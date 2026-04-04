/**
 * Message Group Card Component
 *
 * Renders a message group as an expandable card with derived group state,
 * progress pill, and collapsible task list.
 *
 * @module components/TaskTracking/MessageGroupCard
 */

import React, { useState, useCallback } from 'react';
import { TaskRow } from './TaskRow';
import type { MessageGroup } from './task-tracking.types';
import { deriveGroupState, formatRelativeTime } from './task-tracking.types';
import type { GroupState } from './task-tracking.types';

// =============================================================================
// Types
// =============================================================================

interface MessageGroupCardProps {
  /** Message group data */
  group: MessageGroup;
  /** Whether this card is expanded by default */
  defaultExpanded?: boolean;
  /** Callback when a task toggle is triggered */
  onTaskToggle?: (taskId: string) => void;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Maps group state to its CSS class suffix.
 *
 * @param state - Derived group state
 * @returns CSS class suffix
 */
function getGroupStateClass(state: GroupState): string {
  const map: Record<GroupState, string> = {
    'Running': 'running',
    'Needs attention': 'attention',
    'Ready': 'ready',
    'Done': 'done',
    'Paused': 'paused',
    'Stopped': 'stopped',
  };
  return map[state];
}

// =============================================================================
// Component
// =============================================================================

/**
 * Expandable card representing a message group with derived status.
 *
 * Header shows: message preview (2 lines), timestamp, progress pill, group state badge.
 * Body shows: list of TaskRow components.
 *
 * @param props - Component props
 * @returns Message group card JSX element
 */
export const MessageGroupCard: React.FC<MessageGroupCardProps> = ({
  group,
  defaultExpanded = false,
  onTaskToggle,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const groupState = deriveGroupState(group.tasks);
  const stateClass = getGroupStateClass(groupState);
  const doneCount = group.tasks.filter((t) => t.status === 'completed').length;
  const totalCount = group.tasks.length;

  /** Toggle expansion */
  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  return (
    <div className="message-group-card" data-testid="message-group-card" data-message-id={group.messageId}>
      <button
        className="message-group-card-header"
        onClick={handleToggle}
        aria-expanded={expanded}
        data-testid="message-group-header"
      >
        <div className="message-group-card-header-left">
          <span className="message-group-card-message" data-testid="message-group-text">
            {group.originalMessage}
          </span>
          <span className="message-group-card-meta">
            <span data-testid="message-group-time">{formatRelativeTime(group.createdAt)}</span>
            <span>·</span>
            <span>{totalCount} task{totalCount !== 1 ? 's' : ''}</span>
          </span>
        </div>

        <div className="message-group-card-header-right">
          <span className="message-group-card-progress" data-testid="message-group-progress">
            {doneCount} of {totalCount} done
          </span>
          <span
            className={`group-state-badge group-state-badge--${stateClass}`}
            data-testid="group-state-badge"
          >
            {groupState === 'Running' && (
              <span className="group-state-pulse" aria-hidden="true" />
            )}
            {groupState}
          </span>
          <svg
            className={`message-group-card-chevron ${expanded ? 'message-group-card-chevron--expanded' : ''}`}
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </button>

      {expanded && (
        <div className="message-group-card-body" data-testid="message-group-body">
          {group.tasks.map((task) => (
            <TaskRow key={task.id} task={task} onToggle={onTaskToggle} />
          ))}
        </div>
      )}
    </div>
  );
};

export default MessageGroupCard;
