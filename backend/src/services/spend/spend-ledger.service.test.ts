import { TokenUsageService, calculateCost } from '../monitoring/token-usage.service.js';
import { calculateCost as cacheAwareCost } from '../monitoring/model-pricing.js';
import { SpendLedger, percentile, runtimeOfModel, cents } from './spend-ledger.service.js';

/** Local time on 2026-10-0d at hh:mm. */
function at(day: number, hh: number, mm = 0): Date {
  return new Date(2026, 9, day, hh, mm, 0, 0);
}

describe('SpendLedger', () => {
  let usage: TokenUsageService;
  let now: Date;
  let ledger: SpendLedger;

  beforeEach(() => {
    usage = new TokenUsageService('/tmp/spend-ledger-test-unused');
    now = at(2, 15);
    ledger = new SpendLedger(usage, () => now);
  });

  /** A DeepSeek in-process run: cachedInput is part of input. */
  function deepseekRun(session: string, when: Date, input = 70_000, cached = 60_000, output = 500): void {
    usage.recordUsage(session, session, input, output, 'deepseek/deepseek-chat', undefined, { cachedInput: cached, timestamp: when.toISOString() });
  }

  /** A Claude Code transcript turn: input is fresh only; cachedInput = read + write on top. */
  function claudeTurn(session: string, when: Date, fresh = 10, read = 100_000, write = 2_000, output = 400): void {
    usage.recordUsage(session, session, fresh, output, 'claude-opus-5-5', undefined, { cachedInput: read + write, cacheWrite: write, timestamp: when.toISOString() });
  }

  it('aggregates both ledgers (DeepSeek runs and Claude transcript turns) per agent, runtime and local day', () => {
    deepseekRun('crewly-orc', at(2, 9));
    deepseekRun('crewly-orc', at(1, 23, 59));
    claudeTurn('ella', at(2, 10));
    claudeTurn('ella', at(2, 0, 1));

    const s = ledger.summarize(7);
    const orcRun = calculateCost(70_000, 500, 'deepseek/deepseek-chat', 60_000);
    const ellaTurn = cacheAwareCost({ input: 10, output: 400, cacheRead: 100_000, cacheWrite: 2_000 }, 'claude-opus-5-5').cost;

    expect(s.today).toBe('2026-10-02');
    expect(s.days.map((d) => d.date)).toEqual(['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    const today = s.days[6];
    const yesterday = s.days[5];
    expect(today.byAgent['crewly-orc']).toBeCloseTo(orcRun, 10);
    expect(yesterday.byAgent['crewly-orc']).toBeCloseTo(orcRun, 10);
    expect(today.byAgent.ella).toBeCloseTo(2 * ellaTurn, 10);
    expect(today.byRuntime['crewly-agent']).toBeCloseTo(orcRun, 10);
    expect(today.byRuntime['claude-code']).toBeCloseTo(2 * ellaTurn, 10);
    expect(s.todayUsd).toBeCloseTo(orcRun + 2 * ellaTurn, 10);
    expect(s.totalUsd).toBeCloseTo(2 * orcRun + 2 * ellaTurn, 10);

    const ella = s.agents.find((a) => a.session === 'ella')!;
    expect(ella.runtimes).toEqual(['claude-code']);
    expect(ella.todayUsd).toBeCloseTo(2 * ellaTurn, 10);
    expect(s.agents[0].session).toBe('ella'); // highest spend first
  });

  it('prices Claude cache reads and writes (they dominate a long-lived agent) and DeepSeek cache hits at the hit rate', () => {
    claudeTurn('ella', at(2, 10), 10, 600_000, 0, 100);
    deepseekRun('crewly-orc', at(2, 10), 70_000, 70_000, 0);
    const s = ledger.summarize(1);
    // 600k cache reads at the opus read rate ($1.50/M) ≈ $0.90; fresh-only pricing would say ~$0.008.
    expect(s.days[0].byAgent.ella).toBeGreaterThan(0.85);
    expect(s.days[0].byAgent['crewly-orc']).toBeCloseTo(70_000 * 0.000000006, 10);
  });

  it('spentToday matches getSessionUsageSince from local midnight (the ticket autopilot computation)', () => {
    deepseekRun('crewly-orc', at(1, 23, 0));
    deepseekRun('crewly-orc', at(2, 1, 0));
    claudeTurn('crewly-orc', at(2, 2, 0));
    const expected = usage.getSessionUsageSince('crewly-orc', at(2, 0)).cost;
    expect(ledger.spentToday('crewly-orc')).toBeCloseTo(expected, 12);
    expect(ledger.totalToday()).toBeCloseTo(expected, 12);
  });

  it('caches the all-agents total briefly and recomputes after invalidate()', () => {
    deepseekRun('a', at(2, 9));
    const first = ledger.totalToday();
    deepseekRun('b', at(2, 10));
    expect(ledger.totalToday()).toBe(first);
    ledger.invalidate();
    expect(ledger.totalToday()).toBeCloseTo(first * 2, 12);
  });

  it('computes the p90 of agent-days with spend', () => {
    for (let d = 26; d <= 30; d++) deepseekRun('x', new Date(2026, 8, d, 12));
    expect(ledger.summarize(7).p90AgentDayUsd).toBeGreaterThan(0);
  });

  it('clamps the window', () => {
    expect(ledger.summarize(0).days).toHaveLength(1);
    expect(ledger.summarize(1000).days).toHaveLength(31);
  });
});

describe('runtimeOfModel', () => {
  it.each([
    ['deepseek/deepseek-chat', 'crewly-agent'],
    ['google/gemini-3-flash-preview', 'crewly-agent'],
    ['claude-opus-5-5', 'claude-code'],
    ['claude-fable-5-1', 'claude-code'],
    ['<synthetic>', 'claude-code'],
    ['codex-cli-default', 'codex-cli'],
    ['gpt-5', 'codex-cli'],
    ['gemini-2.0-flash', 'gemini-cli'],
    ['mystery', 'other'],
  ])('%s → %s', (model, runtime) => {
    expect(runtimeOfModel(model)).toBe(runtime);
  });
});

describe('percentile / cents', () => {
  it('nearest-rank percentile', () => {
    expect(percentile([], 90)).toBe(0);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([5], 90)).toBe(5);
  });
  it('rounds to cents', () => {
    expect(cents(1.005)).toBeCloseTo(1.0, 2);
    expect(cents(2.349)).toBe(2.35);
  });
});
