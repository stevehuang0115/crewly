/**
 * ChatV2Gateway — native WebSocket gateway for the Phase 1 Chat MVP.
 *
 * Listens on `/ws/chat?channelId=X&token=Y&lastSeenSeq=N` and fans out
 * wire-format frames to subscribers per Sam's tech spec §6 / the frontend
 * contract implemented by Max in `packages/chat-ui/src/api/client.ts`.
 *
 * Wire contract this gateway must honor (enforced by co-located tests):
 *  - Client→server: `{type:"ping",ts}` every 25s
 *  - Server→client: `{type:"pong",ts}` echo within 10s
 *  - Server→client: `{type:"message",payload:{channelId,message:MessageDTO}}`
 *  - Server→client: `{type:"presence",payload:{agentSession,status,lastSeenAt?}}`
 *  - Server→client: `{type:"error",code,message}` followed by close() on fatal
 *
 * This module is intentionally thin: it does not persist, does not dispatch
 * to agents, and does not manage presence state. The controller/dispatcher
 * call `broadcast()` after the service layer writes to SQLite, so the
 * gateway's only job is routing frames to the right sockets.
 *
 * Upgrade-handoff pattern copied from `BrowserBridgeService.attach()` —
 * Socket.IO's Engine.IO upgrade handler would otherwise corrupt frames on
 * non-`/socket.io/` paths, so we intercept the `upgrade` event on the
 * HTTP server and handle `/ws/chat` exclusively.
 *
 * @module websocket/chat-v2.gateway
 */

import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ChatV2Service } from '../services/chat-v2/chat-v2.service.js';
import type {
  ChatAgentPresenceStatus,
  ChatChannelDTO,
  ChatMessageDTO,
} from '../services/chat-v2/types.js';
import { ChatError, CHAT_ERROR_CODES } from '../services/chat-v2/types.js';
import { LoggerService, ComponentLogger } from '../services/core/logger.service.js';

// ---------------------------------------------------------------------------
// Wire types (mirror `packages/chat-ui/src/api/dto.ts` — keep in sync)
// ---------------------------------------------------------------------------

/** Server→client wire frame. Discriminated by `type`. */
export type ChatWireEvent =
  | { type: 'message'; payload: { channelId: string; message: ChatMessageDTO } }
  | {
      type: 'presence';
      payload: {
        agentSession: string;
        status: ChatAgentPresenceStatus;
        lastSeenAt?: number | null;
      };
    }
  | { type: 'pong'; ts: number }
  | { type: 'error'; code: string; message: string };

/** Client→server wire frame (Phase 1 only has `ping`). */
export interface ChatClientFrame {
  type: 'ping';
  ts: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Pluggable auth for the WS handshake. Must resolve the `?token=` query
 * parameter into a userId, or throw to reject the connection.
 *
 * In production this verifies the OSS session JWT. In dev (no secret
 * configured) `DevTokenVerifier` allows any token (or none) and returns a
 * static userId — sufficient for localhost tests.
 */
export interface ChatWsTokenVerifier {
  (token: string | null): Promise<{ userId: string } | null>;
}

/** Constructor options for {@link ChatV2Gateway}. */
export interface ChatV2GatewayOptions {
  service: ChatV2Service;
  verifyToken: ChatWsTokenVerifier;
  /** Mount path on the HTTP server. Defaults to `/ws/chat`. */
  path?: string;
  /** Optional WebSocketServer override for tests. */
  webSocketServerImpl?: typeof WebSocketServer;
  /** Optional clock override (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/** Default WS mount path — matches the frontend `?${qs}` URL in client.ts. */
export const CHAT_V2_WS_PATH = '/ws/chat';

/**
 * Always-accept token verifier used when `CREWLY_JWT_SECRET` is not
 * configured. Returns the SAME `userId` that `requireAuth`'s dev
 * fallback uses (`dev-user-001`) so that channels created via the
 * REST API are owned by the same principal the WS client will verify
 * as. Not for production — in production a JWT-verifying `verifyToken`
 * function is passed to `ChatV2Gateway` instead.
 */
export const devAnonymousTokenVerifier: ChatWsTokenVerifier = async () => ({
  userId: 'dev-user-001',
});

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** One live subscriber — a WebSocket bound to a channel. */
interface ChatSubscriber {
  ws: WebSocket;
  channelId: string;
  userId: string;
  connectedAt: number;
}

/**
 * A WebSocket gateway that fans chat events out to subscribers.
 *
 * Lifecycle:
 *  1. `attach(httpServer)` — hooks the upgrade interceptor
 *  2. `broadcast(channelId, event)` — called by controller after persist
 *  3. `close()` — shutdown hook (graceful close all sockets)
 *
 * The gateway owns the WebSocketServer and the subscribers map. It never
 * reaches into the service layer on its own — all domain data arrives via
 * `broadcast()` from callers who have already persisted.
 */
export class ChatV2Gateway {
  private readonly service: ChatV2Service;
  private readonly verifyToken: ChatWsTokenVerifier;
  private readonly path: string;
  private readonly webSocketServerImpl: typeof WebSocketServer;
  private readonly now: () => number;
  private readonly logger: ComponentLogger;

  private wss: WebSocketServer | null = null;
  private attached = false;
  /** channelId → set of subscribers listening on that channel. */
  private readonly subscribers = new Map<string, Set<ChatSubscriber>>();
  /**
   * External broadcast listeners registered via {@link onBroadcast}.
   * Independent from the WebSocket subscriber map so a listener still
   * fires when there are no local WS clients (e.g. when only the Cloud
   * Portal is observing the channel via the relay adapter).
   */
  private readonly externalListeners = new Set<
    (channelId: string, event: ChatWireEvent) => void
  >();

  constructor(options: ChatV2GatewayOptions) {
    this.service = options.service;
    this.verifyToken = options.verifyToken;
    this.path = options.path ?? CHAT_V2_WS_PATH;
    this.webSocketServerImpl = options.webSocketServerImpl ?? WebSocketServer;
    this.now = options.now ?? Date.now;
    this.logger = LoggerService.getInstance().createComponentLogger('ChatV2Gateway');
  }

  /**
   * Mount the gateway on an HTTP server.
   *
   * Uses `noServer:true` + an `httpServer.emit` override identical to
   * `BrowserBridgeService.attach()` — the override exclusively handles
   * upgrades whose pathname matches `this.path`, so Engine.IO never sees
   * them and cannot corrupt the frames.
   *
   * @param httpServer - Shared Node HTTP server instance
   */
  attach(httpServer: HttpServer): void {
    if (this.attached) {
      this.logger.warn('chat-v2 WS gateway already attached');
      return;
    }
    this.attached = true;

    this.wss = new this.webSocketServerImpl({
      noServer: true,
      perMessageDeflate: false,
    });

    // Two-part installation:
    //   1. Register an explicit `upgrade` listener. This guarantees the
    //      event is wired even when we're the ONLY listener (tests, dev
    //      standalone — no Socket.IO). In production Socket.IO ALSO
    //      listens; both fire, but step 2 keeps them from colliding.
    //   2. Override `httpServer.emit` so that a `/ws/chat` upgrade event
    //      is handled exclusively, with no other listeners (Engine.IO's
    //      in particular) seeing it. Without this, Engine.IO's 1s
    //      socket.end() timer and compression bits would corrupt our
    //      frames. Same pattern as `BrowserBridgeService.attach()`.
    const pathMatches = (req: { url?: string; headers: Record<string, string | undefined> }): boolean => {
      const url = req.url || '';
      const host = req.headers.host || 'localhost';
      try {
        return new URL(url, `http://${host}`).pathname === this.path;
      } catch {
        return false;
      }
    };

    type UpgradeArgs = Parameters<InstanceType<typeof WebSocketServer>['handleUpgrade']>;
    const performUpgrade = (
      request: UpgradeArgs[0],
      socket: UpgradeArgs[1],
      head: UpgradeArgs[2],
    ): void => {
      if (!pathMatches(request as unknown as { url?: string; headers: Record<string, string | undefined> })) return;
      this.wss!.handleUpgrade(request, socket, head, (ws, req) => {
        this.wss!.emit('connection', ws, req);
      });
    };
    // Register the listener so the 'upgrade' event fires at all (Node's
    // HTTP server routes upgrade requests to the regular request handler
    // when no 'upgrade' listener is registered).
    httpServer.on('upgrade', performUpgrade as unknown as (...args: unknown[]) => void);

    const originalEmit = httpServer.emit.bind(httpServer) as (
      ...args: unknown[]
    ) => boolean;
    (httpServer as { emit: (...args: unknown[]) => boolean }).emit = (
      event: unknown,
      ...args: unknown[]
    ): boolean => {
      if (event === 'upgrade') {
        const request = args[0] as {
          url?: string;
          headers: Record<string, string | undefined>;
        };
        if (pathMatches(request)) {
          // Run our upgrade handler exclusively — skip every other
          // listener (Engine.IO's especially) so their post-hooks cannot
          // corrupt our socket.
          performUpgrade(
            args[0] as UpgradeArgs[0],
            args[1] as UpgradeArgs[1],
            args[2] as UpgradeArgs[2],
          );
          return true;
        }
      }
      return originalEmit(event, ...args);
    };

    this.wss.on('connection', (ws, req) => {
      // ts-jest in CI sometimes resolves req.url as undefined when the
      // upgrade interceptor is exercised from a test — guard both.
      void this.handleConnection(ws, req as { url?: string; headers: Record<string, string | undefined> });
    });

    this.wss.on('error', (err) => {
      this.logger.error('WS server error', { error: err.message });
    });

    this.logger.info('chat-v2 WS gateway attached', { path: this.path });
  }

  /**
   * Broadcast a wire event to every subscriber on `channelId`.
   *
   * Safe to call synchronously from inside a DB transaction — sends are
   * queued on the underlying socket and do not block.
   *
   * @param channelId - Target channel
   * @param event - Wire frame to push
   */
  broadcast(channelId: string, event: ChatWireEvent): void {
    // 1. Fan to local WebSocket subscribers (the original behaviour).
    const set = this.subscribers.get(channelId);
    if (set && set.size > 0) {
      const frame = JSON.stringify(event);
      for (const sub of set) {
        if (sub.ws.readyState !== WebSocket.OPEN) continue;
        try {
          sub.ws.send(frame);
        } catch (err) {
          this.logger.warn('chat-v2 ws send failed', {
            channelId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 2. Fan to external listeners (e.g. ChatV2RelayAdapter forwarding the
    // event to Cloud Portal subscribers over the relay queue). Runs even
    // when there are zero local WS subscribers — the Portal may be the
    // ONLY listener for a given session.
    if (this.externalListeners.size === 0) return;
    for (const listener of this.externalListeners) {
      try {
        listener(channelId, event);
      } catch (err) {
        // Never let a misbehaving listener break the broadcast loop; the
        // next listener (and the user's WS subscribers above) must still
        // see the event.
        this.logger.warn('chat-v2 external broadcast listener threw', {
          channelId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Register an external listener that fires on every {@link broadcast} call,
   * even when there are no local WebSocket subscribers.
   *
   * The primary consumer is `ChatV2RelayAdapter`, which forwards events
   * over the Cloud relay so the Crewly Portal (running on a different
   * device) can render the same realtime updates that the local OSS UI
   * receives via WebSocket.
   *
   * Listener errors are caught and logged — a thrown listener never
   * interrupts the broadcast loop or affects other listeners / WS sends.
   *
   * @param listener - Called with `(channelId, event)` per broadcast
   * @returns Unsubscribe function; call once during shutdown
   */
  onBroadcast(
    listener: (channelId: string, event: ChatWireEvent) => void,
  ): () => void {
    this.externalListeners.add(listener);
    return () => {
      this.externalListeners.delete(listener);
    };
  }

  /**
   * Count of currently-open subscribers for a channel. Exposed for tests
   * and future observability dashboards.
   */
  subscriberCount(channelId: string): number {
    return this.subscribers.get(channelId)?.size ?? 0;
  }

  /** Total open sockets across all channels. Observability helper. */
  totalSubscribers(): number {
    let n = 0;
    for (const set of this.subscribers.values()) n += set.size;
    return n;
  }

  /**
   * Gracefully close all sockets. Called during shutdown.
   */
  async close(): Promise<void> {
    if (!this.wss) return;
    for (const set of this.subscribers.values()) {
      for (const sub of set) {
        try {
          sub.ws.close(1001, 'server shutdown');
        } catch {
          // ignore
        }
      }
    }
    this.subscribers.clear();
    await new Promise<void>((resolve) => {
      this.wss!.close(() => resolve());
    });
    this.wss = null;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Handle a freshly-upgraded socket: parse query string, verify token,
   * authorize against the channel, and register the subscriber.
   *
   * On any failure we send a single `{type:"error",...}` frame and close
   * with a 1008 (policy violation) code — matching the frontend's
   * "fatal, stop reconnecting" contract.
   */
  async handleConnection(
    ws: WebSocket,
    req: { url?: string; headers: Record<string, string | undefined> },
  ): Promise<void> {
    const host = req.headers.host || 'localhost';
    let parsed: URL;
    try {
      parsed = new URL(req.url ?? '', `http://${host}`);
    } catch {
      this.sendErrorAndClose(ws, 'bad_request', 'malformed URL');
      return;
    }

    const channelId = parsed.searchParams.get('channelId');
    const token = parsed.searchParams.get('token');
    // lastSeenSeq is accepted but not yet acted on (Phase 1.5 replay).
    // Parsing validates that callers send a number if they send it at all.
    const lastSeenSeqRaw = parsed.searchParams.get('lastSeenSeq');
    if (lastSeenSeqRaw !== null && !/^\d+$/.test(lastSeenSeqRaw)) {
      this.sendErrorAndClose(ws, 'bad_request', 'lastSeenSeq must be a non-negative integer');
      return;
    }

    if (!channelId) {
      this.sendErrorAndClose(ws, 'bad_request', 'channelId is required');
      return;
    }

    let identity: { userId: string } | null;
    try {
      identity = await this.verifyToken(token);
    } catch (err) {
      this.logger.warn('chat-v2 ws token verify threw', {
        err: err instanceof Error ? err.message : String(err),
      });
      this.sendErrorAndClose(ws, 'unauthorized', 'token verification failed');
      return;
    }
    if (!identity) {
      this.sendErrorAndClose(ws, 'unauthorized', 'invalid token');
      return;
    }

    // Authorize: the channel must exist AND be owned by this user (or —
    // in a later iteration — be readable by the agent identified here).
    try {
      this.service.getChannel(channelId, { userId: identity.userId, source: 'oss' });
    } catch (err) {
      if (err instanceof ChatError && err.code === CHAT_ERROR_CODES.CHANNEL_NOT_FOUND) {
        // 404 leaks less than 403 for ownership checks (consistent with §7.2)
        this.sendErrorAndClose(ws, 'channel_not_found', 'channel not found');
        return;
      }
      this.sendErrorAndClose(ws, 'internal_error', 'authorization failed');
      return;
    }

    const subscriber: ChatSubscriber = {
      ws,
      channelId,
      userId: identity.userId,
      connectedAt: this.now(),
    };
    this.registerSubscriber(subscriber);

    ws.on('message', (data) => this.handleMessage(subscriber, data));
    ws.on('close', () => this.unregisterSubscriber(subscriber));
    ws.on('error', (err) => {
      this.logger.warn('chat-v2 ws socket error', {
        channelId: subscriber.channelId,
        err: err.message,
      });
    });

    this.logger.debug('chat-v2 ws connection established', {
      channelId,
      userId: identity.userId,
      total: this.totalSubscribers(),
    });
  }

  // -------------------------------------------------------------------------
  // Message routing
  // -------------------------------------------------------------------------

  /**
   * Handle a frame from the client.
   *
   * Phase 1 only understands `{type:"ping",ts}`; any other shape is
   * silently dropped (forward-compat with future client-origin frames).
   */
  private handleMessage(sub: ChatSubscriber, raw: unknown): void {
    let parsed: ChatClientFrame | null = null;
    try {
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
      const obj = JSON.parse(text) as { type?: unknown; ts?: unknown };
      if (obj && obj.type === 'ping') {
        const ts = typeof obj.ts === 'number' ? obj.ts : this.now();
        parsed = { type: 'ping', ts };
      }
    } catch {
      // malformed frame — drop
      return;
    }
    if (!parsed) return;

    // Echo pong with the client's own ts — the client uses the round-trip
    // for its 10s timeout, not strict clock agreement.
    const pong: ChatWireEvent = { type: 'pong', ts: parsed.ts };
    if (sub.ws.readyState === WebSocket.OPEN) {
      try {
        sub.ws.send(JSON.stringify(pong));
      } catch {
        // ignore — the socket will close and the close handler cleans up
      }
    }
  }

  // -------------------------------------------------------------------------
  // Subscriber bookkeeping
  // -------------------------------------------------------------------------

  private registerSubscriber(sub: ChatSubscriber): void {
    let set = this.subscribers.get(sub.channelId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sub.channelId, set);
    }
    set.add(sub);
  }

  private unregisterSubscriber(sub: ChatSubscriber): void {
    const set = this.subscribers.get(sub.channelId);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) this.subscribers.delete(sub.channelId);
  }

  /**
   * Send an error frame then close with 1008. Used for all pre-subscribe
   * rejections (auth, malformed URL, missing channelId, not-found).
   */
  private sendErrorAndClose(ws: WebSocket, code: string, message: string): void {
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.send(JSON.stringify({ type: 'error', code, message } satisfies ChatWireEvent));
      }
    } catch {
      // ignore
    }
    try {
      ws.close(1008, code);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Channel presence broadcast helper (future — not wired in Phase 1)
// ---------------------------------------------------------------------------

/**
 * Build a presence wire frame. Placed here so both the gateway's tests and
 * future presence emitters use the same shape.
 *
 * @param agentSession - The agent whose presence changed
 * @param status - New status
 * @param lastSeenAt - Optional last-seen timestamp (ms)
 */
export function buildPresenceEvent(
  agentSession: string,
  status: ChatAgentPresenceStatus,
  lastSeenAt?: number | null,
): Extract<ChatWireEvent, { type: 'presence' }> {
  return {
    type: 'presence',
    payload: { agentSession, status, lastSeenAt: lastSeenAt ?? null },
  };
}

/**
 * Build a message wire frame from a DTO. Used by both the controller (on
 * HTTP persist) and the dispatcher (on agent reply).
 */
export function buildMessageEvent(
  channelId: string,
  message: ChatMessageDTO,
): Extract<ChatWireEvent, { type: 'message' }> {
  return {
    type: 'message',
    payload: { channelId, message },
  };
}

// Types re-exported for callers that need them without pulling from dto.
export type { ChatChannelDTO };
