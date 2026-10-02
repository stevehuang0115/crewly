/**
 * Settings → System → Usage
 *
 * Tokens used today / in the last 7 / 30 days — by team, by agent, by
 * runtime, and the top work items (linked) — plus the owner's daily token
 * caps (per agent, per team, all agents) and temporary boosts: one tap on a
 * team row gives it "+X today" or "Unlimited today" until midnight.
 *
 * The unit is tokens: input (cached included) + output; cached input is
 * shown beside it. Subscription and API billing are not told apart.
 * Phone-first: stacked cards, no tables. specs/2026-10-02-spend-cap.md
 *
 * @module components/Settings/UsagePanel
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gauge, RefreshCw } from 'lucide-react';
import { Alert, Button, FilterPillGroup } from '@crewly/ui';
import { FormInput, FormLabel } from '@crewly/ui/Form';
import {
  boostAmount,
  compactTokens,
  parseTokenInput,
  tokens,
  usageService,
  type BoostRequest,
  type CapTeam,
  type CapsPatch,
  type CapsView,
  type UsageRow,
  type UsageStats,
} from '../../services/usage.service';

/** Labels of runtimes. */
export const RUNTIME_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'crewly-agent': 'Crewly Agent',
  'codex-cli': 'Codex',
  'gemini-cli': 'Gemini CLI',
  'antigravity-cli': 'Antigravity',
  'opencode-cli': 'OpenCode',
  other: 'Other',
};

/** Periods. */
const PERIODS = [
  { key: '1', label: 'Today' },
  { key: '7', label: '7 days' },
  { key: '30', label: '30 days' },
] as const;
type PeriodKey = (typeof PERIODS)[number]['key'];

/**
 * Text of a team's cap cell.
 *
 * @param t - Team row
 * @returns e.g. `50M cap (+20M today)`, `Unlimited today`, `No cap`
 */
export function teamCapLabel(t: Pick<CapTeam, 'baseCapTokens' | 'capTokens' | 'extraTokens' | 'unlimited'>): string {
  if (t.unlimited) return 'Unlimited today';
  if (t.baseCapTokens === null) return t.extraTokens > 0 ? `No cap (+${compactTokens(t.extraTokens)} boost)` : 'No cap';
  return t.extraTokens > 0 ? `${compactTokens(t.capTokens ?? t.baseCapTokens)} cap (+${compactTokens(t.extraTokens)} today)` : `${compactTokens(t.baseCapTokens)} cap`;
}

/** One row of a ranked list. */
const RowLine: React.FC<{ row: UsageRow; testId: string; sub?: string; to?: string }> = ({ row, testId, sub, to }) => (
  <div className="flex items-baseline justify-between gap-3 py-1.5" data-testid={testId}>
    <div className="min-w-0">
      {to ? (
        <Link to={to} className="block truncate text-sm text-text-primary-dark underline-offset-2 hover:underline">
          {row.label}
        </Link>
      ) : (
        <span className="block truncate text-sm text-text-primary-dark">{row.label}</span>
      )}
      {sub && <span className="block truncate text-xs text-text-secondary-dark">{sub}</span>}
    </div>
    <div className="shrink-0 text-right">
      <span className="text-sm text-text-primary-dark">{compactTokens(row.total)}</span>
      <span className="block text-xs text-text-secondary-dark">{Math.round(row.share * 100)}%</span>
    </div>
  </div>
);

/**
 * Usage + caps + boosts panel.
 *
 * @returns Panel
 */
export const UsagePanel: React.FC = () => {
  const [period, setPeriod] = useState<PeriodKey>('7');
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [caps, setCaps] = useState<CapsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [defaultCap, setDefaultCap] = useState('');
  const [totalCap, setTotalCap] = useState('');
  const [teamCaps, setTeamCaps] = useState<Record<string, string>>({});

  const load = useCallback(async (p: PeriodKey) => {
    try {
      const [s, c] = await Promise.all([usageService.stats(Number(p), ['team', 'agent', 'runtime', 'workItem']), usageService.caps(Number(p))]);
      setStats(s);
      setCaps(c);
      setDefaultCap(c.caps.defaultAgentCapTokens === null ? '' : compactTokens(c.caps.defaultAgentCapTokens));
      setTotalCap(c.caps.totalCapTokens === null ? '' : compactTokens(c.caps.totalCapTokens));
      setTeamCaps({});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  const run = async (action: () => Promise<string>): Promise<void> => {
    setBusy(true);
    try {
      setNote(await action());
      setError(null);
      await load(period);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const boost = (req: BoostRequest, who: string): Promise<void> =>
    run(async () => {
      await usageService.boost(req);
      return req.unlimited ? `${who}: no cap until midnight.` : `${who}: +${tokens(req.extraTokens ?? 0)} until midnight.`;
    });

  const endBoost = (id: string): Promise<void> =>
    run(async () => {
      await usageService.endBoost(id);
      return 'Boost ended.';
    });

  const save = (): Promise<void> =>
    run(async () => {
      const d = parseTokenInput(defaultCap);
      const t = parseTokenInput(totalCap);
      if (d === undefined || t === undefined) throw new Error('Caps are token amounts like 5M or 500k, or empty for off.');
      const patch: CapsPatch = { defaultAgentCapTokens: d, totalCapTokens: t };
      const teams: Record<string, number | null> = {};
      for (const [teamId, text] of Object.entries(teamCaps)) {
        const v = parseTokenInput(text);
        if (v === undefined) throw new Error('Team caps are token amounts like 50M, or empty for no cap.');
        teams[teamId] = v;
      }
      if (Object.keys(teams).length > 0) patch.teams = teams;
      await usageService.setCaps(patch);
      return 'Caps saved. They apply right away and reset each day at midnight.';
    });

  if (!stats || !caps) {
    return error ? (
      <Alert variant="error" size="sm">
        {error}{' '}
        <button type="button" className="underline" onClick={() => void load(period)}>
          Retry
        </button>
      </Alert>
    ) : null;
  }

  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? '';
  const teamRows = stats.groups.team ?? [];
  const agentRows = (stats.groups.agent ?? []).slice(0, 10);
  const runtimeRows = stats.groups.runtime ?? [];
  const workItemRows = (stats.groups.workItem ?? []).slice(0, 10);
  const capTeamById = new Map(caps.teams.map((t) => [t.teamId, t]));
  const everyoneBoost = caps.boosts.find((b) => b.target === '*');
  // Teams with usage first (in the stats order), then teams with a cap or a boost but no usage.
  const teamOrder = [
    ...teamRows.filter((r) => capTeamById.has(r.key)).map((r) => r.key),
    ...caps.teams.filter((t) => !teamRows.some((r) => r.key === t.teamId) && (t.baseCapTokens !== null || t.boosts.length > 0)).map((t) => t.teamId),
  ];
  const unattributed = teamRows.filter((r) => !capTeamById.has(r.key));

  return (
    <div className="space-y-4" data-testid="usage-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Gauge className="h-5 w-5 shrink-0 text-text-secondary-dark" />
          <h3 className="text-lg font-semibold text-text-primary-dark">Usage</h3>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load(period)} icon={RefreshCw}>
          Refresh
        </Button>
      </div>
      <FilterPillGroup
        options={PERIODS.map((p) => ({ key: p.key, label: p.label }))}
        value={period}
        onChange={(v) => setPeriod(v)}
        testIdPrefix="usage-period"
      />
      <p className="text-xs text-text-secondary-dark">Tokens = input (cached included) + output, from every runtime. Subscription and API use count the same.</p>

      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}
      {note && (
        <p className="text-xs text-emerald-400" data-testid="usage-note">
          {note}
        </p>
      )}
      {caps.totalStopped && caps.totalCapTodayTokens !== null && (
        <Alert variant="warning" size="sm">
          All agents together hit the daily cap ({tokens(caps.totalCapTodayTokens)}). Every agent is stopped until midnight.{' '}
          <button type="button" className="underline" disabled={busy} onClick={() => void boost({ scope: 'all', unlimited: true }, 'Everyone')}>
            Unlimited today
          </button>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border-dark p-3">
          <div className="text-xs text-text-secondary-dark">{periodLabel}</div>
          <div className="text-xl font-semibold text-text-primary-dark" data-testid="usage-total">
            {tokens(stats.totals.total)}
          </div>
          <div className="mt-1 text-xs text-text-secondary-dark" data-testid="usage-cached">
            {compactTokens(stats.totals.cachedInput)} cached input · {compactTokens(stats.totals.output)} output
          </div>
        </div>
        <div className="rounded-lg border border-border-dark p-3">
          <div className="text-xs text-text-secondary-dark">Today</div>
          <div className="text-xl font-semibold text-text-primary-dark" data-testid="usage-today">
            {tokens(stats.todayTotals.total)}
          </div>
          <div className="mt-1 text-xs text-text-secondary-dark">
            {caps.totalCapTodayTokens !== null ? `Cap ${compactTokens(caps.totalCapTodayTokens)} all agents` : 'No total cap'}
          </div>
        </div>
      </div>

      <section className="space-y-2" data-testid="usage-teams">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-text-primary-dark">By team</h4>
          {everyoneBoost ? (
            <button type="button" className="text-xs underline text-text-secondary-dark" disabled={busy} onClick={() => void endBoost(everyoneBoost.id)}>
              End everyone boost
            </button>
          ) : (
            <button type="button" className="text-xs underline text-text-secondary-dark" disabled={busy} onClick={() => void boost({ scope: 'all', unlimited: true }, 'Everyone')}>
              Unlimited today for everyone
            </button>
          )}
        </div>
        {teamOrder.length === 0 && unattributed.length === 0 && <p className="text-sm text-text-secondary-dark">No usage recorded in this period.</p>}
        {teamOrder.map((teamId) => {
          const t = capTeamById.get(teamId) as CapTeam;
          const row = teamRows.find((r) => r.key === teamId);
          const extra = boostAmount(t.baseCapTokens);
          const own = t.boosts[0];
          return (
            <div key={teamId} className="rounded-lg border border-border-dark p-3" data-testid={`usage-team-${teamId}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-text-primary-dark">{t.name}</span>
                <span className="text-sm text-text-primary-dark">
                  {compactTokens(row?.total ?? 0)} <span className="text-xs text-text-secondary-dark">{periodLabel.toLowerCase()} · {compactTokens(t.todayTokens)} today</span>
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-secondary-dark">
                <span data-testid={`usage-team-cap-${teamId}`}>{teamCapLabel(t)}</span>
                {t.stopped && <span className="text-yellow-400">Stopped until midnight</span>}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void boost({ scope: 'team', id: teamId, extraTokens: extra }, t.name)}>
                  +{compactTokens(extra)} today
                </Button>
                <Button type="button" size="sm" variant="secondary" disabled={busy || t.unlimited} onClick={() => void boost({ scope: 'team', id: teamId, unlimited: true }, t.name)}>
                  Unlimited today
                </Button>
                {own && (
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void endBoost(own.id)}>
                    End boost
                  </Button>
                )}
              </div>
              <div className="mt-2">
                <FormInput
                  size="sm"
                  aria-label={`Daily cap for team ${t.name}`}
                  placeholder="No team cap"
                  value={teamCaps[teamId] ?? (t.baseCapTokens !== null ? compactTokens(t.baseCapTokens) : '')}
                  onChange={(e) => setTeamCaps((c) => ({ ...c, [teamId]: e.target.value }))}
                  className="sm:max-w-[10rem]"
                />
              </div>
            </div>
          );
        })}
        {unattributed.map((r) => (
          <RowLine key={r.key} row={r} testId={`usage-team-${r.key}`} />
        ))}
      </section>

      <section data-testid="usage-agents">
        <h4 className="text-sm font-semibold text-text-primary-dark">By agent</h4>
        {agentRows.map((r) => {
          const a = caps.agents.find((x) => x.session === r.key);
          const runtimes = Array.isArray(r.meta?.runtimes) ? (r.meta?.runtimes as string[]).map((x) => RUNTIME_LABELS[x] ?? x).join(', ') : '';
          const team = typeof r.meta?.team === 'string' ? r.meta.team : '';
          const stop = a?.stopped ? ` · ${a.stopReason ?? 'stopped'}` : '';
          return <RowLine key={r.key} row={r} testId={`usage-agent-${r.key}`} sub={[team, runtimes].filter(Boolean).join(' · ') + stop} />;
        })}
      </section>

      <section data-testid="usage-runtimes">
        <h4 className="text-sm font-semibold text-text-primary-dark">By runtime</h4>
        {runtimeRows.map((r) => (
          <RowLine key={r.key} row={{ ...r, label: RUNTIME_LABELS[r.key] ?? r.label }} testId={`usage-runtime-${r.key}`} sub={`${compactTokens(r.cachedInput)} cached input`} />
        ))}
      </section>

      <section data-testid="usage-workitems">
        <h4 className="text-sm font-semibold text-text-primary-dark">Top work items</h4>
        {workItemRows.length === 0 && <p className="text-sm text-text-secondary-dark">No work item usage in this period.</p>}
        {workItemRows.map((r) => (
          <RowLine
            key={r.key}
            row={r}
            to={r.link}
            testId={`usage-workitem-${r.key}`}
            sub={[r.meta?.agent, r.meta?.team, r.meta?.status].filter((x): x is string => typeof x === 'string').join(' · ')}
          />
        ))}
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-text-primary-dark">Daily caps</h4>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <FormLabel htmlFor="usage-default-cap">Per agent (tokens)</FormLabel>
            <FormInput id="usage-default-cap" placeholder="Off" value={defaultCap} onChange={(e) => setDefaultCap(e.target.value)} />
            <p className="mt-1 text-xs text-text-secondary-dark" data-testid="usage-suggestion">
              {caps.suggestedAgentCapTokens !== null
                ? `Suggested: ${compactTokens(caps.suggestedAgentCapTokens)} (90% of agent-days used less).`
                : 'No usage yet to suggest a cap from.'}{' '}
              Empty = off.
            </p>
          </div>
          <div>
            <FormLabel htmlFor="usage-total-cap">All agents together (tokens)</FormLabel>
            <FormInput id="usage-total-cap" placeholder="Off" value={totalCap} onChange={(e) => setTotalCap(e.target.value)} />
            <p className="mt-1 text-xs text-text-secondary-dark">Optional. When reached, every agent stops until midnight.</p>
          </div>
        </div>
        <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
          Save caps
        </Button>
        <p className="text-xs text-text-secondary-dark">
          Amounts like <code>5M</code> or <code>500k</code>. At 80% of a cap you get one heads-up; at 100% the agent finishes its current turn and starts no new one until
          midnight, and its messages wait. Boosts end at midnight. From Slack, DM the orc: <code>boost CE by 20M today</code> or <code>unlimited today for everyone</code>.
        </p>
      </section>
    </div>
  );
};

export default UsagePanel;
