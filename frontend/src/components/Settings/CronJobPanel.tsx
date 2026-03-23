/**
 * CronJobPanel Component
 *
 * Displays a table of cron tasks with enable/disable toggle and delete actions.
 * Uses the useCronTasks hook for data fetching and mutations.
 *
 * @module components/Settings/CronJobPanel
 */

import React, { useCallback } from 'react';
import { Trash2, ToggleLeft, ToggleRight, Clock, RefreshCw, AlertCircle, Loader2 } from 'lucide-react';
import { useCronTasks } from '../../hooks/useCronTasks';
import { Button } from '../UI/Button';
import type { CronTask } from '../../types/cron-task.types';

// ========================= Helpers =========================

/**
 * Formats an ISO timestamp to a human-readable relative time string.
 *
 * @param iso - ISO timestamp string or null
 * @returns Formatted relative time or dash for null
 */
function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * Formats a future ISO timestamp to a short display string.
 *
 * @param iso - ISO timestamp string or null
 * @returns Formatted date/time or dash for null
 */
function formatNextRun(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 0) return 'Overdue';
  if (diffMin < 1) return 'Imminent';
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `in ${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `in ${diffDays}d`;
}

// ========================= Sub-Components =========================

/**
 * Props for a single CronJobRow
 */
interface CronJobRowProps {
  task: CronTask;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}

/**
 * Single row in the cron job table
 *
 * @param props - Task data and action handlers
 * @returns Table row element
 */
const CronJobRow: React.FC<CronJobRowProps> = ({ task, onToggle, onDelete }) => {
  return (
    <tr className="border-b border-border-dark hover:bg-surface-dark/50 transition-colors">
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text-primary-dark truncate max-w-xs" title={task.taskDescription}>
            {task.taskDescription}
          </span>
          <span className="text-xs text-text-secondary-dark">
            {task.targetAgent}
          </span>
        </div>
      </td>
      <td className="px-4 py-3">
        <code className="text-xs bg-surface-dark px-2 py-1 rounded text-text-secondary-dark">
          {task.cronExpression}
        </code>
      </td>
      <td className="px-4 py-3 text-sm text-text-secondary-dark">
        {task.timezone}
      </td>
      <td className="px-4 py-3 text-sm text-text-secondary-dark">
        {formatTime(task.lastRunAt)}
      </td>
      <td className="px-4 py-3 text-sm text-text-secondary-dark">
        {formatNextRun(task.nextRunAt)}
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
            task.enabled
              ? 'bg-green-500/10 text-green-400'
              : 'bg-gray-500/10 text-gray-400'
          }`}
        >
          {task.enabled ? 'Active' : 'Disabled'}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => onToggle(task.id, !task.enabled)}
            className="p-1 rounded hover:bg-surface-dark transition-colors text-text-secondary-dark hover:text-text-primary-dark"
            aria-label={task.enabled ? 'Disable cron task' : 'Enable cron task'}
            title={task.enabled ? 'Disable' : 'Enable'}
          >
            {task.enabled ? <ToggleRight className="w-5 h-5 text-green-400" /> : <ToggleLeft className="w-5 h-5" />}
          </button>
          <button
            onClick={() => onDelete(task.id)}
            className="p-1 rounded hover:bg-red-500/10 transition-colors text-text-secondary-dark hover:text-red-400"
            aria-label="Delete cron task"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
  );
};

// ========================= Main Component =========================

/**
 * Panel displaying all cron tasks in a table with management actions.
 *
 * Shows a loading spinner while fetching, an error alert on failure,
 * and an empty state when no tasks exist.
 *
 * @returns CronJobPanel component
 */
export const CronJobPanel: React.FC = () => {
  const { tasks, isLoading, error, refresh, updateTask, deleteTask } = useCronTasks();

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    await updateTask(id, { enabled });
  }, [updateTask]);

  const handleDelete = useCallback(async (id: string) => {
    await deleteTask(id);
  }, [deleteTask]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-text-secondary-dark" />
        <span className="ml-2 text-sm text-text-secondary-dark">Loading cron jobs...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 border border-red-500/20">
        <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
        <span className="text-sm text-red-400">{error}</span>
      </div>
    );
  }

  return (
    <div>
      {/* Section Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-text-secondary-dark" />
          <h3 className="text-lg font-semibold text-text-primary-dark">Cron Jobs</h3>
          <span className="text-xs text-text-secondary-dark bg-surface-dark px-2 py-0.5 rounded-full">
            {tasks.length}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={refresh} icon={RefreshCw}>
          Refresh
        </Button>
      </div>

      {tasks.length === 0 ? (
        <div className="text-center py-12 text-text-secondary-dark">
          <Clock className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm">No cron jobs configured</p>
          <p className="text-xs mt-1 opacity-60">Cron jobs will appear here when created by the orchestrator or via API</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-dark">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border-dark bg-surface-dark/50">
                <th className="px-4 py-3 text-xs font-medium text-text-secondary-dark uppercase tracking-wider">Task</th>
                <th className="px-4 py-3 text-xs font-medium text-text-secondary-dark uppercase tracking-wider">Schedule</th>
                <th className="px-4 py-3 text-xs font-medium text-text-secondary-dark uppercase tracking-wider">Timezone</th>
                <th className="px-4 py-3 text-xs font-medium text-text-secondary-dark uppercase tracking-wider">Last Run</th>
                <th className="px-4 py-3 text-xs font-medium text-text-secondary-dark uppercase tracking-wider">Next Run</th>
                <th className="px-4 py-3 text-xs font-medium text-text-secondary-dark uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-xs font-medium text-text-secondary-dark uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <CronJobRow
                  key={task.id}
                  task={task}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default CronJobPanel;
