/**
 * Google Workspace Token Service
 *
 * Crewly Cloud holds the owner's Google OAuth grant; this service asks Cloud
 * (`/api/cloud/google/workspace/token`) for a short-lived access token and
 * caches it until shortly before expiry, so Gmail / Calendar calls made by
 * this instance never carry the refresh token and mail content never passes
 * through Cloud.
 *
 * Cloud auth reuses the Crewly Cloud session already held by
 * `CloudClientService` (its access JWT as Bearer) — no separate login.
 *
 * @module services/google/google-workspace-token.service
 */

import { CloudClientService } from '../cloud/cloud-client.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { GOOGLE_WORKSPACE_CONSTANTS, type GoogleProduct } from '../../constants.js';

/** The slice of CloudClientService this service needs. */
export interface GoogleWorkspaceCloudClient {
  isConnected(): boolean;
  getToken(): string | null;
  getCloudUrl(): string | null;
}

/** Constructor dependencies (all optional — defaults are the real singletons). */
export interface GoogleWorkspaceTokenServiceDeps {
  cloud?: GoogleWorkspaceCloudClient;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Cloud's `/status` payload, plus whether this instance is signed in to Cloud at all. */
/** One connected Google account and what it may be used for. */
export interface GoogleConnection {
  email: string;
  /** Products the grant covers, derived by Cloud from the granted scopes. */
  products: GoogleProduct[];
  scopes: string[];
  grantedAt: string;
  /** True for the account used when a caller names none. */
  isDefault: boolean;
}

export interface GoogleWorkspaceStatus {
  /** True when Cloud holds at least one live Workspace grant */
  connected: boolean;
  /** True when this instance is signed in to Crewly Cloud */
  cloudConnected: boolean;
  /** Every connected Google account; empty when none. */
  connections: GoogleConnection[];
  /** The default connection's details — kept for callers written before multi-account. */
  email?: string;
  scopes?: string[];
  grantedAt?: string;
}

/** Cloud's `/token` payload. */
interface CloudTokenPayload {
  accessToken: string;
  expiresAt: string;
  scopes?: string[];
  email?: string;
  products?: GoogleProduct[];
}

/** Cloud's `/status` payload. `connections` is absent on an older Cloud. */
interface CloudStatusPayload {
  connected: boolean;
  connections?: GoogleConnection[];
  email?: string;
  scopes?: string[];
  grantedAt?: string;
}

/**
 * Error raised for every Cloud / Google failure. `status` is the HTTP status
 * the OSS controller should answer with and `code` is one of
 * {@link GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES} (or `http_<n>` for anything
 * unmapped), so the controller and the skills can branch without parsing text.
 */
export class GoogleWorkspaceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleWorkspaceError';
  }
}

/**
 * Map a Cloud workspace-endpoint failure to the status/code this instance
 * answers with. 404 (no grant) and 409 (grant revoked) both mean "not
 * connected — go through the consent flow again"; 503 means Cloud itself has
 * no Google client; 502 is Google refusing Cloud.
 *
 * @param httpStatus - Status Cloud answered with
 * @param code - `code` (or `error`) field from Cloud's body, if any
 * @param message - Human message from Cloud's body, if any
 * @returns The error to throw
 */
export function mapCloudFailure(httpStatus: number, code: string | undefined, message: string | undefined): GoogleWorkspaceError {
  const CODES = GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES;
  if (httpStatus === 401 || httpStatus === 403) {
    return new GoogleWorkspaceError(401, CODES.NOT_LOGGED_IN, 'Crewly Cloud session expired. Sign in to Crewly Cloud again.');
  }
  if (httpStatus === 404 || httpStatus === 409 || code === CODES.NOT_CONNECTED || code === 'grant_revoked') {
    return new GoogleWorkspaceError(409, CODES.NOT_CONNECTED, 'Google Workspace is not connected for this Crewly Cloud account.');
  }
  if (httpStatus === 503 || code === CODES.NOT_CONFIGURED) {
    return new GoogleWorkspaceError(503, CODES.NOT_CONFIGURED, 'Crewly Cloud is not configured for Google Workspace.');
  }
  if (httpStatus === 502 || code === CODES.GOOGLE_ERROR) {
    return new GoogleWorkspaceError(502, CODES.GOOGLE_ERROR, message || 'Google rejected the token request.');
  }
  return new GoogleWorkspaceError(502, code ?? `http_${httpStatus}`, message || `Cloud request failed (${httpStatus})`);
}

/**
 * Fetches, caches and refreshes the Google access token that Cloud mints
 * from the owner's stored grant.
 *
 * @example
 * ```ts
 * const token = await GoogleWorkspaceTokenService.getInstance().getAccessToken();
 * ```
 */
export class GoogleWorkspaceTokenService {
  private static instance: GoogleWorkspaceTokenService | null = null;

  private readonly logger: ComponentLogger;
  private readonly cloud: GoogleWorkspaceCloudClient;
  private readonly fetchImpl: typeof fetch;
  private readonly nowFn: () => number;

  /**
   * Cached token per Google account (`''` = whichever Cloud calls default).
   *
   * Keyed, not single, because one Crewly account may have several Google
   * accounts connected and their tokens are unrelated — a single slot made
   * the second account evict the first on every call.
   */
  private readonly cached = new Map<
    string,
    { accessToken: string; expiresAtMs: number; email?: string; scopes?: string[]; products?: GoogleProduct[] }
  >();
  /** The refresh currently on the wire per account, so concurrent callers share it. */
  private readonly inflight = new Map<string, Promise<string>>();

  /**
   * @param deps - Cloud client slice, fetch and clock overrides (tests)
   */
  constructor(deps: GoogleWorkspaceTokenServiceDeps = {}) {
    this.logger = LoggerService.getInstance().createComponentLogger('GoogleWorkspaceToken');
    this.cloud = deps.cloud ?? CloudClientService.getInstance();
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.nowFn = deps.now ?? (() => Date.now());
  }

  /**
   * Process-wide instance bound to the real CloudClientService.
   *
   * @returns The singleton
   */
  static getInstance(): GoogleWorkspaceTokenService {
    if (!GoogleWorkspaceTokenService.instance) {
      GoogleWorkspaceTokenService.instance = new GoogleWorkspaceTokenService();
    }
    return GoogleWorkspaceTokenService.instance;
  }

  /**
   * Drop the singleton (tests).
   */
  static resetInstance(): void {
    GoogleWorkspaceTokenService.instance = null;
  }

  /**
   * Whether this instance is signed in to Crewly Cloud (prerequisite for
   * everything else here).
   *
   * @returns True when a Cloud URL and access JWT are available
   */
  isCloudAvailable(): boolean {
    return this.cloud.isConnected() && !!this.cloud.getToken() && !!this.cloud.getCloudUrl();
  }

  /**
   * A Google access token that is valid for at least the refresh margin.
   * Served from cache when possible; otherwise one Cloud round-trip shared
   * by every concurrent caller.
   *
   * @returns Bearer token for Gmail / Calendar
   * @throws GoogleWorkspaceError — not_logged_in / not_connected / not_configured / google_error / network
   */
  async getAccessToken(options: { account?: string; product?: GoogleProduct } = {}): Promise<string> {
    const key = options.account ?? '';
    const margin = GOOGLE_WORKSPACE_CONSTANTS.TOKEN_REFRESH_MARGIN_MS;
    const entry = this.cached.get(key);
    if (entry && entry.expiresAtMs - margin > this.nowFn()) {
      // Checked against the cache too, not just on the Cloud round-trip: a
      // token cached for Calendar would otherwise be handed to a Drive call
      // and fail at Google with an opaque 403.
      this.assertProduct(entry.products, options.product, entry.email ?? options.account);
      return entry.accessToken;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const task = this.refresh(options).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  /**
   * Refuse a token that does not cover the product the caller needs.
   *
   * @param granted - Products the grant covers, when Cloud reported them
   * @param wanted - Product the caller needs, if it named one
   * @param email - Google account, for the message
   * @throws GoogleWorkspaceError not_connected, naming what to connect
   */
  private assertProduct(granted: GoogleProduct[] | undefined, wanted?: GoogleProduct, email?: string): void {
    if (!wanted || !granted || granted.includes(wanted)) return;
    throw new GoogleWorkspaceError(
      404,
      GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.NOT_CONNECTED,
      `${email ?? 'This Google account'} is not connected for ${wanted}. Connect ${wanted} on the Connections page.`,
    );
  }

  /**
   * Forget cached tokens so the next call refreshes (used after Google
   * answers 401, or when a grant is revoked).
   *
   * @param account - Only this Google account; omit to clear every one
   */
  clearCache(account?: string): void {
    if (account === undefined) this.cached.clear();
    else this.cached.delete(account);
  }

  /**
   * Whether Cloud holds a Workspace grant, and for which email.
   * Never throws for the two "not there" cases (no Cloud session / no grant);
   * those come back as `connected: false`.
   *
   * @returns Connection status
   * @throws GoogleWorkspaceError for Cloud outages / misconfiguration
   */
  async status(): Promise<GoogleWorkspaceStatus> {
    if (!this.isCloudAvailable()) {
      return { connected: false, cloudConnected: false, connections: [] };
    }
    try {
      const data = await this.cloudRequest<CloudStatusPayload>('GET', GOOGLE_WORKSPACE_CONSTANTS.CLOUD_ENDPOINTS.STATUS);
      if (!data.connected) this.clearCache();
      return {
        connected: !!data.connected,
        cloudConnected: true,
        // An older Cloud reports no `connections`; synthesise the single one
        // it does describe so callers only ever handle the list shape.
        connections:
          data.connections ??
          (data.connected && data.email
            ? [{ email: data.email, products: [], scopes: data.scopes ?? [], grantedAt: data.grantedAt ?? '', isDefault: true }]
            : []),
        ...(data.email ? { email: data.email } : {}),
        ...(data.scopes ? { scopes: data.scopes } : {}),
        ...(data.grantedAt ? { grantedAt: data.grantedAt } : {}),
      };
    } catch (err) {
      if (err instanceof GoogleWorkspaceError && err.code === GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.NOT_CONNECTED) {
        this.clearCache();
        return { connected: false, cloudConnected: true, connections: [] };
      }
      throw err;
    }
  }

  /**
   * Ask Cloud to revoke the grant and forget it; also drops the local cache.
   *
   * @returns Whether Cloud had a grant to remove
   * @throws GoogleWorkspaceError when not signed in to Cloud or Cloud fails
   */
  async disconnect(options: { account?: string } = {}): Promise<{ removed: boolean }> {
    this.clearCache(options.account);
    const suffix = options.account
      ? `${GOOGLE_WORKSPACE_CONSTANTS.CLOUD_ENDPOINTS.DISCONNECT}?email=${encodeURIComponent(options.account)}`
      : GOOGLE_WORKSPACE_CONSTANTS.CLOUD_ENDPOINTS.DISCONNECT;
    const data = await this.cloudRequest<{ removed?: boolean }>('DELETE', suffix);
    return { removed: !!data.removed };
  }

  /**
   * Choose which connected Google account answers a call that names none.
   *
   * @param account - The Google account to make default
   * @returns `{ updated }`
   * @throws GoogleWorkspaceError when not signed in to Cloud, or no such grant
   */
  async setDefaultAccount(account: string): Promise<{ updated: boolean }> {
    const data = await this.cloudRequest<{ updated?: boolean }>(
      'POST',
      GOOGLE_WORKSPACE_CONSTANTS.CLOUD_ENDPOINTS.DEFAULT,
      { email: account },
    );
    // The default decides which grant an unqualified call lands on, so every
    // cached token is now potentially for the wrong account.
    this.clearCache();
    return { updated: !!data.updated };
  }

  /**
   * The Cloud consent-start URL for the browser: carries the current Cloud
   * access JWT (Cloud accepts `?token=` because a top-level navigation cannot
   * set a Bearer header) and where to land afterwards.
   *
   * @param returnUrl - Absolute dashboard URL Cloud redirects back to
   * @returns Absolute URL to open
   * @throws GoogleWorkspaceError(401, not_logged_in) when not signed in to Cloud
   */
  buildConnectUrl(
    returnUrl: string,
    options: { products?: readonly GoogleProduct[]; loginHint?: string; chooseAccount?: boolean; replace?: boolean } = {},
  ): string {
    const token = this.cloud.getToken();
    const base = this.cloud.getCloudUrl();
    if (!this.isCloudAvailable() || !token || !base) {
      throw new GoogleWorkspaceError(401, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.NOT_LOGGED_IN, 'Sign in to Crewly Cloud first.');
    }
    const url = new URL(
      `${base.replace(/\/$/, '')}${GOOGLE_WORKSPACE_CONSTANTS.CLOUD_PATH}${GOOGLE_WORKSPACE_CONSTANTS.CLOUD_ENDPOINTS.START}`,
    );
    url.searchParams.set('token', token);
    url.searchParams.set('returnUrl', returnUrl);
    if (options.products?.length) url.searchParams.set('products', options.products.join(','));
    // Without a hint Google reuses the session the browser is already signed
    // in to, so "add another account" would silently re-consent the same one.
    if (options.loginHint) url.searchParams.set('loginHint', options.loginHint);
    if (options.chooseAccount) url.searchParams.set('chooseAccount', '1');
    // Narrowing a grant rather than widening it — see the Cloud side.
    if (options.replace) url.searchParams.set('replace', '1');
    return url.toString();
  }

  /**
   * One Cloud `/token` round-trip; updates the cache.
   *
   * @returns The fresh access token
   */
  private async refresh(options: { account?: string; product?: GoogleProduct } = {}): Promise<string> {
    const key = options.account ?? '';
    const query = new URLSearchParams();
    if (options.account) query.set('email', options.account);
    // Cloud is the authority on whether the grant covers this product; asking
    // for it here turns "Google said 403" into "Gmail is not connected".
    if (options.product) query.set('product', options.product);
    const suffix = query.size
      ? `${GOOGLE_WORKSPACE_CONSTANTS.CLOUD_ENDPOINTS.TOKEN}?${query.toString()}`
      : GOOGLE_WORKSPACE_CONSTANTS.CLOUD_ENDPOINTS.TOKEN;
    try {
      const data = await this.cloudRequest<CloudTokenPayload>('GET', suffix);
      if (!data.accessToken) {
        throw new GoogleWorkspaceError(502, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.GOOGLE_ERROR, 'Cloud returned no access token.');
      }
      const expiresAtMs = Date.parse(data.expiresAt);
      this.cached.set(key, {
        accessToken: data.accessToken,
        // An unparseable expiry is treated as already stale so we refresh next time.
        expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : this.nowFn(),
        ...(data.email ? { email: data.email } : {}),
        ...(data.scopes ? { scopes: data.scopes } : {}),
        ...(data.products ? { products: data.products } : {}),
      });
      this.logger.debug('Google access token refreshed', { expiresAt: data.expiresAt, account: data.email });
      return data.accessToken;
    } catch (err) {
      this.cached.delete(key);
      throw err;
    }
  }

  /**
   * Authenticated call to a Cloud workspace endpoint using the Cloud session
   * JWT. Unwraps the auth service's `{ success, data }` envelope.
   *
   * @param method - HTTP verb
   * @param suffix - Path under CLOUD_PATH
   * @returns The `data` payload
   * @throws GoogleWorkspaceError mapped via {@link mapCloudFailure}
   */
  private async cloudRequest<T>(method: 'GET' | 'DELETE' | 'POST', suffix: string, body?: unknown): Promise<T> {
    const token = this.cloud.getToken();
    const base = this.cloud.getCloudUrl();
    if (!this.isCloudAvailable() || !token || !base) {
      throw new GoogleWorkspaceError(401, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.NOT_LOGGED_IN, 'Not signed in to Crewly Cloud.');
    }
    const url = `${base.replace(/\/$/, '')}${GOOGLE_WORKSPACE_CONSTANTS.CLOUD_PATH}${suffix}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(GOOGLE_WORKSPACE_CONSTANTS.REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GoogleWorkspaceError(502, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.NETWORK, `Crewly Cloud unreachable: ${message}`);
    }
    const text = await res.text();
    let parsed: { success?: boolean; data?: T; error?: string; code?: string } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      parsed = {};
    }
    if (!res.ok || parsed.success !== true) {
      throw mapCloudFailure(res.status, parsed.code ?? parsed.error, parsed.error);
    }
    return (parsed.data ?? {}) as T;
  }
}
