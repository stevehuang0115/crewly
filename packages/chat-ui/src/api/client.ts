/**
 * Chat API client interface + default HTTP implementation.
 *
 * The package is backend-agnostic (Decisions doc #1 constraint). Rather
 * than calling `fetch` from hooks directly we define a small client
 * interface that `ChatAPIProvider` injects. Consumers get:
 *
 * - a real HTTP client for production (default)
 * - a mock client for Storybook / local iteration before the backend lands
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
 * Contract every Chat API client must satisfy. Real HTTP and mock
 * implementations both conform to this so the React layer above is
 * transport-agnostic.
 */
export interface ChatApiClient {
  listChannels(): Promise<Channel[]>;
  createChannel(input: CreateChannelInput): Promise<Channel>;
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
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

/**
 * Envelope wrapper the backend returns on every 2xx (`{ success: true, data: T }`).
 */
interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

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
  // Simple fallback — not used in modern browsers or Node ≥ 19.
  return `cmid-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

// ---------------------------------------------------------------------------
// HTTP implementation
// ---------------------------------------------------------------------------

/**
 * HTTP + WebSocket implementation of `ChatApiClient`.
 *
 * Thin wrapper — no retry logic, no caching. Translates wire DTOs to the
 * package's domain types at the boundary; hooks never see the backend
 * shape.
 */
export class HttpChatApiClient implements ChatApiClient {
  private readonly backendURL: string;
  private readonly authToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly websocketImpl: typeof WebSocket;
  private readonly idGenerator: () => string;

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

  /**
   * Request helper for 204-No-Content responses (e.g. archive channel).
   */
  private async requestEmpty(path: string, init?: RequestInit): Promise<void> {
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

  async sendMessage(channelId: string, input: SendMessageInput): Promise<Message> {
    // Stamp a client-side idempotency id when the caller didn't supply one.
    // Ensures retries on the same send() call dedupe server-side.
    const clientMessageId = input.clientMessageId ?? this.idGenerator();
    const wire = {
      content: input.content,
      // `markdown` is the spec default and matches what the backend expects;
      // callers wanting plain text can still pass contentType through
      // `input` once SendMessageInput exposes it (Phase 2).
      contentType: 'markdown' as const,
      clientMessageId,
      // Phase-1 attachments go through the upload endpoint first; until
      // that lands on Sam's Day 2 we forward nothing here (the backend
      // already rejects non-empty `attachments[]` until the upload endpoint
      // is wired, so skipping avoids a known-bad round-trip).
    };
    const dto = await this.request<MessageDTO>(
      `/api/chat/channels/${encodeURIComponent(channelId)}/messages`,
      { method: 'POST', body: JSON.stringify(wire) },
    );
    return messageFromDTO(dto);
  }

  async getAgentPresence(agentId: string): Promise<AgentPresence> {
    const dto = await this.request<{
      agentSession: string;
      status: 'online' | 'busy' | 'offline' | 'starting';
      lastSeenAt: number | null;
    }>(`/api/chat/presence/${encodeURIComponent(agentId)}`);
    return agentPresenceFromDTO(dto);
  }

  subscribeToChannel(
    channelId: string,
    onEvent: (event: ChatWebsocketEvent) => void,
  ): ChannelSubscription {
    // Convert `http(s)://host` → `ws(s)://host`.
    const wsUrl = this.backendURL.replace(/^http/, 'ws');
    const qs = new URLSearchParams({ channelId });
    if (this.authToken) qs.set('token', this.authToken);
    let socket: WebSocket | null = null;
    try {
      socket = new this.websocketImpl(`${wsUrl}/ws/chat?${qs.toString()}`);
    } catch {
      // If the WS server isn't reachable (e.g. Sam's Day 2 endpoint not yet
      // live), silently no-op — hooks that rely on realtime still work via
      // HTTP fetch + refresh. A real `error` frame is not emitted because
      // the package has no other channel to surface it on.
      return { unsubscribe: () => {} };
    }

    const handleMessage = (ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(
          typeof ev.data === 'string' ? ev.data : '',
        ) as ChatWebsocketEvent;
        onEvent(parsed);
      } catch {
        // Malformed frames are ignored — the server owns the contract.
      }
    };
    const theSocket = socket;
    theSocket.addEventListener('message', handleMessage);

    return {
      unsubscribe: () => {
        try {
          theSocket.removeEventListener('message', handleMessage);
          if (
            theSocket.readyState === theSocket.OPEN ||
            theSocket.readyState === theSocket.CONNECTING
          ) {
            theSocket.close();
          }
        } catch {
          // Swallow — closing a socket that is already closing should not throw.
        }
      },
    };
  }
}
