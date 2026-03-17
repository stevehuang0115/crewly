/**
 * Relay Types
 *
 * TypeScript type definitions for the WebSocket Relay system that enables
 * two Crewly instances to communicate through a Cloud hub (双机互联).
 *
 * The relay forwards opaque encrypted blobs between paired nodes — it
 * never inspects or decrypts message content (E2EE).
 *
 * @module services/cloud/relay.types
 */

// ---------------------------------------------------------------------------
// Relay Session
// ---------------------------------------------------------------------------

/** Unique identifier assigned to a relay node upon registration. */
export type RelaySessionId = string;

/** Role of a node in the relay topology. */
export type RelayNodeRole = 'orchestrator' | 'agent';

/** Current state of a relay session. */
export type RelaySessionState = 'waiting' | 'paired' | 'disconnected';

/** Metadata for a registered relay node. */
export interface RelaySession {
  /** Unique session ID assigned by the relay server */
  sessionId: RelaySessionId;
  /** Role of this node */
  role: RelayNodeRole;
  /** Pairing code used to match orchestrator ↔ agent */
  pairingCode: string;
  /** Current session state */
  state: RelaySessionState;
  /** Session ID of the paired counterpart (set when state === 'paired') */
  pairedWith: RelaySessionId | null;
  /** ISO timestamp of registration */
  registeredAt: string;
  /** ISO timestamp of last heartbeat */
  lastHeartbeatAt: string;
}

// ---------------------------------------------------------------------------
// Relay Messages (wire protocol)
// ---------------------------------------------------------------------------

/** Discriminated union tag for relay wire messages. */
export type RelayMessageType =
  | 'register'
  | 'registered'
  | 'pair'
  | 'paired'
  | 'relay'
  | 'heartbeat'
  | 'heartbeat_ack'
  | 'error'
  | 'peer_disconnected';

/** Base shape shared by every relay wire message. */
export interface RelayMessageBase {
  /** Message type discriminator */
  type: RelayMessageType;
}

/**
 * Client → Server: request to register as a relay node.
 * The server responds with a `registered` message containing the session ID.
 */
export interface RelayRegisterMessage extends RelayMessageBase {
  type: 'register';
  /** Node role in the relay */
  role: RelayNodeRole;
  /** Pairing code to match with a counterpart */
  pairingCode: string;
  /** Cloud auth token for verification */
  token: string;
}

/**
 * Server → Client: confirms registration and returns the session ID.
 */
export interface RelayRegisteredMessage extends RelayMessageBase {
  type: 'registered';
  /** Assigned session ID */
  sessionId: RelaySessionId;
}

/**
 * Server → Client: both nodes are now paired and can exchange messages.
 */
export interface RelayPairedMessage extends RelayMessageBase {
  type: 'paired';
  /** Session ID of the peer */
  peerSessionId: RelaySessionId;
  /** Role of the peer */
  peerRole: RelayNodeRole;
}

/**
 * Client → Server: relay an encrypted payload to the paired peer.
 * The relay server forwards the payload unchanged.
 */
export interface RelayDataMessage extends RelayMessageBase {
  type: 'relay';
  /** Base64-encoded encrypted payload (opaque to the relay) */
  payload: string;
}

/**
 * Client → Server: heartbeat to keep the connection alive.
 */
export interface RelayHeartbeatMessage extends RelayMessageBase {
  type: 'heartbeat';
}

/**
 * Server → Client: acknowledgement of a heartbeat.
 */
export interface RelayHeartbeatAckMessage extends RelayMessageBase {
  type: 'heartbeat_ack';
}

/**
 * Server → Client: error notification.
 */
export interface RelayErrorMessage extends RelayMessageBase {
  type: 'error';
  /** Machine-readable error code */
  code: string;
  /** Human-readable description */
  message: string;
}

/**
 * Server → Client: the paired peer has disconnected.
 */
export interface RelayPeerDisconnectedMessage extends RelayMessageBase {
  type: 'peer_disconnected';
  /** Session ID of the disconnected peer */
  peerSessionId: RelaySessionId;
}

/** Union of all relay wire messages. */
export type RelayMessage =
  | RelayRegisterMessage
  | RelayRegisteredMessage
  | RelayPairedMessage
  | RelayDataMessage
  | RelayHeartbeatMessage
  | RelayHeartbeatAckMessage
  | RelayErrorMessage
  | RelayPeerDisconnectedMessage;

// ---------------------------------------------------------------------------
// Relay Registration API (REST)
// ---------------------------------------------------------------------------

/** Request body for POST /v1/relay/register. */
export interface RelayRegisterRequest {
  /** Role of the registering node */
  role: RelayNodeRole;
  /** Pairing code to match with a counterpart */
  pairingCode: string;
}

/** Response body for POST /v1/relay/register. */
export interface RelayRegisterResponse {
  /** Whether registration succeeded */
  success: boolean;
  /** Assigned session ID */
  sessionId: RelaySessionId;
  /** API URL for relay communication */
  apiUrl: string;
}

// ---------------------------------------------------------------------------
// Relay Queue Types (HTTP polling)
// ---------------------------------------------------------------------------

/** A single message returned from the queue poll endpoint. */
export interface RelayQueueMessage {
  /** Unique message ID for acknowledgement */
  id: string;
  /** Encrypted payload (base64 envelope) */
  payload: string;
  /** ISO timestamp of when the message was enqueued */
  createdAt: string;
}

/** Response from GET /api/v1/relay/queue/poll. */
export interface RelayQueuePollResponse {
  /** Array of unread messages */
  messages: RelayQueueMessage[];
}

/** Response from POST /api/v1/relay/queue/register. */
export interface RelayQueueRegisterResponse {
  /** Whether registration succeeded */
  success: boolean;
  /** Assigned queue ID for this client */
  queueId: string;
  /** Peer's queue ID if already paired, null otherwise */
  peerQueueId: string | null;
}

// ---------------------------------------------------------------------------
// Relay Client Configuration
// ---------------------------------------------------------------------------

/** Configuration for the RelayClientService. */
export interface RelayClientConfig {
  /** API URL of the relay server */
  apiUrl: string;
  /** Pairing code shared between the two nodes */
  pairingCode: string;
  /** This node's role */
  role: RelayNodeRole;
  /** Cloud auth token */
  token: string;
  /** Shared secret for E2EE key derivation */
  sharedSecret: string;
}

/** Connection state of the relay client. */
export type RelayClientState = 'disconnected' | 'connecting' | 'registered' | 'paired' | 'error';

// ---------------------------------------------------------------------------
// Encrypted Envelope
// ---------------------------------------------------------------------------

/** Envelope wrapping an encrypted payload for relay transport. */
export interface EncryptedEnvelope {
  /** Base64-encoded initialisation vector */
  iv: string;
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded authentication tag */
  authTag: string;
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Check whether a value is a valid RelayMessageType string.
 *
 * @param value - Value to check
 * @returns true if value is a known RelayMessageType
 */
export function isRelayMessageType(value: unknown): value is RelayMessageType {
  const VALID_TYPES: ReadonlySet<string> = new Set([
    'register',
    'registered',
    'pair',
    'paired',
    'relay',
    'heartbeat',
    'heartbeat_ack',
    'error',
    'peer_disconnected',
  ]);
  return typeof value === 'string' && VALID_TYPES.has(value);
}

/**
 * Check whether a parsed JSON object is a valid RelayMessage.
 *
 * Validates the `type` discriminator and required fields per message type.
 *
 * @param data - Parsed JSON value
 * @returns true if data conforms to RelayMessage
 */
export function isRelayMessage(data: unknown): data is RelayMessage {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!isRelayMessageType(obj['type'])) return false;

  switch (obj['type']) {
    case 'register':
      return typeof obj['role'] === 'string' && typeof obj['pairingCode'] === 'string' && typeof obj['token'] === 'string';
    case 'registered':
      return typeof obj['sessionId'] === 'string';
    case 'paired':
      return typeof obj['peerSessionId'] === 'string' && typeof obj['peerRole'] === 'string';
    case 'relay':
      return typeof obj['payload'] === 'string';
    case 'heartbeat':
    case 'heartbeat_ack':
      return true;
    case 'error':
      return typeof obj['code'] === 'string' && typeof obj['message'] === 'string';
    case 'peer_disconnected':
      return typeof obj['peerSessionId'] === 'string';
    default:
      return false;
  }
}
