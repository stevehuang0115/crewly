/**
 * Tests for tier-usage-report — the per-member usage report a lead reads (crewly#1173).
 */

import { describe, it, expect } from '@jest/globals';
import type { Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TokenUsageEvent } from '../monitoring/token-usage.service.js';
import { buildTierReport, renderTierReport, shortTokens } from './tier-usage-report.js';

const NOW = new Date('2026-10-08T12:00:00Z');

const team = {
  id: 't1',
  name: 'Marketing',
  leaderIds: ['m-owen'],
  members: [
    { id: 'm-owen', name: 'Owen', sessionName: 'mkt-owen', role: 'team-leader', runtimeType: 'claude-code', canDelegate: true },
    { id: 'm-ella', name: 'Ella', sessionName: 'mkt-ella', role: 'developer', runtimeType: 'claude-code', parentMemberId: 'm-owen', tier: 'weak' },
    { id: 'orc', name: 'Orc', sessionName: 'crewly-orc', role: 'orchestrator' },
  ],
  projectIds: [],
  createdAt: '',
  updatedAt: '',
} as unknown as Team;

const ev = (model: string, input: number, cached: number, output: number, at = '2026-10-07T00:00:00Z'): TokenUsageEvent => ({
  timestamp: at,
  agentId: 'x',
  model,
  input,
  cachedInput: cached,
  output,
});

const events: Array<[string, TokenUsageEvent]> = [
  ['mkt-owen', ev('claude-opus-5', 1_000, 299_000, 2_000)],
  ['mkt-owen', ev('claude-opus-5', 1_000, 99_000, 1_000)],
  ['mkt-ella', ev('claude-haiku-4-5', 500, 9_500, 300)],
  ['mkt-ella', ev('claude-haiku-4-5', 500, 9_500, 300, '2026-09-01T00:00:00Z')], // outside the window
  ['someone-else', ev('claude-opus-5', 1_000, 1_000, 1_000)],
];

const forEachEvent = (visit: (s: string, e: TokenUsageEvent) => void, since?: Date): void => {
  for (const [s, e] of events) if (!since || Date.parse(e.timestamp) >= since.getTime()) visit(s, e);
};

const items = [
  { id: 'w1', target: 'mkt-ella', title: 'Poll the inbox', type: 'cron_run', status: 'done', createdAt: '2026-10-06T00:00:00Z', statusChangedAt: '2026-10-06T00:00:00Z', completedAt: '2026-10-06T00:00:00Z', retryCount: 0 },
  { id: 'w2', target: 'mkt-ella', title: 'Sort tickets', type: 'delegate', status: 'rejected', createdAt: '2026-10-07T00:00:00Z', statusChangedAt: '2026-10-07T00:00:00Z', completedAt: '2026-10-07T00:00:00Z', retryCount: 0 },
  { id: 'old', target: 'mkt-ella', title: 'Old', type: 'delegate', status: 'done', createdAt: '2026-08-01T00:00:00Z', statusChangedAt: '2026-08-01T00:00:00Z', retryCount: 0 },
] as unknown as WorkItem[];

describe('buildTierReport', () => {
  const r = buildTierReport({ team, forEachEvent, workItems: items, now: NOW });

  it('has one row per member, without the orchestrator', () => {
    expect(r.rows.map((x) => x.name)).toEqual(['Owen', 'Ella']);
  });

  it('sums turns, average context, output and cost by model in the window', () => {
    const owen = r.rows[0];
    expect(owen.isLead).toBe(true);
    expect(owen.turns).toBe(2);
    expect(owen.avgContext).toBe(200_000);
    expect(owen.outputTokens).toBe(3_000);
    expect(owen.costUsd).toBeGreaterThan(0);
    expect(Object.keys(owen.costByModel)).toEqual(['claude-opus-5']);
    expect(owen.model).toBe('runtime default');
    const ella = r.rows[1];
    expect(ella.turns).toBe(1);
    expect(ella.tier).toBe('weak');
    expect(ella.model).toBe('haiku');
    expect(r.totalCostUsd).toBeCloseTo(owen.costUsd + ella.costUsd, 2);
  });

  it('lists the work handled and its send-back rate', () => {
    const ella = r.rows[1];
    expect(ella.work.count).toBe(2);
    expect(ella.work.titles).toEqual(['Sort tickets', 'Poll the inbox']);
    expect(ella.work.kinds).toEqual({ delegate: 1, cron_run: 1 });
    expect(ella.quality).toEqual({ settled: 2, sentBack: 1, rate: 0.5 });
  });

  it('renders a compact table with the tier maps', () => {
    const text = renderTierReport(r);
    expect(text).toContain('Usage of team Marketing, last 7 days');
    expect(text).toContain('claude-code: strong=opus, mid=sonnet, weak=haiku');
    expect(text).toContain('| Owen (lead) | – → runtime default | 2 | 200k |');
    expect(text).toContain('| Ella | weak → haiku | 1 | 10k |');
    expect(text).toContain('"Sort tickets"');
  });
});

describe('shortTokens', () => {
  it('shortens', () => {
    expect(shortTokens(480_000)).toBe('480k');
    expect(shortTokens(1_200_000)).toBe('1.2M');
    expect(shortTokens(12)).toBe('12');
  });
});
