/**
 * Tests for the Drive mode briefing queue (specs/2026-10-08-drive-mode.md):
 * ordering and summaries, answers to cards vs threads vs tickets, next /
 * later, follow-up lookups coming back, and spoken confirmation.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OwnerDecision } from '../../types/decision.types.js';
import type { Request } from '../../types/v2/request.types.js';
import type { TicketListItem } from '../v3/ticket-intake.service.js';
import { BriefingStateStore } from './briefing-state.store.js';
import { BriefingService, decisionItem, type BriefingDecisions, type BriefingDeps, type BriefingReview } from './briefing.service.js';
import { BriefingError } from './briefing.types.js';

const NOW = new Date('2026-10-08T10:00:00.000Z');

/** A decision card. */
function decision(over: Partial<OwnerDecision> = {}): OwnerDecision {
  return {
    id: 'D-7',
    question: 'Post the **launch** thread on <https://x.com|X> today?',
    options: [
      { key: 'a', label: 'Post today' },
      { key: 'b', label: 'Wait for Monday' },
    ],
    defaultKey: 'b',
    deadline: '2026-10-09T12:00:00.000Z',
    requestedBy: 'ella',
    asker: 'ella',
    status: 'open',
    createdAt: '2026-10-08T08:00:00.000Z',
    updatedAt: '2026-10-08T08:00:00.000Z',
    ...over,
  };
}

/** A Request with an unanswered question from a reply. */
function questionRequest(over: Partial<Request> = {}): Request {
  return {
    id: 'req-1',
    sourceConversationItemId: 'm-0',
    title: 'Weekly newsletter',
    description: 'Draft the weekly newsletter',
    status: 'awaiting_followup',
    priority: 'normal',
    requiresConfirmation: false,
    workItemIds: [],
    intentLevel: 'L1',
    intentCategory: 'content',
    tags: [],
    createdAt: '2026-10-08T06:00:00.000Z',
    updatedAt: '2026-10-08T06:00:00.000Z',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    chatRef: { channelId: 'ch-dm-leo', messageId: 'm-0', threadRootId: 'm-0' },
    openItems: [
      { id: 'q-abc-1', type: 'question', text: 'Should I include the pricing change?', agent: 'leo', sourceMessageId: 'm-1', createdAt: '2026-10-08T07:00:00.000Z', status: 'open' },
    ],
    ...over,
  } as Request;
}

/** A ticket in 待验收. */
function reviewRow(over: Partial<TicketListItem> = {}): TicketListItem {
  return {
    id: 'req-9',
    tkt: 'TKT-9',
    ticketNumber: 9,
    title: 'Fix the signup form',
    description: 'The form drops the email field',
    kind: 'issue',
    column: 'to_review',
    status: 'awaiting_confirmation',
    priority: 'normal',
    priorityLabel: 'P2',
    origin: null,
    assignee: 'max',
    workItemIds: [],
    tags: [],
    createdAt: '2026-10-07T06:00:00.000Z',
    updatedAt: '2026-10-08T05:00:00.000Z',
    acceptance: [{ text: 'Email is saved' }],
    reply: { at: '2026-10-08T05:00:00.000Z', by: 'max', messageId: 'm-9', excerpt: 'Fixed and tested on staging.' },
    rejectCount: 0,
    submitCount: 1,
    submittedAt: '2026-10-08T05:00:00.000Z',
    completedAt: null,
    autoAcceptAt: '2026-10-10T05:00:00.000Z',
    acceptedBy: null,
    ...over,
  } as unknown as TicketListItem;
}

interface Harness {
  service: BriefingService;
  decisions: jest.Mocked<BriefingDecisions>;
  review: jest.Mocked<BriefingReview>;
  posted: Array<{ target: unknown; text: string }>;
  replies: Array<{ agentSession: string; channelId: string; text: string; at: number }>;
  state: { decisions: OwnerDecision[]; requests: Request[]; reviews: TicketListItem[] };
  clock: { now: Date };
  dismissOpenItem: jest.Mock;
  dir: string;
  ownerTurns: Array<{ channelId: string; root: string; lastAt: number }>;
}

/** A service over fakes. */
function harness(init: Partial<Harness['state']> = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-'));
  const state: Harness['state'] = { decisions: init.decisions ?? [], requests: init.requests ?? [], reviews: init.reviews ?? [] };
  const clock = { now: NOW };
  const posted: Harness['posted'] = [];
  const replies: Harness['replies'] = [];
  const settle = (id: string, patch: Partial<OwnerDecision>) => {
    const d = state.decisions.find((x) => x.id === id) as OwnerDecision;
    Object.assign(d, patch);
    return d;
  };
  const decisions = {
    list: jest.fn(async () => state.decisions.filter((d) => d.status === 'open' || d.status === 'parked')),
    chooseFromDashboard: jest.fn(async (id: string, key: string) => settle(id, { status: 'resolved', chosenKey: key, answeredVia: 'voice' })),
    answerInWords: jest.fn(async (id: string, text: string) => settle(id, { status: 'resolved', answerText: text, answeredVia: 'voice' })),
    remindFromDashboard: jest.fn(async (id: string) => settle(id, { remindAt: '2026-10-09T09:00:00.000Z' })),
    skipFromDashboard: jest.fn(async (id: string) => settle(id, { status: 'skipped' })),
  } as unknown as jest.Mocked<BriefingDecisions>;
  const review = {
    verify: jest.fn(async () => ({ ok: true as const, ticket: {} as Request })),
    reject: jest.fn(async () => ({ ok: true as const, ticket: {} as Request })),
  } as unknown as jest.Mocked<BriefingReview>;
  const dismissOpenItem = jest.fn(async () => undefined);
  const ownerTurns: Harness['ownerTurns'] = [];
  const deps: BriefingDeps = {
    decisions: () => decisions,
    listRequests: async () => state.requests,
    listReviewTickets: async () => state.reviews,
    review: () => review,
    dismissOpenItem,
    ownerTurns: async () => ownerTurns,
    roster: async () => [
      { agentSession: 'ella', displayName: 'Ella', teamName: 'Marketing' },
      { agentSession: 'leo', displayName: 'Leo', teamName: 'Content' },
      { agentSession: 'max', displayName: 'Max', teamName: 'Web' },
    ],
    postOwnerMessage: async (target, text) => {
      posted.push({ target, text });
      return { channelId: target.channelId ?? `dm-${target.agentSession}`, ...(target.threadId ? { threadId: target.threadId } : {}) };
    },
    findAgentReply: async (agentSession, channelId, _threadId, sinceMs) => {
      const r = replies.find((x) => x.agentSession === agentSession && x.channelId === channelId && x.at > sinceMs);
      return r ? { text: r.text, at: new Date(r.at).toISOString() } : null;
    },
    store: new BriefingStateStore(path.join(dir, 'briefing-state.json')),
    now: () => clock.now,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never,
  };
  return { service: new BriefingService(deps), decisions, review, posted, replies, state, clock, dismissOpenItem, dir, ownerTurns };
}

afterEach(() => jest.restoreAllMocks());

describe('queue', () => {
  it('orders by urgency, then the longest wait; summaries are speakable', async () => {
    const h = harness({
      decisions: [
        decision({ id: 'D-1', createdAt: '2026-10-08T09:00:00.000Z' }),
        decision({ id: 'D-2', question: 'Which banner for the sale?', createdAt: '2026-10-08T09:30:00.000Z', deadline: '2026-10-08T11:00:00.000Z' }),
      ],
      requests: [questionRequest()],
      reviews: [reviewRow()],
    });
    const q = await h.service.queue();
    expect(q.items.map((i) => i.id)).toEqual(['d:D-2', 'q:req-1:q-abc-1', 'd:D-1', 't:req-9']);
    const card = q.items.find((i) => i.id === 'd:D-1');
    expect(card).toMatchObject({ agentName: 'Ella', teamName: 'Marketing', urgency: 'normal', kind: 'decision' });
    expect(card?.summary).toBe('Ella asks: Post the launch thread on X today? Options: Post today or Wait for Monday.');
    expect(card?.summary).not.toMatch(/https?:|\*\*/);
    expect(card?.details).toContain('Option b: Wait for Monday');
    expect(card?.answerTarget).toEqual({ kind: 'decision', decisionId: 'D-1' });
    const ticket = q.items.find((i) => i.id === 't:req-9');
    expect(ticket?.summary).toBe('Max finished: Fix the signup form. Accept it or send it back?');
    expect(ticket?.details).toContain('Check: Email is saved');
    expect(q.items.find((i) => i.kind === 'question')?.answerTarget).toEqual({ kind: 'thread', channelId: 'ch-dm-leo', threadId: 'm-0', agentSession: 'leo' });
  });

  it('leaves out carded questions, snoozed cards and questions with no conversation', async () => {
    const carded = questionRequest({ id: 'req-2' });
    carded.openItems = [{ ...(carded.openItems ?? [])[0], decisionId: 'D-1' }];
    const h = harness({
      decisions: [decision({ remindAt: '2026-10-09T09:00:00.000Z' })],
      requests: [carded, questionRequest({ id: 'req-3', chatRef: undefined })],
    });
    expect((await h.service.queue()).items).toEqual([]);
  });

  it('a card whose remind time came is a reminder, first in line', async () => {
    const h = harness({ decisions: [decision({ id: 'D-1' }), decision({ id: 'D-3', question: 'Renew the domain?', remindAt: '2026-10-08T09:00:00.000Z', createdAt: '2026-10-08T09:59:00.000Z' })] });
    const [first] = (await h.service.queue()).items;
    expect(first).toMatchObject({ id: 'd:D-3', reminder: true, urgency: 'high' });
  });

  it('flags sensitive items', async () => {
    const h = harness({ decisions: [decision({ sensitive: 'deploy' }), decision({ id: 'D-8', question: 'Delete the old staging database?' })], reviews: [reviewRow()] });
    const items = (await h.service.queue()).items;
    expect(items.find((i) => i.id === 'd:D-7')).toMatchObject({ sensitive: true, sensitiveReason: 'deploy' });
    expect(items.find((i) => i.id === 'd:D-8')).toMatchObject({ sensitive: true, sensitiveReason: 'delete' });
    expect(items.find((i) => i.id === 't:req-9')?.sensitive).toBe(false);
  });
});

describe('live items only (on request)', () => {
  it('leaves out duplicate cards and questions the owner already answered in their conversation', async () => {
    const h = harness({
      decisions: [decision({ id: 'D-1', createdAt: '2026-10-08T07:00:00.000Z' }), decision({ id: 'D-2', createdAt: '2026-10-08T09:00:00.000Z' })],
      requests: [questionRequest()],
    });
    h.ownerTurns.push({ channelId: 'ch-dm-leo', root: '', lastAt: Date.parse('2026-10-08T08:00:00.000Z') });
    const ids = (await h.service.queue()).items.map((i) => i.id);
    expect(ids).toEqual(['d:D-2']);
  });
});

describe('answers', () => {
  it('a card: an option goes to the decision service as voice', async () => {
    const h = harness({ decisions: [decision()] });
    const out = await h.service.answer('d:D-7', { optionKey: 'Post today' });
    expect(out).toMatchObject({ status: 'done', itemId: 'd:D-7' });
    expect(h.decisions.chooseFromDashboard).toHaveBeenCalledWith('D-7', 'a', 'voice');
    expect((await h.service.queue()).items).toEqual([]);
  });

  it('a card: words are answered in words', async () => {
    const h = harness({ decisions: [decision()] });
    await h.service.answer('d:D-7', { text: '先发英文版' });
    expect(h.decisions.answerInWords).toHaveBeenCalledWith('D-7', '先发英文版', 'voice');
    expect(h.posted).toEqual([]);
  });

  it('a question from a reply: the words are posted in that conversation', async () => {
    const h = harness({ requests: [questionRequest()] });
    expect(await h.service.answer('q:req-1:q-abc-1', { text: 'Yes, include it' })).toMatchObject({ status: 'done' });
    expect(h.posted).toEqual([{ target: { agentSession: 'leo', channelId: 'ch-dm-leo', threadId: 'm-0' }, text: 'Yes, include it' }]);
    // Not read again while the open item is still closing.
    expect((await h.service.queue()).items).toEqual([]);
  });

  it('finished work: accept, or send back with a reason', async () => {
    const h = harness({ reviews: [reviewRow()] });
    await expect(h.service.answer('t:req-9', { text: 'looks good' })).rejects.toMatchObject({ status: 400 });
    await expect(h.service.answer('t:req-9', { optionKey: 'send_back' })).rejects.toMatchObject({ status: 400 });
    await h.service.answer('t:req-9', { optionKey: 'send_back', text: 'The email field is still empty on Safari' });
    expect(h.review.reject).toHaveBeenCalledWith('req-9', 'The email field is still empty on Safari', 'board');
    await h.service.answer('t:req-9', { optionKey: 'accept' });
    expect(h.review.verify).toHaveBeenCalledWith('req-9');
  });

  it('a refused ticket action says why', async () => {
    const h = harness({ reviews: [reviewRow()] });
    h.review.verify.mockResolvedValueOnce({ ok: false, reason: 'open_work' });
    await expect(h.service.answer('t:req-9', { optionKey: 'accept' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('still running') });
  });

  it('rejects an unknown option, empty answers and unknown items', async () => {
    const h = harness({ decisions: [decision()] });
    await expect(h.service.answer('d:D-7', { optionKey: 'z' })).rejects.toBeInstanceOf(BriefingError);
    await expect(h.service.answer('d:D-7', {})).rejects.toMatchObject({ status: 400 });
    await expect(h.service.answer('d:D-404', { optionKey: 'a' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('spoken confirmation for sensitive items', () => {
  it('first call asks, second call with the token and the same answer acts', async () => {
    const h = harness({ decisions: [decision({ sensitive: 'deploy' })] });
    const first = await h.service.answer('d:D-7', { optionKey: 'a' });
    expect(first).toMatchObject({ status: 'needs_confirmation', itemId: 'd:D-7' });
    expect(h.decisions.chooseFromDashboard).not.toHaveBeenCalled();
    const token = (first as { confirmToken: string }).confirmToken;
    // confirm without the token, or for a different answer: refused
    await expect(h.service.answer('d:D-7', { optionKey: 'a', confirm: true })).rejects.toMatchObject({ status: 409, code: 'confirm_mismatch' });
    await expect(h.service.answer('d:D-7', { optionKey: 'b', confirm: true, confirmToken: token })).rejects.toMatchObject({ status: 409 });
    expect(await h.service.answer('d:D-7', { optionKey: 'a', confirm: true, confirmToken: token })).toMatchObject({ status: 'done' });
    expect(h.decisions.chooseFromDashboard).toHaveBeenCalledWith('D-7', 'a', 'voice');
  });

  it('a token is single-use and expires', async () => {
    const h = harness({ decisions: [decision({ sensitive: 'spend' }), decision({ id: 'D-8', question: 'Buy the ad slot?', sensitive: 'spend' })] });
    const first = (await h.service.answer('d:D-8', { optionKey: 'a' })) as { confirmToken: string };
    h.clock.now = new Date(NOW.getTime() + 4 * 60 * 1000);
    await expect(h.service.answer('d:D-8', { optionKey: 'a', confirm: true, confirmToken: first.confirmToken })).rejects.toMatchObject({ code: 'confirm_mismatch' });
  });
});

describe('next / later', () => {
  it('next hides an item for hours; dismiss settles it', async () => {
    const h = harness({ decisions: [decision(), decision({ id: 'D-8', question: 'Which banner for the sale?' })], requests: [questionRequest()] });
    expect(await h.service.skip('d:D-7')).toMatchObject({ status: 'hidden' });
    let q = await h.service.queue();
    expect(q.items.map((i) => i.id)).not.toContain('d:D-7');
    expect(q.hidden).toBe(1);
    h.clock.now = new Date(NOW.getTime() + 7 * 60 * 60 * 1000);
    q = await h.service.queue();
    expect(q.items.map((i) => i.id)).toContain('d:D-7');
    await h.service.skip('d:D-8', { dismiss: true });
    expect(h.decisions.skipFromDashboard).toHaveBeenCalledWith('D-8');
    await h.service.skip('q:req-1:q-abc-1', { dismiss: true });
    expect(h.dismissOpenItem).toHaveBeenCalledWith('req-1', 'q-abc-1');
  });

  it('later comes back flagged as a reminder; a card is also snoozed on Slack', async () => {
    const h = harness({ reviews: [reviewRow()], decisions: [decision()] });
    const at = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
    expect(await h.service.later('t:req-9', { at })).toMatchObject({ status: 'hidden', until: at });
    await expect(h.service.later('t:req-9', { at: '2020-01-01T00:00:00Z' })).rejects.toMatchObject({ status: 400 });
    expect((await h.service.queue()).items.map((i) => i.id)).toEqual(['d:D-7']);
    h.clock.now = new Date(NOW.getTime() + 61 * 60 * 1000);
    expect((await h.service.queue()).items[0]).toMatchObject({ id: 't:req-9', reminder: true });
    await h.service.later('d:D-7');
    expect(h.decisions.remindFromDashboard).toHaveBeenCalledWith('D-7');
  });
});

describe('ask → lookup pending → back in the queue', () => {
  it('a card: the question goes to the asker; the item returns with the answer', async () => {
    const h = harness({ decisions: [decision()] });
    const out = await h.service.ask('d:D-7', 'What is in the thread?');
    expect(out).toMatchObject({ status: 'lookup_pending', handedTo: 'Ella' });
    expect((out as { details: string }).details).toContain('Question:');
    expect(h.posted[0].target).toEqual({ agentSession: 'ella' });
    expect(h.posted[0].text).toContain('What is in the thread?');
    expect(h.posted[0].text).toContain('decision D-7');
    let q = await h.service.queue();
    expect(q.items).toEqual([]);
    expect(q.lookupsPending).toEqual([{ id: 'd:D-7', agentName: 'Ella', question: 'What is in the thread?', askedAt: NOW.toISOString() }]);
    h.replies.push({ agentSession: 'ella', channelId: 'dm-ella', text: 'Five posts, the **first** one is the teaser.', at: NOW.getTime() + 1000 });
    q = await h.service.queue();
    expect(q.lookupsPending).toEqual([]);
    expect(q.items[0]).toMatchObject({ id: 'd:D-7', urgency: 'high', lookupAnswer: { question: 'What is in the thread?', answer: 'Five posts, the first one is the teaser.' } });
  });

  it('a question from a reply: the follow-up goes to that conversation verbatim', async () => {
    const h = harness({ requests: [questionRequest()] });
    await h.service.ask('q:req-1:q-abc-1', '这个价格变化是什么时候生效？');
    expect(h.posted).toEqual([{ target: { agentSession: 'leo', channelId: 'ch-dm-leo', threadId: 'm-0' }, text: '这个价格变化是什么时候生效？' }]);
  });

  it('a lookup nobody answers is given up after a day', async () => {
    const h = harness({ reviews: [reviewRow()] });
    await h.service.ask('t:req-9', 'Which browsers?');
    expect((await h.service.queue()).items).toEqual([]);
    h.clock.now = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    expect((await h.service.queue()).items.map((i) => i.id)).toEqual(['t:req-9']);
  });

  it('requires a question', async () => {
    const h = harness({ decisions: [decision()] });
    await expect(h.service.ask('d:D-7', '  ')).rejects.toMatchObject({ status: 400 });
  });
});

describe('decisionItem', () => {
  it('a parked card is urgent and says nothing happens without an answer', () => {
    const item = decisionItem(decision({ status: 'parked', sensitive: 'email' }), { name: 'Ella' }, NOW);
    expect(item).toMatchObject({ urgency: 'high', sensitive: true });
    expect(item?.details).toContain('Nothing happens until the owner answers');
  });

  it('settled cards are not items', () => {
    expect(decisionItem(decision({ status: 'resolved' }), { name: 'Ella' }, NOW)).toBeNull();
  });
});
