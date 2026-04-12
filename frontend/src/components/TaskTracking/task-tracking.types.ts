/**
 * Task Tracking Types — V3
 *
 * Shared type definitions for the intent task tracking UI.
 * Extracted from TaskList.tsx for reuse across components.
 *
 * @module components/TaskTracking/task-tracking.types
 */

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Summary shape returned by GET /api/intent-tasks
 */
export interface IntentTaskSummary {
  id: string;
  messageId: string;
  intent: string;
  level: 'L0' | 'L1' | 'L2';
  category: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  totalTokens: number;
  totalCost: number;
  assignedSessions: string[];
  order: number;
  scheduleId?: string;
  projectTaskId?: string;
}

/**
 * Message group shape from GET /api/intent-tasks/messages
 */
export interface MessageGroup {
  messageId: string;
  originalMessage: string;
  createdAt: string;
  tasks: IntentTaskSummary[];
  completedCount: number;
  totalCount: number;
}

/**
 * Statistics shape from GET /api/intent-tasks/statistics
 */
export interface TaskStatistics {
  totalTasks: number;
  byStatus: Record<string, number>;
  byLevel: Record<string, number>;
  totalTokens: number;
  totalCost: number;
  totalMessages: number;
}

// =============================================================================
// UI Types
// =============================================================================

/**
 * Backend status values
 */
export type BackendStatus = 'pending' | 'classified' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'paused';

/**
 * User-facing status labels mapped from backend status
 */
export type UserFacingStatus = 'Ready' | 'Running' | 'Done' | 'Needs attention' | 'Stopped' | 'Paused';

/**
 * Derived group state from child task statuses
 */
export type GroupState = 'Needs attention' | 'Running' | 'Paused' | 'Ready' | 'Done' | 'Stopped';

/**
 * Primary filter values for the task filter bar
 */
export type PrimaryFilter = 'all' | 'active' | 'needs_attention' | 'completed';

/**
 * Level label mapping
 */
export interface LevelInfo {
  short: string;
  full: string;
}

// =============================================================================
// Status Mapping Utilities
// =============================================================================

/**
 * Maps backend status to user-facing label.
 *
 * @param status - Backend task status string
 * @returns User-facing status label
 */
export function getStatusLabel(status: string): UserFacingStatus {
  const map: Record<string, UserFacingStatus> = {
    pending: 'Ready',
    classified: 'Ready',
    in_progress: 'Running',
    completed: 'Done',
    failed: 'Needs attention',
    cancelled: 'Stopped',
    paused: 'Paused',
  };
  return map[status] ?? 'Ready';
}

/**
 * Maps backend status to CSS class suffix for status styling.
 *
 * @param status - Backend task status string
 * @returns CSS class suffix
 */
export function getStatusClass(status: string): string {
  const map: Record<string, string> = {
    pending: 'ready',
    classified: 'ready',
    in_progress: 'running',
    completed: 'done',
    failed: 'attention',
    cancelled: 'stopped',
    paused: 'paused',
  };
  return map[status] ?? 'ready';
}

/**
 * Level info mapping from L0/L1/L2 to readable labels.
 *
 * @param level - Level string (L0, L1, L2)
 * @returns Level info with short and full labels
 */
export function getLevelInfo(level: string): LevelInfo {
  const map: Record<string, LevelInfo> = {
    L0: { short: 'L0', full: 'L0 Quick' },
    L1: { short: 'L1', full: 'L1 Standard' },
    L2: { short: 'L2', full: 'L2 Complex' },
  };
  return map[level] ?? { short: level, full: level };
}

/**
 * Derives group state from an array of child task statuses.
 * Priority order: Needs attention > Running > Paused > Ready > Done > Stopped
 *
 * @param tasks - Array of tasks in the group
 * @returns Derived group state
 */
export function deriveGroupState(tasks: IntentTaskSummary[]): GroupState {
  if (tasks.length === 0) return 'Ready';

  const statuses = tasks.map((t) => t.status);

  if (statuses.some((s) => s === 'failed')) return 'Needs attention';
  if (statuses.some((s) => s === 'in_progress')) return 'Running';
  if (statuses.some((s) => s === 'paused')) return 'Paused';
  if (statuses.every((s) => s === 'completed')) return 'Done';
  if (statuses.every((s) => s === 'cancelled')) return 'Stopped';
  if (statuses.every((s) => s === 'pending' || s === 'classified' || s === 'completed' || s === 'cancelled')) return 'Ready';

  return 'Ready';
}

/**
 * Maps a primary filter to the backend statuses it includes.
 *
 * @param filter - Primary filter value
 * @returns Array of backend status strings, or empty for 'all'
 */
export function getFilterStatuses(filter: PrimaryFilter): string[] {
  switch (filter) {
    case 'active':
      return ['pending', 'classified', 'in_progress', 'paused'];
    case 'needs_attention':
      return ['failed'];
    case 'completed':
      return ['completed'];
    case 'all':
    default:
      return [];
  }
}

// =============================================================================
// Formatting Utilities
// =============================================================================

/**
 * Formats a relative time string from an ISO date.
 *
 * @param iso - ISO 8601 date string
 * @returns Human-readable relative time string
 */
export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Formats token count with K/M abbreviations.
 *
 * @param count - Raw token count
 * @returns Formatted string (e.g., "15.0K", "2.5M")
 */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

/**
 * Formats a cost value as USD string.
 *
 * @param cost - Raw cost in dollars
 * @returns Formatted cost string (e.g., "$0.45", "<$0.01")
 */
export function formatCost(cost: number): string {
  if (cost === 0) return '-';
  if (cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}
