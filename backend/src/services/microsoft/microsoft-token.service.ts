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

import { PEOPLE_CONSTANTS } from '../../constants.js';
import { actingForHeaders, actorCacheSuffix } from '../people/acting-for.service.js';
import { notPermittedMessage, readNotPermitted, type GrantOwnership, type GrantSharing } from '../people/grant-sharing.js';
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
export interface MicrosoftStatus extends GrantOwnership {
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

interface CloudStatusPayload extends GrantOwnership {
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
  /** Cached token per person the call acts for (issue #968: never handed to another person) */
  private readonly cached = new Map<string, { accessToken: string; expiresAtMs: number }>();
  private readonly inflight = new Map<string, Promise<string>>();

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
    const key = actorCacheSuffix();
    const entry = this.cached.get(key);
    if (entry && entry.expiresAtMs - MICROSOFT_TODO_CONSTANTS.TOKEN_REFRESH_MARGIN_MS > this.nowFn()) return entry.accessToken;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const task = this.refresh(key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  /** Forget the cached token (after a Graph 401 or a disconnect). */
  clearCache(): void {
    this.cached.clear();
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
        ...(data.authorizedBy ? { authorizedBy: data.authorizedBy } : {}),
        ...(data.sharing ? { sharing: data.sharing } : {}),
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
  buildConnectUrl(returnUrl: string, authorizedBy?: string): string {
    const token = this.cloud.getToken();
    const base = this.cloud.getCloudUrl();
    if (!this.isCloudAvailable() || !token || !base) {
      throw new MicrosoftError(401, MICROSOFT_TODO_CONSTANTS.ERROR_CODES.NOT_LOGGED_IN, 'Sign in to Crewly Cloud first.');
    }
    const url = new URL(`${base.replace(/\/$/, '')}${MICROSOFT_TODO_CONSTANTS.CLOUD_PATH}${MICROSOFT_TODO_CONSTANTS.CLOUD_ENDPOINTS.START}`);
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
    const data = await this.cloudRequest<GrantOwnership>('POST', MICROSOFT_TODO_CONSTANTS.CLOUD_ENDPOINTS.SHARING, change);
    this.clearCache();
    return data;
  }

  private async refresh(key: string): Promise<string> {
    try {
      const data = await this.cloudRequest<CloudTokenPayload>('GET', MICROSOFT_TODO_CONSTANTS.CLOUD_ENDPOINTS.TOKEN);
      if (!data.accessToken) throw new MicrosoftError(502, MICROSOFT_TODO_CONSTANTS.ERROR_CODES.MICROSOFT_ERROR, 'Cloud returned no access token.');
      const expiresAtMs = Date.parse(data.expiresAt);
      this.cached.set(key, { accessToken: data.accessToken, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : this.nowFn() });
      this.logger.debug('Microsoft access token refreshed', { expiresAt: data.expiresAt });
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
      throw new MicrosoftError(401, MICROSOFT_TODO_CONSTANTS.ERROR_CODES.NOT_LOGGED_IN, 'Not signed in to Crewly Cloud.');
    }
    const url = `${base.replace(/\/$/, '')}${MICROSOFT_TODO_CONSTANTS.CLOUD_PATH}${suffix}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        // The person this request acts for — set by the backend, never by an agent (issue #968).
        headers: { Authorization: `Bearer ${token}`, ...actingForHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
    const refused = !res.ok ? readNotPermitted(parsed) : null;
    if (refused) throw new MicrosoftError(403, PEOPLE_CONSTANTS.NOT_PERMITTED_CODE, notPermittedMessage('Microsoft To Do', refused.authorizedBy));
    if (!res.ok || parsed.success !== true) throw mapCloudFailure(res.status, parsed.code ?? parsed.error, parsed.message ?? parsed.error);
    return (parsed.data ?? {}) as T;
  }
}
