/**
 * Unit tests for ChatV2Gateway.
 *
 * These tests exercise the gateway WITHOUT spinning up a real TCP socket
 * by driving `handleConnection()` / `broadcast()` with in-memory fake
 * WebSocket objects. End-to-end coverage through a real WebSocket client
 * lives in the integration test (`chat-v2.gateway.integration.test.ts`).
 *
 * @module websocket/chat-v2.gateway.test
 */

import { EventEmitter } from 'events';
import {
  ChatV2Gateway,
  buildMessageEvent,
  buildPresenceEvent,
  devAnonymousTokenVerifier,
  type ChatWireEvent,
} from './chat-v2.gateway.js';
import type { WebSocket } from 'ws';
import type { ChatV2Service } from '../services/chat-v2/chat-v2.service.js';
import { ChatError, CHAT_ERROR_CODES, type ChatMessageDTO } from '../services/chat-v2/types.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Minimal fake WebSocket that records sends and close calls and exposes
 * the `'message'` / `'close'` event hooks the gateway wires up.
 *
 * We treat `readyState` as always OPEN (1) except after `close()`.
 */
class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly CONNECTING = 0;
  readyState: number = FakeWebSocket.OPEN;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(frame: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('not open');
    this.sent.push(frame);
  }
  close(code?: number, reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.closed = { code, reason };
    this.emit('close', code, Buffer.from(reason ?? ''));
  }
  lastFrame(): ChatWireEvent | null {
    if (this.sent.length === 0) return null;
    return JSON.parse(this.sent[this.sent.length - 1]) as ChatWireEvent;
  }
}

function makeRequest(url: string, host = 'localhost'): { url: string; headers: Record<string, string> } {
  return { url, headers: { host } };
}

function makeService(
  owner: string,
  channelId: string,
  agentSession: string,
): { service: ChatV2Service; calls: { getChannel: number } } {
  const calls = { getChannel: 0 };
  const service = {
    getChannel(id: string, principal: { userId: string }) {
      calls.getChannel++;
      if (id !== channelId) {
        throw new ChatError(CHAT_ERROR_CODES.CHANNEL_NOT_FOUND, 404, 'nope');
      }
      if (principal.userId !== owner) {
        throw new ChatError(CHAT_ERROR_CODES.CHANNEL_NOT_FOUND, 404, 'nope');
      }
      return {
        id: channelId,
        agentSession,
        name: 'demo',
        createdAt: 0,
        agentPresence: { status: 'online', lastSeenAt: null },
      };
    },
  } as unknown as ChatV2Service;
  return { service, calls };
}

function makeMsgDTO(channelId: string, overrides: Partial<ChatMessageDTO> = {}): ChatMessageDTO {
  return {
    id: 'm1',
    channelId,
    seq: 1,
    senderType: 'user',
    senderId: 'u1',
    content: 'hi',
    contentType: 'markdown',
    createdAt: 1_700_000_000_000,
    attachments: [],
    // Phase A (SEALED §3.2) tightened ChatMessageDTO.mentions from
    // optional to required (always emitted; empty array when no mentions).
    // Default the fixture to match so tests don't have to repeat it.
    mentions: [],
    metadata: { clientMessageId: 'cmid-1' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatV2Gateway', () => {
  describe('handleConnection — auth + authorization', () => {
    it('rejects with bad_request when channelId missing', async () => {
      const { service } = makeService('u1', 'c1', 'agent-1');
      const gw = new ChatV2Gateway({ service, verifyToken: devAnonymousTokenVerifier });
      const ws = new FakeWebSocket();
      await gw.handleConnection(ws as unknown as WebSocket, makeRequest('/ws/chat?token=x'));
      expect(ws.closed?.code).toBe(1008);
      expect(ws.lastFrame()).toEqual({
        type: 'error',
        code: 'bad_request',
        message: 'channelId is required',
      });
      expect(gw.subscriberCount('c1')).toBe(0);
    });

    it('rejects with bad_request when lastSeenSeq is non-numeric', async () => {
      const { service } = makeService('u1', 'c1', 'agent-1');
      const gw = new ChatV2Gateway({ service, verifyToken: devAnonymousTokenVerifier });
      const ws = new FakeWebSocket();
      await gw.handleConnection(
        ws as unknown as WebSocket,
        makeRequest('/ws/chat?channelId=c1&lastSeenSeq=abc'),
      );
      expect(ws.lastFrame()).toMatchObject({ type: 'error', code: 'bad_request' });
      expect(ws.closed?.code).toBe(1008);
    });

    it('rejects with unauthorized when verifyToken returns null', async () => {
      const { service } = makeService('u1', 'c1', 'agent-1');
      const gw = new ChatV2Gateway({
        service,
        verifyToken: async () => null,
      });
      const ws = new FakeWebSocket();
      await gw.handleConnection(
        ws as unknown as WebSocket,
        makeRequest('/ws/chat?channelId=c1&token=bad'),
      );
      expect(ws.lastFrame()).toEqual({
        type: 'error',
        code: 'unauthorized',
        message: 'invalid token',
      });
      expect(ws.closed?.code).toBe(1008);
    });

    it('rejects with unauthorized when verifyToken throws', async () => {
      const { service } = makeService('u1', 'c1', 'agent-1');
      const gw = new ChatV2Gateway({
        service,
        verifyToken: async () => {
          throw new Error('jwt expired');
        },
      });
      const ws = new FakeWebSocket();
      await gw.handleConnection(ws as unknown as WebSocket, makeRequest('/ws/chat?channelId=c1'));
      expect(ws.lastFrame()).toMatchObject({ type: 'error', code: 'unauthorized' });
    });

    it('rejects with channel_not_found when user does not own channel', async () => {
      const { service } = makeService('owner', 'c1', 'agent-1');
      const gw = new ChatV2Gateway({
        service,
        verifyToken: async () => ({ userId: 'someone-else' }),
      });
      const ws = new FakeWebSocket();
      await gw.handleConnection(ws as unknown as WebSocket, makeRequest('/ws/chat?channelId=c1'));
      expect(ws.lastFrame()).toEqual({
        type: 'error',
        code: 'channel_not_found',
        message: 'channel not found',
      });
    });

    it('accepts a valid connection and registers the subscriber', async () => {
      const { service, calls } = makeService('u1', 'c1', 'agent-1');
      const gw = new ChatV2Gateway({
        service,
        verifyToken: async () => ({ userId: 'u1' }),
      });
      const ws = new FakeWebSocket();
      await gw.handleConnection(ws as unknown as WebSocket, makeRequest('/ws/chat?channelId=c1&token=abc'));
      expect(ws.closed).toBeNull();
      expect(calls.getChannel).toBe(1);
      expect(gw.subscriberCount('c1')).toBe(1);
      expect(gw.totalSubscribers()).toBe(1);
    });
  });

  describe('broadcast', () => {
    async function makeConnectedGateway() {
      const { service } = makeService('u1', 'c1', 'agent-1');
      const gw = new ChatV2Gateway({
        service,
        verifyToken: async () => ({ userId: 'u1' }),
      });
      const ws = new FakeWebSocket();
      await gw.handleConnection(ws as unknown as WebSocket, makeRequest('/ws/chat?channelId=c1'));
      return { gw, ws };
    }

    it('sends a message frame to all subscribers on the matching channel', async () => {
      const { gw, ws } = await makeConnectedGateway();
      const msg = makeMsgDTO('c1');
      gw.broadcast('c1', buildMessageEvent('c1', msg));
      expect(ws.sent).toHaveLength(1);
      expect(ws.lastFrame()).toEqual({
        type: 'message',
        payload: { channelId: 'c1', message: msg },
      });
    });

    it('sends presence frames with the documented shape', async () => {
      const { gw, ws } = await makeConnectedGateway();
      gw.broadcast('c1', buildPresenceEvent('agent-1', 'online', 1_700_000_000_000));
      expect(ws.lastFrame()).toEqual({
        type: 'presence',
        payload: { agentSession: 'agent-1', status: 'online', lastSeenAt: 1_700_000_000_000 },
      });
    });

    it('does not send to a different channel', async () => {
      const { gw, ws } = await makeConnectedGateway();
      gw.broadcast('DIFFERENT', buildMessageEvent('DIFFERENT', makeMsgDTO('DIFFERENT')));
      expect(ws.sent).toHaveLength(0);
    });

    it('skips closed sockets gracefully', async () => {
      const { gw, ws } = await makeConnectedGateway();
      ws.readyState = FakeWebSocket.CLOSED;
      // Should not throw — the closed socket is silently skipped
      gw.broadcast('c1', buildMessageEvent('c1', makeMsgDTO('c1')));
      expect(ws.sent).toHaveLength(0);
    });

    it('fans out to multiple subscribers on the same channel', async () => {
      const { service } = makeService('u1', 'c1', 'agent-1');
      const gw = new ChatV2Gateway({
        service,
        verifyToken: async () => ({ userId: 'u1' }),
      });
      const ws1 = new FakeWebSocket();
      const ws2 = new FakeWebSocket();
      await gw.handleConnection(ws1 as unknown as WebSocket, makeRequest('/ws/chat?channelId=c1'));
      await gw.handleConnection(ws2 as unknown as WebSocket, makeRequest('/ws/chat?channelId=c1'));
      expect(gw.subscriberCount('c1')).toBe(2);

      gw.broadcast('c1', buildMessageEvent('c1', makeMsgDTO('c1')));
      expect(ws1.sent).toHaveLength(1);
      expect(ws2.sent).toHaveLength(1);
    });

    it('drops the subscriber on close', async () => {
      const { gw, ws } = await makeConnectedGateway();
      ws.close(1000, 'client disconnect');
      expect(gw.subscriberCount('c1')).toBe(0);
    });

    // onBroadcast — external listener registration for Cloud Portal relay
    // adapter. The adapter needs to mirror every broadcast over the Cloud
    // queue, even when there are zero local WebSocket subscribers.
    it('onBroadcast listener fires on every broadcast (even with no WS subscribers)', () => {
      const { service } = makeService('u1', 'c-empty', 'agent-1');
      const gw = new ChatV2Gateway({ service, verifyToken: async () => ({ userId: 'u1' }) });
      const events: Array<{ channelId: string; event: unknown }> = [];
      gw.onBroadcast((channelId, event) => events.push({ channelId, event }));
      // No connected WS clients.
      gw.broadcast('c-empty', buildMessageEvent('c-empty', makeMsgDTO('c-empty')));
      expect(events).toHaveLength(1);
      expect(events[0].channelId).toBe('c-empty');
    });

    it('onBroadcast unsubscribe removes the listener', () => {
      const { service } = makeService('u1', 'c1', 'agent-1');
      const gw = new ChatV2Gateway({ service, verifyToken: async () => ({ userId: 'u1' }) });
      let count = 0;
      const off = gw.onBroadcast(() => {
        count += 1;
      });
      gw.broadcast('c1', buildMessageEvent('c1', makeMsgDTO('c1')));
      expect(count).toBe(1);
      off();
      gw.broadcast('c1', buildMessageEvent('c1', makeMsgDTO('c1')));
      expect(count).toBe(1);
    });

    it('a misbehaving listener does not break the broadcast loop', async () => {
      const { gw, ws } = await makeConnectedGateway();
      gw.onBroadcast(() => {
        throw new Error('listener exploded');
      });
      const events: Array<unknown> = [];
      gw.onBroadcast((_c, ev) => events.push(ev));
      // The thrown listener must not stop the second listener from firing,
      // nor block the local WS broadcast.
      gw.broadcast('c1', buildMessageEvent('c1', makeMsgDTO('c1')));
      expect(events).toHaveLength(1);
      expect(ws.sent).toHaveLength(1);
    });
  });

  describe('handleMessage — ping/pong', () => {
    async function makeConnectedGateway() {
      const { service } = makeService('u1', 'c1', 'agent-1');
      const gw = new ChatV2Gateway({
        service,
        verifyToken: async () => ({ userId: 'u1' }),
      });
      const ws = new FakeWebSocket();
      await gw.handleConnection(ws as unknown as WebSocket, makeRequest('/ws/chat?channelId=c1'));
      return { gw, ws };
    }

    it('echoes a pong with the client-supplied ts', async () => {
      const { ws } = await makeConnectedGateway();
      ws.emit('message', JSON.stringify({ type: 'ping', ts: 42 }));
      expect(ws.lastFrame()).toEqual({ type: 'pong', ts: 42 });
    });

    it('ignores unknown frame types silently', async () => {
      const { ws } = await makeConnectedGateway();
      ws.emit('message', JSON.stringify({ type: 'typing', foo: 'bar' }));
      expect(ws.sent).toHaveLength(0);
    });

    it('ignores malformed JSON silently', async () => {
      const { ws } = await makeConnectedGateway();
      ws.emit('message', 'not-json');
      expect(ws.sent).toHaveLength(0);
    });

    it('accepts ping with missing ts and uses gateway clock', async () => {
      const { service } = makeService('u1', 'c1', 'agent-1');
      const gw = new ChatV2Gateway({
        service,
        verifyToken: async () => ({ userId: 'u1' }),
        now: () => 99,
      });
      const ws = new FakeWebSocket();
      await gw.handleConnection(ws as unknown as WebSocket, makeRequest('/ws/chat?channelId=c1'));
      ws.emit('message', JSON.stringify({ type: 'ping' }));
      expect(ws.lastFrame()).toEqual({ type: 'pong', ts: 99 });
    });
  });

  describe('devAnonymousTokenVerifier', () => {
    it('returns the same userId that requireAuth dev-fallback uses', async () => {
      // Must match require-auth.middleware.ts's dev fallback so channels
      // created via REST are owned by the same id the WS verifies as.
      await expect(devAnonymousTokenVerifier(null)).resolves.toEqual({ userId: 'dev-user-001' });
      await expect(devAnonymousTokenVerifier('anything')).resolves.toEqual({ userId: 'dev-user-001' });
    });
  });

  describe('frame builders', () => {
    it('buildMessageEvent matches the frontend wire parser shape', () => {
      const dto = makeMsgDTO('c1');
      expect(buildMessageEvent('c1', dto)).toEqual({
        type: 'message',
        payload: { channelId: 'c1', message: dto },
      });
    });

    it('buildPresenceEvent defaults lastSeenAt to null when absent', () => {
      expect(buildPresenceEvent('agent-1', 'offline')).toEqual({
        type: 'presence',
        payload: { agentSession: 'agent-1', status: 'offline', lastSeenAt: null },
      });
    });
  });
});
