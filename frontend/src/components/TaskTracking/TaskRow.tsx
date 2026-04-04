/**
 * Task Row Component — V3
 *
 * Renders a single intent task as a 2-tier row:
 * - Top line: status icon + intent text + status badge
 * - Bottom line: level badge + category + agents + updated time
 * - Expandable details: tokens, cost, runs (hidden by default)
 *
 * Replaces the checkbox-based V2 design with state dot/check-circle icons.
 *
 * @module components/TaskTracking/TaskRow
 */

import React, { useCallback, useState } from 'react';
import type { IntentTaskSummary } from './task-tracking.types';
import {
  getStatusLabel,
  getStatusClass,
  getLevelInfo,
  formatRelativeTime,
  formatTokens,
  formatCost,
} from './task-tracking.types';

// =============================================================================
// Types
// =============================================================================

interface TaskRowProps {
  /** Task summary data */
  task: IntentTaskSummary;
  /** Callback when the task state is toggled */
  onToggle?: (taskId: string) => void;
}

// =============================================================================
// Sub-components
// =============================================================================

/**
 * Renders the status icon — a check circle for completed tasks, a colored dot for others.
 *
 * @param props - Status and class info
 * @returns SVG or dot element
 */
const StatusIcon: React.FC<{ status: string; statusClass: string }> = ({ status, statusClass }) => {
  if (status === 'completed') {
    return (
      <span className="task-row-status-icon" data-testid="task-status-icon">
        <svg className="task-row-check-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="7" fill="none" stroke="#4ade80" strokeWidth="1.5" />
          <path d="M5 8L7 10L11 6" stroke="#4ade80" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </span>
    );
  }

  return (
    <span className="task-row-status-icon" data-testid="task-status-icon">
      <span className={`task-row-status-dot task-row-status-dot--${statusClass}`} />
    </span>
  );
};

// =============================================================================
// Component
// =============================================================================

/**
 * Single task row with 2-tier layout and expandable details.
 *
 * @param props - Component props
 * @returns JSX element with task row
 */
export const TaskRow: React.FC<TaskRowProps> = ({ task, onToggle }) => {
  const [showDetails, setShowDetails] = useState(false);

  const statusLabel = getStatusLabel(task.status);
  const statusClass = getStatusClass(task.status);
  const levelInfo = getLevelInfo(task.level);
  const isDone = task.status === 'completed';
  const hasDetails = task.totalTokens > 0 || task.totalCost > 0 || task.runCount > 0;

  /** Toggle details disclosure */
  const handleDetailsToggle = useCallback(() => {
    setShowDetails((prev) => !prev);
  }, []);

  /** Handle status icon click for toggling */
  const handleToggle = useCallback(() => {
    onToggle?.(task.id);
  }, [onToggle, task.id]);

  return (
    <div
      className={`task-row-v3 ${isDone ? 'task-row-v3--done' : ''}`}
      data-testid="task-row"
      data-task-id={task.id}
    >
      {/* Top line: icon + intent + status badge */}
      <div className="task-row-top">
        <button
          onClick={handleToggle}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
          aria-label={isDone ? 'Mark as incomplete' : 'Mark as complete'}
          data-testid="task-toggle"
        >
          <StatusIcon status={task.status} statusClass={statusClass} />
        </button>

        <span
          className={`task-row-intent ${isDone ? 'task-row-intent--done' : ''}`}
          data-testid="task-intent"
        >
          {task.intent}
        </span>

        <span
          className={`task-row-status-badge task-row-status-badge--${statusClass}`}
          data-testid="task-status"
        >
          {statusLabel}
        </span>
      </div>

      {/* Bottom line: level + category + agents + time */}
      <div className="task-row-bottom" data-testid="task-row-bottom">
        <span
          className={`task-row-level task-row-level--${task.level.toLowerCase()}`}
          data-testid="task-level"
        >
          <span className="task-row-level-short">{levelInfo.short}</span>
          <span className="task-row-level-full">{levelInfo.full}</span>
        </span>

        <span className="task-row-category" data-testid="task-category">{task.category}</span>

        {task.assignedSessions.length > 0 && (
          <span className="task-row-agents" title={task.assignedSessions.join(', ')} data-testid="task-agents">
            {task.assignedSessions.length} agent{task.assignedSessions.length > 1 ? 's' : ''}
          </span>
        )}

        {task.scheduleId && (
          <span className="task-row-schedule" data-testid="task-schedule" title={`Schedule: ${task.scheduleId}`}>
            scheduled
          </span>
        )}

        <span className="task-row-time" data-testid="task-time">{formatRelativeTime(task.updatedAt)}</span>
      </div>

      {/* Details disclosure */}
      {hasDetails && (
        <>
          <button
            className="task-row-details-toggle"
            onClick={handleDetailsToggle}
            aria-expanded={showDetails}
            data-testid="task-details-toggle"
          >
            {showDetails ? 'Hide details' : 'Details'}
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path
                d={showDetails ? 'M2 7L5 4L8 7' : 'M2 4L5 7L8 4'}
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {showDetails && (
            <div className="task-row-details" data-testid="task-details">
              {task.runCount > 0 && (
                <span className="task-row-detail-item">
                  Runs: <span className="task-row-detail-value" data-testid="task-runs">{task.runCount}</span>
                </span>
              )}
              {task.totalTokens > 0 && (
                <span className="task-row-detail-item">
                  Tokens: <span className="task-row-detail-value" data-testid="task-tokens">{formatTokens(task.totalTokens)}</span>
                </span>
              )}
              {task.totalCost > 0 && (
                <span className="task-row-detail-item">
                  Cost: <span className="task-row-detail-value" data-testid="task-cost">{formatCost(task.totalCost)}</span>
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default TaskRow;
