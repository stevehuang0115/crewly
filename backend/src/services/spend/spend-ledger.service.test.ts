import { TokenUsageService } from '../monitoring/token-usage.service.js';
import { SpendLedger, percentile, runtimeOfEvent, runtimeOfModel } from './spend-ledger.service.js';

/** Local time on 2026-10-0d at hh:mm. */
function at(day: number, hh: number, mm = 0): Date {
  return new Date(2026, 9, day, hh, mm, 0, 0);
}

describe('SpendLedger (tokens)', () => {
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

  /** A Codex rollout call: fresh input with cached on top, runtime recorded. */
  function codexCall(session: string, when: Date, fresh = 2_337, cached = 11_648, output = 209): void {
    usage.recordUsage(session, session, fresh, output, 'gpt-6-sol', undefined, { cachedInput: cached, timestamp: when.toISOString(), runtime: 'codex-cli' });
  }

  const ORC_RUN = 70_000 + 500; // cached is inside input
  const ELLA_TURN = 10 + 102_000 + 400; // cached on top
  const NOVA_CALL = 2_337 + 11_648 + 209;

  it('aggregates every source in one unit per agent, runtime and local day', () => {
    deepseekRun('crewly-orc', at(2, 9));
    deepseekRun('crewly-orc', at(1, 23, 59));
    claudeTurn('ella', at(2, 10));
    claudeTurn('ella', at(2, 0, 1));
    codexCall('nova', at(2, 11));

    const s = ledger.summarize(7);
    expect(s.today).toBe('2026-10-02');
    expect(s.days.map((d) => d.date)).toEqual(['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    const today = s.days[6];
    expect(today.byAgent['crewly-orc']).toBe(ORC_RUN);
    expect(s.days[5].byAgent['crewly-orc']).toBe(ORC_RUN);
    expect(today.byAgent.ella).toBe(2 * ELLA_TURN);
    expect(today.byRuntime).toEqual({ 'crewly-agent': ORC_RUN, 'claude-code': 2 * ELLA_TURN, 'codex-cli': NOVA_CALL });
    expect(s.todayTokens).toBe(ORC_RUN + 2 * ELLA_TURN + NOVA_CALL);
    expect(s.totalTokens).toBe(2 * ORC_RUN + 2 * ELLA_TURN + NOVA_CALL);
    expect(s.cachedTokens).toBe(2 * 60_000 + 2 * 102_000 + 11_648);
    const ella = s.agents.find((a) => a.session === 'ella')!;
    expect(ella.runtimes).toEqual(['claude-code']);
    expect(ella.todayTokens).toBe(2 * ELLA_TURN);
    expect(s.agents[0].session).toBe('ella'); // most tokens first
  });

  it('usedToday matches getSessionUsageSince(...).totalTokens from local midnight (the autopilot computation)', () => {
    deepseekRun('crewly-orc', at(1, 23, 0));
    deepseekRun('crewly-orc', at(2, 1, 0));
    claudeTurn('crewly-orc', at(2, 2, 0));
    const expected = usage.getSessionUsageSince('crewly-orc', at(2, 0)).totalTokens;
    expect(expected).toBe(ORC_RUN + ELLA_TURN);
    expect(ledger.usedToday('crewly-orc')).toBe(expected);
    expect(ledger.totalToday()).toBe(expected);
    claudeTurn('ella', at(2, 3, 0));
    expect(ledger.groupToday(['crewly-orc', 'ella', 'ella'])).toBe(expected + ELLA_TURN);
  });

  it('caches the all-agents total briefly and recomputes after invalidate()', () => {
    deepseekRun('a', at(2, 9));
    const first = ledger.totalToday();
    deepseekRun('b', at(2, 10));
    expect(ledger.totalToday()).toBe(first);
    ledger.invalidate();
    expect(ledger.totalToday()).toBe(first * 2);
  });

  it('computes the p90 of agent-days with usage', () => {
    for (let d = 26; d <= 30; d++) deepseekRun('x', new Date(2026, 8, d, 12));
    expect(ledger.summarize(7).p90AgentDayTokens).toBe(ORC_RUN);
  });

  it('clamps the window', () => {
    expect(ledger.summarize(0).days).toHaveLength(1);
    expect(ledger.summarize(1000).days).toHaveLength(31);
  });
});

describe('runtimeOfEvent', () => {
  it('prefers the recorded runtime', () => {
    expect(runtimeOfEvent({ model: 'gpt-6-sol', runtime: 'codex-cli' })).toBe('codex-cli');
    expect(runtimeOfEvent({ model: 'antigravity-cli-default' })).toBe('antigravity-cli');
    expect(runtimeOfEvent({ model: 'claude-opus-5-5' })).toBe('claude-code');
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

describe('percentile', () => {
  it('nearest-rank percentile', () => {
    expect(percentile([], 90)).toBe(0);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([5], 90)).toBe(5);
  });
});
