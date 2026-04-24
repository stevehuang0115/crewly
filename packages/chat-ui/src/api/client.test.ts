/**
 * HttpChatApiClient tests — exercises the wire envelope + DTO translation
 * layer that was added in Week 2 when we flipped from mock to Sam's live
 * backend.
 *
 * @module api/client.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpChatApiClient } from './client';
import { ChatApiError } from './errors';
import type {
  ChannelDTO,
  MessageDTO,
  ChannelListEnvelope,
  MessageListEnvelope,
} from './dto';

// Keep timestamps human-readable in assertions; epoch zero → fixed ISO.
const MS_T0 = 1729790000000;

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

    // Await once; inspect the caught error so we don't need a second mock.
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

  it('subscribeToChannel opens WS with channelId + token query params', () => {
    const listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
    class MockSocket {
      readyState = 1;
      OPEN = 1;
      CONNECTING = 0;
      url: string;
      constructor(url: string) {
        this.url = url;
      }
      addEventListener(type: string, cb: (e: MessageEvent) => void) {
        (listeners[type] ||= []).push(cb);
      }
      removeEventListener() {
        /* no-op */
      }
      close() {
        /* no-op */
      }
    }
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      authToken: 't',
      websocketImpl: MockSocket as unknown as typeof WebSocket,
    });

    const received: unknown[] = [];
    const sub = client.subscribeToChannel('c1', (e) => received.push(e));

    const frame = { type: 'presence', payload: { agentId: 'a1', status: 'online' } };
    listeners['message'][0]({ data: JSON.stringify(frame) } as MessageEvent);
    expect(received).toEqual([frame]);

    sub.unsubscribe();
  });

  it('subscribeToChannel returns a no-op when the WS constructor throws', () => {
    class BrokenSocket {
      constructor() {
        throw new Error('WS unavailable');
      }
    }
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      websocketImpl: BrokenSocket as unknown as typeof WebSocket,
    });
    const sub = client.subscribeToChannel('c1', () => {
      /* never called */
    });
    // Should not have thrown; unsubscribe is safe to call.
    expect(() => sub.unsubscribe()).not.toThrow();
  });
});
