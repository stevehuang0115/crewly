import { OWNER_MESSAGE_WATCHDOG_CONSTANTS as C, ORCHESTRATOR_SESSION_NAME, SLACK_TYPING_CONSTANTS } from '../../constants.js';
import type { ChatChannelDTO, ChatMessageDTO } from '../chat-v2/types.js';
import type { DispatchMessageResult } from '../chat-v2/chat-v2.dispatcher.service.js';
import { OwnerMessageWatchdogService, type OwnerMessageEntry } from './owner-message-watchdog.service.js';
import { parseInboundOrigin } from '../orc/orc-reply-route.service.js';
import {
  buildNudgeMessage,
  isOwnerChatTurn,
  loginHintFor,
  nudgeAgent,
  onChatTurn,
  onSlackInbound,
  onSlackOutbound,
  postOwnerNote,
  trackInputFromDispatch,
  OWNER_WATCHDOG_NOTE_METADATA_KEY,
  type OwnerWatchdogWiringDeps,
} from './owner-message-watchdog.wiring.js';

function msg(over: Partial<ChatMessageDTO> = {}): ChatMessageDTO {
  return {
    id: 'm-1',
    channelId: 'room-1',
    seq: 1,
    senderType: 'user',
    senderId: 'steve',
    content: 'Who is working on the pricing page?',
    contentType: 'markdown',
    createdAt: 1,
    attachments: [],
    mentions: [],
    metadata: { source: 'slack', slackChannelId: 'C0ROOM', slackThreadTs: '1790.1', slackTs: '1790.1', slackUserId: 'U_OWNER' },
    ...over,
  } as ChatMessageDTO;
}

const room = { id: 'room-1', type: 'huddle', agentSession: undefined } as unknown as ChatChannelDTO;
const dm = { id: 'dm-ella', type: 'dm', agentSession: 'ella' } as unknown as ChatChannelDTO;

function huddleResult(outcomes: Array<[string, 'required' | 'optional', boolean]>): DispatchMessageResult {
  return {
    strategy: 'huddle-broadcast',
    dispatched: outcomes.some(([, , ok]) => ok),
    huddleOutcomes: outcomes.map(([sessionName, responseMode, dispatched]) => ({ sessionName, responseMode, dispatched })),
  };
}

function entry(over: Partial<OwnerMessageEntry> = {}): OwnerMessageEntry {
  return {
    key: 'slack:D0DM:1790.1',
    surface: 'slack',
    slackChannelId: 'D0DM',
    threadTs: '1790.1',
    sourceTs: '1790.1',
    chatChannelId: 'dm-ella',
    responsible: 'ella',
    recipients: ['ella'],
    required: true,
    preview: 'update the EFT sheet',
    receivedAt: 0,
    stage: 'waiting',
    ...over,
  };
}

function deps(over: Partial<OwnerWatchdogWiringDeps> = {}): OwnerWatchdogWiringDeps & {
  sent: Array<[string, string]>;
  enqueued: unknown[];
  posts: unknown[];
  notes: unknown[];
  activations: string[];
} {
  const sent: Array<[string, string]> = [];
  const enqueued: unknown[] = [];
  const posts: unknown[] = [];
  const notes: unknown[] = [];
  const activations: string[] = [];
  return {
    crewlyHome: '/tmp/unused',
    sendToAgent: async (s, t) => {
      sent.push([s, t]);
      return { success: true };
    },
    sessionExists: () => true,
    activate: async (s) => {
      activations.push(s);
      return { success: true };
    },
    enqueueForOrchestrator: (i) => {
      enqueued.push(i);
    },
    isBusy: () => false,
    loginRequired: () => null,
    slack: () => ({
      isConnected: () => true,
      sendMessage: async (m) => {
        posts.push(m);
        return '1790.9';
      },
    }),
    owesThread: () => false,
    agentDmBotToken: () => undefined,
    botTokenOf: () => undefined,
    recordChatNote: (c, t, text) => {
      notes.push({ c, t, text });
      return true;
    },
    sent,
    enqueued,
    posts,
    notes,
    activations,
    ...over,
  };
}

describe('isOwnerChatTurn', () => {
  it('accepts the owner on Slack and anyone on the portal', () => {
    expect(isOwnerChatTurn(msg(), 'U_OWNER')).toBe(true);
    expect(isOwnerChatTurn(msg(), null)).toBe(true);
    expect(isOwnerChatTurn(msg({ metadata: { source: 'web' } }), 'U_OWNER')).toBe(true);
  });

  it('a Drive mode turn is the owner\'s (priority delivery + the tool-boundary hook)', () => {
    expect(isOwnerChatTurn(msg({ metadata: { source: 'cloud-talk', inputMode: 'voice', via: 'drive-mode' } }), 'U_OWNER')).toBe(true);
  });

  it('rejects other people, agents and agent replies', () => {
    expect(isOwnerChatTurn(msg(), 'U_SOMEONE_ELSE')).toBe(false);
    expect(isOwnerChatTurn(msg({ metadata: { source: 'slack', slackUserId: 'U_OWNER', remoteAgentSession: 'avery' } }), 'U_OWNER')).toBe(false);
    expect(isOwnerChatTurn(msg({ metadata: { source: 'web', authorAgentSession: 'ella' } }), null)).toBe(false);
    expect(isOwnerChatTurn(msg({ senderType: 'agent' }), null)).toBe(false);
    expect(isOwnerChatTurn(msg({ metadata: { source: 'reply-tool' } }), null)).toBe(false);
  });
});

describe('trackInputFromDispatch', () => {
  it('Slack DM → slack surface, the DM agent responsible', () => {
    const input = trackInputFromDispatch(
      dm,
      msg({ channelId: 'dm-ella', metadata: { source: 'slack', slackChannelId: 'D0DM', slackThreadTs: '1790.1', slackTs: '1790.1', slackUserId: 'U_OWNER' } }),
      { strategy: 'dm', dispatched: true },
      { ownerSlackUserId: 'U_OWNER' },
    );
    expect(input).toEqual(
      expect.objectContaining({ surface: 'slack', slackChannelId: 'D0DM', threadTs: '1790.1', chatChannelId: 'dm-ella', responsible: 'ella', required: true }),
    );
    expect(input?.chatThreadId).toBeUndefined();
  });

  it('room: the first required recipient is responsible', () => {
    const input = trackInputFromDispatch(room, msg(), huddleResult([['owen', 'optional', true], ['ella', 'required', true]]));
    expect(input?.responsible).toBe('ella');
    expect(input?.required).toBe(true);
    expect(input?.chatThreadId).toBe('m-1');
  });

  it('room: a recipient told to stay silent by default is not waited on', () => {
    const silent: DispatchMessageResult = {
      strategy: 'huddle-broadcast',
      dispatched: true,
      huddleOutcomes: [{ sessionName: 'aria', responseMode: 'optional', dispatched: true, silentByDefault: true }],
    };
    expect(trackInputFromDispatch(room, msg(), silent, { ownerSlackUserId: 'U_OWNER', leader: 'aria' })).toBeNull();
    const mixed: DispatchMessageResult = {
      ...silent,
      huddleOutcomes: [...silent.huddleOutcomes!, { sessionName: 'ella', responseMode: 'required', dispatched: true }],
    };
    expect(trackInputFromDispatch(room, msg(), mixed, { ownerSlackUserId: 'U_OWNER', leader: 'aria' })).toEqual(
      expect.objectContaining({ responsible: 'ella', recipients: ['ella'] }),
    );
  });

  it('room, nobody required: the lead when it got it, never the orchestrator router', () => {
    const r = huddleResult([['owen', 'optional', true], ['lead', 'optional', true]]);
    expect(trackInputFromDispatch(room, msg(), r, { leader: 'lead' })?.responsible).toBe('lead');
    expect(trackInputFromDispatch(room, msg(), r, { leader: 'absent' })?.responsible).toBe('owen');
    expect(trackInputFromDispatch(room, msg(), huddleResult([[ORCHESTRATOR_SESSION_NAME, 'optional', true]]))).toBeNull();
  });

  it('nothing dispatched here (the room fallback owns it) → not tracked', () => {
    expect(trackInputFromDispatch(room, msg(), huddleResult([['ella', 'required', false]]))).toBeNull();
  });

  it('portal chat → chat surface keyed by message id', () => {
    const input = trackInputFromDispatch(dm, msg({ channelId: 'dm-ella', metadata: { source: 'web' } }), { strategy: 'dm', dispatched: true });
    expect(input).toEqual(expect.objectContaining({ surface: 'chat', chatChannelId: 'dm-ella', messageId: 'm-1', responsible: 'ella' }));
  });

  it('not the owner → not tracked', () => {
    expect(trackInputFromDispatch(room, msg(), huddleResult([['ella', 'required', true]]), { ownerSlackUserId: 'U_X' })).toBeNull();
  });
});

describe('room fallback interplay (no double wake)', () => {
  it('fallback hand-off re-dispatch updates the one entry; a single nudge follows', async () => {
    const d = deps();
    const clock = { t: 0 };
    const service = new OwnerMessageWatchdogService({
      isBusy: () => false,
      nudge: (e, w) => nudgeAgent(d, e, w),
      postNote: async () => true,
      now: () => clock.t,
    });
    // First delivery reached nobody here: not tracked (the room fallback runs).
    const none = trackInputFromDispatch(room, msg(), huddleResult([['lead', 'optional', false]]));
    expect(none).toBeNull();
    // The fallback wakes the lead and hands it the message.
    const handoff = trackInputFromDispatch(room, msg(), huddleResult([['lead', 'required', true]]));
    service.track(handoff!);
    // A second copy of the same hand-off (retry) does not add a second entry.
    service.track(handoff!);
    expect(service.size).toBe(1);
    clock.t = C.NUDGE_AFTER_MS;
    await service.tick();
    clock.t += 1000;
    await service.tick();
    expect(d.sent.filter(([s]) => s === 'lead')).toHaveLength(1);
    expect(d.activations).toHaveLength(0);
  });
});

describe('buildNudgeMessage', () => {
  it('carries the routing header, the thread tag and the reply command', () => {
    const text = buildNudgeMessage(entry(), 10);
    expect(text.startsWith('[CHAT:dm-ella]')).toBe(true);
    expect(text).toContain('[SLACK-THREAD:D0DM:1790.1]');
    expect(text).toContain('CREWLY_SESSION_NAME=ella bash config/skills/agent/core/reply/execute.sh');
    expect(text).toContain('10 分钟');
    expect(text).toContain('update the EFT sheet');
    // The reply router reads the header back as the turn origin.
    expect(parseInboundOrigin(text)).toEqual(expect.objectContaining({ conversationId: 'dm-ella' }));
  });

  it('omits the header when the transport adds its own', () => {
    expect(buildNudgeMessage(entry(), 10, { withHeader: false }).startsWith('[CHAT:')).toBe(false);
  });
});

describe('nudgeAgent', () => {
  it('sends to a running agent and records the chat thread for its reply', async () => {
    const noted: unknown[] = [];
    const d = deps({ noteOriginThread: (...a) => noted.push(a) });
    await expect(nudgeAgent(d, entry({ chatThreadId: 'root-1' }), 10)).resolves.toEqual({ outcome: 'sent' });
    expect(d.sent[0][0]).toBe('ella');
    expect(noted).toEqual([['ella', 'dm-ella', 'root-1']]);
  });

  it('wakes a stopped agent first', async () => {
    const d = deps({ sessionExists: () => false });
    await expect(nudgeAgent(d, entry(), 10)).resolves.toEqual({ outcome: 'sent' });
    expect(d.activations).toEqual(['ella']);
    expect(d.sent).toHaveLength(1);
  });

  // crewly#1015 review B2: a reminder must never start an agent the owner stopped.
  it('an agent the owner stopped is not woken: blocked (asleep), nothing sent', async () => {
    const d = deps({ sessionExists: () => false, isOwnerStopped: (s) => s === 'ella' });
    await expect(nudgeAgent(d, entry(), 10)).resolves.toEqual({ outcome: 'blocked', reason: 'asleep', detail: 'you stopped it' });
    expect(d.activations).toEqual([]);
    expect(d.sent).toHaveLength(0);
  });

  it('activation refused → blocked (asleep) with the reason', async () => {
    const d = deps({ sessionExists: () => false, activate: async () => ({ success: false, error: 'team is dormant' }) });
    await expect(nudgeAgent(d, entry(), 10)).resolves.toEqual({ outcome: 'blocked', reason: 'asleep', detail: 'team is dormant' });
    expect(d.sent).toHaveLength(0);
  });

  it('a reminder the agent\'s queue took (busy, or input held) is reported as queued, not delivered (2026-10-08 Ella)', async () => {
    const d = deps({ sendToAgent: async () => ({ success: true, queued: true }) });
    await expect(nudgeAgent(d, entry(), 10)).resolves.toEqual({ outcome: 'sent', queued: true });
  });

  it('delivery failure → blocked (error)', async () => {
    const d = deps({ sendToAgent: async () => ({ success: false, error: '404 session not found' }) });
    await expect(nudgeAgent(d, entry(), 10)).resolves.toEqual(expect.objectContaining({ outcome: 'blocked', reason: 'error' }));
  });

  it('the orchestrator is nudged through its queue with the Slack thread', async () => {
    const d = deps();
    await nudgeAgent(d, entry({ responsible: ORCHESTRATOR_SESSION_NAME, chatChannelId: 'conv-orc' }), 10);
    expect(d.sent).toHaveLength(0);
    expect(d.enqueued).toEqual([
      expect.objectContaining({ conversationId: 'conv-orc', source: 'slack', sourceMetadata: { channelId: 'D0DM', threadTs: '1790.1' } }),
    ]);
    expect((d.enqueued[0] as { content: string }).content.startsWith('[CHAT:')).toBe(false);
  });
});

describe('postOwnerNote', () => {
  it('posts in the Slack thread from the master bot, flagged as not an answer', async () => {
    const d = deps();
    await expect(postOwnerNote(d, entry({ slackChannelId: 'C0ROOM' }), 'note')).resolves.toBe(true);
    expect(d.posts).toEqual([expect.objectContaining({ channelId: 'C0ROOM', threadTs: '1790.1', text: 'note', notAnAnswer: true })]);
    expect((d.posts[0] as { botToken?: string }).botToken).toBeUndefined();
  });

  it('in an agent-owned DM uses that agent bot (the master bot cannot see it)', async () => {
    const d = deps({ agentDmBotToken: () => 'xoxb-ella' });
    await postOwnerNote(d, entry(), 'note');
    expect(d.posts[0]).toEqual(expect.objectContaining({ botToken: 'xoxb-ella' }));
  });

  it('falls back to the responsible agent bot when the master bot cannot post', async () => {
    const posts: unknown[] = [];
    const d = deps({
      botTokenOf: () => 'xoxb-ella',
      slack: () => ({
        isConnected: () => true,
        sendMessage: async (m) => {
          if (!m.botToken) throw new Error('channel_not_found');
          posts.push(m);
          return '1';
        },
      }),
    });
    await expect(postOwnerNote(d, entry({ slackChannelId: 'C0PRIV' }), 'note')).resolves.toBe(true);
    expect(posts).toEqual([expect.objectContaining({ botToken: 'xoxb-ella' })]);
  });

  it('chat entries get a system note in the channel/thread', async () => {
    const d = deps();
    await postOwnerNote(d, entry({ surface: 'chat', chatChannelId: 'huddle-1', chatThreadId: 'root-1' }), 'note');
    expect(d.notes).toEqual([{ c: 'huddle-1', t: 'root-1', text: 'note' }]);
  });
});

describe('answer signals', () => {
  it('agent chat turns answer; interim marks; the watchdog note and user turns do not', () => {
    const calls: unknown[] = [];
    const svc = { noteChatAnswer: (...a: unknown[]) => calls.push(a) } as unknown as OwnerMessageWatchdogService;
    onChatTurn(svc, msg({ senderType: 'agent', channelId: 'c1', threadId: 't1', metadata: {} }));
    onChatTurn(svc, msg({ senderType: 'agent', channelId: 'c1', metadata: { [SLACK_TYPING_CONSTANTS.INTERIM_METADATA_KEY]: true } }));
    onChatTurn(svc, msg({ senderType: 'system', channelId: 'c1', metadata: { [OWNER_WATCHDOG_NOTE_METADATA_KEY]: true } }));
    onChatTurn(svc, msg({ senderType: 'user', channelId: 'c1' }));
    expect(calls).toEqual([
      ['c1', 't1', false],
      ['c1', null, true],
    ]);
  });

  it('Slack posts answer unless flagged; colleagues on other machines answer too', () => {
    const calls: unknown[] = [];
    const svc = { noteSlackAnswer: (...a: unknown[]) => calls.push(a) } as unknown as OwnerMessageWatchdogService;
    onSlackOutbound(svc, { channelId: 'C1', threadTs: '1.1', notAnAnswer: true });
    onSlackOutbound(svc, { channelId: 'C1', threadTs: '1.1', kind: 'file' });
    onSlackInbound(svc, { channelId: 'C1', threadTs: '1.1' });
    onSlackInbound(svc, { channelId: 'C1', threadTs: '1.1', authorAgentSession: 'avery' });
    expect(calls).toEqual([
      ['C1', '1.1', 'file'],
      ['C1', '1.1', 'agent avery posted'],
    ]);
  });
});

describe('loginHintFor', () => {
  it('maps runtimes to the relogin word', () => {
    expect(loginHintFor('claude-code')).toEqual({ runtime: 'Claude', runtimeCmd: 'claude' });
    expect(loginHintFor('codex-cli')).toEqual({ runtime: 'Codex', runtimeCmd: 'codex' });
    expect(loginHintFor(null)).toEqual({ runtime: 'Claude', runtimeCmd: 'claude' });
  });
});

describe('team pause (specs/2026-10-04-team-pause.md)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const registry = require('../team/team-pause.registry.js') as typeof import('../team/team-pause.registry.js');

  beforeEach(() => {
    registry.notePausedTeam({
      id: 'team-p',
      name: 'Crewly',
      projectIds: [],
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      paused: { pausedAt: '2026-10-04T00:00:00.000Z', by: 'owner' },
      members: [{ id: 'm1', name: 'Ella', sessionName: 'ella', agentId: 'ella' }] as never,
    });
  });
  afterEach(() => registry.resetTeamPauseRegistryForTesting());

  it('a reminder never wakes a paused team\'s agent: blocked "you paused <team>", nothing sent', async () => {
    const d = deps({ sessionExists: () => false });
    await expect(nudgeAgent(d, entry(), 10)).resolves.toEqual({ outcome: 'blocked', reason: 'asleep', detail: 'you paused Crewly' });
    expect(d.activations).toEqual([]);
    expect(d.sent).toHaveLength(0);
  });

  it('is blocked even when the agent is running (owner started it while paused)', async () => {
    const d = deps({ sessionExists: () => true });
    await expect(nudgeAgent(d, entry(), 10)).resolves.toMatchObject({ outcome: 'blocked', detail: 'you paused Crewly' });
    expect(d.sent).toHaveLength(0);
  });
});
