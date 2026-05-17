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
  // Cloud Portal ↔ user-local OSS chat-v2 relay (2026-05-16):
  //   chat_request   — Portal calls a chat-v2 RPC method on user's OSS
  //   chat_response  — user's OSS replies, correlated by request id
  //   chat_event     — user's OSS pushes a broadcast (new message, presence
  //                    change) to the Portal — analogous to the local WS
  //                    `gateway.broadcast` frames but tunnelled through the
  //                    relay queue.
  | 'chat_request'
  | 'chat_response'
  | 'chat_event';

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
  'chat_request',
  'chat_response',
  'chat_event',
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

// ---------------------------------------------------------------------------
// chat-v2 RPC over relay (Cloud Portal ↔ user-local OSS)
// ---------------------------------------------------------------------------

/**
 * RPC methods Portal can invoke on the user's OSS chat-v2 surface via the
 * relay. Mirrors the public methods on `@crewly/chat-ui`'s `ChatApiClient`
 * plus the OSS-only directory/presence helpers added by the /agents page.
 *
 * Closed-set on purpose so unknown methods are rejected by the OSS-side
 * adapter (returns `unsupported_method` error) — saves the round-trip from
 * Portal's perspective and gives the audit log a stable enum to group by.
 */
export type ChatRpcMethod =
  | 'listAgents'
  | 'getAgentPresence'
  | 'listChannels'
  | 'ensureDmChannel'
  | 'createChannel'
  | 'createHuddle'
  | 'listHuddleMembers'
  | 'listMessages'
  | 'sendMessage';

/** Set form for runtime validation. */
export const CHAT_RPC_METHODS: readonly ChatRpcMethod[] = [
  'listAgents',
  'getAgentPresence',
  'listChannels',
  'ensureDmChannel',
  'createChannel',
  'createHuddle',
  'listHuddleMembers',
  'listMessages',
  'sendMessage',
] as const;

/**
 * Payload for a `chat_request` message. JSON-RPC-style with stable
 * correlation id so the Portal can match the response that comes back on
 * its inbound queue (responses are out-of-order in general because the
 * OSS adapter may handle them concurrently).
 *
 * Designed so the wire shape is symmetrical between request and response
 * — the same `id` field appears in {@link ChatResponsePayload}.
 */
export interface ChatRequestPayload {
  /**
   * Caller-generated correlation id. Use a UUID v4 or any other source of
   * uniqueness; the OSS adapter does NOT inspect or validate it beyond
   * echoing it back in the matching `chat_response`.
   */
  id: string;
  /** RPC method name. Must be in {@link CHAT_RPC_METHODS}. */
  method: ChatRpcMethod;
  /** Method-specific parameters. Shape is method-dependent; the OSS adapter validates per-method. */
  params?: Record<string, unknown>;
}

/**
 * Payload for a `chat_response` message — the OSS adapter's reply to a
 * Portal `chat_request`. Exactly one of `result` / `error` is populated.
 */
export interface ChatResponsePayload {
  /** Correlation id echoed from the originating {@link ChatRequestPayload}. */
  id: string;
  /**
   * Method-specific success payload. For `listChannels` this is the
   * channel list, for `sendMessage` the persisted message DTO, etc.
   * Shape matches the underlying ChatV2Service / `@crewly/chat-ui`
   * return type for that method.
   */
  result?: unknown;
  /** Error envelope. Mirrors the REST error shape used by chat-v2. */
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Payload for a `chat_event` message — server-pushed broadcast originating
 * from the OSS adapter (after a local `gateway.broadcast` would fire). The
 * Portal client dispatches these to per-channel subscribers based on
 * `payload.channelId`, the same way `HttpChatApiClient.subscribeToChannel`
 * does for direct WebSocket frames.
 *
 * `event` re-uses the {@link import('../../websocket/chat-v2.gateway.js').ChatWireEvent}
 * shape verbatim so Portal's RelayChatApiClient can hand the event straight
 * to the existing `@crewly/chat-ui` reconciler without re-shaping.
 */
export interface ChatEventPayload {
  /** Affected channel. Portal dispatches by this field. */
  channelId: string;
  /**
   * The wire event itself — `{type:'message', payload:{channelId, message}}`
   * or `{type:'presence', ...}`. Typed as `unknown` here to avoid pulling
   * a chat-v2 type into the cloud-sync module (which lives below the
   * chat-v2 layer in the dep graph).
   */
  event: unknown;
}

/**
 * Best-effort type guard for `chat_request` payloads. Used by the OSS
 * adapter when consuming raw IncomingMessage.payload values before
 * dispatching to ChatV2Service.
 *
 * @param value - Untyped payload from the relay
 * @returns True iff the value has the minimum fields for a valid request
 */
export function isChatRequestPayload(value: unknown): value is ChatRequestPayload {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  // Wire shape requires `id` + `method` to both be strings. We intentionally
  // do NOT check `method` against {@link CHAT_RPC_METHODS} here — that's the
  // OSS adapter's job, and rejecting unknown methods at the guard level
  // would drop the message silently. Instead, the adapter responds with
  // a structured `unsupported_method` error so Portal gets a clear signal
  // rather than a hang.
  return typeof obj.id === 'string' && typeof obj.method === 'string';
}

/**
 * Best-effort type guard for `chat_response` payloads. Used by the Portal
 * client to discard malformed responses without throwing inside the
 * inbound-message dispatch loop.
 *
 * @param value - Untyped payload from the relay
 * @returns True iff the value has a string `id` field
 */
export function isChatResponsePayload(value: unknown): value is ChatResponsePayload {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.id === 'string';
}

/**
 * Best-effort type guard for `chat_event` payloads.
 *
 * @param value - Untyped payload from the relay
 * @returns True iff the value has a string `channelId` and an `event` field
 */
export function isChatEventPayload(value: unknown): value is ChatEventPayload {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.channelId === 'string' && obj.event !== undefined;
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
