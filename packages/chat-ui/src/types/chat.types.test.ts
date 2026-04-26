import { describe, it, expect } from 'vitest';
import type {
  AgentPresenceStatus,
  Channel,
  Message,
  ChatWebsocketEvent,
} from './chat.types';

/**
 * Type-level smoke tests. These don't exercise runtime behavior (the file
 * exports only types) but they lock the contract so accidental renames
 * fail the build.
 */
describe('chat.types', () => {
  it('AgentPresenceStatus accepts the three documented values', () => {
    const online: AgentPresenceStatus = 'online';
    const busy: AgentPresenceStatus = 'busy';
    const offline: AgentPresenceStatus = 'offline';
    expect([online, busy, offline]).toEqual(['online', 'busy', 'offline']);
  });

  it('Channel shape is constructable with the minimal fields', () => {
    const ch: Channel = {
      id: 'c1',
      agentSession: 'crewly-foo',
      name: 'Foo',
      createdAt: new Date().toISOString(),
    };
    expect(ch.id).toBe('c1');
  });

  it('Message shape round-trips through JSON', () => {
    const msg: Message = {
      id: 'm1',
      channelId: 'c1',
      seq: 1,
      author: { role: 'user', id: 'u1', name: 'Steve' },
      content: 'hello',
      createdAt: new Date().toISOString(),
      mentions: [],
    };
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });

  it('Message accepts optimistic-send fields', () => {
    const pending: Message = {
      id: 'cmid-1',
      channelId: 'c1',
      seq: -1,
      author: { role: 'user', id: 'me' },
      content: 'hi',
      createdAt: new Date().toISOString(),
      clientMessageId: 'cmid-1',
      deliveryStatus: 'pending',
      mentions: [],
    };
    expect(pending.deliveryStatus).toBe('pending');
    expect(pending.clientMessageId).toBe('cmid-1');
  });

  // Phase B (SEALED §3.2) — mentions array + threadId.
  it('Message carries mentions: string[] (never null on the wire)', () => {
    const tagged: Message = {
      id: 'm-tagged',
      channelId: 'c1',
      seq: 5,
      author: { role: 'user', id: 'u1' },
      content: '@team-product help',
      createdAt: new Date().toISOString(),
      mentions: ['team-product', 'agent-sam'],
    };
    expect(tagged.mentions).toEqual(['team-product', 'agent-sam']);
    // Round-trips losslessly so consumers can rely on `.mentions` always
    // being an array, never null.
    const round = JSON.parse(JSON.stringify(tagged)) as Message;
    expect(round.mentions).toEqual(tagged.mentions);
  });

  it('Message accepts threadId for Slack-style threaded replies', () => {
    const reply: Message = {
      id: 'm-reply',
      channelId: 'c1',
      seq: 6,
      author: { role: 'user', id: 'u1' },
      content: 'in-thread reply',
      createdAt: new Date().toISOString(),
      mentions: [],
      threadId: 'm-root',
    };
    expect(reply.threadId).toBe('m-root');
  });

  it('ChatWebsocketEvent discriminates message events with channelId + message', () => {
    const e: ChatWebsocketEvent = {
      type: 'message',
      channelId: 'c1',
      message: {
        id: 'm1',
        channelId: 'c1',
        seq: 5,
        author: { role: 'agent', id: 'crewly-foo' },
        content: 'hi back',
        createdAt: new Date().toISOString(),
        mentions: [],
      },
    };
    if (e.type === 'message') {
      expect(e.channelId).toBe('c1');
      expect(e.message.author.role).toBe('agent');
    }
  });

  it('ChatWebsocketEvent discriminates presence events with agentSession + status', () => {
    const e: ChatWebsocketEvent = {
      type: 'presence',
      agentSession: 'crewly-foo',
      status: 'online',
    };
    if (e.type === 'presence') {
      expect(e.agentSession).toBe('crewly-foo');
      expect(e.status).toBe('online');
    }
  });

  it('ChatWebsocketEvent discriminates pong events', () => {
    const e: ChatWebsocketEvent = { type: 'pong', ts: 1234 };
    if (e.type === 'pong') {
      expect(e.ts).toBe(1234);
    }
  });

  it('ChatWebsocketEvent discriminates error events', () => {
    const e: ChatWebsocketEvent = {
      type: 'error',
      code: 'unauthorized',
      message: 'token expired',
    };
    if (e.type === 'error') {
      expect(e.code).toBe('unauthorized');
    }
  });
});
