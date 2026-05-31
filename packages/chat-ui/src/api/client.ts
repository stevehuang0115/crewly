/**
 * Chat API client interface + default HTTP implementation.
 *
 * The package is backend-agnostic. Rather than calling `fetch` from hooks
 * directly we define a small client interface that `ChatAPIProvider`
 * injects. Consumers get:
 *
 * - a real HTTP client for production (default)
 * - a mock client for Storybook / local iteration
 *
 * Either one satisfies the same `ChatApiClient` contract, so hooks never
 * branch on mode.
 *
 * Wire ↔ domain translation lives in `./dto.ts`. Error envelope parsing
 * lives in `./errors.ts`. This file orchestrates both.
 *
 * @module api/client
 */

import type {
  Channel,
  CreateChannelInput,
  CreateHuddleInput,
  MessagePage,
  SendMessageInput,
  Message,
  AgentPresence,
  ChatWebsocketEvent,
} from '../types/chat.types';
import {
  channelFromDTO,
  messageFromDTO,
  agentPresenceFromDTO,
  wsEventFromWire,
  type ChannelDTO,
  type ChannelListEnvelope,
  type MessageDTO,
  type MessageListEnvelope,
} from './dto';
import { ChatApiError } from './errors';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * Subscription handle returned by `subscribeToChannel`.
 * Call `unsubscribe()` to stop receiving events.
 */
export interface ChannelSubscription {
  unsubscribe(): void;
}

/**
 * Identity of the local user — used to author optimistic pending messages
 * before the server assigns the canonical `senderId`. The HTTP client
 * stamps this onto pending records so the timeline can render the user's
 * bubble immediately.
 */
export interface CurrentUserIdentity {
  /** Stable user id (e.g. Crewly account id, Cloud id). */
  id: string;
  /** Display name shown in the bubble's author label. Optional. */
  name?: string;
}

/**
 * Contract every Chat API client must satisfy. Real HTTP and mock
 * implementations both conform to this so the React layer above is
 * transport-agnostic.
 */
export interface ChatApiClient {
  listChannels(): Promise<Channel[]>;
  createChannel(input: CreateChannelInput): Promise<Channel>;
  /** Create an ad-hoc multi-agent group chat ("拉群"). */
  createHuddle(input: CreateHuddleInput): Promise<Channel>;
  listMessages(channelId: string, opts?: { cursor?: string; limit?: number }): Promise<MessagePage>;
  sendMessage(channelId: string, input: SendMessageInput): Promise<Message>;
  getAgentPresence(agentId: string): Promise<AgentPresence>;
  subscribeToChannel(
    channelId: string,
    onEvent: (event: ChatWebsocketEvent) => void,
  ): ChannelSubscription;
}

/**
 * Construction options for the default HTTP client.
 */
export interface HttpClientOptions {
  /** Base URL of the OSS backend, e.g. `http://localhost:8787`. */
  backendURL: string;
  /**
   * Optional bearer token. Portal injects a Cloud-scoped token here; OSS
   * passes its local session token. The package does not interpret it.
   */
  authToken?: string;
  /**
   * Optional override for `fetch` (for testing or custom retry wrappers).
   * Defaults to `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional override for the WebSocket constructor. Defaults to
   * `globalThis.WebSocket`. Useful in tests that don't run in a browser.
   */
  websocketImpl?: typeof WebSocket;
  /**
   * Optional override for the random id generator used when a caller
   * doesn't supply an explicit `clientMessageId`. Exposed so tests can
   * stub deterministic ids.
   */
  idGenerator?: () => string;
  /**
   * Identity used to author optimistic pending messages. When omitted,
   * the placeholder `{ id: '__me__', name: 'You' }` is used — sufficient
   * for the demo, but Portal/OSS callers should pass the real account id.
   */
  currentUser?: CurrentUserIdentity;
  /**
   * Override the JSON-heartbeat ping cadence (ms). Default 25s, matching
   * Sam's tech spec §6.1. Tests use a much smaller value.
   */
  heartbeatIntervalMs?: number;
  /**
   * How long to wait for a `pong` reply before declaring the socket dead
   * and forcing a reconnect. Default 10s.
   */
  pongTimeoutMs?: number;
  /**
   * Backoff before attempting to reconnect after an unexpected close.
   * Default 1000ms.
   */
  reconnectDelayMs?: number;
  /**
   * Override the wall-clock used for ping timestamps + pong timeouts.
   * Tests pass `() => fakeNow` to make heartbeats deterministic.
   */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Envelope wrapper the backend returns on every 2xx (`{ success: true, data: T }`). */
interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

/** Default placeholder identity for optimistic pending messages. */
const DEFAULT_CURRENT_USER: CurrentUserIdentity = { id: '__me__', name: 'You' };

/** Default heartbeat / reconnect tuning per Sam's tech spec §6. */
const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;

/**
 * Generate a UUID v4 for the `clientMessageId` field.
 *
 * Prefer the platform `crypto.randomUUID()` when available; fall back to
 * a pseudo-UUID shape for older environments. The only requirement from
 * the backend is uniqueness per channel — no cryptographic strength.
 */
function defaultIdGenerator(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  return `cmid-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

/** A registered local subscriber on a specific channel. */
interface LocalSubscriber {
  channelId: string;
  onEvent: (event: ChatWebsocketEvent) => void;
}

// ---------------------------------------------------------------------------
// HTTP implementation
// ---------------------------------------------------------------------------

/**
 * HTTP + WebSocket implementation of `ChatApiClient`.
 *
 * Responsibilities:
 *  - REST round-trips for channels, messages, presence
 *  - WebSocket subscription with JSON-level heartbeat + reconnect-with-replay
 *  - Local broadcast of optimistic pending/confirmed/failed records to all
 *    subscribers of the affected channel, so that timelines render the
 *    user's send instantly without lifting state into the consumer
 *
 * Translates wire DTOs to the package's domain types at the boundary;
 * hooks never see the backend shape.
 */
export class HttpChatApiClient implements ChatApiClient {
  private readonly backendURL: string;
  private readonly authToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly websocketImpl: typeof WebSocket;
  private readonly idGenerator: () => string;
  private readonly currentUser: CurrentUserIdentity;
  private readonly heartbeatIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly reconnectDelayMs: number;
  private readonly now: () => number;

  /**
   * Local subscribers — the same set `subscribeToChannel` registers, used
   * to fan optimistic events out to all hooks on a channel without going
   * through the WebSocket round-trip.
   */
  private readonly localSubscribers = new Set<LocalSubscriber>();

  constructor(opts: HttpClientOptions) {
    this.backendURL = opts.backendURL.replace(/\/+$/, '');
    this.authToken = opts.authToken;
    this.fetchImpl =
      opts.fetchImpl ??
      (typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : (undefined as never));
    this.websocketImpl =
      opts.websocketImpl ?? (globalThis.WebSocket as unknown as typeof WebSocket);
    this.idGenerator = opts.idGenerator ?? defaultIdGenerator;
    this.currentUser = opts.currentUser ?? DEFAULT_CURRENT_USER;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.now = opts.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Core request helpers
  // -------------------------------------------------------------------------

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
    };
    if (this.authToken) h['Authorization'] = `Bearer ${this.authToken}`;
    return h;
  }

  /**
   * Fetch + envelope-unwrap. Throws `ChatApiError` on non-2xx.
   *
   * @typeParam T - Shape of the `data` payload inside the success envelope.
   */
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.backendURL}${path}`, {
        ...init,
        headers: this.headers(init?.headers as Record<string, string> | undefined),
      });
    } catch (err) {
      throw new ChatApiError({
        code: 'network_error',
        httpStatus: 0,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (!res.ok) throw await ChatApiError.fromResponse(res);
    const body = (await res.json()) as SuccessEnvelope<T>;
    return body.data;
  }

  // -------------------------------------------------------------------------
  // ChatApiClient contract
  // -------------------------------------------------------------------------

  async listChannels(): Promise<Channel[]> {
    const env = await this.request<ChannelListEnvelope>('/api/chat/channels');
    return env.channels.map(channelFromDTO);
  }

  async createChannel(input: CreateChannelInput): Promise<Channel> {
    const dto = await this.request<ChannelDTO>('/api/chat/channels', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return channelFromDTO(dto);
  }

  async createHuddle(input: CreateHuddleInput): Promise<Channel> {
    const dto = await this.request<ChannelDTO>('/api/chat/channels/huddle', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return channelFromDTO(dto);
  }

  async listMessages(
    channelId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<MessagePage> {
    const qs = new URLSearchParams();
    if (opts.cursor) qs.set('cursor', opts.cursor);
    if (opts.limit) qs.set('limit', String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const env = await this.request<MessageListEnvelope>(
      `/api/chat/channels/${encodeURIComponent(channelId)}/messages${suffix}`,
    );
    return {
      messages: env.messages.map(messageFromDTO),
      nextCursor: env.nextCursor,
    };
  }

  /**
   * Send a message with optimistic UX.
   *
   * Flow (Sam's spec — HTTP 201 is the ack, WS broadcast is state-sync):
   *  1. Stamp `clientMessageId` if the caller did not provide one.
   *  2. Emit a synthetic `pending` event to all local subscribers of the
   *     channel, so their timelines render the user's bubble instantly.
   *  3. POST the message; on 2xx the server echoes `clientMessageId` in
   *     `metadata`. We re-emit the persisted record so subscribers swap
   *     the pending bubble for the canonical row (matched by
   *     `clientMessageId`).
   *  4. On error, re-emit the optimistic record with `deliveryStatus:
   *     "failed"` so the UI can surface a retry affordance.
   *
   * The eventual WS broadcast for the same row is idempotent — useMessages
   * dedupes by `clientMessageId` first, then by `id`.
   *
   * @param channelId - Target channel
   * @param input - Body (content, attachments, optional clientMessageId)
   * @returns The persisted server record on success
   * @throws ChatApiError on transport or 4xx/5xx
   */
  async sendMessage(channelId: string, input: SendMessageInput): Promise<Message> {
    const clientMessageId = input.clientMessageId ?? this.idGenerator();
    const optimistic = this.buildOptimisticMessage(channelId, input, clientMessageId);
    this.emitLocal(channelId, { type: 'message', channelId, message: optimistic });

    // Phase B (SEALED §3.2) — forward `mentions` + `threadId`. The BE
    // service validates: cross-channel threadId → 400, mention-count > 50
    // → 400, mentions JSON > 1KB → 413. We surface those errors via the
    // standard `ChatApiError` envelope below.
    const wire: {
      content: string;
      contentType: 'markdown';
      clientMessageId: string;
      mentions?: string[];
      threadId?: string;
    } = {
      content: input.content,
      contentType: 'markdown' as const,
      clientMessageId,
      // Phase-1 attachments still go through the upload endpoint first
      // (orchestrator decision 2026-04-24). Forwarding nothing avoids
      // round-tripping a known-bad payload until that endpoint lands.
    };
    if (input.mentions && input.mentions.length > 0) {
      wire.mentions = input.mentions;
    }
    if (input.threadId) {
      wire.threadId = input.threadId;
    }

    let dto: MessageDTO;
    try {
      dto = await this.request<MessageDTO>(
        `/api/chat/channels/${encodeURIComponent(channelId)}/messages`,
        { method: 'POST', body: JSON.stringify(wire) },
      );
    } catch (err) {
      // Mark the optimistic record as failed so the UI can show retry.
      this.emitLocal(channelId, {
        type: 'message',
        channelId,
        message: { ...optimistic, deliveryStatus: 'failed' },
      });
      throw err;
    }

    const confirmed = messageFromDTO(dto);
    // Server should echo our token, but defend against backends that do not.
    if (!confirmed.clientMessageId) confirmed.clientMessageId = clientMessageId;
    this.emitLocal(channelId, { type: 'message', channelId, message: confirmed });
    return confirmed;
  }

  async getAgentPresence(agentId: string): Promise<AgentPresence> {
    const dto = await this.request<{
      agentSession: string;
      status: 'online' | 'busy' | 'offline' | 'starting';
      lastSeenAt: number | null;
    }>(`/api/chat/presence/${encodeURIComponent(agentId)}`);
    return agentPresenceFromDTO(dto);
  }

  /**
   * Subscribe to a channel's WebSocket feed.
   *
   * Implementation details (per Sam's tech spec §6, locked 2026-04-24):
   *  - JSON heartbeat: client sends `{type:"ping",ts}` every 25s; server
   *    replies `{type:"pong",ts}`. If no pong in 10s we close + reconnect.
   *  - Replay on reconnect: query string includes `?lastSeenSeq=N` so the
   *    server can re-deliver any messages persisted while we were dead.
   *  - All wire frames are translated to domain `ChatWebsocketEvent`
   *    before being handed to the consumer; hooks never parse JSON.
   *  - Local optimistic events emitted by `sendMessage` flow through the
   *    same callback, so the consumer sees a single ordered event stream.
   *
   * @param channelId - Channel to subscribe to
   * @param onEvent - Domain-level event handler
   * @returns Subscription handle with `unsubscribe()`
   */
  subscribeToChannel(
    channelId: string,
    onEvent: (event: ChatWebsocketEvent) => void,
  ): ChannelSubscription {
    const subscriber: LocalSubscriber = { channelId, onEvent };
    this.localSubscribers.add(subscriber);

    const conn = this.openWebsocketConnection(channelId, onEvent);

    return {
      unsubscribe: () => {
        this.localSubscribers.delete(subscriber);
        conn.close();
      },
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Build the optimistic pending Message record for a freshly-issued send. */
  private buildOptimisticMessage(
    channelId: string,
    input: SendMessageInput,
    clientMessageId: string,
  ): Message {
    return {
      id: clientMessageId,
      channelId,
      seq: -1,
      author: {
        role: 'user',
        id: this.currentUser.id,
        name: this.currentUser.name,
      },
      content: input.content,
      attachments: input.attachments,
      createdAt: new Date(this.now()).toISOString(),
      clientMessageId,
      deliveryStatus: 'pending',
      // Phase B — preserve the composer's mention/thread payload on the
      // optimistic record so the timeline renders the same chips/thread
      // affordance immediately, before the server echo reconciles.
      mentions: input.mentions ?? [],
      threadId: input.threadId,
    };
  }

  /** Fan an event out to every local subscriber on the matching channel. */
  private emitLocal(channelId: string, event: ChatWebsocketEvent): void {
    for (const sub of this.localSubscribers) {
      if (sub.channelId !== channelId) continue;
      try {
        sub.onEvent(event);
      } catch {
        // A subscriber crashing must not stop the others.
      }
    }
  }

  /**
   * Open a WS connection to the chat backend with heartbeat + reconnect.
   *
   * Returns an opaque handle whose `close()` halts the connection cycle
   * (no further reconnects). Internal use only.
   */
  private openWebsocketConnection(
    channelId: string,
    onEvent: (event: ChatWebsocketEvent) => void,
  ): { close(): void } {
    let socket: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let pongTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSeenSeq = 0;
    let stopped = false;

    const clearTimers = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (pongTimer) {
        clearTimeout(pongTimer);
        pongTimer = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const closeSocket = () => {
      if (!socket) return;
      try {
        if (
          socket.readyState === socket.OPEN ||
          socket.readyState === socket.CONNECTING
        ) {
          socket.close();
        }
      } catch {
        // Closing a half-open socket can throw on some platforms; ignore.
      }
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      clearTimers();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, this.reconnectDelayMs);
    };

    const sendPing = () => {
      if (!socket || socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify({ type: 'ping', ts: this.now() }));
      } catch {
        // If send fails the close handler will reconnect.
        return;
      }
      // Arm the pong timeout; sendPing is called in a loop so we always
      // refresh it on each tick. A missed pong → force-close → reconnect.
      if (pongTimer) clearTimeout(pongTimer);
      pongTimer = setTimeout(() => {
        // Force a close; the close handler schedules the reconnect.
        closeSocket();
      }, this.pongTimeoutMs);
    };

    const connect = () => {
      if (stopped) return;
      const wsUrl = this.backendURL.replace(/^http/, 'ws');
      const qs = new URLSearchParams({ channelId });
      if (this.authToken) qs.set('token', this.authToken);
      if (lastSeenSeq > 0) qs.set('lastSeenSeq', String(lastSeenSeq));

      try {
        socket = new this.websocketImpl(`${wsUrl}/ws/chat?${qs.toString()}`);
      } catch {
        // Constructor failed — schedule a backoff retry.
        scheduleReconnect();
        return;
      }

      const handleMessage = (ev: MessageEvent) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        } catch {
          return; // malformed frame — drop
        }
        const domain = wsEventFromWire(parsed);
        if (!domain) return;

        if (domain.type === 'pong') {
          // Liveness confirmed — clear the pending pong timeout.
          if (pongTimer) {
            clearTimeout(pongTimer);
            pongTimer = null;
          }
          // We still surface pong events for tests/observability.
          onEvent(domain);
          return;
        }

        if (domain.type === 'message') {
          if (domain.message.seq > lastSeenSeq) lastSeenSeq = domain.message.seq;
        }

        if (domain.type === 'error') {
          // Server signaled fatal — surface, then stop the cycle.
          onEvent(domain);
          stopped = true;
          clearTimers();
          closeSocket();
          return;
        }

        onEvent(domain);
      };

      const handleOpen = () => {
        // Start the heartbeat loop.
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(sendPing, this.heartbeatIntervalMs);
      };

      const handleClose = () => {
        scheduleReconnect();
      };

      socket.addEventListener('message', handleMessage);
      socket.addEventListener('open', handleOpen);
      socket.addEventListener('close', handleClose);
      // 'error' events fire just before 'close' on most platforms; we
      // rely on the close handler to schedule the reconnect.
    };

    connect();

    return {
      close() {
        stopped = true;
        clearTimers();
        closeSocket();
      },
    };
  }
}
