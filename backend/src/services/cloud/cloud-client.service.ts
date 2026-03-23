/**
 * Cloud Client Service
 *
 * Singleton service responsible for all interactions with CrewlyAI Cloud.
 * Handles authentication, premium template fetching, and subscription
 * status synchronization.
 *
 * Premium templates are loaded into memory only — never written to disk
 * to prevent IP leakage.
 *
 * @module services/cloud/cloud-client.service
 */

import * as os from 'os';
import * as path from 'path';
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import {
  CLOUD_CONSTANTS,
  AUTH_CONSTANTS,
  type CloudTier,
  type CloudConnectionStatus,
} from '../../constants.js';

/**
 * Persisted cloud config stored at ~/.crewly/cloud/config.json.
 * Enables auto-reconnect on backend restart.
 */
export interface PersistedCloudConfig {
  cloudUrl: string;
  token: string;
  tier: string;
  connectedAt: string;
  /** Refresh token for auto-renewing expired access tokens */
  refreshToken?: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Summary of a premium template returned by the cloud listing endpoint. */
export interface CloudTemplateSummary {
  /** Unique template identifier */
  id: string;
  /** Human-readable template name */
  name: string;
  /** Short description */
  description: string;
  /** Minimum subscription tier required */
  requiredTier: CloudTier;
  /** Category tag (e.g. "dev-team", "marketing") */
  category: string;
}

/** Full detail for a single premium template (in-memory only). */
export interface CloudTemplateDetail {
  /** Unique template identifier */
  id: string;
  /** Human-readable template name */
  name: string;
  /** Full description */
  description: string;
  /** Minimum subscription tier required */
  requiredTier: CloudTier;
  /** Category tag */
  category: string;
  /** Team member role definitions */
  roles: Array<{ role: string; prompt: string }>;
  /** Task orchestration config */
  orchestration: Record<string, unknown>;
}

/** A relay device returned by the Cloud devices API. */
export interface CloudRelayDevice {
  /** Device/session ID */
  sessionId: string;
  /** Device role */
  role: 'orchestrator' | 'agent';
  /** Device state */
  state: 'waiting' | 'paired' | 'disconnected';
  /** Paired peer device ID */
  pairedWith: string | null;
  /** ISO registration timestamp */
  registeredAt: string;
  /** ISO last heartbeat timestamp */
  lastHeartbeatAt: string;
  /** Human-readable device name (legacy field) */
  name?: string;
  /** Human-readable device name returned by Cloud API */
  deviceName?: string;
  /** Unique device identifier */
  deviceId?: string;
}

/** Current cloud connection state exposed by getStatus(). */
export interface CloudStatus {
  /** Whether the client is currently connected */
  connectionStatus: CloudConnectionStatus;
  /** Cloud API base URL (set after connect) */
  cloudUrl: string | null;
  /** Current subscription tier */
  tier: CloudTier;
  /** ISO timestamp of last successful sync */
  lastSyncAt: string | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * CloudClientService singleton.
 *
 * Manages the lifecycle of the connection between a local Crewly instance
 * and CrewlyAI Cloud. All cloud API calls are made via native fetch with
 * bearer-token authentication.
 */
export class CloudClientService {
  private static instance: CloudClientService | null = null;
  private readonly logger: ComponentLogger;

  /** Cloud API base URL (e.g. "https://api.crewlyai.com") */
  private cloudUrl: string | null = null;
  /** Bearer token obtained during connect() */
  private token: string | null = null;
  /** Refresh token for auto-renewing expired access tokens */
  private refreshToken: string | null = null;
  /** Current connection status */
  private connectionStatus: CloudConnectionStatus = CLOUD_CONSTANTS.CONNECTION_STATUS.DISCONNECTED;
  /** Subscription tier reported by cloud */
  private tier: CloudTier = CLOUD_CONSTANTS.TIERS.FREE;
  /** Timestamp of the most recent successful cloud API call */
  private lastSyncAt: string | null = null;
  /** Timer for proactive token refresh (fires 5 min before expiry) */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guard to prevent concurrent refresh attempts */
  private refreshInProgress = false;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('CloudClientService');
  }

  /**
   * Get the singleton instance.
   *
   * @returns CloudClientService instance
   */
  static getInstance(): CloudClientService {
    if (!CloudClientService.instance) {
      CloudClientService.instance = new CloudClientService();
    }
    return CloudClientService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    CloudClientService.instance = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Connect to CrewlyAI Cloud by verifying the provided token.
   *
   * Calls the cloud auth endpoint to validate credentials and retrieve
   * the subscription tier. On success the service transitions to
   * "connected" status.
   *
   * @param cloudUrl - Base URL of the CrewlyAI Cloud API
   * @param token - Authentication token (API key or JWT)
   * @returns Object with connection result
   * @throws Error when the auth request fails or token is invalid
   *
   * @example
   * ```ts
   * const client = CloudClientService.getInstance();
   * await client.connect('https://api.crewlyai.com', 'sk-abc123');
   * ```
   */
  async connect(cloudUrl: string, token: string, refreshToken?: string): Promise<{ success: boolean; tier: CloudTier }> {
    this.logger.info('Connecting to CrewlyAI Cloud', { cloudUrl });

    const url = `${cloudUrl}${CLOUD_CONSTANTS.ENDPOINTS.AUTH_TOKEN}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(CLOUD_CONSTANTS.TIMEOUTS.CONNECT),
    });

    if (!response.ok) {
      this.connectionStatus = CLOUD_CONSTANTS.CONNECTION_STATUS.ERROR;
      const errorText = await response.text().catch(() => 'Unknown error');
      this.logger.error('Cloud connection failed', { status: response.status, errorText });
      throw new Error(`Cloud authentication failed: ${response.status} ${errorText}`);
    }

    // crewly-auth /api/cloud/validate returns { success, data: { plan, ... } }
    // Also accept legacy { tier } format for forward compatibility
    const data = (await response.json()) as { tier?: string; data?: { plan?: string } };
    const resolvedTier = data.data?.plan || data.tier;

    this.cloudUrl = cloudUrl;
    this.token = token;
    this.refreshToken = refreshToken || this.refreshToken;
    this.tier = (resolvedTier as CloudTier) || CLOUD_CONSTANTS.TIERS.FREE;
    this.connectionStatus = CLOUD_CONSTANTS.CONNECTION_STATUS.CONNECTED;
    this.lastSyncAt = new Date().toISOString();

    this.logger.info('Connected to CrewlyAI Cloud', { tier: this.tier });

    // Schedule proactive token refresh
    this.scheduleTokenRefresh(token);

    // Persist credentials for auto-reconnect on restart
    this.persistConfig().catch((err) => {
      this.logger.warn('Failed to persist cloud config (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { success: true, tier: this.tier };
  }

  /**
   * Connect using a locally verified JWT (no remote API call needed).
   *
   * Used when the JWT was issued by this same instance or the JWT secret
   * is shared between OSS and Cloud. Avoids the round-trip to the cloud
   * auth endpoint.
   *
   * @param cloudUrl - Base URL of the CrewlyAI Cloud API
   * @param token - JWT access token (already verified locally)
   * @param tier - Subscription tier extracted from the JWT payload
   * @param refreshToken - Optional refresh token for auto-renewal
   */
  connectLocal(cloudUrl: string, token: string, tier: CloudTier, refreshToken?: string): void {
    this.cloudUrl = cloudUrl;
    this.token = token;
    this.refreshToken = refreshToken || this.refreshToken;
    this.tier = tier || CLOUD_CONSTANTS.TIERS.FREE;
    this.connectionStatus = CLOUD_CONSTANTS.CONNECTION_STATUS.CONNECTED;
    this.lastSyncAt = new Date().toISOString();

    this.logger.info('Connected to CrewlyAI Cloud (local verification)', { tier: this.tier });

    // Schedule proactive token refresh
    this.scheduleTokenRefresh(token);

    // Persist credentials for auto-reconnect on restart
    this.persistConfig().catch((err) => {
      this.logger.warn('Failed to persist cloud config (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Disconnect from CrewlyAI Cloud.
   *
   * Clears stored credentials and resets the connection state.
   */
  disconnect(): void {
    this.logger.info('Disconnecting from CrewlyAI Cloud');
    this.cloudUrl = null;
    this.token = null;
    this.refreshToken = null;
    this.connectionStatus = CLOUD_CONSTANTS.CONNECTION_STATUS.DISCONNECTED;
    this.tier = CLOUD_CONSTANTS.TIERS.FREE;
    this.lastSyncAt = null;
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }

    // Remove persisted config
    this.removePersistedConfig().catch((err) => {
      this.logger.warn('Failed to remove persisted cloud config (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // -------------------------------------------------------------------------
  // Config Persistence
  // -------------------------------------------------------------------------

  /**
   * Path to the persisted cloud config file.
   */
  static getConfigPath(): string {
    return path.join(os.homedir(), '.crewly', 'cloud', 'config.json');
  }

  /**
   * Load persisted cloud config from disk.
   * Returns null if file doesn't exist or is invalid.
   */
  async loadPersistedConfig(): Promise<PersistedCloudConfig | null> {
    try {
      const data = await readFile(CloudClientService.getConfigPath(), 'utf-8');
      const config = JSON.parse(data) as PersistedCloudConfig;
      if (config.cloudUrl && config.token && config.tier) {
        return config;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Persist current cloud connection config to disk for auto-reconnect.
   */
  private async persistConfig(): Promise<void> {
    if (!this.cloudUrl || !this.token) return;

    const config: PersistedCloudConfig = {
      cloudUrl: this.cloudUrl,
      token: this.token,
      tier: this.tier,
      connectedAt: new Date().toISOString(),
      ...(this.refreshToken && { refreshToken: this.refreshToken }),
    };

    const configPath = CloudClientService.getConfigPath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    this.logger.debug('Persisted cloud config to disk');
  }

  /**
   * Remove persisted cloud config from disk (on disconnect).
   */
  private async removePersistedConfig(): Promise<void> {
    try {
      await unlink(CloudClientService.getConfigPath());
      this.logger.debug('Removed persisted cloud config');
    } catch {
      // File may not exist — not an error
    }
  }

  // -------------------------------------------------------------------------
  // Template Fetching
  // -------------------------------------------------------------------------

  /**
   * Fetch the list of premium templates available on CrewlyAI Cloud.
   *
   * Requires an active cloud connection.
   *
   * @returns Array of template summaries
   * @throws Error when not connected or fetch fails
   *
   * @example
   * ```ts
   * const templates = await client.getTemplates();
   * console.log(templates.map(t => t.name));
   * ```
   */
  async getTemplates(): Promise<CloudTemplateSummary[]> {
    // If token is already known to be expired, return empty without hitting the API
    if (this.isTokenExpired()) return [];
    this.ensureConnected();

    const url = `${this.cloudUrl}${CLOUD_CONSTANTS.ENDPOINTS.TEMPLATES}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(CLOUD_CONSTANTS.TIMEOUTS.FETCH_TEMPLATES),
    });

    if (!response.ok) {
      // 401/403 means token expired or revoked — return empty list + update status
      if (this.isAuthError(response.status)) {
        this.handleAuthFailure('getTemplates', response.status);
        return [];
      }
      this.logger.error('Failed to fetch templates', { status: response.status });
      throw new Error(`Failed to fetch templates: ${response.status}`);
    }

    const data = (await response.json()) as { templates: CloudTemplateSummary[] };
    this.lastSyncAt = new Date().toISOString();
    return data.templates || [];
  }

  /**
   * Fetch full detail for a single premium template.
   *
   * The returned data is held in memory only and must never be
   * persisted to disk.
   *
   * @param id - Template identifier
   * @returns Template detail object
   * @throws Error when not connected, template not found, or fetch fails
   *
   * @example
   * ```ts
   * const detail = await client.getTemplateDetail('tpl-tiktok-ops');
   * ```
   */
  async getTemplateDetail(id: string): Promise<CloudTemplateDetail> {
    // If token is already known to be expired, throw user-friendly error
    if (this.isTokenExpired()) {
      throw new Error('Cloud token expired. Please reconnect to CrewlyAI Cloud.');
    }
    this.ensureConnected();

    const endpoint = CLOUD_CONSTANTS.ENDPOINTS.TEMPLATE_DETAIL.replace(':id', id);
    const url = `${this.cloudUrl}${endpoint}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(CLOUD_CONSTANTS.TIMEOUTS.FETCH_TEMPLATE_DETAIL),
    });

    if (!response.ok) {
      // 401/403 means token expired or revoked
      if (this.isAuthError(response.status)) {
        this.handleAuthFailure('getTemplateDetail', response.status);
        throw new Error('Cloud token expired. Please reconnect to CrewlyAI Cloud.');
      }
      if (response.status === 404) {
        throw new Error(`Template not found: ${id}`);
      }
      this.logger.error('Failed to fetch template detail', { id, status: response.status });
      throw new Error(`Failed to fetch template detail: ${response.status}`);
    }

    const data = (await response.json()) as CloudTemplateDetail;
    this.lastSyncAt = new Date().toISOString();
    return data;
  }

  /**
   * Get the stored cloud API base URL (set during connect).
   *
   * @returns Cloud URL or null if not connected
   */
  getCloudUrl(): string | null {
    return this.cloudUrl;
  }

  /**
   * Get the current cloud connection status and subscription tier.
   *
   * @returns Current status snapshot
   */
  getStatus(): CloudStatus {
    return {
      connectionStatus: this.connectionStatus,
      cloudUrl: this.cloudUrl,
      tier: this.tier,
      lastSyncAt: this.lastSyncAt,
    };
  }

  /**
   * Check whether the client is currently connected to cloud.
   *
   * @returns true if connected
   */
  isConnected(): boolean {
    return this.connectionStatus === CLOUD_CONSTANTS.CONNECTION_STATUS.CONNECTED;
  }

  /**
   * Check whether the cloud token has expired (401/403 from cloud API).
   *
   * @returns true if the token has expired
   */
  isTokenExpired(): boolean {
    return this.connectionStatus === CLOUD_CONSTANTS.CONNECTION_STATUS.TOKEN_EXPIRED;
  }

  /**
   * Get the current subscription tier.
   *
   * @returns Current tier value
   */
  getTier(): CloudTier {
    return this.tier;
  }

  /**
   * Fetch the list of devices registered to this user from Cloud.
   *
   * Proxies GET /api/v1/relay/devices on crewlyai.com and returns
   * the device list for the authenticated user.
   *
   * @returns Array of cloud relay devices
   * @throws Error when not connected or fetch fails
   */
  async fetchCloudDevices(): Promise<CloudRelayDevice[]> {
    // If token is already known to be expired, return empty without hitting the API
    if (this.isTokenExpired()) return [];
    this.ensureConnected();

    const url = `${this.cloudUrl}${CLOUD_CONSTANTS.RELAY_ENDPOINTS.DEVICES}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(CLOUD_CONSTANTS.TIMEOUTS.FETCH_TEMPLATES),
    });

    if (!response.ok) {
      // 401/403 means token expired or revoked — return empty list + update status
      if (this.isAuthError(response.status)) {
        this.handleAuthFailure('fetchCloudDevices', response.status);
        return [];
      }
      // 404 means the cloud devices endpoint is not yet available — return empty list gracefully
      if (response.status === 404) {
        this.logger.warn('Cloud devices endpoint not available (404), returning empty list');
        return [];
      }
      this.logger.error('Failed to fetch cloud devices', { status: response.status });
      throw new Error(`Failed to fetch cloud devices: ${response.status}`);
    }

    const data = (await response.json()) as { success: boolean; devices?: CloudRelayDevice[] };

    if (!data.success) {
      throw new Error('Cloud devices API returned unsuccessful response');
    }

    this.lastSyncAt = new Date().toISOString();
    return data.devices ?? [];
  }

  // -------------------------------------------------------------------------
  // Token Auto-Refresh
  // -------------------------------------------------------------------------

  /**
   * Set the refresh token for auto-renewal.
   *
   * Called by the connect controller after OAuth login provides a refresh token.
   *
   * @param refreshToken - Refresh token string
   */
  setRefreshToken(refreshToken: string): void {
    this.refreshToken = refreshToken;
    // Re-persist config with the new refresh token
    this.persistConfig().catch(() => {});
    this.logger.debug('Refresh token stored');
  }

  /**
   * Get the current access token (for CloudSyncService token updates).
   *
   * @returns Current access token or null
   */
  getToken(): string | null {
    return this.token;
  }

  /**
   * Attempt to refresh the access token using the stored refresh token.
   *
   * Issues a new access token locally (since both access and refresh tokens
   * are signed with the same HMAC secret on this OSS instance).
   *
   * @returns true if refresh succeeded, false if no refresh token or refresh failed
   */
  async tryRefreshToken(): Promise<boolean> {
    if (this.refreshInProgress) {
      this.logger.debug('Token refresh already in progress, skipping');
      return false;
    }
    if (!this.refreshToken) {
      this.logger.debug('No refresh token available for auto-refresh');
      return false;
    }

    this.refreshInProgress = true;
    try {
      // Dynamically import to avoid circular dependency
      const { verifyJwt, signJwt } = await import('../../controllers/cloud/cloud-google-auth.controller.js');

      const payload = verifyJwt(this.refreshToken);
      if (!payload || payload.type !== 'refresh') {
        this.logger.warn('Refresh token verification failed — cannot auto-refresh', {
          hasPayload: !!payload,
          type: payload?.type,
        });
        // IMPORTANT: Do NOT clear this.refreshToken here. The refresh token may
        // still be valid on the Cloud side (which only checks exp, not signature).
        // Clearing it would permanently lose the ability to refresh, requiring
        // the user to re-authenticate via OAuth. The token is only cleared on
        // explicit disconnect().
        return false;
      }

      // Resolve device ID from the LOCAL device identity (always preferred).
      // The refresh token may carry a stale deviceId from a different machine
      // (e.g. when tokens are copied between machines via shared config).
      // Using the local identity ensures the JWT identifies THIS machine.
      let deviceId: string | undefined;
      try {
        const { DeviceIdentityService } = await import('./device-identity.service.js');
        const identity = await DeviceIdentityService.getInstance().getOrCreateIdentity();
        deviceId = identity.deviceId;
      } catch {
        // Fallback to refresh token's deviceId if local identity unavailable
        deviceId = payload.deviceId as string | undefined;
      }

      // Issue a new access token from the refresh token claims
      const now = Math.floor(Date.now() / 1000);
      const newAccessToken = signJwt({
        sub: payload.sub,
        email: payload.email || '',
        name: payload.name || '',
        plan: payload.plan || 'free',
        ...(deviceId && { deviceId }),
        iat: now,
        exp: now + AUTH_CONSTANTS.JWT.ACCESS_TOKEN_EXPIRY_S,
        iss: AUTH_CONSTANTS.JWT.ISSUER,
        type: 'access',
      });

      // Update service state
      this.token = newAccessToken;
      this.connectionStatus = CLOUD_CONSTANTS.CONNECTION_STATUS.CONNECTED;
      this.lastSyncAt = new Date().toISOString();

      // Schedule next refresh
      this.scheduleTokenRefresh(newAccessToken);

      // Persist new token
      await this.persistConfig();

      // Update CloudSyncService with the new token (if running)
      try {
        const { CloudSyncService } = await import('./cloud-sync.service.js');
        const syncService = CloudSyncService.getInstance();
        if (syncService.isStarted()) {
          syncService.updateToken(newAccessToken);
        }
      } catch {
        // CloudSyncService may not be available — non-fatal
      }

      this.logger.info('Access token auto-refreshed successfully', {
        sub: payload.sub,
        expiresIn: AUTH_CONSTANTS.JWT.ACCESS_TOKEN_EXPIRY_S,
      });

      return true;
    } catch (error) {
      this.logger.warn('Token auto-refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      this.refreshInProgress = false;
    }
  }

  /**
   * Schedule a proactive token refresh 5 minutes before expiry.
   *
   * Parses the JWT `exp` claim and sets a timer. If the token has
   * less than 5 minutes remaining, refreshes immediately.
   *
   * @param token - JWT access token to extract expiry from
   */
  private scheduleTokenRefresh(token: string): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (!this.refreshToken) return;

    try {
      // Decode JWT payload to get exp (without verifying — just need the timestamp)
      const parts = token.split('.');
      if (parts.length !== 3) return;
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
      const exp = payload.exp as number;
      if (!exp) return;

      const now = Math.floor(Date.now() / 1000);
      // Refresh 5 minutes (300s) before expiry
      const refreshAt = exp - 300;
      const delayMs = Math.max(0, (refreshAt - now) * 1000);

      if (delayMs <= 0) {
        // Token already near expiry — refresh immediately
        this.logger.info('Access token near expiry, refreshing immediately');
        this.tryRefreshToken().catch(() => {});
        return;
      }

      this.refreshTimer = setTimeout(() => {
        this.logger.info('Proactive token refresh triggered');
        this.tryRefreshToken().catch(() => {});
      }, delayMs);

      // Unref so the timer doesn't keep the process alive
      if (this.refreshTimer.unref) this.refreshTimer.unref();

      const minutesUntilRefresh = Math.round(delayMs / 60_000);
      this.logger.debug('Token refresh scheduled', { minutesUntilRefresh });
    } catch {
      this.logger.debug('Could not schedule token refresh (non-fatal)');
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Throw if the client is not in a connected state.
   *
   * @throws Error when not connected
   */
  private ensureConnected(): void {
    if (!this.isConnected() || !this.cloudUrl || !this.token) {
      throw new Error('Not connected to CrewlyAI Cloud. Call connect() first.');
    }
  }

  /**
   * Build the standard authorization headers for cloud API requests.
   *
   * @returns Headers object with Authorization and Content-Type
   */
  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Check if an HTTP status code indicates an authentication/authorization failure.
   *
   * @param status - HTTP status code
   * @returns true if the status is 401 or 403
   */
  private isAuthError(status: number): boolean {
    return status === 401 || status === 403;
  }

  /**
   * Handle a 401/403 response from the cloud API by transitioning
   * the connection status to TOKEN_EXPIRED. This signals the frontend
   * to show a reconnect prompt instead of a raw error.
   *
   * @param context - Description of the failed operation (for logging)
   * @param status - HTTP status code from the cloud API
   */
  private handleAuthFailure(context: string, status: number): void {
    this.logger.warn(`Cloud token expired or revoked during ${context}`, { status });
    this.connectionStatus = CLOUD_CONSTANTS.CONNECTION_STATUS.TOKEN_EXPIRED;

    // Attempt auto-refresh in background if refresh token is available
    if (this.refreshToken) {
      this.tryRefreshToken().then((refreshed) => {
        if (refreshed) {
          this.logger.info(`Token auto-refreshed after ${context} auth failure`);
        }
      }).catch(() => {});
    }
  }
}
