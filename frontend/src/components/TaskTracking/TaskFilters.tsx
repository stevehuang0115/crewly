/**
 * Task Filters Component
 *
 * Search input and filter chips for the tasks page.
 * Primary filters: All, Active, Needs attention, Completed
 * Advanced filters: Ready, Paused, Stopped, level filters
 *
 * @module components/TaskTracking/TaskFilters
 */

import React, { useState, useCallback } from 'react';
import type { TaskStatistics, PrimaryFilter } from './task-tracking.types';

// =============================================================================
// Types
// =============================================================================

interface TaskFiltersProps {
  /** Current primary filter */
  activeFilter: PrimaryFilter;
  /** Callback when filter changes */
  onFilterChange: (filter: PrimaryFilter) => void;
  /** Current search query */
  searchQuery: string;
  /** Callback when search query changes */
  onSearchChange: (query: string) => void;
  /** Optional advanced filter (backend status or level) */
  advancedFilter: string;
  /** Callback when advanced filter changes */
  onAdvancedFilterChange: (filter: string) => void;
  /** Statistics for badge counts */
  stats: TaskStatistics | null;
}

// =============================================================================
// Constants
// =============================================================================

/** Primary filter chip definitions */
const PRIMARY_FILTERS: Array<{ value: PrimaryFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'needs_attention', label: 'Needs attention' },
  { value: 'completed', label: 'Completed' },
];

/** Advanced filter options */
const ADVANCED_FILTERS = [
  { value: 'classified', label: 'Ready' },
  { value: 'paused', label: 'Paused' },
  { value: 'cancelled', label: 'Stopped' },
  { value: 'L0', label: 'Quick' },
  { value: 'L1', label: 'Standard' },
  { value: 'L2', label: 'Complex' },
];

// =============================================================================
// Component
// =============================================================================

/**
 * Filter bar with search input, primary filter chips, and advanced filter dropdown.
 *
 * @param props - Component props
 * @returns Filter bar JSX element
 */
export const TaskFilters: React.FC<TaskFiltersProps> = ({
  activeFilter,
  onFilterChange,
  searchQuery,
  onSearchChange,
  advancedFilter,
  onAdvancedFilterChange,
  stats,
}) => {
  const [showAdvanced, setShowAdvanced] = useState(false);

  /**
   * Computes the count to display on a primary filter chip.
   *
   * @param filter - The primary filter value
   * @returns Count for the filter, or undefined if no stats
   */
  const getFilterCount = useCallback(
    (filter: PrimaryFilter): number | undefined => {
      if (!stats) return undefined;
      switch (filter) {
        case 'active':
          return (
            (stats.byStatus['classified'] ?? 0) +
            (stats.byStatus['in_progress'] ?? 0) +
            (stats.byStatus['paused'] ?? 0)
          );
        case 'needs_attention':
          return stats.byStatus['failed'] ?? 0;
        case 'completed':
          return stats.byStatus['completed'] ?? 0;
        case 'all':
          return stats.totalTasks;
        default:
          return undefined;
      }
    },
    [stats],
  );

  /**
   * Computes the count for an advanced filter option.
   *
   * @param value - The advanced filter value
   * @returns Count or undefined
   */
  const getAdvancedCount = useCallback(
    (value: string): number | undefined => {
      if (!stats) return undefined;
      if (stats.byStatus[value] !== undefined) return stats.byStatus[value];
      if (stats.byLevel[value] !== undefined) return stats.byLevel[value];
      return undefined;
    },
    [stats],
  );

  /** Toggle advanced filter panel */
  const handleToggleAdvanced = useCallback(() => {
    setShowAdvanced((prev) => !prev);
  }, []);

  /** Handle advanced chip click — toggle on/off */
  const handleAdvancedClick = useCallback(
    (value: string) => {
      onAdvancedFilterChange(advancedFilter === value ? '' : value);
    },
    [advancedFilter, onAdvancedFilterChange],
  );

  return (
    <div className="task-filters" data-testid="task-filters">
      <input
        type="text"
        className="task-search"
        placeholder="Search tasks or source messages..."
        aria-label="Search tasks"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        data-testid="task-search"
      />

      <div className="task-filter-chips" data-testid="task-filter-chips" role="group" aria-label="Task filters">
        {PRIMARY_FILTERS.map((f) => {
          const count = getFilterCount(f.value);
          const isActive = activeFilter === f.value && !advancedFilter;
          return (
            <button
              key={f.value}
              className={`task-filter-chip ${isActive ? 'task-filter-chip--active' : ''}`}
              onClick={() => {
                onFilterChange(f.value);
                onAdvancedFilterChange('');
              }}
              aria-pressed={isActive}
              data-testid={`filter-${f.value}`}
            >
              {f.label}
              {count !== undefined && (
                <span className="task-filter-chip-count">{count}</span>
              )}
            </button>
          );
        })}

        <button
          className={`task-filter-advanced-toggle ${showAdvanced ? 'task-filter-advanced-toggle--open' : ''}`}
          onClick={handleToggleAdvanced}
          aria-expanded={showAdvanced}
          data-testid="filter-advanced-toggle"
        >
          More filters {showAdvanced ? '▴' : '▾'}
        </button>
      </div>

      {showAdvanced && (
        <div className="task-filter-advanced-panel" data-testid="filter-advanced-panel" role="group" aria-label="Advanced filters">
          {ADVANCED_FILTERS.map((f) => {
            const count = getAdvancedCount(f.value);
            const isActive = advancedFilter === f.value;
            return (
              <button
                key={f.value}
                className={`task-filter-chip ${isActive ? 'task-filter-chip--active' : ''}`}
                onClick={() => handleAdvancedClick(f.value)}
                aria-pressed={isActive}
                data-testid={`filter-adv-${f.value}`}
              >
                {f.label}
                {count !== undefined && (
                  <span className="task-filter-chip-count">{count}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TaskFilters;
