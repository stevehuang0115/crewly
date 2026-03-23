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
  SyncAgentInfo,
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
 * Includes agent session details for cross-device routing.
 *
 * @returns Array of team summaries for heartbeat payload
 */
async function gatherTeamSummaries(): Promise<SyncTeamSummary[]> {
  try {
    const storage = StorageService.getInstance();
    const teams = await storage.getTeams();
    return teams.map((team) => {
      const members = team.members ?? [];
      const activeMembers = members.filter((m: any) => m.agentStatus === 'active');

      // Include session details for active agents so remote devices can route messages
      const agents: SyncAgentInfo[] = activeMembers
        .filter((m: any) => m.sessionName)
        .map((m: any) => ({
          sessionName: m.sessionName as string,
          role: (m.role as string) || 'agent',
          workingStatus: (m.workingStatus as string) || 'idle',
        }));

      return {
        id: team.id,
        name: team.name,
        memberCount: members.length,
        activeAgents: activeMembers.length,
        agents,
      };
    });
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
  /** Error recovery timer handle */
  private errorRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive error recovery attempts (reset on success or stop) */
  private errorRecoveryAttempts = 0;

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
    if (this.errorRecoveryTimer) { clearInterval(this.errorRecoveryTimer); this.errorRecoveryTimer = null; }

    this.state = 'stopped';
    this.config = null;
    this.devices = [];
    this.heartbeatFailures = 0;
    this.devicePollFailures = 0;
    this.messagePollFailures = 0;
    this.errorRecoveryAttempts = 0;
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
   * Update the authentication token used for Cloud API requests.
   *
   * Called by CloudClientService after a successful token refresh
   * so that heartbeat, device poll, and message poll use the new token.
   *
   * @param newToken - New JWT access token
   */
  updateToken(newToken: string): void {
    if (this.config) {
      this.config = { ...this.config, token: newToken };
      this.logger.info('CloudSyncService token updated');
    }
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

    // Cloud Relay queue/send expects { toDeviceId, payload }.
    // We wrap type + encrypted + actual payload into the payload field so
    // the receiver can reconstruct the full IncomingMessage shape on poll.
    const wrappedPayload = JSON.stringify({
      type,
      data: payload,
      encrypted: false,
      fromDeviceName: this.config.deviceName,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        toDeviceId,
        payload: wrappedPayload,
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
   *
   * Posts to the Cloud Relay handshake endpoint (/api/v1/relay/handshake)
   * which registers/updates the device with enriched metadata.
   */
  async sendHeartbeat(): Promise<void> {
    if (!this.config || this.state === 'error') return;

    try {
      const teams = await gatherTeamSummaries();

      // Cloud Relay handshake expects: { deviceId, deviceName, teams, version, timestamp }
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
        // On 401/403, attempt token refresh before counting as failure
        if (response.status === 401 || response.status === 403) {
          const refreshed = await this.handleAuthError(response.status);
          if (refreshed) {
            this.logger.info('Heartbeat will retry with refreshed token on next cycle');
            return;
          }
        }
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
   *
   * The Cloud server returns devices in relay format:
   * `{ sessionId, role, state, pairedWith, registeredAt, lastHeartbeatAt, name }`
   * which we normalize to the SyncDevice shape used by the frontend.
   */
  async pollDevices(): Promise<void> {
    if (!this.config || this.state === 'error') return;

    try {
      const url = `${this.config.cloudUrl}${CLOUD_SYNC_CONSTANTS.ENDPOINTS.DEVICES}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          ...this.authHeaders(),
          // Send the real local deviceId so the Cloud auto-register uses
          // THIS machine's identity, not the (potentially stale) JWT deviceId.
          'X-Device-Id': this.config.deviceId,
        },
        signal: AbortSignal.timeout(CLOUD_SYNC_CONSTANTS.REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        // On 401/403, attempt token refresh before counting as failure
        if (response.status === 401 || response.status === 403) {
          const refreshed = await this.handleAuthError(response.status);
          if (refreshed) {
            this.logger.info('Device poll will retry with refreshed token on next cycle');
            return;
          }
        }
        throw new Error(`Device poll failed: ${response.status}`);
      }

      const data = await response.json() as { success?: boolean; data?: any[]; devices?: any[] };

      // Cloud /api/v1/relay/devices returns { success, devices: Device[] }
      // Legacy endpoints returned { success, data: Device[] }
      // Support both formats for forward/backward compatibility
      const rawDevices = data.data || data.devices;

      if (!rawDevices) {
        // Empty response is valid when no other devices are online
        this.devices = [];
        this.devicePollFailures = 0;
        this.emit('devices_updated', this.getDevices());
        return;
      }

      const previousOnlineIds = new Set(
        this.devices.filter((d) => d.status === 'online').map((d) => d.deviceId)
      );

      // Normalize Cloud device records to SyncDevice format.
      // Cloud /api/devices returns: { deviceId, deviceName, email, teams, lastSeenAt }
      // Legacy relay returns: { sessionId, role, state, pairedWith, registeredAt, lastHeartbeatAt, name }
      // We need:              { deviceId, deviceName, status, lastHeartbeatAt, isLocal, ... }
      const offlineThreshold = CLOUD_SYNC_CONSTANTS.OFFLINE_THRESHOLD_MS;
      const now = Date.now();
      const updatedDevices: SyncDevice[] = rawDevices.map((d: any) => {
        const deviceId = d.deviceId || d.sessionId || '';
        const lastSeen = d.lastSeenAt || d.lastHeartbeatAt || d.registeredAt || new Date().toISOString();
        // Determine online/offline from heartbeat recency, explicit status, or relay state
        const isOnline = d.status === 'online' ||
          d.online === true ||
          d.state === 'paired' ||
          d.state === 'waiting' ||
          (now - new Date(lastSeen).getTime() <= offlineThreshold);

        return {
          deviceId,
          deviceName: d.deviceName || d.name || `Device ${deviceId.slice(0, 8)}`,
          status: isOnline ? 'online' as const : 'offline' as const,
          lastHeartbeatAt: lastSeen,
          isLocal: deviceId === this.config!.deviceId,
          version: d.version,
          capabilities: d.capabilities,
          // Preserve extra fields for the frontend
          ...(d.role && { role: d.role }),
          ...(d.state && { state: d.state }),
          ...(d.registeredAt && { registeredAt: d.registeredAt }),
          ...(d.sessionId && { sessionId: d.sessionId }),
          ...(d.email && { email: d.email }),
          ...(d.teams && { teams: d.teams }),
        } as SyncDevice;
      });

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

      // Deduplicate by deviceId — the Cloud API may return multiple records
      // for the same physical device (e.g., from relay handshake and device
      // heartbeat endpoints). Keep the entry with the most recent heartbeat.
      const deduped = new Map<string, SyncDevice>();
      for (const device of updatedDevices) {
        if (!device.deviceId) {
          // No deviceId — cannot deduplicate, keep as-is with a generated key
          deduped.set(`__no_id_${deduped.size}`, device);
          continue;
        }
        const existing = deduped.get(device.deviceId);
        if (!existing) {
          deduped.set(device.deviceId, device);
        } else {
          // Keep the one with the more recent heartbeat, or prefer online status
          const existingTime = new Date(existing.lastHeartbeatAt).getTime();
          const newTime = new Date(device.lastHeartbeatAt).getTime();
          if (newTime > existingTime || (device.status === 'online' && existing.status !== 'online')) {
            deduped.set(device.deviceId, device);
          }
        }
      }

      this.devices = Array.from(deduped.values());
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
   *
   * The Cloud Sync message poll endpoint uses `deviceId` query param.
   * Cloud returns messages as: `{ id, from, fromDeviceName, type, payload, encrypted, sentAt }`.
   */
  async pollMessages(): Promise<void> {
    if (!this.config || this.state === 'error') return;

    try {
      // Cloud Relay queue/poll accepts ?queueId= query param (fallback when JWT has no deviceId)
      const url = `${this.config.cloudUrl}${CLOUD_SYNC_CONSTANTS.ENDPOINTS.MESSAGES_POLL}?queueId=${encodeURIComponent(this.config.deviceId)}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(CLOUD_SYNC_CONSTANTS.REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        // On 401/403, attempt token refresh before counting as failure
        if (response.status === 401 || response.status === 403) {
          const refreshed = await this.handleAuthError(response.status);
          if (refreshed) {
            this.logger.info('Message poll will retry with refreshed token on next cycle');
            return;
          }
        }
        throw new Error(`Message poll failed: ${response.status}`);
      }

      const data = await response.json() as { success?: boolean; messages?: any[]; data?: any[] };

      // Support both { messages: [...] } and { data: [...] } response formats
      const rawMessages = data.messages || data.data;

      if (!rawMessages || rawMessages.length === 0) {
        this.messagePollFailures = 0;
        return;
      }

      // Normalize Cloud Relay message format to IncomingMessage shape.
      // Cloud returns: { id, fromDeviceId, payload (string), createdAt }.
      // The payload may be a JSON string wrapping { type, data, encrypted, fromDeviceName }
      // (sent by our sendMessage), or a raw string from legacy senders.
      const messageIds: string[] = [];
      for (const raw of rawMessages) {
        let msgType: MessageType = 'relay';
        let msgPayload: unknown = raw.payload;
        let msgEncrypted = false;
        let msgFromDeviceName = '';

        // Try to unwrap our wrapped payload format
        try {
          const parsed = typeof raw.payload === 'string' ? JSON.parse(raw.payload) : raw.payload;
          if (parsed && typeof parsed === 'object' && 'type' in parsed && 'data' in parsed) {
            msgType = parsed.type || 'relay';
            msgPayload = parsed.data;
            msgEncrypted = parsed.encrypted ?? false;
            msgFromDeviceName = parsed.fromDeviceName || '';
          }
        } catch {
          // Not JSON or not our format — use raw payload as-is
        }

        const msg: IncomingMessage = {
          id: raw.id,
          from: raw.fromDeviceId || raw.from || '',
          fromDeviceName: msgFromDeviceName,
          type: msgType,
          payload: msgPayload,
          encrypted: msgEncrypted,
          sentAt: raw.createdAt || raw.sentAt || new Date().toISOString(),
        };
        this.emit('message', msg);
        messageIds.push(msg.id);
      }

      // Acknowledge processed messages
      await this.ackMessages(messageIds);

      this.messagePollFailures = 0;
      this.logger.debug('Polled and processed messages', { count: rawMessages.length });
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
   * Uses `queueId` in body to identify the target message queue (fallback
   * when JWT has no deviceId claim).
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
          queueId: this.config.deviceId,
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
   * If so, transition to error state and schedule a recovery attempt.
   */
  private checkErrorThreshold(): void {
    if (this.state === 'error') return; // Already in error state, don't log repeatedly
    const max = CLOUD_SYNC_CONSTANTS.MAX_CONSECUTIVE_FAILURES;
    if (
      this.heartbeatFailures >= max ||
      this.devicePollFailures >= max ||
      this.messagePollFailures >= max
    ) {
      this.logger.error('Cloud Sync entering error state after repeated failures — scheduling recovery', {
        heartbeatFailures: this.heartbeatFailures,
        devicePollFailures: this.devicePollFailures,
        messagePollFailures: this.messagePollFailures,
      });
      this.state = 'error';
      this.scheduleErrorRecovery();
    }
  }

  /**
   * Schedule periodic recovery attempts when in error state.
   *
   * Tries a single heartbeat every ERROR_RECOVERY_INTERVAL_MS (60s by default).
   * If the heartbeat succeeds, resets all failure counters and resumes normal
   * polling. After MAX_ERROR_RECOVERY_ATTEMPTS consecutive auth failures (401/403),
   * transitions to 'auth_expired' terminal state and emits 'auth_expired'.
   */
  private scheduleErrorRecovery(): void {
    if (this.errorRecoveryTimer) return; // Already scheduled

    this.errorRecoveryAttempts = 0;
    const recoveryInterval = CLOUD_SYNC_CONSTANTS.ERROR_RECOVERY_INTERVAL_MS ?? 60_000;
    const maxAttempts = CLOUD_SYNC_CONSTANTS.MAX_ERROR_RECOVERY_ATTEMPTS ?? 5;

    this.errorRecoveryTimer = setInterval(async () => {
      if (this.state !== 'error' || !this.config) {
        if (this.errorRecoveryTimer) {
          clearInterval(this.errorRecoveryTimer);
          this.errorRecoveryTimer = null;
        }
        return;
      }

      this.errorRecoveryAttempts++;
      this.logger.info('Attempting Cloud Sync error recovery...', {
        attempt: this.errorRecoveryAttempts,
        maxAttempts,
      });

      try {
        const url = `${this.config.cloudUrl}${CLOUD_SYNC_CONSTANTS.ENDPOINTS.HEARTBEAT}`;
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

        const response = await fetch(url, {
          method: 'POST',
          headers: this.authHeaders(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(CLOUD_SYNC_CONSTANTS.REQUEST_TIMEOUT_MS),
        });

        if (response.ok) {
          this.logger.info('Cloud Sync recovery succeeded — resuming normal polling');
          this.heartbeatFailures = 0;
          this.devicePollFailures = 0;
          this.messagePollFailures = 0;
          this.errorRecoveryAttempts = 0;
          this.state = 'syncing';

          if (this.errorRecoveryTimer) {
            clearInterval(this.errorRecoveryTimer);
            this.errorRecoveryTimer = null;
          }

          this.pollDevices().catch(() => {});
        } else if (response.status === 401 || response.status === 403) {
          const refreshed = await this.handleAuthError(response.status);
          if (refreshed) {
            this.logger.info('Token refreshed during recovery — will retry next cycle');
            this.errorRecoveryAttempts--;
          } else if (this.errorRecoveryAttempts >= maxAttempts) {
            this.enterAuthExpiredState();
          } else {
            this.logger.warn('Recovery heartbeat auth failed, will retry', {
              status: response.status,
              attempt: this.errorRecoveryAttempts,
              remaining: maxAttempts - this.errorRecoveryAttempts,
            });
          }
        } else {
          this.logger.warn('Recovery heartbeat failed, will retry', { status: response.status });
        }
      } catch (error) {
        this.logger.warn('Recovery attempt failed, will retry', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, recoveryInterval);

    if (this.errorRecoveryTimer.unref) this.errorRecoveryTimer.unref();
  }

  /**
   * Transition to the terminal auth_expired state.
   * Clears all timers and emits 'auth_expired' for frontend notification.
   */
  private enterAuthExpiredState(): void {
    this.logger.error(
      'Cloud Sync authentication permanently failed — user must re-login',
      { attempts: this.errorRecoveryAttempts },
    );

    if (this.errorRecoveryTimer) { clearInterval(this.errorRecoveryTimer); this.errorRecoveryTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.devicePollTimer) { clearInterval(this.devicePollTimer); this.devicePollTimer = null; }
    if (this.messagePollTimer) { clearInterval(this.messagePollTimer); this.messagePollTimer = null; }

    this.state = 'auth_expired';
    this.emit('auth_expired');
  }

  /** Guard to prevent concurrent token refresh attempts */
  private tokenRefreshInProgress = false;

  /**
   * Check if an HTTP status code indicates an authentication failure (401/403).
   * If so, attempt to refresh the token via CloudClientService.
   * On success, updates this service's config with the new token.
   *
   * @param status - HTTP status code from a Cloud API response
   * @returns true if the token was refreshed successfully
   */
  private async handleAuthError(status: number): Promise<boolean> {
    if (status !== 401 && status !== 403) return false;
    if (this.tokenRefreshInProgress) return false;

    this.tokenRefreshInProgress = true;
    try {
      const { CloudClientService } = await import('./cloud-client.service.js');
      const client = CloudClientService.getInstance();

      const refreshed = await client.tryRefreshToken();
      if (refreshed) {
        const newToken = client.getToken();
        if (newToken && this.config) {
          this.config = { ...this.config, token: newToken };
          this.logger.info('CloudSyncService token refreshed after auth error');
        }
        return true;
      }

      this.logger.warn('CloudSyncService token refresh failed — API returned auth error', { status });
      return false;
    } catch (err) {
      this.logger.warn('CloudSyncService token refresh attempt threw', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      this.tokenRefreshInProgress = false;
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
