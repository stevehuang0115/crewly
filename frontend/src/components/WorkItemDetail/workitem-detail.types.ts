/**
 * WorkItem Detail Types — V3
 *
 * Type definitions for the WorkItem Detail page, mirroring
 * backend V2 WorkItem types for the frontend.
 *
 * @module components/WorkItemDetail/workitem-detail.types
 */

import type { StatusType } from '../UI/StatusBadge';
import type { BadgeVariant } from '../UI/Badge';

// =============================================================================
// WorkItem Core Types (mirrors backend/src/types/v2/work-item.types.ts)
// =============================================================================

/** Execution type — determines handler and behavior. */
export type WorkItemType =
  | 'delegate'
  | 'project_task'
  | 'check'
  | 'notify'
  | 'cron_run'
  | 'review'
  | 'confirm'
  | 'reconcile';

/** Who is responsible for execution. */
export type WorkItemOwner =
  | 'orchestrator'
  | 'team_lead'
  | 'agent'
  | 'system';

/** Lifecycle statuses for a WorkItem. */
export type WorkItemStatus =
  | 'queued'
  | 'scheduled'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';

/**
 * A single unit of system execution (frontend representation).
 */
export interface WorkItem {
  /** UUID v4 */
  id: string;
  /** Parent Request (undefined for Mission-generated items) */
  requestId?: string;
  /** Parent WorkItem for sub-tasks / retries */
  parentWorkItemId?: string;
  /** Execution type — determines handler and behavior */
  type: WorkItemType;
  /** Who is responsible for execution */
  owner: WorkItemOwner;
  /** Target agent session, team, or system component */
  target?: string;
  /** Human-readable title */
  title: string;
  /** Detailed instructions or description */
  description?: string;
  /** Lifecycle status */
  status: WorkItemStatus;
  /** When this item should execute (null = immediately) */
  scheduledAt?: string;
  /** ISO8601 timestamps */
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Execution result data */
  result?: Record<string, unknown>;
  /** Error details if failed */
  error?: string;
  /** Number of retry attempts so far */
  retryCount: number;
  /** Maximum retries before permanent failure */
  maxRetries: number;
  /** Trigger ID that created or will wake this WorkItem */
  triggerId?: string;
  /** Link to ProjectTask (for durable project work) */
  projectTaskId?: string;
  /** Link to Mission (for autonomy-generated work) */
  missionId?: string;
  /** Token usage for this specific WorkItem */
  inputTokens: number;
  outputTokens: number;
  /** Cost in USD for this WorkItem */
  cost: number;
}

// =============================================================================
// Timeline Event Types
// =============================================================================

/** Type of timeline event for display purposes */
export type TimelineEventKind =
  | 'status_change'
  | 'agent_reasoning'
  | 'tool_action'
  | 'error'
  | 'progress_update';

/**
 * A single event in the WorkItem's activity timeline.
 * Synthesized from WorkItem status changes and result data.
 */
export interface TimelineEvent {
  /** Unique key for rendering */
  id: string;
  /** Type of event */
  kind: TimelineEventKind;
  /** Display label */
  label: string;
  /** Detailed description or output */
  detail?: string;
  /** ISO8601 timestamp */
  timestamp: string;
  /** Associated status (if status change) */
  status?: WorkItemStatus;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Maps a WorkItem status to a StatusBadge-compatible StatusType.
 *
 * @param status - The WorkItem status
 * @returns StatusType for the UI StatusBadge component
 */
export function getWorkItemStatusType(status: WorkItemStatus): StatusType {
  const mapping: Record<WorkItemStatus, StatusType> = {
    queued: 'pending',
    scheduled: 'paused',
    running: 'running',
    blocked: 'blocked',
    done: 'completed',
    failed: 'error',
    cancelled: 'inactive',
  };
  return mapping[status] ?? 'pending';
}

/**
 * Returns a human-readable label for a WorkItem status.
 *
 * @param status - The WorkItem status
 * @returns Display label string
 */
export function getWorkItemStatusLabel(status: WorkItemStatus): string {
  const labels: Record<WorkItemStatus, string> = {
    queued: 'Queued',
    scheduled: 'Scheduled',
    running: 'Running',
    blocked: 'Blocked',
    done: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  return labels[status] ?? status;
}

/**
 * Maps a WorkItem type to a Badge variant.
 *
 * @param type - The WorkItem type
 * @returns BadgeVariant for the UI Badge component
 */
export function getWorkItemTypeBadgeVariant(type: WorkItemType): BadgeVariant {
  const mapping: Record<WorkItemType, BadgeVariant> = {
    delegate: 'primary',
    project_task: 'info',
    check: 'default',
    notify: 'success',
    cron_run: 'warning',
    review: 'info',
    confirm: 'warning',
    reconcile: 'default',
  };
  return mapping[type] ?? 'default';
}

/**
 * Returns a human-readable label for a WorkItem type.
 *
 * @param type - The WorkItem type
 * @returns Display label string
 */
export function getWorkItemTypeLabel(type: WorkItemType): string {
  const labels: Record<WorkItemType, string> = {
    delegate: 'Delegate',
    project_task: 'Project Task',
    check: 'Check',
    notify: 'Notify',
    cron_run: 'Cron Run',
    review: 'Review',
    confirm: 'Confirm',
    reconcile: 'Reconcile',
  };
  return labels[type] ?? type;
}

/**
 * Returns a human-readable label for a WorkItem owner.
 *
 * @param owner - The WorkItem owner
 * @returns Display label string
 */
export function getWorkItemOwnerLabel(owner: WorkItemOwner): string {
  const labels: Record<WorkItemOwner, string> = {
    orchestrator: 'Orchestrator',
    team_lead: 'Team Lead',
    agent: 'Agent',
    system: 'System',
  };
  return labels[owner] ?? owner;
}

/**
 * Formats a relative time string from an ISO date.
 *
 * @param isoDate - ISO date string
 * @returns Human-readable relative time (e.g., "2h ago")
 */
export function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${diffDay}d ago`;
}

/**
 * Formats a date to a display string.
 *
 * @param isoDate - ISO date string
 * @returns Formatted date string (e.g., "2026-04-05 10:30:01 AM")
 */
export function formatTimestamp(isoDate: string): string {
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

/**
 * Formats a cost value in USD.
 *
 * @param cost - Cost in USD
 * @returns Formatted cost string (e.g., "$0.0045")
 */
export function formatCost(cost: number): string {
  if (cost === 0) return '—';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Formats token count for display.
 *
 * @param tokens - Number of tokens
 * @returns Formatted string (e.g., "1.2K")
 */
export function formatTokens(tokens: number): string {
  if (tokens === 0) return '—';
  if (tokens < 1000) return tokens.toString();
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * Synthesizes timeline events from a WorkItem.
 * Creates a chronological list of events based on timestamps and status.
 *
 * @param item - The WorkItem to build timeline from
 * @returns Array of TimelineEvents sorted newest-first
 */
export function buildTimeline(item: WorkItem): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // Created / Queued
  events.push({
    id: `${item.id}-created`,
    kind: 'status_change',
    label: 'QUEUED',
    detail: `WorkItem created and added to pool.`,
    timestamp: item.createdAt,
    status: 'queued',
  });

  // Started / Running
  if (item.startedAt) {
    events.push({
      id: `${item.id}-started`,
      kind: 'status_change',
      label: 'RUNNING',
      detail: item.target ? `Claimed by agent: ${item.target}` : 'Execution started.',
      timestamp: item.startedAt,
      status: 'running',
    });
  }

  // Error
  if (item.error) {
    const errorTs = item.completedAt || item.startedAt || item.createdAt;
    events.push({
      id: `${item.id}-error`,
      kind: 'error',
      label: 'ERROR',
      detail: item.error,
      timestamp: errorTs,
      status: 'failed',
    });
  }

  // Completed / Done
  if (item.completedAt && item.status === 'done') {
    events.push({
      id: `${item.id}-done`,
      kind: 'status_change',
      label: 'COMPLETED',
      detail: 'Execution completed successfully.',
      timestamp: item.completedAt,
      status: 'done',
    });
  }

  // Failed (terminal)
  if (item.completedAt && item.status === 'failed') {
    events.push({
      id: `${item.id}-failed`,
      kind: 'status_change',
      label: 'FAILED',
      detail: `Execution failed after ${item.retryCount}/${item.maxRetries} retries.`,
      timestamp: item.completedAt,
      status: 'failed',
    });
  }

  // Cancelled
  if (item.status === 'cancelled') {
    const ts = item.completedAt || item.createdAt;
    events.push({
      id: `${item.id}-cancelled`,
      kind: 'status_change',
      label: 'CANCELLED',
      detail: 'WorkItem was cancelled.',
      timestamp: ts,
      status: 'cancelled',
    });
  }

  // Result as progress update
  if (item.result && Object.keys(item.result).length > 0) {
    const resultTs = item.completedAt || item.startedAt || item.createdAt;
    events.push({
      id: `${item.id}-result`,
      kind: 'progress_update',
      label: 'RESULT DATA',
      detail: JSON.stringify(item.result, null, 2),
      timestamp: resultTs,
    });
  }

  // Sort newest first
  return events.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}
