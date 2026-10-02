/**
 * Tests for the token usage stats: aggregation by agent / team / project /
 * work item / runtime / day, in the one token unit.
 */
import { TokenUsageService, eventCostUsd } from '../monitoring/token-usage.service.js';
import { modelFamily, modelKeyOf, parseGroupBy, UsageStatsService, type UsageTeam, type UsageWorkItem } from './usage-stats.service.js';

const at = (day: number, hh: number, mm = 0) => new Date(2026, 9, day, hh, mm);

describe('UsageStatsService', () => {
  let ledger: TokenUsageService;
  let teams: UsageTeam[];
  let items: UsageWorkItem[];
  const now = at(2, 18);

  const svc = () =>
    new UsageStatsService({
      ledger,
      teams: async () => teams,
      projects: async () => [
        { id: 'p-ce', name: 'CE core' },
        { id: 'p-web', name: 'Web' },
        { id: 'p-mk', name: 'Marketing site' },
      ],
      workItems: async () => items,
      now: () => now,
    });

  /** Claude turn: fresh input + cached on top. */
  const claude = (s: string, when: Date, fresh: number, cached: number, out: number) =>
    ledger.recordUsage(s, s, fresh, out, 'claude-opus-5-5', undefined, { cachedInput: cached, timestamp: when.toISOString() });
  /** Codex call. */
  const codex = (s: string, when: Date, fresh: number, cached: number, out: number) =>
    ledger.recordUsage(s, s, fresh, out, 'gpt-6-sol', undefined, { cachedInput: cached, timestamp: when.toISOString(), runtime: 'codex-cli' });
  /** In-process run: cached inside input. */
  const deepseek = (s: string, when: Date, input: number, cached: number, out: number) =>
    ledger.recordUsage(s, s, input, out, 'deepseek/deepseek-chat', undefined, { cachedInput: cached, timestamp: when.toISOString() });

  beforeEach(() => {
    ledger = new TokenUsageService('/tmp/usage-stats-test-unused');
    teams = [
      { id: 't-ce', name: 'CE', projectIds: ['p-ce'], members: [{ session: 'owen', name: 'Owen' }, { session: 'nova', name: 'Nova' }] },
      { id: 't-mk', name: 'Marketing', projectIds: ['p-web', 'p-mk'], members: [{ session: 'ella', name: 'Ella' }] },
    ];
    items = [];
    claude('owen', at(2, 9), 100, 9_900, 500); // 10,500
    codex('nova', at(2, 10), 2_000, 8_000, 1_000); // 11,000
    claude('ella', at(1, 12), 0, 4_000, 1_000); // 5,000 (yesterday)
    claude('ella', at(2, 11), 0, 1_000, 0); // 1,000
    deepseek('crewly-orc', at(2, 12), 3_000, 2_000, 500); // 3,500
    claude('owen', new Date(2026, 8, 20, 9), 1, 1, 1); // outside any 7-day window (September 20)
  });

  it('groups by agent / team / runtime / day; every grouping sums to the total', async () => {
    const r = await svc().query(7, ['agent', 'team', 'runtime', 'day']);
    expect(r.totals).toEqual({
      input: 10_000 + 10_000 + 4_000 + 1_000 + 3_000,
      cachedInput: 9_900 + 8_000 + 4_000 + 1_000 + 2_000,
      output: 3_000,
      total: 31_000,
      events: 5,
      costUsd: expect.any(Number),
    });
    expect(r.todayTotals.total).toBe(26_000);
    expect(r.rows).toBe(r.groups.agent);

    expect(r.groups.agent?.map((x) => [x.key, x.label, x.total])).toEqual([
      ['nova', 'Nova', 11_000],
      ['owen', 'Owen', 10_500],
      ['ella', 'Ella', 6_000],
      ['crewly-orc', 'Orc', 3_500],
    ]);
    expect(r.groups.agent?.[0].meta).toEqual({ team: 'CE', runtimes: ['codex-cli'] });

    expect(r.groups.team?.map((x) => [x.key, x.label, x.total])).toEqual([
      ['t-ce', 'CE', 21_500],
      ['t-mk', 'Marketing', 6_000],
      ['(unattributed)', 'Orc (no team)', 3_500],
    ]);
    expect(r.groups.runtime?.map((x) => [x.key, x.total])).toEqual([
      ['claude-code', 16_500],
      ['codex-cli', 11_000],
      ['crewly-agent', 3_500],
    ]);
    expect(r.groups.day?.map((x) => x.key)).toEqual(['2026-10-01', '2026-10-02']);
    for (const g of Object.values(r.groups)) expect(g!.reduce((n, x) => n + x.total, 0)).toBe(r.totals.total);
    expect(r.groups.team?.[0].share).toBeCloseTo(21_500 / 31_000, 10);
  });

  it('adds the estimated API cost (eventCostUsd) to every row and the totals', async () => {
    const r = await svc().query(7, ['agent', 'team']);
    const owen = eventCostUsd({ input: 100, output: 500, cachedInput: 9_900, model: 'claude-opus-5-5' });
    expect(r.groups.agent?.find((x) => x.key === 'owen')?.costUsd).toBeCloseTo(owen, 12);
    const sumAgents = r.groups.agent!.reduce((n, x) => n + x.costUsd, 0);
    expect(r.totals.costUsd).toBeCloseTo(sumAgents, 12);
    expect(r.groups.team!.reduce((n, x) => n + x.costUsd, 0)).toBeCloseTo(r.totals.costUsd, 12);
    expect(r.totals.costUsd).toBeGreaterThan(0);
  });

  it('groups by model, with family / runtime / rate source, and an "Unknown model" row for placeholders', async () => {
    ledger.recordUsage('nova', 'nova', 10, 5, 'codex-cli-default', undefined, { timestamp: at(2, 13).toISOString(), runtime: 'codex-cli' });
    ledger.recordUsage('nova', 'nova', 10, 5, '', undefined, { timestamp: at(2, 14).toISOString(), runtime: 'codex-cli' });
    const r = await svc().query(7, ['model']);
    const byKey = new Map(r.groups.model!.map((x) => [x.key, x]));
    expect(byKey.get('claude-opus-5-5')).toMatchObject({ label: 'claude-opus-5-5', total: 16_500, meta: { family: 'Claude Opus', runtime: 'claude-code', rate: 'family' } });
    expect(byKey.get('deepseek/deepseek-chat')).toMatchObject({ label: 'deepseek-chat', total: 3_500, meta: { family: 'DeepSeek', runtime: 'crewly-agent', rate: 'exact' } });
    expect(byKey.get('gpt-6-sol')?.meta).toMatchObject({ family: 'GPT', runtime: 'codex-cli' });
    expect(byKey.get('(unknown-model)')).toMatchObject({ label: 'Unknown model', total: 30, events: 2, meta: { family: 'Unknown', rate: 'default' } });
    expect(r.groups.model!.reduce((n, x) => n + x.total, 0)).toBe(r.totals.total);
    expect(parseGroupBy('model,agent')).toEqual(['model', 'agent']);
  });

  it('today only (days=1)', async () => {
    const r = await svc().query(1, ['agent']);
    expect(r.totals.total).toBe(26_000);
    expect(r.rows.find((x) => x.key === 'ella')?.total).toBe(1_000);
  });

  it('attributes work items via computeWorkItemUsage (the agent\'s usage while the item ran), top first, with links', async () => {
    items = [
      { id: 'wi-1', title: 'Refresh bulletin page', status: 'completed', target: 'nova', createdAt: at(2, 9, 30).toISOString(), startedAt: at(2, 9, 45).toISOString(), completedAt: at(2, 10, 30).toISOString() },
      { id: 'wi-2', title: 'Fix login', status: 'running', target: 'owen', createdAt: at(2, 8).toISOString(), startedAt: at(2, 8, 30).toISOString() },
      { id: 'wi-old', title: 'Old', status: 'completed', target: 'owen', createdAt: new Date(2026, 8, 20, 8).toISOString(), completedAt: new Date(2026, 8, 20, 10).toISOString() },
      { id: 'wi-none', title: 'Nothing used', status: 'completed', target: 'ella', createdAt: at(2, 15).toISOString(), completedAt: at(2, 16).toISOString() },
    ];
    const r = await svc().query(7, ['workItem']);
    expect(r.rows.map((x) => [x.key, x.label, x.total, x.cachedInput, x.link])).toEqual([
      ['wi-1', 'Refresh bulletin page', 11_000, 8_000, '/workitems/wi-1'],
      ['wi-2', 'Fix login', 10_500, 9_900, '/workitems/wi-2'],
    ]);
    expect(r.rows[0].meta).toEqual({ agent: 'Nova', status: 'completed', team: 'CE' });
  });

  it('attributes projects: the running work item\'s project first, else the team\'s only project', async () => {
    items = [
      // Ella's team works on two projects; her work item names one.
      { id: 'wi-e', title: 'Site copy', status: 'completed', target: 'ella', createdAt: at(2, 10).toISOString(), startedAt: at(2, 10, 30).toISOString(), completedAt: at(2, 11, 30).toISOString(), metadata: { projectId: 'p-mk' } },
    ];
    const r = await svc().query(7, ['project']);
    expect(r.rows.map((x) => [x.key, x.label, x.total])).toEqual([
      ['p-ce', 'CE core', 21_500],
      ['(unattributed)', '(unattributed)', 5_000 + 3_500],
      ['p-mk', 'Marketing site', 1_000],
    ]);
  });

  it('parses groupBy', () => {
    expect(parseGroupBy(undefined)).toEqual(['agent']);
    expect(parseGroupBy('team,runtime,bogus,team')).toEqual(['team', 'runtime']);
    expect(parseGroupBy('nope')).toEqual(['agent']);
  });
});

describe('modelKeyOf / modelFamily', () => {
  it('folds missing and placeholder models into Unknown model', () => {
    expect(modelKeyOf('')).toBe('(unknown-model)');
    expect(modelKeyOf(undefined)).toBe('(unknown-model)');
    expect(modelKeyOf('codex-cli-default')).toBe('(unknown-model)');
    expect(modelKeyOf('claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('names families', () => {
    expect(modelFamily('claude-sonnet-5')).toBe('Claude Sonnet');
    expect(modelFamily('claude-haiku-4-5')).toBe('Claude Haiku');
    expect(modelFamily('deepseek/deepseek-chat')).toBe('DeepSeek');
    expect(modelFamily('gpt-5-codex')).toBe('GPT');
    expect(modelFamily('gemini-2.5-pro')).toBe('Gemini');
    expect(modelFamily('mystery')).toBe('Other');
  });
});
