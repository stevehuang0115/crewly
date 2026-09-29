/**
 * Tests for the owner receipt data layer (#828).
 */

import { createRequest, type Request } from '../../../types/v2/request.types.js';
import { createWorkItem, REVIEW_ESCALATED_TO_OWNER_KEY, type WorkItem } from '../../../types/v2/work-item.types.js';
import { OWNER_RECEIPT_CONSTANTS } from '../../../constants.js';
import {
  askLineOf,
  buildReceiptData,
  fitLine,
  isMisrouted,
  isReceiptEmpty,
  ownerQuestionOf,
  summarizeOutcome,
  teamLabeller,
  ticketTeamOf,
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

  it('names each team\'s lead when teamLeadOf resolves one (Ava\'s reference: CE（Owen）); unassigned never gets one', () => {
    const teamLeadOf = (t: string): string | null => ({ 'Think Tank': 'Atlas', 'Crewly Marketing': 'Ella' })[t] ?? null;
    const data = buildReceiptData({
      requests: [ticket({ assignee: 'atlas' }), ticket({ assignee: 'ella' }), ticket({})],
      workItems: [],
      window: WINDOW,
      teamOf,
      teamLeadOf,
      now: NOW,
    });
    // Equal-sized teams tie-break alphabetically (buildReceiptData's own sort).
    expect(data.teams.map((t) => [t.team, t.lead])).toEqual([
      ['Crewly Marketing', 'Ella'],
      ['Think Tank', 'Atlas'],
      [OWNER_RECEIPT_CONSTANTS.UNASSIGNED_TEAM, null],
    ]);
  });

  it('every team\'s lead is null when teamLeadOf is not given at all (backward compatible)', () => {
    const data = buildReceiptData({ requests: [ticket({ assignee: 'atlas' })], workItems: [], window: WINDOW, teamOf, now: NOW });
    expect(data.teams.map((t) => t.lead)).toEqual([null]);
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

describe('coverage (#828: the receipt says what it covers)', () => {
  const at = (h: number) => `2026-09-26T${String(h).padStart(2, '0')}:00:00.000Z`;

  it('counts every logged owner message in the window by what intake did with it', () => {
    const log = {
      startedAt: '2026-09-20T00:00:00.000Z',
      events: [
        { at: at(12), ref: 'a', action: 'created' as const, ticketId: 't1', ticketNumber: 1 },
        { at: at(13), ref: 'b', action: 'appended' as const, ticketId: 't1', ticketNumber: 1, askSignal: true, text: '可以去研究一下opus做视频那个吗' },
        { at: at(13), ref: 'c', action: 'appended' as const, ticketId: 't1', ticketNumber: 1 },
        { at: at(14), ref: 'd', action: 'ignored' as const, reason: 'trivial_or_short' },
        { at: at(14), ref: 'e', action: 'ignored' as const, reason: 'status_ping' },
        { at: at(14), ref: 'e', action: 'ignored' as const, reason: 'status_ping' }, // same message twice: once
        { at: '2026-09-26T02:00:00.000Z', ref: 'old', action: 'created' as const, ticketId: 't0' }, // before the window
      ],
    };
    const data = buildReceiptData({ requests: [], workItems: [], window: WINDOW, teamOf, now: NOW, intakeLog: log });
    expect(data.coverage).toEqual({ status: 'known', messages: 5, created: 1, appended: 2, ignored: 2 });
    expect(data.possiblyMissed).toEqual([
      {
        text: '可以去研究一下opus做视频那个吗',
        ticketId: 't1',
        tkt: 'TKT-001',
        ref: 'b',
        splitCommand: 'split-ticket --ticket TKT-001 --discussion-ref b',
        at: at(13),
      },
    ]);
  });

  it('is unknown — not zero — without a log, or when the log started after the window began', () => {
    expect(buildReceiptData({ requests: [], workItems: [], window: WINDOW, teamOf, now: NOW }).coverage).toEqual({ status: 'unknown', reason: 'not_recorded' });
    expect(buildReceiptData({ requests: [], workItems: [], window: WINDOW, teamOf, now: NOW, intakeLog: { startedAt: null, events: [] } }).coverage.status).toBe('unknown');
    const late = { startedAt: '2026-09-26T12:00:00.000Z', events: [{ at: at(13), ref: 'x', action: 'created' as const, ticketId: 't' }] };
    expect(buildReceiptData({ requests: [], workItems: [], window: WINDOW, teamOf, now: NOW, intakeLog: late }).coverage).toEqual({ status: 'unknown', reason: 'window_before_log' });
  });

  it('an empty but counted window is a real zero', () => {
    const data = buildReceiptData({ requests: [], workItems: [], window: WINDOW, teamOf, now: NOW, intakeLog: { startedAt: '2026-09-01T00:00:00Z', events: [] } });
    expect(data.coverage).toEqual({ status: 'known', messages: 0, created: 0, appended: 0, ignored: 0 });
  });

  it('possibly-missed never lists a pure ack (intake only marks appended messages with request signals)', () => {
    const log = { startedAt: '2026-09-01T00:00:00Z', events: [{ at: at(15), ref: 'ok', action: 'appended' as const, ticketId: 't', text: '好的' }] };
    expect(buildReceiptData({ requests: [], workItems: [], window: WINDOW, teamOf, now: NOW, intakeLog: log }).possiblyMissed).toEqual([]);
  });
});

describe('askLineOf', () => {
  it('picks the line that carries the request, else the text', () => {
    expect(askLineOf('1. 修\n2. 485那个因为体检rfe的可以去其他地方搜索一下吗')).toBe('2. 485那个因为体检rfe的可以去其他地方搜索一下吗');
    expect(askLineOf('这样\n定稿以前我们都不着急\n我倾向于我们去研究一下目前industry')).toBe('我倾向于我们去研究一下目前industry');
    expect(askLineOf('没关系')).toBe('没关系');
  });
});


// ---------------------------------------------------------------------------
// 2026-09-28 redesign: highlights, decisions, who did it
// ---------------------------------------------------------------------------

describe('who did it (team grouping)', () => {
  const label = teamLabeller(teamOf);

  it('the assignee\'s team when the assignee is ours; the answering agent\'s when not', () => {
    expect(ticketTeamOf(ticket({ assignee: 'atlas' }), [], label)).toBe('Think Tank');
    // Addressed to an agent on another machine (a shared room), answered here by Atlas.
    const remote = ticket({ assignee: 'personal-assistant-team-ella-47a2e6e2', reply: { at: 'x', by: 'atlas', messageId: 'm', excerpt: 'e' } });
    expect(ticketTeamOf(remote, [], label)).toBe('Think Tank');
    // Nobody assigned, Owen (CE) answered: not 未分配.
    expect(ticketTeamOf(ticket({ reply: { at: 'x', by: 'nova', messageId: 'm', excerpt: 'e' } }), [], label)).toBe('CE');
    expect(ticketTeamOf(ticket({}), [item({ target: 'ella' })], label)).toBe('Crewly Marketing');
    expect(ticketTeamOf(ticket({ assignee: 'crewly-orc' }), [], label)).toBe(OWNER_RECEIPT_CONSTANTS.ORCHESTRATOR_LABEL);
    expect(ticketTeamOf(ticket({}), [], label)).toBeNull();
  });

  it('asks are grouped by that team too (no Atlas ticket under another team)', () => {
    const remote = ticket({ assignee: 'personal-assistant-team-ella-47a2e6e2', reply: { at: 'x', by: 'atlas', messageId: 'm', excerpt: 'e' } });
    const d = buildReceiptData({ requests: [remote], workItems: [], window: WINDOW, teamOf, now: NOW });
    expect(d.teams.map((t) => t.team)).toEqual(['Think Tank']);
  });

  it('an answer from another team than the assignee\'s is misrouted', () => {
    const reply = (by: string) => ({ at: 'x', by, messageId: 'm', excerpt: 'e' });
    expect(isMisrouted(ticket({ assignee: 'atlas', reply: reply('atlas') }), label)).toBe(false);
    expect(isMisrouted(ticket({ assignee: 'atlas', reply: reply('ella') }), label)).toBe(true);
    expect(isMisrouted(ticket({ assignee: 'atlas', reply: reply('someone-remote') }), label)).toBe(true);
    expect(isMisrouted(ticket({ reply: reply('ella') }), label)).toBe(false);
    // Addressed to another machine's agent, answered here: ours, not misrouted.
    expect(isMisrouted(ticket({ assignee: 'personal-assistant-team-ella-47a2e6e2', reply: reply('atlas') }), label)).toBe(false);
  });
});

describe('wording helpers', () => {
  it('summarizeOutcome takes the first line that says something, in Chinese, without links, paths or marks', () => {
    expect(summarizeOutcome('*结论*\n• 每天早上 8 点问你一个问题，已经设好')).toBe('每天早上 8 点问你一个问题，已经设好');
    expect(summarizeOutcome('看了。这篇长文自己的结论就是：提示词只占 10%')).toBe('这篇长文自己的结论就是：提示词只占 10%');
    // The path goes with its 「路径是」; the short 「存好了。」 opener goes too.
    expect(summarizeOutcome('存好了，路径是 crewly/.crewly/specs/x.md 。这个目录不进公开仓库')).toBe('这个目录不进公开仓库');
    expect(summarizeOutcome('Your team uses AI every day.\n英文版好了，照 v10 译的，没加新内容。可以直接复制发：')).toBe('英文版好了，照 v10 译的，没加新内容。');
    expect(summarizeOutcome('<@U1> 看 <https://x.com/a|这条>：')).toBe('');
    expect(summarizeOutcome(undefined)).toBe('');
  });

  it('ownerQuestionOf finds the last question, drops its lead-in, and is null when nothing is asked', () => {
    expect(ownerQuestionOf('两个办法。要你定的只剩一件：每周一次聊天还是每月一场圆桌，哪个现实？')).toBe('每周一次聊天还是每月一场圆桌，哪个现实？');
    expect(ownerQuestionOf('做完了。报告在 wiki 里。')).toBeNull();
    expect(ownerQuestionOf('直接在这里回要改的地方就行，我改完在这里给你定稿。')).toBeNull();
  });

  it('fitLine cuts at a phrase boundary, not inside a number', () => {
    const long = '英文版好了，照 v10 译的，没加新内容，约 2,600 字符（LinkedIn 上限 3,000），段落更短，结尾加了三个 hashtag';
    const cut = fitLine(long, 40);
    expect(cut).toBe('英文版好了，照 v10 译的，没加新内容');
    expect(fitLine('短句')).toBe('短句');
  });
});

describe('highlights (今天做完的)', () => {
  const done = (over: Partial<Request>): Request =>
    ticket({ status: 'done', completedAt: '2026-09-26T16:00:00.000Z', assignee: 'atlas', ...over });

  it('takes done tickets of the window, in the agent\'s words, at most three, one per team first, work with files first', () => {
    const d = buildReceiptData({
      requests: [
        done({ description: '老板的原话 A', result: 'Think Tank 的第一件做完了，结论写进了 wiki' }),
        done({ description: '老板的原话 B', result: 'Think Tank 的第二件也做完了，报告见 .crewly/research/b.md', completedAt: '2026-09-26T17:00:00.000Z' }),
        done({ assignee: 'ella', result: '周五的小红书定稿了，标题按你说的改好' }),
        done({ assignee: 'nova', result: 'M2 发布了，两台服务器都返回新内容' }),
        done({ result: '昨天做完的不算在今天里面', completedAt: '2026-09-25T16:00:00.000Z' }),
        done({ result: '三天没动静被关掉的不算', tags: ['ticket', 'stale'] }),
        done({ result: '别的团队的回答不算', reply: { at: 'x', by: 'ella', messageId: 'm', excerpt: '别的团队的回答不算' } }),
      ],
      workItems: [],
      window: WINDOW,
      teamOf,
      now: NOW,
    });
    expect(d.highlights.map((h) => [h.team, h.summary])).toEqual([
      ['Think Tank', 'Think Tank 的第二件也做完了，报告'],
      ['Crewly Marketing', '周五的小红书定稿了，标题按你说的改好'],
      ['CE', 'M2 发布了，两台服务器都返回新内容'],
    ]);
    expect(JSON.stringify(d.highlights)).not.toContain('老板的原话');
  });
});

describe('decisions (需要你决定的)', () => {
  const waiting = (over: Partial<Request>): Request =>
    ticket({
      status: 'waiting_confirmation',
      assignee: 'atlas',
      submittedAt: '2026-09-26T20:00:00.000Z',
      reply: { at: '2026-09-26T20:00:00.000Z', by: 'atlas', messageId: 'm', excerpt: '草稿好了。要不要再正式一点？' },
      ...over,
    });

  it('only what is genuinely blocked on him, phrased as the question, oldest first, at most three', () => {
    const d = buildReceiptData({
      requests: [
        waiting({ submittedAt: '2026-09-26T18:00:00.000Z' }),
        waiting({ reply: { at: 'x', by: 'atlas', messageId: 'm', excerpt: '周报写好了，放在 wiki 里。' } }),
        waiting({ submittedAt: '2026-09-22T00:00:00.000Z' }), // older than 3 days: off the list
        waiting({ reply: { at: 'x', by: 'ella', messageId: 'm', excerpt: '别的团队：日历 ID 给我一下？' } }), // misrouted
        waiting({ requiresConfirmation: false }), // a question ticket: nothing to review
        waiting({ submittedAt: '2026-09-26T21:00:00.000Z' }),
        waiting({ submittedAt: '2026-09-26T22:00:00.000Z' }),
      ],
      workItems: [
        item({ status: 'done_by_worker', target: 'nova', title: '发布 M2', metadata: { [REVIEW_ESCALATED_TO_OWNER_KEY]: '2026-09-26T19:00:00.000Z' }, output: { summary: 'M2 可以发了吗？' } }),
      ],
      window: WINDOW,
      teamOf,
      agentNameOf: (s) => ({ atlas: 'Atlas', nova: 'Nova' })[s] ?? null,
      now: NOW,
    });
    expect(d.decisionsTotal).toBe(5);
    expect(d.decisions.map((x) => [x.from, x.question])).toEqual([
      ['Atlas', '要不要再正式一点？'],
      ['Nova', 'M2 可以发了吗？'],
      ['Atlas', '周报写好了，放在 wiki 里，这样可以吗？'],
    ]);
  });

  it('an empty receipt: nothing done, nothing blocked', () => {
    const d = buildReceiptData({ requests: [ticket({ status: 'open' })], workItems: [], window: WINDOW, teamOf, now: NOW });
    expect(isReceiptEmpty(d)).toBe(true);
  });
});
