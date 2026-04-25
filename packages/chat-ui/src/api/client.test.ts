/**
 * HttpChatApiClient tests — exercises the wire envelope + DTO translation
 * layer plus the Week 2 additions: heartbeat, optimistic emission, and
 * reconnect-with-replay.
 *
 * @module api/client.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpChatApiClient } from './client';
import { ChatApiError } from './errors';
import type {
  ChannelDTO,
  MessageDTO,
  ChannelListEnvelope,
  MessageListEnvelope,
} from './dto';
import type { ChatWebsocketEvent } from '../types/chat.types';

// Keep timestamps human-readable in assertions; epoch zero → fixed ISO.
const MS_T0 = 1729790000000;

/**
 * Test double for the browser `WebSocket`. Records sends, exposes hooks
 * to fire `open`/`message`/`close` synchronously, and tracks how many
 * times the constructor was invoked so reconnect tests can assert on it.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readonly CLOSED = 3;
  readyState = 1;
  url: string;
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Array<(e: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (e: unknown) => void): void {
    (this.listeners[type] ||= []).push(cb);
  }

  removeEventListener(type: string, cb: (e: unknown) => void): void {
    const list = this.listeners[type];
    if (!list) return;
    this.listeners[type] = list.filter((x) => x !== cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = this.CLOSED;
    this.fire('close', {});
  }

  // Helpers used by tests to trigger lifecycle events.
  fire(type: string, ev: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
  open(): void {
    this.readyState = this.OPEN;
    this.fire('open', {});
  }
  receive(frame: unknown): void {
    this.fire('message', { data: JSON.stringify(frame) });
  }
}

describe('HttpChatApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const jsonResponse = (body: unknown, status = 200): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  const successEnvelope = <T>(data: T) => ({ success: true as const, data });

  beforeEach(() => {
    fetchMock = vi.fn();
    FakeSocket.instances = [];
  });

  it('GET /api/chat/channels unwraps the envelope and translates DTOs', async () => {
    const dto: ChannelDTO = {
      id: 'ch-sam',
      agentSession: 'crewly-product-sam',
      name: 'Sam',
      createdAt: MS_T0,
      archivedAt: null,
      agentPresence: { status: 'busy', lastSeenAt: MS_T0 },
    };
    const env: ChannelListEnvelope = { channels: [dto], nextCursor: null };
    fetchMock.mockResolvedValueOnce(jsonResponse(successEnvelope(env)));

    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const channels = await client.listChannels();

    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe('ch-sam');
    expect(channels[0].presence).toBe('busy');
    expect(channels[0].createdAt).toBe(new Date(MS_T0).toISOString());
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://localhost:8787/api/chat/channels',
    );
  });

  it('POST createChannel returns a translated Channel', async () => {
    const dto: ChannelDTO = {
      id: 'ch-new',
      agentSession: 'crewly-new',
      name: 'New',
      createdAt: MS_T0,
      agentPresence: { status: 'online', lastSeenAt: null },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(successEnvelope(dto), 201));

    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787/',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const out = await client.createChannel({ agentSession: 'crewly-new', name: 'New' });

    expect(out.id).toBe('ch-new');
    expect(out.presence).toBe('online');
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('http://localhost:8787/api/chat/channels');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({ agentSession: 'crewly-new', name: 'New' });
  });

  it('listMessages serializes cursor + limit and translates each MessageDTO', async () => {
    const msg: MessageDTO = {
      id: 'm1',
      channelId: 'c1',
      seq: 1,
      senderType: 'user',
      senderId: 'u1',
      content: 'hi',
      contentType: 'markdown',
      createdAt: MS_T0,
      attachments: [],
    };
    const env: MessageListEnvelope = {
      channelId: 'c1',
      messages: [msg],
      nextCursor: null,
      prevCursor: null,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(successEnvelope(env)));

    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const page = await client.listMessages('c1', { cursor: 'abc', limit: 25 });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://localhost:8787/api/chat/channels/c1/messages?cursor=abc&limit=25',
    );
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].author.role).toBe('user');
    expect(page.messages[0].content).toBe('hi');
  });

  it('sendMessage stamps a clientMessageId when caller does not supply one', async () => {
    const msg: MessageDTO = {
      id: 'm1',
      channelId: 'c1',
      seq: 1,
      senderType: 'user',
      senderId: 'u1',
      content: 'hey',
      contentType: 'markdown',
      createdAt: MS_T0,
      attachments: [],
      metadata: { clientMessageId: 'stamped-uuid' },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(successEnvelope(msg), 201));

    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      fetchImpl: fetchMock as unknown as typeof fetch,
      idGenerator: () => 'stamped-uuid',
    });
    await client.sendMessage('c1', { content: 'hey' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.clientMessageId).toBe('stamped-uuid');
    expect(body.content).toBe('hey');
    expect(body.contentType).toBe('markdown');
  });

  it('sendMessage preserves a caller-supplied clientMessageId for idempotent retries', async () => {
    const msg: MessageDTO = {
      id: 'm1',
      channelId: 'c1',
      seq: 1,
      senderType: 'user',
      senderId: 'u1',
      content: 'hey',
      contentType: 'markdown',
      createdAt: MS_T0,
      attachments: [],
      metadata: { clientMessageId: 'caller-id' },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(successEnvelope(msg), 201));

    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await client.sendMessage('c1', { content: 'hey', clientMessageId: 'caller-id' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.clientMessageId).toBe('caller-id');
  });

  it('attaches Authorization header when authToken is set', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(successEnvelope({ channels: [], nextCursor: null })),
    );
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      authToken: 'tok_123',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.listChannels();

    expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBe('Bearer tok_123');
  });

  it('throws ChatApiError with parsed code on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error: {
            code: 'agent_already_bound',
            message: 'Agent is already bound.',
            details: { existingChannelId: 'ch-old' },
          },
        },
        409,
      ),
    );
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.createChannel({ agentSession: 'a', name: 'n' }),
    ).rejects.toMatchObject({
      name: 'ChatApiError',
      code: 'agent_already_bound',
      httpStatus: 409,
    });
  });

  it('wraps network failures into ChatApiError(code=network_error)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket hangup'));
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    let thrown: unknown;
    try {
      await client.listChannels();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ChatApiError);
    expect(thrown).toMatchObject({
      code: 'network_error',
      httpStatus: 0,
      message: 'socket hangup',
    });
  });
});

describe('HttpChatApiClient — WebSocket subscription', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const successEnvelope = <T>(data: T) => ({ success: true as const, data });
  const jsonResponse = (body: unknown, status = 200): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribeToChannel opens WS with channelId + token query params and translates frames', () => {
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      authToken: 't',
      websocketImpl: FakeSocket as unknown as typeof WebSocket,
    });

    const received: ChatWebsocketEvent[] = [];
    const sub = client.subscribeToChannel('c1', (e) => received.push(e));

    expect(FakeSocket.instances.length).toBe(1);
    expect(FakeSocket.instances[0].url).toBe(
      'ws://localhost:8787/ws/chat?channelId=c1&token=t',
    );

    // Fire a presence wire frame; consumer should receive the domain shape.
    FakeSocket.instances[0].receive({
      type: 'presence',
      payload: { agentSession: 'crewly-foo', status: 'online' },
    });
    expect(received).toEqual([
      { type: 'presence', agentSession: 'crewly-foo', status: 'online', lastSeen: undefined },
    ]);

    sub.unsubscribe();
  });

  it('emits a JSON ping every 25s and clears the pong timeout on reply', () => {
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      websocketImpl: FakeSocket as unknown as typeof WebSocket,
      heartbeatIntervalMs: 25_000,
      pongTimeoutMs: 10_000,
      now: () => 1234,
    });
    const sub = client.subscribeToChannel('c1', () => {
      /* noop */
    });
    const sock = FakeSocket.instances[0];
    sock.open();

    vi.advanceTimersByTime(25_000);
    expect(sock.sent).toEqual([JSON.stringify({ type: 'ping', ts: 1234 })]);

    // Pong reply within the 10s window — pong timer should be cleared.
    sock.receive({ type: 'pong', ts: 1234 });
    // Advance another 9.9s; without clearing, the pong timeout would have
    // fired by now and closed the socket.
    vi.advanceTimersByTime(9_900);
    expect(sock.closed).toBe(false);

    sub.unsubscribe();
  });

  it('forces reconnect with ?lastSeenSeq=N when a pong is missed', () => {
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      websocketImpl: FakeSocket as unknown as typeof WebSocket,
      heartbeatIntervalMs: 25_000,
      pongTimeoutMs: 10_000,
      reconnectDelayMs: 1_000,
    });
    const sub = client.subscribeToChannel('c1', () => {
      /* noop */
    });
    const first = FakeSocket.instances[0];
    first.open();

    // Receive a message so we have a non-zero lastSeenSeq.
    first.receive({
      type: 'message',
      payload: {
        channelId: 'c1',
        message: {
          id: 'srv-1',
          channelId: 'c1',
          seq: 5,
          senderType: 'agent',
          senderId: 'crewly-foo',
          content: 'hi',
          contentType: 'markdown',
          createdAt: MS_T0,
          attachments: [],
        },
      },
    });

    // Tick past the ping interval and the pong timeout.
    vi.advanceTimersByTime(25_000); // ping sent
    vi.advanceTimersByTime(10_000); // pong timeout fires → close
    expect(first.closed).toBe(true);

    // Reconnect backoff fires.
    vi.advanceTimersByTime(1_000);

    expect(FakeSocket.instances.length).toBe(2);
    expect(FakeSocket.instances[1].url).toBe(
      'ws://localhost:8787/ws/chat?channelId=c1&lastSeenSeq=5',
    );

    sub.unsubscribe();
  });

  it('emits optimistic pending event before HTTP, then confirmed event with server clientMessageId', async () => {
    vi.useRealTimers(); // async test — fake timers interfere with the awaited fetch
    const dto: MessageDTO = {
      id: 'srv-1',
      channelId: 'c1',
      seq: 9,
      senderType: 'user',
      senderId: 'demo-user',
      content: 'hello',
      contentType: 'markdown',
      createdAt: MS_T0,
      attachments: [],
      metadata: { clientMessageId: 'stamped-cmid' },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(successEnvelope(dto), 201));

    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      fetchImpl: fetchMock as unknown as typeof fetch,
      websocketImpl: FakeSocket as unknown as typeof WebSocket,
      idGenerator: () => 'stamped-cmid',
      currentUser: { id: 'demo-user', name: 'Steve' },
      now: () => MS_T0,
    });

    const events: ChatWebsocketEvent[] = [];
    client.subscribeToChannel('c1', (e) => events.push(e));

    await client.sendMessage('c1', { content: 'hello' });

    // Two `message` events: pending then confirmed.
    const messageEvents = events.filter((e) => e.type === 'message');
    expect(messageEvents).toHaveLength(2);
    if (messageEvents[0].type === 'message' && messageEvents[1].type === 'message') {
      expect(messageEvents[0].message.deliveryStatus).toBe('pending');
      expect(messageEvents[0].message.id).toBe('stamped-cmid');
      expect(messageEvents[0].message.clientMessageId).toBe('stamped-cmid');
      expect(messageEvents[0].message.author).toEqual({
        role: 'user',
        id: 'demo-user',
        name: 'Steve',
      });

      expect(messageEvents[1].message.deliveryStatus).toBe('sent');
      expect(messageEvents[1].message.id).toBe('srv-1');
      expect(messageEvents[1].message.clientMessageId).toBe('stamped-cmid');
      expect(messageEvents[1].message.seq).toBe(9);
    }
  });

  it('emits a failed event if the HTTP send rejects', async () => {
    vi.useRealTimers();
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      fetchImpl: fetchMock as unknown as typeof fetch,
      websocketImpl: FakeSocket as unknown as typeof WebSocket,
      idGenerator: () => 'cmid-1',
      now: () => MS_T0,
    });

    const events: ChatWebsocketEvent[] = [];
    client.subscribeToChannel('c1', (e) => events.push(e));

    await expect(client.sendMessage('c1', { content: 'x' })).rejects.toBeInstanceOf(ChatApiError);

    const messageEvents = events.filter((e) => e.type === 'message');
    expect(messageEvents).toHaveLength(2);
    if (messageEvents[0].type === 'message' && messageEvents[1].type === 'message') {
      expect(messageEvents[0].message.deliveryStatus).toBe('pending');
      expect(messageEvents[1].message.deliveryStatus).toBe('failed');
      expect(messageEvents[1].message.clientMessageId).toBe('cmid-1');
    }
  });

  it('subscribeToChannel survives WS constructor throwing — schedules backoff', () => {
    class BrokenSocket {
      constructor() {
        throw new Error('WS unavailable');
      }
    }
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      websocketImpl: BrokenSocket as unknown as typeof WebSocket,
      reconnectDelayMs: 50,
    });
    const sub = client.subscribeToChannel('c1', () => {
      /* never called */
    });
    // Should not have thrown synchronously; unsubscribe is safe.
    expect(() => sub.unsubscribe()).not.toThrow();
  });
});
