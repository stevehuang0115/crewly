/**
 * Tests for the owner receipt renderer (#828, redesigned 2026-09-28): two
 * short sections in English (the bullets carry the agents' own words), at most ten lines, no ticket numbers, no raw
 * owner text, nothing for what is unknown, nothing at all when empty.
 */

import { OWNER_RECEIPT_CONSTANTS } from '../../../constants.js';
import { escapeMrkdwn, renderReceiptSlack } from './owner-receipt.renderer.js';
import type { ReceiptData, ReceiptDecision, ReceiptHighlight } from './owner-receipt.types.js';

/**
 * A highlight.
 *
 * @param n - Index
 * @param over - Fields to change
 * @returns ReceiptHighlight
 */
function highlight(n: number, over: Partial<ReceiptHighlight> = {}): ReceiptHighlight {
  return { ticketId: `h${n}`, team: 'Think Tank', summary: `第 ${n} 件做完了`, deliverableCount: 0, completedAt: '2026-09-26T15:00:00Z', ...over };
}

/**
 * A decision.
 *
 * @param n - Index
 * @param over - Fields to change
 * @returns ReceiptDecision
 */
function decision(n: number, over: Partial<ReceiptDecision> = {}): ReceiptDecision {
  return { id: `d${n}`, source: 'ticket_review', from: 'Atlas', question: `第 ${n} 个问题要你定吗？`, since: '2026-09-26T15:00:00Z', ...over };
}

/**
 * Receipt data with the legacy (API-only) fields filled with noise the
 * Slack text must never show.
 *
 * @param over - Fields to change
 * @returns ReceiptData
 */
function data(over: Partial<ReceiptData> = {}): ReceiptData {
  return {
    window: { from: '2026-09-26T04:00:00.000Z', to: '2026-09-27T01:00:00.000Z', basis: 'since_last_receipt', timezone: 'America/New_York' },
    teams: [
      {
        team: 'Think Tank',
        lead: 'Atlas',
        cost: { status: 'not_tracked', reason: 'cumulative_meter' },
        asks: [
          {
            ticketId: 't',
            tkt: 'TKT-001',
            text: '研究 Orca（老板的原话）',
            outcome: 'done',
            kind: 'feature',
            isQuestion: false,
            parentTicketId: null,
            assignee: 'atlas',
            deliverables: [],
            blockedReason: null,
            createdAt: '2026-09-26T15:00:00Z',
          },
        ],
      },
    ],
    outcomes: { done: 1, to_review: 0, in_progress: 0, blocked: 0, unowned: 0, dismissed: 0 },
    deliverables: { pr: 0, issue: 0, file: 0, link: 0 },
    waiting: [{ source: 'ticket_review', id: 'w1', tkt: 'TKT-036', text: 'Orca 博客', question: null, team: 'Crewly Marketing', since: null }],
    askCount: 1,
    coverage: { status: 'unknown', reason: 'not_recorded' },
    possiblyMissed: [],
    highlights: [highlight(1, { team: 'Think Tank' }), highlight(2, { team: 'Crewly Marketing' })],
    decisions: [decision(1)],
    decisionsTotal: 1,
    generatedAt: '2026-09-27T01:00:00.000Z',
    ...over,
  };
}

describe('renderReceiptSlack — the redesigned receipt', () => {
  it('renders the date, Done today and Needs your decision, one line each', () => {
    expect(renderReceiptSlack(data())).toBe(
      [
        '*Crewly receipt · Sat 9/26*',
        '*Done today*',
        '• Think Tank: 第 1 件做完了',
        '• Crewly Marketing: 第 2 件做完了',
        '*Needs your decision*',
        '• Atlas: 第 1 个问题要你定吗？',
      ].join('\n'),
    );
  });

  it('never shows ticket numbers, the owner\'s words, counts, coverage (不详) or cost (没记)', () => {
    const text = renderReceiptSlack(data());
    for (const banned of ['TKT-', '老板的原话', '不详', '没记', '花费', '你发了', '你提了', '等你拍板']) expect(text).not.toContain(banned);
  });

  it('leaves out an empty section', () => {
    expect(renderReceiptSlack(data({ decisions: [], decisionsTotal: 0 }))).not.toContain('Needs your decision');
    expect(renderReceiptSlack(data({ highlights: [] }))).not.toContain('Done today');
  });

  it('is empty when nothing was done and nothing waits on the owner (the receipt is skipped)', () => {
    expect(renderReceiptSlack(data({ highlights: [], decisions: [], decisionsTotal: 0 }))).toBe('');
  });

  it('stays within ten lines at the limits, and says how many more decisions are on the board', () => {
    const text = renderReceiptSlack(
      data({
        highlights: [1, 2, 3].map((n) => highlight(n)),
        decisions: [1, 2, 3].map((n) => decision(n)),
        decisionsTotal: 17,
      }),
    );
    expect(text.split('\n')).toHaveLength(10);
    expect(text.split('\n').at(-1)).toBe('14 more on the board');
    expect(OWNER_RECEIPT_CONSTANTS.MAX_HIGHLIGHTS + OWNER_RECEIPT_CONSTANTS.MAX_DECISIONS + 4).toBeLessThanOrEqual(10);
  });

  it('leaves the name off a line when nobody is known', () => {
    const text = renderReceiptSlack(data({ highlights: [highlight(1, { team: null })], decisions: [decision(1, { from: null })] }));
    expect(text).toContain('• 第 1 件做完了');
    expect(text).toContain('• 第 1 个问题要你定吗？');
  });

  it('escapes what Slack reserves', () => {
    const text = renderReceiptSlack(data({ highlights: [highlight(1, { summary: 'a < b & c', team: 'R&D' })] }));
    expect(text).toContain('• R&amp;D: a &lt; b &amp; c');
    expect(escapeMrkdwn('<&>')).toBe('&lt;&amp;&gt;');
  });
});
