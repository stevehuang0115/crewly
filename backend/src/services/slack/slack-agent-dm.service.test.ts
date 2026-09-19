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
