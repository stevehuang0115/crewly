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

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import {
  CLOUD_CONSTANTS,
  type CloudTier,
  type CloudConnectionStatus,
} from '../../constants.js';

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
  /** Human-readable device name */
  name?: string;
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

  /** Cloud API base URL (e.g. "https://cloud.crewly.dev") */
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
   * await client.connect('https://cloud.crewly.dev', 'sk-abc123');
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

    const data = (await response.json()) as { tier?: string };

    this.cloudUrl = cloudUrl;
    this.token = token;
    this.tier = (data.tier as CloudTier) || CLOUD_CONSTANTS.TIERS.FREE;
    this.connectionStatus = CLOUD_CONSTANTS.CONNECTION_STATUS.CONNECTED;
    this.lastSyncAt = new Date().toISOString();

    this.logger.info('Connected to CrewlyAI Cloud', { tier: this.tier });
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
  }

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
    this.ensureConnected();

    const url = `${this.cloudUrl}${CLOUD_CONSTANTS.ENDPOINTS.TEMPLATES}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(CLOUD_CONSTANTS.TIMEOUTS.FETCH_TEMPLATES),
    });

    if (!response.ok) {
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
    this.ensureConnected();

    const endpoint = CLOUD_CONSTANTS.ENDPOINTS.TEMPLATE_DETAIL.replace(':id', id);
    const url = `${this.cloudUrl}${endpoint}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(CLOUD_CONSTANTS.TIMEOUTS.FETCH_TEMPLATE_DETAIL),
    });

    if (!response.ok) {
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
    this.ensureConnected();

    const url = `${this.cloudUrl}${CLOUD_CONSTANTS.RELAY_ENDPOINTS.DEVICES}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(CLOUD_CONSTANTS.TIMEOUTS.FETCH_TEMPLATES),
    });

    if (!response.ok) {
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
}
