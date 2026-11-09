import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TurnOrigin } from './orc-reply-route.service.js';
import type { PromptReference } from './agent-prompt-reference.service.js';
import {
  fixCommand,
  latestInputOf,
  resolveReplyDestination,
  threadOfMessage,
  validateHints,
  type LatestInput,
  type ReplyResolverDeps,
  type ResolverChatMessage,
  type ResolverDecision,
  type ResolverRequestTicket,
} from './reply-destination-resolver.js';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const MIN = 60 * 1000;

/** #pro-ce (team channel) ↔ huddle `room-ce`; #crewly-marketing ↔ `room-mkt`. */
const PRO_CE = 'C0C2Y1FRCP7';
const PRO_CE_TS = '1790897084.888289';
const MKT = 'C0MKT000001';

interface World {
  messages?: ResolverChatMessage[];
  members?: Record<string, string[]>;
  slackOf?: Record<string, string>;
  roots?: Record<string, string>;
  tickets?: ResolverRequestTicket[];
  projectTickets?: Record<string, { projectPath: string; ticketId: string; title?: string }>;
  decisions?: ResolverDecision[];
  items?: WorkItem[];
  origin?: TurnOrigin;
  prompt?: PromptReference;
  dm?: string | null;
  owes?: boolean;
  lastDelivered?: string;
  surfaced?: string[];
  latest?: LatestInput | null;
}

function deps(w: World = {}): ReplyResolverDeps {
  const slackOf = w.slackOf ?? { 'room-ce': PRO_CE, 'room-mkt': MKT };
  const members = w.members ?? { 'room-ce': ['owen'], 'room-mkt': ['owen', 'ella'], 'dm-owen': ['owen'] };
  return {
    getMessage: (id) => (w.messages ?? []).find((m) => m.id === id) ?? null,
    ownsConversation: async (s, c) => (members[c] ?? []).includes(s),
    slackChannelOfConversation: (c) => slackOf[c] ?? null,
    conversationOfSlackThread: (ch, ts) => {
      const conv = Object.keys(slackOf).find((c) => slackOf[c] === ch);
      if (!conv) return null;
      const root = (w.roots ?? {})[`${ch}:${ts}`];
      return { conversationId: conv, ...(root ? { threadRootId: root } : {}) };
    },
    requestTicket: async (n) => (w.tickets ?? []).find((t) => t.label === `TKT-${String(n).padStart(3, '0')}`) ?? null,
    projectTicket: async (_s, id) => (w.projectTickets ?? {})[id] ?? null,
    decision: async (id) => (w.decisions ?? []).find((d) => d.id === id) ?? null,
    workItem: async (id) => (w.items ?? []).find((i) => i.id === id) ?? null,
    poolItems: async () => w.items ?? [],
    turnOrigin: () => w.origin,
    promptReference: () => w.prompt,
    owesOwner: () => w.owes === true,
    lastDelivered: () => w.lastDelivered,
    ownerDm: async () => (w.dm === undefined ? 'dm-owen' : w.dm),
    surfacedOwnerConversations: () => w.surfaced ?? [],
    latestInput: () => w.latest ?? null,
    now: () => NOW,
  };
}

function wi(over: Partial<WorkItem>): WorkItem {
  return {
    id: 'wi-1',
    type: 'delegate',
    owner: 'system',
    target: 'owen',
    title: 'Work',
    status: 'running',
    createdAt: new Date(NOW - 30 * MIN).toISOString(),
    startedAt: new Date(NOW - 30 * MIN).toISOString(),
    retryCount: 0,
    maxRetries: 3,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    ...over,
  } as WorkItem;
}

/** The follow-up item TKT-187 carried: blocked, with the #pro-ce origin. */
const followUp = wi({
  id: 'fu-187',
  status: 'blocked',
  title: 'Follow-up for the owner (TKT-187)',
  metadata: { origin: { kind: 'owner', conversationId: 'room-ce', slackChannelId: PRO_CE, threadTs: PRO_CE_TS, chatThreadId: 'root-ce' } },
});
/** An unrelated cron item, newest running. */
const cronItem = wi({ id: 'cron-1', type: 'cron_run', title: 'daily digest', startedAt: new Date(NOW - 2 * MIN).toISOString(), metadata: { origin: { kind: 'trigger', triggerId: 't1', topic: 'daily digest' } } });
/** Owen's last owner turn: the unrelated #crewly-marketing huddle. */
const mktOrigin: TurnOrigin = { conversationId: 'room-mkt', slackChannelId: MKT, slackThreadTs: '1790890000.000100', slackThreadKey: `${MKT}:1790890000.000100`, receivedAt: NOW - 20 * MIN };

describe('resolveReplyDestination — order', () => {
  it('1. a referenced message wins over everything', async () => {
    const r = await resolveReplyDestination(
      { session: 'owen', reference: { messageId: 'm-1' }, hints: { conversationId: 'room-mkt' } },
      deps({ messages: [{ id: 'm-1', channelId: 'room-ce', threadId: 'root-ce', metadata: { slackThreadTs: PRO_CE_TS } }], origin: mktOrigin }),
    );
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-ce', thread: `${PRO_CE}:${PRO_CE_TS}`, source: 'message' }));
  });

  it('2. a request ticket goes to its chat thread (Slack key when it has one)', async () => {
    const r = await resolveReplyDestination(
      { session: 'owen', reference: { ticket: 'TKT-187' } },
      deps({ tickets: [{ id: 'req-187', label: 'TKT-187', conversationId: 'room-ce', threadRootId: 'root-ce', slackChannelId: PRO_CE, threadTs: PRO_CE_TS }], origin: mktOrigin }),
    );
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-ce', thread: `${PRO_CE}:${PRO_CE_TS}`, source: 'ticket' }));
  });

  it('2. a project ticket goes to the ticket-thread binding (created on first post)', async () => {
    const r = await resolveReplyDestination(
      { session: 'owen', reference: { ticket: 'CE-7' } },
      deps({ projectTickets: { 'CE-7': { projectPath: '/p/ce', ticketId: 'CE-7', title: 'Visa page' } } }),
    );
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'work', source: 'ticket', destination: expect.objectContaining({ kind: 'ticket-thread', projectPath: '/p/ce', ticketId: 'CE-7' }) }));
  });

  it('2. a decision goes to its card thread, only for its asker', async () => {
    const decisions: ResolverDecision[] = [{ id: 'D-12', asker: 'owen', slackChannelId: PRO_CE, threadTs: PRO_CE_TS }];
    const ok = await resolveReplyDestination({ session: 'owen', reference: { decisionId: 'D-12' } }, deps({ decisions }));
    expect(ok.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-ce', thread: `${PRO_CE}:${PRO_CE_TS}`, source: 'decision' }));
    const other = await resolveReplyDestination({ session: 'ella', reference: { decisionId: 'D-12' } }, deps({ decisions }));
    expect(other.destination.kind).toBe('unresolved');
  });

  it('3. a referenced work item goes to its origin even when it is blocked', async () => {
    const r = await resolveReplyDestination({ session: 'owen', reference: { workItemId: 'fu-187' } }, deps({ items: [followUp, cronItem], origin: mktOrigin }));
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-ce', thread: `${PRO_CE}:${PRO_CE_TS}`, source: 'work-item' }));
  });

  it('an explicit reference that does not resolve is an error with the command to run — never a guess', async () => {
    const r = await resolveReplyDestination({ session: 'owen', reference: { ticket: 'TKT-999' } }, deps({ origin: mktOrigin }));
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'unresolved', reason: 'there is no ticket TKT-999' }));
    expect((r.destination as { fix: string }).fix).toBe('reply "<your message>"');
  });

  it('5. the reference the harness last prompted about beats an unrelated newest-running trigger item', async () => {
    const r = await resolveReplyDestination(
      { session: 'owen' },
      deps({ items: [followUp, cronItem], tickets: [{ id: 'req-187', label: 'TKT-187', conversationId: 'room-ce', threadRootId: 'root-ce', slackChannelId: PRO_CE, threadTs: PRO_CE_TS }], prompt: { reference: { ticket: 'TKT-187', workItemId: 'fu-187' }, at: NOW - 5 * MIN, marker: '[FOLLOW-UP TKT-187]' }, lastDelivered: '[FOLLOW-UP TKT-187] The work you promised…' }),
    );
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-ce', source: 'prompt' }));
  });

  it('5. an owner message delivered after the prompt wins (the prompt is no longer the last thing delivered)', async () => {
    const r = await resolveReplyDestination(
      { session: 'owen' },
      deps({ tickets: [{ id: 'req-187', label: 'TKT-187', conversationId: 'room-ce', threadRootId: 'root-ce' }], prompt: { reference: { ticket: 'TKT-187' }, at: NOW - 30 * MIN, marker: '[FOLLOW-UP TKT-187]' }, origin: mktOrigin, lastDelivered: `[CHAT:room-mkt] <steve@Owen> huddle notes?`, latest: { kind: 'owner', conversationId: 'room-mkt', at: NOW - 1 * MIN } }),
    );
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-mkt', source: 'turn-origin' }));
  });

  it('6. an owner message from another conversation shown mid-turn: a bare reply is not guessed', async () => {
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ origin: mktOrigin, owes: true, surfaced: ['room-ce'], latest: { kind: 'owner', conversationId: 'room-mkt', at: NOW - 1 * MIN } }));
    expect(r.destination.kind).toBe('unresolved');
    if (r.destination.kind === 'unresolved') {
      expect(r.destination.reason).toContain('room-ce');
      expect(r.destination.reason).toContain('room-mkt');
      expect(r.destination.fix).toContain('--conversation room-ce');
    }
  });

  it('6. a mid-turn owner message in the same conversation does not block the turn-origin reply', async () => {
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ origin: mktOrigin, owes: true, surfaced: ['room-mkt'], latest: { kind: 'owner', conversationId: 'room-mkt', at: NOW - 1 * MIN } }));
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-mkt', source: 'turn-origin' }));
  });

  // Message-routing audit 2026-10-18: this used to name only the conversation
  // and post at the Slack channel's top level. A Slack channel now needs its
  // thread named (or the owner message being answered must be in it).
  it('6. an explicit conversation and thread still go through while a mid-turn owner message is open', async () => {
    const r = await resolveReplyDestination(
      { session: 'owen', hints: { conversationId: 'room-ce', thread: `${PRO_CE}:${PRO_CE_TS}` } },
      deps({ origin: mktOrigin, owes: true, surfaced: ['room-ce'] }),
    );
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-ce', thread: `${PRO_CE}:${PRO_CE_TS}` }));
  });

  it('a Slack-channel conversation named without a thread is refused, never posted at the top level', async () => {
    const r = await resolveReplyDestination({ session: 'owen', hints: { conversationId: 'room-ce' } }, deps({ origin: mktOrigin, owes: true, surfaced: ['room-ce'] }));
    expect(r.destination.kind).toBe('unresolved');
    if (r.destination.kind === 'unresolved') expect(r.destination.reason).toContain('name the thread with --thread');
  });

  it('5. a stale prompt never hijacks an owed answer: 10:00 owner question, 10:02 TKT-150 nudge → the bare reply answers the question', async () => {
    const q: TurnOrigin = { conversationId: 'room-mkt', slackChannelId: MKT, slackThreadTs: '1790890000.000100', slackThreadKey: `${MKT}:1790890000.000100`, receivedAt: NOW - 2 * MIN };
    const r = await resolveReplyDestination(
      { session: 'owen' },
      deps({
        tickets: [{ id: 'req-150', label: 'TKT-150', conversationId: 'room-ce', threadRootId: 'root-150' }],
        // The nudge IS the last thing delivered — but Owen still owes the owner the 10:00 answer.
        prompt: { reference: { ticket: 'TKT-150' }, at: NOW, marker: '[FOLLOW-UP TKT-150]' },
        lastDelivered: '[FOLLOW-UP TKT-150] You promised the owner…',
        owes: true,
        origin: q,
        // The owner's question is the latest input that names what Owen answers
        // (the nudge is not a routed input).
        latest: { kind: 'owner', conversationId: 'room-mkt', at: NOW - 2 * MIN },
      }),
    );
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-mkt', source: 'turn-origin' }));
  });

  // These fell to the owner DM before; there is no such guess any more
  // (message-routing audit 2026-10-18): unused prompt → refused.
  it('5. a prompt reference without a marker, or recorded but not delivered last, is not used', async () => {
    const tickets = [{ id: 'req-150', label: 'TKT-150', conversationId: 'room-ce', threadRootId: 'root-150' }];
    const noMarker = await resolveReplyDestination({ session: 'owen' }, deps({ tickets, prompt: { reference: { ticket: 'TKT-150' }, at: NOW }, lastDelivered: '[FOLLOW-UP TKT-150] x' }));
    expect(noMarker.destination.kind).toBe('unresolved');
    const notLast = await resolveReplyDestination({ session: 'owen' }, deps({ tickets, prompt: { reference: { ticket: 'TKT-150' }, at: NOW, marker: '[FOLLOW-UP TKT-150]' }, lastDelivered: '[DECISION D-3] other' }));
    expect(notLast.destination.kind).toBe('unresolved');
  });

  it('6. without references or hints: the current work (a scheduled item → its own destination)', async () => {
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ items: [cronItem] }));
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'work', source: 'current-work', destination: expect.objectContaining({ kind: 'new-top-level', topic: 'daily digest' }) }));
  });

  // Message-routing audit 2026-10-18 (R1/R2): "nothing at all" used to post
  // in the owner DM, or at a team channel's top level with no DM. Both were
  // guesses. Now the reply is refused with the ids that would work.
  it('7. nothing at all → refused with the command to run, never the owner DM or a top-level post', async () => {
    for (const w of [deps(), deps({ dm: null })]) {
      const r = await resolveReplyDestination({ session: 'owen' }, w);
      expect(r.destination.kind).toBe('unresolved');
      if (r.destination.kind === 'unresolved') {
        expect(r.destination.reason).toContain('nothing you were given names where this reply goes');
        expect(r.destination.fix).toContain('reply --to <message id');
      }
    }
    const noDm = await resolveReplyDestination({ session: 'owen', noOwnerDm: true }, deps());
    expect(noDm.destination.kind).toBe('unresolved');
  });

  it('7. the owner\'s last thread is offered as a command, not used', async () => {
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ origin: mktOrigin }));
    expect(r.destination.kind).toBe('unresolved');
    if (r.destination.kind === 'unresolved') expect(r.destination.fix).toContain(`reply --conversation room-mkt --thread ${MKT}:1790890000.000100`);
  });

  it('7. several live work items and no input naming one → refused listing each id (never the newest)', async () => {
    const a = wi({ id: 'wi-a', title: 'A', metadata: { origin: { kind: 'owner', conversationId: 'room-ce', slackChannelId: PRO_CE, threadTs: PRO_CE_TS } } });
    const b = wi({ id: 'wi-b', title: 'B', startedAt: new Date(NOW - 1 * MIN).toISOString(), metadata: { origin: { kind: 'owner', conversationId: 'room-mkt', slackChannelId: MKT, threadTs: '1.0' } } });
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ items: [a, b] }));
    expect(r.destination.kind).toBe('unresolved');
    if (r.destination.kind === 'unresolved') {
      expect(r.destination.reason).toContain('2 live work items');
      expect(r.destination.fix).toContain('reply --work-item wi-a');
      expect(r.destination.fix).toContain('reply --work-item wi-b');
    }
  });

  it('7. one live work item with no origin → refused, never a top-level post', async () => {
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ items: [wi({ id: 'wi-bare' })] }));
    expect(r.destination.kind).toBe('unresolved');
    if (r.destination.kind === 'unresolved') expect(r.destination.reason).toContain('work item wi-bare names no conversation or thread');
  });
});

// crewly#1375 (2026-10-18): Pia answered the owner's Shaw Brothers thread at
// 11:53; Atlas then sent her a message; her bare `reply` resolved to
// "turn-origin: the owner asked (no work item running)" — the owner's thread.
describe('crewly#1375 — a newer input from someone else than the owner', () => {
  const ATLAS = 'think-tank-atlas-b4e166f6';
  const ownerAsked: TurnOrigin = { ...mktOrigin, receivedAt: NOW - 3 * MIN };
  const fromAtlas: LatestInput = { kind: 'agent', sender: ATLAS, at: NOW - 1 * MIN };

  it('a bare reply after an agent message goes back to that agent, not the owner thread', async () => {
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ origin: ownerAsked, latest: fromAtlas }));
    expect(r.destination).toEqual(
      expect.objectContaining({ kind: 'work', source: 'agent-message', destination: expect.objectContaining({ kind: 'agent', sessionName: ATLAS }) }),
    );
  });

  it('owing the owner too: refused with both commands', async () => {
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ origin: ownerAsked, latest: fromAtlas, owes: true }));
    expect(r.destination.kind).toBe('unresolved');
    if (r.destination.kind === 'unresolved') {
      expect(r.destination.fix).toContain(`send-message --to ${ATLAS}`);
      expect(r.destination.fix).toContain('reply --conversation room-mkt');
    }
  });

  it('an owner message shown mid-turn: refused as well', async () => {
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ origin: ownerAsked, latest: fromAtlas, surfaced: ['room-ce'] }));
    expect(r.destination.kind).toBe('unresolved');
  });

  it('holding work whose answer goes elsewhere: refused with the work-item command', async () => {
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ latest: fromAtlas, items: [cronItem] }));
    expect(r.destination.kind).toBe('unresolved');
    if (r.destination.kind === 'unresolved') expect(r.destination.fix).toContain('reply --work-item cron-1');
  });

  it('work delegated by that same agent: the answer goes to it', async () => {
    const delegated = wi({ id: 'wi-atlas', metadata: { origin: { kind: 'agent', sessionName: ATLAS } } });
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ latest: fromAtlas, items: [delegated] }));
    expect(r.destination).toEqual(expect.objectContaining({ source: 'agent-message' }));
  });

  it('explicit references and hints still win over the agent message', async () => {
    const r = await resolveReplyDestination({ session: 'owen', hints: { conversationId: 'room-mkt', thread: `${MKT}:1790890000.000100` } }, deps({ origin: ownerAsked, latest: fromAtlas }));
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-mkt', source: 'hint' }));
  });

  it('an owner message after the agent message: the turn origin again', async () => {
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ origin: ownerAsked, latest: { kind: 'owner', at: NOW } }));
    expect(r.destination).toEqual(expect.objectContaining({ conversationId: 'room-mkt', source: 'turn-origin' }));
  });

  it('a dispatch newer than the owner turn origin: no guess into the owner thread', async () => {
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ origin: ownerAsked, latest: { kind: 'dispatch', at: NOW - 1 * MIN } }));
    expect(r.destination.kind).toBe('unresolved');
    if (r.destination.kind === 'unresolved') expect(r.destination.fix).toContain('reply --conversation room-mkt');
  });

  // Message-routing audit 2026-10-18: these fell back to the turn origin (the
  // owner's last thread). Only the latest ROUTED input counts now: when the
  // owner message is newer it is the latest input itself (first case), and a
  // dispatch naming no work item, or a reminder, names no place: refused.
  it('the owner message newer than a dispatch is the input answered; a dispatch or reminder naming nothing is refused', async () => {
    const owner = await resolveReplyDestination({ session: 'owen' }, deps({ origin: ownerAsked, latest: { kind: 'owner', conversationId: 'room-mkt', at: NOW - 3 * MIN } }));
    expect(owner.destination).toEqual(expect.objectContaining({ source: 'turn-origin', conversationId: 'room-mkt' }));
    const older = await resolveReplyDestination({ session: 'owen' }, deps({ origin: ownerAsked, latest: { kind: 'dispatch', at: NOW - 10 * MIN } }));
    expect(older.destination.kind).toBe('unresolved');
    const other = await resolveReplyDestination({ session: 'owen' }, deps({ origin: ownerAsked, latest: { kind: 'other', at: NOW } }));
    expect(other.destination.kind).toBe('unresolved');
    if (other.destination.kind === 'unresolved') expect(other.destination.fix).toContain('reply --conversation room-mkt');
  });

  it('a dispatch naming its work item answers that item', async () => {
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ items: [followUp, cronItem], latest: { kind: 'dispatch', workItemId: 'fu-187', at: NOW - 1 * MIN } }));
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-ce', thread: `${PRO_CE}:${PRO_CE_TS}` }));
  });
});

describe('TKT-187 — Owen: reply-chat --thread <#pro-ce key>, no conversation', () => {
  it('lands in the #pro-ce thread, not the newer unrelated #crewly-marketing conversation', async () => {
    const r = await resolveReplyDestination(
      { session: 'owen', hints: { thread: `${PRO_CE}:${PRO_CE_TS}` } },
      deps({ items: [followUp, cronItem], origin: mktOrigin, roots: { [`${PRO_CE}:${PRO_CE_TS}`]: 'root-ce' } }),
    );
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-ce', thread: `${PRO_CE}:${PRO_CE_TS}`, source: 'hint' }));
    expect(r.ignoredHints).toEqual([]);
  });
});

describe('validateHints — agent ids are hints only', () => {
  it('a thread key from another channel than the named conversation is rejected for that conversation', async () => {
    const v = await validateHints('owen', { conversationId: 'room-mkt', thread: `${PRO_CE}:${PRO_CE_TS}` }, undefined, deps());
    // The key alone still names a conversation Owen is in: that one, not room-mkt.
    expect(v.destination).toEqual(expect.objectContaining({ conversationId: 'room-ce', thread: `${PRO_CE}:${PRO_CE_TS}` }));
    expect(v.ignored).toEqual([expect.objectContaining({ hint: 'conversation room-mkt' })]);
  });

  it('a key whose conversation the agent is not in is ignored (and logged), never re-pointed', async () => {
    const v = await validateHints('ella', { thread: `${PRO_CE}:${PRO_CE_TS}` }, undefined, deps());
    expect(v.destination).toBeNull();
    expect(v.ignored[0]).toEqual(expect.objectContaining({ why: 'you are not in the conversation of that thread' }));
  });

  it('a key for a channel no conversation knows is ignored', async () => {
    const v = await validateHints('owen', { thread: 'C0NOWHERE1:1790000000.000100' }, undefined, deps());
    expect(v.destination).toBeNull();
    expect(v.ignored[0].why).toBe('no known conversation has that Slack thread');
  });

  it('slack-post: a --target that differs from the key\'s channel is ignored', async () => {
    const v = await validateHints('owen', { thread: `${PRO_CE}:${PRO_CE_TS}`, slackChannelId: MKT }, undefined, deps());
    expect(v.destination).toEqual(expect.objectContaining({ conversationId: 'room-ce' }));
    expect(v.ignored[0].hint).toBe(`target ${MKT}`);
  });

  it('a conversation the agent is not in is an error, never a guessed place (#1136)', async () => {
    const r = await resolveReplyDestination({ session: 'ella', hints: { conversationId: 'room-ce' } }, deps({ origin: { ...mktOrigin } }));
    expect(r.ignoredHints[0]).toEqual(expect.objectContaining({ hint: 'conversation room-ce' }));
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'unresolved', reason: expect.stringContaining('conversation room-ce') }));
  });

  it('a thread key the agent is not in is an error even with a turn origin (#1136)', async () => {
    const r = await resolveReplyDestination({ session: 'ella', hints: { thread: `${PRO_CE}:${PRO_CE_TS}` } }, deps({ origin: { ...mktOrigin } }));
    expect(r.destination.kind).toBe('unresolved');
  });

  it('its own conversation with no thread takes the origin thread when the origin is there', async () => {
    const v = await validateHints('owen', { conversationId: 'room-mkt' }, mktOrigin, deps());
    expect(v.destination).toEqual(expect.objectContaining({ conversationId: 'room-mkt', thread: mktOrigin.slackThreadKey }));
  });

  it('a chat-v2 message id as thread must be in the named conversation', async () => {
    const d = deps({ messages: [{ id: 'm-ce', channelId: 'room-ce' }] });
    const bad = await validateHints('owen', { conversationId: 'room-mkt', thread: 'm-ce' }, undefined, d);
    expect(bad.destination).toBeNull();
    const good = await validateHints('owen', { thread: 'm-ce' }, undefined, d);
    expect(good.destination).toEqual(expect.objectContaining({ conversationId: 'room-ce', thread: 'm-ce' }));
  });
});

describe('validateHints — a delegate outside the room (Kai, #daily-info, 2026-10-18)', () => {
  const kaiWork = wi({
    id: 'wi-kai',
    target: 'kai',
    metadata: { origin: { kind: 'owner', conversationId: 'room-ce', slackChannelId: PRO_CE, threadTs: PRO_CE_TS, chatThreadId: 'root-ce' } },
  });
  const delegatedTo = (who: string) => async (s: string, ch: string, ts: string) => s === who && ch === PRO_CE && ts === PRO_CE_TS;
  const world = (extra: Partial<ReplyResolverDeps> = {}): ReplyResolverDeps => ({
    ...deps({ messages: [{ id: 'root-ce', channelId: 'room-ce', metadata: { slackThreadTs: PRO_CE_TS } }], items: [kaiWork] }),
    delegatedThread: delegatedTo('kai'),
    ...extra,
  });

  it('a chat thread id of the delegated thread resolves to that Slack thread', async () => {
    const v = await validateHints('kai', { conversationId: 'room-ce', thread: 'root-ce' }, undefined, world());
    expect(v.destination).toEqual(expect.objectContaining({ kind: 'work', destination: expect.objectContaining({ kind: 'slack', target: PRO_CE, threadTs: PRO_CE_TS }) }));
  });

  it('the conversation alone resolves to the thread the current work came from, never its top level', async () => {
    const v = await validateHints('kai', { conversationId: 'room-ce' }, undefined, world());
    expect(v.destination).toEqual(expect.objectContaining({ kind: 'work', destination: expect.objectContaining({ target: PRO_CE, threadTs: PRO_CE_TS }) }));
  });

  it('an agent the thread was not delegated to stays unresolved', async () => {
    const d = world({ delegatedThread: delegatedTo('someone-else') });
    expect((await validateHints('kai', { conversationId: 'room-ce', thread: 'root-ce' }, undefined, d)).destination).toBeNull();
    const v = await validateHints('kai', { conversationId: 'room-ce' }, undefined, d);
    expect(v.destination).toBeNull();
    expect(v.ignored).toEqual([expect.objectContaining({ hint: 'conversation room-ce', why: 'not a conversation you are in' })]);
  });

  it('two pieces of open work from different threads of the room: no guess (the newest is not picked)', async () => {
    const second = wi({
      id: 'wi-kai-2',
      target: 'kai',
      startedAt: new Date(NOW - MIN).toISOString(),
      metadata: { origin: { kind: 'owner', conversationId: 'room-ce', slackChannelId: PRO_CE, threadTs: '1790900000.000200' } },
    });
    const d = { ...world(), poolItems: async () => [kaiWork, second], delegatedThread: async () => true };
    expect((await validateHints('kai', { conversationId: 'room-ce' }, undefined, d)).destination).toBeNull();
  });

  it('current work from another conversation does not steer a conversation-only hint', async () => {
    const other = wi({ id: 'wi-kai', target: 'kai', metadata: { origin: { kind: 'owner', conversationId: 'room-mkt', slackChannelId: MKT, threadTs: '1.2' } } });
    const d = { ...world(), poolItems: async () => [other], delegatedThread: async () => true };
    expect((await validateHints('kai', { conversationId: 'room-ce' }, undefined, d)).destination).toBeNull();
  });
});

describe('helpers', () => {
  it('threadOfMessage prefers the Slack thread', () => {
    expect(threadOfMessage({ id: 'r', channelId: 'c', metadata: { slackThreadTs: '1.2' } }, 'C1')).toBe('C1:1.2');
    expect(threadOfMessage({ id: 'r', channelId: 'c', threadId: 'root' }, null)).toBe('root');
  });

  it('fixCommand names the prompt reference', () => {
    expect(fixCommand({ ticket: 'TKT-187' })).toBe('reply --ticket TKT-187 "<your message>"');
    expect(fixCommand({ decisionId: 'D-2' })).toBe('reply --decision D-2 "<your message>"');
    // No reference: a command the agent can run as is.
    expect(fixCommand()).toBe('reply "<your message>"');
  });
});

describe('latestInputOf', () => {
  const base = { rootKind: 'system' as const, viaAgents: [], at: 5 };
  it('maps turn triggers to what routing cares about', () => {
    expect(latestInputOf(null)).toBeNull();
    expect(latestInputOf({ ...base, triggerKind: 'owner_message' })).toEqual({ kind: 'owner', at: 5 });
    expect(latestInputOf({ ...base, triggerKind: 'agent_message', sender: 'a-1' })).toEqual({ kind: 'agent', sender: 'a-1', at: 5 });
    expect(latestInputOf({ ...base, triggerKind: 'agent_message' })).toEqual({ kind: 'other', at: 5 });
    expect(latestInputOf({ ...base, triggerKind: 'dispatch' })).toEqual({ kind: 'dispatch', at: 5 });
    expect(latestInputOf({ ...base, triggerKind: 'scheduled' })).toEqual({ kind: 'dispatch', at: 5 });
    expect(latestInputOf({ ...base, triggerKind: 'redelivery' })).toEqual({ kind: 'other', at: 5 });
    expect(latestInputOf({ ...base, triggerKind: 'follow_up' })).toEqual({ kind: 'other', at: 5 });
  });
});

// Message-routing audit 2026-10-18: every message carries its destination.
// A delegate's [RESULT] and another agent's message carry the route of the
// request they answer; the resolver follows it and never guesses.
describe('routes carried by results and agent messages', () => {
  const PIA = 'flopost-pia-1';
  const ownerRoute = { kind: 'owner' as const, conversationId: 'room-ce', thread: `${PRO_CE}:${PRO_CE_TS}` };

  it('a result carrying the owner route answers in that owner thread', async () => {
    const r = await resolveReplyDestination(
      { session: 'owen' },
      deps({ origin: mktOrigin, latest: { kind: 'result', sender: PIA, at: NOW, route: ownerRoute } }),
    );
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-ce', thread: `${PRO_CE}:${PRO_CE_TS}`, source: 'route' }));
  });

  it('a result carrying a work-item route answers where that work item goes', async () => {
    const r = await resolveReplyDestination(
      { session: 'owen' },
      deps({ items: [followUp], latest: { kind: 'result', sender: PIA, at: NOW, route: { kind: 'work-item', workItemId: 'fu-187' } } }),
    );
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-ce', source: 'route' }));
  });

  it('a result with no route is refused (it used to land in the owner\'s last thread)', async () => {
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ origin: mktOrigin, latest: { kind: 'result', sender: PIA, at: NOW } }));
    expect(r.destination.kind).toBe('unresolved');
    if (r.destination.kind === 'unresolved') {
      expect(r.destination.reason).toContain(`${PIA}'s result`);
      expect(r.destination.fix).toContain('reply --conversation room-mkt');
    }
  });

  it('a result whose owner route the replier cannot post in is refused with send-message', async () => {
    const r = await resolveReplyDestination(
      { session: 'owen' },
      deps({ members: { 'room-mkt': ['owen'] }, latest: { kind: 'result', sender: PIA, at: NOW, route: ownerRoute } }),
    );
    expect(r.destination.kind).toBe('unresolved');
    if (r.destination.kind === 'unresolved') expect(r.destination.fix).toContain('send-message --to');
  });

  it('an agent message about the replier\'s own owner request: refused, naming both answers', async () => {
    const r = await resolveReplyDestination(
      { session: 'owen' },
      deps({ latest: { kind: 'agent', sender: PIA, at: NOW, route: ownerRoute } }),
    );
    expect(r.destination.kind).toBe('unresolved');
    if (r.destination.kind === 'unresolved') {
      expect(r.destination.fix).toContain(`send-message --to ${PIA}`);
      expect(r.destination.fix).toContain(`reply --conversation room-ce --thread ${PRO_CE}:${PRO_CE_TS}`);
    }
  });

  it('an agent message about someone else\'s request goes back to that agent', async () => {
    const r = await resolveReplyDestination(
      { session: 'owen' },
      deps({ members: {}, latest: { kind: 'agent', sender: PIA, at: NOW, route: ownerRoute } }),
    );
    expect(r.destination).toEqual(expect.objectContaining({ source: 'agent-message', destination: expect.objectContaining({ kind: 'agent', sessionName: PIA }) }));
  });
});
