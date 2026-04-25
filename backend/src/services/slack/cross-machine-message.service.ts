/**
 * Cross-Machine Message Service
 *
 * Enables Crewly instances on different machines to communicate
 * via the CloudSync HTTP-polling transport layer. Messages are routed
 * through the CrewlyAI Cloud message queue (heartbeat-based device
 * discovery + HTTP-polled delivery), providing built-in auth, persistence,
 * and offline tolerance without requiring WebSocket connections.
 *
 * @module services/slack/cross-machine-message
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { createRequire } from 'module';

/**
 * CJS-style `require` for the lazy CloudSync lookup below. Keeps the
 * load deferred (CloudSync may not be available in all builds) without
 * tripping `ReferenceError: require is not defined` under ESM.
 */
const nodeRequire: NodeRequire =
  typeof require === 'function'
    ? require
    : createRequire(new Function('return import.meta.url')() as string);
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { DeviceIdentityService, type DeviceIdentity } from '../cloud/device-identity.service.js';
import type { SlackIncomingMessage } from '../../types/slack.types.js';
import {
  type CrossMachineMessage,
  type CrossMachineMessageType,
  type CrossMachineConfig,
  type CrossMachineSendResult,
  parseCrossMachineMessage,
} from '../../types/cross-machine.types.js';
import { CROSS_MACHINE_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

/**
 * Events emitted by CrossMachineMessageService.
 */
export interface CrossMachineEvents {
  /** Fired when a cross-machine message addressed to this machine is received */
  message: (message: CrossMachineMessage) => void;
  /** Fired when a broadcast message is received */
  broadcast: (message: CrossMachineMessage) => void;
  /** Fired on errors */
  error: (error: Error) => void;
}

/** Config file path relative to ~/.crewly/ */
const CONFIG_FILE = 'cross-machine.json';

/** Singleton instance */
let serviceInstance: CrossMachineMessageService | null = null;

/**
 * CrossMachineMessageService
 *
 * Singleton service managing cross-machine communication via CloudSync.
 * On send: constructs a CrossMachineMessage and posts it through the
 * Cloud message queue (CloudSyncService.sendMessage).
 * On receive: the SlackOrchestratorBridge detects the prefix and calls
 * handleIncomingMessage(), which filters by target and emits events.
 *
 * @example
 * ```typescript
 * const service = getCrossMachineMessageService();
 * await service.initialize();
 *
 * // Send a task to another machine
 * await service.sendMessage('device-uuid-of-remote', 'delegate-task', {
 *   task: 'Run tests on feature branch',
 *   priority: 'high',
 * });
 *
 * // Listen for incoming messages
 * service.on('message', (msg) => {
 *   console.log(`Received ${msg.type} from ${msg.fromName}`);
 * });
 * ```
 */
export class CrossMachineMessageService extends EventEmitter {
  private readonly logger: ComponentLogger;
  private deviceIdentity: DeviceIdentityService;
  private config: CrossMachineConfig | null = null;
  private identity: DeviceIdentity | null = null;
  private initialized = false;

  /** Track processed message IDs to prevent duplicate handling */
  private processedMessageIds = new Set<string>();
  /** Maximum number of tracked message IDs before pruning */
  private readonly maxTrackedMessages: number;

  /**
   * Create a new CrossMachineMessageService.
   *
   * @param deviceIdentity - Optional DeviceIdentityService override (for testing)
   */
  constructor(deviceIdentity?: DeviceIdentityService) {
    super();
    this.logger = LoggerService.getInstance().createComponentLogger('CrossMachineMsg');
    this.deviceIdentity = deviceIdentity || DeviceIdentityService.getInstance();
    this.maxTrackedMessages = CROSS_MACHINE_CONSTANTS.MAX_TRACKED_MESSAGE_IDS;
  }

  /**
   * Initialize the service.
   * Loads device identity and cross-machine config from disk.
   *
   * @returns Promise that resolves when initialized
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.identity = await this.deviceIdentity.getOrCreateIdentity();
    this.config = await this.loadConfig();

    this.initialized = true;
    this.logger.info('Initialized', {
      deviceId: this.identity.deviceId,
      deviceName: this.identity.deviceName,
      enabled: this.config?.enabled ?? false,
      channelId: this.config?.channelId ?? 'not configured',
    });
  }

  /**
   * Check if the service is initialized and enabled.
   *
   * Returns true when initialized AND enabled, and either:
   * - A Slack channelId is configured (legacy path), OR
   * - CloudSyncService is started (new cloud transport path).
   *
   * @returns True if ready to send/receive messages
   */
  isEnabled(): boolean {
    if (!this.initialized || !this.config?.enabled) {
      return false;
    }

    // Legacy path: Slack channel configured
    if (this.config.channelId) {
      return true;
    }

    // Cloud transport path: CloudSync is running
    try {
      const { CloudSyncService } = nodeRequire('../cloud/cloud-sync.service.js');
      return CloudSyncService.getInstance().isStarted();
    } catch {
      return false;
    }
  }

  /**
   * Get the current configuration.
   *
   * @returns Cross-machine config or null
   */
  getConfig(): CrossMachineConfig | null {
    return this.config ? { ...this.config } : null;
  }

  /**
   * Get the local device identity.
   *
   * @returns Device identity or null if not initialized
   */
  getIdentity(): DeviceIdentity | null {
    return this.identity ? { ...this.identity } : null;
  }

  /**
   * Configure cross-machine messaging.
   * Persists the config to ~/.crewly/cross-machine.json.
   *
   * @param config - Configuration with Slack channel ID
   * @returns Promise that resolves when saved
   */
  async configure(config: CrossMachineConfig): Promise<void> {
    this.config = config;
    await this.saveConfig(config);
    this.logger.info('Configuration updated', { enabled: config.enabled, channelId: config.channelId });
  }

  /**
   * Send a cross-machine message via CloudSync API.
   *
   * All inter-device communication goes through the Cloud message queue.
   * Devices are identified by deviceId — no pairing required.
   *
   * @param targetDeviceId - Target machine's device ID (or "*" for broadcast)
   * @param type - Message type
   * @param payload - Message payload
   * @returns Send result with success status
   */
  async sendMessage(
    targetDeviceId: string,
    type: CrossMachineMessageType,
    payload: Record<string, unknown> = {}
  ): Promise<CrossMachineSendResult> {
    if (!this.isEnabled()) {
      return { success: false, error: 'Cross-machine messaging is not enabled or configured' };
    }

    if (!this.identity) {
      return { success: false, error: 'Device identity not initialized' };
    }

    const message: CrossMachineMessage = {
      protocol: 'crewly-x-machine',
      version: 1,
      from: this.identity.deviceId,
      fromName: this.identity.deviceName,
      to: targetDeviceId,
      type,
      payload,
      timestamp: new Date().toISOString(),
      messageId: uuidv4(),
    };

    try {
      const { CloudSyncService } = await import('../cloud/cloud-sync.service.js');
      const syncService = CloudSyncService.getInstance();

      if (!syncService.isStarted()) {
        return { success: false, error: 'CloudSync is not started — cannot send cross-machine message' };
      }

      // For broadcasts, send to all known devices
      if (targetDeviceId === '*') {
        const devices = syncService.getDevices();
        const selfId = this.identity.deviceId;
        const targets = devices.filter(d => d.deviceId !== selfId && d.status === 'online');

        if (targets.length === 0) {
          return { success: false, error: 'No online remote devices found for broadcast' };
        }

        for (const device of targets) {
          await syncService.sendMessage(device.deviceId, 'cross-machine', message);
        }

        this.logger.info('Broadcast cross-machine message via CloudSync', {
          type,
          messageId: message.messageId,
          targetCount: targets.length,
        });

        return { success: true };
      }

      await syncService.sendMessage(targetDeviceId, 'cross-machine', message);

      this.logger.info('Sent cross-machine message via CloudSync', {
        to: targetDeviceId,
        type,
        messageId: message.messageId,
      });

      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to send cross-machine message', {
        error: errorMsg,
        to: targetDeviceId,
        type,
      });
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Handle an incoming Slack message that has been identified as a
   * cross-machine message by the SlackOrchestratorBridge.
   *
   * Checks if the message is addressed to this machine, deduplicates,
   * and emits appropriate events.
   *
   * @param slackMessage - The raw Slack incoming message
   * @returns True if the message was handled (addressed to us), false if ignored
   */
  handleIncomingMessage(slackMessage: SlackIncomingMessage): boolean {
    const parsed = parseCrossMachineMessage(slackMessage.text);
    if (!parsed) {
      return false;
    }

    // Ignore messages from ourselves
    if (this.identity && parsed.from === this.identity.deviceId) {
      this.logger.debug('Ignoring own message', { messageId: parsed.messageId });
      return true; // Handled (by ignoring)
    }

    // Deduplicate
    if (this.processedMessageIds.has(parsed.messageId)) {
      this.logger.debug('Ignoring duplicate message', { messageId: parsed.messageId });
      return true;
    }

    // Track message ID
    this.processedMessageIds.add(parsed.messageId);
    if (this.processedMessageIds.size > this.maxTrackedMessages) {
      // Prune oldest entries (Set preserves insertion order)
      const iterator = this.processedMessageIds.values();
      const halfSize = Math.floor(this.maxTrackedMessages / 2);
      for (let i = 0; i < halfSize; i++) {
        const val = iterator.next().value;
        if (val !== undefined) {
          this.processedMessageIds.delete(val);
        }
      }
    }

    // Check if addressed to us or broadcast
    const isForUs = this.identity && (
      parsed.to === this.identity.deviceId ||
      parsed.to === '*'
    );

    if (!isForUs) {
      this.logger.debug('Ignoring message addressed to another machine', {
        to: parsed.to,
        ourId: this.identity?.deviceId,
      });
      return true; // Handled (by ignoring — not for us)
    }

    this.logger.info('Received cross-machine message', {
      from: parsed.fromName,
      fromId: parsed.from,
      type: parsed.type,
      messageId: parsed.messageId,
    });

    // Handle ping/pong automatically
    if (parsed.type === 'ping') {
      this.sendMessage(parsed.from, 'pong', { inResponseTo: parsed.messageId }).catch(err => {
        this.logger.warn('Failed to send pong', { error: err instanceof Error ? err.message : String(err) });
      });
    }

    // Emit events
    if (parsed.to === '*') {
      this.emit('broadcast', parsed);
    }
    this.emit('message', parsed);

    return true;
  }

  /**
   * Load cross-machine config from disk.
   *
   * @returns Config or null if not configured
   */
  private async loadConfig(): Promise<CrossMachineConfig | null> {
    const configPath = join(homedir(), '.crewly', CONFIG_FILE);
    try {
      if (existsSync(configPath)) {
        const content = await readFile(configPath, 'utf-8');
        return JSON.parse(content) as CrossMachineConfig;
      }
    } catch (error) {
      this.logger.warn('Failed to load cross-machine config', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  /**
   * Save cross-machine config to disk.
   *
   * @param config - Configuration to persist
   */
  private async saveConfig(config: CrossMachineConfig): Promise<void> {
    const crewlyHome = join(homedir(), '.crewly');
    const configPath = join(crewlyHome, CONFIG_FILE);
    try {
      if (!existsSync(crewlyHome)) {
        await mkdir(crewlyHome, { recursive: true });
      }
      await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('Failed to save cross-machine config', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Reset the singleton instance (for testing).
   */
  static resetInstance(): void {
    serviceInstance = null;
  }
}

/**
 * Get the singleton CrossMachineMessageService instance.
 *
 * @returns The service instance
 */
export function getCrossMachineMessageService(): CrossMachineMessageService {
  if (!serviceInstance) {
    serviceInstance = new CrossMachineMessageService();
  }
  return serviceInstance;
}
