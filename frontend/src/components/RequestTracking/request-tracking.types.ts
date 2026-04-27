/**
 * Request Tracking Types — V3
 *
 * Type definitions and utility functions for the Request List page.
 *
 * @module components/RequestTracking/request-tracking.types
 */

import type { StatusType } from '../UI/StatusBadge';
import type { BadgeVariant } from '../UI/Badge';

// =============================================================================
// Constants
// =============================================================================

/** Available request statuses */
export const REQUEST_STATUSES = ['active', 'blocked', 'waiting_confirmation', 'done'] as const;

/** Request priority levels */
export const REQUEST_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

/** Source channel types */
export const REQUEST_SOURCES = ['slack', 'email', 'chat', 'api', 'manual'] as const;

// =============================================================================
// Types
// =============================================================================

/** Request status type */
export type RequestStatus = typeof REQUEST_STATUSES[number];

/** Request priority type */
export type RequestPriority = typeof REQUEST_PRIORITIES[number];

/** Request source channel type */
export type RequestSource = typeof REQUEST_SOURCES[number];

/** Primary filter for the request list */
export type RequestPrimaryFilter = 'all' | RequestStatus;

/**
 * A single request item in the request list.
 *
 * The two-tier scan model (per Ava's V3 design report 2026-04-05):
 *   Top line — source icon + title + status pill (compact identity scan)
 *   Bottom line — priority, category, mission link, work item count, updated time
 * Cost / tokens / source label live on the detail page or the expandable
 * context area, not on the baseline row scan line.
 */
export interface RequestItem {
  /** Unique request ID */
  id: string;
  /** Request title / summary */
  title: string;
  /** Current status */
  status: RequestStatus;
  /** Priority level */
  priority: RequestPriority;
  /** Source channel (Slack, email, etc.) */
  source: RequestSource;
  /** Requester name */
  requester: string;
  /** Associated mission name (optional) */
  missionLink?: string;
  /** Intent category (optional) — surfaces on the row's bottom line */
  category?: string;
  /** Number of WorkItems backing this Request (0 when no delegation occurred) */
  workItemCount: number;
  /** Last updated timestamp (ISO string) */
  updatedAt: string;
  /** Child work items (optional) */
  childItems?: RequestChildItem[];
  /** Total input tokens consumed (kept for detail-page stats) */
  totalInputTokens: number;
  /** Total output tokens consumed (kept for detail-page stats) */
  totalOutputTokens: number;
  /** Total cost in USD (kept for detail-page stats) */
  totalCost: number;
  /** Agent that handled the request directly (no WorkItem delegation) */
  ownerAgent?: string;
}

/**
 * A child work item within a request (e.g., sub-tasks, migration steps).
 */
export interface RequestChildItem {
  /** Child item ID */
  id: string;
  /** Child item label */
  label: string;
  /** Completion status */
  status: 'pending' | 'in_progress' | 'done';
  /** Assignee name (optional) */
  assignee?: string;
  /** Due date (optional, ISO string) */
  dueDate?: string;
  /** Progress percentage (0-100, optional) */
  progress?: number;
  /** Tag label (optional) */
  tag?: string;
}

/**
 * Secondary filter options for the request list.
 * These provide additional filtering on top of the primary status filter.
 */
export type RequestSecondaryFilter = 'urgent' | 'assigned_to_me';

/**
 * Statistics for the request list summary bar.
 */
export interface RequestStatistics {
  /** Total number of requests */
  total: number;
  /** Number of active requests */
  active: number;
  /** Number of blocked requests */
  blocked: number;
  /** Number of requests waiting confirmation */
  waitingConfirmation: number;
  /** Number of completed requests */
  done: number;
  /** Total cost across all requests in USD */
  totalCost: number;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Returns a human-readable label for a request status.
 *
 * @param status - The request status
 * @returns Display label string
 */
export function getRequestStatusLabel(status: RequestStatus): string {
  const labels: Record<RequestStatus, string> = {
    active: 'Active',
    blocked: 'Blocked',
    waiting_confirmation: 'Waiting Confirmation',
    done: 'Done',
  };
  return labels[status] ?? status;
}

/**
 * Maps a request status to a StatusBadge-compatible StatusType.
 *
 * @param status - The request status
 * @returns StatusType for the UI StatusBadge component
 */
export function getStatusBadgeType(status: RequestStatus): StatusType {
  const mapping: Record<RequestStatus, StatusType> = {
    active: 'active',
    blocked: 'blocked',
    waiting_confirmation: 'paused',
    done: 'completed',
  };
  return mapping[status] ?? 'pending';
}

/**
 * Maps a request priority to a Badge variant.
 *
 * @param priority - The request priority
 * @returns BadgeVariant for the UI Badge component
 */
export function getPriorityBadgeVariant(priority: RequestPriority): BadgeVariant {
  const mapping: Record<RequestPriority, BadgeVariant> = {
    critical: 'error',
    high: 'warning',
    medium: 'info',
    low: 'default',
  };
  return mapping[priority] ?? 'default';
}

/**
 * Returns a human-readable label for a request priority.
 *
 * @param priority - The request priority
 * @returns Display label string
 */
export function getRequestPriorityLabel(priority: RequestPriority): string {
  const labels: Record<RequestPriority, string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  };
  return labels[priority] ?? priority;
}

/**
 * Returns a source channel display label.
 *
 * @param source - The request source channel
 * @returns Capitalized source name
 */
export function getSourceLabel(source: RequestSource): string {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

/**
 * Formats a relative time string from an ISO date.
 *
 * @param isoDate - ISO date string
 * @returns Human-readable relative time (e.g., "2h ago")
 */
export function formatRequestTime(isoDate: string): string {
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
 * Formats a cost value as a USD string.
 *
 * @param cost - Cost in USD
 * @returns Formatted string (e.g. "$1.53" or "$0.00")
 */
export function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Formats a token count with comma separators.
 *
 * @param tokens - Token count
 * @returns Formatted string (e.g. "485,688")
 */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString();
}

/**
 * Computes statistics from a list of requests.
 *
 * @param requests - Array of request items
 * @returns Computed statistics
 */
export function computeRequestStats(requests: RequestItem[]): RequestStatistics {
  return {
    total: requests.length,
    active: requests.filter((r) => r.status === 'active').length,
    blocked: requests.filter((r) => r.status === 'blocked').length,
    waitingConfirmation: requests.filter((r) => r.status === 'waiting_confirmation').length,
    done: requests.filter((r) => r.status === 'done').length,
    totalCost: requests.reduce((sum, r) => sum + (r.totalCost || 0), 0),
  };
}
