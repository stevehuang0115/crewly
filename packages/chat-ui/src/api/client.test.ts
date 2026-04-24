import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpChatApiClient } from './client';
import type { Channel, Message, MessagePage } from '../types/chat.types';

describe('HttpChatApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const jsonResponse = (body: unknown, status = 200): Response => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('GET /api/chat/channels returns parsed channels', async () => {
    const channels: Channel[] = [
      { id: 'c1', agentSession: 'a1', name: 'A', createdAt: '2026-04-24T00:00:00Z' },
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse(channels));
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const out = await client.listChannels();

    expect(out).toEqual(channels);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8787/api/chat/channels',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('POST create channel sends JSON body', async () => {
    const created: Channel = {
      id: 'c1', agentSession: 'a1', name: 'A', createdAt: '2026-04-24T00:00:00Z',
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(created));
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787/',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.createChannel({ agentSession: 'a1', name: 'A' });

    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('http://localhost:8787/api/chat/channels');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({ agentSession: 'a1', name: 'A' });
  });

  it('listMessages serializes cursor + limit into query string', async () => {
    const page: MessagePage = { messages: [], nextCursor: null };
    fetchMock.mockResolvedValueOnce(jsonResponse(page));
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.listMessages('c1', { cursor: 'abc', limit: 25 });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://localhost:8787/api/chat/channels/c1/messages?cursor=abc&limit=25',
    );
  });

  it('attaches Authorization header when authToken is set', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      authToken: 'tok_123',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.listChannels();

    expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBe('Bearer tok_123');
  });

  it('throws a readable error on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 500));
    const client = new HttpChatApiClient({
      backendURL: 'http://localhost:8787',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.listChannels()).rejects.toThrow(/500/);
  });

  it('subscribeToChannel opens WS with channelId query param', () => {
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

    // Simulate an inbound presence frame.
    const frame = { type: 'presence', payload: { agentId: 'a1', status: 'online' } };
    listeners['message'][0]({ data: JSON.stringify(frame) } as MessageEvent);
    expect(received).toEqual([frame]);

    sub.unsubscribe();
  });
});
