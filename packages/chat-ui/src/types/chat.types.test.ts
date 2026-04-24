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
    };
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });

  it('ChatWebsocketEvent discriminates on type', () => {
    const e: ChatWebsocketEvent = {
      type: 'presence',
      payload: { agentId: 'a1', status: 'online' },
    };
    if (e.type === 'presence') {
      expect(e.payload.agentId).toBe('a1');
    }
  });
});
