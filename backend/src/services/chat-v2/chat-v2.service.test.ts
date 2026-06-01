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

    // ---------------------------------------------------------------------
    // F2b (#333) — outer-ring tenant defense via validateTeamMembership
    // ---------------------------------------------------------------------
    describe('F2b validateTeamMembership', () => {
      function makeServiceWithValidator(
        validator: ((p: ChatPrincipal, teamId: string) => boolean) | undefined,
      ) {
        // Each test gets its own isolated DB so it can construct the
        // service with the validator wired without leaking state to the
        // outer beforeEach service.
        const localDb = openChatDatabase({
          dbPath: ':memory:',
          inMemory: true,
          skipIntegrityCheck: true,
        });
        const localService = new ChatV2Service({
          config: loadChatV2Config({}),
          db: localDb,
          getPresence: () => ({ status: 'online', lastSeenAt: 1234 }),
          now: () => 1000,
          validateTeamMembership: validator,
        });
        return { localDb, localService };
      }

      it("permits channel creation when the validator returns true (caller is a member)", () => {
        const validator = jest.fn(
          (_p: ChatPrincipal, teamId: string) => teamId === 'team-allowed',
        );
        const { localDb, localService } = makeServiceWithValidator(validator);
        try {
          const dto = localService.createChannel({
            name: '#general',
            type: 'channel',
            teamId: 'team-allowed',
            principal: owner,
          });
          expect(dto.teamId).toBe('team-allowed');
          // Validator was called exactly once with the principal + teamId.
          expect(validator).toHaveBeenCalledTimes(1);
          expect(validator).toHaveBeenCalledWith(owner, 'team-allowed');
        } finally {
          localService.close();
          localDb.close();
        }
      });

      it('throws forbidden_team (403) when the validator returns false (foreign team)', () => {
        // The Arch-described leak vector at the outer ring: caller binds
        // a channel to a teamId the membership check rejects. Must throw
        // forbidden_team before the row is persisted.
        const validator = jest.fn(() => false);
        const { localDb, localService } = makeServiceWithValidator(validator);
        try {
          let caught: ChatError | null = null;
          try {
            localService.createChannel({
              name: '#leak-attempt',
              type: 'channel',
              teamId: 'team-other-tenant',
              principal: owner,
            });
          } catch (err) {
            caught = err as ChatError;
          }
          expect(caught).toBeInstanceOf(ChatError);
          expect(caught?.code).toBe('forbidden_team');
          expect(caught?.httpStatus).toBe(403);
          expect(caught?.details).toMatchObject({
            teamId: 'team-other-tenant',
            userId: 'user-a',
          });
          // No rows persisted — listChannels for the owner returns 0.
          expect(
            localService.listChannels({ principal: owner }).length,
          ).toBe(0);
          expect(validator).toHaveBeenCalledTimes(1);
        } finally {
          localService.close();
          localDb.close();
        }
      });

      it('does NOT call the validator for type=dm (membership only gates type=channel)', () => {
        const validator = jest.fn(() => false);
        const { localDb, localService } = makeServiceWithValidator(validator);
        try {
          // type='dm' (the default) must remain unaffected by the
          // membership check — DMs have no teamId.
          const dto = localService.createChannel({
            agentSession: 'sess-x',
            name: 'Sam DM',
            principal: owner,
          });
          expect(dto.id).toBeTruthy();
          expect(validator).not.toHaveBeenCalled();
        } finally {
          localService.close();
          localDb.close();
        }
      });

      it('preserves pre-F2b behavior when no validator is wired (back-compat)', () => {
        // The outer beforeEach service does NOT inject a validator, so
        // any previously-passing channel creation must still succeed.
        // Pinning this so a future change doesn't accidentally make the
        // validator mandatory.
        expect(() =>
          service.createChannel({
            name: '#general',
            type: 'channel',
            teamId: 'team-without-validator',
            principal: owner,
          }),
        ).not.toThrow();
      });

      it('regression: blocks the cross-tenant leak vector at channel creation (Arch attack)', () => {
        // Tenant separation: owner is only authorized for their own
        // tenant; any attempt to bind a channel to another tenant's
        // team must reject with forbidden_team.
        const ownTenant = 'tenant-a';
        const validator = jest.fn(
          (_p: ChatPrincipal, teamId: string) => teamId === ownTenant,
        );
        const { localDb, localService } = makeServiceWithValidator(validator);
        try {
          // Allowed.
          expect(() =>
            localService.createChannel({
              name: '#own',
              type: 'channel',
              teamId: ownTenant,
              principal: owner,
            }),
          ).not.toThrow();
          // Blocked at the outer ring (F2a is the inner ring on dispatch).
          expect(() =>
            localService.createChannel({
              name: '#leak',
              type: 'channel',
              teamId: 'tenant-b-stolen',
              principal: owner,
            }),
          ).toThrow(ChatError);
        } finally {
          localService.close();
          localDb.close();
        }
      });
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

    it('surfaces bridged Slack channels the caller does not own', () => {
      // Slack bridge persists under the synthetic 'system' owner.
      service.ensureChannelForLegacyConversation({
        conversationId: 'slack-D0-1',
        agentSession: 'crewly-orc',
      });
      const list = service.listChannels({ principal: owner });
      expect(list.some((c) => c.id === 'slack-D0-1')).toBe(true);
    });

    it('excludes bridged channels when a type filter is applied', () => {
      service.ensureChannelForLegacyConversation({
        conversationId: 'slack-D0-2',
        agentSession: 'crewly-orc',
      });
      const list = service.listChannels({ principal: owner, type: 'channel' });
      expect(list.some((c) => c.id === 'slack-D0-2')).toBe(false);
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
  // listMessages — Slack-style thread reply counts
  // -------------------------------------------------------------------------

  describe('listMessages thread reply counts', () => {
    it('attaches replyCount + lastReplyAt to a root once a reply is posted', () => {
      const ch = createSam();
      const root = service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'thread root',
      });

      // Before any reply: the root carries no reply summary.
      const before = service.listMessages({ channelId: ch.id, principal: owner });
      const rootBefore = before.messages.find((m) => m.id === root.id);
      expect(rootBefore?.replyCount).toBeUndefined();
      expect(rootBefore?.lastReplyAt).toBeUndefined();

      // Post one reply into the thread.
      service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'a reply',
        threadId: root.id,
      });

      // After: the root has replyCount=1 and a populated lastReplyAt; the
      // reply row itself never carries a count.
      const after = service.listMessages({ channelId: ch.id, principal: owner });
      const rootAfter = after.messages.find((m) => m.id === root.id);
      expect(rootAfter?.replyCount).toBe(1);
      expect(typeof rootAfter?.lastReplyAt).toBe('string');
      expect(Number.isNaN(Date.parse(rootAfter!.lastReplyAt!))).toBe(false);

      const replyRow = after.messages.find((m) => m.threadId === root.id);
      expect(replyRow).toBeDefined();
      expect(replyRow?.replyCount).toBeUndefined();
    });

    it('counts multiple replies and tracks the latest reply time', () => {
      const ch = createSam();
      const root = service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'root',
      });
      service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'r1',
        threadId: root.id,
      });
      service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'r2',
        threadId: root.id,
      });
      const page = service.listMessages({ channelId: ch.id, principal: owner });
      const rootDto = page.messages.find((m) => m.id === root.id);
      expect(rootDto?.replyCount).toBe(2);
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

    it('lets any caller READ a shared bridged Slack channel they do not own', () => {
      // Slack bridge persists under the synthetic 'system' owner; the bound
      // agent records the turn. The team-chat surface merges these into the
      // Orchestrator timeline, so a non-owner web user must be able to read them.
      const ch = service.ensureChannelForLegacyConversation({
        conversationId: 'slack-D0-read',
        agentSession: 'crewly-orc',
      });
      const orcAgent: ChatPrincipal = {
        userId: 'orc-agent',
        agentSession: 'crewly-orc',
        source: 'oss',
      };
      service.sendMessage({ channelId: ch.id, principal: orcAgent, content: 'from slack' });
      // `owner` does NOT own this channel ('system' does) yet can read it.
      const page = service.listMessages({ channelId: ch.id, principal: owner });
      expect(page.messages.map((m) => m.content)).toEqual(['from slack']);
    });

    it('still forbids a non-owner from POSTING into a shared Slack channel', () => {
      const ch = service.ensureChannelForLegacyConversation({
        conversationId: 'slack-D0-write',
        agentSession: 'crewly-orc',
      });
      // The read gate now allows shared Slack channels, but resolveSender keeps
      // writes locked to the owner / bound agent → forbidden for a plain user.
      try {
        service.sendMessage({ channelId: ch.id, principal: owner, content: 'nope' });
        fail('expected ChatError');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatError);
        expect((err as ChatError).code).toBe('forbidden');
      }
    });
  });

  // -------------------------------------------------------------------------
  // countAllMessages — Onboarding v3 (B1) cold-start probe
  // -------------------------------------------------------------------------

  describe('countAllMessages (Onboarding v3 — B1)', () => {
    it('returns 0 on a fresh service before any channel exists', () => {
      expect(service.countAllMessages()).toBe(0);
    });

    it('counts messages across the channels owned by every principal', () => {
      // Two channels, two owners, three messages — sum is 3.
      const ch1 = createSam();
      const ch2 = service.createChannel({
        agentSession: 'sess-b',
        name: 'Other Agent',
        principal: otherUser,
      });
      service.sendMessage({ channelId: ch1.id, principal: owner, content: 'a' });
      service.sendMessage({ channelId: ch1.id, principal: owner, content: 'b' });
      service.sendMessage({ channelId: ch2.id, principal: otherUser, content: 'c' });

      expect(service.countAllMessages()).toBe(3);
    });

    it('is callable without an HTTP-request principal (orc bootstrap path)', () => {
      // The orc bootstrap calls this from a closure with no principal —
      // verify there's no implicit auth guard that would throw.
      expect(() => service.countAllMessages()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // recordTurn — canonical server-internal write entry
  // Spec: 2026-05-14-unified-chat-message-store.md (Phase 1)
  // -------------------------------------------------------------------------

  describe('recordTurn', () => {
    it('persists an agent turn and stamps metadata.source', () => {
      const ch = createSam();

      const { message, deduped } = service.recordTurn({
        channelId: ch.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'Hello!',
        metadata: { source: 'in-process-runtime', runtime: 'crewly-agent' },
      });

      expect(deduped).toBe(false);
      expect(message.content).toBe('Hello!');
      expect(message.senderType).toBe('agent');
      expect(message.senderId).toBe('crewly-orc');
      // metadata.source must be carried through to storage — audit trail
      expect(message.metadata).toMatchObject({
        source: 'in-process-runtime',
        runtime: 'crewly-agent',
      });
    });

    it('persists a user turn for Slack inbound', () => {
      const ch = createSam();

      const { message } = service.recordTurn({
        channelId: ch.id,
        senderType: 'user',
        senderId: 'slack-U0XYZ',
        content: 'hi orc',
        metadata: {
          source: 'slack',
          slackChannelId: 'D0AC7',
          slackThreadTs: '1700000000.000111',
        },
      });

      expect(message.senderType).toBe('user');
      expect(message.metadata).toMatchObject({
        source: 'slack',
        slackChannelId: 'D0AC7',
      });
    });

    it('is idempotent via clientMessageId — second call returns deduped=true', () => {
      const ch = createSam();
      const clientId = 'agent-finish-2026-05-14T22:30:00Z';

      const first = service.recordTurn({
        channelId: ch.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'one',
        clientMessageId: clientId,
        metadata: { source: 'in-process-runtime' },
      });
      const second = service.recordTurn({
        channelId: ch.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'one',  // same content
        clientMessageId: clientId,
        metadata: { source: 'in-process-runtime' },
      });

      expect(first.deduped).toBe(false);
      expect(second.deduped).toBe(true);
      expect(second.message.id).toBe(first.message.id);
      expect(service.countAllMessages()).toBe(1);
    });

    it('rejects empty content (400)', () => {
      const ch = createSam();
      expect(() =>
        service.recordTurn({
          channelId: ch.id,
          senderType: 'agent',
          senderId: 'crewly-orc',
          content: '',
          metadata: { source: 'in-process-runtime' },
        }),
      ).toThrow(ChatError);
    });

    it('rejects missing metadata.source (audit trail required)', () => {
      const ch = createSam();
      expect(() =>
        service.recordTurn({
          channelId: ch.id,
          senderType: 'agent',
          senderId: 'crewly-orc',
          content: 'hi',
          // @ts-expect-error — deliberately omitting source to test runtime guard
          metadata: { runtime: 'crewly-agent' },
        }),
      ).toThrow(/metadata\.source is required/);
    });

    it('rejects unknown metadata.source values (closed enum)', () => {
      const ch = createSam();
      expect(() =>
        service.recordTurn({
          channelId: ch.id,
          senderType: 'agent',
          senderId: 'crewly-orc',
          content: 'hi',
          // @ts-expect-error — invalid source string at compile + runtime
          metadata: { source: 'made-up-source' },
        }),
      ).toThrow(/unknown metadata\.source/);
    });

    it('rejects unknown senderType', () => {
      const ch = createSam();
      expect(() =>
        service.recordTurn({
          channelId: ch.id,
          // @ts-expect-error
          senderType: 'robot',
          senderId: 'crewly-orc',
          content: 'hi',
          metadata: { source: 'in-process-runtime' },
        }),
      ).toThrow(/unknown senderType/);
    });

    it('rejects empty senderId', () => {
      const ch = createSam();
      expect(() =>
        service.recordTurn({
          channelId: ch.id,
          senderType: 'agent',
          senderId: '',
          content: 'hi',
          metadata: { source: 'in-process-runtime' },
        }),
      ).toThrow(/senderId is required/);
    });

    it('rejects unknown channelId (channel_not_found)', () => {
      expect(() =>
        service.recordTurn({
          channelId: 'no-such-channel',
          senderType: 'agent',
          senderId: 'crewly-orc',
          content: 'hi',
          metadata: { source: 'in-process-runtime' },
        }),
      ).toThrow(ChatError);
    });

    it('accepts all RECORD_TURN_SOURCES values', () => {
      const ch = createSam();
      const sources = [
        'web',
        'slack',
        'pty-runtime',
        'in-process-runtime',
        'reply-tool',
        'system',
      ] as const;

      for (const source of sources) {
        const { message } = service.recordTurn({
          channelId: ch.id,
          senderType: 'system',
          senderId: 'system',
          content: `msg from ${source}`,
          metadata: { source },
        });
        expect(message.metadata).toMatchObject({ source });
      }

      expect(service.countAllMessages()).toBe(sources.length);
    });

    it('rejects oversized content with payload_too_large', () => {
      const ch = createSam();
      const huge = 'x'.repeat(service.config.maxMessageBytes + 1);

      expect(() =>
        service.recordTurn({
          channelId: ch.id,
          senderType: 'agent',
          senderId: 'crewly-orc',
          content: huge,
          metadata: { source: 'in-process-runtime' },
        }),
      ).toThrow(ChatError);
    });
  });

  // -------------------------------------------------------------------------
  // ensureChannelForLegacyConversation
  // Spec: 2026-05-14-unified-chat-message-store.md Phase 2 (Option B)
  // -------------------------------------------------------------------------

  describe('ensureChannelForLegacyConversation', () => {
    it('creates a fresh channel using the conversationId as the id', () => {
      const ch = service.ensureChannelForLegacyConversation({
        conversationId: 'slack-D0AC7-1700000000.000111',
        agentSession: 'crewly-orc',
      });

      expect(ch.id).toBe('slack-D0AC7-1700000000.000111');
      expect(ch.agentSession).toBe('crewly-orc');
      expect(ch.type).toBe('dm');
    });

    it('is idempotent — second call returns the existing channel', () => {
      const first = service.ensureChannelForLegacyConversation({
        conversationId: 'web-conv-abc',
        agentSession: 'crewly-orc',
      });
      const second = service.ensureChannelForLegacyConversation({
        conversationId: 'web-conv-abc',
        agentSession: 'crewly-orc',
      });

      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
    });

    it('allows the same agent to participate in MANY concurrent channels (the whole point)', () => {
      // This is the post-Option-B contract: no `agent_already_bound`
      // failure on the second / third / Nth channel for the same agent.
      const a = service.ensureChannelForLegacyConversation({
        conversationId: 'slack-thread-1',
        agentSession: 'crewly-orc',
      });
      const b = service.ensureChannelForLegacyConversation({
        conversationId: 'slack-thread-2',
        agentSession: 'crewly-orc',
      });
      const c = service.ensureChannelForLegacyConversation({
        conversationId: 'web-conv-xyz',
        agentSession: 'crewly-orc',
      });

      expect([a.id, b.id, c.id]).toEqual([
        'slack-thread-1',
        'slack-thread-2',
        'web-conv-xyz',
      ]);
    });

    it('feeds directly into recordTurn — combined bridge flow', () => {
      const ch = service.ensureChannelForLegacyConversation({
        conversationId: 'slack-X-1234',
        agentSession: 'crewly-orc',
      });

      const { message, deduped } = service.recordTurn({
        channelId: ch.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'Hello from auto-route',
        metadata: { source: 'in-process-runtime', runtime: 'crewly-agent' },
      });

      expect(deduped).toBe(false);
      expect(message.content).toBe('Hello from auto-route');
      expect(message.senderType).toBe('agent');
    });

    it('defaults ownerUserId to "system" for server-internal callers', () => {
      const ch = service.ensureChannelForLegacyConversation({
        conversationId: 'server-internal-conv',
        agentSession: 'crewly-orc',
      });
      // The DTO doesn't expose ownerUserId directly; we verify via list
      // filter which is scoped by owner.
      const channels = service.listChannels({
        principal: { userId: 'system', source: 'oss' },
      });
      expect(channels.some((c) => c.id === ch.id)).toBe(true);
    });

    it('rejects empty conversationId', () => {
      expect(() =>
        service.ensureChannelForLegacyConversation({
          conversationId: '',
          agentSession: 'crewly-orc',
        }),
      ).toThrow(/conversationId is required/);
    });

    it('rejects empty agentSession', () => {
      expect(() =>
        service.ensureChannelForLegacyConversation({
          conversationId: 'slack-X-1',
          agentSession: '',
        }),
      ).toThrow(/agentSession is required/);
    });
  });

  // -------------------------------------------------------------------------
  // ensureDmChannel — find-or-create for the /agents page
  // -------------------------------------------------------------------------

  describe('ensureDmChannel', () => {
    it('creates a fresh DM channel when none exists', () => {
      const { channel, created } = service.ensureDmChannel({
        agentSession: 'sess-x',
        name: 'Leo',
        principal: owner,
      });
      expect(created).toBe(true);
      expect(channel.agentSession).toBe('sess-x');
      expect(channel.name).toBe('Leo');
      expect(channel.type).toBe('dm');
    });

    it('returns the existing channel on a second call (idempotent)', () => {
      const first = service.ensureDmChannel({
        agentSession: 'sess-x',
        name: 'Leo',
        principal: owner,
      });
      const second = service.ensureDmChannel({
        agentSession: 'sess-x',
        name: 'Leo (renamed)',
        principal: owner,
      });
      expect(second.created).toBe(false);
      expect(second.channel.id).toBe(first.channel.id);
      // We don't auto-rename — the existing row's name wins.
      expect(second.channel.name).toBe('Leo');
    });

    it('scopes find-or-create by ownerUserId — other users get a separate channel', () => {
      // F2b: this matters for Cloud Portal where multiple users share the
      // singleton ChatV2Service. In OSS we always have one user, but the
      // scoping invariant must hold so the same code path works in both.
      const first = service.ensureDmChannel({
        agentSession: 'sess-x',
        name: 'Leo',
        principal: owner,
      });
      const otherOwnerChan = service.ensureDmChannel({
        agentSession: 'sess-x',
        name: 'Leo',
        principal: otherUser,
      });
      expect(otherOwnerChan.created).toBe(true);
      expect(otherOwnerChan.channel.id).not.toBe(first.channel.id);
    });

    it('rejects empty agentSession', () => {
      expect(() =>
        service.ensureDmChannel({ agentSession: '   ', principal: owner }),
      ).toThrow(/agentSession is required/);
    });

    it('falls back to the agentSession as the channel name when no name is provided', () => {
      const { channel, created } = service.ensureDmChannel({
        agentSession: 'sess-y',
        principal: owner,
      });
      expect(created).toBe(true);
      expect(channel.name).toBe('sess-y');
    });
  });

  // -------------------------------------------------------------------------
  // ensureTeamChannel — find-or-create for the consolidated team-chat surface
  // -------------------------------------------------------------------------

  describe('ensureTeamChannel', () => {
    it('creates a default #general channel when the team has none', () => {
      const { channel, created } = service.ensureTeamChannel({
        teamId: 'team-1',
        principal: owner,
      });
      expect(created).toBe(true);
      expect(channel.type).toBe('channel');
      expect(channel.teamId).toBe('team-1');
      expect(channel.name).toBe('#general');
    });

    it('uses a provided name for a freshly created channel', () => {
      const { channel, created } = service.ensureTeamChannel({
        teamId: 'team-2',
        name: '#standup',
        principal: owner,
      });
      expect(created).toBe(true);
      expect(channel.name).toBe('#standup');
    });

    it('is idempotent — returns the existing channel on a second call', () => {
      const first = service.ensureTeamChannel({ teamId: 'team-1', principal: owner });
      const second = service.ensureTeamChannel({
        teamId: 'team-1',
        name: '#ignored',
        principal: owner,
      });
      expect(second.created).toBe(false);
      expect(second.channel.id).toBe(first.channel.id);
      expect(second.channel.name).toBe('#general');
    });

    it('reuses a channel created via the public createChannel path', () => {
      const made = service.createChannel({
        name: '#existing',
        type: 'channel',
        teamId: 'team-3',
        principal: owner,
      });
      const ensured = service.ensureTeamChannel({ teamId: 'team-3', principal: owner });
      expect(ensured.created).toBe(false);
      expect(ensured.channel.id).toBe(made.id);
    });

    it('rejects an empty teamId', () => {
      expect(() => service.ensureTeamChannel({ teamId: '   ', principal: owner })).toThrow(
        /teamId is required/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // importLegacyConversation
  // Spec: 2026-05-14-unified-chat-message-store.md Phase 5
  // -------------------------------------------------------------------------

  describe('importLegacyConversation', () => {
    const sampleLegacy = {
      conversation: { id: 'slack-D0AC7-1777130816-772509' },
      messages: [
        {
          id: 'msg-a',
          from: { type: 'user', name: 'You' },
          content: 'hello',
          timestamp: '2026-05-04T11:26:58.361Z',
          metadata: { source: 'slack', userId: 'UG94JLNGK', channelId: 'D0AC7' },
        },
        {
          id: 'msg-b',
          from: { type: 'orchestrator', name: 'Orchestrator' },
          content: 'hi back',
          timestamp: '2026-05-04T11:27:01.000Z',
          metadata: { source: 'slack' },
        },
        {
          id: 'msg-c',
          from: { type: 'system' },
          content: 'system note',
          timestamp: '2026-05-04T11:28:00.000Z',
        },
      ],
    };

    it('imports all rows on first run, dedups on second run', () => {
      const first = service.importLegacyConversation(sampleLegacy);
      expect(first.imported).toBe(3);
      expect(first.deduped).toBe(0);
      expect(first.channelId).toBe('slack-D0AC7-1777130816-772509');

      // Re-run — every row must dedupe via clientMessageId
      const second = service.importLegacyConversation(sampleLegacy);
      expect(second.imported).toBe(0);
      expect(second.deduped).toBe(3);
      expect(second.channelId).toBe(first.channelId);

      // No phantom rows
      expect(service.countAllMessages()).toBe(3);
    });

    it('maps from.type correctly (user, orchestrator → agent, anything → system)', () => {
      service.importLegacyConversation(sampleLegacy);
      // Fetch via listMessages to inspect sender types
      const messages = service.listMessages({
        channelId: 'slack-D0AC7-1777130816-772509',
        principal: { userId: 'system', source: 'oss' },
        direction: 'forward',
      }).messages;
      expect(messages).toHaveLength(3);
      expect(messages.map((m) => m.senderType)).toEqual(['user', 'agent', 'system']);
      expect(messages[1].senderId).toBe('crewly-orc');
      expect(messages[2].senderId).toBe('system');
    });

    it('preserves legacy metadata under explicit legacy* keys', () => {
      service.importLegacyConversation(sampleLegacy);
      const messages = service.listMessages({
        channelId: 'slack-D0AC7-1777130816-772509',
        principal: { userId: 'system', source: 'oss' },
        direction: 'forward',
      }).messages;
      expect(messages[0].metadata).toMatchObject({
        source: 'system',
        legacySource: 'slack',
        legacyMessageId: 'msg-a',
        legacyTimestamp: '2026-05-04T11:26:58.361Z',
      });
    });

    it('skips malformed rows without aborting the import', () => {
      const conv = {
        conversation: { id: 'slack-X-1' },
        messages: [
          { id: 'good', from: { type: 'user' }, content: 'kept' },
          { id: '', from: { type: 'user' }, content: 'dropped — no id' } as any,
          { id: 'bad-empty', from: { type: 'user' }, content: '' },
          { id: 'no-content', from: { type: 'user' } } as any,
          { id: 'good2', from: { type: 'user' }, content: 'kept2' },
        ],
      };
      const result = service.importLegacyConversation(conv as any);
      expect(result.imported).toBe(2);
      expect(result.deduped).toBe(0);
      expect(result.skipped).toBe(3);
    });

    it('logs a warning surfacing skipped row count + reasons when malformed rows are present', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        service.importLegacyConversation({
          conversation: { id: 'slack-Y-1' },
          messages: [
            { id: 'ok', from: { type: 'user' }, content: 'ok' },
            { id: 'bad-empty', from: { type: 'user' }, content: '' },
            { id: '', from: { type: 'user' }, content: 'no id' } as any,
          ],
        } as any);
        expect(warn).toHaveBeenCalledTimes(1);
        const [msg, ctx] = warn.mock.calls[0];
        expect(String(msg)).toMatch(/skipped 2\/3 malformed row/);
        expect(ctx).toMatchObject({
          skipped: 2,
          totalRows: 3,
          truncated: false,
        });
        expect((ctx as any).reasons).toEqual([
          { index: 1, reason: 'empty-content', id: 'bad-empty' },
          { index: 2, reason: 'missing-id', id: '' },
        ]);
      } finally {
        warn.mockRestore();
      }
    });

    it('does NOT log a warning when no rows are skipped (silent on the happy path)', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        service.importLegacyConversation(sampleLegacy);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('caps the reasons list at 10 entries and sets truncated=true beyond that', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const messages: Array<{ id: string; from: { type: string }; content: string }> = [];
        for (let i = 0; i < 12; i++) {
          messages.push({ id: `bad-${i}`, from: { type: 'user' }, content: '' });
        }
        service.importLegacyConversation({
          conversation: { id: 'slack-Z-1' },
          messages,
        } as any);
        const [, ctx] = warn.mock.calls[0];
        expect((ctx as any).reasons).toHaveLength(10);
        expect((ctx as any).truncated).toBe(true);
        expect((ctx as any).skipped).toBe(12);
      } finally {
        warn.mockRestore();
      }
    });

    it('rejects missing conversation.id', () => {
      expect(() =>
        service.importLegacyConversation({
          conversation: { id: '' },
          messages: [],
        } as any),
      ).toThrow(/conversation\.id is required/);
    });

    it('rejects non-array messages', () => {
      expect(() =>
        service.importLegacyConversation({
          conversation: { id: 'x' },
          messages: null,
        } as any),
      ).toThrow(/messages must be an array/);
    });

    it('extracts user id from legacy metadata when present', () => {
      service.importLegacyConversation(sampleLegacy);
      const messages = service.listMessages({
        channelId: 'slack-D0AC7-1777130816-772509',
        principal: { userId: 'system', source: 'oss' },
        direction: 'forward',
      }).messages;
      // First message has metadata.userId = 'UG94JLNGK'
      expect(messages[0].senderId).toBe('UG94JLNGK');
    });
  });

  // -------------------------------------------------------------------------
  // Phase 6.0 — API gap fill for legacy ChatService retirement
  // Spec: 2026-05-14-unified-chat-message-store.md
  // -------------------------------------------------------------------------

  describe('updateMessageMetadata (Phase 6.0)', () => {
    it('merges patch into existing metadata and returns the updated DTO', () => {
      const ch = createSam();
      const { message } = service.recordTurn({
        channelId: ch.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'hello',
        metadata: {
          source: 'reply-tool',
          slackChannelId: 'D0AC7',
          slackDeliveryStatus: 'pending',
        },
      });

      const updated = service.updateMessageMetadata(message.id, {
        slackDeliveryStatus: 'delivered',
        slackMessageTs: '1234567890.000100',
      });

      expect(updated).not.toBeNull();
      expect(updated!.metadata).toMatchObject({
        source: 'reply-tool',                  // preserved
        slackChannelId: 'D0AC7',                // preserved
        slackDeliveryStatus: 'delivered',       // overwritten
        slackMessageTs: '1234567890.000100',    // added
      });
    });

    it('returns null when the message does not exist', () => {
      expect(service.updateMessageMetadata('no-such-msg', { x: 1 })).toBeNull();
    });
  });

  describe('findMessagesWithPendingSlackDelivery (Phase 6.0)', () => {
    it('returns only messages tagged pending with a slackChannelId, within window', () => {
      const ch = createSam();

      const pending = service.recordTurn({
        channelId: ch.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'pending msg',
        metadata: {
          source: 'reply-tool',
          slackChannelId: 'D0AC7',
          slackDeliveryStatus: 'pending',
        },
      });
      service.recordTurn({
        channelId: ch.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'delivered msg',
        metadata: {
          source: 'reply-tool',
          slackChannelId: 'D0AC7',
          slackDeliveryStatus: 'delivered',
        },
      });
      service.recordTurn({
        channelId: ch.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'pending but no channel id',
        metadata: { source: 'reply-tool', slackDeliveryStatus: 'pending' },
      });

      // Window large enough to include all
      const found = service.findMessagesWithPendingSlackDelivery(60 * 60 * 1000);
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe(pending.message.id);
    });

    it('respects the maxAgeMs window — older rows are excluded', () => {
      const ch = createSam();
      service.recordTurn({
        channelId: ch.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'recent pending',
        metadata: {
          source: 'reply-tool',
          slackChannelId: 'D0AC7',
          slackDeliveryStatus: 'pending',
        },
      });

      // 0ms window → nothing falls inside
      expect(service.findMessagesWithPendingSlackDelivery(0)).toHaveLength(0);
    });
  });

  describe('getStatistics (Phase 6.0)', () => {
    it('counts active and archived channels separately and totals messages across both', () => {
      const a = createSam();
      service.archiveChannel(a.id, owner);

      const b = service.createChannel({
        agentSession: 'sess-b',
        name: 'Active B',
        principal: owner,
      });

      service.recordTurn({
        channelId: b.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'one',
        metadata: { source: 'in-process-runtime' },
      });
      service.recordTurn({
        channelId: b.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'two',
        metadata: { source: 'in-process-runtime' },
      });

      const stats = service.getStatistics();
      expect(stats).toEqual({
        totalChannels: 2,
        activeChannels: 1,
        archivedChannels: 1,
        totalMessages: 2,
      });
    });

    it('returns zeros on a fresh store', () => {
      expect(service.getStatistics()).toEqual({
        totalChannels: 0,
        activeChannels: 0,
        archivedChannels: 0,
        totalMessages: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Phase 6.0b — conversation-lifecycle methods (rename, unarchive, delete,
  // clear, count). Each replaces a legacy ChatService method.
  // -------------------------------------------------------------------------

  describe('unarchiveChannel (Phase 6.0b)', () => {
    it('flips an archived channel back to active', () => {
      const ch = createSam();
      service.archiveChannel(ch.id, owner);
      expect(service.unarchiveChannel(ch.id, owner)).toBe(true);
      // Channel is listable again
      const list = service.listChannels({ principal: owner });
      expect(list.some((c) => c.id === ch.id)).toBe(true);
    });

    it('returns false when the channel was already active', () => {
      const ch = createSam();
      expect(service.unarchiveChannel(ch.id, owner)).toBe(false);
    });

    it('rejects on non-owned channel', () => {
      const ch = createSam();
      service.archiveChannel(ch.id, owner);
      expect(() => service.unarchiveChannel(ch.id, otherUser)).toThrow(ChatError);
    });
  });

  describe('renameChannel (Phase 6.0b)', () => {
    it('renames an existing channel and returns the updated DTO', () => {
      const ch = createSam();
      const renamed = service.renameChannel(ch.id, 'Sam (renamed)', owner);
      expect(renamed.id).toBe(ch.id);
      expect(renamed.name).toBe('Sam (renamed)');
      // Round-trip through the store confirms it stuck
      const fetched = service.getChannel(ch.id, owner);
      expect(fetched.name).toBe('Sam (renamed)');
    });

    it('trims whitespace from the new name', () => {
      const ch = createSam();
      const renamed = service.renameChannel(ch.id, '  Trim Me  ', owner);
      expect(renamed.name).toBe('Trim Me');
    });

    it('rejects empty / whitespace-only names', () => {
      const ch = createSam();
      expect(() => service.renameChannel(ch.id, '', owner)).toThrow(/name is required/);
      expect(() => service.renameChannel(ch.id, '   ', owner)).toThrow(/name is required/);
    });

    it('rejects oversize names', () => {
      const ch = createSam();
      const tooLong = 'x'.repeat(service.config.maxChannelNameChars + 1);
      expect(() => service.renameChannel(ch.id, tooLong, owner)).toThrow(/exceeds/);
    });
  });

  describe('deleteChannel (Phase 6.0b)', () => {
    it('hard-deletes channel + all messages via FK cascade', () => {
      const ch = createSam();
      service.recordTurn({
        channelId: ch.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'msg',
        metadata: { source: 'in-process-runtime' },
      });
      expect(service.countAllMessages()).toBe(1);

      expect(service.deleteChannel(ch.id, owner)).toBe(true);

      // Channel + messages both gone
      expect(service.countAllMessages()).toBe(0);
      const list = service.listChannels({ principal: owner });
      expect(list.find((c) => c.id === ch.id)).toBeUndefined();
    });

    it('throws on unknown channel id (auth probe fails first)', () => {
      expect(() => service.deleteChannel('no-such-id', owner)).toThrow(ChatError);
    });
  });

  describe('clearChannel (Phase 6.0b)', () => {
    it('deletes messages but keeps the channel row', () => {
      const ch = createSam();
      service.recordTurn({
        channelId: ch.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'a',
        metadata: { source: 'in-process-runtime' },
      });
      service.recordTurn({
        channelId: ch.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'b',
        metadata: { source: 'in-process-runtime' },
      });
      expect(service.countAllMessages()).toBe(2);

      const cleared = service.clearChannel(ch.id, owner);
      expect(cleared).toBe(2);

      // Channel survives, messages don't
      expect(service.countAllMessages()).toBe(0);
      expect(service.getChannel(ch.id, owner).id).toBe(ch.id);
    });
  });

  describe('countChannelMessages (Phase 6.0b)', () => {
    it('returns 0 for a fresh channel and counts after writes', () => {
      const ch = createSam();
      expect(service.countChannelMessages(ch.id, owner)).toBe(0);
      service.recordTurn({
        channelId: ch.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'one',
        metadata: { source: 'in-process-runtime' },
      });
      service.recordTurn({
        channelId: ch.id,
        senderType: 'agent',
        senderId: 'crewly-orc',
        content: 'two',
        metadata: { source: 'in-process-runtime' },
      });
      expect(service.countChannelMessages(ch.id, owner)).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase B-2 (2026-05-17): createHuddle + listHuddleMembers + queryHuddleMembersForDispatch
  // ---------------------------------------------------------------------------

  describe('createHuddle', () => {
    it('creates a type=huddle channel with the given roster', () => {
      const dto = service.createHuddle({
        name: 'Q4 planning',
        memberSessions: ['sess-a', 'sess-b', 'sess-c'],
        principal: owner,
      });

      expect(dto.type).toBe('huddle');
      expect(dto.name).toBe('Q4 planning');
      expect(dto.agentSession).toBe(''); // huddle is not 1:1-bound
      expect(dto.teamId).toBeUndefined();
      expect(dto.members?.map((m) => m.sessionName).sort()).toEqual(['sess-a', 'sess-b', 'sess-c']);
      for (const m of dto.members!) {
        expect(m.joinedAt).toBe(1000); // matches the test clock
      }
    });

    it('dedupes and trims member sessions', () => {
      const dto = service.createHuddle({
        name: 'Dupes',
        memberSessions: [' sess-a ', 'sess-a', 'sess-b', '', '   '],
        principal: owner,
      });
      expect(dto.members?.map((m) => m.sessionName).sort()).toEqual(['sess-a', 'sess-b']);
    });

    it('rejects empty membership', () => {
      expect(() =>
        service.createHuddle({ name: 'Empty', memberSessions: [], principal: owner }),
      ).toThrow(/at least one agent session/);
      expect(() =>
        service.createHuddle({ name: 'Whitespace', memberSessions: ['  ', ''], principal: owner }),
      ).toThrow(/at least one agent session/);
    });

    it('rejects blank name', () => {
      expect(() =>
        service.createHuddle({ name: '   ', memberSessions: ['sess-a'], principal: owner }),
      ).toThrow(/name is required/);
    });

    it('caps the roster size to 50', () => {
      const fifty = Array.from({ length: 50 }, (_, i) => `sess-${i}`);
      // 50 is fine
      expect(() =>
        service.createHuddle({ name: 'Big', memberSessions: fifty, principal: owner }),
      ).not.toThrow();
      // 51 throws
      expect(() =>
        service.createHuddle({
          name: 'Bigger',
          memberSessions: [...fifty, 'sess-51'],
          principal: owner,
        }),
      ).toThrow(/50-member cap/);
    });
  });

  describe('listHuddleMembers', () => {
    it('returns the roster ordered by joined_at ASC', () => {
      const huddle = service.createHuddle({
        name: 'h',
        memberSessions: ['sess-a', 'sess-b', 'sess-c'],
        principal: owner,
      });
      const members = service.listHuddleMembers(huddle.id, owner);
      expect(members.map((m) => m.sessionName).sort()).toEqual(['sess-a', 'sess-b', 'sess-c']);
    });

    it('returns an empty array for a non-huddle channel (instead of throwing)', () => {
      const dm = createSam();
      expect(service.listHuddleMembers(dm.id, owner)).toEqual([]);
    });

    it('refuses to expose a huddle owned by a different user', () => {
      const huddle = service.createHuddle({
        name: 'h',
        memberSessions: ['sess-a'],
        principal: owner,
      });
      expect(() => service.listHuddleMembers(huddle.id, otherUser)).toThrow();
    });
  });

  describe('queryHuddleMembersForDispatch', () => {
    it('returns just the session names (dispatcher-shaped)', () => {
      const huddle = service.createHuddle({
        name: 'h',
        memberSessions: ['sess-a', 'sess-b'],
        principal: owner,
      });
      const sessions = service.queryHuddleMembersForDispatch(huddle.id);
      expect(sessions.sort()).toEqual(['sess-a', 'sess-b']);
    });

    it('returns empty for non-huddle channels', () => {
      const dm = createSam();
      expect(service.queryHuddleMembersForDispatch(dm.id)).toEqual([]);
    });
  });
});
