/**
 * TaskUsageTable Component
 *
 * Displays token usage data aggregated by task ID in a sortable table.
 * Shows task name, total tokens (input + output), cost, and event count.
 *
 * @module components/Monitoring/TaskUsageTable
 */

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../services/api.service';
import type { TaskUsageSummary } from '../../types';

/** Sort field options */
type SortField = 'taskId' | 'totalInput' | 'totalOutput' | 'cost' | 'eventCount';

/** Sort direction */
type SortDir = 'asc' | 'desc';

/**
 * Format a number of tokens with thousand separators.
 *
 * @param n - Number to format
 * @returns Formatted string (e.g. "12,345")
 */
function formatTokens(n: number): string {
  return n.toLocaleString();
}

/**
 * Format a cost value in USD.
 *
 * @param cost - Cost in USD
 * @returns Formatted string (e.g. "$0.0523")
 */
function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * TaskUsageTable displays per-task token consumption data.
 *
 * Fetches data from GET /api/monitoring/token-usage/by-task and renders
 * a sortable table with task ID, input/output tokens, total cost, and
 * event count columns.
 *
 * @returns Task usage table component
 */
export const TaskUsageTable: React.FC = () => {
  const [tasks, setTasks] = useState<TaskUsageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>('cost');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  /**
   * Fetch task usage data from the API.
   */
  const fetchData = useCallback(async () => {
    try {
      const data = await apiService.getTokenUsageByTask();
      setTasks(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load task usage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  /**
   * Handle column header click to toggle sort.
   */
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const sorted = [...tasks].sort((a, b) => {
    const aVal = a[sortField];
    const bVal = b[sortField];
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    const numA = aVal as number;
    const numB = bVal as number;
    return sortDir === 'asc' ? numA - numB : numB - numA;
  });

  const sortIndicator = (field: SortField) => {
    if (sortField !== field) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  if (loading) {
    return (
      <div className="bg-surface-dark rounded-lg border border-border-dark p-6 text-center">
        <p className="text-text-secondary-dark">Loading task usage data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-surface-dark rounded-lg border border-red-500/50 p-6 text-center">
        <p className="text-red-400">{error}</p>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="bg-surface-dark rounded-lg border border-border-dark p-6 text-center" data-testid="task-usage-empty">
        <p className="text-text-secondary-dark">No per-task usage data yet. Token tracking must be enabled in Settings.</p>
      </div>
    );
  }

  return (
    <div className="bg-surface-dark rounded-lg border border-border-dark overflow-hidden" data-testid="task-usage-table">
      <div className="px-4 py-3 border-b border-border-dark">
        <h3 className="text-sm font-semibold text-text-primary-dark">Usage by Task</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-text-secondary-dark border-b border-border-dark">
              <th className="px-4 py-2 cursor-pointer hover:text-text-primary-dark" onClick={() => handleSort('taskId')}>
                Task{sortIndicator('taskId')}
              </th>
              <th className="px-4 py-2 cursor-pointer hover:text-text-primary-dark text-right" onClick={() => handleSort('totalInput')}>
                Input Tokens{sortIndicator('totalInput')}
              </th>
              <th className="px-4 py-2 cursor-pointer hover:text-text-primary-dark text-right" onClick={() => handleSort('totalOutput')}>
                Output Tokens{sortIndicator('totalOutput')}
              </th>
              <th className="px-4 py-2 cursor-pointer hover:text-text-primary-dark text-right" onClick={() => handleSort('cost')}>
                Cost{sortIndicator('cost')}
              </th>
              <th className="px-4 py-2 cursor-pointer hover:text-text-primary-dark text-right" onClick={() => handleSort('eventCount')}>
                Events{sortIndicator('eventCount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(task => (
              <tr key={task.taskId} className="border-b border-border-dark/50 hover:bg-background-dark/50">
                <td className="px-4 py-2 text-text-primary-dark font-mono text-xs truncate max-w-[200px]" title={task.taskId}>
                  {task.taskId === 'unassigned' ? (
                    <span className="text-text-secondary-dark italic">Unassigned</span>
                  ) : task.taskId}
                </td>
                <td className="px-4 py-2 text-right text-text-secondary-dark">{formatTokens(task.totalInput)}</td>
                <td className="px-4 py-2 text-right text-text-secondary-dark">{formatTokens(task.totalOutput)}</td>
                <td className="px-4 py-2 text-right text-green-400 font-medium">{formatCost(task.cost)}</td>
                <td className="px-4 py-2 text-right text-text-secondary-dark">{task.eventCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default TaskUsageTable;
