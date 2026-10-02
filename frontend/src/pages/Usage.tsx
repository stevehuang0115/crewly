/**
 * Usage Page (`/usage`)
 *
 * Tokens used by every agent on every runtime, and the daily caps that keep
 * them in check (specs/2026-10-02-ui-redesign.md, simple/Usage artboard).
 * The page's one job: "how much are we using today, and is anything capped?"
 *
 * - Headline "X of Y today" with a thin bar against the all-agents cap, and a
 *   Today / 7 days / 30 days switch.
 * - Top agents and teams as bars (five each, then "Show all").
 * - Caps & boosts, collapsed, with "Boost a team" beside it.
 * - Runtime and work-item breakdowns behind "Details".
 *
 * Replaces the former $ cost dashboard (`/monitoring/costs` redirects here)
 * and the usage panel that sat in Settings › System. Data:
 * `/api/system/usage`, `/api/system/usage/caps`, `/api/system/usage/boost`.
 *
 * @module pages/Usage
 */

import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Alert, Button, IconButton, LoadingSpinner, PageHeader, SegmentedControl } from '@crewly/ui';
import { compactTokens, type CapsView, type UsageRow, type UsageStats } from '../services/usage.service';
import { USAGE_PERIODS, useUsage, type UsagePeriod } from '../hooks/useUsage';
import { UsageBarList, type UsageBar } from '../components/Usage/UsageBarList';
import { CapsBoostsSection } from '../components/Usage/CapsBoostsSection';
import { UsageDetails } from '../components/Usage/UsageDetails';
import { runtimeLabel } from '../components/Usage/usage.utils';

/** Headline, sub-line and the bar against the daily cap. */
export interface UsageHeadline {
  headline: string;
  subline: string;
  /** 0..100 when today is shown against a cap, else null */
  pct: number | null;
}

/**
 * Headline text for a period.
 *
 * @param period - Selected period
 * @param stats - Stats
 * @param caps - Caps view
 * @returns {@link UsageHeadline}
 */
export function usageHeadline(period: UsagePeriod, stats: UsageStats, caps: CapsView): UsageHeadline {
  const today = compactTokens(stats.todayTotals.total);
  const cap = caps.totalCapTodayTokens;
  const pct = cap !== null && cap > 0 ? Math.min(100, Math.round((stats.todayTotals.total / cap) * 100)) : null;
  if (period === '1') {
    if (cap === null) return { headline: `${today} today`, subline: 'No daily cap set.', pct: null };
    return {
      headline: `${today} of ${compactTokens(cap)} today`,
      subline: (pct ?? 0) >= 80 ? 'Close to the daily cap. Agents pause new turns at 100% until midnight.' : 'Resets at midnight.',
      pct,
    };
  }
  return {
    headline: `${compactTokens(stats.totals.total)} in the last ${period} days`,
    subline: `Today so far: ${today}${cap !== null ? ` of ${compactTokens(cap)}` : ''}`,
    pct: null,
  };
}

/**
 * Hover text of a bar: the token split.
 *
 * @param r - Stats row
 * @returns e.g. "40M input (20M cached) · 1M output · 12 turns"
 */
export function tokenSplit(r: Pick<UsageRow, 'input' | 'cachedInput' | 'output' | 'events'>): string {
  return `${compactTokens(r.input)} input (${compactTokens(r.cachedInput)} cached) · ${compactTokens(r.output)} output · ${r.events.toLocaleString('en-US')} turns`;
}

/**
 * Agent bars: team and runtimes as the quiet label; stopped agents flagged.
 *
 * @param stats - Stats
 * @param caps - Caps view
 * @returns Bars
 */
export function agentBars(stats: UsageStats, caps: CapsView): UsageBar[] {
  return (stats.groups.agent ?? []).map((r) => {
    const a = caps.agents.find((x) => x.session === r.key);
    const runtimes = Array.isArray(r.meta?.runtimes) ? (r.meta?.runtimes as string[]).map(runtimeLabel).join(', ') : '';
    const team = typeof r.meta?.team === 'string' ? r.meta.team : '';
    return {
      key: r.key,
      name: r.label,
      sub: [team, runtimes].filter(Boolean).join(' · '),
      alert: a?.stopped ? (a.stopReason ?? 'Stopped until midnight') : undefined,
      total: r.total,
      detail: tokenSplit(r),
    };
  });
}

/**
 * Team bars: cap as the quiet label when one is set; stopped teams flagged.
 *
 * @param stats - Stats
 * @param caps - Caps view
 * @returns Bars
 */
export function teamBars(stats: UsageStats, caps: CapsView): UsageBar[] {
  return (stats.groups.team ?? []).map((r) => {
    const t = caps.teams.find((x) => x.teamId === r.key);
    const capped = t && (t.baseCapTokens !== null || t.unlimited || t.extraTokens > 0);
    return {
      key: r.key,
      name: t?.name ?? r.label,
      sub: capped && t ? `${compactTokens(t.todayTokens)} today · ${t.unlimited ? 'unlimited today' : `${compactTokens(t.capTokens ?? 0)} cap`}` : '',
      alert: t?.stopped ? 'Stopped until midnight' : undefined,
      total: r.total,
      detail: tokenSplit(r),
    };
  });
}

/**
 * Usage page.
 *
 * @returns Page
 */
export const Usage: React.FC = () => {
  const [period, setPeriod] = useState<UsagePeriod>('1');
  const [capsOpen, setCapsOpen] = useState(false);
  const [perOpen, setPerOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { stats, caps, error, note, busy, reload, boost, endBoost, saveCaps } = useUsage(period);

  const header = (
    <PageHeader
      title="Usage"
      actions={
        <div className="flex items-center gap-2">
          <SegmentedControl<UsagePeriod>
            aria-label="Range"
            size="sm"
            value={period}
            onChange={setPeriod}
            options={USAGE_PERIODS.map((p) => ({ value: p.key, label: p.label, 'data-testid': `usage-period-${p.key}` }))}
          />
          <IconButton icon={RefreshCw} aria-label="Refresh" title="Refresh" onClick={() => void reload()} />
        </div>
      }
    />
  );

  if (!stats || !caps) {
    return (
      <div className="mx-auto max-w-[960px]" data-testid="usage-page">
        {header}
        {error ? (
          <Alert variant="error" size="sm">
            {error}{' '}
            <Button variant="link" size="xs" onClick={() => void reload()}>
              Retry
            </Button>
          </Alert>
        ) : (
          <LoadingSpinner centered text="Loading usage…" />
        )}
      </div>
    );
  }

  const head = usageHeadline(period, stats, caps);
  const agents = agentBars(stats, caps);
  const teams = teamBars(stats, caps);

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-8" data-testid="usage-page">
      {header}

      {caps.totalStopped && caps.totalCapTodayTokens !== null && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-attention-soft px-4 py-3 text-sm text-text" role="alert" data-testid="usage-total-stopped">
          <span className="min-w-0 flex-1">
            All agents together hit the daily cap ({compactTokens(caps.totalCapTodayTokens)}). Every agent is stopped until midnight.
          </span>
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void boost({ scope: 'all', unlimited: true }, 'Everyone')}>
            Unlimited today
          </Button>
        </div>
      )}
      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}
      {note && (
        <p className="-my-4 text-[13px] text-success" role="status" data-testid="usage-note">
          {note}
        </p>
      )}

      <section aria-label="Total" className="flex flex-col gap-3">
        <p className="text-[32px] font-extrabold leading-10 tracking-tight text-text" data-testid="usage-headline">
          {head.headline}
        </p>
        {head.pct !== null && (
          <div
            role="meter"
            aria-label="Today against the daily cap"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={head.pct}
            className="h-1.5 rounded-full bg-surface-2"
            data-testid="usage-meter"
          >
            <div className={`h-1.5 rounded-full ${head.pct >= 80 ? 'bg-attention' : 'bg-primary'}`} style={{ width: `${head.pct}%` }} />
          </div>
        )}
        <p className="text-[13px] text-text-2" data-testid="usage-subline">
          {head.subline}
        </p>
      </section>

      <div className="grid grid-cols-1 items-start gap-8 md:grid-cols-2 md:gap-12">
        <UsageBarList title="Top agents" rows={agents} testIdPrefix="usage-agent" />
        <UsageBarList title="Teams" rows={teams} testIdPrefix="usage-team" />
      </div>

      <div className="flex flex-col">
        <CapsBoostsSection
          caps={caps}
          teamRows={stats.groups.team ?? []}
          busy={busy}
          onBoost={boost}
          onEndBoost={endBoost}
          onSaveCaps={saveCaps}
          open={capsOpen}
          onOpenChange={setCapsOpen}
          perOpen={perOpen}
          onPerOpenChange={setPerOpen}
        />
        <UsageDetails stats={stats} open={detailsOpen} onOpenChange={setDetailsOpen} />
      </div>
    </div>
  );
};

export default Usage;
