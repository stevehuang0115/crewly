/**
 * Tests for TeamBudgetGateService.
 *
 * @module services/budget/team-budget-gate.service.test
 */

import { jest } from '@jest/globals';
import {
  TeamBudgetGateService,
  TeamBudgetExceededError,
  TEAM_BUDGET_CACHE_TTL_MS,
  TEAM_BUDGET_EXCEEDED_REASON,
  DEFAULT_ALERT_THRESHOLD_PCT,
  BUDGET_CONVERSATION_ID,
  type BudgetUsageLedger,
} from './team-budget-gate.service.js';
import type { Team, TeamBudget } from '../../types/index.js';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never;

function makeTeam(id: string, sessions: string[], budget?: TeamBudget): Team {
  return {
    id,
    name: `Team ${id}`,
    description: '',
    members: sessions.map((s, i) => ({
      id: `${id}-m${i}`,
      name: `Member ${i}`,
      sessionName: s,
      role: 'developer',
      systemPrompt: '',
      agentStatus: 'active',
      workingStatus: 'idle',
      runtimeType: 'claude-code',
      createdAt: '',
      updatedAt: '',
    })),
    budget,
    createdAt: '',
    updatedAt: '',
  } as unknown as Team;
}

/**
 * Ledger stub keyed by window. Tests pin "now" to the 15th, so a `since` on
 * the 1st is the month window (returns `monthUsd`) and a `since` on the 15th
 * is the day window (returns `dayTokens`, split across input/output).
 */
function makeLedger(
  perSession: Record<string, { dayTokens: number; monthUsd: number }>,
): BudgetUsageLedger & { calls: Array<[string, Date]> } {
  const calls: Array<[string, Date]> = [];
  return {
    calls,
    getSessionUsageSince(sessionName: string, since: Date) {
      calls.push([sessionName, since]);
      const rec = perSession[sessionName] ?? { dayTokens: 0, monthUsd: 0 };
      if (since.getUTCDate() === 1) {
        return { inputTokens: 0, outputTokens: 0, cost: rec.monthUsd };
      }
      return { inputTokens: rec.dayTokens / 2, outputTokens: rec.dayTokens / 2, cost: 0 };
    },
  };
}

const NOW = new Date('2026-09-15T12:00:00.000Z');

function build(opts: {
  teams: Team[];
  ledger?: BudgetUsageLedger;
  now?: () => Date;
}) {
  const getTeams = jest.fn(async () => opts.teams);
  const gate = new TeamBudgetGateService({
    getTeams,
    ledger: opts.ledger ?? makeLedger({}),
    now: opts.now ?? (() => NOW),
    logger,
  });
  return { gate, getTeams };
}

describe('TeamBudgetGateService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    TeamBudgetGateService.resetInstance();
  });

  it('allows a team with no budget and an unknown team', async () => {
    const { gate } = build({ teams: [makeTeam('t1', ['s1'])] });
    expect((await gate.check('t1')).allowed).toBe(true);
    expect((await gate.check('t1')).level).toBe('ok');
    expect((await gate.check('nope')).allowed).toBe(true);
  });

  it('sums today\'s tokens across member sessions against maxTokensPerDay', async () => {
    const ledger = makeLedger({ s1: { dayTokens: 600, monthUsd: 0 }, s2: { dayTokens: 300, monthUsd: 0 } });
    const { gate } = build({
      teams: [makeTeam('t1', ['s1', 's2'], { maxTokensPerDay: 1000 })],
      ledger,
    });
    const check = await gate.check('t1');
    expect(check.usage.tokensToday).toBe(900);
    expect(check.usage.tokenPct).toBe(90);
    expect(check.usage.sessions).toEqual(['s1', 's2']);
    expect(check.level).toBe('warn'); // 90% ≥ default 80%
    expect(check.allowed).toBe(true);
  });

  it('blocks at 100% of maxTokensPerDay with reason team_budget_exceeded', async () => {
    const ledger = makeLedger({ s1: { dayTokens: 1000, monthUsd: 0 } });
    const { gate } = build({ teams: [makeTeam('t1', ['s1'], { maxTokensPerDay: 1000 })], ledger });
    const check = await gate.check('t1');
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe(TEAM_BUDGET_EXCEEDED_REASON);
    expect(check.level).toBe('blocked');
    expect(check.detail).toMatch(/1000 tokens today ≥ 1000\/day/);
  });

  it('blocks on maxUsdPerMonth using month-to-date cost', async () => {
    const ledger = makeLedger({ s1: { dayTokens: 0, monthUsd: 12.5 } });
    const { gate } = build({ teams: [makeTeam('t1', ['s1'], { maxUsdPerMonth: 10 })], ledger });
    const check = await gate.check('t1');
    expect(check.allowed).toBe(false);
    expect(check.usage.usdThisMonth).toBe(12.5);
    expect(check.usage.usdPct).toBe(125);
    expect(check.detail).toMatch(/\$12\.50 this month ≥ \$10\/month/);
  });

  it('honours a custom alertThreshold and stays ok below it', async () => {
    const ledger = makeLedger({ s1: { dayTokens: 500, monthUsd: 0 } });
    const { gate } = build({
      teams: [makeTeam('t1', ['s1'], { maxTokensPerDay: 1000, alertThreshold: 60 })],
      ledger,
    });
    expect((await gate.check('t1')).level).toBe('ok');
    expect(DEFAULT_ALERT_THRESHOLD_PCT).toBe(80);
  });

  it('caches the result per team for 60s and re-evaluates after the TTL', async () => {
    let now = NOW;
    const ledger = makeLedger({ s1: { dayTokens: 100, monthUsd: 0 } });
    const { gate, getTeams } = build({
      teams: [makeTeam('t1', ['s1'], { maxTokensPerDay: 1000 })],
      ledger,
      now: () => now,
    });
    await gate.check('t1');
    await gate.check('t1');
    await gate.checkForSession('s1');
    expect(getTeams).toHaveBeenCalledTimes(1);
    const ledgerCallsAfterFirst = ledger.calls.length;

    now = new Date(NOW.getTime() + TEAM_BUDGET_CACHE_TTL_MS + 1);
    await gate.check('t1');
    expect(getTeams).toHaveBeenCalledTimes(2);
    expect(ledger.calls.length).toBeGreaterThan(ledgerCallsAfterFirst);
  });

  it('checkForSession resolves the team by member sessionName; unknown sessions are allowed', async () => {
    const ledger = makeLedger({ s1: { dayTokens: 1000, monthUsd: 0 } });
    const { gate } = build({ teams: [makeTeam('t1', ['s1'], { maxTokensPerDay: 1000 })], ledger });
    expect((await gate.checkForSession('s1')).allowed).toBe(false);
    const orc = await gate.checkForSession('crewly-orc');
    expect(orc.allowed).toBe(true);
    expect(orc.teamId).toBe('');
  });

  it('fails open when the team store throws', async () => {
    const gate = new TeamBudgetGateService({
      getTeams: async () => {
        throw new Error('teams.json unreadable');
      },
      ledger: makeLedger({}),
      now: () => NOW,
      logger,
    });
    expect((await gate.check('t1')).allowed).toBe(true);
    expect((await gate.checkForSession('s1')).allowed).toBe(true);
  });

  describe('notifications', () => {
    it('publishes team:budget_exceeded and enqueues [BUDGET] once per team per level per day', async () => {
      const published: unknown[] = [];
      const enqueued: unknown[] = [];
      const ledger = makeLedger({ s1: { dayTokens: 1000, monthUsd: 0 } });
      const { gate } = build({ teams: [makeTeam('t1', ['s1'], { maxTokensPerDay: 1000 })], ledger });
      gate.setNotifiers({
        eventBus: { publish: (e: unknown) => published.push(e) } as never,
        messageQueue: { enqueue: (m: unknown) => enqueued.push(m) },
      });

      await gate.check('t1');
      gate.invalidate('t1');
      await gate.check('t1');

      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        type: 'team:budget_exceeded',
        teamId: 't1',
        newValue: 'blocked',
        sessionName: '',
        id: 'team:budget_exceeded:t1:blocked:2026-09-15',
      });
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({
        source: 'system_event',
        conversationId: BUDGET_CONVERSATION_ID,
        targetSession: 'crewly-orc',
      });
      expect(String((enqueued[0] as { content: string }).content)).toMatch(
        /^\[BUDGET\] Team "Team t1" \(t1\) BLOCKED/,
      );
    });

    it('sends a warn notice and later a separate blocked notice as usage grows', async () => {
      const enqueued: Array<{ content: string }> = [];
      let tokens = 850;
      const ledger: BudgetUsageLedger = {
        getSessionUsageSince: (_s, since) =>
          since.getUTCDate() === 15
            ? { inputTokens: tokens, outputTokens: 0, cost: 0 }
            : { inputTokens: 0, outputTokens: 0, cost: 0 },
      };
      const { gate } = build({ teams: [makeTeam('t1', ['s1'], { maxTokensPerDay: 1000 })], ledger });
      gate.setNotifiers({ messageQueue: { enqueue: (m: unknown) => enqueued.push(m as { content: string }) } });

      expect((await gate.check('t1')).level).toBe('warn');
      tokens = 1200;
      gate.invalidate('t1');
      expect((await gate.check('t1')).level).toBe('blocked');

      expect(enqueued.map((m) => m.content)).toEqual([
        expect.stringContaining('WARNING'),
        expect.stringContaining('BLOCKED'),
      ]);
    });

    it('does not notify for an ok team', async () => {
      const enqueued: unknown[] = [];
      const ledger = makeLedger({ s1: { dayTokens: 10, monthUsd: 0 } });
      const { gate } = build({ teams: [makeTeam('t1', ['s1'], { maxTokensPerDay: 1000 })], ledger });
      gate.setNotifiers({ messageQueue: { enqueue: (m: unknown) => enqueued.push(m) } });
      await gate.check('t1');
      expect(enqueued).toHaveLength(0);
    });
  });

  it('TeamBudgetExceededError carries the reason and check', async () => {
    const ledger = makeLedger({ s1: { dayTokens: 1000, monthUsd: 0 } });
    const { gate } = build({ teams: [makeTeam('t1', ['s1'], { maxTokensPerDay: 1000 })], ledger });
    const check = await gate.check('t1');
    const err = new TeamBudgetExceededError(check);
    expect(err.reason).toBe('team_budget_exceeded');
    expect(err.message).toBe(check.detail);
    expect(err.check.teamId).toBe('t1');
  });

  it('getInstance returns a singleton until reset', () => {
    const a = TeamBudgetGateService.getInstance();
    expect(TeamBudgetGateService.getInstance()).toBe(a);
    TeamBudgetGateService.resetInstance();
    expect(TeamBudgetGateService.getInstance()).not.toBe(a);
  });
});
