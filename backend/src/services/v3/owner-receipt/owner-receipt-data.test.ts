/**
 * Tests for the owner receipt data layer (#828).
 */

import { createRequest, type Request } from '../../../types/v2/request.types.js';
import { createWorkItem, REVIEW_ESCALATED_TO_OWNER_KEY, type WorkItem } from '../../../types/v2/work-item.types.js';
import { OWNER_RECEIPT_CONSTANTS } from '../../../constants.js';
import {
  buildReceiptData,
  cumulativeMeterCost,
  extractDeliverables,
  localDate,
  localMidnight,
  localParts,
  outcomeOf,
  resolveReceiptWindow,
  shortenAsk,
} from './owner-receipt-data.js';
import type { ReceiptWindow } from './owner-receipt.types.js';

const TZ = 'America/New_York';
/** 2026-09-26 21:00 EDT */
const NOW = new Date('2026-09-27T01:00:00Z');
const WINDOW: ReceiptWindow = { from: '2026-09-26T04:00:00.000Z', to: NOW.toISOString(), basis: 'local_day', timezone: TZ };

let seq = 0;
/**
 * A ticket.
 *
 * @param over - Fields to change
 * @returns Request
 */
function ticket(over: Partial<Request> = {}): Request {
  seq += 1;
  const r = createRequest({
    sourceConversationItemId: `ref-${seq}`,
    title: `t${seq}`,
    description: over.description ?? `ask number ${seq}`,
    ticketNumber: over.ticketNumber ?? seq,
  });
  return { ...r, createdAt: '2026-09-26T15:00:00.000Z', requiresConfirmation: true, origin: { channel: 'slack-channel', ref: `ref-${seq}`, author: 'U1' }, ...over };
}

/**
 * A WorkItem.
 *
 * @param over - Fields to change
 * @returns WorkItem
 */
function item(over: Partial<WorkItem> = {}): WorkItem {
  return { ...createWorkItem({ type: 'delegate', owner: 'agent', title: 'work' }), ...over };
}

const TEAMS = new Map([
  ['atlas', 'Think Tank'],
  ['ella', 'Crewly Marketing'],
  ['nova', 'CE'],
]);
const teamOf = (s: string): string | null => TEAMS.get(s) ?? null;

beforeEach(() => {
  seq = 0;
});

describe('buildReceiptData — every ticket of the window exactly once, by team', () => {
  it('includes tickets created in the window (split children and questions too), each once, grouped by team', () => {
    const parent = ticket({ assignee: 'atlas', status: 'done' });
    const child = ticket({ assignee: 'atlas', parentTicketId: parent.id, tags: ['ticket', 'split'] });
    const question = ticket({ assignee: 'atlas', kind: 'question', requiresConfirmation: false, status: 'done' });
    const marketing = ticket({ assignee: 'ella' });
    const nobody = ticket({});
    const yesterday = ticket({ assignee: 'atlas', createdAt: '2026-09-26T03:59:59.000Z' });
    const legacy = { ...ticket({ assignee: 'ella' }), ticketNumber: undefined };
    const data = buildReceiptData({ requests: [marketing, child, legacy, nobody, parent, question, yesterday], workItems: [], window: WINDOW, teamOf, now: NOW });

    const all = data.teams.flatMap((t) => t.asks.map((a) => a.ticketId));
    // Examined 7, 5 in the window; a legacy Request (no number) and one from before are not asks.
    expect(all).toHaveLength(5);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([parent.id, child.id, question.id, marketing.id, nobody.id].sort());
    expect(data.askCount).toBe(5);
    expect(data.teams.map((t) => [t.team, t.asks.length])).toEqual([
      ['Think Tank', 3],
      ['Crewly Marketing', 1],
      [OWNER_RECEIPT_CONSTANTS.UNASSIGNED_TEAM, 1],
    ]);
    const tt = data.teams[0].asks;
    expect(tt.find((a) => a.ticketId === child.id)?.parentTicketId).toBe(parent.id);
    expect(tt.find((a) => a.ticketId === question.id)?.isQuestion).toBe(true);
  });

  it('counts outcomes over every ask, and they add up to the ask count', () => {
    const tickets = [
      ticket({ assignee: 'atlas', status: 'done' }),
      ticket({ assignee: 'atlas', status: 'running' }),
      ticket({ assignee: 'atlas', status: 'waiting_confirmation', submittedAt: '2026-09-26T16:00:00Z' }),
      ticket({ assignee: 'ella', status: 'blocked' }),
      ticket({ status: 'open' }),
      ticket({ assignee: 'ella', status: 'cancelled' }),
    ];
    const data = buildReceiptData({ requests: tickets, workItems: [], window: WINDOW, teamOf, now: NOW });
    expect(data.outcomes).toEqual({ done: 1, to_review: 1, in_progress: 1, blocked: 1, unowned: 1, dismissed: 1 });
    expect(Object.values(data.outcomes).reduce((a, b) => a + b, 0)).toBe(data.askCount);
  });

  it('finds deliverables in WorkItem outputs and the reply, and counts them', () => {
    const t = ticket({ assignee: 'atlas', status: 'done', reply: { messageId: 'm1', by: 'atlas', at: '2026-09-26T16:00:00Z', excerpt: '报告在 .crewly/research/2026-09-26-orca.pdf' } });
    const wi = item({ requestId: t.id, output: { summary: 'opened https://github.com/o/r/pull/831 and https://github.com/o/r/issues/828' } });
    const data = buildReceiptData({ requests: [t], workItems: [wi], window: WINDOW, teamOf, now: NOW });
    expect(data.teams[0].asks[0].deliverables.map((d) => [d.kind, d.label])).toEqual([
      ['file', '2026-09-26-orca.pdf'],
      ['pr', '#831'],
      ['issue', '#828'],
    ]);
    expect(data.deliverables).toEqual({ pr: 1, issue: 1, file: 1, link: 0 });
  });
});

describe('waiting on you', () => {
  it('lists every ticket in 待验收 whatever day it was asked, plus WorkItems escalated to the owner (#813)', () => {
    const old = ticket({ assignee: 'ella', status: 'waiting_confirmation', createdAt: '2026-09-20T10:00:00Z', submittedAt: '2026-09-21T10:00:00Z', reply: { messageId: 'm2', by: 'ella', at: '2026-09-21T10:00:00Z', excerpt: '只写 Orca，行吗？' } });
    const today = ticket({ assignee: 'atlas', status: 'waiting_confirmation', submittedAt: '2026-09-26T17:00:00Z' });
    const questionAnswered = ticket({ assignee: 'atlas', status: 'waiting_confirmation', kind: 'question', requiresConfirmation: false });
    const running = ticket({ assignee: 'atlas', status: 'running' });
    const escalated = item({ status: 'done_by_worker', title: 'Blog preview fix', target: 'ella', metadata: { [REVIEW_ESCALATED_TO_OWNER_KEY]: '2026-09-25T12:00:00Z' } });
    const merelyAwaiting = item({ status: 'done_by_worker', title: 'not escalated' });
    const data = buildReceiptData({ requests: [old, today, questionAnswered, running], workItems: [escalated, merelyAwaiting], window: WINDOW, teamOf, now: NOW });

    // 4 tickets and 2 WorkItems examined; 2 tickets and 1 WorkItem are waiting on him.
    expect(data.waiting.map((w) => [w.source, w.id])).toEqual([
      ['ticket_review', old.id],
      ['owner_escalation', escalated.id],
      ['ticket_review', today.id],
    ]);
    expect(data.waiting[0]).toMatchObject({ team: 'Crewly Marketing', question: '只写 Orca，行吗？', tkt: expect.stringMatching(/^TKT-/) });
  });
});

describe('cost — never a number it cannot stand behind (#812)', () => {
  it('a non-zero CUMULATIVE session meter is not tracked', () => {
    const t = ticket({ assignee: 'ella', status: 'done' });
    const wi = item({ requestId: t.id, cost: 1137.05 });
    const data = buildReceiptData({ requests: [t], workItems: [wi], window: WINDOW, teamOf, now: NOW });
    expect(data.teams[0].cost).toEqual({ status: 'not_tracked', reason: 'cumulative_meter' });
  });

  it('no meter at all is also not tracked (never $0)', () => {
    expect(cumulativeMeterCost('x', [item({ cost: 0 })], WINDOW)).toEqual({ status: 'not_tracked', reason: 'no_data' });
    expect(cumulativeMeterCost('x', [], WINDOW)).toEqual({ status: 'not_tracked', reason: 'no_data' });
  });

  it('a real per-day source is used when given', () => {
    const t = ticket({ assignee: 'ella' });
    const data = buildReceiptData({ requests: [t], workItems: [], window: WINDOW, teamOf, now: NOW, cost: () => ({ status: 'tracked', usd: 4.2 }) });
    expect(data.teams[0].cost).toEqual({ status: 'tracked', usd: 4.2 });
  });
});

describe('outcomeOf', () => {
  it('maps status and WorkItems to an outcome', () => {
    expect(outcomeOf(ticket({ status: 'done' }), [])).toBe('done');
    expect(outcomeOf(ticket({ status: 'cancelled' }), [])).toBe('dismissed');
    expect(outcomeOf(ticket({ status: 'waiting_confirmation' }), [])).toBe('to_review');
    // A question has no acceptance step: answered is done.
    expect(outcomeOf(ticket({ status: 'waiting_confirmation', requiresConfirmation: false }), [])).toBe('done');
    expect(outcomeOf(ticket({ status: 'running', assignee: 'a' }), [item({ status: 'blocked' })])).toBe('blocked');
    expect(outcomeOf(ticket({ status: 'open' }), [])).toBe('unowned');
    expect(outcomeOf(ticket({ status: 'open' }), [item({ status: 'queued' })])).toBe('in_progress');
  });
});

describe('the window', () => {
  it('defaults to since the last receipt', () => {
    const w = resolveReceiptWindow({ now: NOW, timezone: TZ, lastSentAt: '2026-09-26T01:00:00.000Z' });
    expect(w).toEqual({ from: '2026-09-26T01:00:00.000Z', to: NOW.toISOString(), basis: 'since_last_receipt', timezone: TZ });
  });

  it('falls back to the local day for the first receipt, and on request', () => {
    expect(resolveReceiptWindow({ now: NOW, timezone: TZ })).toMatchObject({ from: '2026-09-26T04:00:00.000Z', basis: 'local_day' });
    expect(resolveReceiptWindow({ now: NOW, timezone: TZ, lastSentAt: '2026-09-26T01:00:00Z', mode: 'local_day' }).basis).toBe('local_day');
  });

  it('takes an explicit window', () => {
    expect(resolveReceiptWindow({ now: NOW, timezone: TZ, from: '2026-09-26T04:00:00Z', to: '2026-09-26T18:00:00Z' })).toEqual({
      from: '2026-09-26T04:00:00.000Z',
      to: '2026-09-26T18:00:00.000Z',
      basis: 'explicit',
      timezone: TZ,
    });
  });

  it('a last-sent time in the future is ignored (clock skew)', () => {
    expect(resolveReceiptWindow({ now: NOW, timezone: TZ, lastSentAt: '2026-09-28T00:00:00Z' }).basis).toBe('local_day');
  });

  it('local time helpers handle other zones and DST', () => {
    expect(localParts(NOW, TZ)).toMatchObject({ year: 2026, month: 9, day: 26, hour: 21, minute: 0, weekday: 6 });
    expect(localDate(NOW, 'Asia/Shanghai')).toBe('2026-09-27');
    expect(localMidnight(NOW, 'Asia/Shanghai').toISOString()).toBe('2026-09-26T16:00:00.000Z');
    // EST in winter: midnight is 05:00Z.
    expect(localMidnight(new Date('2026-12-01T12:00:00Z'), TZ).toISOString()).toBe('2026-12-01T05:00:00.000Z');
  });
});

describe('shortenAsk and extractDeliverables', () => {
  it('keeps the owner\'s first line, drops mentions and file lines, cuts long text', () => {
    expect(shortenAsk('<@U0C2ZK849ND> 可以去研究一下opus做视频那个吗\n可以怎么加到flopost里')).toBe('可以去研究一下opus做视频那个吗');
    expect(shortenAsk('[Slack File: /path/a.m4a (Audio)]')).toBe('（语音或文件）');
    const long = shortenAsk('很'.repeat(100), 20);
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(10);
  });

  it('redacts secrets from ask text and deliverables', () => {
    expect(shortenAsk('use token ghp_abcdefghijklmnopqrstuvwxyz123456 please')).not.toContain('ghp_abcdef');
    const d = extractDeliverables(['see https://example.com/x?key=AKIAABCDEFGHIJKLMNOP']);
    expect(JSON.stringify(d)).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('deduplicates and ignores empty inputs', () => {
    expect(extractDeliverables([null, '', 'https://a.b/c https://a.b/c.'])).toEqual([{ kind: 'link', ref: 'https://a.b/c', label: 'a.b' }]);
  });
});
