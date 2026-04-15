/**
 * WorkItem Summary Bar Component
 *
 * Displays summary statistics for the work items list using the shared
 * ScoreCard and ScoreCardGrid UI components.
 *
 * @module components/WorkItemDetail/WorkItemSummaryBar
 */

import React from 'react';
import { ScoreCard, ScoreCardGrid } from '../UI/ScoreCard';

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
    }
  }

  return stats;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a grid of stat cards for the work items list using shared ScoreCard.
 *
 * @param props.stats - Statistics to display
 * @returns Summary bar JSX element
 */
export const WorkItemSummaryBar: React.FC<WorkItemSummaryBarProps> = ({ stats }) => {
  if (!stats) return null;

  return (
    <ScoreCardGrid variant="horizontal" className="grid-cols-3 md:grid-cols-6" data-testid="workitem-summary-bar">
      <ScoreCard label="Total" value={stats.total} />
      <ScoreCard label="Running"><span className="text-blue-400">{stats.running}</span></ScoreCard>
      <ScoreCard label="Queued"><span className="text-yellow-400">{stats.queued}</span></ScoreCard>
      <ScoreCard label="Done"><span className="text-green-400">{stats.done}</span></ScoreCard>
      <ScoreCard label="Failed"><span className="text-red-400">{stats.failed}</span></ScoreCard>
      <ScoreCard label="Blocked"><span className="text-orange-400">{stats.blocked}</span></ScoreCard>
    </ScoreCardGrid>
  );
};
