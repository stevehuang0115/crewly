/**
 * Which persisted agent sessions to bring back after a restart.
 *
 * @module services/agent/restore-filter
 */

import type { WorkItemStatus } from '../../types/v2/work-item.types.js';

/**
 * Statuses in which the target agent itself has something to do. Finished
 * (`verified`, `done`, `failed`, `cancelled`), parked (`scheduled`) and
 * waiting-on-someone-else (`blocked`, `escalated`, `done_by_worker`) items
 * do not need their agent running.
 *
 * Before 2026-09-23 only `done`/`cancelled` counted as finished, so
 * hundreds of `verified` items going back to May kept almost every agent
 * "busy": a restart relaunched 12–13 Claude sessions on a machine already
 * swapping, each paying a registration prompt.
 */
export const RESTORE_ACTIVE_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>([
  'queued',
  'proposed',
  'accepted',
  'running',
  'rejected',
]);

/** Items untouched for longer than this are stale, not work in hand. */
export const RESTORE_MAX_ITEM_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** The fields of a WorkItem the filter reads. */
export interface RestoreWorkItem {
  status: WorkItemStatus | string;
  target?: string;
  updatedAt?: string;
  createdAt?: string;
}

/**
 * Sessions that have work in hand: an active-status item targeting them
 * that was touched recently.
 *
 * @param items - Every WorkItem in the pool
 * @param now - Current time (ms)
 * @returns Session names worth restoring
 */
export function sessionsWithWorkInHand(items: readonly RestoreWorkItem[], now: number = Date.now()): Set<string> {
  const out = new Set<string>();
  for (const wi of items) {
    if (!RESTORE_ACTIVE_STATUSES.has(wi.status as WorkItemStatus)) continue;
    if (typeof wi.target !== 'string' || wi.target.length === 0) continue;
    const touched = Date.parse(wi.updatedAt ?? wi.createdAt ?? '');
    if (Number.isFinite(touched) && now - touched > RESTORE_MAX_ITEM_AGE_MS) continue;
    out.add(wi.target);
  }
  return out;
}
