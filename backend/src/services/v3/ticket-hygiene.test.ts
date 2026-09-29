/**
 * Tests for ticket hygiene (specs/ticket-calm.md): which answers wait for the
 * owner, staleness, and the one-time cleanup (dry run, apply, idempotent).
 *
 * The cleanup runs against a real RequestService in a temp dir, so the `done`
 * gate (review + open children) is exercised too.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RequestService } from './request.service.js';
import { answerNeedsOwner, isStaleTicket, planTicketCleanup, runTicketCleanup, staleCloseUpdate, ticketLastActivity } from './ticket-hygiene.js';
import { TICKET_CONSTANTS } from '../../constants.js';
import { createRequest, type Request } from '../../types/v2/request.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * A ticket-shaped Request for the pure functions.
 *
 * @param over - Fields to set
 * @returns Request
 */
function req(over: Partial<Request> = {}): Request {
  return {
    ...createRequest({ sourceConversationItemId: `s-${Math.random()}`, title: 't', description: '看看这个' }),
    ticketNumber: 1,
    requiresConfirmation: true,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...over,
  };
}

describe('answerNeedsOwner — only deliverables (or a question to him) wait', () => {
  const reply = (excerpt: string) => ({ at: '2026-09-28T00:00:00Z', by: 'atlas', messageId: 'm', excerpt });

  it.each([
    ['看看这个 https://x.com/a/status/1', '这篇讲的是 agent 记忆的三种做法。'],
    ['研究一下 Muse 的产品', 'Muse 主打个人助理，三点值得学：……'],
    ['这个团队都有几个人', 'CE 团队有 3 个 agent。'],
    ['所以Nova已经登陆过了？', '你的登录是生效了的，但 Nova 还是没起来。'],
  ])('%s → closes on the answer', (description, excerpt) => {
    expect(answerNeedsOwner({ description, kind: 'feature', intentCategory: 'research', reply: reply(excerpt) })).toBe(false);
  });

  it.each([
    ['帮我draft一个微信的回信', '草稿如下……'],
    ['结合上面的写一份pdf给我', '写好了：report.pdf'],
    ['每天晚上美东时间11:30跑一下daily ops 帮我设置一下', '已经设置好了。'],
    ['可以在ce的团队下添加一个codex agent吗？', '加好了。'],
  ])('%s → waits for the owner (deliverable)', (description, excerpt) => {
    expect(answerNeedsOwner({ description, kind: 'feature', intentCategory: 'other', reply: reply(excerpt) })).toBe(true);
  });

  it('an answer that asks him something waits, whatever was asked', () => {
    expect(
      answerNeedsOwner({ description: '你怎么看他的观点', kind: 'feature', intentCategory: 'research', reply: reply('两个办法，每周一次还是每月一次，你定？') }),
    ).toBe(true);
  });

  it('a change (code / deploy) always waits; a question ticket never does', () => {
    expect(answerNeedsOwner({ description: 'x', kind: 'feature', intentCategory: 'code_change', reply: reply('ok') })).toBe(true);
    expect(answerNeedsOwner({ description: '帮我写', kind: 'question', intentCategory: 'code_change', reply: reply('行吗？') })).toBe(false);
  });
});

describe('staleness', () => {
  it('last activity is the latest of created / updated / answer / submit / discussion', () => {
    const r = req({
      reply: { at: '2026-09-22T00:00:00.000Z', by: 'a', messageId: 'm', excerpt: 'x' },
      discussion: [{ at: '2026-09-23T00:00:00.000Z', author: 'U', text: 'y', ref: 'r' }],
    });
    expect(new Date(ticketLastActivity(r)).toISOString()).toBe('2026-09-23T00:00:00.000Z');
  });

  it('open / running idle for 3 days is stale; 待验收 and done never are', () => {
    const at = Date.parse('2026-09-20T00:00:00.000Z');
    expect(isStaleTicket(req({ status: 'open' }), at + TICKET_CONSTANTS.STALE.AFTER_MS - 1)).toBe(false);
    expect(isStaleTicket(req({ status: 'open' }), at + TICKET_CONSTANTS.STALE.AFTER_MS)).toBe(true);
    expect(isStaleTicket(req({ status: 'running' }), at + 10 * DAY)).toBe(true);
    expect(isStaleTicket(req({ status: 'waiting_confirmation' }), at + 10 * DAY)).toBe(false);
    expect(isStaleTicket(req({ status: 'done' }), at + 10 * DAY)).toBe(false);
  });

  it('the stale close cancels, tags and leaves a note', () => {
    const u = staleCloseUpdate(req({ tags: ['ticket'] }), '2026-09-28T00:00:00.000Z');
    expect(u).toMatchObject({ status: 'cancelled', tags: ['ticket', TICKET_CONSTANTS.STALE.TAG] });
    expect(u.discussion?.at(-1)).toMatchObject({ text: TICKET_CONSTANTS.STALE.NOTE, author: TICKET_CONSTANTS.STALE.NOTE_AUTHOR });
  });
});

describe('planTicketCleanup', () => {
  it('accepts old 待验收, closes stale open / running, leaves the rest', () => {
    const now = Date.parse('2026-09-29T01:00:00.000Z');
    const plan = planTicketCleanup(
      [
        req({ id: 'old-review', status: 'waiting_confirmation', submittedAt: '2026-09-26T00:00:00.000Z' }),
        req({ id: 'new-review', status: 'waiting_confirmation', submittedAt: '2026-09-28T20:00:00.000Z', updatedAt: '2026-09-28T20:00:00.000Z' }),
        req({ id: 'stale-open', status: 'open' }),
        req({ id: 'busy-running', status: 'running', updatedAt: '2026-09-28T00:00:00.000Z' }),
        req({ id: 'done', status: 'done' }),
        req({ id: 'legacy', status: 'open', ticketNumber: undefined }),
      ],
      { now },
    );
    expect(plan.actions.map((a) => [a.id, a.action])).toEqual([
      ['old-review', 'accept'],
      ['stale-open', 'stale'],
      ['legacy', 'stale'],
    ]);
    expect(plan).toMatchObject({ applied: false, scanned: 6, accept: 1, stale: 2 });
    expect(planTicketCleanup([req({ status: 'open', ticketNumber: undefined })], { now, includeLegacy: false }).actions).toEqual([]);
  });
});

describe('runTicketCleanup — against a real RequestService', () => {
  let dir: string;
  let requests: RequestService;
  const workItems = new Map<string, Pick<WorkItem, 'id' | 'status'>>();

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ticket-cleanup-'));
    RequestService.resetInstance();
    requests = RequestService.getInstance(dir);
    workItems.clear();
    requests.setTaskPoolService({ findWorkItem: async (id) => (workItems.get(id) as WorkItem | undefined) ?? null });
  });

  afterEach(async () => {
    RequestService.resetInstance();
    await fs.rm(dir, { recursive: true, force: true });
  });

  /**
   * A numbered ticket, optionally moved to a status and given WorkItems.
   *
   * @param n - Ticket number (0 = legacy Request, no number)
   * @param status - Target status
   * @param items - WorkItem statuses to link
   * @returns Its id
   */
  async function make(n: number, status: 'open' | 'running' | 'waiting_confirmation' | 'done', items: WorkItem['status'][] = []): Promise<string> {
    const r = await requests.create({
      sourceConversationItemId: `src-${n}-${Math.random()}`,
      title: `ticket ${n}`,
      description: `帮我写一份报告 ${n}`,
      ...(n > 0 ? { ticketNumber: n, requiresConfirmation: true, origin: { channel: 'slack-channel' as const, ref: `r${n}`, author: 'U' } } : {}),
    });
    items.forEach((s, i) => workItems.set(`${r.id}-wi-${i}`, { id: `${r.id}-wi-${i}`, status: s }));
    for (let i = 0; i < items.length; i++) await requests.linkWorkItem(r.id, `${r.id}-wi-${i}`);
    if (status === 'running' || status === 'waiting_confirmation' || status === 'done') await requests.update(r.id, { status: 'running' });
    if (status === 'waiting_confirmation') await requests.update(r.id, { status: 'done' }); // the gate turns it into 待验收
    if (status === 'done') await requests.update(r.id, { status: 'done', accepted: true });
    return r.id;
  }

  it('dry run by default: reports counts, writes nothing; apply closes them; a second run changes nothing', async () => {
    const review = await make(1, 'waiting_confirmation');
    const reviewDead = await make(2, 'waiting_confirmation', ['rejected', 'verified']);
    const reviewLive = await make(3, 'waiting_confirmation', ['running']);
    const open = await make(4, 'open');
    const done = await make(5, 'done');
    const legacy = await make(0, 'open');
    expect((await requests.getById(review))?.status).toBe('waiting_confirmation');
    const now = Date.now() + 4 * DAY;

    const dry = await runTicketCleanup(requests, { now });
    expect(dry).toMatchObject({ applied: false, scanned: 6, accept: 3, stale: 2, failed: [] });
    expect((await requests.getById(review))?.status).toBe('waiting_confirmation');
    expect((await requests.getById(open))?.status).toBe('open');

    const applied = await runTicketCleanup(requests, { now, apply: true });
    expect(applied).toMatchObject({ applied: true, accept: 2, stale: 2 });
    expect(applied.failed.map((f) => f.id)).toEqual([reviewLive]);
    expect(await requests.getById(review)).toMatchObject({ status: 'done', acceptedBy: 'silence' });
    expect((await requests.getById(review))?.tags).toContain(TICKET_CONSTANTS.REVIEW.AUTO_ACCEPTED_TAG);
    // A rejected verify that its retry replaced no longer holds an accepted ticket open.
    expect((await requests.getById(reviewDead))?.status).toBe('done');
    // A live WorkItem still does.
    expect((await requests.getById(reviewLive))?.status).toBe('waiting_confirmation');
    expect(await requests.getById(open)).toMatchObject({ status: 'cancelled', tags: expect.arrayContaining([TICKET_CONSTANTS.STALE.TAG]) });
    expect((await requests.getById(legacy))?.status).toBe('cancelled');
    expect((await requests.getById(done))?.status).toBe('done');

    const again = await runTicketCleanup(requests, { now, apply: true });
    expect(again).toMatchObject({ accept: 0, stale: 0 });
    expect(again.actions.map((a) => a.id)).toEqual([reviewLive]);
    expect((await requests.getById(open))?.discussion).toHaveLength(1);
  });
});
