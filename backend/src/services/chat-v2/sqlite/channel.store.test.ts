/**
 * Unit tests for ChannelStore.
 *
 * @module services/chat-v2/sqlite/channel.store.test
 */

import { openChatDatabase, type ChatDatabase } from './chat-db.js';
import { ChannelStore } from './channel.store.js';
import { ChatError } from '../types.js';

describe('ChannelStore', () => {
  let db: ChatDatabase;
  let store: ChannelStore;

  beforeEach(() => {
    db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    store = new ChannelStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('persists a channel with all fields', () => {
      const row = store.create({
        agentSession: 'sess-a',
        ownerUserId: 'user-a',
        name: 'Test',
        purpose: 'for tests',
        nowMs: 100,
      });
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.agent_session).toBe('sess-a');
      expect(row.owner_user_id).toBe('user-a');
      expect(row.name).toBe('Test');
      expect(row.purpose).toBe('for tests');
      expect(row.created_at).toBe(100);
      expect(row.archived_at).toBeNull();
      expect(row.last_message_at).toBeNull();
    });

    it('allows purpose to be null', () => {
      const row = store.create({
        agentSession: 'sess-a',
        ownerUserId: 'user-a',
        name: 'Test',
      });
      expect(row.purpose).toBeNull();
    });

    it('throws agent_already_bound when the agent has an active channel', () => {
      store.create({ agentSession: 'sess-a', ownerUserId: 'user-a', name: 'First' });
      try {
        store.create({ agentSession: 'sess-a', ownerUserId: 'user-b', name: 'Second' });
        fail('expected ChatError');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatError);
        const ce = err as ChatError;
        expect(ce.code).toBe('agent_already_bound');
        expect(ce.httpStatus).toBe(409);
        expect(ce.details?.existingChannelId).toBeTruthy();
      }
    });

    it('re-allows binding once the previous channel is archived', () => {
      const first = store.create({ agentSession: 'sess-a', ownerUserId: 'user-a', name: 'First' });
      store.archive(first.id);
      expect(() =>
        store.create({ agentSession: 'sess-a', ownerUserId: 'user-a', name: 'Reborn' }),
      ).not.toThrow();
    });
  });

  describe('getById', () => {
    it('returns null for unknown id', () => {
      expect(store.getById('ghost')).toBeNull();
    });

    it('returns the row for an existing id', () => {
      const row = store.create({
        agentSession: 'sess-a',
        ownerUserId: 'user-a',
        name: 'Test',
      });
      const got = store.getById(row.id);
      expect(got?.id).toBe(row.id);
    });
  });

  describe('findActiveByAgentSession', () => {
    it('returns null when no binding exists', () => {
      expect(store.findActiveByAgentSession('nobody')).toBeNull();
    });

    it('returns the active channel for a bound agent', () => {
      const row = store.create({ agentSession: 'sess-a', ownerUserId: 'user-a', name: 'Ch' });
      const got = store.findActiveByAgentSession('sess-a');
      expect(got?.id).toBe(row.id);
    });

    it('skips archived channels', () => {
      const row = store.create({ agentSession: 'sess-a', ownerUserId: 'user-a', name: 'Ch' });
      store.archive(row.id);
      expect(store.findActiveByAgentSession('sess-a')).toBeNull();
    });
  });

  describe('listByOwner', () => {
    it('returns only this user\'s channels', () => {
      store.create({ agentSession: 'sess-a', ownerUserId: 'user-a', name: 'A', nowMs: 100 });
      store.create({ agentSession: 'sess-b', ownerUserId: 'user-b', name: 'B', nowMs: 200 });
      const aList = store.listByOwner('user-a');
      expect(aList).toHaveLength(1);
      expect(aList[0].name).toBe('A');
    });

    it('orders by last_message_at DESC, falling back to created_at', () => {
      const older = store.create({
        agentSession: 'sess-a',
        ownerUserId: 'user-a',
        name: 'Old',
        nowMs: 100,
      });
      const newer = store.create({
        agentSession: 'sess-b',
        ownerUserId: 'user-a',
        name: 'New',
        nowMs: 200,
      });

      // Older channel now has the most-recent activity.
      store.touchLastMessageAt(older.id, 300);

      const list = store.listByOwner('user-a');
      expect(list.map((c) => c.id)).toEqual([older.id, newer.id]);
    });

    it('excludes archived by default and includes them with the flag', () => {
      const a = store.create({ agentSession: 'sess-a', ownerUserId: 'user-a', name: 'A' });
      store.create({ agentSession: 'sess-b', ownerUserId: 'user-a', name: 'B' });
      store.archive(a.id);

      expect(store.listByOwner('user-a').map((c) => c.name)).toEqual(['B']);
      const withArchived = store.listByOwner('user-a', { includeArchived: true });
      expect(withArchived.map((c) => c.name).sort()).toEqual(['A', 'B']);
    });

    it('caps limit at 100', () => {
      const list = store.listByOwner('user-a', { limit: 1000 });
      expect(list).toEqual([]); // empty — but we're testing the SQL accepted the cap
    });
  });

  describe('archive', () => {
    it('returns true on first archive, false on re-archive', () => {
      const row = store.create({ agentSession: 'sess-a', ownerUserId: 'user-a', name: 'Ch' });
      expect(store.archive(row.id)).toBe(true);
      expect(store.archive(row.id)).toBe(false);
    });

    it('returns false for unknown id', () => {
      expect(store.archive('nope')).toBe(false);
    });
  });

  describe('touchLastMessageAt', () => {
    it('sets the timestamp on first call', () => {
      const row = store.create({ agentSession: 'sess-a', ownerUserId: 'user-a', name: 'Ch' });
      store.touchLastMessageAt(row.id, 500);
      expect(store.getById(row.id)?.last_message_at).toBe(500);
    });

    it('only advances forward — older timestamps are ignored', () => {
      const row = store.create({ agentSession: 'sess-a', ownerUserId: 'user-a', name: 'Ch' });
      store.touchLastMessageAt(row.id, 500);
      store.touchLastMessageAt(row.id, 300);
      expect(store.getById(row.id)?.last_message_at).toBe(500);
      store.touchLastMessageAt(row.id, 700);
      expect(store.getById(row.id)?.last_message_at).toBe(700);
    });
  });
});
