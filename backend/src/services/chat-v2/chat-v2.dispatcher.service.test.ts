/**
 * Unit tests for ChatV2DispatcherService.
 *
 * @module services/chat-v2/chat-v2.dispatcher.service.test
 */

import {
  ChatV2DispatcherService,
  defaultFormatPrompt,
  type AgentMessageSink,
} from './chat-v2.dispatcher.service.js';
import type { ChatChannelDTO, ChatMessageDTO } from './types.js';
import { ChatV2MentionResolver } from './chat-v2.mention-resolver.js';
import type { Team } from '../../types/index.js';

function makeChannel(overrides: Partial<ChatChannelDTO> = {}): ChatChannelDTO {
  return {
    id: 'chan-1',
    agentSession: 'crewly-product-sam-dd2b46f7',
    name: 'Chat with Sam',
    createdAt: 0,
    agentPresence: { status: 'online', lastSeenAt: null },
    // Phase A — `type` is required on the wire from A1 onward; default
    // legacy DM channels in fixtures.
    type: 'dm',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessageDTO> = {}): ChatMessageDTO {
  return {
    id: 'msg-1',
    channelId: 'chan-1',
    seq: 1,
    senderType: 'user',
    senderId: 'user-abc',
    content: 'hello there',
    contentType: 'markdown',
    createdAt: 0,
    attachments: [],
    metadata: { clientMessageId: 'cmid-xyz' },
    // Phase A — `mentions` is required on the wire (never null); default to
    // an empty array for non-mention test fixtures.
    mentions: [],
    ...overrides,
  };
}

/** Collector sink that records all calls. */
function makeSink(response: Awaited<ReturnType<AgentMessageSink['sendMessageToAgent']>>) {
  const calls: Array<{ sessionName: string; message: string }> = [];
  const sink: AgentMessageSink = {
    async sendMessageToAgent(sessionName, message) {
      calls.push({ sessionName, message });
      return response;
    },
  };
  return { sink, calls };
}

describe('ChatV2DispatcherService', () => {
  describe('defaultFormatPrompt — Slack team channel variant', () => {
    it('names reply-channel with --thread when replyVia=reply-channel', () => {
      const prompt = defaultFormatPrompt({
        channelId: 'huddle-1',
        channelName: '#team-alpha',
        agentSession: 'sess-a',
        senderId: 'U1',
        content: '@sam look',
        replyVia: 'reply-channel',
        threadId: 'msg-root',
      });
      expect(prompt).toContain('`reply-channel`');
      expect(prompt).toContain('--channel huddle-1');
      expect(prompt).toContain('--thread msg-root');
      expect(prompt).not.toContain('reply-chat');
      // Multi-agent threads must converge (owner, 2026-09-19): two rounds
      // each, the team leader writes the conclusion, then silence.
      expect(prompt).toContain('最多发言两轮');
      expect(prompt).toContain('「结论」');
    });

    it('omits --thread when no threadId and keeps the optional wording for non-mentioned members', () => {
      const prompt = defaultFormatPrompt({
        channelId: 'huddle-1',
        channelName: '#team-alpha',
        agentSession: 'sess-a',
        senderId: 'U1',
        content: 'fyi',
        replyVia: 'reply-channel',
        responseMode: 'optional',
      });
      expect(prompt).toContain('reply-channel');
      expect(prompt).not.toContain('--thread');
      expect(prompt).toContain('没有 @ 任何人');
    });
  });

  describe('defaultFormatPrompt roster', () => {
    it('appends the channel roster line when one is given', () => {
      const prompt = defaultFormatPrompt({
        channelId: 'huddle-1', channelName: '#team', agentSession: 's', senderId: 'U1', content: 'hi',
        replyVia: 'reply-channel', responseMode: 'required', channelRoster: 'Atlas (Think Tank, this machine) → @Atlas · Mia (Portal, mac-mini) → @Mia',
      });
      expect(prompt).toContain('本频道成员（可 @ 的同事）: Atlas (Think Tank, this machine) → @Atlas · Mia (Portal, mac-mini) → @Mia');
      expect(defaultFormatPrompt({ channelId: 'h', channelName: 'c', agentSession: 's', senderId: 'U', content: 'x' })).not.toContain('本频道成员');
    });
  });

  describe('defaultFormatPrompt', () => {
    it('includes the [CHAT:<id>] tag, author, and reply instruction', () => {
      const prompt = defaultFormatPrompt({
        channelId: 'chan-1',
        channelName: 'Chat with Sam',
        agentSession: 'crewly-product-sam-xyz',
        senderId: 'steve',
        content: '  hi, sam  ',
      });
      expect(prompt).toContain('[CHAT:chan-1]');
      expect(prompt).toContain('<steve@Chat with Sam>');
      // trim() stripped the leading/trailing whitespace
      expect(prompt).toContain('\nhi, sam\n');
      expect(prompt).toContain('`reply-chat`');
      expect(prompt).toContain('conversationId="chan-1"');
    });

    it('appends [cmid:...] when clientMessageId is present', () => {
      const prompt = defaultFormatPrompt({
        channelId: 'chan-1',
        channelName: 'n',
        agentSession: 's',
        senderId: 'u',
        content: 'x',
        clientMessageId: 'cmid-zzz',
      });
      expect(prompt).toContain('[cmid:cmid-zzz]');
    });

    it('omits [cmid:...] when clientMessageId is missing', () => {
      const prompt = defaultFormatPrompt({
        channelId: 'chan-1',
        channelName: 'n',
        agentSession: 's',
        senderId: 'u',
        content: 'x',
      });
      expect(prompt).not.toContain('[cmid:');
    });
  });

  describe('dispatchToAgent', () => {
    it('calls sendMessageToAgent with the bound session and formatted prompt', async () => {
      const { sink, calls } = makeSink({ success: true });
      const dispatcher = new ChatV2DispatcherService({ agentSink: sink });

      const result = await dispatcher.dispatchToAgent(makeChannel(), makeMessage());

      expect(result.dispatched).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].sessionName).toBe('crewly-product-sam-dd2b46f7');
      expect(calls[0].message).toContain('[CHAT:chan-1]');
      expect(calls[0].message).toContain('hello there');
      expect(calls[0].message).toContain('[cmid:cmid-xyz]');
    });

    it('is a no-op for agent-origin messages (prevents loopback)', async () => {
      const { sink, calls } = makeSink({ success: true });
      const dispatcher = new ChatV2DispatcherService({ agentSink: sink });

      const result = await dispatcher.dispatchToAgent(
        makeChannel(),
        makeMessage({ senderType: 'agent', senderId: 'crewly-product-sam-xyz' }),
      );

      expect(result.dispatched).toBe(false);
      expect(result.error).toMatch(/not a user-origin/);
      expect(calls).toHaveLength(0);
    });

    it('is a no-op when the channel has no bound agent session', async () => {
      const { sink, calls } = makeSink({ success: true });
      const dispatcher = new ChatV2DispatcherService({ agentSink: sink });

      const result = await dispatcher.dispatchToAgent(
        makeChannel({ agentSession: '' }),
        makeMessage(),
      );
      expect(result.dispatched).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it('propagates sink failure as a non-dispatched result', async () => {
      const { sink } = makeSink({ success: false, error: 'no such session' });
      const dispatcher = new ChatV2DispatcherService({ agentSink: sink });

      const result = await dispatcher.dispatchToAgent(makeChannel(), makeMessage());
      expect(result).toEqual({ dispatched: false, error: 'no such session' });
    });

    it('activates an inactive agent on send, then retries delivery', async () => {
      // First send fails (no session); after activation the retry succeeds.
      const calls: string[] = [];
      let attempt = 0;
      const sink: AgentMessageSink = {
        async sendMessageToAgent(sessionName) {
          calls.push(sessionName);
          attempt += 1;
          return attempt === 1
            ? { success: false, error: 'Session does not exist' }
            : { success: true };
        },
      };
      const activated: string[] = [];
      const dispatcher = new ChatV2DispatcherService({
        agentSink: sink,
        activateAgent: async (s) => {
          activated.push(s);
          return true;
        },
      });

      const result = await dispatcher.dispatchToAgent(makeChannel(), makeMessage());
      expect(result).toEqual({ dispatched: true });
      expect(activated).toEqual(['crewly-product-sam-dd2b46f7']); // bound session
      expect(calls).toHaveLength(2); // initial + retry after activation
    });

    it('stays failed when activation does not bring the agent up', async () => {
      const { sink } = makeSink({ success: false, error: 'Session does not exist' });
      const dispatcher = new ChatV2DispatcherService({
        agentSink: sink,
        activateAgent: async () => false,
      });

      const result = await dispatcher.dispatchToAgent(makeChannel(), makeMessage());
      expect(result).toEqual({ dispatched: false, error: 'Session does not exist' });
    });

    it('treats thrown errors as a clean, reportable failure', async () => {
      const sink: AgentMessageSink = {
        async sendMessageToAgent() {
          throw new Error('PTY crashed');
        },
      };
      const dispatcher = new ChatV2DispatcherService({ agentSink: sink });
      const result = await dispatcher.dispatchToAgent(makeChannel(), makeMessage());
      expect(result).toEqual({ dispatched: false, error: 'PTY crashed' });
    });

    it('allows formatPrompt override for future customization', async () => {
      const { sink, calls } = makeSink({ success: true });
      const dispatcher = new ChatV2DispatcherService({
        agentSink: sink,
        formatPrompt: ({ content }) => `CUSTOM::${content}`,
      });
      await dispatcher.dispatchToAgent(makeChannel(), makeMessage());
      expect(calls[0].message).toBe('CUSTOM::hello there');
    });

    it('handles missing metadata.clientMessageId gracefully', async () => {
      const { sink, calls } = makeSink({ success: true });
      const dispatcher = new ChatV2DispatcherService({ agentSink: sink });
      await dispatcher.dispatchToAgent(
        makeChannel(),
        makeMessage({ metadata: undefined }),
      );
      expect(calls[0].message).not.toContain('[cmid:');
    });
  });

  // --------------------------------------------------------------------
  // Phase C BE.3 — dispatchMessage routing.
  // --------------------------------------------------------------------

  describe('dispatchMessage', () => {
    /** Build a resolver backed by the supplied team list. */
    function buildResolver(teams: Team[]): ChatV2MentionResolver {
      return new ChatV2MentionResolver({ loadTeams: () => teams });
    }

    /** Minimal team fixture: one product team with a TL + a worker. */
    function fixtureTeams(): Team[] {
      const now = '2026-01-01T00:00:00.000Z';
      return [
        {
          id: 'team-product',
          name: 'Product',
          members: [
            {
              id: 'sam-id',
              name: 'Sam',
              sessionName: 'crewly-product-sam',
              role: 'team-leader',
              systemPrompt: '',
              agentStatus: 'inactive',
              workingStatus: 'idle',
              runtimeType: 'claude-code',
              hierarchyLevel: 1,
              canDelegate: true,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: 'leo-id',
              name: 'Leo',
              sessionName: 'crewly-product-leo',
              role: 'developer',
              systemPrompt: '',
              agentStatus: 'inactive',
              workingStatus: 'idle',
              runtimeType: 'claude-code',
              createdAt: now,
              updatedAt: now,
            },
          ],
          projectIds: [],
          createdAt: now,
          updatedAt: now,
        },
      ];
    }

    /** Build a channel-typed channel for fan-out tests. */
    function makeTeamChannel(over: Partial<ChatChannelDTO> = {}): ChatChannelDTO {
      return makeChannel({
        type: 'channel',
        agentSession: '',
        teamId: 'team-product',
        name: '#general-product',
        ...over,
      });
    }

    describe('dm strategy (back-compat)', () => {
      it("dispatches to channel.agentSession for type='dm'", async () => {
        const { sink, calls } = makeSink({ success: true });
        const dispatcher = new ChatV2DispatcherService({ agentSink: sink });
        const result = await dispatcher.dispatchMessage(makeChannel(), makeMessage());
        expect(result.strategy).toBe('dm');
        expect(result.dispatched).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0].sessionName).toBe('crewly-product-sam-dd2b46f7');
      });

      it('skips agent-origin messages (no self-loopback) before checking type', async () => {
        const { sink, calls } = makeSink({ success: true });
        const dispatcher = new ChatV2DispatcherService({ agentSink: sink });
        const result = await dispatcher.dispatchMessage(
          makeTeamChannel(),
          makeMessage({ senderType: 'agent' }),
        );
        expect(result.strategy).toBe('skip');
        expect(result.reason).toMatch(/not a user-origin/);
        expect(calls).toHaveLength(0);
      });
    });

    describe('channel-mentions strategy (Phase C BE.3 fan-out)', () => {
      it('skips when no resolver is wired', async () => {
        const { sink, calls } = makeSink({ success: true });
        const dispatcher = new ChatV2DispatcherService({ agentSink: sink });
        const result = await dispatcher.dispatchMessage(
          makeTeamChannel(),
          makeMessage({ mentions: ['leo-id'] }),
        );
        expect(result.strategy).toBe('skip');
        expect(result.reason).toMatch(/no mention resolver/);
        expect(calls).toHaveLength(0);
      });

      it('skips when message has no mentions', async () => {
        const { sink, calls } = makeSink({ success: true });
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          mentionResolver: buildResolver(fixtureTeams()),
        });
        const result = await dispatcher.dispatchMessage(
          makeTeamChannel(),
          makeMessage({ mentions: [] }),
        );
        expect(result.strategy).toBe('skip');
        expect(result.reason).toMatch(/no mentions/);
        expect(calls).toHaveLength(0);
      });

      it('fans out to one resolved member', async () => {
        const { sink, calls } = makeSink({ success: true });
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          mentionResolver: buildResolver(fixtureTeams()),
        });
        const result = await dispatcher.dispatchMessage(
          makeTeamChannel(),
          makeMessage({ mentions: ['leo-id'] }),
        );
        expect(result.strategy).toBe('channel-mentions');
        expect(result.dispatched).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0].sessionName).toBe('crewly-product-leo');
        expect(calls[0].message).toContain('[CHAT:chan-1]');
        expect(result.mentionOutcomes).toEqual([
          {
            target: expect.objectContaining({
              kind: 'agent',
              memberId: 'leo-id',
              sessionName: 'crewly-product-leo',
            }),
            dispatched: true,
          },
        ]);
      });

      it('fans out to multiple distinct resolved targets', async () => {
        const { sink, calls } = makeSink({ success: true });
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          mentionResolver: buildResolver(fixtureTeams()),
        });
        const result = await dispatcher.dispatchMessage(
          makeTeamChannel(),
          makeMessage({ mentions: ['leo-id', 'team-product'] }),
        );
        expect(result.strategy).toBe('channel-mentions');
        expect(result.dispatched).toBe(true);
        // team-product mention precedes leo because the resolver puts
        // teams first on shared input ordering — but here the input
        // order has leo first; the resolver preserves input order.
        // (Sam = TL of team-product; Leo = direct agent mention.)
        expect(calls.map((c) => c.sessionName).sort()).toEqual([
          'crewly-product-leo',
          'crewly-product-sam',
        ]);
      });

      it('returns empty mentionOutcomes when resolver yields nothing (unknown ids)', async () => {
        const { sink, calls } = makeSink({ success: true });
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          mentionResolver: buildResolver(fixtureTeams()),
        });
        const result = await dispatcher.dispatchMessage(
          makeTeamChannel(),
          makeMessage({ mentions: ['unknown-1', 'unknown-2'] }),
        );
        expect(result.strategy).toBe('channel-mentions');
        expect(result.dispatched).toBe(false);
        expect(result.mentionOutcomes).toEqual([]);
        expect(calls).toHaveLength(0);
      });

      it('captures per-recipient sink failures without halting fan-out', async () => {
        const calls: Array<{ sessionName: string; message: string }> = [];
        const sink: AgentMessageSink = {
          async sendMessageToAgent(sessionName, message) {
            calls.push({ sessionName, message });
            // Fail leo, succeed sam
            if (sessionName === 'crewly-product-leo') {
              return { success: false, error: 'leo offline' };
            }
            return { success: true };
          },
        };
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          mentionResolver: buildResolver(fixtureTeams()),
        });
        const result = await dispatcher.dispatchMessage(
          makeTeamChannel(),
          makeMessage({ mentions: ['leo-id', 'team-product'] }),
        );
        expect(result.strategy).toBe('channel-mentions');
        expect(result.dispatched).toBe(true); // at least one succeeded (sam)
        expect(calls).toHaveLength(2);
        const leoOutcome = result.mentionOutcomes!.find(
          (o) => o.target.sessionName === 'crewly-product-leo',
        );
        const samOutcome = result.mentionOutcomes!.find(
          (o) => o.target.sessionName === 'crewly-product-sam',
        );
        expect(leoOutcome?.dispatched).toBe(false);
        expect(leoOutcome?.error).toBe('leo offline');
        expect(samOutcome?.dispatched).toBe(true);
      });

      it('captures thrown sink errors as a non-dispatched per-recipient outcome', async () => {
        const sink: AgentMessageSink = {
          async sendMessageToAgent() {
            throw new Error('PTY crashed');
          },
        };
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          mentionResolver: buildResolver(fixtureTeams()),
        });
        const result = await dispatcher.dispatchMessage(
          makeTeamChannel(),
          makeMessage({ mentions: ['leo-id'] }),
        );
        expect(result.strategy).toBe('channel-mentions');
        expect(result.dispatched).toBe(false);
        expect(result.mentionOutcomes).toHaveLength(1);
        expect(result.mentionOutcomes![0].error).toBe('PTY crashed');
      });

      // Regression guard for Arch review M1 (PR #331): the production
      // composition root in `backend/src/index.ts` MUST inject
      // `mentionResolver` into ChatV2DispatcherService. When omitted,
      // `type='channel'` messages silently short-circuit to
      // strategy='skip' and the Phase E acceptance test would fail
      // with debug-only logging.
      describe("M1 regression: production composition shape", () => {
        it("WITH mentionResolver wired (production shape) — fans out, does NOT skip", async () => {
          const { sink, calls } = makeSink({ success: true });
          // Mirrors backend/src/index.ts:1088-1094 exactly:
          //   const chatMentionResolver = new ChatV2MentionResolver({
          //     loadTeams: async () => StorageService.getInstance().getTeams(),
          //   });
          //   const chatDispatcher = new ChatV2DispatcherService({
          //     agentSink: ...,
          //     mentionResolver: chatMentionResolver,
          //   });
          const teams = fixtureTeams();
          const chatMentionResolver = new ChatV2MentionResolver({
            loadTeams: async () => teams,
          });
          const dispatcher = new ChatV2DispatcherService({
            agentSink: sink,
            mentionResolver: chatMentionResolver,
          });
          const result = await dispatcher.dispatchMessage(
            makeTeamChannel(),
            makeMessage({ mentions: ['leo-id'] }),
          );
          expect(result.strategy).toBe('channel-mentions');
          expect(result.strategy).not.toBe('skip'); // explicit
          expect(result.dispatched).toBe(true);
          expect(calls).toHaveLength(1);
          expect(calls[0].sessionName).toBe('crewly-product-leo');
        });

        it("WITHOUT mentionResolver (regression repro of pre-M1 wiring) — silently skips", async () => {
          // This is the exact failure mode Arch flagged: if the
          // composition root ever drops `mentionResolver` from the
          // options, EVERY type='channel' message hits the
          // `strategy='skip'` short-circuit at chat-v2.dispatcher
          // .service.ts. Logged at debug only. Phase E acceptance test
          // would silently fail.
          const { sink, calls } = makeSink({ success: true });
          const dispatcher = new ChatV2DispatcherService({ agentSink: sink });
          const result = await dispatcher.dispatchMessage(
            makeTeamChannel(),
            makeMessage({ mentions: ['leo-id'] }),
          );
          expect(result.strategy).toBe('skip');
          expect(result.reason).toMatch(/no mention resolver/);
          expect(calls).toHaveLength(0);
        });
      });

      it("forwards channel.teamId as resolver context (passed through, not enforced yet)", async () => {
        // Resolver context is forwarded; BE.2 leaves enforcement for a
        // future tightening. This test pins that the dispatcher does
        // pass `channel.teamId` so BE.4+ can act on it without changing
        // the dispatcher.
        let capturedCtx: { teamId?: string } | undefined;
        const fakeResolver = {
          async resolve(_mentions: string[], ctx?: { teamId?: string }) {
            capturedCtx = ctx;
            return [];
          },
        } as unknown as ChatV2MentionResolver;
        const { sink } = makeSink({ success: true });
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          mentionResolver: fakeResolver,
        });
        await dispatcher.dispatchMessage(
          makeTeamChannel({ teamId: 'team-product' }),
          makeMessage({ mentions: ['leo-id'] }),
        );
        expect(capturedCtx).toEqual({ teamId: 'team-product' });
      });
    });

    // ----------------------------------------------------------------
    // Phase B-2 (2026-05-17) — huddle broadcast.
    // ----------------------------------------------------------------

    describe('huddle broadcast', () => {
      /** Build a `type='huddle'` channel DTO fixture. */
      function makeHuddle(overrides: Partial<ChatChannelDTO> = {}): ChatChannelDTO {
        return {
          id: 'huddle-1',
          agentSession: '',
          name: 'Q4 planning',
          createdAt: 1,
          archivedAt: null,
          lastMessageAt: null,
          agentPresence: { status: 'online', lastSeenAt: null },
          type: 'huddle',
          ...overrides,
        };
      }

      it('forwards threadId + replyVia into every member prompt', async () => {
        const sink = { sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }) };
        const svc = new ChatV2DispatcherService({
          agentSink: sink,
          huddleMembersFor: () => ['sess-a', 'sess-b'],
        });
        const result = await svc.dispatchMessage(
          makeHuddle(),
          makeMessage({ mentions: ['sess-b'] }),
          { threadId: 'msg-root', replyVia: 'reply-channel' },
        );
        expect(result.strategy).toBe('huddle-broadcast');
        for (const call of sink.sendMessageToAgent.mock.calls) {
          expect(call[1]).toContain('--thread msg-root');
          expect(call[1]).toContain('reply-channel');
        }
      });

      it('skips when no huddleMembersFor resolver is wired', async () => {
        const { sink, calls } = makeSink({ success: true });
        const dispatcher = new ChatV2DispatcherService({ agentSink: sink });

        const result = await dispatcher.dispatchMessage(
          makeHuddle(),
          makeMessage({ mentions: [] }),
        );

        expect(result.strategy).toBe('skip');
        expect(result.dispatched).toBe(false);
        expect(result.reason).toMatch(/huddleMembersFor/);
        expect(calls).toHaveLength(0);
      });

      it('skips when the roster is empty', async () => {
        const { sink, calls } = makeSink({ success: true });
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          huddleMembersFor: () => [],
        });

        const result = await dispatcher.dispatchMessage(makeHuddle(), makeMessage());
        expect(result.strategy).toBe('skip');
        expect(result.reason).toMatch(/no members/);
        expect(calls).toHaveLength(0);
      });

      it('@-mentioned members get a required prompt; nobody else hears the message', async () => {
        const { sink, calls } = makeSink({ success: true });
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          huddleMembersFor: () => ['sess-a', 'sess-b', 'sess-c'],
          huddleLeaderFor: async () => 'sess-a',
        });
        const result = await dispatcher.dispatchMessage(makeHuddle(), makeMessage({ mentions: ['sess-b'] }));
        expect(result.strategy).toBe('huddle-broadcast');
        expect(calls.map((c) => c.sessionName)).toEqual(['sess-b']);
        expect(result.huddleOutcomes).toEqual([{ sessionName: 'sess-b', responseMode: 'required', dispatched: true }]);
        expect(calls[0].message).not.toMatch(/不要回复/);
      });

      it('a message that @s nobody goes to the team leader alone, optional; without a leader resolver it is recorded only', async () => {
        const { sink, calls } = makeSink({ success: true });
        const withLeader = new ChatV2DispatcherService({
          agentSink: sink,
          huddleMembersFor: () => ['sess-a', 'sess-b', 'sess-c'],
          huddleLeaderFor: async () => 'sess-a',
        });
        const result = await withLeader.dispatchMessage(makeHuddle(), makeMessage({ mentions: [] }));
        expect(calls.map((c) => c.sessionName)).toEqual(['sess-a']);
        expect(result.huddleOutcomes).toEqual([{ sessionName: 'sess-a', responseMode: 'optional', dispatched: true }]);
        expect(calls[0].message).toMatch(/team leader/);

        calls.length = 0;
        const noLeader = new ChatV2DispatcherService({ agentSink: sink, huddleMembersFor: () => ['sess-a', 'sess-b'] });
        const silent = await noLeader.dispatchMessage(makeHuddle(), makeMessage({ mentions: [] }));
        expect(calls).toHaveLength(0);
        expect(silent).toEqual({ strategy: 'huddle-broadcast', dispatched: false, huddleOutcomes: [] });
      });

      it('a follow-up inside a thread reaches the agents already engaged there without another @', async () => {
        const { sink, calls } = makeSink({ success: true });
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          huddleMembersFor: () => ['sess-a', 'sess-b', 'sess-c'],
          huddleLeaderFor: async () => 'sess-a',
          threadParticipantsFor: (_channelId, threadId) => (threadId === 'root-1' ? ['sess-c', 'someone-not-a-member'] : []),
        });
        const result = await dispatcher.dispatchMessage(makeHuddle(), makeMessage({ mentions: [] }), { threadId: 'root-1', replyVia: 'reply-channel' });
        expect(calls.map((c) => c.sessionName)).toEqual(['sess-c']);
        expect(result.huddleOutcomes).toEqual([{ sessionName: 'sess-c', responseMode: 'required', dispatched: true }]);
        expect(calls[0].message).toContain('--thread root-1');
      });

      it('wakes an inactive addressee, retries once, and reports a member that would not start', async () => {
        const up = new Set<string>();
        const sink: AgentMessageSink = {
          async sendMessageToAgent(sessionName) {
            return up.has(sessionName) ? { success: true } : { success: false, error: `Session '${sessionName}' does not exist` };
          },
        };
        const activated: string[] = [];
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          huddleMembersFor: () => ['tt-atlas', 'tt-sage', 'tt-kai'],
          huddleLeaderFor: async () => 'tt-atlas',
          activateAgent: async (s) => {
            activated.push(s);
            if (s === 'tt-kai') return false;
            up.add(s);
            return true;
          },
        });
        // Nobody addressed → only the leader is woken; the researchers stay asleep.
        const leaderOnly = await dispatcher.dispatchMessage(makeHuddle(), makeMessage({ mentions: [] }));
        expect(activated).toEqual(['tt-atlas']);
        expect(leaderOnly.huddleOutcomes).toEqual([{ sessionName: 'tt-atlas', responseMode: 'optional', dispatched: true }]);
        // An @ to an agent that cannot start is reported, not swallowed.
        const kai = await dispatcher.dispatchMessage(makeHuddle(), makeMessage({ mentions: ['tt-kai'] }));
        expect(activated).toEqual(['tt-atlas', 'tt-kai']);
        expect(kai.dispatched).toBe(false);
        expect(kai.huddleOutcomes?.[0]).toMatchObject({ sessionName: 'tt-kai', dispatched: false });
      });

      it('skips agent-origin messages (no self-loopback)', async () => {
        const { sink, calls } = makeSink({ success: true });
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          huddleMembersFor: () => ['sess-a', 'sess-b'],
        });

        const result = await dispatcher.dispatchMessage(
          makeHuddle(),
          makeMessage({ senderType: 'agent', senderId: 'sess-a' }),
        );
        expect(result.strategy).toBe('skip');
        expect(result.reason).toMatch(/not a user-origin/);
        expect(calls).toHaveLength(0);
      });
    });
  });
});
