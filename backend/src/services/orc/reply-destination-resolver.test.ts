import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TurnOrigin } from './orc-reply-route.service.js';
import type { PromptReference } from './agent-prompt-reference.service.js';
import {
  fixCommand,
  resolveReplyDestination,
  threadOfMessage,
  validateHints,
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
    ownerDm: async () => (w.dm === undefined ? 'dm-owen' : w.dm),
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
    expect((r.destination as { fix: string }).fix).toMatch(/^reply --ticket/);
  });

  it('5. the reference the harness last prompted about beats an unrelated newest-running trigger item', async () => {
    const r = await resolveReplyDestination(
      { session: 'owen' },
      deps({ items: [followUp, cronItem], tickets: [{ id: 'req-187', label: 'TKT-187', conversationId: 'room-ce', threadRootId: 'root-ce', slackChannelId: PRO_CE, threadTs: PRO_CE_TS }], prompt: { reference: { ticket: 'TKT-187', workItemId: 'fu-187' }, at: NOW - 5 * MIN } }),
    );
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-ce', source: 'prompt' }));
  });

  it('5. an owner message newer than the prompt wins (the owner spoke since)', async () => {
    const r = await resolveReplyDestination(
      { session: 'owen' },
      deps({ tickets: [{ id: 'req-187', label: 'TKT-187', conversationId: 'room-ce', threadRootId: 'root-ce' }], prompt: { reference: { ticket: 'TKT-187' }, at: NOW - 30 * MIN }, origin: mktOrigin }),
    );
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'room-mkt', source: 'turn-origin' }));
  });

  it('6. without references or hints: the current work (a scheduled item → its own destination)', async () => {
    const r = await resolveReplyDestination({ session: 'owen' }, deps({ items: [cronItem] }));
    expect(r.destination).toEqual(expect.objectContaining({ kind: 'work', source: 'current-work', destination: expect.objectContaining({ kind: 'new-top-level', topic: 'daily digest' }) }));
  });

  it('7. nothing at all → the owner DM; with no DM → a team-channel top-level post', async () => {
    const dm = await resolveReplyDestination({ session: 'owen' }, deps());
    expect(dm.destination).toEqual(expect.objectContaining({ kind: 'conversation', conversationId: 'dm-owen', source: 'owner-dm' }));
    const none = await resolveReplyDestination({ session: 'owen' }, deps({ dm: null }));
    expect(none.destination).toEqual(expect.objectContaining({ kind: 'work', destination: expect.objectContaining({ kind: 'new-top-level' }) }));
    const noDm = await resolveReplyDestination({ session: 'owen', noOwnerDm: true }, deps());
    expect(noDm.destination.kind).toBe('unresolved');
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

  it('a conversation the agent is not in is ignored; the resolver then continues', async () => {
    const r = await resolveReplyDestination({ session: 'ella', hints: { conversationId: 'room-ce' } }, deps({ origin: { ...mktOrigin } }));
    expect(r.ignoredHints[0]).toEqual(expect.objectContaining({ hint: 'conversation room-ce' }));
    expect(r.destination).toEqual(expect.objectContaining({ conversationId: 'room-mkt', source: 'turn-origin' }));
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

describe('helpers', () => {
  it('threadOfMessage prefers the Slack thread', () => {
    expect(threadOfMessage({ id: 'r', channelId: 'c', metadata: { slackThreadTs: '1.2' } }, 'C1')).toBe('C1:1.2');
    expect(threadOfMessage({ id: 'r', channelId: 'c', threadId: 'root' }, null)).toBe('root');
  });

  it('fixCommand names the prompt reference', () => {
    expect(fixCommand({ ticket: 'TKT-187' })).toBe('reply --ticket TKT-187 "<your message>"');
    expect(fixCommand({ decisionId: 'D-2' })).toBe('reply --decision D-2 "<your message>"');
    expect(fixCommand()).toMatch(/^reply --ticket <TKT-id/);
  });
});
