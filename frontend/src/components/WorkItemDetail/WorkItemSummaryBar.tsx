/**
 * WorkItem Summary Bar Component
 *
 * Displays summary statistics for the work items list as a horizontal grid
 * of stat cards. Uses the same pattern as RequestSummaryBar
 * (bg-surface-dark, border-border-dark, Tailwind utility classes).
 *
 * @module components/WorkItemDetail/WorkItemSummaryBar
 */

import React from 'react';

// =============================================================================
// Types
// =============================================================================

/**
 * Statistics for the WorkItem summary bar.
 */
export interface WorkItemStatistics {
  /** Total number of work items */
  total: number;
  /** Number of running work items */
  running: number;
  /** Number of queued work items */
  queued: number;
  /** Number of completed (done) work items */
  done: number;
  /** Number of failed work items */
  failed: number;
  /** Number of blocked work items */
  blocked: number;
}

// =============================================================================
// Props
// =============================================================================

interface WorkItemSummaryBarProps {
  /** Computed work item statistics (null during loading) */
  stats: WorkItemStatistics | null;
}

// =============================================================================
// Sub-component
// =============================================================================

/**
 * A single stat card matching the Dashboard StatCard pattern.
 *
 * @param props.title - Stat label
 * @param props.value - Stat value
 * @param props.accent - Optional text color class for the value
 */
const StatCard: React.FC<{ title: string; value: number; accent?: string }> = ({
  title,
  value,
  accent,
}) => (
  <div className="bg-surface-dark p-4 rounded-lg border border-border-dark transition-all hover:shadow-lg hover:border-primary/50">
    <p className="text-xs font-medium text-text-secondary-dark">{title}</p>
    <p className={`text-2xl font-bold mt-1 ${accent ?? ''}`}>{value}</p>
  </div>
);

// =============================================================================
// Helpers
// =============================================================================

/**
 * Computes WorkItem statistics from items array.
 *
 * @param items - Array of work items with status field
 * @returns Computed statistics
 */
export function computeWorkItemStats(items: Array<{ status: string }>): WorkItemStatistics {
  const stats: WorkItemStatistics = {
    total: items.length,
    running: 0,
    queued: 0,
    done: 0,
    failed: 0,
    blocked: 0,
  };

  for (const item of items) {
    switch (item.status) {
      case 'running':
        stats.running++;
        break;
      case 'queued':
      case 'scheduled':
        stats.queued++;
        break;
      case 'done':
        stats.done++;
        break;
      case 'failed':
        stats.failed++;
        break;
      case 'blocked':
        stats.blocked++;
        break;
      // 'cancelled' and others are counted in total but not shown as separate cards
    }
  }

  return stats;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a 6-column grid of stat cards for the work items list.
 * Follows the RequestSummaryBar layout pattern.
 *
 * @param props.stats - Statistics to display
 * @returns Summary bar JSX element
 */
export const WorkItemSummaryBar: React.FC<WorkItemSummaryBarProps> = ({ stats }) => {
  if (!stats) return null;

  return (
    <div
      className="grid grid-cols-3 md:grid-cols-6 gap-3"
      data-testid="workitem-summary-bar"
    >
      <StatCard title="Total" value={stats.total} />
      <StatCard title="Running" value={stats.running} accent="text-blue-400" />
      <StatCard title="Queued" value={stats.queued} accent="text-yellow-400" />
      <StatCard title="Done" value={stats.done} accent="text-green-400" />
      <StatCard title="Failed" value={stats.failed} accent="text-red-400" />
      <StatCard title="Blocked" value={stats.blocked} accent="text-orange-400" />
    </div>
  );
};
