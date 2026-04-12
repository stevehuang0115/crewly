/**
 * Task List Component — V4 (Data orchestration)
 *
 * Fetches intent tasks from the API and exposes data to the parent page.
 * Handles grouping, filtering, search, and agent assignment.
 *
 * V4 adds: fetches available agents from teams API, passes to TaskRow
 * for "Assign Agent" functionality.
 *
 * @module components/TaskTracking/TaskList
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { MessageGroupCard } from './MessageGroupCard';
import type { AvailableAgent } from './TaskRow';
import type {
  IntentTaskSummary,
  MessageGroup,
  TaskStatistics,
  PrimaryFilter,
} from './task-tracking.types';
import { getFilterStatuses } from './task-tracking.types';

// Re-export types for backward compatibility
export type { IntentTaskSummary, MessageGroup, TaskStatistics };

// =============================================================================
// Types
// =============================================================================

interface TaskListProps {
  /** Current primary filter */
  activeFilter: PrimaryFilter;
  /** Current search query */
  searchQuery: string;
  /** Advanced filter (backend status or level) */
  advancedFilter: string;
  /** Callback to provide stats to parent */
  onStatsLoaded?: (stats: TaskStatistics) => void;
  /** Callback to provide loading state to parent */
  onLoadingChange?: (loading: boolean) => void;
  /** Callback to provide error state to parent */
  onError?: (error: string | null) => void;
}

// =============================================================================
// Filter-empty messages
// =============================================================================

const FILTER_EMPTY_MESSAGES: Record<string, string> = {
  active: 'No active tasks right now.',
  needs_attention: 'Nothing needs attention right now.',
  completed: 'No completed tasks in this view yet.',
};

// =============================================================================
// Component
// =============================================================================

/**
 * Task feed component that fetches, filters, and renders message groups.
 * Also loads available agents for task assignment.
 *
 * @param props - Component props
 * @returns Task feed JSX element
 */
export const TaskList: React.FC<TaskListProps> = ({
  activeFilter,
  searchQuery,
  advancedFilter,
  onStatsLoaded,
  onLoadingChange,
  onError,
}) => {
  const [allGroups, setAllGroups] = useState<MessageGroup[]>([]);
  const [stats, setStats] = useState<TaskStatistics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [availableAgents, setAvailableAgents] = useState<AvailableAgent[]>([]);

  /**
   * Fetch all message groups from the API (always unfiltered to preserve originalMessage).
   */
  const fetchGroups = useCallback(async () => {
    try {
      const res = await fetch('/api/intent-tasks/messages');
      const data = await res.json();
      if (data.success) {
        setAllGroups(data.data);
      } else {
        const errMsg = data.error || 'Failed to load tasks';
        setError(errMsg);
        onError?.(errMsg);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Network error';
      setError(errMsg);
      onError?.(errMsg);
    }
  }, [onError]);

  /**
   * Fetch statistics from the API.
   */
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/intent-tasks/statistics');
      const data = await res.json();
      if (data.success) {
        setStats(data.data);
        onStatsLoaded?.(data.data);
      }
    } catch {
      // Stats are non-critical, silently ignore
    }
  }, [onStatsLoaded]);

  /**
   * Fetch available agents from teams API for assignment dropdown.
   */
  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/teams');
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        const agents: AvailableAgent[] = [];
        for (const team of data.data) {
          if (Array.isArray(team.members)) {
            for (const member of team.members) {
              agents.push({
                sessionName: member.sessionName,
                name: member.name,
                role: member.role,
                agentStatus: member.agentStatus,
                workingStatus: member.workingStatus,
              });
            }
          }
        }
        setAvailableAgents(agents);
      }
    } catch {
      // Agents list is non-critical, silently ignore
    }
  }, []);

  /** Initial data load */
  useEffect(() => {
    setIsLoading(true);
    onLoadingChange?.(true);
    Promise.all([fetchGroups(), fetchStats(), fetchAgents()]).finally(() => {
      setIsLoading(false);
      onLoadingChange?.(false);
    });
  }, [fetchGroups, fetchStats, fetchAgents, onLoadingChange]);

  /**
   * Handle task toggle (status change) — refetch data after toggle.
   */
  const handleToggle = useCallback(async (taskId: string) => {
    try {
      const res = await fetch(`/api/intent-tasks/${taskId}/toggle`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        await Promise.all([fetchGroups(), fetchStats()]);
      }
    } catch {
      // Silently fail
    }
  }, [fetchGroups, fetchStats]);

  /**
   * Handle agent assignment — update task with assigned session, refetch data.
   */
  const handleAssignAgent = useCallback(async (taskId: string, sessionName: string) => {
    try {
      const res = await fetch(`/api/intent-tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignedSessions: [sessionName],
          status: 'in_progress',
        }),
      });
      const data = await res.json();
      if (data.success) {
        await Promise.all([fetchGroups(), fetchStats()]);
      }
    } catch {
      // Silently fail
    }
  }, [fetchGroups, fetchStats]);

  /**
   * Apply filters and search to the groups.
   * Always preserves originalMessage (never rebuilds from child intents).
   */
  const filteredGroups = useMemo(() => {
    let groups = allGroups;

    // Determine which backend statuses to filter by
    let statusFilter: string[] = [];
    if (advancedFilter) {
      // Advanced filter: could be a status or a level
      const isLevel = ['L0', 'L1', 'L2'].includes(advancedFilter);
      if (isLevel) {
        // Filter tasks by level, then filter out empty groups
        groups = groups
          .map((g) => ({
            ...g,
            tasks: g.tasks.filter((t) => t.level === advancedFilter),
          }))
          .filter((g) => g.tasks.length > 0);
      } else {
        statusFilter = [advancedFilter];
      }
    } else {
      statusFilter = getFilterStatuses(activeFilter);
    }

    // Apply status filter
    if (statusFilter.length > 0) {
      groups = groups
        .map((g) => ({
          ...g,
          tasks: g.tasks.filter((t: IntentTaskSummary) => statusFilter.includes(t.status)),
        }))
        .filter((g) => g.tasks.length > 0);
    }

    // Apply search
    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      groups = groups.filter((g) => {
        const messageMatch = g.originalMessage.toLowerCase().includes(query);
        const taskMatch = g.tasks.some(
          (t) =>
            t.intent.toLowerCase().includes(query) ||
            t.category.toLowerCase().includes(query),
        );
        return messageMatch || taskMatch;
      });
    }

    return groups;
  }, [allGroups, activeFilter, advancedFilter, searchQuery]);

  /** Retry handler for error state */
  const handleRetry = useCallback(() => {
    setError(null);
    onError?.(null);
    setIsLoading(true);
    onLoadingChange?.(true);
    Promise.all([fetchGroups(), fetchStats(), fetchAgents()]).finally(() => {
      setIsLoading(false);
      onLoadingChange?.(false);
    });
  }, [fetchGroups, fetchStats, fetchAgents, onError, onLoadingChange]);

  // Error state
  if (error) {
    return (
      <div className="tasks-error-state" data-testid="tasks-error">
        <p className="tasks-error-text">Task history couldn&apos;t load right now. Try again.</p>
        <button className="tasks-error-retry" onClick={handleRetry} data-testid="tasks-error-retry">
          Retry
        </button>
      </div>
    );
  }

  // Loading state — skeleton cards
  if (isLoading) {
    return (
      <div className="task-feed" data-testid="task-feed-loading">
        {[1, 2, 3].map((i) => (
          <div key={i} className="task-skeleton-card" data-testid="task-skeleton">
            <div className="task-skeleton-line task-skeleton-line--wide" />
            <div className="task-skeleton-line task-skeleton-line--narrow" />
            <div className="task-skeleton-row">
              <div className="task-skeleton-dot" />
              <div className="task-skeleton-line task-skeleton-line--medium" />
            </div>
            <div className="task-skeleton-row">
              <div className="task-skeleton-dot" />
              <div className="task-skeleton-line task-skeleton-line--wide" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Empty state (no tasks at all)
  if (allGroups.length === 0) {
    return (
      <div className="tasks-empty-state" data-testid="tasks-empty">
        <h3 className="tasks-empty-title">No tasks yet</h3>
        <p className="tasks-empty-body">
          When a conversation includes actionable requests, Crewly will break them into trackable tasks here.
        </p>
        <a href="/chat" className="tasks-empty-cta" data-testid="tasks-empty-cta">
          Open Chat
        </a>
      </div>
    );
  }

  // Filter-empty state (tasks exist but none match filter)
  if (filteredGroups.length === 0) {
    const emptyMessage = FILTER_EMPTY_MESSAGES[activeFilter] ?? 'No tasks match the current filters.';
    return (
      <div className="tasks-filter-empty" data-testid="tasks-filter-empty">
        {emptyMessage}
      </div>
    );
  }

  // Render task feed — newest 2 groups expanded, rest collapsed
  return (
    <div className="task-feed" data-testid="task-feed">
      {filteredGroups.map((group, index) => (
        <MessageGroupCard
          key={group.messageId}
          group={group}
          defaultExpanded={index < 2}
          onTaskToggle={handleToggle}
          onAssignAgent={handleAssignAgent}
          availableAgents={availableAgents}
        />
      ))}
    </div>
  );
};

export default TaskList;
