/**
 * Quality signal for the model-tier guard (crewly#1173).
 *
 * After the owner moves a member to a lower tier, the guard compares how
 * often the member's work is sent back (rejected by its reviewer, failed, or
 * retried) over its next settled work items against the same rate before the
 * change. Pure functions; the service feeds them the task pool.
 *
 * @module services/model-tiers/tier-quality
 */

import { MODEL_TIER_CONSTANTS } from '../../constants.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

/** Work-item statuses that end an item's run (judged or failed). */
const SETTLED = new Set(['done', 'verified', 'rejected', 'failed']);

/** Send-back counts over a set of settled work items. */
export interface QualityStats {
  /** Settled work items counted */
  settled: number;
  /** Of those, sent back: rejected, failed, or retried at least once */
  sentBack: number;
  /** sentBack / settled, or null with nothing settled */
  rate: number | null;
}

/** The guard's verdict on one lowered member. */
export type GuardVerdict = 'wait' | 'ok' | 'worse';

/** The guard thresholds (defaults from MODEL_TIER_CONSTANTS). */
export interface GuardThresholds {
  minItems: number;
  minBad: number;
  margin: number;
}

/** Default thresholds. */
export const DEFAULT_GUARD_THRESHOLDS: GuardThresholds = {
  minItems: MODEL_TIER_CONSTANTS.GUARD_MIN_ITEMS,
  minBad: MODEL_TIER_CONSTANTS.GUARD_MIN_BAD,
  margin: MODEL_TIER_CONSTANTS.GUARD_WORSE_MARGIN,
};

/**
 * When a work item settled.
 *
 * @param wi - Work item
 * @returns Epoch ms
 */
export function settledAtMs(wi: Pick<WorkItem, 'completedAt' | 'statusChangedAt' | 'createdAt'>): number {
  return Date.parse(wi.completedAt ?? wi.statusChangedAt ?? wi.createdAt) || 0;
}

/**
 * Whether a settled item was sent back.
 *
 * @param wi - Work item
 * @returns True for rejected / failed / retried
 */
export function isSentBack(wi: Pick<WorkItem, 'status' | 'retryCount'>): boolean {
  return wi.status === 'rejected' || wi.status === 'failed' || (wi.retryCount ?? 0) > 0;
}

/**
 * The settled work items of a member, oldest first.
 *
 * @param items - All work items
 * @param sessions - The member's session names / agent ids
 * @returns Settled items targeted at the member
 */
export function settledItemsOf(items: readonly WorkItem[], sessions: readonly string[]): WorkItem[] {
  const keys = new Set(sessions.filter(Boolean));
  return items
    .filter((wi) => !!wi.target && keys.has(wi.target) && SETTLED.has(wi.status))
    .sort((a, b) => settledAtMs(a) - settledAtMs(b));
}

/**
 * Send-back counts of a list of items.
 *
 * @param items - Settled items
 * @returns Stats
 */
export function statsOf(items: readonly WorkItem[]): QualityStats {
  const sentBack = items.filter(isSentBack).length;
  return { settled: items.length, sentBack, rate: items.length ? sentBack / items.length : null };
}

/**
 * Baseline before a change: the last `limit` settled items before `atMs`.
 *
 * @param items - All work items
 * @param sessions - The member's keys
 * @param atMs - When the change applied
 * @param limit - How many items
 * @returns Stats
 */
export function baselineBefore(items: readonly WorkItem[], sessions: readonly string[], atMs: number, limit: number = MODEL_TIER_CONSTANTS.GUARD_BASELINE_ITEMS): QualityStats {
  const before = settledItemsOf(items, sessions).filter((wi) => settledAtMs(wi) < atMs);
  return statsOf(before.slice(-limit));
}

/**
 * Stats after a change: every settled item after `atMs`.
 *
 * @param items - All work items
 * @param sessions - The member's keys
 * @param atMs - When the change applied
 * @returns Stats
 */
export function statsAfter(items: readonly WorkItem[], sessions: readonly string[], atMs: number): QualityStats {
  return statsOf(settledItemsOf(items, sessions).filter((wi) => settledAtMs(wi) >= atMs));
}

/**
 * Judge a lowered member: `wait` until enough items settled; `worse` when the
 * send-back rate rose by more than the margin (and enough items were sent
 * back); else `ok`.
 *
 * @param baseline - Before the change
 * @param after - Since the change
 * @param t - Thresholds
 * @returns Verdict
 *
 * @example
 * ```typescript
 * judgeGuard({ settled: 10, sentBack: 1, rate: 0.1 }, { settled: 5, sentBack: 3, rate: 0.6 }); // 'worse'
 * ```
 */
export function judgeGuard(baseline: QualityStats, after: QualityStats, t: GuardThresholds = DEFAULT_GUARD_THRESHOLDS): GuardVerdict {
  if (after.settled < t.minItems || after.rate === null) return 'wait';
  if (after.sentBack >= t.minBad && after.rate > (baseline.rate ?? 0) + t.margin) return 'worse';
  return 'ok';
}

/**
 * "3 of 5 sent back" / "none settled".
 *
 * @param s - Stats
 * @returns Short text
 */
export function describeStats(s: QualityStats): string {
  return s.settled ? `${s.sentBack} of ${s.settled} sent back` : 'none settled';
}
