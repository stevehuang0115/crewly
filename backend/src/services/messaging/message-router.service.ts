/**
 * Message Router Service
 *
 * Provides transparent cross-device message routing for agent communication.
 * When a target agent session is not found locally, the router queries
 * CloudSyncService for same-account devices that host the agent and forwards
 * the message through the Cloud message queue.
 *
 * On the receiving end, listens for incoming `agent_message` events from
 * CloudSyncService and delivers them to the local agent session via the
 * standard terminal delivery path.
 *
 * This makes cross-device communication fully transparent to callers —
 * orchestrator skills (send-message, delegate-task) require zero changes.
 *
 * @module services/messaging/message-router.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { CloudSyncService } from '../cloud/cloud-sync.service.js';
import type {
  SyncDevice,
  IncomingMessage,
  AgentMessagePayload,
} from '../cloud/cloud-sync.types.js';
import { isAgentMessagePayload } from '../cloud/cloud-sync.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Constants for the MessageRouterService. */
export const MESSAGE_ROUTER_CONSTANTS = {
  /** Maximum time to wait for remote delivery confirmation (ms) */
  REMOTE_DELIVERY_TIMEOUT_MS: 15_000,
  /** Log component name */
  COMPONENT_NAME: 'MessageRouterService',
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a remote routing attempt. */
export interface RouteResult {
  /** Whether the message was successfully routed to a remote device */
  routed: boolean;
  /** Target device ID (if routed) */
  deviceId?: string;
  /** Target device name (if routed) */
  deviceName?: string;
  /** Error message (if routing failed) */
  error?: string;
}

/**
 * Handler function for delivering a message to a local agent session.
 * Injected via setLocalDeliveryHandler() to avoid circular dependencies
 * with terminal.controller / AgentRegistrationService.
 */
export type LocalDeliveryHandler = (
  sessionName: string,
  message: string,
) => Promise<{ success: boolean; error?: string }>;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * MessageRouterService singleton.
 *
 * Transparently routes agent messages across devices under the same
 * Cloud account. Local sessions are delivered directly; remote sessions
 * are forwarded via the Cloud message queue.
 *
 * @example
 * ```typescript
 * const router = MessageRouterService.getInstance();
 * router.setLocalDeliveryHandler(myDeliveryFn);
 * router.startListening();
 *
 * // Route a message — automatically determines local vs remote
 * const result = await router.routeRemote('crewly-product-leo', 'Hello Leo');
 * if (result.routed) {
 *   console.log(`Routed to device ${result.deviceName}`);
 * }
 * ```
 */
export class MessageRouterService {
  private static instance: MessageRouterService | null = null;
  private readonly logger: ComponentLogger;

  /** Whether we are listening for incoming agent_message events */
  private listening = false;
  /** Bound handler reference for cleanup */
  private boundMessageHandler: ((msg: IncomingMessage) => void) | null = null;
  /** Handler for delivering messages to local agent sessions */
  private localDeliveryHandler: LocalDeliveryHandler | null = null;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger(
      MESSAGE_ROUTER_CONSTANTS.COMPONENT_NAME
    );
  }

  /**
   * Get the singleton instance.
   *
   * @returns MessageRouterService instance
   */
  static getInstance(): MessageRouterService {
    if (!MessageRouterService.instance) {
      MessageRouterService.instance = new MessageRouterService();
    }
    return MessageRouterService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    if (MessageRouterService.instance) {
      MessageRouterService.instance.stopListening();
    }
    MessageRouterService.instance = null;
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Set the handler used to deliver messages to local agent sessions.
   * Must be called before startListening() to enable incoming message delivery.
   *
   * @param handler - Function that delivers a message to a local session
   */
  setLocalDeliveryHandler(handler: LocalDeliveryHandler): void {
    this.localDeliveryHandler = handler;
  }

  // -------------------------------------------------------------------------
  // Outbound: Remote Routing
  // -------------------------------------------------------------------------

  /**
   * Find which remote device hosts the given agent session.
   *
   * Searches the cached device list from CloudSyncService, inspecting
   * each device's team summaries for matching agent session names.
   *
   * @param sessionName - Target agent session name
   * @returns The SyncDevice hosting the session, or null if not found
   */
  findDeviceForSession(sessionName: string): SyncDevice | null {
    const sync = CloudSyncService.getInstance();
    if (!sync.isStarted()) return null;

    const onlineDevices = sync.getOnlineDevices();

    for (const device of onlineDevices) {
      if (!device.teams) continue;
      for (const team of device.teams) {
        if (!team.agents) continue;
        for (const agent of team.agents) {
          if (agent.sessionName === sessionName) {
            return device;
          }
        }
      }
    }

    return null;
  }

  /**
   * Route a message to a remote device via the Cloud message queue.
   *
   * Called when a target agent session is not found locally. Queries
   * CloudSyncService for the device hosting that session and sends
   * an `agent_message` through the Cloud queue.
   *
   * @param targetSession - Target agent session name
   * @param message - Message content to deliver
   * @param priority - Delivery priority (default: 'normal')
   * @returns RouteResult indicating success/failure
   *
   * @example
   * ```typescript
   * const result = await router.routeRemote('crewly-product-leo', 'Build the feature');
   * if (!result.routed) {
   *   console.error('Remote routing failed:', result.error);
   * }
   * ```
   */
  async routeRemote(
    targetSession: string,
    message: string,
    priority: 'high' | 'normal' = 'normal',
  ): Promise<RouteResult> {
    const sync = CloudSyncService.getInstance();

    // Guard: CloudSync must be running
    if (!sync.isStarted()) {
      return { routed: false, error: 'CloudSyncService not started' };
    }

    // Find the device hosting this session
    const targetDevice = this.findDeviceForSession(targetSession);
    if (!targetDevice) {
      return {
        routed: false,
        error: `Session '${targetSession}' not found on any online device`,
      };
    }

    // Build the agent_message payload
    const config = this.getLocalDeviceInfo();
    const payload: AgentMessagePayload = {
      targetSession,
      message,
      fromDevice: config.deviceId,
      fromDeviceName: config.deviceName,
      priority,
    };

    try {
      await sync.sendMessage(targetDevice.deviceId, 'agent_message', payload);

      this.logger.info('Message routed to remote device', {
        targetSession,
        deviceId: targetDevice.deviceId,
        deviceName: targetDevice.deviceName,
        messageLength: message.length,
      });

      return {
        routed: true,
        deviceId: targetDevice.deviceId,
        deviceName: targetDevice.deviceName,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to route message to remote device', {
        targetSession,
        deviceId: targetDevice.deviceId,
        error: errorMsg,
      });
      return { routed: false, error: errorMsg };
    }
  }

  // -------------------------------------------------------------------------
  // Inbound: Incoming Message Handling
  // -------------------------------------------------------------------------

  /**
   * Start listening for incoming `agent_message` events from CloudSyncService.
   *
   * When an `agent_message` is received, it extracts the target session name
   * and delivers the message to the local agent via the configured
   * localDeliveryHandler.
   */
  startListening(): void {
    if (this.listening) return;

    const sync = CloudSyncService.getInstance();
    this.boundMessageHandler = (msg: IncomingMessage) => {
      this.handleIncomingMessage(msg).catch((err) => {
        this.logger.error('Error handling incoming agent_message', {
          error: err instanceof Error ? err.message : String(err),
          messageId: msg.id,
        });
      });
    };

    sync.on('message', this.boundMessageHandler);
    this.listening = true;
    this.logger.info('MessageRouterService started listening for agent_message events');
  }

  /**
   * Stop listening for incoming messages.
   */
  stopListening(): void {
    if (!this.listening || !this.boundMessageHandler) return;

    const sync = CloudSyncService.getInstance();
    sync.removeListener('message', this.boundMessageHandler);
    this.boundMessageHandler = null;
    this.listening = false;
    this.logger.info('MessageRouterService stopped listening');
  }

  /**
   * Handle an incoming message from CloudSyncService.
   * Only processes messages of type `agent_message`.
   *
   * @param msg - The incoming message from another device
   */
  async handleIncomingMessage(msg: IncomingMessage): Promise<void> {
    // Only handle agent_message type
    if (msg.type !== 'agent_message') return;

    const payload = msg.payload;
    if (!isAgentMessagePayload(payload)) {
      this.logger.warn('Received agent_message with invalid payload', {
        messageId: msg.id,
        from: msg.from,
      });
      return;
    }

    this.logger.info('Received remote agent_message', {
      messageId: msg.id,
      from: msg.fromDeviceName,
      targetSession: payload.targetSession,
      messageLength: payload.message.length,
    });

    // Deliver to the local agent session
    if (!this.localDeliveryHandler) {
      this.logger.error('No localDeliveryHandler configured — cannot deliver remote message', {
        targetSession: payload.targetSession,
      });
      return;
    }

    try {
      const result = await this.localDeliveryHandler(
        payload.targetSession,
        payload.message,
      );

      if (result.success) {
        this.logger.info('Remote message delivered to local agent', {
          targetSession: payload.targetSession,
          from: payload.fromDeviceName,
        });
      } else {
        this.logger.warn('Failed to deliver remote message to local agent', {
          targetSession: payload.targetSession,
          error: result.error,
        });
      }
    } catch (error) {
      this.logger.error('Exception delivering remote message to local agent', {
        targetSession: payload.targetSession,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check if the router is currently listening for incoming messages.
   *
   * @returns True if listening
   */
  isListening(): boolean {
    return this.listening;
  }

  // -------------------------------------------------------------------------
  // Internal Helpers
  // -------------------------------------------------------------------------

  /**
   * Get local device identity info from CloudSyncService config.
   * Falls back to defaults if sync is not started.
   *
   * @returns Object with deviceId and deviceName
   */
  private getLocalDeviceInfo(): { deviceId: string; deviceName: string } {
    // Access the device list and find our own entry
    const sync = CloudSyncService.getInstance();
    const devices = sync.getDevices();
    const local = devices.find((d) => d.isLocal);

    if (local) {
      return { deviceId: local.deviceId, deviceName: local.deviceName };
    }

    // Fallback: return placeholder (will still work for logging)
    return { deviceId: 'unknown', deviceName: 'unknown' };
  }
}
