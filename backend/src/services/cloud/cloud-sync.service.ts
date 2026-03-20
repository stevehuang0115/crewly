/**
 * Cloud Sync Service
 *
 * Singleton service that replaces the WebSocket Relay pairing model with a
 * simpler heartbeat + polling architecture. All devices under the same Cloud
 * account are automatically visible and can exchange messages.
 *
 * Responsibilities:
 * - Heartbeat: periodically uploads device status to Cloud
 * - Device poll: periodically fetches the device list for the account
 * - Message poll: periodically fetches pending messages for this device
 * - Send: posts messages to specific devices via Cloud
 *
 * @see docs/cloud-sync-design.md
 * @module services/cloud/cloud-sync.service
 */

import { EventEmitter } from 'events';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { StorageService } from '../core/storage.service.js';
import { CLOUD_SYNC_CONSTANTS } from '../../constants.js';
import type {
  CloudSyncConfig,
  CloudSyncState,
  SyncDevice,
  SyncTeamSummary,
  HeartbeatPayload,
  IncomingMessage,
  MessageType,
} from './cloud-sync.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the Crewly version from package.json (best-effort).
 *
 * @returns Version string or 'unknown'
 */
async function readVersion(): Promise<string> {
  try {
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf-8'));
    return (pkg.version as string) || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Gather active team summaries from StorageService.
 *
 * @returns Array of team summaries for heartbeat payload
 */
async function gatherTeamSummaries(): Promise<SyncTeamSummary[]> {
  try {
    const storage = StorageService.getInstance();
    const teams = await storage.getTeams();
    return teams.map((team) => ({
      id: team.id,
      name: team.name,
      memberCount: team.members?.length ?? 0,
      activeAgents: team.members?.filter((m: any) => m.agentStatus === 'active').length ?? 0,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * CloudSyncService singleton.
 *
 * Manages heartbeat, device discovery, and message polling for the
 * Cloud Sync system. Extends EventEmitter to notify consumers of
 * device and message changes.
 *
 * Events:
 * - `devices_updated` — Fired when the device list changes. Payload: SyncDevice[]
 * - `message` — Fired for each incoming message. Payload: IncomingMessage
 * - `device_online` — Fired when a device comes online. Payload: SyncDevice
 * - `device_offline` — Fired when a device goes offline. Payload: SyncDevice
 *
 * @example
 * ```typescript
 * const sync = CloudSyncService.getInstance();
 * sync.start({ cloudUrl, token, deviceId, deviceName });
 * sync.on('message', (msg) => console.log('Received:', msg));
 * sync.on('devices_updated', (devices) => console.log('Devices:', devices));
 * ```
 */
export class CloudSyncService extends EventEmitter {
  private static instance: CloudSyncService | null = null;
  private readonly logger: ComponentLogger;

  /** Current service state */
  private state: CloudSyncState = 'stopped';
  /** Configuration (set on start) */
  private config: CloudSyncConfig | null = null;
  /** Cached device list from last poll */
  private devices: SyncDevice[] = [];
  /** Cached Crewly version */
  private version = 'unknown';

  /** Heartbeat timer handle */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Device poll timer handle */
  private devicePollTimer: ReturnType<typeof setInterval> | null = null;
  /** Message poll timer handle */
  private messagePollTimer: ReturnType<typeof setInterval> | null = null;

  /** Consecutive heartbeat failure count */
  private heartbeatFailures = 0;
  /** Consecutive device poll failure count */
  private devicePollFailures = 0;
  /** Consecutive message poll failure count */
  private messagePollFailures = 0;

  private constructor() {
    super();
    this.logger = LoggerService.getInstance().createComponentLogger('CloudSyncService');
  }

  /**
   * Get the singleton instance.
   *
   * @returns CloudSyncService instance
   */
  static getInstance(): CloudSyncService {
    if (!CloudSyncService.instance) {
      CloudSyncService.instance = new CloudSyncService();
    }
    return CloudSyncService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    if (CloudSyncService.instance) {
      CloudSyncService.instance.stop();
    }
    CloudSyncService.instance = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start the Cloud Sync service.
   *
   * Begins heartbeat, device polling, and message polling timers.
   * Performs an immediate heartbeat and device poll on start.
   *
   * @param config - Cloud connection configuration
   */
  start(config: CloudSyncConfig): void {
    if (this.state === 'syncing') {
      this.logger.warn('CloudSyncService already running, ignoring start()');
      return;
    }

    this.config = config;
    this.state = 'syncing';
    this.heartbeatFailures = 0;
    this.devicePollFailures = 0;
    this.messagePollFailures = 0;

    this.logger.info('Starting Cloud Sync', {
      cloudUrl: config.cloudUrl,
      deviceId: config.deviceId,
      deviceName: config.deviceName,
    });

    // Read version once at startup
    readVersion().then((v) => { this.version = v; }).catch(() => {});

    // Perform initial sync immediately
    this.sendHeartbeat().catch(() => {});
    this.pollDevices().catch(() => {});

    // Start periodic timers
    this.heartbeatTimer = setInterval(
      () => { this.sendHeartbeat().catch(() => {}); },
      CLOUD_SYNC_CONSTANTS.HEARTBEAT_INTERVAL_MS
    );
    this.devicePollTimer = setInterval(
      () => { this.pollDevices().catch(() => {}); },
      CLOUD_SYNC_CONSTANTS.DEVICE_POLL_INTERVAL_MS
    );
    this.messagePollTimer = setInterval(
      () => { this.pollMessages().catch(() => {}); },
      CLOUD_SYNC_CONSTANTS.MESSAGE_POLL_INTERVAL_MS
    );

    // Unref timers so they don't keep the process alive
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    if (this.devicePollTimer.unref) this.devicePollTimer.unref();
    if (this.messagePollTimer.unref) this.messagePollTimer.unref();
  }

  /**
   * Stop the Cloud Sync service.
   *
   * Clears all timers and resets state. Safe to call multiple times.
   */
  stop(): void {
    if (this.state === 'stopped') return;

    this.logger.info('Stopping Cloud Sync');

    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.devicePollTimer) { clearInterval(this.devicePollTimer); this.devicePollTimer = null; }
    if (this.messagePollTimer) { clearInterval(this.messagePollTimer); this.messagePollTimer = null; }

    this.state = 'stopped';
    this.config = null;
    this.devices = [];
    this.heartbeatFailures = 0;
    this.devicePollFailures = 0;
    this.messagePollFailures = 0;
  }

  /**
   * Check if the sync service has been started.
   *
   * @returns True if the service is currently syncing
   */
  isStarted(): boolean {
    return this.state === 'syncing';
  }

  /**
   * Get the current service state.
   *
   * @returns Current CloudSyncState
   */
  getState(): CloudSyncState {
    return this.state;
  }

  /**
   * Get all cached devices for this Cloud account.
   *
   * @returns Array of SyncDevice objects (may include offline devices)
   */
  getDevices(): SyncDevice[] {
    return [...this.devices];
  }

  /**
   * Get only online devices (excluding this device).
   *
   * @returns Array of online SyncDevice objects
   */
  getOnlineDevices(): SyncDevice[] {
    return this.devices.filter((d) => d.status === 'online' && !d.isLocal);
  }

  /**
   * Send a message to another device via the Cloud message queue.
   *
   * @param toDeviceId - Target device identifier
   * @param type - Message type
   * @param payload - Message payload (must be JSON-serializable)
   * @throws Error when not started or API call fails
   *
   * @example
   * ```typescript
   * await sync.sendMessage('dev-456', 'command', {
   *   action: 'delegate-task',
   *   content: 'Implement feature X'
   * });
   * ```
   */
  async sendMessage(toDeviceId: string, type: MessageType, payload: unknown): Promise<void> {
    if (!this.config) {
      throw new Error('CloudSyncService not started. Call start() first.');
    }

    const url = `${this.config.cloudUrl}${CLOUD_SYNC_CONSTANTS.ENDPOINTS.MESSAGES}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        to: toDeviceId,
        type,
        payload,
        encrypted: false,
      }),
      signal: AbortSignal.timeout(CLOUD_SYNC_CONSTANTS.REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Failed to send message: ${response.status} ${errorText}`);
    }

    this.logger.info('Message sent via Cloud Sync', { to: toDeviceId, type });
  }

  // -------------------------------------------------------------------------
  // Internal: Heartbeat
  // -------------------------------------------------------------------------

  /**
   * Send a heartbeat to the Cloud server with current device state.
   * Called periodically by the heartbeat timer.
   */
  async sendHeartbeat(): Promise<void> {
    if (!this.config) return;

    try {
      const teams = await gatherTeamSummaries();

      const payload: HeartbeatPayload = {
        deviceId: this.config.deviceId,
        deviceName: this.config.deviceName,
        status: 'online',
        version: this.version,
        capabilities: ['orchestrator', 'agent-runner'],
        teams,
        timestamp: new Date().toISOString(),
      };

      const url = `${this.config.cloudUrl}${CLOUD_SYNC_CONSTANTS.ENDPOINTS.HEARTBEAT}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CLOUD_SYNC_CONSTANTS.REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Heartbeat failed: ${response.status}`);
      }

      this.heartbeatFailures = 0;
    } catch (error) {
      this.heartbeatFailures++;
      this.logger.warn('Heartbeat failed', {
        error: error instanceof Error ? error.message : String(error),
        failures: this.heartbeatFailures,
      });
      this.checkErrorThreshold();
    }
  }

  // -------------------------------------------------------------------------
  // Internal: Device Polling
  // -------------------------------------------------------------------------

  /**
   * Poll the Cloud server for the current device list.
   * Updates the cached device list and emits events on changes.
   */
  async pollDevices(): Promise<void> {
    if (!this.config) return;

    try {
      const url = `${this.config.cloudUrl}${CLOUD_SYNC_CONSTANTS.ENDPOINTS.DEVICES}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(CLOUD_SYNC_CONSTANTS.REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Device poll failed: ${response.status}`);
      }

      const data = await response.json() as { success: boolean; devices?: SyncDevice[] };

      if (!data.success || !data.devices) {
        throw new Error('Device poll returned unsuccessful response');
      }

      const previousOnlineIds = new Set(
        this.devices.filter((d) => d.status === 'online').map((d) => d.deviceId)
      );

      // Normalize devices: mark local, determine online status
      const offlineThreshold = CLOUD_SYNC_CONSTANTS.OFFLINE_THRESHOLD_MS;
      const now = Date.now();
      const updatedDevices: SyncDevice[] = data.devices.map((d) => ({
        ...d,
        status: (now - new Date(d.lastHeartbeatAt).getTime() > offlineThreshold)
          ? 'offline' as const
          : 'online' as const,
        isLocal: d.deviceId === this.config!.deviceId,
      }));

      // Detect online/offline transitions
      const newOnlineIds = new Set(
        updatedDevices.filter((d) => d.status === 'online').map((d) => d.deviceId)
      );

      for (const device of updatedDevices) {
        if (device.status === 'online' && !previousOnlineIds.has(device.deviceId) && !device.isLocal) {
          this.emit('device_online', device);
        }
      }
      for (const prevId of previousOnlineIds) {
        if (!newOnlineIds.has(prevId) && prevId !== this.config.deviceId) {
          const offlineDevice = this.devices.find((d) => d.deviceId === prevId);
          if (offlineDevice) {
            this.emit('device_offline', { ...offlineDevice, status: 'offline' });
          }
        }
      }

      this.devices = updatedDevices;
      this.devicePollFailures = 0;
      this.emit('devices_updated', this.getDevices());
    } catch (error) {
      this.devicePollFailures++;
      this.logger.warn('Device poll failed', {
        error: error instanceof Error ? error.message : String(error),
        failures: this.devicePollFailures,
      });
      this.checkErrorThreshold();
    }
  }

  // -------------------------------------------------------------------------
  // Internal: Message Polling
  // -------------------------------------------------------------------------

  /**
   * Poll the Cloud server for pending messages addressed to this device.
   * Emits 'message' event for each received message, then acknowledges.
   */
  async pollMessages(): Promise<void> {
    if (!this.config) return;

    try {
      const url = `${this.config.cloudUrl}${CLOUD_SYNC_CONSTANTS.ENDPOINTS.MESSAGES}?deviceId=${encodeURIComponent(this.config.deviceId)}&limit=50`;

      const response = await fetch(url, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(CLOUD_SYNC_CONSTANTS.REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Message poll failed: ${response.status}`);
      }

      const data = await response.json() as { success: boolean; messages?: IncomingMessage[] };

      if (!data.success || !data.messages || data.messages.length === 0) {
        this.messagePollFailures = 0;
        return;
      }

      // Emit each message
      const messageIds: string[] = [];
      for (const msg of data.messages) {
        this.emit('message', msg);
        messageIds.push(msg.id);
      }

      // Acknowledge processed messages
      await this.ackMessages(messageIds);

      this.messagePollFailures = 0;
      this.logger.debug('Polled and processed messages', { count: data.messages.length });
    } catch (error) {
      this.messagePollFailures++;
      this.logger.warn('Message poll failed', {
        error: error instanceof Error ? error.message : String(error),
        failures: this.messagePollFailures,
      });
      this.checkErrorThreshold();
    }
  }

  /**
   * Acknowledge processed messages so Cloud can remove them from the queue.
   *
   * @param messageIds - Array of message IDs to acknowledge
   */
  private async ackMessages(messageIds: string[]): Promise<void> {
    if (!this.config || messageIds.length === 0) return;

    try {
      const url = `${this.config.cloudUrl}${CLOUD_SYNC_CONSTANTS.ENDPOINTS.MESSAGES_ACK}`;

      await fetch(url, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          deviceId: this.config.deviceId,
          messageIds,
        }),
        signal: AbortSignal.timeout(CLOUD_SYNC_CONSTANTS.REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn('Message ACK failed (non-fatal)', {
        error: error instanceof Error ? error.message : String(error),
        messageIds,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internal: Error Handling
  // -------------------------------------------------------------------------

  /**
   * Check if any failure counter has exceeded the threshold.
   * If so, transition to error state.
   */
  private checkErrorThreshold(): void {
    const max = CLOUD_SYNC_CONSTANTS.MAX_CONSECUTIVE_FAILURES;
    if (
      this.heartbeatFailures >= max ||
      this.devicePollFailures >= max ||
      this.messagePollFailures >= max
    ) {
      this.logger.error('Cloud Sync entering error state after repeated failures', {
        heartbeatFailures: this.heartbeatFailures,
        devicePollFailures: this.devicePollFailures,
        messagePollFailures: this.messagePollFailures,
      });
      this.state = 'error';
    }
  }

  // -------------------------------------------------------------------------
  // Internal: Helpers
  // -------------------------------------------------------------------------

  /**
   * Build authorization headers for Cloud API requests.
   *
   * @returns Headers with Bearer token and Content-Type
   */
  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config?.token ?? ''}`,
      'Content-Type': 'application/json',
    };
  }
}
