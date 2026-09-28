/**
 * Tests for the owner receipt renderer (#828). The format is Ava's posted
 * receipt of 2026-09-26; all wording lives in the renderer.
 */

import { OWNER_RECEIPT_CONSTANTS } from '../../../constants.js';
import { escapeMrkdwn, renderReceiptSlack } from './owner-receipt.renderer.js';
import type { ReceiptAsk, ReceiptData, ReceiptTeam } from './owner-receipt.types.js';

/**
 * An ask.
 *
 * @param over - Fields to change
 * @returns ReceiptAsk
 */
function ask(over: Partial<ReceiptAsk> = {}): ReceiptAsk {
  return {
    ticketId: 't',
    tkt: 'TKT-001',
    text: '研究 Orca',
    outcome: 'done',
    kind: 'feature',
    isQuestion: false,
    parentTicketId: null,
    assignee: 'atlas',
    deliverables: [],
    blockedReason: null,
    createdAt: '2026-09-26T15:00:00Z',
    ...over,
  };
}

/**
 * Receipt data.
 *
 * @param over - Fields to change
 * @returns ReceiptData
 */
function data(over: Partial<ReceiptData> = {}): ReceiptData {
  const teams: ReceiptTeam[] = over.teams ?? [
    {
      team: 'Think Tank',
      lead: 'Atlas',
      cost: { status: 'not_tracked', reason: 'cumulative_meter' },
      asks: [
        ask({ deliverables: [{ kind: 'file', ref: '.crewly/specs/2026-09-26-orca-delta.md', label: '2026-09-26-orca-delta.md' }] }),
        ask({ text: 'Turing 的另一个测试是什么', isQuestion: true, kind: 'question' }),
        ask({ text: 'Opus 做视频 → Flopost', outcome: 'in_progress' }),
      ],
    },
    {
      team: 'Crewly Product',
      lead: null,
      cost: { status: 'not_tracked', reason: 'cumulative_meter' },
      asks: [
        ask({ text: '开 issue 给 Sam', deliverables: [{ kind: 'issue', ref: 'https://github.com/o/r/issues/828', label: '#828' }] }),
        ask({ text: '个人助理：X 动向按主题分组', outcome: 'unowned', assignee: null }),
      ],
    },
  ];
  const askCount = teams.reduce((n, t) => n + t.asks.length, 0);
  return {
    window: { from: '2026-09-26T04:00:00.000Z', to: '2026-09-27T01:00:00.000Z', basis: 'local_day', timezone: 'America/New_York' },
    teams,
    outcomes: { done: 3, to_review: 0, in_progress: 1, blocked: 0, unowned: 1, dismissed: 0 },
    deliverables: { pr: 0, issue: 1, file: 1, link: 0 },
    waiting: [
      { source: 'ticket_review', id: 'w1', tkt: 'TKT-036', text: 'Orca 博客', question: '只写 Orca，行吗？', team: 'Crewly Marketing', since: '2026-09-26T15:03:00Z' },
    ],
    askCount,
    coverage: { status: 'known', messages: 12, created: 5, appended: 4, ignored: 3 },
    possiblyMissed: [],
    generatedAt: '2026-09-27T01:00:00.000Z',
    ...over,
  };
}

describe('renderReceiptSlack — the posted format', () => {
  it('renders header, counts, deliverables, teams, waiting and cost in that order', () => {
    const text = renderReceiptSlack(data());
    expect(text.split('\n')).toEqual([
      '*Crewly 小票 · 9/26 周六*（美东 0:00–21:00）',
      '今天你发了 *12 条消息*：5 条成了事项 · 4 条并进已有事项 · 3 条没记（确认/寒暄）',
      '你提了 *5 件事*：✅ 3 · 🔄 1 · ⛔ 1',
      '交付：issue 1 · 文件 1',
      '',
      '*Think Tank（Atlas）*',
      '✅ 研究 Orca → `.crewly/specs/2026-09-26-orca-delta.md`',
      '✅ Turing 的另一个测试是什么 → 已答',
      '🔄 Opus 做视频 → Flopost → 在做',
      '',
      '*Crewly Product*',
      '✅ 开 issue 给 Sam → <https://github.com/o/r/issues/828|#828>',
      '⛔ 个人助理：X 动向按主题分组 → 没人接',
      '',
      '*等你拍板（1）*',
      '1. TKT-036 Orca 博客 — 只写 Orca，行吗？',
      '',
      '*花费*：各团队都 没记（成本字段是会话累计值，不是当天花费，#812）',
    ]);
  });

  it('names the window as "since the last receipt" when it is', () => {
    const text = renderReceiptSlack(data({ window: { from: '2026-09-26T01:00:00.000Z', to: '2026-09-27T01:00:00.000Z', basis: 'since_last_receipt', timezone: 'America/New_York' } }));
    expect(text.split('\n')[0]).toBe('*Crewly 小票 · 9/26 周六*（美东，上次小票 9/25 周五 21:00 起）');
  });

  it('says so when nothing was asked', () => {
    const text = renderReceiptSlack(data({ teams: [], askCount: 0, waiting: [], outcomes: { done: 0, to_review: 0, in_progress: 0, blocked: 0, unowned: 0, dismissed: 0 }, deliverables: { pr: 0, issue: 0, file: 0, link: 0 } }));
    expect(text).toContain('这段时间你没有提新的事。');
    expect(text).toContain('*花费*：没记（今天没有工作项）');
    expect(text).not.toContain('等你拍板');
  });
});

describe('renderReceiptSlack — cost is never a fake number', () => {
  it('a cumulative meter renders 没记, not its value', () => {
    const text = renderReceiptSlack(data());
    expect(text).toContain('没记');
    expect(text).not.toMatch(/\$\d/);
  });

  it('no data at all renders 没记 too, never $0', () => {
    const d = data();
    d.teams = d.teams.map((t) => ({ ...t, cost: { status: 'not_tracked', reason: 'no_data' } }));
    const text = renderReceiptSlack(d);
    expect(text).toContain('*花费*：各团队都 没记（没有花费数据）');
    expect(text).not.toContain('$0');
  });

  it('a real figure is shown per team, next to 没记 for the rest', () => {
    const d = data();
    d.teams[0].cost = { status: 'tracked', usd: 3.5 };
    expect(renderReceiptSlack(d)).toContain('*花费*：Think Tank $3.50 · Crewly Product 没记');
  });
});

describe('renderReceiptSlack — safety and length', () => {
  it('escapes the owner\'s words but keeps links clickable', () => {
    const d = data();
    d.teams[0].asks = [ask({ text: 'a <b> & c', deliverables: [{ kind: 'pr', ref: 'https://github.com/o/r/pull/1', label: '#1' }] })];
    const line = renderReceiptSlack(d).split('\n').find((l) => l.includes('a &lt;b&gt;'));
    expect(line).toBe('✅ a &lt;b&gt; &amp; c → <https://github.com/o/r/pull/1|#1>');
  });

  it('caps the ask lines for a phone and says how many more', () => {
    const many = Array.from({ length: OWNER_RECEIPT_CONSTANTS.MAX_ASK_LINES + 7 }, (_, i) => ask({ ticketId: `t${i}`, text: `ask ${i}` }));
    const d = data({ teams: [{ team: 'A', lead: null, asks: many, cost: { status: 'not_tracked', reason: 'no_data' } }], askCount: many.length });
    const text = renderReceiptSlack(d);
    expect(text.split('\n').filter((l) => l.startsWith('✅ ask '))).toHaveLength(OWNER_RECEIPT_CONSTANTS.MAX_ASK_LINES);
    expect(text).toContain('…另有 7 件，见看板');
  });

  it('shows at most three deliverables per line', () => {
    const d = data();
    d.teams[0].asks = [ask({ deliverables: [1, 2, 3, 4, 5].map((n) => ({ kind: 'pr' as const, ref: `https://github.com/o/r/pull/${n}`, label: `#${n}` })) })];
    expect(renderReceiptSlack(d)).toContain('#3> 等 5 项');
  });

  it('escapeMrkdwn escapes & < >', () => {
    expect(escapeMrkdwn('<a&b>')).toBe('&lt;a&amp;b&gt;');
  });
});

describe('renderReceiptSlack — coverage (#828: the receipt says what it covers)', () => {
  it('always has the coverage line, right under the header', () => {
    const lines = renderReceiptSlack(data()).split('\n');
    expect(lines[1]).toBe('今天你发了 *12 条消息*：5 条成了事项 · 4 条并进已有事项 · 3 条没记（确认/寒暄）');
  });

  it('prints real zeros as zeros when the window was counted', () => {
    const text = renderReceiptSlack(data({ coverage: { status: 'known', messages: 2, created: 0, appended: 0, ignored: 2 } }));
    expect(text).toContain('你发了 *2 条消息*：0 条成了事项 · 0 条并进已有事项 · 2 条没记');
  });

  it('an uncounted window reads 不详 — never 0, never left out', () => {
    for (const reason of ['not_recorded', 'window_before_log'] as const) {
      const text = renderReceiptSlack(data({ coverage: { status: 'unknown', reason } }));
      expect(text.split('\n')[1]).toBe('今天你发了几条消息：不详（这段时间还没有开始记录）');
      expect(text).not.toMatch(/发了 \*0 条/);
    }
  });

  it('says 这段时间 for a since-last-receipt window', () => {
    const d = data({ window: { from: '2026-09-26T01:00:00.000Z', to: '2026-09-27T01:00:00.000Z', basis: 'since_last_receipt', timezone: 'America/New_York' } });
    expect(renderReceiptSlack(d).split('\n')[1]).toMatch(/^这段时间你发了/);
  });

  it('lists 可能漏记 with the ticket each went into, at most 5, then says how many more', () => {
    const missed = Array.from({ length: 7 }, (_, i) => ({
      text: `可以帮我看看第 ${i} 个`,
      ticketId: `t${i}`,
      tkt: `TKT-00${i}`,
      ref: `r${i}`,
      splitCommand: `split-ticket --ticket TKT-00${i} --discussion-ref r${i}`,
      at: '2026-09-26T15:00:00Z',
    }));
    const lines = renderReceiptSlack(data({ possiblyMissed: missed })).split('\n');
    const head = lines.indexOf('*可能漏记（7）* — 回复「拆出来」就单独记一件');
    expect(head).toBeGreaterThan(0);
    expect(lines.slice(head + 1, head + 6)).toEqual(missed.slice(0, 5).map((m) => `• ${m.text} → 并进了 ${m.tkt}`));
    expect(lines[head + 6]).toBe('…另有 2 条，见看板');
  });

  it('has no 可能漏记 section when nothing is suspect', () => {
    expect(renderReceiptSlack(data())).not.toContain('可能漏记');
  });
});

