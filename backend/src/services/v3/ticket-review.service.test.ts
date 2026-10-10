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
import { TicketReviewService, nudgeText, type ReworkInput } from './ticket-review.service.js';
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
  opts: { channel?: TicketOriginChannel; assignee?: string; chatChannelId?: string; messageId?: string; description?: string } = {},
): Promise<Request> {
  const channel = opts.channel ?? 'slack-channel';
  const t = await requests.create({
    sourceConversationItemId: `src-${n}`,
    title: `ticket ${n}`,
    // A deliverable by default (a report to write), so the answer waits for the
    // owner; plain questions close on the answer (see 'plain answers close').
    description: opts.description ?? `帮我写一份报告 ${n}`,
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

  it('an interim note ("got it, plan: …") is not the answer', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    expect(await review.onChatMessage({ ...agentMsg('ch1', 'atlas', 'got it, plan: …', 'm1'), metadata: { interim: true } })).toBeNull();
    expect((await requests.getById(t.id))?.reply).toBeUndefined();
  });

  it('"I\'m building it now" is a promise, not the answer (2026-10-10)', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    expect(await review.onChatMessage(agentMsg('ch1', 'atlas', "I'm breaking down the shot list now, then building the crab version.", 'm1'))).toBeNull();
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
    expect(r).toMatchObject({ ok: true, ticket: { status: 'done', acceptedBy: 'owner' } });
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
    expect(after?.discussion?.at(-1)?.text).toBe('Sent back: the numbers are last month');
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
    // #813: silence is acceptance, never a review.
    expect(after?.acceptedBy).toBe('silence');
  });
});

describe('auto-accept: the owner moved on in the thread', () => {
  /** Put a ticket in 待验收 and return it. */
  async function submitted(n: number) {
    const t = await ticket(n, { chatChannelId: `ch${n}`, messageId: `m${n}` });
    await review.onChatMessage(agentMsg(`ch${n}`, 'atlas', 'answer', `m${n}`));
    await review.onAgentIdle('atlas');
    return (await requests.getById(t.id))!;
  }

  /** The owner said something in the ticket's thread after the answer. */
  async function ownerSays(id: string, text: string) {
    const t = (await requests.getById(id))!;
    const at = new Date(Date.parse(t.submittedAt!) + 60_000).toISOString();
    await requests.update(id, { discussion: [...(t.discussion ?? []), { at, author: 'U1', text, ref: `r-${Math.random()}` }] });
  }

  it('settles well before the deadline, silently, with the reason recorded', async () => {
    const t = await submitted(1);
    await ownerSays(t.id, '那个房间变大 宠物变小的上线了吗');
    expect((await review.sweep()).autoAccepted).toBe(1);
    const after = (await requests.getById(t.id))!;
    expect(after.status).toBe('done');
    expect(after.acceptedBy).toBe('silence');
    expect(after.tags).toContain(TICKET_CONSTANTS.REVIEW.AUTO_ACCEPTED_TAG);
    expect(after.discussion?.some((d) => d.text === 'auto-accepted: no objection' && d.author === 'crewly')).toBe(true);
    // The owner is told nothing: no nudge, no extra receipt beyond the done swap.
  });

  it('a send-back or a "where is it" is an objection and keeps it in review', async () => {
    const a = await submitted(1);
    await ownerSays(a.id, '打回 少了截图');
    const b = await submitted(2);
    await ownerSays(b.id, '链接发到哪了？没看到');
    expect((await review.sweep()).autoAccepted).toBe(0);
    expect((await requests.getById(a.id))?.status).toBe('waiting_confirmation');
    expect((await requests.getById(b.id))?.status).toBe('waiting_confirmation');
  });

  it('no later owner message, inside the window: stays; past 24h: settles with the reason', async () => {
    const t = await submitted(1);
    expect((await review.sweep()).autoAccepted).toBe(0);
    clock = Date.now() + TICKET_CONSTANTS.REVIEW.AUTO_ACCEPT_MS + 60_000;
    expect((await review.sweep()).autoAccepted).toBe(1);
    expect((await requests.getById(t.id))?.discussion?.some((d) => d.text === 'auto-accepted: no objection')).toBe(true);
  });

  it('does not settle early while the agent still owes the owner an open item', async () => {
    const t = await submitted(1);
    await ownerSays(t.id, '好 那继续吧');
    const cur = (await requests.getById(t.id))!;
    await requests.update(t.id, {
      openItems: [{ id: 'q-1', type: 'question', agent: 'atlas', sourceMessageId: 'x', createdAt: new Date().toISOString(), status: 'open', text: '你同意吗？' }],
    });
    expect(cur.status).toBe('waiting_confirmation');
    expect((await review.sweep()).autoAccepted).toBe(0);
  });
});

describe('plain answers close (2026-09-28: only deliverables wait for the owner)', () => {
  it('an answer to a plain ask closes the ticket as done, tagged answered, with no acceptedBy', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1', description: '看看这个 https://x.com/a/status/1' });
    await review.onChatMessage(agentMsg('ch1', 'atlas', '这篇讲的是 agent 记忆的三种做法，我们已经有第一种。', 'm1'));
    const [submitted] = await review.onAgentIdle('atlas');
    expect(submitted).toMatchObject({ id: t.id, status: 'done' });
    expect(submitted.tags).toContain(TICKET_CONSTANTS.REVIEW.ANSWERED_TAG);
    expect(submitted.acceptedBy).toBeUndefined();
  });

  it('a question ticket (这个团队都有几个人) closes on the answer', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1', description: '这个团队都有几个人' });
    await review.onChatMessage(agentMsg('ch1', 'owen', 'CE 团队有 3 个 agent：Owen、Vera、Nova。', 'm1'));
    const [submitted] = await review.onAgentIdle('owen');
    expect(submitted.status).toBe('done');
    expect(t.id).toBe(submitted.id);
  });

  it('an answer that asks the owner something waits for him', async () => {
    await ticket(1, { chatChannelId: 'ch1', messageId: 'm1', description: '你怎么看路易斯哥的观点' });
    await review.onChatMessage(agentMsg('ch1', 'atlas', '两个办法可以叠着用，每周一次还是每月一次，你定？', 'm1'));
    const [submitted] = await review.onAgentIdle('atlas');
    expect(submitted.status).toBe('waiting_confirmation');
  });

  it('a deliverable (a draft to send) waits for the owner', async () => {
    await ticket(1, { chatChannelId: 'ch1', messageId: 'm1', description: '帮我draft一个微信的回信' });
    await review.onChatMessage(agentMsg('ch1', 'atlas', '草稿在这里：……', 'm1'));
    const [submitted] = await review.onAgentIdle('atlas');
    expect(submitted.status).toBe('waiting_confirmation');
  });
});

describe('stale tickets (open / running idle for 3 days)', () => {
  it('closes an idle ticket as stale with a note; recent ones stay', async () => {
    const idle = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    const created = Date.parse(idle.createdAt);
    clock = created + TICKET_CONSTANTS.STALE.AFTER_MS - 60_000;
    expect((await review.sweep()).staleClosed).toBe(0);
    clock = created + TICKET_CONSTANTS.STALE.AFTER_MS + 60_000;
    expect((await review.sweep()).staleClosed).toBe(1);
    const after = await requests.getById(idle.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.tags).toContain(TICKET_CONSTANTS.STALE.TAG);
    expect(after?.discussion?.at(-1)).toMatchObject({ author: TICKET_CONSTANTS.STALE.NOTE_AUTHOR, text: TICKET_CONSTANTS.STALE.NOTE });
  });

  it('does not close a ticket whose WorkItems are still live', async () => {
    const t = await ticket(1);
    openWork.set(t.id, 1);
    clock = Date.parse(t.createdAt) + TICKET_CONSTANTS.STALE.AFTER_MS + 60_000;
    expect((await review.sweep()).staleClosed).toBe(0);
    expect((await requests.getById(t.id))?.status).toBe('open');
  });

  it('the agent answering in its thread reopens a stale ticket', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    clock = Date.parse(t.createdAt) + TICKET_CONSTANTS.STALE.AFTER_MS + 60_000;
    await review.sweep();
    expect((await requests.getById(t.id))?.status).toBe('cancelled');
    const reopened = await review.onChatMessage(agentMsg('ch1', 'atlas', '补上了，报告在这里', 'm1'));
    expect(reopened).toMatchObject({ id: t.id, status: 'running', reply: { by: 'atlas' } });
    expect(reopened?.tags).not.toContain(TICKET_CONSTANTS.STALE.TAG);
    // A dismissed (不用记) ticket is never reopened this way.
    await requests.update(t.id, { status: 'cancelled', tags: [...reopened!.tags, TICKET_CONSTANTS.DISMISSED_TAG] });
    expect(await review.onChatMessage(agentMsg('ch1', 'atlas', 'again', 'm1'))).toBeNull();
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

describe('follow-up by the agent (owner, 2026-09-24)', () => {
  it('nudges the answering agent once, then silence accepts 24h after the answer', async () => {
    const nudges: Array<[string, string]> = [];
    const r = new TicketReviewService({
      requests,
      fallbackAgent: 'crewly-orc',
      now: () => new Date(clock),
      nudgeAgent: async (agent, text) => void nudges.push([agent, text]),
    });
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    await r.noteChatTurn(t.id, { id: 'm1', channelId: 'ch1' });
    await r.onChatMessage(agentMsg('ch1', 'atlas', 'done: report', 'm1'));
    await r.onAgentIdle('atlas');
    const submittedAt = Date.parse((await requests.getById(t.id))!.submittedAt!);

    clock = submittedAt + TICKET_CONSTANTS.REVIEW.NUDGE_AFTER_MS - 60_000;
    await r.sweep();
    expect(nudges).toHaveLength(0);

    clock = submittedAt + TICKET_CONSTANTS.REVIEW.NUDGE_AFTER_MS + 60_000;
    await r.sweep();
    expect(nudges).toHaveLength(1);
    expect(nudges[0][0]).toBe('atlas');
    expect((await requests.getById(t.id))?.nudgeCount).toBe(1);

    // No second nudge (MAX_NUDGES = 1), still waiting just before the deadline.
    clock = submittedAt + TICKET_CONSTANTS.REVIEW.AUTO_ACCEPT_MS - 60_000;
    await r.sweep();
    expect(nudges).toHaveLength(1);
    expect((await requests.getById(t.id))?.status).toBe('waiting_confirmation');

    clock = submittedAt + TICKET_CONSTANTS.REVIEW.AUTO_ACCEPT_MS + 60_000;
    await r.sweep();
    const after = await requests.getById(t.id);
    expect(after?.status).toBe('done');
    expect(after?.tags).toContain(TICKET_CONSTANTS.REVIEW.AUTO_ACCEPTED_TAG);
    // #813: silence is acceptance, never a review.
    expect(after?.acceptedBy).toBe('silence');
    expect(nudges).toHaveLength(1);
  });

  it('the deadline counts from the answer: a nudge that never went out does not hold it (2026-09-28)', async () => {
    const r = new TicketReviewService({
      requests,
      fallbackAgent: 'crewly-orc',
      now: () => new Date(clock),
      nudgeAgent: async () => {
        throw new Error('agent offline');
      },
    });
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    await r.onChatMessage(agentMsg('ch1', 'atlas', 'done: report', 'm1'));
    await r.onAgentIdle('atlas');
    const submittedAt = Date.parse((await requests.getById(t.id))!.submittedAt!);
    clock = submittedAt + TICKET_CONSTANTS.REVIEW.AUTO_ACCEPT_MS + 60_000;
    expect((await r.sweep()).autoAccepted).toBe(1);
    expect((await requests.getById(t.id))?.status).toBe('done');
  });

  it('the nudge speaks to the agent, points at the thread, and forbids ticket words toward the owner', async () => {
    const t = await ticket(1, { chatChannelId: 'ch1', messageId: 'm1' });
    const text = nudgeText({ ...t, submittedAt: new Date(clock - 25 * 3_600_000).toISOString() }, clock);
    expect(text).toContain('--channel ch1 --thread m1');
    expect(text).toContain('do not mention tickets');
    expect(text).toContain('about 25 hours');
  });
});
