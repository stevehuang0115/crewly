/**
 * Relay Client Service
 *
 * WebSocket client that connects to a Relay Server for inter-node
 * communication when direct connections are unavailable (NAT/firewall).
 *
 * Flow: Node A (Agent) <-> Cloud (Relay) <-> Node B (Orchestrator)
 *
 * Features:
 * - Automatic fallback from direct connection to relay mode
 * - End-to-end encryption (E2EE) — relay never sees plaintext
 * - Heartbeat keep-alive with auto-reconnection
 * - Exponential backoff on reconnection failures
 *
 * @module services/cloud/relay-client.service
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { CLOUD_CONSTANTS } from '../../constants.js';
import {
  isRelayMessage,
  type RelayClientConfig,
  type RelayClientState,
  type RelaySessionId,
  type RelayRegisterMessage,
  type RelayDataMessage,
  type RelayHeartbeatMessage,
  type RelayMessage,
} from './relay.types.js';
import {
  deriveKey,
  generateSalt,
  encrypt,
  decrypt,
  serializeEnvelope,
  deserializeEnvelope,
} from './relay-crypto.service.js';

const RELAY = CLOUD_CONSTANTS.RELAY;

// ---------------------------------------------------------------------------
// Events emitted by RelayClientService
// ---------------------------------------------------------------------------

export interface RelayClientEvents {
  /** Emitted when successfully paired with a peer */
  paired: (peerSessionId: RelaySessionId, peerRole: string) => void;
  /** Emitted when a decrypted message is received from the peer */
  message: (plaintext: string) => void;
  /** Emitted when the peer disconnects */
  peerDisconnected: (peerSessionId: RelaySessionId) => void;
  /** Emitted when the client state changes */
  stateChange: (state: RelayClientState) => void;
  /** Emitted on errors */
  error: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * RelayClientService singleton.
 *
 * Manages a WebSocket connection to a relay server, handles registration,
 * heartbeats, reconnection, and encrypts/decrypts messages for E2EE.
 */
export class RelayClientService extends EventEmitter {
  private static instance: RelayClientService | null = null;
  private readonly logger: ComponentLogger;

  /** Current WebSocket connection */
  private ws: WebSocket | null = null;
  /** Client configuration (set via connect()) */
  private config: RelayClientConfig | null = null;
  /** Current connection state */
  private state: RelayClientState = 'disconnected';
  /** Assigned session ID after registration */
  private sessionId: RelaySessionId | null = null;
  /** Heartbeat interval timer */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  /** Reconnection attempt counter */
  private reconnectAttempts = 0;
  /** Reconnection timer */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Derived encryption key */
  private encryptionKey: Buffer | null = null;
  /** Salt for key derivation (exchanged as part of pairing code) */
  private salt: Buffer | null = null;
  /** Whether disconnect was intentional (skip reconnect) */
  private intentionalDisconnect = false;

  private constructor() {
    super();
    this.logger = LoggerService.getInstance().createComponentLogger('RelayClientService');
  }

  /**
   * Get the singleton instance.
   *
   * @returns RelayClientService instance
   */
  static getInstance(): RelayClientService {
    if (!RelayClientService.instance) {
      RelayClientService.instance = new RelayClientService();
    }
    return RelayClientService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    if (RelayClientService.instance) {
      RelayClientService.instance.disconnect();
      RelayClientService.instance.removeAllListeners();
    }
    RelayClientService.instance = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Connect to a relay server.
   *
   * Establishes the WebSocket connection, sends a register message,
   * and derives the E2EE encryption key from the shared secret.
   *
   * @param config - Relay client configuration
   *
   * @example
   * ```ts
   * const client = RelayClientService.getInstance();
   * client.connect({
   *   wsUrl: 'ws://cloud.crewly.dev:8787/relay',
   *   pairingCode: 'abc-123',
   *   role: 'agent',
   *   token: 'sk-xxx',
   *   sharedSecret: 'team-secret',
   * });
   * client.on('message', (plaintext) => console.log(plaintext));
   * ```
   */
  connect(config: RelayClientConfig): void {
    if (this.state !== 'disconnected' && this.state !== 'error') {
      this.logger.warn('Already connected or connecting — disconnect first');
      return;
    }

    this.config = config;
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;

    // Derive encryption key from shared secret
    this.salt = generateSalt();
    this.encryptionKey = deriveKey(config.sharedSecret, this.salt);

    this.doConnect();
  }

  /**
   * Disconnect from the relay server.
   *
   * Closes the WebSocket cleanly and stops heartbeats and reconnection.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.cleanup();
    this.setState('disconnected');
  }

  /**
   * Send an encrypted message to the paired peer via the relay.
   *
   * The message is encrypted locally before being sent — the relay
   * server only forwards the opaque ciphertext.
   *
   * @param plaintext - Message content to send
   * @throws Error if not in paired state or encryption key is not available
   *
   * @example
   * ```ts
   * client.send('Hello from agent node!');
   * ```
   */
  send(plaintext: string): void {
    if (this.state !== 'paired') {
      throw new Error(`Cannot send — client is in "${this.state}" state, must be "paired"`);
    }
    if (!this.encryptionKey) {
      throw new Error('Encryption key not derived — cannot send');
    }

    const envelope = encrypt(plaintext, this.encryptionKey);
    const payload = serializeEnvelope(envelope);

    const msg: RelayDataMessage = { type: 'relay', payload };
    this.sendRaw(msg);
  }

  /**
   * Get the current client state.
   *
   * @returns Current RelayClientState
   */
  getState(): RelayClientState {
    return this.state;
  }

  /**
   * Get the assigned session ID (available after registration).
   *
   * @returns Session ID or null if not registered
   */
  getSessionId(): RelaySessionId | null {
    return this.sessionId;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Establish the WebSocket connection and set up handlers.
   */
  private doConnect(): void {
    if (!this.config) return;

    this.setState('connecting');
    this.logger.info('Connecting to relay server', { wsUrl: this.config.wsUrl });

    try {
      this.ws = new WebSocket(this.config.wsUrl, {
        handshakeTimeout: RELAY.HANDSHAKE_TIMEOUT_MS,
      });
    } catch (err) {
      this.logger.error('Failed to create WebSocket', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.setState('error');
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.logger.info('WebSocket connected, sending registration');
      this.reconnectAttempts = 0;
      this.sendRegister();
    });

    this.ws.on('message', (data: Buffer | string) => {
      this.handleMessage(data);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.logger.info('WebSocket closed', { code, reason: reason.toString('utf8') });
      this.cleanup();
      if (!this.intentionalDisconnect) {
        this.setState('disconnected');
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error('WebSocket error', { error: err.message });
      this.setState('error');
      this.scheduleReconnect();
    });
  }

  /**
   * Send the registration message to the relay server.
   */
  private sendRegister(): void {
    if (!this.config) return;

    const msg: RelayRegisterMessage = {
      type: 'register',
      role: this.config.role,
      pairingCode: this.config.pairingCode,
      token: this.config.token,
    };
    this.sendRaw(msg);
  }

  /**
   * Handle an incoming WebSocket message.
   *
   * @param data - Raw message data
   */
  private handleMessage(data: Buffer | string): void {
    const raw = typeof data === 'string' ? data : data.toString('utf8');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.error('Received invalid JSON from relay');
      return;
    }

    if (!isRelayMessage(parsed)) {
      this.logger.warn('Received unknown message type from relay');
      return;
    }

    const msg: RelayMessage = parsed;

    switch (msg.type) {
      case 'registered':
        this.sessionId = msg.sessionId;
        this.setState('registered');
        this.startHeartbeat();
        this.logger.info('Registered with relay', { sessionId: msg.sessionId });
        break;

      case 'paired':
        this.setState('paired');
        this.logger.info('Paired with peer', { peerSessionId: msg.peerSessionId, peerRole: msg.peerRole });
        this.emit('paired', msg.peerSessionId, msg.peerRole);
        break;

      case 'relay':
        this.handleRelayData(msg);
        break;

      case 'heartbeat_ack':
        // Heartbeat acknowledged — no action needed
        break;

      case 'peer_disconnected':
        this.setState('registered');
        this.logger.info('Peer disconnected', { peerSessionId: msg.peerSessionId });
        this.emit('peerDisconnected', msg.peerSessionId);
        break;

      case 'error':
        this.logger.error('Relay server error', { code: msg.code, message: msg.message });
        this.setState('error');
        this.scheduleReconnect();
        break;

      default:
        this.logger.warn('Unhandled relay message type', { type: (msg as RelayMessage).type });
    }
  }

  /**
   * Handle an incoming relay data message by decrypting the payload.
   *
   * @param msg - Relay data message with encrypted payload
   */
  private handleRelayData(msg: RelayDataMessage): void {
    if (!this.encryptionKey) {
      this.logger.error('Cannot decrypt — no encryption key');
      return;
    }

    try {
      const envelope = deserializeEnvelope(msg.payload);
      const plaintext = decrypt(envelope, this.encryptionKey);
      this.emit('message', plaintext);
    } catch (err) {
      this.logger.error('Failed to decrypt relay message', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Log only — do not re-emit error to avoid uncaught exception crash
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  /**
   * Start the heartbeat interval to keep the connection alive.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      const msg: RelayHeartbeatMessage = { type: 'heartbeat' };
      this.sendRaw(msg);
    }, RELAY.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop the heartbeat interval.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // -------------------------------------------------------------------------
  // Reconnection
  // -------------------------------------------------------------------------

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;
    if (this.reconnectAttempts >= RELAY.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error('Max reconnection attempts reached — giving up');
      this.setState('error');
      return;
    }

    const delay = Math.min(
      RELAY.RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      RELAY.RECONNECT_MAX_DELAY_MS,
    );

    this.reconnectAttempts++;
    this.logger.info('Scheduling reconnection', {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Send a raw relay message over the WebSocket.
   *
   * @param message - Relay message to send
   */
  private sendRaw(message: RelayMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Update the client state and emit a stateChange event.
   *
   * @param newState - New state
   */
  private setState(newState: RelayClientState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit('stateChange', newState);
    }
  }

  /**
   * Clean up timers and close the WebSocket connection.
   */
  private cleanup(): void {
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Client disconnecting');
      }
      this.ws = null;
    }

    this.sessionId = null;
  }
}
