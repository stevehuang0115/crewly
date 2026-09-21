/**
 * Tests for SlackAgentDmService — a DM to an agent's own bot lands on the
 * owner's chat-v2 DM channel with that agent and the reply goes back under
 * the agent's bot token.
 */

import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { SlackAgentDmService, type SlackAgentDmServiceDeps } from './slack-agent-dm.service.js';
import type { SlackIncomingMessage } from '../../types/slack.types.js';
import type { ChatChannelDTO, ChatMessageDTO } from '../chat-v2/types.js';

type Listener = (dto: ChatMessageDTO) => void;

function makeDeps(overrides: Partial<SlackAgentDmServiceDeps> = {}) {
  const listeners: Listener[] = [];
  const sent: unknown[] = [];
  const reactions: unknown[] = [];
  const recorded: unknown[] = [];
  const dispatched: unknown[] = [];
  const channel = { id: 'chat-ella', type: 'dm', agentSession: 'crewly-marketing-ella-e6a6b8ea', name: 'Ella' } as unknown as ChatChannelDTO;
  const deps: SlackAgentDmServiceDeps = {
    slack: {
      isConnected: () => true,
      sendMessage: async (m) => { sent.push(m); return '1.2'; },
      addReaction: async (...a) => { reactions.push(a); },
    },
    chat: {
      ensureDmChannel: jest.fn(() => ({ channel, created: true })),
      getChannelForBridge: () => channel,
      recordTurn: jest.fn((args: { content: string }) => ({
        message: { id: 'm1', channelId: channel.id, senderType: 'user', senderId: 'steve', content: args.content } as unknown as ChatMessageDTO,
        channel,
      })),
      on: (_e: string, l: Listener) => { listeners.push(l); },
      off: (_e: string, l: Listener) => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); },
    } as unknown as SlackAgentDmServiceDeps['chat'],
    storage: { getTeams: async () => [{ id: 't1', name: 'Crewly Marketing', members: [{ id: 'e6a6b8ea-1', name: 'Ella', sessionName: 'crewly-marketing-ella-e6a6b8ea', role: 'developer' }] }] as never },
    getDispatcher: () => ({ dispatchMessage: async (c: ChatChannelDTO, m: ChatMessageDTO) => { dispatched.push([c.id, m.id]); return { strategy: 'dm', dispatched: true }; } }) as never,
    identities: { getInstalled: (s: string) => (s.includes('ella') ? { botUserId: 'U-ella', botToken: 'xoxb-ella' } : null) },
    storePath: path.join(os.tmpdir(), `agent-dm-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
    ...overrides,
  };
  return { deps, listeners, sent, reactions, recorded, dispatched, emit: (dto: ChatMessageDTO) => { for (const l of [...listeners]) l(dto); } };
}

const dm = (over: Partial<SlackIncomingMessage> = {}): SlackIncomingMessage => ({
  ts: '1789781178.423669',
  text: '你好 你能自我介绍一下吗',
  userId: 'U-steve',
  channelId: 'D0C2YLU8F2A',
  user: { id: 'U-steve', name: 'steve', realName: 'Steve Huang' },
  agentSession: 'crewly-marketing-ella-e6a6b8ea',
  source: 'cloud',
  ...over,
} as SlackIncomingMessage);

describe('SlackAgentDmService', () => {
  afterEach(async () => { /* temp store files are per-test and tiny */ });

  it('routes a DM to the agent: owner DM channel, user turn with Slack metadata, dispatch, reaction from the agent bot', async () => {
    const { deps, dispatched, reactions } = makeDeps();
    const svc = new SlackAgentDmService(deps);
    await svc.start();
    const res = await svc.routeInbound(dm());
    expect(res?.link).toMatchObject({ chatChannelId: 'chat-ella', agentSession: 'crewly-marketing-ella-e6a6b8ea', slackChannelId: 'D0C2YLU8F2A' });
    expect(deps.chat.ensureDmChannel).toHaveBeenCalledWith(expect.objectContaining({
      agentSession: 'crewly-marketing-ella-e6a6b8ea',
      name: 'Ella',
      principal: { userId: 'dev-user-001', source: 'oss' },
    }));
    expect(deps.chat.recordTurn).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'chat-ella',
      senderType: 'user',
      senderId: 'Steve Huang',
      metadata: expect.objectContaining({ source: 'slack', slackChannelId: 'D0C2YLU8F2A', slackTs: '1789781178.423669' }),
    }));
    expect(dispatched).toEqual([['chat-ella', 'm1']]);
    expect(reactions).toEqual([['D0C2YLU8F2A', '1789781178.423669', 'eyes', 'xoxb-ella']]);
    expect(svc.findBySlackChannelId('D0C2YLU8F2A')?.agentSession).toBe('crewly-marketing-ella-e6a6b8ea');
    svc.stop();
    await fs.rm(deps.storePath as string, { force: true });
  });

  it('ignores messages not addressed to a local agent', async () => {
    const { deps, dispatched } = makeDeps({ isLocalAgent: () => false });
    const svc = new SlackAgentDmService(deps);
    expect(await svc.routeInbound(dm({ agentSession: undefined }))).toBeNull();
    expect(await svc.routeInbound(dm())).toBeNull();
    expect(dispatched).toEqual([]);
  });

  it('mirrors the agent reply back into the Slack DM under the agent bot token (thread only when the DM was threaded)', async () => {
    const { deps, sent, emit } = makeDeps();
    const svc = new SlackAgentDmService(deps);
    await svc.start();
    await svc.routeInbound(dm());
    emit({ id: 'm2', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: '你好，我是 Ella。' } as unknown as ChatMessageDTO);
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual([expect.objectContaining({ channelId: 'D0C2YLU8F2A', text: '你好，我是 Ella。', botToken: 'xoxb-ella', skipChatV2Mirror: true })]);
    expect((sent[0] as { threadTs?: string }).threadTs).toBeUndefined();

    await svc.routeInbound(dm({ ts: '2.0', threadTs: '1789781178.423669' }));
    emit({ id: 'm3', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: 'in thread' } as unknown as ChatMessageDTO);
    await new Promise((r) => setImmediate(r));
    expect((sent[1] as { threadTs?: string }).threadTs).toBe('1789781178.423669');

    // User turns and messages from Slack itself are never mirrored.
    emit({ id: 'm4', channelId: 'chat-ella', senderType: 'user', senderId: 'steve', content: 'x' } as unknown as ChatMessageDTO);
    emit({ id: 'm5', channelId: 'chat-ella', senderType: 'agent', senderId: 'x', content: 'x', metadata: { source: 'slack' } } as unknown as ChatMessageDTO);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(2);
    svc.stop();
    await fs.rm(deps.storePath as string, { force: true });
  });

  describe('duplicate replies', () => {
    const answer = '你好！我是 Crewly 的编排器（Orchestrator），负责把你的需求拆成任务、派给团队里的 agent，并跟踪进度。';

    it('drops a second agent turn that merely restates the one just sent', async () => {
      let clock = 1_700_000_000_000;
      const { deps, sent, emit } = makeDeps({ now: () => new Date(clock) });
      const svc = new SlackAgentDmService(deps);
      await svc.start();
      await svc.routeInbound(dm());

      emit({ id: 'm2', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: answer } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));
      // The agent reports back that it replied, and repeats the answer.
      clock += 1_600;
      emit({ id: 'm3', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: `已回复该频道。\n\n${answer}` } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));

      expect(sent).toHaveLength(1);
      expect((sent[0] as { text: string }).text).toBe(answer);
      svc.stop();
      await fs.rm(deps.storePath as string, { force: true });
    });

    // One orchestrator turn reaches chat twice: the terminal scraper records
    // its [CHAT_RESPONSE] as `pty-runtime`, the notify handler records its
    // [NOTIFY] summary as `in-process-runtime`. The owner got the answer and
    // then a condensed restatement 1.2s later (2026-09-21). The two texts do
    // not contain one another, so only the source separates them.
    it('drops the other runtime\'s restatement of the answer just sent', async () => {
      let clock = 1_700_000_000_000;
      const { deps, sent, emit } = makeDeps({ now: () => new Date(clock) });
      const svc = new SlackAgentDmService(deps);
      await svc.start();
      await svc.routeInbound(dm());

      emit({ id: 'm2', channelId: 'chat-ella', senderType: 'agent', senderId: 'Orchestrator', content: answer, metadata: { source: 'pty-runtime' } } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));
      clock += 1_200;
      emit({ id: 'm3', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: '已回复。我是 Crewly 编排器，负责把目标拆解、分派并盯进度。', metadata: { source: 'in-process-runtime' } } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));

      expect(sent).toHaveLength(1);
      expect((sent[0] as { text: string }).text).toBe(answer);
      svc.stop();
      await fs.rm(deps.storePath as string, { force: true });
    });

    it('keeps a genuine later follow-up from that runtime', async () => {
      let clock = 1_700_000_000_000;
      const { deps, sent, emit } = makeDeps({ now: () => new Date(clock) });
      const svc = new SlackAgentDmService(deps);
      await svc.start();
      await svc.routeInbound(dm());

      emit({ id: 'm2', channelId: 'chat-ella', senderType: 'agent', senderId: 'Orchestrator', content: '开始处理了。', metadata: { source: 'pty-runtime' } } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));
      clock += 11_000; // past the cross-runtime window
      emit({ id: 'm3', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: '做完了，结果在 wiki。', metadata: { source: 'in-process-runtime' } } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));

      expect(sent).toHaveLength(2);
      svc.stop();
      await fs.rm(deps.storePath as string, { force: true });
    });

    it('does not suppress two turns from the same runtime', async () => {
      let clock = 1_700_000_000_000;
      const { deps, sent, emit } = makeDeps({ now: () => new Date(clock) });
      const svc = new SlackAgentDmService(deps);
      await svc.start();
      await svc.routeInbound(dm());

      emit({ id: 'm2', channelId: 'chat-ella', senderType: 'agent', senderId: 'x', content: '第一段。', metadata: { source: 'in-process-runtime' } } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));
      clock += 1_000;
      emit({ id: 'm3', channelId: 'chat-ella', senderType: 'agent', senderId: 'x', content: '第二段，接着上面。', metadata: { source: 'in-process-runtime' } } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));

      expect(sent).toHaveLength(2);
      svc.stop();
      await fs.rm(deps.storePath as string, { force: true });
    });

    it('lets the same text through once the window has passed', async () => {
      let clock = 1_700_000_000_000;
      const { deps, sent, emit } = makeDeps({ now: () => new Date(clock) });
      const svc = new SlackAgentDmService(deps);
      await svc.start();
      await svc.routeInbound(dm());

      emit({ id: 'm2', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: answer } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));
      clock += 31_000;
      emit({ id: 'm3', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: answer } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));

      expect(sent).toHaveLength(2);
      svc.stop();
      await fs.rm(deps.storePath as string, { force: true });
    });

    it('a new question reopens the DM, so an identical answer is sent again', async () => {
      let clock = 1_700_000_000_000;
      const { deps, sent, emit } = makeDeps({ now: () => new Date(clock) });
      const svc = new SlackAgentDmService(deps);
      await svc.start();
      await svc.routeInbound(dm());
      emit({ id: 'm2', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: answer } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));

      clock += 2_000;
      await svc.routeInbound(dm({ ts: '2.0', text: '再说一遍' }));
      emit({ id: 'm3', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: answer } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));

      expect(sent).toHaveLength(2);
      svc.stop();
      await fs.rm(deps.storePath as string, { force: true });
    });

    it('keeps a short reply that happens to appear inside the previous one', async () => {
      let clock = 1_700_000_000_000;
      const { deps, sent, emit } = makeDeps({ now: () => new Date(clock) });
      const svc = new SlackAgentDmService(deps);
      await svc.start();
      await svc.routeInbound(dm());
      emit({ id: 'm2', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: '好的，我先看一下日志再回你。' } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));
      clock += 1_000;
      emit({ id: 'm3', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: '好的' } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));

      expect(sent).toHaveLength(2);
      svc.stop();
      await fs.rm(deps.storePath as string, { force: true });
    });

    it('dedupes per DM, not globally', async () => {
      let clock = 1_700_000_000_000;
      const { deps, sent, emit } = makeDeps({ now: () => new Date(clock) });
      const svc = new SlackAgentDmService(deps);
      await svc.start();
      await svc.routeInbound(dm());
      emit({ id: 'm2', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: answer } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));

      // Same agent, a different Slack DM: the link is rewritten, so the reply
      // must still go out.
      clock += 1_000;
      await svc.routeInbound(dm({ ts: '3.0', channelId: 'D-OTHER' }));
      emit({ id: 'm3', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: answer } as unknown as ChatMessageDTO);
      await new Promise((r) => setImmediate(r));

      expect(sent).toHaveLength(2);
      expect((sent[1] as { channelId: string }).channelId).toBe('D-OTHER');
      svc.stop();
      await fs.rm(deps.storePath as string, { force: true });
    });
  });

  it('shows "waking up…" for an idle agent BEFORE dispatch, "is working on it…" once it holds the message, then edits in the reply', async () => {
    const { deps, sent, emit } = makeDeps({ isAgentAwake: () => false });
    const calls: string[] = [];
    deps.typing = {
      begin: async (key, id, phase) => { calls.push(`begin:${key.agentSession}:${key.slackChannelId}:${id.displayName}:${phase}`); return null; },
      setPhase: async (key, phase) => { calls.push(`phase:${key.slackChannelId}:${phase}`); },
      fail: async (key) => { calls.push(`fail:${key.slackChannelId}`); },
      resolve: async (key, text) => { calls.push(`resolve:${key.slackChannelId}:${text}`); return 'edited' as const; },
    };
    const svc = new SlackAgentDmService(deps);
    await svc.start();
    await svc.routeInbound(dm());
    emit({ id: 'm2', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: '回复' } as unknown as ChatMessageDTO);
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([
      'begin:crewly-marketing-ella-e6a6b8ea:D0C2YLU8F2A:Ella:waking',
      'phase:D0C2YLU8F2A:typing',
      'resolve:D0C2YLU8F2A:回复',
    ]);
    expect(sent).toHaveLength(0); // the typing service owns the post/edit
    svc.stop();
    await fs.rm(deps.storePath as string, { force: true });
  });

  it('an awake agent starts at "is working on it…"; a failed dispatch turns the placeholder into a failure note', async () => {
    const { deps } = makeDeps({ isAgentAwake: () => true, getDispatcher: () => ({ dispatchMessage: async () => ({ strategy: 'dm', dispatched: false }) }) as never });
    const calls: string[] = [];
    deps.typing = {
      begin: async (key, _id, phase) => { calls.push(`begin:${phase}`); return null; },
      setPhase: async (_key, phase) => { calls.push(`phase:${phase}`); },
      fail: async () => { calls.push('fail'); },
      resolve: async () => 'posted' as const,
    };
    const svc = new SlackAgentDmService(deps);
    await svc.start();
    await svc.routeInbound(dm());
    expect(calls).toEqual(['begin:typing', 'fail']);
    svc.stop();
    await fs.rm(deps.storePath as string, { force: true });
  });

  it('survives a restart: links are persisted and reloaded', async () => {
    const { deps } = makeDeps();
    const svc = new SlackAgentDmService(deps);
    await svc.start();
    await svc.routeInbound(dm());
    svc.stop();

    const again = new SlackAgentDmService(deps);
    await again.start();
    expect(again.findBySlackChannelId('D0C2YLU8F2A')?.chatChannelId).toBe('chat-ella');
    again.stop();
    await fs.rm(deps.storePath as string, { force: true });
  });
});
