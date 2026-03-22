/**
 * Cross-Machine Communication Types
 *
 * Types for Slack-based cross-machine orchestrator communication.
 * Two Crewly instances in the same Slack workspace can exchange messages
 * through a designated Slack channel, enabling cross-machine task delegation.
 *
 * @module types/cross-machine
 */

/**
 * Cross-machine message types supported by the protocol.
 */
export type CrossMachineMessageType =
  | 'delegate-task'
  | 'send-message'
  | 'status-request'
  | 'status-response'
  | 'ping'
  | 'pong';

/**
 * Wire format for cross-machine messages sent through Slack.
 * Messages are JSON-encoded and wrapped in a recognizable prefix
 * so the receiving bridge can detect and route them.
 */
export interface CrossMachineMessage {
  /** Protocol identifier — always "crewly-x-machine" */
  protocol: 'crewly-x-machine';
  /** Protocol version for future compatibility */
  version: 1;
  /** Source machine device ID (from DeviceIdentityService) */
  from: string;
  /** Source machine human-readable name */
  fromName: string;
  /** Target machine device ID (or "*" for broadcast) */
  to: string;
  /** Message type */
  type: CrossMachineMessageType;
  /** Arbitrary payload depending on message type */
  payload: Record<string, unknown>;
  /** ISO timestamp when the message was created */
  timestamp: string;
  /** Unique message ID to prevent duplicate processing */
  messageId: string;
}

/**
 * Configuration for cross-machine messaging via Slack.
 */
export interface CrossMachineConfig {
  /** Slack channel ID dedicated to cross-machine communication */
  channelId: string;
  /** Whether cross-machine messaging is enabled */
  enabled: boolean;
}

/**
 * Result of sending a cross-machine message.
 */
export interface CrossMachineSendResult {
  /** Whether the message was sent successfully */
  success: boolean;
  /** Slack message timestamp (for tracking) */
  slackTs?: string;
  /** Error message if sending failed */
  error?: string;
}

/**
 * Payload for delegate-task cross-machine messages.
 */
export interface DelegateTaskPayload {
  /** Task description or instructions */
  task: string;
  /** Priority level */
  priority?: 'low' | 'normal' | 'high' | 'critical';
  /** Target agent session name on the remote machine (optional) */
  targetAgent?: string;
  /** Additional context for the task */
  context?: string;
}

/**
 * Payload for status-request / status-response messages.
 */
export interface StatusPayload {
  /** Status summary text */
  summary?: string;
  /** Number of active agents */
  activeAgents?: number;
  /** Current orchestrator status */
  orchestratorStatus?: 'active' | 'inactive';
}

/**
 * Slack message prefix used to identify cross-machine messages.
 * The bridge checks for this prefix to distinguish cross-machine
 * messages from regular user messages.
 */
export const CROSS_MACHINE_PREFIX = '🔗 [X-MACHINE]';

/**
 * Parse a Slack message text to determine if it's a cross-machine message.
 *
 * @param text - Raw Slack message text
 * @returns Parsed CrossMachineMessage or null if not a cross-machine message
 */
export function parseCrossMachineMessage(text: string): CrossMachineMessage | null {
  if (!text.startsWith(CROSS_MACHINE_PREFIX)) {
    return null;
  }

  try {
    const jsonPart = text.slice(CROSS_MACHINE_PREFIX.length).trim();
    const parsed = JSON.parse(jsonPart) as Partial<CrossMachineMessage>;

    if (parsed.protocol !== 'crewly-x-machine' || !parsed.from || !parsed.to || !parsed.type) {
      return null;
    }

    return parsed as CrossMachineMessage;
  } catch {
    return null;
  }
}

/**
 * Serialize a cross-machine message for sending via Slack.
 *
 * @param message - The message to serialize
 * @returns Formatted string with prefix + JSON
 */
export function serializeCrossMachineMessage(message: CrossMachineMessage): string {
  return `${CROSS_MACHINE_PREFIX} ${JSON.stringify(message)}`;
}
