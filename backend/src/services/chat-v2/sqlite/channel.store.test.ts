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
      // Phase A defaults: omitted type defaults to 'dm'; team/project/target null.
      expect(row.type).toBe('dm');
      expect(row.team_id).toBeNull();
      expect(row.project_id).toBeNull();
      expect(row.target_member_id).toBeNull();
    });

    it('persists Phase A fields: type=channel, team_id, project_id', () => {
      const row = store.create({
        agentSession: '',
        ownerUserId: 'user-a',
        name: '#general',
        type: 'channel',
        teamId: 'team-1',
        projectId: 'proj-x',
      });
      expect(row.type).toBe('channel');
      expect(row.team_id).toBe('team-1');
      expect(row.project_id).toBe('proj-x');
      expect(row.target_member_id).toBeNull();
      // Channel-typed rows carry an empty agent_session sentinel.
      expect(row.agent_session).toBe('');
    });

    it('persists target_member_id for type=dm rows', () => {
      const row = store.create({
        agentSession: 'sess-sam',
        ownerUserId: 'user-a',
        name: 'DM with Sam',
        targetMemberId: 'member-sam-uuid',
      });
      expect(row.type).toBe('dm');
      expect(row.target_member_id).toBe('member-sam-uuid');
    });

    it('allows multiple type=channel rows to share the empty agent_session', () => {
      // The dm-scoped partial unique index excludes type='channel' rows.
      expect(() =>
        store.create({
          agentSession: '',
          ownerUserId: 'user-a',
          name: '#general',
          type: 'channel',
          teamId: 'team-1',
        }),
      ).not.toThrow();
      expect(() =>
        store.create({
          agentSession: '',
          ownerUserId: 'user-a',
          name: '#general',
          type: 'channel',
          teamId: 'team-2',
        }),
      ).not.toThrow();
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

    it('Phase A: ignores type=channel rows even when agent_session matches', () => {
      // Create a type='channel' row with a non-empty agent_session (edge
      // case — service layer would normally pass ''). The dm-scoped lookup
      // must NOT return it since channel rows aren't 1:1-bound to agents.
      store.create({
        agentSession: 'sess-shared',
        ownerUserId: 'user-a',
        name: '#shared',
        type: 'channel',
        teamId: 'team-1',
      });
      expect(store.findActiveByAgentSession('sess-shared')).toBeNull();

      // After the channel row, a real DM with the same session is still
      // findable — the lookup correctly distinguishes by type.
      const dm = store.create({
        agentSession: 'sess-shared',
        ownerUserId: 'user-a',
        name: 'DM',
      });
      expect(store.findActiveByAgentSession('sess-shared')?.id).toBe(dm.id);
    });
  });

  describe('findActiveDmByOwnerAndAgent', () => {
    it('returns null when no DM exists for the (owner, agent) pair', () => {
      expect(store.findActiveDmByOwnerAndAgent('user-a', 'sess-x')).toBeNull();
    });

    it('returns the active DM matching both owner and agentSession', () => {
      const dm = store.create({
        agentSession: 'sess-a',
        ownerUserId: 'user-a',
        name: 'A',
      });
      const got = store.findActiveDmByOwnerAndAgent('user-a', 'sess-a');
      expect(got?.id).toBe(dm.id);
    });

    it('ignores rows owned by a different user', () => {
      store.create({ agentSession: 'sess-a', ownerUserId: 'user-a', name: 'A' });
      expect(store.findActiveDmByOwnerAndAgent('user-b', 'sess-a')).toBeNull();
    });

    it('ignores archived rows', () => {
      const dm = store.create({
        agentSession: 'sess-a',
        ownerUserId: 'user-a',
        name: 'A',
      });
      store.archive(dm.id);
      expect(store.findActiveDmByOwnerAndAgent('user-a', 'sess-a')).toBeNull();
    });

    it('ignores type=channel rows', () => {
      store.create({
        agentSession: 'sess-shared',
        ownerUserId: 'user-a',
        name: '#shared',
        type: 'channel',
        teamId: 'team-1',
      });
      expect(store.findActiveDmByOwnerAndAgent('user-a', 'sess-shared')).toBeNull();
    });

    it('prefers the most-recently-active DM when multiple rows exist', () => {
      // Multiple DMs for the same (owner, agent) are possible after the
      // unique-index drop; the helper must return the freshest one so the
      // /agents page lands on the channel the user was last using.
      const older = store.create({
        agentSession: 'sess-a',
        ownerUserId: 'user-a',
        name: 'older',
        nowMs: 1000,
      });
      const newer = store.create({
        agentSession: 'sess-a',
        ownerUserId: 'user-a',
        name: 'newer',
        nowMs: 2000,
      });
      const got = store.findActiveDmByOwnerAndAgent('user-a', 'sess-a');
      // Newer row should win — both rows are unarchived, COALESCE(last_message_at,created_at)
      // picks created_at since neither has had a message; created_at=2000 > 1000.
      expect(got?.id).toBe(newer.id);
      // older row is still present (we don't touch it).
      expect(store.getById(older.id)).not.toBeNull();
    });
  });

  describe('findActiveChannelByTeam', () => {
    it('returns null when the team has no channel', () => {
      expect(store.findActiveChannelByTeam('team-x')).toBeNull();
    });

    it('returns the active team channel matching the teamId', () => {
      const ch = store.create({
        agentSession: '',
        ownerUserId: 'user-a',
        name: '#general',
        type: 'channel',
        teamId: 'team-1',
      });
      expect(store.findActiveChannelByTeam('team-1')?.id).toBe(ch.id);
    });

    it('ignores DM rows and channels of other teams', () => {
      store.create({ agentSession: 'sess-a', ownerUserId: 'user-a', name: 'DM' });
      store.create({
        agentSession: '',
        ownerUserId: 'user-a',
        name: '#other',
        type: 'channel',
        teamId: 'team-2',
      });
      expect(store.findActiveChannelByTeam('team-1')).toBeNull();
    });

    it('ignores archived channels', () => {
      const ch = store.create({
        agentSession: '',
        ownerUserId: 'user-a',
        name: '#general',
        type: 'channel',
        teamId: 'team-1',
      });
      store.archive(ch.id);
      expect(store.findActiveChannelByTeam('team-1')).toBeNull();
    });

    it('returns the oldest channel when a team has several', () => {
      const first = store.create({
        agentSession: '',
        ownerUserId: 'user-a',
        name: '#general',
        type: 'channel',
        teamId: 'team-1',
        nowMs: 1000,
      });
      store.create({
        agentSession: '',
        ownerUserId: 'user-a',
        name: '#random',
        type: 'channel',
        teamId: 'team-1',
        nowMs: 2000,
      });
      expect(store.findActiveChannelByTeam('team-1')?.id).toBe(first.id);
    });
  });

  describe('listBridged', () => {
    it('returns active slack-prefixed channels regardless of owner', () => {
      store.create({
        id: 'slack-D0-1',
        agentSession: 'crewly-orc',
        ownerUserId: 'system',
        name: 'slack-D0-1',
        type: 'dm',
      });
      store.create({ agentSession: 'sess-a', ownerUserId: 'user-a', name: 'DM' });
      expect(store.listBridged().map((r) => r.id)).toEqual(['slack-D0-1']);
    });

    it('skips archived bridged channels', () => {
      const row = store.create({
        id: 'slack-D0-2',
        agentSession: 'crewly-orc',
        ownerUserId: 'system',
        name: 'slack-D0-2',
        type: 'dm',
      });
      store.archive(row.id);
      expect(store.listBridged()).toHaveLength(0);
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

    // Phase C — channel-rail listing refinements: type + teamId filters.
    describe('Phase C filters', () => {
      beforeEach(() => {
        // Mixed fixture: two DMs + two team channels across two teams.
        store.create({
          agentSession: 'sess-dm-1',
          ownerUserId: 'user-a',
          name: 'DM with Sam',
          type: 'dm',
          targetMemberId: 'sam-id',
          nowMs: 100,
        });
        store.create({
          agentSession: 'sess-dm-2',
          ownerUserId: 'user-a',
          name: 'DM with Leo',
          type: 'dm',
          targetMemberId: 'leo-id',
          nowMs: 200,
        });
        store.create({
          agentSession: '',
          ownerUserId: 'user-a',
          name: '#general-product',
          type: 'channel',
          teamId: 'team-product',
          nowMs: 300,
        });
        store.create({
          agentSession: '',
          ownerUserId: 'user-a',
          name: '#general-marketing',
          type: 'channel',
          teamId: 'team-marketing',
          nowMs: 400,
        });
      });

      it('filters to DMs when type=dm', () => {
        const list = store.listByOwner('user-a', { type: 'dm' });
        expect(list.map((c) => c.name).sort()).toEqual(['DM with Leo', 'DM with Sam']);
      });

      it('filters to team channels when type=channel', () => {
        const list = store.listByOwner('user-a', { type: 'channel' });
        expect(list.map((c) => c.name).sort()).toEqual([
          '#general-marketing',
          '#general-product',
        ]);
      });

      it('filters to a single team when teamId is set', () => {
        const list = store.listByOwner('user-a', { teamId: 'team-product' });
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe('#general-product');
        expect(list[0].team_id).toBe('team-product');
      });

      it('teamId filter excludes DMs (which have null team_id)', () => {
        // Even though both DMs are owned by user-a, none has team_id='team-product'
        // so the SQL `team_id = ?` predicate (NULL-rejecting) filters them out.
        const list = store.listByOwner('user-a', { teamId: 'team-product' });
        expect(list.every((c) => c.type === 'channel')).toBe(true);
      });

      it('composes type + teamId filters (AND semantics)', () => {
        const list = store.listByOwner('user-a', {
          type: 'channel',
          teamId: 'team-marketing',
        });
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe('#general-marketing');
      });

      it('returns no rows when teamId has no match', () => {
        const list = store.listByOwner('user-a', { teamId: 'team-does-not-exist' });
        expect(list).toEqual([]);
      });

      it('falls back to all rows when no filters set (back-compat)', () => {
        const list = store.listByOwner('user-a');
        expect(list).toHaveLength(4);
      });
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
