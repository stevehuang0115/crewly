/**
 * MicrosoftTokenService — the Microsoft Graph access token for this
 * instance, minted by Crewly Cloud from the owner's grant
 * (`/api/cloud/microsoft/token`).
 *
 * Mirrors CanvaTokenService: Cloud keeps the client secret and the
 * (rotating) refresh token; this side caches the access token until a
 * minute before expiry and shares one in-flight refresh. The Cloud grant is
 * keyed `microsoft`, so the same token will serve Outlook mail / calendar
 * once those scopes are added — To Do is only its first consumer.
 *
 * @module services/microsoft/microsoft-token.service
 */

import { CloudClientService } from '../cloud/cloud-client.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { MICROSOFT_TODO_CONSTANTS } from '../../constants.js';

/** The slice of the Cloud client the service needs (injectable for tests). */
export interface MicrosoftCloudClient {
  isConnected(): boolean;
  getToken(): string | null;
  getCloudUrl(): string | null;
}

/** Constructor dependencies. */
export interface MicrosoftTokenServiceDeps {
  cloud?: MicrosoftCloudClient;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** `GET /api/microsoft-todo/status` payload. */
export interface MicrosoftStatus {
  connected: boolean;
  cloudConnected: boolean;
  microsoftUserId?: string;
  displayName?: string;
  email?: string;
  scopes?: string[];
  grantedAt?: string;
}

interface CloudTokenPayload {
  accessToken: string;
  expiresAt: string;
  scopes?: string[];
  microsoftUserId?: string;
  displayName?: string;
  email?: string;
}

interface CloudStatusPayload {
  connected: boolean;
  microsoftUserId?: string;
  displayName?: string;
  email?: string;
  scopes?: string[];
  grantedAt?: string;
}

/** A Microsoft / To Do failure with the HTTP status the controller answers with. */
export class MicrosoftError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Seconds to wait before retrying (Graph 429 `Retry-After`). */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'MicrosoftError';
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
export function mapCloudFailure(httpStatus: number, code: string | undefined, message: string | undefined): MicrosoftError {
  const CODES = MICROSOFT_TODO_CONSTANTS.ERROR_CODES;
  if (httpStatus === 401 || httpStatus === 403) {
    return new MicrosoftError(401, CODES.NOT_LOGGED_IN, 'Crewly Cloud session expired. Sign in to Crewly Cloud again.');
  }
  if (httpStatus === 404 || httpStatus === 409 || code === CODES.NOT_CONNECTED || code === 'grant_revoked') {
    return new MicrosoftError(409, CODES.NOT_CONNECTED, 'Microsoft is not connected for this Crewly Cloud account.');
  }
  if (httpStatus === 503 || code === CODES.NOT_CONFIGURED) {
    return new MicrosoftError(503, CODES.NOT_CONFIGURED, 'Crewly Cloud is not configured for Microsoft.');
  }
  if (httpStatus === 502 || code === CODES.MICROSOFT_ERROR) {
    return new MicrosoftError(502, CODES.MICROSOFT_ERROR, message || 'Microsoft rejected the token request.');
  }
  return new MicrosoftError(502, code ?? `http_${httpStatus}`, message || `Cloud request failed (${httpStatus})`);
}

/**
 * Access-token provider for Microsoft Graph.
 */
export class MicrosoftTokenService {
  private static instance: MicrosoftTokenService | null = null;
  private readonly logger: ComponentLogger;
  private readonly cloud: MicrosoftCloudClient;
  private readonly fetchImpl: typeof fetch;
  private readonly nowFn: () => number;
  private cached: { accessToken: string; expiresAtMs: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(deps: MicrosoftTokenServiceDeps = {}) {
    this.logger = LoggerService.getInstance().createComponentLogger('MicrosoftToken');
    this.cloud = deps.cloud ?? CloudClientService.getInstance();
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.nowFn = deps.now ?? (() => Date.now());
  }

  /**
   * Process-wide instance.
   *
   * @returns The singleton
   */
  static getInstance(): MicrosoftTokenService {
    if (!MicrosoftTokenService.instance) MicrosoftTokenService.instance = new MicrosoftTokenService();
    return MicrosoftTokenService.instance;
  }

  /** Reset the singleton (tests). */
  static resetInstance(): void {
    MicrosoftTokenService.instance = null;
  }

  /**
   * Whether this instance is signed in to Crewly Cloud.
   *
   * @returns True when a Cloud session is available
   */
  isCloudAvailable(): boolean {
    return this.cloud.isConnected() && !!this.cloud.getToken() && !!this.cloud.getCloudUrl();
  }

  /**
   * A usable access token (cached until 60 s before expiry).
   *
   * @returns The token
   * @throws MicrosoftError not_logged_in / not_connected / not_configured / microsoft_error / network
   */
  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - MICROSOFT_TODO_CONSTANTS.TOKEN_REFRESH_MARGIN_MS > this.nowFn()) return this.cached.accessToken;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Forget the cached token (after a Graph 401 or a disconnect). */
  clearCache(): void {
    this.cached = null;
  }

  /**
   * Whether Cloud holds a Microsoft grant; "not there" cases come back as
   * `connected: false`, outages throw.
   *
   * @returns Status
   */
  async status(): Promise<MicrosoftStatus> {
    if (!this.isCloudAvailable()) return { connected: false, cloudConnected: false };
    try {
      const data = await this.cloudRequest<CloudStatusPayload>('GET', MICROSOFT_TODO_CONSTANTS.CLOUD_ENDPOINTS.STATUS);
      if (!data.connected) this.clearCache();
      return {
        connected: !!data.connected,
        cloudConnected: true,
        ...(data.microsoftUserId ? { microsoftUserId: data.microsoftUserId } : {}),
        ...(data.displayName ? { displayName: data.displayName } : {}),
        ...(data.email ? { email: data.email } : {}),
        ...(data.scopes ? { scopes: data.scopes } : {}),
        ...(data.grantedAt ? { grantedAt: data.grantedAt } : {}),
      };
    } catch (err) {
      if (err instanceof MicrosoftError && err.code === MICROSOFT_TODO_CONSTANTS.ERROR_CODES.NOT_CONNECTED) {
        this.clearCache();
        return { connected: false, cloudConnected: true };
      }
      throw err;
    }
  }

  /**
   * Ask Cloud to forget the grant.
   *
   * @returns Whether Cloud had one
   */
  async disconnect(): Promise<{ removed: boolean }> {
    this.clearCache();
    const data = await this.cloudRequest<{ removed?: boolean }>('DELETE', MICROSOFT_TODO_CONSTANTS.CLOUD_ENDPOINTS.DISCONNECT);
    return { removed: !!data.removed };
  }

  /**
   * The Cloud consent-start URL for the browser.
   *
   * @param returnUrl - Absolute dashboard URL Cloud redirects back to
   * @returns URL to open
   * @throws MicrosoftError(401, not_logged_in) when not signed in to Cloud
   */
  buildConnectUrl(returnUrl: string): string {
    const token = this.cloud.getToken();
    const base = this.cloud.getCloudUrl();
    if (!this.isCloudAvailable() || !token || !base) {
      throw new MicrosoftError(401, MICROSOFT_TODO_CONSTANTS.ERROR_CODES.NOT_LOGGED_IN, 'Sign in to Crewly Cloud first.');
    }
    const url = new URL(`${base.replace(/\/$/, '')}${MICROSOFT_TODO_CONSTANTS.CLOUD_PATH}${MICROSOFT_TODO_CONSTANTS.CLOUD_ENDPOINTS.START}`);
    url.searchParams.set('token', token);
    url.searchParams.set('returnUrl', returnUrl);
    return url.toString();
  }

  private async refresh(): Promise<string> {
    try {
      const data = await this.cloudRequest<CloudTokenPayload>('GET', MICROSOFT_TODO_CONSTANTS.CLOUD_ENDPOINTS.TOKEN);
      if (!data.accessToken) throw new MicrosoftError(502, MICROSOFT_TODO_CONSTANTS.ERROR_CODES.MICROSOFT_ERROR, 'Cloud returned no access token.');
      const expiresAtMs = Date.parse(data.expiresAt);
      this.cached = { accessToken: data.accessToken, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : this.nowFn() };
      this.logger.debug('Microsoft access token refreshed', { expiresAt: data.expiresAt });
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
      throw new MicrosoftError(401, MICROSOFT_TODO_CONSTANTS.ERROR_CODES.NOT_LOGGED_IN, 'Not signed in to Crewly Cloud.');
    }
    const url = `${base.replace(/\/$/, '')}${MICROSOFT_TODO_CONSTANTS.CLOUD_PATH}${suffix}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(MICROSOFT_TODO_CONSTANTS.REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new MicrosoftError(502, MICROSOFT_TODO_CONSTANTS.ERROR_CODES.NETWORK, `Crewly Cloud unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let parsed: { success?: boolean; data?: T; error?: string; code?: string; message?: string } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      parsed = {};
    }
    if (!res.ok || parsed.success !== true) throw mapCloudFailure(res.status, parsed.code ?? parsed.error, parsed.message ?? parsed.error);
    return (parsed.data ?? {}) as T;
  }
}
