/**
 * Cost-weighted "budget tokens" (crewly#1090).
 *
 * The fixture is a compact synthetic copy of CE's 2026-10-04 ledger: the same
 * per-agent raw totals, cache-read share and output as the research note
 * (.crewly/research/2026-10-05-ce-token-spend-10-04.md), split over a handful
 * of events per agent instead of 824 real ones.
 */

import { TokenUsageService, budgetWeightsFor, DEFAULT_BUDGET_WEIGHTS, eventTokens } from './token-usage.service.js';

/** One CE agent on 2026-10-04: raw total = fresh + cached + output. */
const CE_DAY = [
  { session: 'ce-vera', fresh: 654, cached: 60_990_688, cacheWrite: 828_374, output: 134_229 }, // 61,125,571
  { session: 'ce-owen', fresh: 792, cached: 38_514_933, cacheWrite: 1_121_626, output: 154_991 }, // 38,670,716
  { session: 'ce-nova', fresh: 241_869, cached: 8_476_032, cacheWrite: 500_000, output: 34_528 }, // 8,752,429
];

/** Splits a total over n parts that sum to it exactly. */
function split(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? total - base * (n - 1) : base));
}

describe('budgetWeightsFor', () => {
  it('uses the Claude weights: reads x0.1, writes x1.25, input and output x1', () => {
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'claude-fable-5-1']) {
      expect(budgetWeightsFor(model)).toEqual({ input: 1, output: 1, cacheWrite: 1.25, cacheRead: 0.1 });
    }
  });

  it('derives the other families from the pricing table ratios', () => {
    expect(budgetWeightsFor('gpt-5.1-codex')).toEqual({ input: 1, output: 1, cacheWrite: 1, cacheRead: 0.1 });
    expect(budgetWeightsFor('deepseek/deepseek-chat')).toMatchObject({ cacheWrite: 1, cacheRead: 0.259 });
    expect(budgetWeightsFor('gemini-2.5-pro').cacheRead).toBeCloseTo(0.248, 3);
  });

  it('falls back to the Claude defaults for an unknown model', () => {
    expect(budgetWeightsFor('mystery-model')).toEqual(DEFAULT_BUDGET_WEIGHTS);
    expect(budgetWeightsFor('')).toEqual(DEFAULT_BUDGET_WEIGHTS);
  });
});

describe('eventTokens().budget', () => {
  it('weights a Claude turn: fresh x1 + output x1 + cache write x1.25 + cache read x0.1', () => {
    const t = eventTokens({ model: 'claude-sonnet-5-5', input: 10, output: 400, cachedInput: 102_000, cacheWrite: 2_000 });
    expect(t.total).toBe(10 + 102_000 + 400); // raw total keeps its definition
    expect(t.budget).toBeCloseTo(10 + 400 + 2_000 * 1.25 + 100_000 * 0.1, 6);
  });

  it('prices cached input at the read weight when the runtime does not split out writes', () => {
    const t = eventTokens({ model: 'gpt-5.1-codex', runtime: 'codex-cli', input: 2_000, output: 200, cachedInput: 10_000 });
    expect(t.budget).toBeCloseTo(2_000 + 200 + 10_000 * 0.1, 6);
  });

  it('takes the cached part out of input for in-process runs (cache is inside input there)', () => {
    const t = eventTokens({ model: 'deepseek/deepseek-chat', input: 1_000, output: 50, cachedInput: 900 });
    expect(t.total).toBe(1_050);
    expect(t.budget).toBeCloseTo(100 + 50 + 900 * 0.259, 6);
  });

  it('never exceeds the raw total times the largest weight, and never goes negative on bad data', () => {
    expect(eventTokens({ model: 'claude-sonnet-5-5', input: -5, output: -1, cachedInput: -9, cacheWrite: 50 }).budget).toBe(0);
    // cacheWrite larger than the cached part is clamped to it
    expect(eventTokens({ model: 'claude-sonnet-5-5', input: 0, output: 0, cachedInput: 100, cacheWrite: 500 }).budget).toBe(125);
  });
});

describe('CE 2026-10-04 fixture (crewly#1090 acceptance)', () => {
  let usage: TokenUsageService;
  const MIDNIGHT = new Date(2026, 9, 4, 0, 0, 0);

  beforeEach(() => {
    usage = new TokenUsageService('/tmp/token-usage-budget-weighting-unused');
    for (const a of CE_DAY) {
      const n = 4;
      const fresh = split(a.fresh, n);
      const cached = split(a.cached, n);
      const writes = split(a.cacheWrite, n);
      const out = split(a.output, n);
      for (let i = 0; i < n; i++) {
        usage.recordUsage(a.session, a.session, fresh[i], out[i], 'claude-sonnet-5-5', undefined, {
          cachedInput: cached[i],
          cacheWrite: writes[i],
          timestamp: new Date(2026, 9, 4, 9 + i, 0, 0).toISOString(),
        });
      }
    }
  });

  const day = (s: string) => usage.getSessionUsageSince(s, MIDNIGHT, new Date(2026, 9, 4, 23, 59, 59));

  it('keeps the raw total at 108,548,716 (its definition is unchanged)', () => {
    const raw = CE_DAY.reduce((n, a) => n + day(a.session).totalTokens, 0);
    expect(raw).toBe(108_548_716);
    expect(day('ce-vera').totalTokens).toBe(61_125_571);
    expect(day('ce-owen').totalTokens).toBe(38_670_716);
    expect(day('ce-nova').totalTokens).toBe(8_752_429);
  });

  it('weights the same day at about 14.2M budget tokens, not 108.5M', () => {
    const budget = CE_DAY.reduce((n, a) => n + day(a.session).budgetTokens, 0);
    expect(budget).toBeGreaterThan(14_100_000);
    expect(budget).toBeLessThan(14_300_000);
    // exact: fresh + output + 0.1 x reads + 1.25 x writes
    const reads = 107_981_653 - 2_450_000;
    expect(Math.abs(budget - Math.round(243_315 + 323_748 + reads * 0.1 + 2_450_000 * 1.25))).toBeLessThanOrEqual(3);
  });

  it('a 50M budget is no longer reached by that day, and 100M was never needed', () => {
    const budget = CE_DAY.reduce((n, a) => n + day(a.session).budgetTokens, 0);
    expect(budget).toBeLessThan(50_000_000);
  });
});
