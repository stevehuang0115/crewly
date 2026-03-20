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
  /** Current connection status */
  private connectionStatus: CloudConnectionStatus = CLOUD_CONSTANTS.CONNECTION_STATUS.DISCONNECTED;
  /** Subscription tier reported by cloud */
  private tier: CloudTier = CLOUD_CONSTANTS.TIERS.FREE;
  /** Timestamp of the most recent successful cloud API call */
  private lastSyncAt: string | null = null;

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
  async connect(cloudUrl: string, token: string): Promise<{ success: boolean; tier: CloudTier }> {
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
    this.tier = (resolvedTier as CloudTier) || CLOUD_CONSTANTS.TIERS.FREE;
    this.connectionStatus = CLOUD_CONSTANTS.CONNECTION_STATUS.CONNECTED;
    this.lastSyncAt = new Date().toISOString();

    this.logger.info('Connected to CrewlyAI Cloud', { tier: this.tier });

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
   */
  connectLocal(cloudUrl: string, token: string, tier: CloudTier): void {
    this.cloudUrl = cloudUrl;
    this.token = token;
    this.tier = tier || CLOUD_CONSTANTS.TIERS.FREE;
    this.connectionStatus = CLOUD_CONSTANTS.CONNECTION_STATUS.CONNECTED;
    this.lastSyncAt = new Date().toISOString();

    this.logger.info('Connected to CrewlyAI Cloud (local verification)', { tier: this.tier });

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
    this.connectionStatus = CLOUD_CONSTANTS.CONNECTION_STATUS.DISCONNECTED;
    this.tier = CLOUD_CONSTANTS.TIERS.FREE;
    this.lastSyncAt = null;

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
  }
}
