/**
 * Tasks Page — V3
 *
 * Page shell for the /tasks route. Contains page header, summary bar,
 * filter controls, and the task feed (TaskList).
 *
 * @module pages/TasksPage
 */

import React, { useState, useCallback } from 'react';
import { TaskSummaryBar } from '../components/TaskTracking/TaskSummaryBar';
import { TaskFilters } from '../components/TaskTracking/TaskFilters';
import { TaskList } from '../components/TaskTracking/TaskList';
import type { TaskStatistics, PrimaryFilter } from '../components/TaskTracking/task-tracking.types';
import '../components/TaskTracking/TaskTracking.css';

// =============================================================================
// Component
// =============================================================================

/**
 * Tasks page with page shell, summary bar, filters, and task feed.
 *
 * Orchestrates state between TaskSummaryBar, TaskFilters, and TaskList:
 * - Stats from TaskList are propagated to TaskSummaryBar
 * - Filter/search state from TaskFilters is propagated to TaskList
 *
 * @returns Tasks page JSX element
 */
export const TasksPage: React.FC = () => {
  const [stats, setStats] = useState<TaskStatistics | null>(null);
  const [activeFilter, setActiveFilter] = useState<PrimaryFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [advancedFilter, setAdvancedFilter] = useState('');

  /** Receive stats from TaskList */
  const handleStatsLoaded = useCallback((loadedStats: TaskStatistics) => {
    setStats(loadedStats);
  }, []);

  /** Debounced search handler (immediate for now, can add debounce later) */
  const handleSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  return (
    <div className="tasks-page" data-testid="tasks-page">
      {/* Page header */}
      <div className="tasks-page-header" data-testid="tasks-page-header">
        <h1 className="tasks-page-title">Tasks</h1>
        <p className="tasks-page-subtitle">
          AI-generated action items extracted from your conversations.
        </p>
      </div>

      {/* Summary bar */}
      <TaskSummaryBar stats={stats} />

      {/* Filters */}
      <TaskFilters
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        advancedFilter={advancedFilter}
        onAdvancedFilterChange={setAdvancedFilter}
        stats={stats}
      />

      {/* Task feed */}
      <TaskList
        activeFilter={activeFilter}
        searchQuery={searchQuery}
        advancedFilter={advancedFilter}
        onStatsLoaded={handleStatsLoaded}
      />
    </div>
  );
};

export default TasksPage;
