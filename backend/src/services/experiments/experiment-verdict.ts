/**
 * Experiment windows and verdicts (issue #986).
 *
 * Windows: the baseline is the `windowDays` days that had settled when the
 * change shipped (ending `lag` days before the ship day); the observation
 * window is the `windowDays` days after the ship day (the ship day itself is
 * a partial day and is left out). The result is due once the observation
 * window's last day has settled (`lag` days later).
 *
 * Verdicts use simple rules with a minimum volume:
 * - counts (clicks, impressions, sessions, events): equal-length Poisson
 *   comparison, z = (b − a) / √(a + b), with at least MIN_COUNT_VOLUME events
 *   across both windows;
 * - ctr: two-proportion z-test, with enough impressions in each window and
 *   enough clicks overall;
 * - position: Welch's t on the daily positions, with enough days that had
 *   impressions in each window (lower is better).
 * |z| ≥ SIGNIFICANCE_Z in the hypothesis's direction → worked; enough volume
 * but no such change → didn't; too little volume → inconclusive.
 *
 * specs/experiment-cards.md
 *
 * @module services/experiments/experiment-verdict
 */

import { EXPERIMENT_CONSTANTS } from '../../constants.js';
import type { ExperimentDirection, ExperimentMeasure, ExperimentSource, ExperimentVerdict, Measurement } from '../../types/experiment.types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A date range (inclusive, YYYY-MM-DD). */
export interface DateRange {
  start: string;
  end: string;
}

/** The two windows of an experiment and when it can be measured. */
export interface ExperimentWindows {
  baseline: DateRange;
  observation: DateRange;
  /** ISO time the result can be fetched (observation end + lag, start of the next day UTC) */
  dueAt: string;
}

/** A verdict with its numbers. */
export interface VerdictOutcome {
  verdict: ExperimentVerdict;
  /** One line with the numbers */
  reason: string;
  /** Test statistic (z or Welch t), when there was enough volume to compute it */
  statistic?: number;
  /** Relative change of the headline value (null when the baseline is 0 / unknown) */
  lift?: number | null;
}

/**
 * Format a UTC date as YYYY-MM-DD.
 *
 * @param ms - Epoch millis
 * @returns Day string
 */
function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Midnight UTC of the day an instant falls on.
 *
 * @param iso - ISO time
 * @returns Epoch millis
 * @throws Error on an invalid time
 */
function dayStart(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Invalid time: ${iso}`);
  return Math.floor(t / DAY_MS) * DAY_MS;
}

/**
 * Baseline / observation windows and the due time for a shipped experiment.
 *
 * @param shippedAt - When the change went live (ISO)
 * @param windowDays - Days per window
 * @param source - Metric source (sets the lag)
 * @returns Windows
 *
 * @example
 * ```typescript
 * experimentWindows('2026-10-10T15:00:00Z', 14, 'gsc');
 * // baseline 2026-09-24..2026-10-07, observation 2026-10-11..2026-10-24, due 2026-10-28
 * ```
 */
export function experimentWindows(shippedAt: string, windowDays: number, source: ExperimentSource): ExperimentWindows {
  const ship = dayStart(shippedAt);
  const lag = EXPERIMENT_CONSTANTS.SOURCE_LAG_DAYS[source] ?? 0;
  const baseEnd = ship - lag * DAY_MS;
  const obsStart = ship + DAY_MS;
  const obsEnd = ship + windowDays * DAY_MS;
  return {
    baseline: { start: day(baseEnd - (windowDays - 1) * DAY_MS), end: day(baseEnd) },
    observation: { start: day(obsStart), end: day(obsEnd) },
    dueAt: new Date(obsEnd + (lag + 1) * DAY_MS).toISOString(),
  };
}

/**
 * The direction a hypothesis means when it doesn't say: lower is better for position.
 *
 * @param measure - Measure
 * @returns Default direction
 */
export function defaultDirection(measure: ExperimentMeasure): ExperimentDirection {
  return (EXPERIMENT_CONSTANTS.LOWER_IS_BETTER as readonly string[]).includes(measure) ? 'decrease' : 'increase';
}

/**
 * Format a number for a verdict line.
 *
 * @param v - Value
 * @param measure - Measure (ctr as a percentage, position to one decimal)
 * @returns Text
 */
export function formatValue(v: number | null | undefined, measure: ExperimentMeasure): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  if (measure === 'ctr') return `${(v * 100).toFixed(2)}%`;
  if (measure === 'position') return v.toFixed(1);
  return String(Math.round(v * 100) / 100);
}

/**
 * Relative change.
 *
 * @param from - Baseline
 * @param to - Result
 * @returns (to − from) / from, or null when from is 0 / missing
 */
function liftOf(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined || from === 0) return null;
  return (to - from) / from;
}

/**
 * "+40%" / "−12%" / "".
 *
 * @param lift - Relative change
 * @returns Text with a leading space, or empty
 */
function liftText(lift: number | null): string {
  if (lift === null) return '';
  const pct = Math.round(lift * 1000) / 10;
  return ` (${pct >= 0 ? '+' : ''}${pct}%)`;
}

/**
 * Label from a statistic: worked when it is significant in the hypothesis's direction.
 *
 * @param stat - z or t (positive = the metric rose)
 * @param direction - Hypothesis direction
 * @returns worked / didnt and the wording
 */
function judge(stat: number, direction: ExperimentDirection): { verdict: ExperimentVerdict; words: string } {
  const z = EXPERIMENT_CONSTANTS.SIGNIFICANCE_Z;
  const wanted = direction === 'increase' ? stat >= z : stat <= -z;
  if (wanted) return { verdict: 'worked', words: `a real ${direction}` };
  const wrongWay = direction === 'increase' ? stat <= -z : stat >= z;
  return { verdict: 'didnt', words: wrongWay ? 'it moved the wrong way' : 'no real change' };
}

/**
 * Daily values of the days that had volume.
 *
 * @param m - Measurement
 * @returns Values
 */
function dailyValues(m: Measurement): number[] {
  return m.days.filter((d) => d.volume > 0 && d.value !== null && Number.isFinite(d.value)).map((d) => d.value as number);
}

/**
 * Mean and sample variance.
 *
 * @param xs - Values (at least 2)
 * @returns Mean and variance
 */
function meanVar(xs: number[]): { mean: number; variance: number } {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1);
  return { mean, variance };
}

/**
 * Label a measured experiment.
 *
 * @param measure - What was measured
 * @param direction - Which way the hypothesis says it moves
 * @param baseline - Baseline window
 * @param result - Observation window
 * @returns Verdict, one-line reason and the statistic
 */
export function decideVerdict(
  measure: ExperimentMeasure,
  direction: ExperimentDirection,
  baseline: Measurement,
  result: Measurement,
): VerdictOutcome {
  const C = EXPERIMENT_CONSTANTS;
  if (measure === 'ctr') {
    const n1 = baseline.impressions ?? baseline.volume;
    const n2 = result.impressions ?? result.volume;
    const c1 = baseline.clicks ?? 0;
    const c2 = result.clicks ?? 0;
    const head = `CTR ${formatValue(n1 ? c1 / n1 : null, measure)} → ${formatValue(n2 ? c2 / n2 : null, measure)}`;
    const lift = liftOf(n1 ? c1 / n1 : null, n2 ? c2 / n2 : null);
    if (n1 < C.MIN_IMPRESSIONS_PER_WINDOW || n2 < C.MIN_IMPRESSIONS_PER_WINDOW || c1 + c2 < C.MIN_CTR_CLICKS) {
      return {
        verdict: 'inconclusive',
        reason: `${head}: too little data (${n1} / ${n2} impressions, ${c1 + c2} clicks; need ${C.MIN_IMPRESSIONS_PER_WINDOW} impressions per window and ${C.MIN_CTR_CLICKS} clicks)`,
        lift,
      };
    }
    const p = (c1 + c2) / (n1 + n2);
    const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    const stat = se > 0 ? (c2 / n2 - c1 / n1) / se : 0;
    const j = judge(stat, direction);
    return { verdict: j.verdict, reason: `${head}${liftText(lift)}, z = ${stat.toFixed(2)}: ${j.words}`, statistic: stat, lift };
  }

  if (measure === 'position') {
    const a = dailyValues(baseline);
    const b = dailyValues(result);
    const head = `Average position ${formatValue(baseline.total, measure)} → ${formatValue(result.total, measure)}`;
    const lift = liftOf(baseline.total, result.total);
    const imps1 = baseline.impressions ?? baseline.volume;
    const imps2 = result.impressions ?? result.volume;
    if (a.length < C.MIN_POSITION_DAYS || b.length < C.MIN_POSITION_DAYS || imps1 < C.MIN_IMPRESSIONS_PER_WINDOW || imps2 < C.MIN_IMPRESSIONS_PER_WINDOW) {
      return {
        verdict: 'inconclusive',
        reason: `${head}: too little data (${a.length} / ${b.length} days with impressions, ${imps1} / ${imps2} impressions; need ${C.MIN_POSITION_DAYS} days and ${C.MIN_IMPRESSIONS_PER_WINDOW} impressions per window)`,
        lift,
      };
    }
    const s1 = meanVar(a);
    const s2 = meanVar(b);
    const se = Math.sqrt(s1.variance / a.length + s2.variance / b.length);
    const diff = s2.mean - s1.mean;
    const stat = se > 0 ? diff / se : diff === 0 ? 0 : Math.sign(diff) * Infinity;
    const j = judge(stat, direction);
    const statText = Number.isFinite(stat) ? stat.toFixed(2) : stat > 0 ? '∞' : '−∞';
    return { verdict: j.verdict, reason: `${head}, t = ${statText}: ${j.words}`, statistic: stat, lift };
  }

  // Counts: clicks, impressions, sessions, events.
  const a = baseline.total ?? 0;
  const b = result.total ?? 0;
  const min = C.MIN_COUNT_VOLUME[measure] ?? 0;
  const head = `${measure} ${formatValue(a, measure)} → ${formatValue(b, measure)}`;
  const lift = liftOf(a, b);
  if (a + b < min) {
    return { verdict: 'inconclusive', reason: `${head}: too little data (${a + b} across both windows; need ${min})`, lift };
  }
  const stat = (b - a) / Math.sqrt(a + b);
  const j = judge(stat, direction);
  return { verdict: j.verdict, reason: `${head}${liftText(lift)}, z = ${stat.toFixed(2)}: ${j.words}`, statistic: stat, lift };
}
