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
export type CloudSyncState = 'stopped' | 'syncing' | 'error';

/** Valid cloud sync state values for runtime validation. */
export const CLOUD_SYNC_STATES = ['stopped', 'syncing', 'error'] as const;

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
  | 'task_update';

/** Valid message type values for runtime validation. */
export const MESSAGE_TYPES: readonly MessageType[] = [
  'command',
  'sync_teams',
  'sync_settings',
  'notification',
  'relay',
  'ping',
  'task_update',
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
