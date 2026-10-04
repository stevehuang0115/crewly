/**
 * AutopilotTab — the project page's Autopilot tab
 * (specs/2026-10-03-autopilot-experiments.md §2).
 *
 * One headline sentence, the speed selector (Rush / Normal / Chill,
 * specs/2026-10-04-autopilot-speed-modes.md) with why it stopped and the
 * lead's latest self-review, a small per-day bar chart of shipped tickets, the
 * top stall causes, and the runs (each day's run trace and its ticket
 * traces) linking to their timelines. `@crewly/ui` + tokens only; works at
 * 390px (2-column numbers, wrapping rows, the chart scrolls inside its card).
 *
 * @module components/ProjectDetail/AutopilotTab
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CompactRow, EmptyState, FilterPillGroup, ShowAll, StatusLabel, type StatusTone } from '@crewly/ui';
import { Bot } from 'lucide-react';
import { LINKS } from '../../constants/routes.constants';
import {
  getAutopilotRuns,
  getAutopilotStats,
  getAutopilotStatus,
  setAutopilotSpeedMode,
  type AutopilotDayStats,
  type AutopilotRunDay,
  type AutopilotSpeedMode,
  type AutopilotStallCause,
  type AutopilotStats,
  type AutopilotStatus,
} from '../../services/autopilot.service';
import { formatDuration, formatTokenCount, formatUsd, STALL_CAUSE_LABELS } from '../TraceTimeline/traceFormat';

export interface AutopilotTabProps {
  projectId: string;
}

/** Ranges offered (days). */
export const AUTOPILOT_RANGES = ['7', '14', '30'] as const;
type Range = (typeof AUTOPILOT_RANGES)[number];

/** Speed modes offered, fastest first. */
export const SPEED_MODE_OPTIONS: ReadonlyArray<{ key: AutopilotSpeedMode; label: string }> = [
  { key: 'rush', label: 'Rush' },
  { key: 'normal', label: 'Normal' },
  { key: 'chill', label: 'Chill' },
];

/** What each speed does, one line. */
export const SPEED_MODE_HINTS: Readonly<Record<AutopilotSpeedMode, string>> = {
  rush: 'Replans whenever the queue runs dry (≥ 1 h apart, ≤ 12 a day), self-review hourly, retries an empty replan after 1 h.',
  normal: 'Replans when the queue runs dry (≥ 3 h apart, ≤ 4 a day), self-review daily, retries an empty replan the next day.',
  chill: 'At most 1 replan a day, self-review weekly, retries an empty replan the next week.',
};

/** The cost warning under Rush. */
export const RUSH_WARNING = 'Rush keeps the team busy all day and can use the whole daily budget every day; the budget brake still stops it.';

/**
 * The stop line ("Stopped: waiting on you since 14:05"), or null while it runs.
 *
 * @param s - Status
 * @returns Line or null
 */
export function stopLine(s: AutopilotStatus | null): string | null {
  if (!s?.stopReason || !s.stopReasonText) return null;
  const since = s.stoppedSince ? new Date(s.stoppedSince).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  return `Stopped: ${s.stopReasonText}${since ? ` (since ${since})` : ''}`;
}

/** "All tickets" in the label filter. */
const ALL = '__all__';

/**
 * The headline sentence.
 *
 * @param s - Stats
 * @param days - Range in days
 * @returns e.g. "Last 14 days: 9 tickets shipped · 1.2 owner touches per ticket · $3.10 per shipped ticket"
 */
export function headline(s: AutopilotStats, days: number): string {
  const t = s.total;
  const parts = [`${t.verified} ticket${t.verified === 1 ? '' : 's'} shipped`];
  if (t.verified > 0) {
    parts.push(`${Math.round((t.ownerTouches.total / t.verified) * 10) / 10} owner touches per ticket`);
    parts.push(`${formatUsd(t.costUsd / t.verified)} per shipped ticket`);
  } else {
    parts.push(`${t.started} started`);
  }
  return `Last ${days} days${s.label ? ` (${s.label})` : ''}: ${parts.join(' · ')}`;
}

/**
 * Status of the autopilot.
 *
 * @param s - Stats
 * @returns Label and tone
 */
export function autopilotState(s: AutopilotStats): { label: string; tone: StatusTone } {
  if (!s.settings.enabled) return { label: 'Off', tone: 'neutral' };
  if (s.pausedForToday) return { label: 'Paused on budget today', tone: 'attention' };
  return { label: 'On', tone: 'success' };
}

/**
 * The top stall causes, longest first.
 *
 * @param s - Stats
 * @param max - How many
 * @returns Causes with count and time
 */
export function topStallCauses(s: AutopilotStats, max = 3): Array<{ cause: AutopilotStallCause; count: number; ms: number }> {
  return (Object.entries(s.total.stalls.byCause) as Array<[AutopilotStallCause, { count: number; ms: number }]>)
    .filter(([, v]) => v.count > 0)
    .sort((a, b) => b[1].ms - a[1].ms || b[1].count - a[1].count)
    .slice(0, max)
    .map(([cause, v]) => ({ cause, count: v.count, ms: v.ms }));
}

/**
 * A day as "Oct 3".
 *
 * @param day - YYYY-MM-DD
 * @returns Short date
 */
function shortDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The hover text of a day's bar.
 *
 * @param d - Day stats
 * @returns One line
 */
export function dayTitle(d: AutopilotDayStats): string {
  return `${shortDay(d.day)}: ${d.verified} shipped, ${d.started} started, ${d.done} done, ${d.sentBack} sent back, ${formatUsd(d.costUsd)}${d.pausedMs > 0 ? `, paused ${formatDuration(d.pausedMs)}` : ''}`;
}

/** The per-day bar chart: shipped tickets, one thin bar per day. */
const DayBars: React.FC<{ days: AutopilotDayStats[] }> = ({ days }) => {
  const max = Math.max(1, ...days.map((d) => d.verified));
  return (
    <div className="overflow-x-auto" data-testid="autopilot-day-bars">
      <div className="flex items-end gap-[2px] h-24 min-w-full" role="img" aria-label="Tickets shipped per day">
        {days.map((d) => (
          <div key={d.day} className="flex flex-1 min-w-[10px] h-full flex-col justify-end" title={dayTitle(d)} data-testid={`autopilot-bar-${d.day}`}>
            <div
              className={d.verified > 0 ? 'bg-primary rounded-t' : 'bg-muted-dot rounded-t'}
              style={{ height: d.verified > 0 ? `${Math.max(8, (d.verified / max) * 100)}%` : '2px' }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-text-3">
        <span>{days[0] ? shortDay(days[0].day) : ''}</span>
        <span>{days.length ? shortDay(days[days.length - 1].day) : ''}</span>
      </div>
    </div>
  );
};

/** One number. */
const Num: React.FC<{ label: string; value: string; attention?: boolean }> = ({ label, value, attention }) => (
  <div className="min-w-0">
    <div className={`text-lg font-semibold ${attention ? 'text-attention' : 'text-text'}`}>{value}</div>
    <div className="text-xs text-text-3 truncate">{label}</div>
  </div>
);

/**
 * Autopilot tab body.
 *
 * @param props - {@link AutopilotTabProps}
 * @returns The tab content
 */
export const AutopilotTab: React.FC<AutopilotTabProps> = ({ projectId }) => {
  const [range, setRange] = useState<Range>('14');
  const [label, setLabel] = useState<string>(ALL);
  const [stats, setStats] = useState<AutopilotStats | null>(null);
  const [runs, setRuns] = useState<AutopilotRunDay[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<AutopilotStatus | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);
  const [savingMode, setSavingMode] = useState(false);

  // Status (speed, stop reason, self-review) is owner-only and optional:
  // a failure leaves the numbers on the page.
  useEffect(() => {
    let cancelled = false;
    getAutopilotStatus(projectId)
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const changeMode = (mode: AutopilotSpeedMode): void => {
    if (savingMode || status?.speedMode === mode) return;
    setSavingMode(true);
    setModeError(null);
    setAutopilotSpeedMode(projectId, mode)
      .then((s) => setStatus(s))
      .catch((err: unknown) => setModeError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSavingMode(false));
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const days = Number(range);
    const l = label === ALL ? null : label;
    void Promise.all([getAutopilotStats(projectId, days, l), getAutopilotRuns(projectId, days, l)])
      .then(([s, r]) => {
        if (cancelled) return;
        setStats(s);
        setRuns(r);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, range, label]);

  const labelOptions = useMemo(
    () => [{ key: ALL, label: 'All tickets' }, ...(stats?.labels ?? []).map((l) => ({ key: l, label: l }))],
    [stats?.labels],
  );

  if (error) return <EmptyState icon={Bot} title="Autopilot numbers are not available" description={error} />;
  if (!stats) return loading ? <div className="p-4 text-sm text-text-3">Loading…</div> : null;

  const days = Number(range);
  const active = runs.filter((r) => r.runTraceId || r.traces.length > 0);
  const t = stats.total;
  if (!stats.settings.enabled && active.length === 0) {
    return (
      <EmptyState
        icon={Bot}
        title="Autopilot is off"
        description="When the ticket autopilot drives this project, its daily runs, what shipped and where it stalled show here."
      />
    );
  }
  const state = autopilotState(stats);
  const causes = topStallCauses(stats);

  return (
    <div className="flex flex-col gap-4 pb-6" data-testid="autopilot-tab">
      <section className="rounded-[var(--crewly-radius)] border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusLabel tone={state.tone}>{state.label}</StatusLabel>
          <h2 className="text-[15px] font-semibold text-text min-w-0" data-testid="autopilot-headline">
            {headline(stats, days)}
          </h2>
        </div>
        {status && (
          <div className="mt-3 flex flex-col gap-1" data-testid="autopilot-speed">
            <FilterPillGroup
              label="Speed"
              options={SPEED_MODE_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
              value={status.speedMode}
              onChange={(v) => changeMode(v as AutopilotSpeedMode)}
              testIdPrefix="autopilot-speed"
            />
            <p className="text-xs text-text-3">{SPEED_MODE_HINTS[status.speedMode]}</p>
            {status.speedMode === 'rush' && (
              <p className="text-xs text-attention" data-testid="autopilot-rush-warning">
                {RUSH_WARNING}
              </p>
            )}
            {modeError && <p className="text-xs text-attention">{modeError}</p>}
            {stopLine(status) && (
              <p className="text-sm text-attention" data-testid="autopilot-stop">
                {stopLine(status)}
              </p>
            )}
            {status.lastSelfReview && (
              <p className="text-sm text-text-2 break-words" data-testid="autopilot-self-review">
                Self-review: {status.lastSelfReview.gap} · next bet: {status.lastSelfReview.nextBet}
              </p>
            )}
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-3">
          <FilterPillGroup label="Range" options={AUTOPILOT_RANGES.map((r) => ({ key: r, label: `${r} days` }))} value={range} onChange={(v) => setRange(v)} testIdPrefix="autopilot-range" />
          {labelOptions.length > 1 && <FilterPillGroup label="Label" options={labelOptions} value={label} onChange={setLabel} testIdPrefix="autopilot-label" />}
        </div>
      </section>

      <section className="rounded-[var(--crewly-radius)] border border-border bg-surface p-4">
        <h3 className="mb-2 text-[13px] font-semibold text-text-2">Shipped per day</h3>
        <DayBars days={stats.days} />
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Num label="Started" value={String(t.started)} />
          <Num label="Sent back" value={String(t.sentBack)} attention={t.sentBack > 0} />
          <Num label="Your touches" value={String(t.ownerTouches.total)} />
          <Num label="Cycle time (median)" value={t.cycleTime.toVerified.medianMs === null ? '—' : formatDuration(t.cycleTime.toVerified.medianMs)} />
          <Num label="Harness interventions" value={String(t.interventions.total)} />
          <Num label="Cost" value={formatUsd(t.costUsd)} />
          <Num label="Team tokens / budget" value={`${formatTokenCount(t.budget.ledgerTokens)} / ${formatTokenCount(t.budget.dailyBudgetTokens)}`} attention={t.budget.pct >= 1} />
          <Num label="Paused on budget" value={t.pausedMs > 0 ? formatDuration(t.pausedMs) : '—'} attention={t.pausedMs > 0} />
        </div>
      </section>

      <section className="rounded-[var(--crewly-radius)] border border-border bg-surface p-4" data-testid="autopilot-stalls">
        <h3 className="mb-2 text-[13px] font-semibold text-text-2">Where it stalled</h3>
        {causes.length === 0 ? (
          <p className="text-sm text-text-3">No stalls in this range.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {causes.map((c) => (
              <li key={c.cause} className="flex flex-wrap justify-between gap-2 text-sm">
                <span className="text-text">{STALL_CAUSE_LABELS[c.cause]}</span>
                <span className="text-text-3">
                  {c.count} × · {formatDuration(c.ms)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-[var(--crewly-radius)] border border-border bg-surface p-2" data-testid="autopilot-runs">
        <h3 className="px-2 pb-1 pt-2 text-[13px] font-semibold text-text-2">Runs</h3>
        {active.length === 0 ? (
          <p className="px-2 pb-2 text-sm text-text-3">No autopilot runs in this range.</p>
        ) : (
          <ShowAll limit={5} total={active.length}>
            {active.map((r) => {
              const d = stats.days.find((x) => x.day === r.day);
              return (
                <div key={r.day} className="flex flex-col">
                  <CompactRow
                    primary={r.runTraceId ? <Link to={LINKS.trace(r.runTraceId)}>{shortDay(r.day)} run</Link> : `${shortDay(r.day)}`}
                    meta={d ? `${d.verified} shipped · ${d.started} started · ${formatUsd(d.costUsd)}${d.pausedMs > 0 ? ` · paused ${formatDuration(d.pausedMs)}` : ''}` : undefined}
                  />
                  {r.traces.length > 0 && (
                    <ShowAll limit={3} total={r.traces.length} as="ul" className="pl-4">
                      {r.traces.map((tr) => (
                        <li key={tr.traceId} className="truncate py-1 text-sm">
                          <Link to={LINKS.trace(tr.traceId)} className="text-text-2 hover:text-text">
                            {tr.summary}
                          </Link>
                          {tr.labels.length > 0 && <span className="ml-2 text-xs text-text-3">{tr.labels.join(', ')}</span>}
                        </li>
                      ))}
                    </ShowAll>
                  )}
                </div>
              );
            })}
          </ShowAll>
        )}
      </section>
    </div>
  );
};
