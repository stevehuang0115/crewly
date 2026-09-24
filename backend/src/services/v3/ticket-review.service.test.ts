/**
 * Tests for TicketReviewService (specs/ticket-loop.md, Phase 2).
 *
 * Runs against a real RequestService in a temp dir, so the `done` gate in
 * RequestService.update is exercised too.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RequestService } from './request.service.js';
import { TicketReviewService, type ReworkInput } from './ticket-review.service.js';
import { TICKET_CONSTANTS } from '../../constants.js';
import type { Request } from '../../types/v2/request.types.js';
import type { TicketOriginChannel } from '../../types/v2/ticket.types.js';

let dir: string;
let requests: RequestService;
let clock: number;
let openWork: Map<string, number>;
let reworks: ReworkInput[];
let doneReceipts: string[];
let review: TicketReviewService;

/**
 * Create a ticket straight through RequestService (as intake would).
 *
 * @param n - Ticket number
 * @param opts - Origin channel, assignee, chat turn
 * @returns The ticket
 */
async function ticket(
  n: number,
  opts: { channel?: TicketOriginChannel; assignee?: string; chatChannelId?: string; messageId?: string } = {},
): Promise<Request> {
  const channel = opts.channel ?? 'slack-channel';
  const t = await requests.create({
    sourceConversationItemId: `src-${n}`,
    title: `ticket ${n}`,
    description: `please do thing ${n}`,
    ticketNumber: n,
    origin: { channel, ref: `src-${n}`, threadRef: `slack:C1:${n}.0`, author: 'U1' },
    requiresConfirmation: !TICKET_CONSTANTS.REVIEW.NO_REVIEW_ORIGINS.includes(channel),
    ...(opts.assignee ? { assignee: opts.assignee } : {}),
  });
  if (opts.chatChannelId) {
    await review.noteChatTurn(t.id, { id: opts.messageId ?? `m-${n}`, channelId: opts.chatChannelId });
  }
  return (await requests.getById(t.id))!;
}

/**
 * Agent chat-v2 message.
 *
 * @param channelId - chat-v2 channel
 * @param senderId - Agent session
 * @param content - Text
 * @param threadId - Thread root
 * @returns Message
 */
function agentMsg(channelId: string, senderId: string, content: string, threadId?: string) {
  return { id: `a-${Math.random()}`, channelId, senderType: 'agent', senderId, content, ...(threadId ? { threadId } : {}) };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ticket-review-'));
  RequestService.resetInstance();
  requests = RequestService.getInstance(dir);
  // RequestService stamps submittedAt with the real clock, so start ours there.
  clock = Date.now();
  openWork = new Map();
  reworks = [];
  doneReceipts = [];
  review = new TicketReviewService({
    requests,
    fallbackAgent: 'crewly-orc',
    now: () => new Date(clock),
    openWorkItemCount: async (id) => openWork.get(id) ?? 0,
    createRework: async (input) => {
      reworks.push(input);
      return 'wi-rework';
    },
    markReceiptDone: async (t) => {
      doneReceipts.push(t.id);
    },
  });
});

afterEach(async () => {
  RequestService.resetInstance();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('noteChatTurn', () => {
  it('records the first chat turn only', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    await review.noteChatTurn(t.id, { id: 'm2', channelId: 'ch2' });
    expect((await requests.getById(t.id))?.chatRef).toEqual({ channelId: 'ch1', messageId: 'm1', threadRootId: 'm1' });
  });

  it('uses the thread root when the owner wrote inside a thread', async () => {
    const t = await ticket(1);
    await review.noteChatTurn(t.id, { id: 'm5', channelId: 'ch1', threadId: 'root' });
    expect((await requests.getById(t.id))?.chatRef?.threadRootId).toBe('root');
  });
});

describe('onChatMessage — answer detection', () => {
  it('records a threaded agent answer and moves the ticket to running', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    const r = await review.onChatMessage(agentMsg('ch1', 'atlas', 'Here is the analysis …', 'm1'));
    expect(r?.id).toBe(t.id);
    const after = await requests.getById(t.id);
    expect(after?.status).toBe('running');
    expect(after?.reply).toMatchObject({ by: 'atlas', excerpt: 'Here is the analysis …' });
  });

  it('a top-level agent message counts for the newest open ticket its sender may answer', async () => {
    const older = await ticket(1, { chatChannelId: 'ch1', assignee: 'atlas' });
    clock += 1000;
    const newer = await ticket(2, { chatChannelId: 'ch1', assignee: 'ella' });
    await review.onChatMessage(agentMsg('ch1', 'atlas', 'answer'));
    expect((await requests.getById(older.id))?.reply?.by).toBe('atlas');
    expect((await requests.getById(newer.id))?.reply).toBeUndefined();
  });

  it('ignores owner messages, other channels and tickets without a chat turn', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1' });
    expect(await review.onChatMessage({ ...agentMsg('ch1', 'U1', 'hi'), senderType: 'user' })).toBeNull();
    expect(await review.onChatMessage(agentMsg('ch2', 'atlas', 'hi'))).toBeNull();
    expect((await requests.getById(t.id))?.reply).toBeUndefined();
  });

  it('caps the excerpt', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    await review.onChatMessage(agentMsg('ch1', 'atlas', 'x'.repeat(5000), 'm1'));
    expect((await requests.getById(t.id))?.reply?.excerpt).toHaveLength(TICKET_CONSTANTS.REVIEW.REPLY_EXCERPT_MAX);
  });
});

describe('submit — idle and settle', () => {
  it('the answering agent going idle puts the ticket in 待验收 (not done)', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    await review.onChatMessage(agentMsg('ch1', 'atlas', 'done: report attached', 'm1'));
    expect(await review.onAgentIdle('someone-else')).toHaveLength(0);
    const [submitted] = await review.onAgentIdle('atlas');
    expect(submitted).toMatchObject({ id: t.id, status: 'waiting_confirmation', result: 'done: report attached', submitCount: 1 });
    expect(submitted.submittedAt).toEqual(expect.any(String));
    expect(doneReceipts).toHaveLength(0);
  });

  it('does not submit while the ticket has open WorkItems', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    await review.onChatMessage(agentMsg('ch1', 'atlas', '收到，我来做', 'm1'));
    openWork.set(t.id, 2);
    expect(await review.onAgentIdle('atlas')).toHaveLength(0);
    expect((await requests.getById(t.id))?.status).toBe('running');
  });

  it('the sweep submits only answers older than the settle time', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    await review.onChatMessage(agentMsg('ch1', 'atlas', 'answer', 'm1'));
    expect((await review.sweep()).submitted).toBe(0);
    clock += TICKET_CONSTANTS.REVIEW.SUBMIT_SETTLE_MS;
    expect((await review.sweep()).submitted).toBe(1);
    expect((await requests.getById(t.id))?.status).toBe('waiting_confirmation');
  });

  it('a cron / mission ticket closes without review and swaps the receipt', async () => {
    const t = await ticket(1, { channel: 'cron', chatChannelId: 'ch1', messageId: 'm1' });
    await review.onChatMessage(agentMsg('ch1', 'atlas', 'ran it', 'm1'));
    await requests.update(t.id, { receipt: { kind: 'slack', slackChannelId: 'C1', ts: '1.0', reaction: 'ticket' } });
    const [submitted] = await review.onAgentIdle('atlas');
    expect(submitted.status).toBe('done');
    expect(doneReceipts).toEqual([t.id]);
  });

  it('an answer after a 打回 submits again (submitCount 2); an old answer does not', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    await review.onChatMessage(agentMsg('ch1', 'atlas', 'v1', 'm1'));
    await review.onAgentIdle('atlas');
    clock += 1000;
    await review.reject(t.id, 'missing the chart', 'thread');
    // Same old answer: nothing new to submit.
    expect(await review.onAgentIdle('atlas')).toHaveLength(0);
    clock += 1000;
    await review.onChatMessage(agentMsg('ch1', 'atlas', 'v2 with chart', 'm1'));
    const [again] = await review.onAgentIdle('atlas');
    expect(again).toMatchObject({ status: 'waiting_confirmation', submitCount: 2, rejectCount: 1, result: 'v2 with chart' });
  });
});

describe('owner actions', () => {
  /**
   * A ticket in 待验收.
   *
   * @returns The ticket
   */
  async function inReview(): Promise<Request> {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1', assignee: 'atlas' });
    await review.onChatMessage(agentMsg('ch1', 'atlas', 'answer', 'm1'));
    await review.onAgentIdle('atlas');
    await requests.update(t.id, { receipt: { kind: 'slack', slackChannelId: 'C1', ts: '1.0', reaction: 'ticket' } });
    return (await requests.getById(t.id))!;
  }

  it('verify → done and the receipt turns ✅', async () => {
    const t = await inReview();
    const r = await review.verify('TKT-001');
    expect(r).toMatchObject({ ok: true, ticket: { status: 'done' } });
    expect(doneReceipts).toEqual([t.id]);
    expect(await review.verify(t.id)).toMatchObject({ ok: false, reason: 'already_done' });
    expect(await review.verify('TKT-404')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('verify works before the agent finished (open → done) but not with open work', async () => {
    const t = await ticket(2);
    openWork.set(t.id, 1);
    await requests.update(t.id, { status: 'ready' });
    expect(await review.verify(t.id)).toMatchObject({ ok: true });
  });

  it('reject from the thread records the criterion but queues no rework (the agent sees the message)', async () => {
    const t = await inReview();
    const r = await review.reject(t.id, 'the numbers are last month', 'thread');
    expect(r).toMatchObject({ ok: true, ticket: { status: 'running', rejectCount: 1 } });
    expect(reworks).toHaveLength(0);
    const after = await requests.getById(t.id);
    expect(after?.acceptance?.[0]).toMatchObject({ text: 'the numbers are last month', source: 'reject', check: 'judgment' });
    expect(after?.discussion?.at(-1)?.text).toBe('打回：the numbers are last month');
  });

  it('reject from the board queues rework for whoever answered', async () => {
    const t = await inReview();
    await review.reject(t.id, 'wrong file', 'board');
    expect(reworks).toEqual([expect.objectContaining({ reason: 'wrong file', target: 'atlas' })]);
  });

  it('reject needs a reason and a ticket in review', async () => {
    const t = await ticket(3);
    expect(await review.reject(t.id, '  ', 'board')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await review.reject(t.id, 'nope', 'board')).toMatchObject({ ok: false, reason: 'not_in_review' });
  });

  it('a plain follow-up reopens without counting a reject', async () => {
    const t = await inReview();
    const after = await review.reopenOnFollowUp(t.id);
    expect(after).toMatchObject({ status: 'running' });
    expect(after?.rejectCount ?? 0).toBe(0);
  });
});

describe('auto-accept', () => {
  it('accepts a 待验收 ticket after the silence window and tags it', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    await review.onChatMessage(agentMsg('ch1', 'atlas', 'answer', 'm1'));
    await review.onAgentIdle('atlas');
    // RequestService stamps submittedAt with the real clock; move ours past it.
    clock = Date.now() + TICKET_CONSTANTS.REVIEW.AUTO_ACCEPT_MS - 60_000;
    expect((await review.sweep()).autoAccepted).toBe(0);
    clock = Date.now() + TICKET_CONSTANTS.REVIEW.AUTO_ACCEPT_MS + 60_000;
    expect((await review.sweep()).autoAccepted).toBe(1);
    const after = await requests.getById(t.id);
    expect(after?.status).toBe('done');
    expect(after?.tags).toContain(TICKET_CONSTANTS.REVIEW.AUTO_ACCEPTED_TAG);
  });
});

describe('acceptance, self-check, patch', () => {
  it('setAcceptance keeps removed criteria with removedAt and adds new ones as the owner’s', async () => {
    const t = await ticket(1);
    await review.setAcceptance(t.id, [{ text: 'a' }, { text: 'b', check: 'auto' }]);
    const r = await review.setAcceptance(t.id, [{ text: 'b' }, { text: 'c' }]);
    expect(r.ok).toBe(true);
    const list = (await requests.getById(t.id))!.acceptance!;
    expect(list.find((a) => a.text === 'a')?.removedAt).toEqual(expect.any(String));
    expect(list.find((a) => a.text === 'b')).toMatchObject({ source: 'owner', check: 'auto' });
    expect(list.find((a) => a.text === 'c')).toMatchObject({ source: 'owner', check: 'judgment' });
  });

  it('selfCheck indexes the live list', async () => {
    const t = await ticket(1);
    await review.setAcceptance(t.id, [{ text: 'a' }, { text: 'b' }]);
    await review.setAcceptance(t.id, [{ text: 'b' }]);
    await review.selfCheck(t.id, 0, 'fail', 'b is not there');
    const b = (await requests.getById(t.id))!.acceptance!.find((a) => a.text === 'b');
    expect(b).toMatchObject({ selfCheck: 'fail', evidence: 'b is not there' });
    expect(await review.selfCheck(t.id, 3, 'pass')).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('patch validates priority / kind / title', async () => {
    const t = await ticket(1);
    expect(await review.patch(t.id, { priority: 'urgent', kind: 'issue', assignee: 'ella' })).toMatchObject({
      ok: true,
      ticket: { priority: 'urgent', kind: 'issue', assignee: 'ella' },
    });
    expect(await review.patch(t.id, { priority: 'asap' as never })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await review.patch(t.id, { title: ' ' })).toMatchObject({ ok: false, reason: 'invalid' });
  });
});
