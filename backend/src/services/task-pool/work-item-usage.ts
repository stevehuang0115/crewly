/**
 * Per-WorkItem token usage and cost (#812).
 *
 * A WorkItem's `inputTokens` / `outputTokens` / `cost` describe what that one
 * task spent. The agent session's totals are cumulative across every task the
 * session ever ran, so copying them onto a WorkItem charged the whole history
 * to whichever item finished next (a morning briefing "cost" $576).
 *
 * The task's usage is the session's usage between the moment the item started
 * running and the moment it completed — the delta between the cumulative
 * figures at those two points.
 */

import type { WorkItem } from '../../types/v2/work-item.types.js';

/** Token usage and cost attributed to one WorkItem. */
export interface WorkItemUsage {
  /** Input tokens the session consumed while the item ran */
  inputTokens: number;
  /** Output tokens the session generated while the item ran */
  outputTokens: number;
  /** Cost in USD of that usage */
  cost: number;
}

/** The slice of TokenUsageService this helper needs (windowed session usage). */
export interface SessionUsageWindowSource {
  getSessionUsageSince(
    sessionName: string,
    since: Date,
    until?: Date,
  ): { inputTokens: number; outputTokens: number; cost: number };
}

/**
 * Compute the token usage and cost of one WorkItem: the session's usage from
 * when the item started running (`startedAt`, falling back to `createdAt` for
 * items completed without a claim) to when it completed (`completedAt`,
 * falling back to `now`).
 *
 * @param item - The WorkItem (only its timestamps are read)
 * @param sessionName - The agent session that ran it
 * @param source - Windowed usage source (TokenUsageService)
 * @param now - End of the window when the item has no `completedAt`
 * @returns The per-task usage, or null when the window is unusable
 */
export function computeWorkItemUsage(
  item: Pick<WorkItem, 'createdAt' | 'startedAt' | 'completedAt'>,
  sessionName: string,
  source: SessionUsageWindowSource,
  now: Date = new Date(),
): WorkItemUsage | null {
  const start = new Date(item.startedAt ?? item.createdAt);
  const end = item.completedAt ? new Date(item.completedAt) : now;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;
  const usage = source.getSessionUsageSince(sessionName, start, end);
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cost: usage.cost,
  };
}
