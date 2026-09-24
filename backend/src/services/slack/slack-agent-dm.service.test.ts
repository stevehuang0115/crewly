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
import { setTicketIntakeService, type IntakeMessage, type TicketIntakeService } from '../v3/ticket-intake.service.js';

type Listener = (dto: ChatMessageDTO) => void;

function makeDeps(overrides: Partial<SlackAgentDmServiceDeps> = {}) {
  const listeners: Listener[] = [];
  const sent: unknown[] = [];
  const reactions: unknown[] = [];
  const recorded: unknown[] = [];
  const uploads: Array<Record<string, unknown>> = [];
  let uploadError: string | null = null;
  const dispatched: unknown[] = [];
  const channel = { id: 'chat-ella', type: 'dm', agentSession: 'crewly-marketing-ella-e6a6b8ea', name: 'Ella' } as unknown as ChatChannelDTO;
  const deps: SlackAgentDmServiceDeps = {
    slack: {
      isConnected: () => true,
      sendMessage: async (m) => { sent.push(m); return '1.2'; },
      addReaction: async (...a) => { reactions.push(a); },
      uploadFile: async (o: Record<string, unknown>) => {
        if (uploadError) throw new Error(uploadError);
        uploads.push(o);
        return { fileId: `F${uploads.length}` };
      },
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
  return { deps, listeners, sent, reactions, recorded, dispatched, uploads, setUploadError: (e: string | null) => { uploadError = e; }, emit: (dto: ChatMessageDTO) => { for (const l of [...listeners]) l(dto); } };
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

  describe('ticket loop intake', () => {
    const TICKET = { id: '11111111-2222-3333-4444-555555555555', ticketNumber: 21 };
    afterEach(() => setTicketIntakeService(null));

    it('the owner\'s DM becomes a ticket assigned to the agent; receipt under the agent\'s bot; the agent gets the marker', async () => {
      const intake = { intakeWithOutcome: jest.fn(async () => ({ action: 'created', ticket: TICKET })) };
      setTicketIntakeService(intake as unknown as TicketIntakeService);
      const seen: ChatMessageDTO[] = [];
      const { deps } = makeDeps({
        getOwnerUserId: () => 'U-steve',
        getDispatcher: () => ({ dispatchMessage: async (_c: ChatChannelDTO, m: ChatMessageDTO) => { seen.push(m); return { strategy: 'dm', dispatched: true }; } }) as never,
      });
      const svc = new SlackAgentDmService(deps);
      await svc.routeInbound(dm({ text: '帮我把周报的格式改成表格' }));
      const [msg] = intake.intakeWithOutcome.mock.calls[0] as unknown as [IntakeMessage];
      expect(msg).toMatchObject({
        isOwner: true,
        targetAgent: 'crewly-marketing-ella-e6a6b8ea',
        origin: { channel: 'slack-dm', ref: 'slackdm-D0C2YLU8F2A-1789781178.423669' },
        receipt: { kind: 'slack', slackChannelId: 'D0C2YLU8F2A', threadTs: '1789781178.423669', postAs: 'crewly-marketing-ella-e6a6b8ea' },
      });
      expect(String(seen[0].metadata?.ticketMarker)).toContain('[TICKET:TKT-021');
      await fs.rm(deps.storePath as string, { force: true });
    });

    it('a DM from someone other than the owner is not the owner\'s', async () => {
      const intake = { intakeWithOutcome: jest.fn(async () => ({ action: 'ignored', reason: 'not_owner' })) };
      setTicketIntakeService(intake as unknown as TicketIntakeService);
      const { deps, dispatched } = makeDeps({ getOwnerUserId: () => 'U-owner' });
      const svc = new SlackAgentDmService(deps);
      await svc.routeInbound(dm());
      expect((intake.intakeWithOutcome.mock.calls[0] as unknown as [IntakeMessage])[0].isOwner).toBe(false);
      expect(dispatched).toHaveLength(1);
      await fs.rm(deps.storePath as string, { force: true });
    });
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
    // A top-level DM question opens a thread under itself, so a long
    // conversation reads as exchanges rather than one flat column
    // (owner, 2026-09-21).
    expect((sent[0] as { threadTs?: string }).threadTs).toBe('1789781178.423669');

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

  it('puts the placeholder for a new top-level DM in the thread the reply goes to, so the reply replaces it', async () => {
    // The placeholder used to sit at the top level while the reply went into
    // the message's thread under another key: never replaced, and later
    // turned into "still working on this" next to an answered thread.
    const { deps, sent, emit } = makeDeps();
    const calls: string[] = [];
    deps.typing = {
      begin: async (key) => { calls.push(`begin:${key.threadTs}`); return null; },
      setPhase: async () => undefined,
      fail: async () => undefined,
      resolve: async (key, text) => { calls.push(`resolve:${key.threadTs}`); sent.push({ channelId: key.slackChannelId, text, threadTs: key.threadTs }); return 'replaced' as const; },
    };
    const svc = new SlackAgentDmService(deps);
    await svc.start();

    await svc.routeInbound(dm({ ts: '7.0' }));
    emit({ id: 'm3', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: 'done' } as unknown as ChatMessageDTO);
    await new Promise((r) => setImmediate(r));

    expect(calls).toEqual(['begin:7.0', 'resolve:7.0']);
    svc.stop();
    await fs.rm(deps.storePath as string, { force: true });
  });

  it('an interim note is posted and the working placeholder comes back under it (owner, 2026-09-24)', async () => {
    const { deps, emit } = makeDeps();
    const calls: string[] = [];
    deps.typing = {
      begin: async (key, _id, phase) => { calls.push(`begin:${key.threadTs}:${phase}`); return null; },
      setPhase: async () => undefined,
      fail: async () => undefined,
      resolve: async (key, text) => { calls.push(`resolve:${key.threadTs}:${text}`); return 'replaced' as const; },
    };
    const svc = new SlackAgentDmService(deps);
    await svc.start();
    await svc.routeInbound(dm({ ts: '8.0' }));
    emit({ id: 'i1', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: '收到，计划：…', metadata: { interim: true } } as unknown as ChatMessageDTO);
    await new Promise((r) => setImmediate(r));
    emit({ id: 'f1', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: '做好了' } as unknown as ChatMessageDTO);
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(['begin:8.0:typing', 'resolve:8.0:收到，计划：…', 'begin:8.0:typing', 'resolve:8.0:做好了']);
    svc.stop();
    await fs.rm(deps.storePath as string, { force: true });
  });

  it('keeps an already-threaded question in its own thread, and the placeholder with it', async () => {
    const { deps, sent, emit } = makeDeps();
    const calls: string[] = [];
    deps.typing = {
      begin: async (key) => { calls.push(`begin:${key.threadTs}`); return null; },
      setPhase: async () => undefined,
      fail: async () => undefined,
      resolve: async (key, text) => { calls.push(`resolve:${key.threadTs}`); sent.push({ channelId: key.slackChannelId, text, threadTs: key.threadTs }); return 'posted' as const; },
    };
    const svc = new SlackAgentDmService(deps);
    await svc.start();

    await svc.routeInbound(dm({ ts: '5.0', threadTs: '1.0' }));
    emit({ id: 'm2', channelId: 'chat-ella', senderType: 'agent', senderId: 'crewly-marketing-ella-e6a6b8ea', content: 'in the same thread' } as unknown as ChatMessageDTO);
    await new Promise((r) => setImmediate(r));

    // The existing thread wins over the message's own ts.
    expect(calls).toEqual(['begin:1.0', 'resolve:1.0']);
    expect((sent.at(-1) as { threadTs?: string }).threadTs).toBe('1.0');
    svc.stop();
    await fs.rm(deps.storePath as string, { force: true });
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

  describe('attachFileForAgent', () => {
    it('uploads into the Slack DM, as the agent, in the reply thread', async () => {
      // The DM is the path most single-agent conversations take, and the one
      // that had an agent sending a Drive link because its reply interface
      // could only carry text.
      const { deps, uploads } = makeDeps();
      const svc = new SlackAgentDmService(deps);
      await svc.start();
      await svc.routeInbound(dm());

      const result = await svc.attachFileForAgent({
        chatChannelId: 'chat-ella',
        agentSession: 'crewly-marketing-ella-e6a6b8ea',
        filePath: '/tmp/proposal.pdf',
        comment: '第 3 节改了',
      });

      expect(result.ok).toBe(true);
      expect(uploads).toHaveLength(1);
      expect(uploads[0]).toMatchObject({
        channelId: 'D0C2YLU8F2A',
        filePath: '/tmp/proposal.pdf',
        initialComment: '第 3 节改了',
        botToken: 'xoxb-ella',
      });
      // Beside its words, not at the bottom of the conversation.
      expect(uploads[0].threadTs).toBeDefined();

      svc.stop();
      await fs.rm(deps.storePath as string, { force: true });
    });

    it('refuses a chat channel that is not a DM link', async () => {
      const { deps, uploads } = makeDeps();
      const svc = new SlackAgentDmService(deps);
      await svc.start();

      const result = await svc.attachFileForAgent({
        chatChannelId: 'some-other-channel',
        agentSession: 'crewly-marketing-ella-e6a6b8ea',
        filePath: '/tmp/x.pdf',
      });

      expect(result).toEqual({ ok: false, reason: 'not_a_slack_channel' });
      expect(uploads).toHaveLength(0);
      svc.stop();
      await fs.rm(deps.storePath as string, { force: true });
    });

    it('says when the agent has no Slack bot of its own', async () => {
      // There is no workspace-bot fallback here: a DM with the agent's bot
      // only exists because that bot exists.
      const { deps } = makeDeps({
        identities: { getInstalled: () => null } as unknown as SlackAgentDmServiceDeps['identities'],
      });
      const svc = new SlackAgentDmService(deps);
      await svc.start();
      await svc.routeInbound(dm());

      const result = await svc.attachFileForAgent({
        chatChannelId: 'chat-ella',
        agentSession: 'crewly-marketing-ella-e6a6b8ea',
        filePath: '/tmp/x.pdf',
      });

      expect(result).toEqual({ ok: false, reason: 'agent_has_no_slack_bot' });
      svc.stop();
      await fs.rm(deps.storePath as string, { force: true });
    });

    it('surfaces an upload failure instead of throwing', async () => {
      const { deps, setUploadError } = makeDeps();
      const svc = new SlackAgentDmService(deps);
      await svc.start();
      await svc.routeInbound(dm());
      setUploadError('file too large');

      const result = await svc.attachFileForAgent({
        chatChannelId: 'chat-ella',
        agentSession: 'crewly-marketing-ella-e6a6b8ea',
        filePath: '/tmp/huge.pdf',
      });

      expect(result).toEqual({ ok: false, reason: 'file too large' });
      svc.stop();
      await fs.rm(deps.storePath as string, { force: true });
    });
  });
});
