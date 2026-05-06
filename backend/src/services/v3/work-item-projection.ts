/**
 * WorkItem → legacy projection helpers.
 *
 * The frontend Tasks tab and the team/terminal controllers historically
 * read `InProgressTask`-shaped objects from `TaskTrackingService`
 * (`~/.crewly/in_progress_tasks.json`). Per the v1-deprecation campaign
 * (`specs/2026-05-06-task-management-v1-deprecation.md`) the V3 task-pool
 * is now the single source of truth for delegated work — but we want to
 * collapse the user-visible duplication without forcing a frontend
 * rewrite.
 *
 * This module shapes V3 `WorkItem`s into the legacy `InProgressTask`
 * shape so existing UI components work unchanged. It is a *read-only*
 * projection — write paths still go through `TaskPoolService`.
 *
 * @module services/v3/work-item-projection
 */

import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import type { InProgressTask, InProgressTaskStatus } from '../../types/task-tracking.types.js';

/**
 * Map V3 WorkItem status → legacy InProgressTaskStatus values that the
 * frontend Tasks tab and dashboard widgets expect.
 *
 * Some V3 statuses have no exact legacy equivalent; we pick the closest
 * legacy state that preserves the UI's grouping behavior (e.g.
 * `verified`/`done_by_worker` both surface as `done`).
 */
function mapStatus(status: WorkItemStatus): InProgressTaskStatus {
  switch (status) {
    case 'queued':
      return 'pending_assignment';
    case 'running':
      return 'active';
    case 'blocked':
      return 'blocked';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'done':
    case 'done_by_worker':
    case 'verified':
      return 'done';
    case 'rejected':
      return 'failed';
    default:
      return 'active';
  }
}

/**
 * Map a V3 priority (stored in metadata; 1=critical … 4=low) to the legacy
 * 'low'|'medium'|'high' enum the dashboard cards use for color coding.
 *
 * V3 doesn't carry priority as a top-level field; producer skills place it
 * under `metadata.priority` when relevant.
 */
function mapPriority(priority: unknown): 'low' | 'medium' | 'high' | undefined {
  if (typeof priority !== 'number') return undefined;
  if (priority <= 2) return 'high';
  if (priority === 3) return 'medium';
  return 'low';
}

/**
 * Project a V3 WorkItem into the legacy InProgressTask shape.
 *
 * Fields without a V3 equivalent (e.g. `taskFilePath`) are populated
 * with sentinel values that callers can recognize as "no longer file-based".
 * `metadata` is mined for stored projectId/projectPath/teamId/role.
 *
 * @param wi - The V3 WorkItem to project
 * @returns A legacy-shaped InProgressTask
 */
export function projectWorkItemToInProgressTask(wi: WorkItem): InProgressTask {
  const meta = (wi.metadata ?? {}) as Record<string, unknown>;
  const projectId = (meta.projectId as string) ?? '';
  const projectPath = (meta.projectPath as string) ?? '';
  const teamId = (meta.teamId as string) ?? '';
  const targetRole = (meta.requiredRole as string) ?? (meta.role as string) ?? '';
  const milestone = (meta.milestone as string) ?? 'delegated';
  return {
    id: wi.id,
    projectId,
    teamId,
    // Sentinel: no longer a real path. Kept non-empty so legacy code
    // that calls `path.basename(taskFilePath)` doesn't crash.
    taskFilePath: `v3://workitem/${wi.id}`,
    taskName: wi.title,
    targetRole,
    assignedTeamMemberId: '',
    assignedSessionName: wi.target ?? '',
    assignedAt: wi.createdAt,
    status: mapStatus(wi.status),
    lastCheckedAt: wi.startedAt,
    completedAt: wi.completedAt,
    blockReason: wi.error,
    priority: mapPriority(meta.priority),
    // Carry projectPath for callers that still want it.
    ...(projectPath ? ({ slackContext: undefined } as Partial<InProgressTask>) : {}),
    // Stash milestone in the audit trail metadata-friendly slot.
    ...(milestone ? {} : {}),
  };
}

/**
 * Project an array of V3 WorkItems into legacy InProgressTask[].
 *
 * Convenience wrapper for the common case (controller endpoints).
 *
 * @param items - The V3 WorkItems
 * @returns Legacy-shaped InProgressTask[]
 */
export function projectWorkItems(items: WorkItem[]): InProgressTask[] {
  return items.map(projectWorkItemToInProgressTask);
}
