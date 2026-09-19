/**
 * CanvaTokenService — the Canva access token for this instance, minted by
 * Crewly Cloud from the owner's grant (`/api/cloud/canva/token`).
 *
 * Mirrors GoogleWorkspaceTokenService: Cloud keeps the client secret and the
 * (single-use, rotating) refresh token; this side caches the access token
 * until a minute before expiry and shares one in-flight refresh.
 *
 * @module services/canva/canva-token.service
 */

import { CloudClientService } from '../cloud/cloud-client.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { CANVA_CONSTANTS } from '../../constants.js';

/** The slice of the Cloud client the service needs (injectable for tests). */
export interface CanvaCloudClient {
  isConnected(): boolean;
  getToken(): string | null;
  getCloudUrl(): string | null;
}

/** Constructor dependencies. */
export interface CanvaTokenServiceDeps {
  cloud?: CanvaCloudClient;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** `GET /api/canva/status` payload. */
export interface CanvaStatus {
  connected: boolean;
  cloudConnected: boolean;
  canvaUserId?: string;
  canvaTeamId?: string;
  displayName?: string;
  scopes?: string[];
  grantedAt?: string;
}

interface CloudTokenPayload {
  accessToken: string;
  expiresAt: string;
  scopes?: string[];
  canvaUserId?: string;
  canvaTeamId?: string;
  displayName?: string;
}

interface CloudStatusPayload {
  connected: boolean;
  canvaUserId?: string;
  canvaTeamId?: string;
  displayName?: string;
  scopes?: string[];
  grantedAt?: string;
}

/** A Canva failure with the HTTP status the controller answers with. */
export class CanvaError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CanvaError';
  }
}

/**
 * Map a Cloud grant-endpoint failure onto this instance's error codes.
 *
 * @param httpStatus - Cloud HTTP status
 * @param code - Cloud `error` / `code`
 * @param message - Cloud message
 * @returns The mapped error
 */
export function mapCloudFailure(httpStatus: number, code: string | undefined, message: string | undefined): CanvaError {
  const CODES = CANVA_CONSTANTS.ERROR_CODES;
  if (httpStatus === 401 || httpStatus === 403) {
    return new CanvaError(401, CODES.NOT_LOGGED_IN, 'Crewly Cloud session expired. Sign in to Crewly Cloud again.');
  }
  if (httpStatus === 404 || httpStatus === 409 || code === CODES.NOT_CONNECTED || code === 'grant_revoked') {
    return new CanvaError(409, CODES.NOT_CONNECTED, 'Canva is not connected for this Crewly Cloud account.');
  }
  if (httpStatus === 503 || code === CODES.NOT_CONFIGURED) {
    return new CanvaError(503, CODES.NOT_CONFIGURED, 'Crewly Cloud is not configured for Canva.');
  }
  if (httpStatus === 502 || code === CODES.CANVA_ERROR) {
    return new CanvaError(502, CODES.CANVA_ERROR, message || 'Canva rejected the token request.');
  }
  return new CanvaError(502, code ?? `http_${httpStatus}`, message || `Cloud request failed (${httpStatus})`);
}

/**
 * Access-token provider for the Canva API.
 */
export class CanvaTokenService {
  private static instance: CanvaTokenService | null = null;
  private readonly logger: ComponentLogger;
  private readonly cloud: CanvaCloudClient;
  private readonly fetchImpl: typeof fetch;
  private readonly nowFn: () => number;
  private cached: { accessToken: string; expiresAtMs: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(deps: CanvaTokenServiceDeps = {}) {
    this.logger = LoggerService.getInstance().createComponentLogger('CanvaToken');
    this.cloud = deps.cloud ?? CloudClientService.getInstance();
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.nowFn = deps.now ?? (() => Date.now());
  }

  static getInstance(): CanvaTokenService {
    if (!CanvaTokenService.instance) CanvaTokenService.instance = new CanvaTokenService();
    return CanvaTokenService.instance;
  }

  static resetInstance(): void {
    CanvaTokenService.instance = null;
  }

  isCloudAvailable(): boolean {
    return this.cloud.isConnected() && !!this.cloud.getToken() && !!this.cloud.getCloudUrl();
  }

  /**
   * A usable access token (cached until 60 s before expiry).
   *
   * @returns The token
   * @throws CanvaError not_logged_in / not_connected / not_configured / canva_error / network
   */
  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - CANVA_CONSTANTS.TOKEN_REFRESH_MARGIN_MS > this.nowFn()) return this.cached.accessToken;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Forget the cached token (after a Canva 401 or a disconnect). */
  clearCache(): void {
    this.cached = null;
  }

  /**
   * Whether Cloud holds a Canva grant; "not there" cases come back as
   * `connected: false`, outages throw.
   *
   * @returns Status
   */
  async status(): Promise<CanvaStatus> {
    if (!this.isCloudAvailable()) return { connected: false, cloudConnected: false };
    try {
      const data = await this.cloudRequest<CloudStatusPayload>('GET', CANVA_CONSTANTS.CLOUD_ENDPOINTS.STATUS);
      if (!data.connected) this.clearCache();
      return {
        connected: !!data.connected,
        cloudConnected: true,
        ...(data.canvaUserId ? { canvaUserId: data.canvaUserId } : {}),
        ...(data.canvaTeamId ? { canvaTeamId: data.canvaTeamId } : {}),
        ...(data.displayName ? { displayName: data.displayName } : {}),
        ...(data.scopes ? { scopes: data.scopes } : {}),
        ...(data.grantedAt ? { grantedAt: data.grantedAt } : {}),
      };
    } catch (err) {
      if (err instanceof CanvaError && err.code === CANVA_CONSTANTS.ERROR_CODES.NOT_CONNECTED) {
        this.clearCache();
        return { connected: false, cloudConnected: true };
      }
      throw err;
    }
  }

  /**
   * Ask Cloud to revoke and forget the grant.
   *
   * @returns Whether Cloud had one
   */
  async disconnect(): Promise<{ removed: boolean }> {
    this.clearCache();
    const data = await this.cloudRequest<{ removed?: boolean }>('DELETE', CANVA_CONSTANTS.CLOUD_ENDPOINTS.DISCONNECT);
    return { removed: !!data.removed };
  }

  /**
   * The Cloud consent-start URL for the browser.
   *
   * @param returnUrl - Absolute dashboard URL Cloud redirects back to
   * @returns URL to open
   * @throws CanvaError(401, not_logged_in) when not signed in to Cloud
   */
  buildConnectUrl(returnUrl: string): string {
    const token = this.cloud.getToken();
    const base = this.cloud.getCloudUrl();
    if (!this.isCloudAvailable() || !token || !base) {
      throw new CanvaError(401, CANVA_CONSTANTS.ERROR_CODES.NOT_LOGGED_IN, 'Sign in to Crewly Cloud first.');
    }
    const url = new URL(`${base.replace(/\/$/, '')}${CANVA_CONSTANTS.CLOUD_PATH}${CANVA_CONSTANTS.CLOUD_ENDPOINTS.START}`);
    url.searchParams.set('token', token);
    url.searchParams.set('returnUrl', returnUrl);
    return url.toString();
  }

  private async refresh(): Promise<string> {
    try {
      const data = await this.cloudRequest<CloudTokenPayload>('GET', CANVA_CONSTANTS.CLOUD_ENDPOINTS.TOKEN);
      if (!data.accessToken) throw new CanvaError(502, CANVA_CONSTANTS.ERROR_CODES.CANVA_ERROR, 'Cloud returned no access token.');
      const expiresAtMs = Date.parse(data.expiresAt);
      this.cached = { accessToken: data.accessToken, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : this.nowFn() };
      this.logger.debug('Canva access token refreshed', { expiresAt: data.expiresAt });
      return data.accessToken;
    } catch (err) {
      this.cached = null;
      throw err;
    }
  }

  private async cloudRequest<T>(method: 'GET' | 'DELETE', suffix: string): Promise<T> {
    const token = this.cloud.getToken();
    const base = this.cloud.getCloudUrl();
    if (!this.isCloudAvailable() || !token || !base) {
      throw new CanvaError(401, CANVA_CONSTANTS.ERROR_CODES.NOT_LOGGED_IN, 'Not signed in to Crewly Cloud.');
    }
    const url = `${base.replace(/\/$/, '')}${CANVA_CONSTANTS.CLOUD_PATH}${suffix}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(CANVA_CONSTANTS.REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw new CanvaError(502, CANVA_CONSTANTS.ERROR_CODES.NETWORK, `Crewly Cloud unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let parsed: { success?: boolean; data?: T; error?: string; code?: string } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      parsed = {};
    }
    if (!res.ok || parsed.success !== true) throw mapCloudFailure(res.status, parsed.code ?? parsed.error, parsed.error);
    return (parsed.data ?? {}) as T;
  }
}
