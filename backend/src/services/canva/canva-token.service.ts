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

import { PEOPLE_CONSTANTS } from '../../constants.js';
import { actingForHeaders, actorCacheSuffix } from '../people/acting-for.service.js';
import { notPermittedMessage, readNotPermitted, type GrantOwnership, type GrantSharing } from '../people/grant-sharing.js';
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
export interface CanvaStatus extends GrantOwnership {
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

interface CloudStatusPayload extends GrantOwnership {
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
  /** Cached token per person the call acts for (issue #968: never handed to another person) */
  private readonly cached = new Map<string, { accessToken: string; expiresAtMs: number }>();
  private readonly inflight = new Map<string, Promise<string>>();

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
    const key = actorCacheSuffix();
    const entry = this.cached.get(key);
    if (entry && entry.expiresAtMs - CANVA_CONSTANTS.TOKEN_REFRESH_MARGIN_MS > this.nowFn()) return entry.accessToken;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const task = this.refresh(key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  /** Forget the cached token (after a Canva 401 or a disconnect). */
  clearCache(): void {
    this.cached.clear();
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
        ...(data.authorizedBy ? { authorizedBy: data.authorizedBy } : {}),
        ...(data.sharing ? { sharing: data.sharing } : {}),
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
  buildConnectUrl(returnUrl: string, authorizedBy?: string): string {
    const token = this.cloud.getToken();
    const base = this.cloud.getCloudUrl();
    if (!this.isCloudAvailable() || !token || !base) {
      throw new CanvaError(401, CANVA_CONSTANTS.ERROR_CODES.NOT_LOGGED_IN, 'Sign in to Crewly Cloud first.');
    }
    const url = new URL(`${base.replace(/\/$/, '')}${CANVA_CONSTANTS.CLOUD_PATH}${CANVA_CONSTANTS.CLOUD_ENDPOINTS.START}`);
    url.searchParams.set('token', token);
    url.searchParams.set('returnUrl', returnUrl);
    // Who is connecting it: the grant is theirs alone until shared (issue #968).
    if (authorizedBy) url.searchParams.set('authorizedBy', authorizedBy);
    return url.toString();
  }

  /**
   * Change who owns the grant and who it is shared with (issue #968). Owner
   * action; Cloud stores it and enforces it on every token request.
   *
   * @param change - New owner and/or sharing
   * @returns Ownership as Cloud now reports it
   */
  async setSharing(change: { authorizedBy?: string; sharing?: GrantSharing }): Promise<GrantOwnership> {
    const data = await this.cloudRequest<GrantOwnership>('POST', CANVA_CONSTANTS.CLOUD_ENDPOINTS.SHARING, change);
    this.clearCache();
    return data;
  }

  private async refresh(key: string): Promise<string> {
    try {
      const data = await this.cloudRequest<CloudTokenPayload>('GET', CANVA_CONSTANTS.CLOUD_ENDPOINTS.TOKEN);
      if (!data.accessToken) throw new CanvaError(502, CANVA_CONSTANTS.ERROR_CODES.CANVA_ERROR, 'Cloud returned no access token.');
      const expiresAtMs = Date.parse(data.expiresAt);
      this.cached.set(key, { accessToken: data.accessToken, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : this.nowFn() });
      this.logger.debug('Canva access token refreshed', { expiresAt: data.expiresAt });
      return data.accessToken;
    } catch (err) {
      this.cached.delete(key);
      throw err;
    }
  }

  private async cloudRequest<T>(method: 'GET' | 'DELETE' | 'POST', suffix: string, body?: unknown): Promise<T> {
    const token = this.cloud.getToken();
    const base = this.cloud.getCloudUrl();
    if (!this.isCloudAvailable() || !token || !base) {
      throw new CanvaError(401, CANVA_CONSTANTS.ERROR_CODES.NOT_LOGGED_IN, 'Not signed in to Crewly Cloud.');
    }
    const url = `${base.replace(/\/$/, '')}${CANVA_CONSTANTS.CLOUD_PATH}${suffix}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        // The person this request acts for — set by the backend, never by an agent (issue #968).
        headers: { Authorization: `Bearer ${token}`, ...actingForHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(CANVA_CONSTANTS.REQUEST_TIMEOUT_MS),
      });
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
    const refused = !res.ok ? readNotPermitted(parsed) : null;
    if (refused) throw new CanvaError(403, PEOPLE_CONSTANTS.NOT_PERMITTED_CODE, notPermittedMessage('Canva', refused.authorizedBy));
    // Crewly Cloud from before per-person access (auth < 1.10) has no sharing
    // endpoint: a bare 404 (no error code). Say so instead of "not connected".
    if (res.status === 404 && suffix === CANVA_CONSTANTS.CLOUD_ENDPOINTS.SHARING && !parsed.code && !parsed.error) {
      throw new CanvaError(501, PEOPLE_CONSTANTS.CLOUD_UPDATE_REQUIRED_CODE, PEOPLE_CONSTANTS.CLOUD_UPDATE_REQUIRED_MESSAGE);
    }
    if (!res.ok || parsed.success !== true) throw mapCloudFailure(res.status, parsed.code ?? parsed.error, parsed.error);
    return (parsed.data ?? {}) as T;
  }
}
