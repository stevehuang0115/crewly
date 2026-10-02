/**
 * Test fixtures for the Usage page (`/api/system/usage*`).
 *
 * @module test/usage.fixtures
 */

import type { CapsView, UsageRow, UsageStats } from '../services/usage.service';

/** One million tokens. */
export const M = 1_000_000;

/**
 * Build a stats row.
 *
 * @param key - Row key
 * @param label - Label
 * @param total - Tokens
 * @param extra - Other fields
 * @returns Row
 */
export function usageRow(key: string, label: string, total: number, extra: Partial<UsageRow> = {}): UsageRow {
  return { key, label, total, input: total, cachedInput: total / 2, output: 0, events: 1, share: total / (100 * M), ...extra };
}

/**
 * Stats for a 7-day window.
 *
 * @param over - Fields to override
 * @returns Stats
 */
export function makeUsageStats(over: Partial<UsageStats> = {}): UsageStats {
  return {
    days: 7,
    since: '2026-09-26T04:00:00.000Z',
    today: '2026-10-02',
    totals: { input: 95 * M, cachedInput: 80 * M, output: 5 * M, total: 100 * M, events: 10 },
    todayTotals: { input: 11 * M, cachedInput: 9 * M, output: M, total: 12.4 * M, events: 3 },
    groupBy: ['team', 'agent', 'runtime', 'workItem'],
    rows: [],
    groups: {
      team: [usageRow('t-ce', 'CE', 70 * M), usageRow('(unattributed)', 'Orc (no team)', 30 * M)],
      agent: [usageRow('ce-nova', 'Nova', 40 * M, { meta: { team: 'CE', runtimes: ['codex-cli'] } }), usageRow('crewly-orc', 'Orc', 30 * M, { meta: { runtimes: ['claude-code'] } })],
      runtime: [usageRow('claude-code', 'claude-code', 60 * M), usageRow('codex-cli', 'codex-cli', 40 * M)],
      workItem: [usageRow('wi-1', 'Refresh bulletin page', 9 * M, { link: '/workitems/wi-1', meta: { agent: 'Nova', team: 'CE', status: 'completed' } })],
    },
    ...over,
  };
}

/**
 * Caps view: team CE capped at 50M and stopped, no total cap.
 *
 * @param over - Fields to override
 * @returns Caps view
 */
export function makeCapsView(over: Partial<CapsView> = {}): CapsView {
  return {
    today: '2026-10-02',
    todayTokens: 12.4 * M,
    totalTokens: 100 * M,
    agents: [
      {
        session: 'ce-nova',
        name: 'Nova',
        teamId: 't-ce',
        runtimes: ['codex-cli'],
        todayTokens: 6 * M,
        windowTokens: 40 * M,
        capTokens: null,
        baseCapTokens: null,
        capSource: 'none',
        boosted: false,
        unlimited: false,
        stopped: true,
        stopReason: 'Nova is stopped: team CE hit its daily token cap (50M tokens)',
      },
    ],
    teams: [
      { teamId: 't-ce', name: 'CE', members: ['ce-nova'], todayTokens: 51 * M, baseCapTokens: 50 * M, capTokens: 50 * M, extraTokens: 0, unlimited: false, boosts: [], stopped: true },
      { teamId: 't-idle', name: 'Idle', members: [], todayTokens: 0, baseCapTokens: null, capTokens: null, extraTokens: 0, unlimited: false, boosts: [], stopped: false },
    ],
    caps: { defaultAgentCapTokens: null, totalCapTokens: null, agentCapsTokens: {}, teamCapsTokens: { 't-ce': 50 * M } },
    boosts: [],
    totalCapTodayTokens: null,
    suggestedAgentCapTokens: 8 * M,
    totalStopped: false,
    ...over,
  };
}
