/**
 * CronJobPanel Component
 *
 * Manages cron tasks with create/toggle/delete actions, human-readable
 * schedule descriptions, responsive card+table layout, and confirmation dialogs.
 *
 * @module components/Settings/CronJobPanel
 */

import React, { useCallback, useState } from 'react';
import {
  Trash2, Clock, RefreshCw, AlertCircle,
  Plus, Play, Pause, CalendarClock, Timer, X,
} from 'lucide-react';
import { useCronTasks } from '../../hooks/useCronTasks';
import { Button } from '../UI/Button';
import { LoadingSpinner } from '../UI/LoadingSpinner';
import { Badge } from '../UI/Badge';
import { Modal, ModalFooter } from '../UI/Modal';
import { Input } from '../UI/Input';
import { FormLabel, FormSelect } from '../UI/Form';
import type { CronTask, CreateCronTaskRequest } from '../../types/cron-task.types';

// ========================= Cron Expression Helpers =========================

/** Common cron presets for the create form */
const CRON_PRESETS: { label: string; value: string }[] = [
  { label: 'Every minute', value: '* * * * *' },
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily at 9:00 AM', value: '0 9 * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
  { label: 'Weekdays at 9:00 AM', value: '0 9 * * 1-5' },
  { label: 'Every Monday at 9:00 AM', value: '0 9 * * 1' },
  { label: 'Monthly on the 1st', value: '0 0 1 * *' },
];

/** Day-of-week mapping for cron expressions */
const DOW_NAMES: Record<string, string> = {
  '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed',
  '4': 'Thu', '5': 'Fri', '6': 'Sat', '7': 'Sun',
  SUN: 'Sun', MON: 'Mon', TUE: 'Tue', WED: 'Wed',
  THU: 'Thu', FRI: 'Fri', SAT: 'Sat',
};

/**
 * Converts a cron expression to a human-readable description.
 *
 * Handles common patterns: every-N-minutes, hourly, daily, weekly, monthly, weekdays.
 * Falls back to raw expression for complex patterns.
 *
 * @param expr - Standard 5-field cron expression
 * @returns Human-readable schedule description
 */
export function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, , dow] = parts;

  // Every minute
  if (expr === '* * * * *') return 'Every minute';

  // Every N minutes
  const everyMinMatch = min.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === '*' && dom === '*' && dow === '*') {
    const n = parseInt(everyMinMatch[1], 10);
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  // Every N hours
  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (min === '0' && everyHourMatch && dom === '*' && dow === '*') {
    const n = parseInt(everyHourMatch[1], 10);
    return n === 1 ? 'Every hour' : `Every ${n} hours`;
  }

  // Hourly at :MM
  if (hour === '*' && dom === '*' && dow === '*' && /^\d+$/.test(min)) {
    const m = parseInt(min, 10);
    return m === 0 ? 'Every hour' : `Every hour at :${min.padStart(2, '0')}`;
  }

  // Fixed time patterns
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const timeStr = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;

    // Monthly
    if (/^\d+$/.test(dom) && dow === '*') {
      const d = parseInt(dom, 10);
      const suffix = d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th';
      return `Monthly on the ${d}${suffix} at ${timeStr}`;
    }

    // Daily
    if (dom === '*' && dow === '*') {
      return `Daily at ${timeStr}`;
    }

    // Weekdays (Mon-Fri)
    if (dom === '*' && (dow === '1-5' || dow === 'MON-FRI')) {
      return `Weekdays at ${timeStr}`;
    }

    // Specific day of week
    if (dom === '*' && dow !== '*') {
      const dayName = DOW_NAMES[dow.toUpperCase()] || DOW_NAMES[dow] || dow;
      return `Every ${dayName} at ${timeStr}`;
    }
  }

  return expr;
}

// ========================= Time Formatting =========================

/**
 * Formats an ISO timestamp to a human-readable relative past-time string.
 *
 * @param iso - ISO timestamp string or null
 * @returns Formatted relative time or dash for null
 */
function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

/**
 * Formats a future ISO timestamp to a relative time string.
 *
 * @param iso - ISO timestamp string or null
 * @returns Formatted future time or dash for null
 */
function formatNextRun(iso: string | null): string {
  if (!iso) return '—';
  const diffMs = new Date(iso).getTime() - Date.now();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 0) return 'Overdue';
  if (diffMin < 1) return 'Imminent';
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `in ${diffHours}h`;
  return `in ${Math.floor(diffHours / 24)}d`;
}

// ========================= Sub-Components =========================

interface CronJobCardProps {
  task: CronTask;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}

/**
 * Mobile-friendly card for a single cron task.
 *
 * @param props - Task data and action handlers
 * @returns Card element for responsive layout
 */
const CronJobCard: React.FC<CronJobCardProps> = ({ task, onToggle, onDelete }) => {
  return (
    <div className="bg-surface-dark border border-border-dark rounded-lg p-5 hover:shadow-lg hover:border-primary/50 transition-all">
      {/* Header: description + status */}
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 mr-2">
          <p className="text-lg font-semibold text-text-primary-dark truncate" title={task.taskDescription}>
            {task.taskDescription}
          </p>
          <p className="text-xs text-text-secondary-dark mt-0.5">{task.targetAgent}</p>
        </div>
        <Badge variant={task.enabled ? 'success' : 'default'}>
          {task.enabled ? 'Active' : 'Disabled'}
        </Badge>
      </div>

      {/* Schedule */}
      <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-md bg-surface-dark/50">
        <CalendarClock className="w-3.5 h-3.5 text-text-secondary-dark shrink-0" />
        <span className="text-xs text-text-primary-dark">{cronToHuman(task.cronExpression)}</span>
        <code className="text-xs text-text-secondary-dark ml-auto hidden sm:inline">{task.cronExpression}</code>
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
        <div className="flex justify-between">
          <span className="text-text-secondary-dark">Timezone</span>
          <span className="text-text-primary-dark">{task.timezone}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-secondary-dark">Created by</span>
          <span className="text-text-primary-dark capitalize">{task.createdBy}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-secondary-dark">Last run</span>
          <span className="text-text-primary-dark">{formatTime(task.lastRunAt)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-secondary-dark">Next run</span>
          <span className={`${task.nextRunAt && new Date(task.nextRunAt).getTime() - Date.now() < 600_000 ? 'text-yellow-400' : 'text-text-primary-dark'}`}>
            {formatNextRun(task.nextRunAt)}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-3 border-t border-border-dark">
        <Button
          variant={task.enabled ? 'ghost' : 'ghost'}
          size="sm"
          icon={task.enabled ? Pause : Play}
          onClick={() => onToggle(task.id, !task.enabled)}
          aria-label={task.enabled ? 'Disable cron task' : 'Enable cron task'}
        >
          {task.enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button
          variant="danger-ghost"
          size="sm"
          icon={Trash2}
          onClick={() => onDelete(task.id)}
          aria-label="Delete cron task"
          className="ml-auto"
        >
          Delete
        </Button>
      </div>
    </div>
  );
};

interface CronJobRowProps {
  task: CronTask;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}

/**
 * Desktop table row for a single cron task with human-readable schedule.
 *
 * @param props - Task data and action handlers
 * @returns Table row element
 */
const CronJobRow: React.FC<CronJobRowProps> = ({ task, onToggle, onDelete }) => {
  return (
    <tr className="border-b border-border-dark hover:bg-surface-dark/50 transition-colors">
      <td className="px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-text-primary-dark truncate max-w-xs" title={task.taskDescription}>
            {task.taskDescription}
          </span>
          <span className="text-xs text-text-secondary-dark">{task.targetAgent}</span>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-text-primary-dark">{cronToHuman(task.cronExpression)}</span>
          <code className="text-xs text-text-secondary-dark">{task.cronExpression}</code>
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-text-secondary-dark">{task.timezone}</td>
      <td className="px-4 py-3 text-sm text-text-secondary-dark">{formatTime(task.lastRunAt)}</td>
      <td className="px-4 py-3">
        <span className={`text-sm ${task.nextRunAt && new Date(task.nextRunAt).getTime() - Date.now() < 600_000 ? 'text-yellow-400' : 'text-text-secondary-dark'}`}>
          {formatNextRun(task.nextRunAt)}
        </span>
      </td>
      <td className="px-4 py-3">
        <Badge variant={task.enabled ? 'success' : 'default'}>
          {task.enabled ? 'Active' : 'Disabled'}
        </Badge>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1">
          <button
            onClick={() => onToggle(task.id, !task.enabled)}
            className="p-1.5 rounded hover:bg-surface-dark transition-colors text-text-secondary-dark hover:text-text-primary-dark"
            aria-label={task.enabled ? 'Disable cron task' : 'Enable cron task'}
            title={task.enabled ? 'Disable' : 'Enable'}
          >
            {task.enabled ? <Pause className="w-4 h-4 text-green-400" /> : <Play className="w-4 h-4" />}
          </button>
          <button
            onClick={() => onDelete(task.id)}
            className="p-1.5 rounded hover:bg-red-500/10 transition-colors text-text-secondary-dark hover:text-red-400"
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

// ========================= Create Modal =========================

interface CreateCronJobModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (request: CreateCronTaskRequest) => Promise<unknown>;
}

/**
 * Modal form for creating a new cron task.
 *
 * Provides preset schedule picker and custom cron expression input,
 * timezone selection, and target agent configuration.
 *
 * @param props - Modal open state and handlers
 * @returns Modal component
 */
const CreateCronJobModal: React.FC<CreateCronJobModalProps> = ({ isOpen, onClose, onCreate }) => {
  const [taskDescription, setTaskDescription] = useState('');
  const [cronExpression, setCronExpression] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [targetAgent, setTargetAgent] = useState('');
  const [targetTeamId, setTargetTeamId] = useState('');
  const [useCustomCron, setUseCustomCron] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const resetForm = () => {
    setTaskDescription('');
    setCronExpression('0 9 * * *');
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setTargetAgent('');
    setTargetTeamId('');
    setUseCustomCron(false);
    setIsSubmitting(false);
    setFormError('');
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (!taskDescription.trim()) {
      setFormError('Task description is required');
      return;
    }
    if (!cronExpression.trim()) {
      setFormError('Schedule is required');
      return;
    }
    if (!targetAgent.trim()) {
      setFormError('Target agent is required');
      return;
    }

    setIsSubmitting(true);
    try {
      await onCreate({
        cronExpression: cronExpression.trim(),
        timezone,
        targetAgent: targetAgent.trim(),
        targetTeamId: targetTeamId.trim() || 'default',
        taskDescription: taskDescription.trim(),
        createdBy: 'user',
      });
      handleClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create cron job');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Create Cron Job" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Task Description */}
        <Input
          label="Task Description"
          placeholder="e.g., Daily standup reminder"
          value={taskDescription}
          onChange={(e) => setTaskDescription(e.target.value)}
          fullWidth
          required
        />

        {/* Schedule */}
        <div>
          <FormLabel required>Schedule</FormLabel>
          <div className="flex items-center gap-2 mb-2">
            <button
              type="button"
              className={`text-xs px-3 py-1.5 rounded-md transition-colors ${!useCustomCron ? 'bg-primary text-white' : 'bg-surface-dark text-text-secondary-dark hover:text-text-primary-dark'}`}
              onClick={() => setUseCustomCron(false)}
            >
              Presets
            </button>
            <button
              type="button"
              className={`text-xs px-3 py-1.5 rounded-md transition-colors ${useCustomCron ? 'bg-primary text-white' : 'bg-surface-dark text-text-secondary-dark hover:text-text-primary-dark'}`}
              onClick={() => setUseCustomCron(true)}
            >
              Custom
            </button>
          </div>

          {useCustomCron ? (
            <Input
              placeholder="e.g., 0 9 * * 1-5"
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              helperText={`Preview: ${cronToHuman(cronExpression)}`}
              fullWidth
            />
          ) : (
            <FormSelect
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
            >
              {CRON_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label} ({preset.value})
                </option>
              ))}
            </FormSelect>
          )}
        </div>

        {/* Timezone */}
        <Input
          label="Timezone"
          placeholder="e.g., Asia/Shanghai"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          helperText="IANA timezone identifier"
          fullWidth
        />

        {/* Target Agent */}
        <Input
          label="Target Agent"
          placeholder="e.g., crewly-product-sam-217bfbbf"
          value={targetAgent}
          onChange={(e) => setTargetAgent(e.target.value)}
          helperText="Agent session name to execute this task"
          fullWidth
          required
        />

        {/* Target Team ID */}
        <Input
          label="Team ID"
          placeholder="e.g., team-001 (optional)"
          value={targetTeamId}
          onChange={(e) => setTargetTeamId(e.target.value)}
          helperText="Leave empty for default team"
          fullWidth
        />

        {/* Error */}
        {formError && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span className="text-sm text-red-400">{formError}</span>
          </div>
        )}

        <ModalFooter>
          <Button variant="ghost" onClick={handleClose} type="button">Cancel</Button>
          <Button variant="primary" type="submit" loading={isSubmitting} icon={Plus}>
            Create
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
};

// ========================= Delete Confirmation Modal =========================

interface DeleteConfirmModalProps {
  isOpen: boolean;
  task: CronTask | null;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * Confirmation dialog before deleting a cron task.
 *
 * @param props - Modal state and handlers
 * @returns Confirmation modal component
 */
const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({ isOpen, task, onClose, onConfirm }) => {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Delete Cron Job" size="sm">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary-dark">
          Are you sure you want to delete this cron job? This action cannot be undone.
        </p>
        {task && (
          <div className="p-3 rounded-lg bg-surface-dark border border-border-dark">
            <p className="text-sm font-medium text-text-primary-dark">{task.taskDescription}</p>
            <p className="text-xs text-text-secondary-dark mt-1">{cronToHuman(task.cronExpression)} &middot; {task.timezone}</p>
          </div>
        )}
        <ModalFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} icon={Trash2}>Delete</Button>
        </ModalFooter>
      </div>
    </Modal>
  );
};

// ========================= Summary Stats =========================

interface SummaryStatsProps {
  tasks: CronTask[];
}

/**
 * Summary statistics bar showing active count and next upcoming run.
 *
 * @param props - Task list for computing stats
 * @returns Summary stats strip
 */
const SummaryStats: React.FC<SummaryStatsProps> = ({ tasks }) => {
  const activeCount = tasks.filter((t) => t.enabled).length;
  const nextRun = tasks
    .filter((t) => t.enabled && t.nextRunAt)
    .map((t) => ({ task: t, time: new Date(t.nextRunAt!).getTime() }))
    .sort((a, b) => a.time - b.time)[0];

  return (
    <div className="flex flex-wrap items-center gap-4 px-4 py-3 rounded-lg bg-surface-dark/50 border border-border-dark mb-4">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-green-400" />
        <span className="text-xs text-text-secondary-dark">
          <span className="text-text-primary-dark font-medium">{activeCount}</span> active of {tasks.length} total
        </span>
      </div>
      {nextRun && (
        <div className="flex items-center gap-2">
          <Timer className="w-3.5 h-3.5 text-text-secondary-dark" />
          <span className="text-xs text-text-secondary-dark">
            Next: <span className="text-text-primary-dark">{nextRun.task.taskDescription}</span> {formatNextRun(nextRun.task.nextRunAt)}
          </span>
        </div>
      )}
    </div>
  );
};

// ========================= Main Component =========================

/**
 * Panel displaying all cron tasks with management actions.
 *
 * Features:
 * - Summary stats (active count, next upcoming run)
 * - Responsive layout: card grid on mobile, table on desktop
 * - Human-readable schedule descriptions alongside raw cron expressions
 * - Create modal with preset/custom schedule picker
 * - Delete confirmation dialog
 * - Toggle enable/disable with Pause/Play icons
 *
 * @returns CronJobPanel component
 */
export const CronJobPanel: React.FC = () => {
  const { tasks, isLoading, error, refresh, createTask, updateTask, deleteTask } = useCronTasks();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CronTask | null>(null);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    await updateTask(id, { enabled });
  }, [updateTask]);

  const handleDeleteClick = useCallback((id: string) => {
    const task = tasks.find((t) => t.id === id) || null;
    setDeleteTarget(task);
  }, [tasks]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    await deleteTask(deleteTarget.id);
    setDeleteTarget(null);
  }, [deleteTarget, deleteTask]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner size="sm" text="Loading cron jobs..." />
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
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={refresh} icon={RefreshCw}>
            Refresh
          </Button>
          <Button variant="primary" size="sm" onClick={() => setShowCreateModal(true)} icon={Plus}>
            Create
          </Button>
        </div>
      </div>

      {/* Summary Stats */}
      {tasks.length > 0 && <SummaryStats tasks={tasks} />}

      {tasks.length === 0 ? (
        <div className="text-center py-12 text-text-secondary-dark">
          <Clock className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm">No cron jobs configured</p>
          <p className="text-xs mt-1 opacity-60">Create your first scheduled task to automate agent workflows</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCreateModal(true)}
            icon={Plus}
            className="mt-4"
          >
            Create Cron Job
          </Button>
        </div>
      ) : (
        <>
          {/* Mobile: Card layout */}
          <div className="grid grid-cols-1 gap-3 md:hidden">
            {tasks.map((task) => (
              <CronJobCard
                key={task.id}
                task={task}
                onToggle={handleToggle}
                onDelete={handleDeleteClick}
              />
            ))}
          </div>

          {/* Desktop: Table layout */}
          <div className="hidden md:block overflow-x-auto rounded-lg border border-border-dark">
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
                    onDelete={handleDeleteClick}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Create Modal */}
      <CreateCronJobModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={createTask}
      />

      {/* Delete Confirmation Modal */}
      <DeleteConfirmModal
        isOpen={deleteTarget !== null}
        task={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
};

export default CronJobPanel;
