/**
 * Cloud Sync Type Definitions
 *
 * Defines the data structures for the Cloud Sync system that replaces
 * the WebSocket Relay pairing model. All devices under the same Cloud
 * account are automatically visible and can exchange messages.
 *
 * @see docs/cloud-sync-design.md
 * @module services/cloud/cloud-sync.types
 */

// ---------------------------------------------------------------------------
// Cloud Sync State
// ---------------------------------------------------------------------------

/** Possible states of the CloudSyncService lifecycle. */
export type CloudSyncState = 'stopped' | 'syncing' | 'error' | 'auth_expired';

/** Valid cloud sync state values for runtime validation. */
export const CLOUD_SYNC_STATES = ['stopped', 'syncing', 'error', 'auth_expired'] as const;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration required to start the CloudSyncService.
 * Obtained from CloudClientService credentials and DeviceIdentityService.
 */
export interface CloudSyncConfig {
  /** Cloud API base URL (e.g. "https://api.crewlyai.com") */
  cloudUrl: string;
  /** Bearer token for Cloud API authentication */
  token: string;
  /** Unique device identifier from ~/.crewly/device.json */
  deviceId: string;
  /** Human-readable device name (OS hostname) */
  deviceName: string;
}

// ---------------------------------------------------------------------------
// Device Types
// ---------------------------------------------------------------------------

/** Summary of an agent running on a device, included in heartbeat payloads. */
export interface SyncAgentInfo {
  /** Agent PTY session name (e.g. "crewly-product-leo-member-n") */
  sessionName: string;
  /** Agent role (e.g. "developer", "orchestrator") */
  role: string;
  /** Agent working status */
  workingStatus: string;
}

/** Summary of a team on a device, included in heartbeat payloads. */
export interface SyncTeamSummary {
  /** Team identifier */
  id: string;
  /** Team display name */
  name: string;
  /** Number of configured team members */
  memberCount: number;
  /** Number of currently active agents */
  activeAgents: number;
  /** Active agent session details (for cross-device routing) */
  agents?: SyncAgentInfo[];
}

/**
 * A device visible in the same Cloud account.
 * Populated by polling GET /api/v1/relay/devices.
 */
export interface SyncDevice {
  /** Unique device identifier (UUID) */
  deviceId: string;
  /** Human-readable device name (hostname) */
  deviceName: string;
  /** Whether the device is online or offline (based on heartbeat freshness) */
  status: 'online' | 'offline';
  /** Crewly version running on the device */
  version?: string;
  /** Device capabilities (e.g. orchestrator, agent-runner, mcp-server) */
  capabilities?: string[];
  /** Active teams on the device */
  teams?: SyncTeamSummary[];
  /** ISO timestamp of last heartbeat */
  lastHeartbeatAt: string;
  /** Whether this device is the local OSS instance */
  isLocal?: boolean;
  /** Relay session ID (legacy compat — maps from Cloud sessionId) */
  sessionId?: string;
  /** Device role in the relay topology */
  role?: string;
  /** Relay pairing state ('waiting' | 'paired' | 'disconnected') */
  state?: string;
  /** ISO timestamp of initial registration */
  registeredAt?: string;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Payload sent to Cloud in the heartbeat POST.
 * Uploaded every HEARTBEAT_INTERVAL_MS (30s).
 */
export interface HeartbeatPayload {
  /** Unique device identifier */
  deviceId: string;
  /** Human-readable device name (hostname) */
  deviceName: string;
  /** Device status */
  status: 'online';
  /** Crewly version */
  version: string;
  /** Device capabilities */
  capabilities: string[];
  /** Active teams on this device */
  teams: SyncTeamSummary[];
  /** ISO timestamp */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/** All supported message types for inter-device communication. */
export type MessageType =
  | 'command'
  | 'sync_teams'
  | 'sync_settings'
  | 'notification'
  | 'relay'
  | 'ping'
  | 'task_update'
  | 'agent_message'
  | 'cross-machine'
  | 'browser_command'
  | 'browser_response'
  | 'event';

/** Valid message type values for runtime validation. */
export const MESSAGE_TYPES: readonly MessageType[] = [
  'command',
  'sync_teams',
  'sync_settings',
  'notification',
  'relay',
  'ping',
  'task_update',
  'agent_message',
  'cross-machine',
  'browser_command',
  'browser_response',
  'event',
] as const;

/**
 * An incoming message received from another device via Cloud polling.
 */
export interface IncomingMessage {
  /** Unique message identifier */
  id: string;
  /** Device ID of the sender */
  from: string;
  /** Human-readable name of the sending device */
  fromDeviceName: string;
  /** Message type */
  type: MessageType;
  /** Message payload (structure varies by type) */
  payload: unknown;
  /** Whether the payload is E2EE encrypted */
  encrypted: boolean;
  /** ISO timestamp when the message was sent */
  sentAt: string;
}

/**
 * Payload for a command message sent between devices.
 */
export interface CommandPayload {
  /** The action to perform */
  action: string;
  /** Optional task identifier */
  taskId?: string;
  /** Optional team identifier */
  teamId?: string;
  /** Optional agent session name */
  agentSession?: string;
  /** Free-text content */
  content?: string;
}

/**
 * Payload for a notification message.
 */
export interface NotificationPayload {
  /** Notification title */
  title: string;
  /** Notification body */
  message: string;
  /** Urgency level */
  urgency: 'low' | 'normal' | 'high';
  /** Optional team identifier */
  teamId?: string;
}

/**
 * Payload for a task_update message.
 */
export interface TaskUpdatePayload {
  /** Task identifier */
  taskId: string;
  /** Current task status */
  status: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Summary of what was done */
  summary?: string;
}

/**
 * Payload for an agent_message sent between devices for transparent
 * cross-device agent communication. The orchestrator's send-message /
 * delegate-task skills remain unchanged — the message router transparently
 * wraps undeliverable local messages into this payload and routes via Cloud.
 */
export interface AgentMessagePayload {
  /** Target agent session name on the remote device */
  targetSession: string;
  /** The message content to deliver */
  message: string;
  /** Source device ID */
  fromDevice: string;
  /** Human-readable source device name */
  fromDeviceName: string;
  /** Delivery priority */
  priority?: 'high' | 'normal';
  /** Optional correlation ID for request-response patterns */
  correlationId?: string;
}

/**
 * Check if an object satisfies the AgentMessagePayload interface shape.
 *
 * @param value - Value to check
 * @returns True if the value has the required AgentMessagePayload fields
 */
export function isAgentMessagePayload(value: unknown): value is AgentMessagePayload {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.targetSession === 'string' &&
    typeof obj.message === 'string' &&
    typeof obj.fromDevice === 'string' &&
    typeof obj.fromDeviceName === 'string'
  );
}

/**
 * Cross-machine AgentEvent payload — the wire format for the `'event'`
 * MessageType (autonomy_v1.f1).
 *
 * Distinct from `AgentMessagePayload` and `'cross-machine'` MessageType:
 *   - `'cross-machine'` routes free-text orchestrator MESSAGES (slack-style).
 *   - `'event'` broadcasts typed AgentEvent OBJECTS (schema-stable).
 *
 * Different shape, different consumer (router vs CloudEventInboundBridge),
 * different validation paths. Kept parallel by Arch verdict 2026-04-28 (M1).
 *
 * The Cloud Relay fan-out (web/) duplicates this payload into N device
 * queues; each queue assigns its own message id, so the local
 * `processedMessageIds` LRU dedupes at-least-once delivery transparently.
 */
export interface EventMessagePayload {
  /**
   * The serialised AgentEvent the origin device published locally.
   * Carries `event.id` (origin-assigned uuid, stable across fan-out),
   * `event.type`, `event.sessionName`, `event.timestamp`, and the
   * event-specific payload fields. The receiving CloudEventInboundBridge
   * stamps `source: 'remote'` + `originDeviceId` before re-publishing on
   * the local EventBus; those two fields are NOT shipped on the wire to
   * keep the contract symmetric (any device, on any side, computes the
   * tag from the message envelope).
   */
  event: {
    id: string;
    type: string;
    sessionName: string;
    timestamp: string;
    [extra: string]: unknown;
  };

  /** Origin device id — echoes the sender so the receiver can stamp `originDeviceId` on the re-published event. */
  originDeviceId: string;

  /** Human-readable origin device name for log lines + ops audit. */
  originDeviceName?: string;
}

/**
 * Check if an object satisfies the EventMessagePayload interface shape.
 *
 * Validates the minimum schema needed for the inbound bridge to safely
 * re-publish: a non-empty `event.id`, `event.type`, `event.sessionName`,
 * `event.timestamp`, and a non-empty `originDeviceId`.
 *
 * @param value - Value to check
 * @returns True if the value has the required EventMessagePayload fields
 */
export function isEventMessagePayload(value: unknown): value is EventMessagePayload {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.originDeviceId !== 'string' || obj.originDeviceId.length === 0) return false;
  if (typeof obj.event !== 'object' || obj.event === null) return false;
  const evt = obj.event as Record<string, unknown>;
  return (
    typeof evt.id === 'string' && evt.id.length > 0 &&
    typeof evt.type === 'string' && evt.type.length > 0 &&
    typeof evt.sessionName === 'string' &&
    typeof evt.timestamp === 'string'
  );
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Check if a value is a valid CloudSyncState.
 *
 * @param value - Value to check
 * @returns True if the value is a valid CloudSyncState
 */
export function isCloudSyncState(value: unknown): value is CloudSyncState {
  return typeof value === 'string' && CLOUD_SYNC_STATES.includes(value as CloudSyncState);
}

/**
 * Check if a value is a valid MessageType.
 *
 * @param value - Value to check
 * @returns True if the value is a valid MessageType
 */
export function isMessageType(value: unknown): value is MessageType {
  return typeof value === 'string' && MESSAGE_TYPES.includes(value as MessageType);
}

/**
 * Check if an object satisfies the SyncDevice interface shape.
 *
 * @param value - Value to check
 * @returns True if the value has the required SyncDevice fields
 */
export function isSyncDevice(value: unknown): value is SyncDevice {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.deviceId === 'string' &&
    typeof obj.deviceName === 'string' &&
    (obj.status === 'online' || obj.status === 'offline') &&
    typeof obj.lastHeartbeatAt === 'string'
  );
}

/**
 * Check if an object satisfies the IncomingMessage interface shape.
 *
 * @param value - Value to check
 * @returns True if the value has the required IncomingMessage fields
 */
export function isIncomingMessage(value: unknown): value is IncomingMessage {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.from === 'string' &&
    typeof obj.fromDeviceName === 'string' &&
    isMessageType(obj.type) &&
    typeof obj.encrypted === 'boolean' &&
    typeof obj.sentAt === 'string'
  );
}

/**
 * Check if an object satisfies the CloudSyncConfig interface shape.
 *
 * @param value - Value to check
 * @returns True if the value has the required CloudSyncConfig fields
 */
export function isCloudSyncConfig(value: unknown): value is CloudSyncConfig {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.cloudUrl === 'string' &&
    typeof obj.token === 'string' &&
    typeof obj.deviceId === 'string' &&
    typeof obj.deviceName === 'string'
  );
}
