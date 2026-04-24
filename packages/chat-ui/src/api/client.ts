/**
 * Chat API client interface.
 *
 * The package is backend-agnostic (Decisions doc #1 constraint). Rather
 * than calling `fetch` from hooks directly we define a small client
 * interface that `ChatAPIProvider` injects. Consumers get:
 *
 * - a real HTTP client for production (default)
 * - a mock client for Storybook / local iteration while Sam's backend
 *   is still being defined
 *
 * Either one satisfies the same `ChatApiClient` contract, so hooks never
 * branch on mode.
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
}

/**
 * HTTP + WebSocket implementation of `ChatApiClient`.
 *
 * Thin wrapper — no retry logic, no caching. The hooks layer owns UX
 * concerns like optimistic sends and reconnect; this class just moves
 * bytes.
 */
export class HttpChatApiClient implements ChatApiClient {
  private readonly backendURL: string;
  private readonly authToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly websocketImpl: typeof WebSocket;

  constructor(opts: HttpClientOptions) {
    this.backendURL = opts.backendURL.replace(/\/+$/, '');
    this.authToken = opts.authToken;
    this.fetchImpl =
      opts.fetchImpl ??
      (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined as never);
    this.websocketImpl = opts.websocketImpl ?? (globalThis.WebSocket as unknown as typeof WebSocket);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.authToken) h['Authorization'] = `Bearer ${this.authToken}`;
    return h;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.backendURL}${path}`, {
      ...init,
      headers: this.headers(init?.headers as Record<string, string> | undefined),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Chat API ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${body}`);
    }
    return (await res.json()) as T;
  }

  listChannels(): Promise<Channel[]> {
    return this.request<Channel[]>('/api/chat/channels');
  }

  createChannel(input: CreateChannelInput): Promise<Channel> {
    return this.request<Channel>('/api/chat/channels', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  listMessages(channelId: string, opts: { cursor?: string; limit?: number } = {}): Promise<MessagePage> {
    const qs = new URLSearchParams();
    if (opts.cursor) qs.set('cursor', opts.cursor);
    if (opts.limit) qs.set('limit', String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.request<MessagePage>(
      `/api/chat/channels/${encodeURIComponent(channelId)}/messages${suffix}`,
    );
  }

  sendMessage(channelId: string, input: SendMessageInput): Promise<Message> {
    return this.request<Message>(
      `/api/chat/channels/${encodeURIComponent(channelId)}/messages`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }

  getAgentPresence(agentId: string): Promise<AgentPresence> {
    return this.request<AgentPresence>(`/api/chat/presence/${encodeURIComponent(agentId)}`);
  }

  subscribeToChannel(
    channelId: string,
    onEvent: (event: ChatWebsocketEvent) => void,
  ): ChannelSubscription {
    // Convert `http(s)://host` → `ws(s)://host`.
    const wsUrl = this.backendURL.replace(/^http/, 'ws');
    const qs = new URLSearchParams({ channelId });
    if (this.authToken) qs.set('token', this.authToken);
    const socket = new this.websocketImpl(`${wsUrl}/ws/chat?${qs.toString()}`);

    const handleMessage = (ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ChatWebsocketEvent;
        onEvent(parsed);
      } catch {
        // Malformed frames are ignored — the server owns the contract.
      }
    };
    socket.addEventListener('message', handleMessage);

    return {
      unsubscribe: () => {
        try {
          socket.removeEventListener('message', handleMessage);
          if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
            socket.close();
          }
        } catch {
          // Swallow — closing a socket that is already closing should not throw.
        }
      },
    };
  }
}
