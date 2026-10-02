/**
 * Tests for the token usage stats: aggregation by agent / team / project /
 * work item / runtime / day, in the one token unit.
 */
import { TokenUsageService, eventCostUsd } from '../monitoring/token-usage.service.js';
import { modelFamily, modelKeyOf, parseGroupBy, UsageStatsService, workItemBounds, type UsageTeam, type UsageWorkItem } from './usage-stats.service.js';

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

  it('attributes work items by the item running at each event, top first, with links', async () => {
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
      ['(no-work-item)', '(no work item)', 6_000 + 3_500, 4_000 + 1_000 + 2_000, undefined],
    ]);
    expect(r.rows[0].meta).toEqual({ agent: 'Nova', status: 'completed', team: 'CE' });
    expect(r.rows[0].events).toBe(1);
    expect(r.rows.reduce((n, x) => n + x.total, 0)).toBe(r.totals.total);
  });

  describe('workItem attribution (#953)', () => {
    const rowsOf = async () => (await svc().query(7, ['workItem', 'agent'])).groups;

    it('gives two items of one agent at different times only their own events; rows sum to the agent total', async () => {
      claude('owen', at(2, 14), 0, 2_000, 0); // 2,000
      claude('owen', at(2, 16), 0, 4_000, 0); // 4,000
      items = [
        { id: 'wi-a', title: 'A', status: 'done', target: 'owen', createdAt: at(2, 13).toISOString(), startedAt: at(2, 13, 30).toISOString(), completedAt: at(2, 15).toISOString() },
        { id: 'wi-b', title: 'B', status: 'running', target: 'owen', createdAt: at(2, 15, 30).toISOString(), startedAt: at(2, 15, 45).toISOString() },
      ];
      const g = await rowsOf();
      const wi = new Map(g.workItem!.map((x) => [x.key, x.total]));
      expect(wi.get('wi-a')).toBe(2_000);
      expect(wi.get('wi-b')).toBe(4_000);
      const owenTotal = g.agent!.find((x) => x.key === 'owen')!.total;
      expect(owenTotal).toBe(10_500 + 6_000);
      // Owen's 9:00 event ran outside both items.
      expect(wi.get('(no-work-item)')).toBe(10_500 + 11_000 + 6_000 + 3_500);
      expect(g.workItem!.reduce((n, x) => n + x.total, 0)).toBe(g.agent!.reduce((n, x) => n + x.total, 0));
    });

    it('lists an item once, and open items from before the window do not each get the agent total', async () => {
      const longAgo = new Date(2026, 8, 1, 8).toISOString();
      const stale = { id: 'wi-max', title: 'Max idle — verify progress', status: 'running', target: 'owen', createdAt: longAgo, startedAt: longAgo };
      items = [
        stale,
        { ...stale }, // the same item listed twice
        { id: 'wi-max-2', title: 'Max idle — verify progress', status: 'running', target: 'owen', createdAt: longAgo, startedAt: new Date(2026, 8, 1, 9).toISOString() },
      ];
      const g = await rowsOf();
      const keys = g.workItem!.map((x) => x.key);
      expect(new Set(keys).size).toBe(keys.length);
      // Owen's whole usage lands once, on the most recently started open item.
      expect(g.workItem!.filter((x) => x.label === 'Max idle — verify progress').map((x) => [x.key, x.total])).toEqual([['wi-max-2', 10_500]]);
      expect(g.workItem!.reduce((n, x) => n + x.total, 0)).toBe(31_000);
    });

    it('puts usage outside any work item in the "(no work item)" row; a never-started item gets nothing', async () => {
      items = [{ id: 'wi-q', title: 'Queued', status: 'queued', target: 'nova', createdAt: at(1, 8).toISOString() }];
      const g = await rowsOf();
      expect(g.workItem!.map((x) => [x.key, x.label, x.total, x.events])).toEqual([['(no-work-item)', '(no work item)', 31_000, 5]]);
      expect(g.workItem![0].share).toBe(1);
      expect(g.workItem![0].link).toBeUndefined();
    });

    it('a cancelled / re-queued / blocked item without completedAt does not absorb the agent\'s later usage', async () => {
      claude('owen', at(2, 14), 0, 2_000, 0); // 2,000
      items = [
        // Stopped with no recorded end: no span at all.
        { id: 'wi-cancelled', title: 'C', status: 'cancelled', target: 'owen', createdAt: at(2, 8).toISOString(), startedAt: at(2, 8, 30).toISOString() },
        { id: 'wi-requeued', title: 'Q', status: 'queued', target: 'owen', createdAt: at(2, 8).toISOString(), startedAt: at(2, 8, 45).toISOString() },
        { id: 'wi-escalated', title: 'E', status: 'escalated', target: 'owen', createdAt: at(2, 8).toISOString(), startedAt: at(2, 8, 50).toISOString() },
      ];
      const wi = new Map((await rowsOf()).workItem!.map((x) => [x.key, x.total]));
      expect([...wi.keys()]).toEqual(['(no-work-item)']);
      expect(wi.get('(no-work-item)')).toBe(31_000 + 2_000);
    });

    it('a stopped item ends when its status changed (statusChangedAt, or blockedAt for an explicit block)', async () => {
      claude('owen', at(2, 14), 0, 2_000, 0); // 2,000 — after both stopped
      items = [
        { id: 'wi-cancelled', title: 'C', status: 'cancelled', target: 'owen', createdAt: at(2, 8).toISOString(), startedAt: at(2, 8, 30).toISOString(), statusChangedAt: at(2, 9, 30).toISOString() },
        { id: 'wi-blocked', title: 'B', status: 'blocked', target: 'nova', createdAt: at(2, 8).toISOString(), startedAt: at(2, 9, 30).toISOString(), metadata: { blockedAt: at(2, 10, 30).toISOString() } },
      ];
      const wi = new Map((await rowsOf()).workItem!.map((x) => [x.key, x.total]));
      expect(wi.get('wi-cancelled')).toBe(10_500); // Owen's 9:00 event only
      expect(wi.get('wi-blocked')).toBe(11_000); // Nova's 10:00 event
      expect(wi.get('(no-work-item)')).toBe(5_000 + 1_000 + 3_500 + 2_000);
    });

    it('overlapping items: the most recently started one gets the event', async () => {
      items = [
        { id: 'wi-old', title: 'Older', status: 'running', target: 'nova', createdAt: at(2, 8).toISOString(), startedAt: at(2, 8).toISOString() },
        { id: 'wi-new', title: 'Newer', status: 'done', target: 'nova', createdAt: at(2, 9).toISOString(), startedAt: at(2, 9, 30).toISOString(), completedAt: at(2, 11).toISOString() },
      ];
      const wi = new Map((await rowsOf()).workItem!.map((x) => [x.key, x.total]));
      expect(wi.get('wi-new')).toBe(11_000);
      expect(wi.has('wi-old')).toBe(false);
    });
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

  it('project windows follow the same bounds: a never-started queued item does not claim its agent\'s usage', async () => {
    items = [
      // Ella's team works on two projects. This item names one but never started.
      { id: 'wi-q', title: 'Queued', status: 'queued', target: 'ella', createdAt: at(1, 8).toISOString(), metadata: { projectId: 'p-mk' } },
      // Cancelled without a known end: no window either.
      { id: 'wi-c', title: 'Cancelled', status: 'cancelled', target: 'ella', createdAt: at(1, 8).toISOString(), startedAt: at(1, 9).toISOString(), metadata: { projectId: 'p-web' } },
    ];
    const r = await svc().query(7, ['project']);
    expect(r.rows.map((x) => [x.key, x.total])).toEqual([
      ['p-ce', 21_500],
      ['(unattributed)', 5_000 + 1_000 + 3_500],
    ]);
  });

  describe('workItemBounds', () => {
    const base: UsageWorkItem = { id: 'w', title: 'W', status: 'running', target: 'owen', createdAt: at(2, 8).toISOString(), startedAt: at(2, 9).toISOString() };

    it('a running item is open until now', () => {
      expect(workItemBounds(base, now)).toEqual({ start: at(2, 9).getTime(), end: now.getTime() });
    });

    it('completedAt ends any item', () => {
      expect(workItemBounds({ ...base, status: 'done', completedAt: at(2, 10).toISOString() }, now)).toEqual({ start: at(2, 9).getTime(), end: at(2, 10).getTime() });
    });

    it('an item completed without a claim starts at createdAt', () => {
      expect(workItemBounds({ ...base, status: 'done', startedAt: undefined, completedAt: at(2, 10).toISOString() }, now)?.start).toBe(at(2, 8).getTime());
    });

    it('never started → no range; stopped without a known end → no range', () => {
      expect(workItemBounds({ ...base, status: 'queued', startedAt: undefined }, now)).toBeNull();
      for (const status of ['cancelled', 'blocked', 'queued', 'escalated', 'accepted']) {
        expect(workItemBounds({ ...base, status }, now)).toBeNull();
      }
    });

    it('a stop time is capped at now and must not precede the start', () => {
      expect(workItemBounds({ ...base, status: 'cancelled', statusChangedAt: at(3, 9).toISOString() }, now)?.end).toBe(now.getTime());
      expect(workItemBounds({ ...base, status: 'cancelled', statusChangedAt: at(2, 8).toISOString() }, now)).toBeNull();
    });
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
