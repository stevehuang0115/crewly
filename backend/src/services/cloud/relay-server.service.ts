/**
 * Relay Server Service
 *
 * WebSocket server that accepts connections from Crewly instances,
 * assigns session IDs, pairs nodes by pairing code, and relays
 * encrypted messages between paired instances.
 *
 * The server never inspects or decrypts message payloads (E2EE).
 * It only reads the wire protocol envelope to route messages.
 *
 * @module services/cloud/relay-server.service
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import type { Server as HttpServer } from 'http';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { CLOUD_CONSTANTS } from '../../constants.js';
import {
  isRelayMessage,
  type RelaySession,
  type RelaySessionId,
  type RelayRegisteredMessage,
  type RelayPairedMessage,
  type RelayErrorMessage,
  type RelayHeartbeatAckMessage,
  type RelayPeerDisconnectedMessage,
  type RelayRegisterMessage,
  type RelayDataMessage,
  type RelayMessage,
} from './relay.types.js';

const RELAY = CLOUD_CONSTANTS.RELAY;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A connected client with its WebSocket and session metadata. */
interface ConnectedClient {
  /** WebSocket connection */
  ws: WebSocket;
  /** Session metadata (populated after registration) */
  session: RelaySession | null;
  /** Timer that fires when heartbeat times out */
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * RelayServerService singleton.
 *
 * Manages the WebSocket server lifecycle, client connections, pairing,
 * and message forwarding between paired Crewly instances.
 */
export class RelayServerService {
  private static instance: RelayServerService | null = null;
  private readonly logger: ComponentLogger;

  /** WebSocket server instance */
  private wss: WebSocketServer | null = null;
  /** Map of session ID → connected client */
  private clients: Map<RelaySessionId, ConnectedClient> = new Map();
  /** Map of pairing code → array of session IDs waiting to pair */
  private pairingQueue: Map<string, RelaySessionId[]> = new Map();
  /** Whether the server is running */
  private running = false;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('RelayServerService');
  }

  /**
   * Get the singleton instance.
   *
   * @returns RelayServerService instance
   */
  static getInstance(): RelayServerService {
    if (!RelayServerService.instance) {
      RelayServerService.instance = new RelayServerService();
    }
    return RelayServerService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    RelayServerService.instance = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start the relay WebSocket server.
   *
   * Can attach to an existing HTTP server or listen on a standalone port.
   *
   * @param options - Server options: either an httpServer or a port number
   *
   * @example
   * ```ts
   * const relay = RelayServerService.getInstance();
   * relay.start({ port: 8787 });
   * ```
   */
  start(options: { httpServer?: HttpServer; port?: number; path?: string }): void {
    if (this.running) {
      this.logger.warn('Relay server already running');
      return;
    }

    const wssOptions: Record<string, unknown> = {
      maxPayload: RELAY.MAX_PAYLOAD_BYTES,
      path: options.path ?? '/relay',
    };

    if (options.httpServer) {
      wssOptions['server'] = options.httpServer;
    } else {
      wssOptions['port'] = options.port ?? RELAY.DEFAULT_PORT;
    }

    this.wss = new WebSocketServer(wssOptions as ConstructorParameters<typeof WebSocketServer>[0]);
    this.running = true;

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    this.logger.info('Relay server started', {
      port: options.port ?? (options.httpServer ? 'attached' : RELAY.DEFAULT_PORT),
    });
  }

  /**
   * Stop the relay server and close all connections.
   *
   * @returns Promise that resolves when the server is fully closed
   */
  async stop(): Promise<void> {
    if (!this.running || !this.wss) {
      return;
    }

    this.running = false;

    // Clear all heartbeat timers
    for (const client of this.clients.values()) {
      if (client.heartbeatTimer) {
        clearTimeout(client.heartbeatTimer);
      }
      client.ws.close(1001, 'Server shutting down');
    }

    this.clients.clear();
    this.pairingQueue.clear();

    return new Promise<void>((resolve) => {
      this.wss!.close(() => {
        this.wss = null;
        this.logger.info('Relay server stopped');
        resolve();
      });
    });
  }

  /**
   * Check whether the relay server is currently running.
   *
   * @returns true if running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of currently connected clients.
   *
   * @returns Client count
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get a snapshot of all active sessions.
   *
   * @returns Array of relay session metadata
   */
  getSessions(): RelaySession[] {
    const sessions: RelaySession[] = [];
    for (const client of this.clients.values()) {
      if (client.session) {
        sessions.push({ ...client.session });
      }
    }
    return sessions;
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  /**
   * Handle a new WebSocket connection.
   *
   * Sets up message, close, and error handlers. The client must send
   * a `register` message within the handshake timeout or be disconnected.
   *
   * @param ws - Incoming WebSocket connection
   */
  private handleConnection(ws: WebSocket): void {
    const tempId = `pending-${randomUUID()}`;
    this.logger.debug('New WebSocket connection', { tempId });

    // Handshake timeout: client must register within the window
    const handshakeTimer = setTimeout(() => {
      this.sendError(ws, 'HANDSHAKE_TIMEOUT', 'Registration timeout — send a register message');
      ws.close(4001, 'Handshake timeout');
    }, RELAY.HANDSHAKE_TIMEOUT_MS);

    ws.on('message', (data: Buffer | string) => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.sendError(ws, 'INVALID_JSON', 'Message is not valid JSON');
        return;
      }

      if (!isRelayMessage(parsed)) {
        this.sendError(ws, 'INVALID_MESSAGE', 'Unknown or malformed relay message');
        return;
      }

      const msg = parsed;

      if (msg.type === 'register') {
        clearTimeout(handshakeTimer);
        this.handleRegister(ws, msg);
        return;
      }

      // All other message types require a registered session
      const sessionId = this.findSessionIdByWs(ws);
      if (!sessionId) {
        this.sendError(ws, 'NOT_REGISTERED', 'Send a register message first');
        return;
      }

      switch (msg.type) {
        case 'relay':
          this.handleRelay(sessionId, msg);
          break;
        case 'heartbeat':
          this.handleHeartbeat(sessionId);
          break;
        default:
          this.sendError(ws, 'UNEXPECTED_TYPE', `Unexpected message type: ${msg.type}`);
      }
    });

    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      const sessionId = this.findSessionIdByWs(ws);
      if (sessionId) {
        this.handleDisconnect(sessionId);
      }
    });

    ws.on('error', (err: Error) => {
      this.logger.error('WebSocket error', { error: err.message });
      const sessionId = this.findSessionIdByWs(ws);
      if (sessionId) {
        this.handleDisconnect(sessionId);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Message handlers
  // -------------------------------------------------------------------------

  /**
   * Handle a register message from a client.
   *
   * Assigns a session ID, stores the client, and attempts pairing
   * if another client with the same pairing code is waiting.
   *
   * @param ws - Client WebSocket
   * @param msg - Registration message
   */
  private handleRegister(ws: WebSocket, msg: RelayRegisterMessage): void {
    const sessionId = randomUUID();
    const now = new Date().toISOString();

    const session: RelaySession = {
      sessionId,
      role: msg.role,
      pairingCode: msg.pairingCode,
      state: 'waiting',
      pairedWith: null,
      registeredAt: now,
      lastHeartbeatAt: now,
    };

    const client: ConnectedClient = {
      ws,
      session,
      heartbeatTimer: this.startHeartbeatTimer(sessionId),
    };

    this.clients.set(sessionId, client);

    // Send registration confirmation
    const registered: RelayRegisteredMessage = { type: 'registered', sessionId };
    this.send(ws, registered);

    this.logger.info('Client registered', { sessionId, role: msg.role, pairingCode: msg.pairingCode });

    // Attempt pairing
    this.attemptPairing(sessionId, msg.pairingCode);
  }

  /**
   * Attempt to pair a newly registered client with an existing one.
   *
   * Two clients are paired when they share the same pairing code and
   * have complementary roles (orchestrator + agent).
   *
   * @param sessionId - Session ID of the newly registered client
   * @param pairingCode - Pairing code to match
   */
  private attemptPairing(sessionId: RelaySessionId, pairingCode: string): void {
    const queue = this.pairingQueue.get(pairingCode) ?? [];

    // Look for a compatible peer in the queue
    const newClient = this.clients.get(sessionId);
    if (!newClient?.session) return;

    const peerIndex = queue.findIndex((peerId) => {
      const peer = this.clients.get(peerId);
      if (!peer?.session) return false;
      // Pair orchestrator with agent (different roles)
      return peer.session.role !== newClient.session!.role && peer.session.state === 'waiting';
    });

    if (peerIndex >= 0) {
      const peerId = queue[peerIndex];
      queue.splice(peerIndex, 1);
      if (queue.length === 0) {
        this.pairingQueue.delete(pairingCode);
      } else {
        this.pairingQueue.set(pairingCode, queue);
      }

      this.completePairing(sessionId, peerId);
    } else {
      // No peer yet — add to queue
      queue.push(sessionId);
      this.pairingQueue.set(pairingCode, queue);
    }
  }

  /**
   * Complete pairing between two sessions.
   *
   * Updates both sessions to 'paired' state and sends paired messages
   * to both clients.
   *
   * @param idA - First session ID
   * @param idB - Second session ID
   */
  private completePairing(idA: RelaySessionId, idB: RelaySessionId): void {
    const clientA = this.clients.get(idA);
    const clientB = this.clients.get(idB);

    if (!clientA?.session || !clientB?.session) return;

    clientA.session.state = 'paired';
    clientA.session.pairedWith = idB;
    clientB.session.state = 'paired';
    clientB.session.pairedWith = idA;

    const pairedA: RelayPairedMessage = {
      type: 'paired',
      peerSessionId: idB,
      peerRole: clientB.session.role,
    };
    const pairedB: RelayPairedMessage = {
      type: 'paired',
      peerSessionId: idA,
      peerRole: clientA.session.role,
    };

    this.send(clientA.ws, pairedA);
    this.send(clientB.ws, pairedB);

    this.logger.info('Clients paired', {
      sessionA: idA,
      roleA: clientA.session.role,
      sessionB: idB,
      roleB: clientB.session.role,
    });
  }

  /**
   * Forward a relay message from one peer to its paired counterpart.
   *
   * The payload is forwarded unchanged — the server never decrypts it.
   *
   * @param senderSessionId - Session ID of the sending client
   * @param msg - Relay data message with encrypted payload
   */
  private handleRelay(senderSessionId: RelaySessionId, msg: RelayDataMessage): void {
    const sender = this.clients.get(senderSessionId);
    if (!sender?.session?.pairedWith) {
      this.sendError(sender?.ws ?? null, 'NOT_PAIRED', 'Cannot relay — not paired with a peer');
      return;
    }

    const peer = this.clients.get(sender.session.pairedWith);
    if (!peer) {
      this.sendError(sender.ws, 'PEER_UNAVAILABLE', 'Paired peer is no longer connected');
      return;
    }

    // Forward the encrypted payload as-is
    const forwarded: RelayDataMessage = { type: 'relay', payload: msg.payload };
    this.send(peer.ws, forwarded);
  }

  /**
   * Handle a heartbeat from a client by resetting its timeout timer.
   *
   * @param sessionId - Session ID of the heartbeating client
   */
  private handleHeartbeat(sessionId: RelaySessionId): void {
    const client = this.clients.get(sessionId);
    if (!client?.session) return;

    client.session.lastHeartbeatAt = new Date().toISOString();

    // Reset heartbeat timer
    if (client.heartbeatTimer) {
      clearTimeout(client.heartbeatTimer);
    }
    client.heartbeatTimer = this.startHeartbeatTimer(sessionId);

    const ack: RelayHeartbeatAckMessage = { type: 'heartbeat_ack' };
    this.send(client.ws, ack);
  }

  /**
   * Handle a client disconnection.
   *
   * Cleans up the session, removes from pairing queue, and notifies
   * the paired peer if applicable.
   *
   * @param sessionId - Session ID of the disconnected client
   */
  private handleDisconnect(sessionId: RelaySessionId): void {
    const client = this.clients.get(sessionId);
    if (!client) return;

    if (client.heartbeatTimer) {
      clearTimeout(client.heartbeatTimer);
    }

    // Notify peer of disconnection
    if (client.session?.pairedWith) {
      const peer = this.clients.get(client.session.pairedWith);
      if (peer?.session) {
        peer.session.state = 'waiting';
        peer.session.pairedWith = null;

        const disconnected: RelayPeerDisconnectedMessage = {
          type: 'peer_disconnected',
          peerSessionId: sessionId,
        };
        this.send(peer.ws, disconnected);
      }
    }

    // Remove from pairing queue
    if (client.session) {
      const queue = this.pairingQueue.get(client.session.pairingCode);
      if (queue) {
        const idx = queue.indexOf(sessionId);
        if (idx >= 0) {
          queue.splice(idx, 1);
          if (queue.length === 0) {
            this.pairingQueue.delete(client.session.pairingCode);
          }
        }
      }
    }

    this.clients.delete(sessionId);
    this.logger.info('Client disconnected', { sessionId });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Find the session ID associated with a WebSocket connection.
   *
   * @param ws - WebSocket to look up
   * @returns Session ID or undefined
   */
  private findSessionIdByWs(ws: WebSocket): RelaySessionId | undefined {
    for (const [sessionId, client] of this.clients.entries()) {
      if (client.ws === ws) return sessionId;
    }
    return undefined;
  }

  /**
   * Start a heartbeat timeout timer for a session.
   *
   * If no heartbeat is received within the timeout window, the client
   * is disconnected.
   *
   * @param sessionId - Session ID to monitor
   * @returns Timer handle
   */
  private startHeartbeatTimer(sessionId: RelaySessionId): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.logger.warn('Heartbeat timeout', { sessionId });
      const client = this.clients.get(sessionId);
      if (client) {
        client.ws.close(4002, 'Heartbeat timeout');
        this.handleDisconnect(sessionId);
      }
    }, RELAY.HEARTBEAT_TIMEOUT_MS);
  }

  /**
   * Send a typed relay message to a WebSocket.
   *
   * @param ws - Target WebSocket
   * @param message - Relay message to send
   */
  private send(ws: WebSocket, message: RelayMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send an error message to a WebSocket.
   *
   * @param ws - Target WebSocket (or null if unavailable)
   * @param code - Machine-readable error code
   * @param message - Human-readable error description
   */
  private sendError(ws: WebSocket | null, code: string, message: string): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const errorMsg: RelayErrorMessage = { type: 'error', code, message };
    ws.send(JSON.stringify(errorMsg));
  }
}
