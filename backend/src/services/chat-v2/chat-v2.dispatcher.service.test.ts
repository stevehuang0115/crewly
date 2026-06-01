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

      it('broadcasts to EVERY member regardless of mentions', async () => {
        const { sink, calls } = makeSink({ success: true });
        const members = ['sess-a', 'sess-b', 'sess-c'];
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          huddleMembersFor: () => members,
        });

        const result = await dispatcher.dispatchMessage(
          makeHuddle(),
          makeMessage({ mentions: [] }), // nobody @-mentioned
        );

        expect(result.strategy).toBe('huddle-broadcast');
        expect(result.dispatched).toBe(true);
        expect(result.huddleOutcomes).toHaveLength(3);
        expect(calls.map((c) => c.sessionName).sort()).toEqual(['sess-a', 'sess-b', 'sess-c']);
        // No one was @-mentioned → everyone is responseMode='optional'.
        for (const o of result.huddleOutcomes!) {
          expect(o.responseMode).toBe('optional');
          expect(o.dispatched).toBe(true);
        }
      });

      it('marks @-mentioned members as response-required, others as optional', async () => {
        const { sink, calls } = makeSink({ success: true });
        const members = ['sess-a', 'sess-b', 'sess-c'];
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          huddleMembersFor: () => members,
        });

        const result = await dispatcher.dispatchMessage(
          makeHuddle(),
          makeMessage({ mentions: ['sess-b'] }),
        );

        expect(result.strategy).toBe('huddle-broadcast');
        const byMember = new Map(result.huddleOutcomes!.map((o) => [o.sessionName, o]));
        expect(byMember.get('sess-b')!.responseMode).toBe('required');
        expect(byMember.get('sess-a')!.responseMode).toBe('optional');
        expect(byMember.get('sess-c')!.responseMode).toBe('optional');

        // Prompt body for sess-b uses the "required" reply hint;
        // sess-a/c use the "optional" hint.
        const calledForB = calls.find((c) => c.sessionName === 'sess-b')!;
        expect(calledForB.message).toContain('reply-chat');
        expect(calledForB.message).not.toMatch(/否则不回复也可以/);

        const calledForA = calls.find((c) => c.sessionName === 'sess-a')!;
        expect(calledForA.message).toMatch(/否则不回复也可以/);
      });

      it('captures per-member sink failures without short-circuiting the rest', async () => {
        let n = 0;
        const sink: AgentMessageSink = {
          async sendMessageToAgent(sessionName) {
            n += 1;
            if (sessionName === 'sess-b') {
              return { success: false, error: 'PTY closed' };
            }
            return { success: true };
          },
        };
        const dispatcher = new ChatV2DispatcherService({
          agentSink: sink,
          huddleMembersFor: () => ['sess-a', 'sess-b', 'sess-c'],
        });

        const result = await dispatcher.dispatchMessage(makeHuddle(), makeMessage());
        expect(result.strategy).toBe('huddle-broadcast');
        // Even though sess-b failed, sess-a and sess-c were attempted.
        expect(n).toBe(3);
        // At least one succeeded → dispatched=true.
        expect(result.dispatched).toBe(true);
        const failed = result.huddleOutcomes!.filter((o) => !o.dispatched);
        expect(failed).toHaveLength(1);
        expect(failed[0].sessionName).toBe('sess-b');
        expect(failed[0].error).toContain('PTY closed');
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
