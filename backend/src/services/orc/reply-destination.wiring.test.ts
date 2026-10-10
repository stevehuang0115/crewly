import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { WorkDestinationDeps } from './work-item-destination.wiring.js';
import type { ReplyResolverDeps } from './reply-destination-resolver.js';
import { deliverReply, notDelivered, resolveSlackPlace, type ReplyDeliveryDeps } from './reply-destination.wiring.js';
import { AgentPromptReferenceService } from './agent-prompt-reference.service.js';

function resolver(over: Partial<ReplyResolverDeps> = {}): ReplyResolverDeps {
  return {
    getMessage: () => null,
    ownsConversation: async (_s, c) => c === 'room-ce' || c === 'dm-owen',
    slackChannelOfConversation: (c) => (c === 'room-ce' ? 'C0CE00001' : null),
    conversationOfSlackThread: (ch) => (ch === 'C0CE00001' ? { conversationId: 'room-ce' } : null),
    requestTicket: async (n) => (n === 187 ? { id: 'r', label: 'TKT-187', conversationId: 'room-ce', threadRootId: 'root', slackChannelId: 'C0CE00001', threadTs: '1.1' } : null),
    projectTicket: async () => null,
    decision: async () => null,
    workItem: async () => null,
    poolItems: async () => [] as WorkItem[],
    turnOrigin: () => undefined,
    promptReference: () => undefined,
    owesOwner: () => false,
    lastDelivered: () => '[FOLLOW-UP TKT-187] ready',
    ownerDm: async () => 'dm-owen',
    now: () => Date.now(),
    ...over,
  };
}

function work(post = jest.fn(async (r: { target: string }) => ({ channelId: r.target, messageTs: '9.9' }))): WorkDestinationDeps {
  return {
    poolItems: async () => [],
    ownerOrigin: () => undefined,
    now: () => Date.now(),
    teamChannelOf: async () => ({ slackChannelId: 'C0TEAM001', teamId: 't' }),
    ticketThreads: () => null,
    ticketInfo: async () => null,
    post: post as unknown as WorkDestinationDeps['post'],
  };
}

function deps(over: Partial<ReplyDeliveryDeps> = {}, r: Partial<ReplyResolverDeps> = {}): ReplyDeliveryDeps & { deliver: jest.Mock } {
  const deliver = jest.fn(async (i: { conversationId: string }) => `msg-${i.conversationId}`);
  return { resolver: resolver(r), deliverToConversation: deliver, workDestination: async () => work(), deliver, ...over } as ReplyDeliveryDeps & { deliver: jest.Mock };
}

describe('deliverReply', () => {
  beforeEach(() => AgentPromptReferenceService.resetInstance());

  it('reply --ticket: delivered in the ticket thread and marked as its delivery', async () => {
    const d = deps();
    const r = await deliverReply({ session: 'owen', content: 'preview: https://x', reference: { ticket: 'TKT-187' } }, d);
    expect(r.ok).toBe(true);
    expect(d.deliver).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'room-ce', thread: 'C0CE00001:1.1', metadata: { deliversTicket: 'TKT-187' } }));
  });

  it('never shows run-trace markers to the owner', async () => {
    const d = deps();
    await deliverReply({ session: 'owen', content: 'preview: https://x\n[TRACE:tr-20261003-0123abcd]', reference: { ticket: 'TKT-187' } }, d);
    expect(d.deliver).toHaveBeenCalledWith(expect.objectContaining({ content: 'preview: https://x' }));
  });

  it('a conversation that does not take it → ok:false with the command, never a guess', async () => {
    const d = deps({ deliverToConversation: jest.fn(async () => null) });
    const r = await deliverReply({ session: 'owen', content: 'x', reference: { ticket: 'TKT-187' } }, d);
    expect(r).toEqual(expect.objectContaining({ ok: false }));
    expect(!r.ok && r.error).toMatch(/^Your message was NOT delivered: .*Run: reply "<your message>"$/);
  });

  it('a hint that does not take it → resolved again without the hints', async () => {
    const deliver = jest.fn(async (i: { conversationId: string }) => (i.conversationId === 'room-ce' ? null : `msg-${i.conversationId}`));
    const d = deps({ deliverToConversation: deliver });
    const r = await deliverReply({ session: 'owen', content: 'x', hints: { conversationId: 'room-ce' } }, d);
    expect(r.ok && r.conversationId).toBe('dm-owen');
  });

  it('answering the prompted reference clears it', async () => {
    AgentPromptReferenceService.getInstance().note('owen', { ticket: 'TKT-187' }, '[FOLLOW-UP TKT-187]');
    const d = deps({}, { promptReference: (s) => AgentPromptReferenceService.getInstance().get(s) });
    const r = await deliverReply({ session: 'owen', content: 'here' }, d);
    expect(r.ok && r.conversationId).toBe('room-ce');
    expect(AgentPromptReferenceService.getInstance().get('owen')).toBeUndefined();
  });
});

describe('deliverReply — reply gate (specs/2026-10-03-one-responder-per-message.md §2)', () => {
  beforeEach(() => AgentPromptReferenceService.resetInstance());
  const prior = jest.fn(async () => ({ by: 'Atlas', excerpt: 'Got it — keeping both versions.' }));

  it('a colleague already answered the owner in this thread → held, not posted anywhere else', async () => {
    const d = deps({ priorRoomAnswer: prior });
    const r = await deliverReply({ session: 'ella', content: 'Both versions it is', reference: { ticket: 'TKT-187' } }, d);
    expect(r).toEqual(expect.objectContaining({ ok: false, held: true }));
    expect(!r.ok && r.error).toContain('Held, not posted: Atlas, the agent answering');
    expect(!r.ok && r.error).not.toContain('--none');
    // No retry without the hints: a held reply must not land somewhere else.
    expect(d.deliver).not.toHaveBeenCalled();
    expect(prior).toHaveBeenCalledWith({ conversationId: 'room-ce', thread: 'C0CE00001:1.1', agentSession: 'ella' });
  });

  it('--adds-new and interim notes are posted', async () => {
    const d = deps({ priorRoomAnswer: prior });
    expect((await deliverReply({ session: 'ella', content: 'One more thing: …', addsNew: true, reference: { ticket: 'TKT-187' } }, d)).ok).toBe(true);
    expect((await deliverReply({ session: 'ella', content: 'on it', interim: true, reference: { ticket: 'TKT-187' } }, d)).ok).toBe(true);
    expect(d.deliver).toHaveBeenCalledTimes(2);
  });

  it('a gate that fails never blocks the reply', async () => {
    const d = deps({ priorRoomAnswer: jest.fn(async () => { throw new Error('db'); }) });
    expect((await deliverReply({ session: 'ella', content: 'x', reference: { ticket: 'TKT-187' } }, d)).ok).toBe(true);
  });
});

describe('resolveSlackPlace', () => {
  it('a Slack thread key hint gives that channel and thread', async () => {
    const p = await resolveSlackPlace({ session: 'owen', hints: { thread: 'C0CE00001:1790000000.000100' } }, deps());
    expect(p).toEqual(expect.objectContaining({ slackChannelId: 'C0CE00001', threadTs: '1790000000.000100', conversationId: 'room-ce' }));
  });

  it('noOwnerDm and nothing to go on → null', async () => {
    expect(await resolveSlackPlace({ session: 'owen', noOwnerDm: true }, deps())).toBeNull();
  });
});

describe('notDelivered', () => {
  it('formats the English error', () => {
    expect(notDelivered('why', 'reply --to m "<your message>"')).toBe('Your message was NOT delivered: why. Run: reply --to m "<your message>"');
  });
});

describe('deliverReply — work delegated from the owner\'s DM with another agent (crewly#1083)', () => {
  beforeEach(() => AgentPromptReferenceService.resetInstance());

  const delegated = {
    id: 'wi-7',
    type: 'delegate',
    owner: 'team_lead',
    target: 'sage',
    title: 'Compare the two pricing pages',
    status: 'running',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    metadata: { origin: { kind: 'owner', conversationId: 'dm-atlas', slackChannelId: 'D0ATLAS01', threadTs: '1790000000.000100' } },
  } as unknown as WorkItem;

  const r = {
    ownsConversation: async (s: string, c: string) => (s === 'sage' ? c === 'dm-sage' : false),
    slackChannelOfConversation: (c: string) => (c === 'dm-atlas' ? 'D0ATLAS01' : c === 'dm-sage' ? 'D0SAGE001' : null),
    ownerDm: async (s: string) => (s === 'sage' ? 'dm-sage' : null),
    poolItems: async () => [delegated],
    workItem: async (id: string) => (id === 'wi-7' ? delegated : null),
    lastDelivered: () => undefined,
  };

  it('the member answers in its own DM with the owner, opened with the topic', async () => {
    const deliver = jest.fn(async (i: { conversationId: string }) => (i.conversationId === 'dm-sage' ? 'msg-1' : null));
    const d = deps({ deliverToConversation: deliver }, r);
    const res = await deliverReply({ session: 'sage', content: 'Page B converts better.', reference: { workItemId: 'wi-7' } }, d);
    expect(res.ok && res.conversationId).toBe('dm-sage');
    expect(deliver).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: 'dm-sage', content: '*Re: Compare the two pricing pages*\nPage B converts better.' }));
  });

  it('a plain reply from current work takes the same path', async () => {
    const deliver = jest.fn(async (i: { conversationId: string }) => (i.conversationId === 'dm-sage' ? 'msg-1' : null));
    const d = deps({ deliverToConversation: deliver }, r);
    const res = await deliverReply({ session: 'sage', content: 'Done.' }, d);
    expect(res.ok && res.conversationId).toBe('dm-sage');
  });

  it('a team-channel destination is never swapped for a DM', async () => {
    const deliver = jest.fn(async () => null);
    const d = deps({ deliverToConversation: deliver });
    const res = await deliverReply({ session: 'owen', content: 'x', reference: { ticket: 'TKT-187' } }, d);
    expect(res.ok).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe('deliverReply — decision-card threads (CREW-438)', () => {
  beforeEach(() => AgentPromptReferenceService.resetInstance());

  const refuse = () => jest.fn(async () => null);

  it('a refused --conversation + Slack-thread hint in a mapped channel is posted straight to that Slack thread', async () => {
    const post = jest.fn(async (r: { target: string }) => ({ channelId: r.target, messageTs: '9.9' }));
    const d = deps({ deliverToConversation: refuse(), workDestination: async () => work(post) });
    const r = await deliverReply({ session: 'owen', content: 'my answer', hints: { conversationId: 'room-ce', thread: 'C0CE00001:1790000000.000001' } }, d);
    expect(r.ok).toBe(true);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ target: 'C0CE00001', threadTs: '1790000000.000001', text: 'my answer' }));
    expect(r).toMatchObject({ ok: true, slackChannelId: 'C0CE00001', threadTs: '1790000000.000001' });
  });

  it('does not post to a Slack thread of a different channel than the conversation is mapped to', async () => {
    const post = jest.fn(async (r: { target: string }) => ({ channelId: r.target, messageTs: '9.9' }));
    const d = deps({ deliverToConversation: refuse(), workDestination: async () => work(post) });
    await deliverReply({ session: 'owen', content: 'x', hints: { conversationId: 'room-ce', thread: 'C0OTHER99:1790000000.000001' } }, d);
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ target: 'C0OTHER99' }));
  });

  it('the refusal names reply --decision D-n when the thread is a decision card', async () => {
    const d = deps({ deliverToConversation: refuse(), workDestination: async () => work(jest.fn(async (_r: { target: string }) => { throw new Error('slack down'); })), decisionOfCardThread: async (ch, ts) => (ch === 'C0CE00001' && ts === '1790000000.000001' ? 'D-42' : null) });
    const r = await deliverReply({ session: 'owen', content: 'x', hints: { conversationId: 'room-ce', thread: 'C0CE00001:1790000000.000001' } }, d);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('reply --decision D-42');
  });
});
