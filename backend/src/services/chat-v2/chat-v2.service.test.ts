/**
 * Tests for ChatV2Service — wire of stores + authorization + DTO mapping.
 *
 * @module services/chat-v2/chat-v2.service.test
 */

import { ChatV2Service } from './chat-v2.service.js';
import { openChatDatabase, type ChatDatabase } from './sqlite/chat-db.js';
import { loadChatV2Config } from './config.js';
import { ChatError, type ChatPrincipal } from './types.js';

describe('ChatV2Service', () => {
  let db: ChatDatabase;
  let service: ChatV2Service;

  const owner: ChatPrincipal = { userId: 'user-a', source: 'oss' };
  const otherUser: ChatPrincipal = { userId: 'user-b', source: 'oss' };
  const agentPrincipal: ChatPrincipal = {
    userId: 'agent-principal', // distinct so we can see agent path vs owner path
    agentSession: 'sess-a',
    source: 'oss',
  };

  beforeEach(() => {
    db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    service = new ChatV2Service({
      config: loadChatV2Config({}),
      db,
      getPresence: () => ({ status: 'online', lastSeenAt: 1234 }),
      now: () => 1000,
    });
  });

  afterEach(() => {
    service.close();
  });

  function createSam() {
    return service.createChannel({
      agentSession: 'sess-a',
      name: 'Sam backend',
      principal: owner,
    });
  }

  // -------------------------------------------------------------------------
  // createChannel
  // -------------------------------------------------------------------------

  describe('createChannel', () => {
    it('creates a channel owned by the caller, ignoring any client-supplied owner', () => {
      const dto = createSam();
      expect(dto.agentSession).toBe('sess-a');
      expect(dto.name).toBe('Sam backend');
      expect(dto.agentPresence.status).toBe('online');
      expect(dto.agentPresence.lastSeenAt).toBe(1234);
    });

    it.each([
      ['', 'name is required'],
      ['   ', 'name is required'],
    ])('rejects blank name %s', (name, errMsg) => {
      expect(() =>
        service.createChannel({ agentSession: 'sess-a', name, principal: owner }),
      ).toThrow(errMsg);
    });

    it('rejects names > config.maxChannelNameChars', () => {
      const long = 'a'.repeat(200);
      expect(() =>
        service.createChannel({ agentSession: 'sess-a', name: long, principal: owner }),
      ).toThrow(/exceeds/);
    });

    it('rejects empty agentSession', () => {
      expect(() =>
        service.createChannel({ agentSession: '   ', name: 'x', principal: owner }),
      ).toThrow(/agentSession is required/);
    });

    it('rejects a second active channel for the same agent (1:1 binding)', () => {
      createSam();
      try {
        service.createChannel({
          agentSession: 'sess-a',
          name: 'Dup',
          principal: owner,
        });
        fail('expected ChatError');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatError);
        expect((err as ChatError).code).toBe('agent_already_bound');
        expect((err as ChatError).httpStatus).toBe(409);
      }
    });

    // -----------------------------------------------------------------------
    // Phase A — type='channel' / Slack-like surfaces (SEALED §3.1)
    // -----------------------------------------------------------------------

    it("Phase A: creates a type='channel' row with teamId; agentSession is server-erased", () => {
      const dto = service.createChannel({
        // Caller may or may not pass agentSession on channel rows; server
        // discards it either way and stores '' as the wire-binding sentinel.
        agentSession: 'whatever-this-is-ignored',
        name: '#general',
        type: 'channel',
        teamId: 'team-1',
        principal: owner,
      });
      expect(dto.type).toBe('channel');
      expect(dto.teamId).toBe('team-1');
      expect(dto.agentSession).toBe('');
    });

    it("Phase A: type='channel' without teamId fails validation", () => {
      try {
        service.createChannel({
          name: '#orphan',
          type: 'channel',
          principal: owner,
        });
        fail('expected ChatError');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatError);
        expect((err as ChatError).code).toBe('validation_error');
        expect((err as ChatError).httpStatus).toBe(400);
        expect((err as ChatError).message).toMatch(/teamId is required/);
      }
    });

    it("Phase A: type='dm' with teamId fails validation (DMs are not team-scoped)", () => {
      expect(() =>
        service.createChannel({
          agentSession: 'sess-a',
          name: 'Cross-typed DM',
          type: 'dm',
          teamId: 'team-1',
          principal: owner,
        }),
      ).toThrow(/teamId must be omitted/);
    });

    it("Phase A: type='channel' with targetMemberId fails validation", () => {
      expect(() =>
        service.createChannel({
          name: '#x',
          type: 'channel',
          teamId: 'team-1',
          targetMemberId: 'member-x',
          principal: owner,
        }),
      ).toThrow(/targetMemberId must be omitted/);
    });

    it("Phase A: type='dm' with targetMemberId persists it", () => {
      const dto = service.createChannel({
        agentSession: 'sess-sam',
        name: 'DM with Sam',
        type: 'dm',
        targetMemberId: 'member-sam-uuid',
        principal: owner,
      });
      expect(dto.targetMemberId).toBe('member-sam-uuid');
      expect(dto.type).toBe('dm');
    });

    it('Phase A: rejects unknown channel type values', () => {
      expect(() =>
        service.createChannel({
          name: 'x',
          // Cast through unknown to escape the typed contract for the test.
          type: 'group' as unknown as 'dm',
          principal: owner,
        }),
      ).toThrow(/unknown channel type/);
    });

    it("Phase A: type='channel' rows allow multiple per team (no 1:1 binding)", () => {
      service.createChannel({
        name: '#general',
        type: 'channel',
        teamId: 'team-1',
        principal: owner,
      });
      // Same owner + same teamId, different name — must NOT trip the
      // dm-scoped unique index. Different team is also fine.
      expect(() =>
        service.createChannel({
          name: '#random',
          type: 'channel',
          teamId: 'team-1',
          principal: owner,
        }),
      ).not.toThrow();
      expect(() =>
        service.createChannel({
          name: '#general',
          type: 'channel',
          teamId: 'team-2',
          principal: owner,
        }),
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // listChannels / getChannel / archiveChannel
  // -------------------------------------------------------------------------

  describe('listChannels', () => {
    it('returns only channels owned by the caller', () => {
      createSam();
      service.createChannel({
        agentSession: 'sess-b',
        name: 'Other owner',
        principal: otherUser,
      });
      expect(service.listChannels({ principal: owner })).toHaveLength(1);
      expect(service.listChannels({ principal: otherUser })).toHaveLength(1);
    });

    // Phase C — channel-rail listing refinements: type + teamId filters.
    describe('Phase C filters', () => {
      function seedMixedFixture() {
        // Owner has: 1 DM + 2 team channels across 2 teams.
        service.createChannel({
          agentSession: 'sess-dm',
          name: 'DM with Sam',
          principal: owner,
          type: 'dm',
          targetMemberId: 'sam-id',
        });
        service.createChannel({
          agentSession: '',
          name: '#general-product',
          principal: owner,
          type: 'channel',
          teamId: 'team-product',
        });
        service.createChannel({
          agentSession: '',
          name: '#general-marketing',
          principal: owner,
          type: 'channel',
          teamId: 'team-marketing',
        });
      }

      it('filters to DMs when type=dm', () => {
        seedMixedFixture();
        const list = service.listChannels({ principal: owner, type: 'dm' });
        expect(list).toHaveLength(1);
        expect(list[0].type).toBe('dm');
        expect(list[0].name).toBe('DM with Sam');
      });

      it('filters to team channels when type=channel', () => {
        seedMixedFixture();
        const list = service.listChannels({ principal: owner, type: 'channel' });
        expect(list).toHaveLength(2);
        expect(list.every((c) => c.type === 'channel')).toBe(true);
      });

      it('rejects unknown type with validation_error', () => {
        seedMixedFixture();
        try {
          service.listChannels({
            principal: owner,
            type: 'group' as unknown as 'dm', // intentionally invalid
          });
          fail('expected ChatError');
        } catch (err) {
          expect(err).toBeInstanceOf(ChatError);
          expect((err as ChatError).code).toBe('validation_error');
          expect((err as ChatError).httpStatus).toBe(400);
          expect((err as ChatError).message).toContain('unknown channel type');
        }
      });

      it('treats blank teamId as omitted (no filter)', () => {
        seedMixedFixture();
        // Empty string teamId should NOT filter to "rows with empty team_id"
        // — that would silently nuke the rail. Instead it's normalized to
        // "no team filter".
        const list = service.listChannels({ principal: owner, teamId: '' });
        expect(list).toHaveLength(3);
      });

      it('treats whitespace-only teamId as omitted (no filter)', () => {
        seedMixedFixture();
        const list = service.listChannels({ principal: owner, teamId: '   ' });
        expect(list).toHaveLength(3);
      });

      it('filters to a single team when teamId is set', () => {
        seedMixedFixture();
        const list = service.listChannels({ principal: owner, teamId: 'team-product' });
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe('#general-product');
        expect(list[0].teamId).toBe('team-product');
      });

      it('teamId filter excludes DMs (which have null team_id at the row level)', () => {
        seedMixedFixture();
        const list = service.listChannels({ principal: owner, teamId: 'team-product' });
        expect(list.every((c) => c.type === 'channel')).toBe(true);
      });

      it('composes type + teamId filters', () => {
        seedMixedFixture();
        const list = service.listChannels({
          principal: owner,
          type: 'channel',
          teamId: 'team-marketing',
        });
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe('#general-marketing');
      });

      it('still scopes to caller-owned rows when filtered (cross-owner isolation)', () => {
        seedMixedFixture();
        // Other user creates an isolated marketing channel. The filtered
        // list for owner must not see it.
        service.createChannel({
          agentSession: '',
          name: '#general-marketing',
          principal: otherUser,
          type: 'channel',
          teamId: 'team-marketing',
        });
        const list = service.listChannels({
          principal: owner,
          type: 'channel',
          teamId: 'team-marketing',
        });
        expect(list).toHaveLength(1); // only owner's row
      });
    });
  });

  describe('getChannel', () => {
    it('returns 404-style error when the caller does not own it', () => {
      const ch = createSam();
      try {
        service.getChannel(ch.id, otherUser);
        fail('expected ChatError');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatError);
        expect((err as ChatError).code).toBe('channel_not_found');
        expect((err as ChatError).httpStatus).toBe(404);
      }
    });

    it('returns the DTO to the owner', () => {
      const ch = createSam();
      const dto = service.getChannel(ch.id, owner);
      expect(dto.id).toBe(ch.id);
    });
  });

  describe('archiveChannel', () => {
    it('archives a channel the caller owns', () => {
      const ch = createSam();
      expect(service.archiveChannel(ch.id, owner)).toBe(true);
      expect(service.archiveChannel(ch.id, owner)).toBe(false);
    });

    it('refuses non-owners', () => {
      const ch = createSam();
      expect(() => service.archiveChannel(ch.id, otherUser)).toThrow(ChatError);
    });
  });

  // -------------------------------------------------------------------------
  // sendMessage
  // -------------------------------------------------------------------------

  describe('sendMessage', () => {
    it('persists a user message with server-assigned sender fields', () => {
      const ch = createSam();
      const msg = service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'hello',
      });
      expect(msg.senderType).toBe('user');
      expect(msg.senderId).toBe(owner.userId);
      expect(msg.seq).toBe(1);
      expect(msg.contentType).toBe('markdown');
    });

    it('persists an agent message when the bound agent calls', () => {
      const ch = createSam();
      const msg = service.sendMessage({
        channelId: ch.id,
        principal: agentPrincipal,
        content: 'agent here',
      });
      expect(msg.senderType).toBe('agent');
      expect(msg.senderId).toBe('sess-a');
    });

    it('rejects messages exceeding the byte cap with payload_too_large', () => {
      const ch = createSam();
      const oversize = 'a'.repeat(40000);
      try {
        service.sendMessage({ channelId: ch.id, principal: owner, content: oversize });
        fail('expected ChatError');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatError);
        expect((err as ChatError).code).toBe('payload_too_large');
        expect((err as ChatError).httpStatus).toBe(413);
      }
    });

    it('rejects empty content', () => {
      const ch = createSam();
      expect(() =>
        service.sendMessage({ channelId: ch.id, principal: owner, content: '' }),
      ).toThrow(/content is required/);
    });

    it('rejects unknown contentType', () => {
      const ch = createSam();
      expect(() =>
        service.sendMessage({
          channelId: ch.id,
          principal: owner,
          content: 'x',
          contentType: 'binary' as never,
        }),
      ).toThrow(/unknown contentType/);
    });

    it('forbids a user from posting system_note', () => {
      const ch = createSam();
      expect(() =>
        service.sendMessage({
          channelId: ch.id,
          principal: owner,
          content: 'admin-ish',
          contentType: 'system_note',
        }),
      ).toThrow(/system_note/);
    });

    it('404s for unknown channel id', () => {
      try {
        service.sendMessage({ channelId: 'missing', principal: owner, content: 'x' });
        fail('expected ChatError');
      } catch (err) {
        expect((err as ChatError).code).toBe('channel_not_found');
      }
    });

    it('forbids non-owner non-agent from posting', () => {
      const ch = createSam();
      try {
        service.sendMessage({ channelId: ch.id, principal: otherUser, content: 'hi' });
        fail('expected ChatError');
      } catch (err) {
        // Not found (rather than 403) to avoid leaking channel existence.
        expect((err as ChatError).code).toBe('channel_not_found');
      }
    });

    it('refuses sends into an archived channel', () => {
      const ch = createSam();
      service.archiveChannel(ch.id, owner);
      try {
        service.sendMessage({ channelId: ch.id, principal: owner, content: 'x' });
        fail('expected ChatError');
      } catch (err) {
        expect((err as ChatError).code).toBe('channel_archived');
      }
    });

    it('dedupes on clientMessageId', () => {
      const ch = createSam();
      const a = service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'x',
        clientMessageId: 'cmid-1',
      });
      const b = service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'x-DIFFERENT',
        clientMessageId: 'cmid-1',
      });
      expect(a.id).toBe(b.id);
      expect(a.seq).toBe(b.seq);
    });

    // -----------------------------------------------------------------------
    // Phase A — mentions + threadId (SEALED §3.2)
    // -----------------------------------------------------------------------

    it('Phase A: persists mentions and emits them on the wire DTO', () => {
      const ch = createSam();
      const dto = service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'pinging @Sam and @team',
        mentions: ['member-sam-uuid', 'team-1'],
      });
      expect(dto.mentions).toEqual(['member-sam-uuid', 'team-1']);
    });

    it('Phase A: empty/omitted mentions yield empty array on the wire (never null)', () => {
      const ch = createSam();
      const omitted = service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'no mentions',
      });
      expect(omitted.mentions).toEqual([]);

      const empty = service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'still no mentions',
        mentions: [],
      });
      expect(empty.mentions).toEqual([]);
    });

    it('Phase A: mentions exceeding the count cap fail validation', () => {
      const ch = createSam();
      const tooMany = Array.from({ length: 51 }, (_, i) => `m-${i}`);
      expect(() =>
        service.sendMessage({
          channelId: ch.id,
          principal: owner,
          content: 'x',
          mentions: tooMany,
        }),
      ).toThrow(/mentions exceeds max count/);
    });

    it('Phase A: rejects non-string mention entries', () => {
      const ch = createSam();
      expect(() =>
        service.sendMessage({
          channelId: ch.id,
          principal: owner,
          content: 'x',
          // Cast through unknown to bypass the typed contract.
          mentions: ['ok', 42 as unknown as string],
        }),
      ).toThrow(/mentions entries must be strings/);
    });

    it('Phase A: rejects mentions that aren’t an array', () => {
      const ch = createSam();
      expect(() =>
        service.sendMessage({
          channelId: ch.id,
          principal: owner,
          content: 'x',
          mentions: 'not-an-array' as unknown as string[],
        }),
      ).toThrow(/mentions must be an array/);
    });

    it('Phase A: persists threadId for replies and emits it on the wire DTO', () => {
      const ch = createSam();
      const root = service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'thread root',
      });
      const reply = service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'reply',
        threadId: root.id,
      });
      expect(reply.threadId).toBe(root.id);
      // Top-level messages omit threadId on the wire.
      expect(root.threadId).toBeUndefined();
    });

    it('Phase A: rejects threadId that does not reference an existing message', () => {
      const ch = createSam();
      expect(() =>
        service.sendMessage({
          channelId: ch.id,
          principal: owner,
          content: 'orphan reply',
          threadId: 'non-existent-id',
        }),
      ).toThrow(/non-existent message/);
    });

    it('Phase A: rejects threadId that references a message in a different channel', () => {
      // Set up two channels owned by the same user. A reply in channel B
      // pointing at a thread root in channel A must be rejected.
      const chA = createSam();
      const chB = service.createChannel({
        agentSession: 'sess-b',
        name: 'Other DM',
        principal: owner,
      });
      const rootInA = service.sendMessage({
        channelId: chA.id,
        principal: owner,
        content: 'root in A',
      });
      expect(() =>
        service.sendMessage({
          channelId: chB.id,
          principal: owner,
          content: 'cross-channel reply',
          threadId: rootInA.id,
        }),
      ).toThrow(/different channel/);
    });
  });

  // -------------------------------------------------------------------------
  // listMessages
  // -------------------------------------------------------------------------

  describe('listMessages', () => {
    it('pages newest-first with cursor continuation', () => {
      const ch = createSam();
      for (let i = 0; i < 7; i++) {
        service.sendMessage({ channelId: ch.id, principal: owner, content: `m${i}` });
      }
      const first = service.listMessages({
        channelId: ch.id,
        principal: owner,
        limit: 3,
      });
      expect(first.messages.map((m) => m.content)).toEqual(['m6', 'm5', 'm4']);
      const second = service.listMessages({
        channelId: ch.id,
        principal: owner,
        limit: 3,
        cursor: first.nextCursor,
      });
      expect(second.messages.map((m) => m.content)).toEqual(['m3', 'm2', 'm1']);
    });

    it('refuses listing a channel the caller doesn\'t own', () => {
      const ch = createSam();
      service.sendMessage({ channelId: ch.id, principal: owner, content: 'x' });
      expect(() =>
        service.listMessages({ channelId: ch.id, principal: otherUser }),
      ).toThrow(ChatError);
    });
  });
});
