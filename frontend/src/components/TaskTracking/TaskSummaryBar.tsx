/**
 * Task Summary Bar Component
 *
 * Displays primary stat cards (Active, Needs attention, Done, Messages)
 * and secondary metrics (Tokens used, Estimated cost) in a visually
 * subordinate row.
 *
 * @module components/TaskTracking/TaskSummaryBar
 */

import React from 'react';
import type { TaskStatistics } from './task-tracking.types';
import { formatTokens, formatCost } from './task-tracking.types';

// =============================================================================
// Types
// =============================================================================

interface TaskSummaryBarProps {
  /** Statistics data from the API */
  stats: TaskStatistics | null;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Summary bar showing primary stat cards and secondary metrics.
 *
 * Primary cards: Active, Needs attention, Done, Messages
 * Secondary: Tokens used, Estimated cost (visually subordinate)
 *
 * @param props - Component props
 * @returns Summary bar JSX element
 */
export const TaskSummaryBar: React.FC<TaskSummaryBarProps> = ({ stats }) => {
  if (!stats) return null;

  const activeCount =
    (stats.byStatus['classified'] ?? 0) +
    (stats.byStatus['in_progress'] ?? 0) +
    (stats.byStatus['paused'] ?? 0);

  const attentionCount = stats.byStatus['failed'] ?? 0;
  const doneCount = stats.byStatus['completed'] ?? 0;

  return (
    <div className="task-summary-bar" data-testid="task-summary-bar">
      <div className="task-summary-primary" data-testid="task-summary-primary">
        <div className="task-summary-card" data-testid="summary-active">
          <span className="task-summary-value">{activeCount}</span>
          <span className="task-summary-label">Active</span>
        </div>
        <div
          className={`task-summary-card ${attentionCount > 0 ? 'task-summary-card--attention' : ''}`}
          data-testid="summary-attention"
        >
          <span className="task-summary-value">{attentionCount}</span>
          <span className="task-summary-label">Needs attention</span>
        </div>
        <div className="task-summary-card" data-testid="summary-done">
          <span className="task-summary-value">{doneCount}</span>
          <span className="task-summary-label">Done</span>
        </div>
        <div className="task-summary-card" data-testid="summary-messages">
          <span className="task-summary-value">{stats.totalMessages}</span>
          <span className="task-summary-label">Messages</span>
        </div>
      </div>

      <div className="task-summary-secondary" data-testid="task-summary-secondary">
        <span className="task-summary-metric">
          Tokens used{' '}
          <span className="task-summary-metric-value" data-testid="summary-tokens">
            {formatTokens(stats.totalTokens)}
          </span>
        </span>
        <span className="task-summary-metric">
          Estimated cost{' '}
          <span className="task-summary-metric-value" data-testid="summary-cost">
            {formatCost(stats.totalCost)}
          </span>
        </span>
      </div>
    </div>
  );
};

export default TaskSummaryBar;
