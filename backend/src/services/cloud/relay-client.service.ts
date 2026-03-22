/**
 * Relay Client Service
 *
 * HTTP polling-based client that connects to a Cloud Message Queue for
 * inter-node communication when direct connections are unavailable (NAT/firewall).
 *
 * Flow: Node A (Agent) <-> Cloud (Queue) <-> Node B (Orchestrator)
 *
 * Features:
 * - HTTP-based registration and message polling (replaces WebSocket)
 * - End-to-end encryption (E2EE) — relay never sees plaintext
 * - Exponential backoff on registration failures
 * - Automatic message acknowledgement after processing
 * - Token auto-refresh via CloudClientService integration
 * - Consecutive failure tracking with error state escalation
 *
 * @module services/cloud/relay-client.service
 */

import { EventEmitter } from 'events';
import { hostname } from 'os';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { CLOUD_CONSTANTS } from '../../constants.js';
import type {
  RelayClientConfig,
  RelayClientState,
  RelaySessionId,
  RelayQueueRegisterResponse,
  RelayQueuePollResponse,
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
const RELAY_ENDPOINTS = CLOUD_CONSTANTS.RELAY_ENDPOINTS;

/** Maximum consecutive poll failures before emitting an error event */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

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
 * Manages HTTP-based registration, polling, and message exchange with
 * a Cloud Message Queue. Encrypts/decrypts messages for E2EE.
 */
export class RelayClientService extends EventEmitter {
  private static instance: RelayClientService | null = null;
  private readonly logger: ComponentLogger;

  /** Client configuration (set via connect()) */
  private config: RelayClientConfig | null = null;
  /** Current connection state */
  private state: RelayClientState = 'disconnected';
  /** Assigned queue ID after registration (used as sessionId) */
  private sessionId: RelaySessionId | null = null;
  /** Peer's queue ID for sending messages */
  private peerQueueId: string | null = null;
  /** Polling interval timer */
  private pollInterval: ReturnType<typeof setInterval> | null = null;
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
  /** Timestamp of last seen message for pagination */
  private lastSeenTimestamp: string | null = null;
  /** Consecutive poll failure count for error escalation */
  private consecutivePollFailures = 0;
  /** Total poll cycles executed (for observability) */
  private pollCount = 0;

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
   * Connect to the Cloud Message Queue.
   *
   * Registers via HTTP POST, derives the E2EE encryption key,
   * and starts polling for messages if not immediately paired.
   *
   * @param config - Relay client configuration
   *
   * @example
   * ```ts
   * const client = RelayClientService.getInstance();
   * client.connect({
   *   apiUrl: 'https://api.crewlyai.com',
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
    this.lastSeenTimestamp = null;

    // Derive encryption key from shared secret
    this.salt = generateSalt();
    this.encryptionKey = deriveKey(config.sharedSecret, this.salt);

    this.doRegister();
  }

  /**
   * Disconnect from the Cloud Message Queue.
   *
   * Stops polling and cleans up all timers.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.cleanup();
    this.setState('disconnected');
  }

  /**
   * Send an encrypted message to the paired peer via the Cloud Queue.
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
    if (!this.peerQueueId) {
      throw new Error('No peer queue ID — cannot send');
    }

    const envelope = encrypt(plaintext, this.encryptionKey);
    const payload = serializeEnvelope(envelope);

    this.sendViaHttp(payload);
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
   * Get the assigned session ID (queue ID, available after registration).
   *
   * @returns Session ID or null if not registered
   */
  getSessionId(): RelaySessionId | null {
    return this.sessionId;
  }

  // -------------------------------------------------------------------------
  // Registration (replaces WebSocket connect)
  // -------------------------------------------------------------------------

  /**
   * Register with the Cloud Message Queue via HTTP POST.
   *
   * Uses CLOUD_CONSTANTS.RELAY_ENDPOINTS.QUEUE_REGISTER for the endpoint URL.
   * On success, transitions to 'registered' or 'paired' state and starts polling.
   * On failure, enters 'error' state and schedules reconnection with backoff.
   */
  private async doRegister(): Promise<void> {
    if (!this.config) return;

    this.setState('connecting');
    this.logger.info('Registering with Cloud Message Queue', { apiUrl: this.config.apiUrl });

    try {
      const token = this.getAuthToken();
      const url = `${this.config.apiUrl}${RELAY_ENDPOINTS.QUEUE_REGISTER}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          role: this.config.role,
          pairingCode: this.config.pairingCode,
          deviceName: hostname(),
        }),
        signal: AbortSignal.timeout(RELAY.REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Registration failed with HTTP ${response.status}`);
      }

      const data = await response.json() as RelayQueueRegisterResponse;

      if (!data.success || !data.queueId) {
        throw new Error('Registration response missing required fields');
      }

      this.sessionId = data.queueId;
      this.reconnectAttempts = 0;
      this.consecutivePollFailures = 0;
      this.logger.info('Registered with Cloud Queue', { queueId: data.queueId });

      if (data.peerQueueId) {
        // Already paired
        this.peerQueueId = data.peerQueueId;
        this.setState('paired');
        this.emit('paired', data.peerQueueId, 'peer');
        this.startPolling();
      } else {
        // Waiting for peer — start polling for pairing + messages
        this.setState('registered');
        this.startPolling();
      }
    } catch (err) {
      this.logger.error('Failed to register with Cloud Queue', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.setState('error');
      this.scheduleReconnect();
    }
  }

  // -------------------------------------------------------------------------
  // Polling (replaces WebSocket onMessage)
  // -------------------------------------------------------------------------

  /**
   * Start the polling interval to fetch new messages from the queue.
   */
  private startPolling(): void {
    this.stopPolling();
    this.pollInterval = setInterval(() => {
      this.poll();
    }, RELAY.POLL_INTERVAL_MS);
  }

  /**
   * Stop the polling interval.
   */
  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Poll the queue for new messages and process them.
   *
   * Uses CLOUD_CONSTANTS.RELAY_ENDPOINTS.QUEUE_POLL for the endpoint URL.
   * Handles pairing detection when the poll response includes a peerQueueId
   * (transition from 'registered' → 'paired'). Tracks consecutive failures
   * and emits an error event after MAX_CONSECUTIVE_POLL_FAILURES.
   */
  private async poll(): Promise<void> {
    if (!this.config || !this.sessionId) return;

    this.pollCount++;

    try {
      const token = this.getAuthToken();
      let url = `${this.config.apiUrl}${RELAY_ENDPOINTS.QUEUE_POLL}?queueId=${this.sessionId}`;
      if (this.lastSeenTimestamp) {
        url += `&since=${encodeURIComponent(this.lastSeenTimestamp)}`;
      }

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(RELAY.REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.handlePollFailure(`Poll request failed with HTTP ${response.status}`);
        return;
      }

      // Reset failure counter on successful response
      this.consecutivePollFailures = 0;

      const data = await response.json() as RelayQueuePollResponse;

      // Detect pairing during poll — server may return peerQueueId once peer registers
      if (data.peerQueueId && !this.peerQueueId) {
        this.peerQueueId = data.peerQueueId;
        if (this.state === 'registered') {
          this.setState('paired');
          this.emit('paired', this.peerQueueId, 'peer');
          this.logger.info('Paired with peer during poll', { peerQueueId: this.peerQueueId });
        }
      }

      if (!data.messages || data.messages.length === 0) return;

      const messageIds: string[] = [];

      for (const msg of data.messages) {
        messageIds.push(msg.id);

        // Update last seen timestamp for pagination
        if (!this.lastSeenTimestamp || msg.createdAt > this.lastSeenTimestamp) {
          this.lastSeenTimestamp = msg.createdAt;
        }

        // Decrypt and emit the message
        this.handleQueueMessage(msg.payload);
      }

      // Acknowledge processed messages
      if (messageIds.length > 0) {
        await this.ackMessages(messageIds);
      }
    } catch (err) {
      this.handlePollFailure(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Handle a poll failure by incrementing the failure counter and
   * emitting an error event if the threshold is exceeded.
   *
   * @param reason - Human-readable failure reason for logging
   */
  private handlePollFailure(reason: string): void {
    this.consecutivePollFailures++;
    this.logger.error('Poll cycle failed', {
      reason,
      consecutiveFailures: this.consecutivePollFailures,
    });

    if (this.consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
      this.logger.error('Too many consecutive poll failures — emitting error');
      this.emit('error', new Error(`Relay poll failed ${this.consecutivePollFailures} times consecutively`));
    }
  }

  /**
   * Handle a single queue message payload by decrypting it.
   *
   * @param payload - Encrypted payload string
   */
  private handleQueueMessage(payload: string): void {
    if (!this.encryptionKey) {
      this.logger.error('Cannot decrypt — no encryption key');
      return;
    }

    try {
      const envelope = deserializeEnvelope(payload);
      const plaintext = decrypt(envelope, this.encryptionKey);
      this.emit('message', plaintext);
    } catch (err) {
      this.logger.error('Failed to decrypt queue message', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Acknowledge processed messages so they are not re-delivered.
   *
   * Uses CLOUD_CONSTANTS.RELAY_ENDPOINTS.QUEUE_ACK for the endpoint URL.
   * Fire-and-forget — ack failures are logged but do not affect state.
   * Unacked messages may be re-delivered on the next poll cycle.
   *
   * @param messageIds - Array of message IDs to acknowledge
   */
  private async ackMessages(messageIds: string[]): Promise<void> {
    if (!this.config || !this.sessionId) return;

    try {
      const token = this.getAuthToken();
      const url = `${this.config.apiUrl}${RELAY_ENDPOINTS.QUEUE_ACK}`;

      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          queueId: this.sessionId,
          messageIds,
        }),
        signal: AbortSignal.timeout(RELAY.REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error('Failed to acknowledge messages', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Send via HTTP (replaces WebSocket send)
  // -------------------------------------------------------------------------

  /**
   * Send an encrypted payload to the peer via HTTP POST.
   *
   * Uses CLOUD_CONSTANTS.RELAY_ENDPOINTS.QUEUE_SEND for the endpoint URL.
   *
   * @param payload - Serialized encrypted envelope
   */
  private async sendViaHttp(payload: string): Promise<void> {
    if (!this.config || !this.peerQueueId) return;

    try {
      const token = this.getAuthToken();
      const url = `${this.config.apiUrl}${RELAY_ENDPOINTS.QUEUE_SEND}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          peerQueueId: this.peerQueueId,
          payload,
        }),
        signal: AbortSignal.timeout(RELAY.REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.error('Failed to send message', { status: response.status });
      }
    } catch (err) {
      this.logger.error('Send request failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Reconnection
  // -------------------------------------------------------------------------

  /**
   * Schedule a reconnection attempt with exponential backoff.
   * Applied to HTTP register failures.
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
      this.doRegister();
    }, delay);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

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
   * Get the total number of poll cycles executed since last connect.
   *
   * Useful for monitoring and debugging relay health.
   *
   * @returns Number of poll cycles
   */
  getPollCount(): number {
    return this.pollCount;
  }

  /**
   * Get the current number of consecutive poll failures.
   *
   * @returns Consecutive failure count (resets on success)
   */
  getConsecutivePollFailures(): number {
    return this.consecutivePollFailures;
  }

  /**
   * Get the best available auth token for Cloud API calls.
   *
   * Attempts to read a fresh token from CloudClientService (which handles
   * auto-refresh). Falls back to the token stored in config if CloudClientService
   * is not connected or unavailable.
   *
   * @returns Bearer token string
   */
  private getAuthToken(): string {
    try {
      // Dynamically import to avoid circular dependency at module load time
      // CloudClientService.getToken() returns the latest (possibly refreshed) token
      const { CloudClientService } = require('./cloud-client.service.js');
      const cloudClient = CloudClientService.getInstance();
      if (cloudClient.isConnected()) {
        const freshToken = cloudClient.getToken();
        if (freshToken) return freshToken;
      }
    } catch {
      // CloudClientService not available — use config token
    }
    return this.config?.token ?? '';
  }

  /**
   * Clean up timers and reset connection state.
   */
  private cleanup(): void {
    this.stopPolling();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.sessionId = null;
    this.peerQueueId = null;
    this.consecutivePollFailures = 0;
    this.pollCount = 0;
  }
}
