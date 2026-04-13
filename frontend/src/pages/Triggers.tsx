/**
 * Triggers Page
 *
 * Unified V3 Trigger management UI. Shows:
 * - Legacy CronTask jobs (user-created scheduled agent tasks)
 * - User/orchestrator-created V3 TriggerEngine triggers
 * System triggers (reconciler etc.) are hidden.
 *
 * @module pages/Triggers
 */

import React, { useState, useEffect } from 'react';
import {
  Clock,
  Zap,
  GitBranch,
  Play,
  Pause,
  XCircle,
  Trash2,
  Plus,
  RefreshCw,
  Activity,
  Bot,
  Users,
  List,
} from 'lucide-react';
import { Button, Modal, ModalBody, ModalFooter, useConfirm, StatusBadge, Alert, PageToolbar } from '../components/UI';
import type { StatusType } from '../components/UI/StatusBadge';
import { useTriggers } from '../hooks/useTriggers';
import { useCronTasks } from '../hooks/useCronTasks';
import { apiService } from '../services/api.service';
import { formatDate, triggerConfigSummary, triggerActionSummary } from '../components/Triggers/helpers';
import type { Trigger, TriggerType, CreateTriggerInput, EventSubscription } from '../types/trigger.types';
import type { CronTask } from '../types/cron-task.types';

/**
 * Maps trigger status to shared StatusBadge StatusType.
 */
function mapTriggerStatus(status: string): StatusType {
  switch (status) {
    case 'active': return 'active';
    case 'paused': return 'paused';
    case 'exhausted': return 'completed';
    case 'cancelled': return 'inactive';
    default: return 'pending';
  }
}

// =============================================================================
// Helpers
// =============================================================================

function triggerTypeIcon(type: TriggerType): React.ReactNode {
  switch (type) {
    case 'time': return <Clock className="w-3.5 h-3.5" />;
    case 'signal': return <Zap className="w-3.5 h-3.5" />;
    case 'compound': return <GitBranch className="w-3.5 h-3.5" />;
  }
}

// =============================================================================
// CronTask Row
// =============================================================================

interface CronTaskRowProps {
  task: CronTask;
  teamMap: Record<string, string>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onDelete: (id: string) => void;
}

const CronTaskRow: React.FC<CronTaskRowProps> = ({ task, teamMap, onToggle, onDelete }) => {
  const [busy, setBusy] = useState(false);

  const handleToggle = async () => {
    setBusy(true);
    try { await onToggle(task.id, !task.enabled); } finally { setBusy(false); }
  };

  const desc = task.taskDescription || (task as any).command || (task as any).name || task.id;
  const displayName = desc.length > 55 ? desc.slice(0, 55) + '…' : desc;
  const cronExpr = task.cronExpression || (task as any).schedule || '—';
  const teamId = task.targetTeamId || (task as any).owner?.split('-').slice(0, -1).join('-') || '';
  const teamName = teamMap[teamId] || (teamId ? teamId : '—');

  return (
    <tr className="border-t border-border-dark hover:bg-background-dark/40 transition-colors">
      {/* Type */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary-dark">
          <Clock className="w-3.5 h-3.5" />
          Time
        </span>
      </td>

      {/* Team */}
      <td className="px-4 py-3 whitespace-nowrap text-xs text-text-secondary-dark max-w-[120px] hidden sm:table-cell">
        <span className="truncate block" title={teamName}>{teamName}</span>
      </td>

      {/* Schedule */}
      <td className="px-4 py-3 text-xs font-mono text-text-primary-dark whitespace-nowrap">
        {cronExpr}
        {task.timezone && (
          <span className="ml-1.5 text-[10px] text-text-secondary-dark">{task.timezone}</span>
        )}
      </td>

      {/* Task */}
      <td className="px-4 py-3 text-sm text-text-secondary-dark max-w-[220px] hidden md:table-cell">
        <div className="flex items-center gap-1.5">
          <Bot className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate" title={desc}>{displayName}</span>
        </div>
      </td>

      {/* Status */}
      <td className="px-4 py-3 whitespace-nowrap">
        <StatusBadge status={task.enabled ? 'active' : 'paused'} />
      </td>

      {/* Next Fire */}
      <td className="px-4 py-3 whitespace-nowrap text-xs text-text-secondary-dark hidden lg:table-cell">
        {formatDate(task.nextRunAt)}
      </td>

      {/* Last Fire */}
      <td className="px-4 py-3 whitespace-nowrap text-xs text-text-secondary-dark hidden lg:table-cell">
        {formatDate(task.lastRunAt)}
      </td>

      {/* Actions */}
      <td className="px-4 py-3 whitespace-nowrap">
        <div className="flex items-center gap-1">
          <button
            onClick={handleToggle}
            disabled={busy}
            title={task.enabled ? 'Pause' : 'Resume'}
            className={`p-1 rounded transition-colors disabled:opacity-40 ${
              task.enabled
                ? 'text-text-secondary-dark hover:text-yellow-400 hover:bg-yellow-500/10'
                : 'text-text-secondary-dark hover:text-green-400 hover:bg-green-500/10'
            }`}
          >
            {task.enabled
              ? <Pause className="w-3.5 h-3.5" />
              : <Play className="w-3.5 h-3.5" />
            }
          </button>
          <button
            onClick={() => onDelete(task.id)}
            disabled={busy}
            title="Delete"
            className="p-1 rounded text-text-secondary-dark hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
};

// =============================================================================
// Trigger Row (V3 TriggerEngine)
// =============================================================================

interface TriggerRowProps {
  trigger: Trigger;
  onPause: (id: string) => Promise<Trigger>;
  onResume: (id: string) => Promise<Trigger>;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
}

const TriggerRow: React.FC<TriggerRowProps> = ({ trigger, onPause, onResume, onCancel, onDelete }) => {
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <tr className="border-t border-border-dark hover:bg-background-dark/40 transition-colors">
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary-dark">
          {triggerTypeIcon(trigger.type)}
          <span className="capitalize">{trigger.type}</span>
        </span>
      </td>

      {/* Team — V3 triggers show createdBy */}
      <td className="px-4 py-3 whitespace-nowrap text-xs text-text-secondary-dark hidden sm:table-cell">
        <span className="capitalize">{trigger.createdBy}</span>
      </td>

      <td className="px-4 py-3 text-xs font-mono text-text-primary-dark max-w-[200px]">
        <span className="truncate block" title={triggerConfigSummary(trigger)}>
          {triggerConfigSummary(trigger)}
        </span>
      </td>

      <td className="px-4 py-3 text-sm text-text-secondary-dark max-w-[180px] hidden md:table-cell">
        <span className="truncate block">{triggerActionSummary(trigger)}</span>
      </td>

      <td className="px-4 py-3 whitespace-nowrap">
        <StatusBadge status={mapTriggerStatus(trigger.status)}>{trigger.status}</StatusBadge>
      </td>

      <td className="px-4 py-3 whitespace-nowrap text-xs text-text-secondary-dark hidden lg:table-cell">
        {formatDate(trigger.nextFireAt)}
      </td>

      <td className="px-4 py-3 whitespace-nowrap text-xs text-text-secondary-dark hidden lg:table-cell">
        {formatDate(trigger.lastFiredAt)}
      </td>

      <td className="px-4 py-3 whitespace-nowrap">
        <div className="flex items-center gap-1">
          {trigger.status === 'active' && (
            <button onClick={() => act(() => onPause(trigger.id))} disabled={busy} title="Pause"
              className="p-1 rounded text-text-secondary-dark hover:text-yellow-400 hover:bg-yellow-500/10 transition-colors disabled:opacity-40">
              <Pause className="w-3.5 h-3.5" />
            </button>
          )}
          {trigger.status === 'paused' && (
            <button onClick={() => act(() => onResume(trigger.id))} disabled={busy} title="Resume"
              className="p-1 rounded text-text-secondary-dark hover:text-green-400 hover:bg-green-500/10 transition-colors disabled:opacity-40">
              <Play className="w-3.5 h-3.5" />
            </button>
          )}
          {(trigger.status === 'active' || trigger.status === 'paused') && (
            <button onClick={() => onCancel(trigger.id)} disabled={busy} title="Cancel"
              className="p-1 rounded text-text-secondary-dark hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40">
              <XCircle className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={() => onDelete(trigger.id)} disabled={busy} title="Delete"
            className="p-1 rounded text-text-secondary-dark hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
};

// =============================================================================
// EventSubscription Row (read-only display)
// =============================================================================

interface EventSubRowProps {
  sub: EventSubscription;
}

const EventSubRow: React.FC<EventSubRowProps> = ({ sub }) => {
  const session = sub.subscriberSession;
  const isSystem = session === '__reconciler__';

  return (
    <tr className="border-t border-border-dark hover:bg-background-dark/40 transition-colors">
      {/* Type */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary-dark">
          <Zap className="w-3.5 h-3.5" />
          Signal
        </span>
      </td>

      {/* Team/subscriber */}
      <td className="px-4 py-3 whitespace-nowrap text-xs text-text-secondary-dark max-w-[120px]">
        <span className="truncate block" title={session}>{isSystem ? 'System' : session}</span>
      </td>

      {/* Event type */}
      <td className="px-4 py-3 text-xs font-mono text-text-primary-dark">
        {sub.eventType}
      </td>

      {/* Action */}
      <td className="px-4 py-3 text-sm text-text-secondary-dark">
        → {session}
      </td>

      {/* Status */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/15 text-green-400 border border-green-500/20">
          active
        </span>
      </td>

      {/* Next Fire */}
      <td className="px-4 py-3 whitespace-nowrap text-xs text-text-secondary-dark">
        {sub.expiresAt ? `Exp ${formatDate(sub.expiresAt)}` : '—'}
      </td>

      {/* Last Fire */}
      <td className="px-4 py-3 whitespace-nowrap text-xs text-text-secondary-dark">—</td>

      {/* Actions (read-only for event subscriptions) */}
      <td className="px-4 py-3 whitespace-nowrap text-xs text-text-secondary-dark">
        {sub.oneShot && <span className="text-[10px] text-yellow-400">one-shot</span>}
      </td>
    </tr>
  );
};

// =============================================================================
// Create Trigger Modal
// =============================================================================

interface CreateTriggerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: CreateTriggerInput) => Promise<void>;
}

const CreateTriggerModal: React.FC<CreateTriggerModalProps> = ({ isOpen, onClose, onCreate }) => {
  const [type, setType] = useState<TriggerType>('time');
  const [cronExpression, setCronExpression] = useState('0 9 * * 1-5');
  const [eventType, setEventType] = useState('agent:idle');
  const [messageTarget, setMessageTarget] = useState('');
  const [messageText, setMessageText] = useState('');
  const [maxFires, setMaxFires] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    setError('');
    if (type === 'time' && !cronExpression.trim()) { setError('Cron expression is required'); return; }
    if (type === 'signal' && !eventType.trim()) { setError('Event type is required'); return; }
    if (!messageTarget.trim() || !messageText.trim()) { setError('Message target and text are required'); return; }

    const config =
      type === 'time'
        ? { type: 'time' as const, cronExpression: cronExpression.trim() }
        : { type: 'signal' as const, eventType: eventType.trim() };

    const input: CreateTriggerInput = {
      type,
      config,
      action: { sendMessage: { target: messageTarget.trim(), message: messageText.trim() } },
      createdBy: 'user',
      maxFires: maxFires ? parseInt(maxFires, 10) : undefined,
    };

    try {
      setSubmitting(true);
      await onCreate(input);
      onClose();
      setCronExpression('0 9 * * 1-5');
      setEventType('agent:idle');
      setMessageTarget('');
      setMessageText('');
      setMaxFires('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create trigger');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New Trigger" size="md">
      <ModalBody>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Trigger Type</label>
            <div className="flex gap-2">
              {(['time', 'signal'] as TriggerType[]).map((t) => (
                <button key={t} onClick={() => setType(t)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border transition-colors capitalize ${
                    type === t
                      ? 'bg-accent-blue/15 border-accent-blue/40 text-accent-blue'
                      : 'bg-surface-dark border-border-dark text-text-secondary-dark hover:border-border-dark/80'
                  }`}>
                  {triggerTypeIcon(t)} {t}
                </button>
              ))}
            </div>
          </div>

          {type === 'time' && (
            <div>
              <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Cron Expression</label>
              <input className="w-full bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark font-mono focus:outline-none focus:border-accent-blue/50"
                value={cronExpression} onChange={(e) => setCronExpression(e.target.value)} placeholder="0 9 * * 1-5" />
              <p className="mt-1 text-xs text-text-secondary-dark">Standard 5-field cron (min hour dom month dow)</p>
            </div>
          )}

          {type === 'signal' && (
            <div>
              <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Event Type</label>
              <input className="w-full bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark font-mono focus:outline-none focus:border-accent-blue/50"
                value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="agent:idle" />
              <p className="mt-1 text-xs text-text-secondary-dark">EventBus event type (e.g. agent:idle, task:completed)</p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Send Message To</label>
            <input className="w-full bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark font-mono focus:outline-none focus:border-accent-blue/50"
              value={messageTarget} onChange={(e) => setMessageTarget(e.target.value)} placeholder="agent-session or #channel" />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Message</label>
            <textarea className="w-full bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark resize-none focus:outline-none focus:border-accent-blue/50"
              rows={3} value={messageText} onChange={(e) => setMessageText(e.target.value)} placeholder="What should the agent do?" />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Max Fires (optional)</label>
            <input type="number" min="1"
              className="w-32 bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark focus:outline-none focus:border-accent-blue/50"
              value={maxFires} onChange={(e) => setMaxFires(e.target.value)} placeholder="∞" />
            <p className="mt-1 text-xs text-text-secondary-dark">Leave blank for unlimited.</p>
          </div>

          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitting}>
          {submitting ? 'Creating…' : 'Create Trigger'}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

// =============================================================================
// Engine Status Bar
// =============================================================================

interface EngineStatusBarProps {
  running: boolean;
  totalUserTriggers: number;
  totalCronTasks: number;
  activeCount: number;
  pausedCount: number;
}

const EngineStatusBar: React.FC<EngineStatusBarProps> = ({
  running, totalUserTriggers, totalCronTasks, activeCount, pausedCount,
}) => (
  <div className="flex items-center gap-4 px-4 py-2.5 bg-surface-dark border border-border-dark rounded-lg text-xs text-text-secondary-dark flex-wrap">
    <span className="flex items-center gap-1.5">
      <Activity className={`w-3 h-3 ${running ? 'text-green-400' : 'text-yellow-400'}`} />
      Engine {running ? 'running' : 'stopped'}
    </span>
    <span className="text-border-dark">|</span>
    <span>{totalCronTasks} scheduled tasks</span>
    {totalUserTriggers > 0 && <span>{totalUserTriggers} V3 triggers</span>}
    <span className="text-border-dark">|</span>
    {activeCount > 0 && <span className="text-green-400">{activeCount} active</span>}
    {pausedCount > 0 && <span className="text-yellow-400">{pausedCount} paused</span>}
  </div>
);

// =============================================================================
// Filter + View Tabs
// =============================================================================

type FilterTab = 'all' | 'active' | 'paused';
type ViewMode = 'list' | 'team';

// =============================================================================
// Table Component (shared between list + team views)
// =============================================================================

interface TriggersTableProps {
  cronTasks: CronTask[];
  triggers: Trigger[];
  eventSubs: EventSubscription[];
  teamMap: Record<string, string>;
  onToggleCron: (id: string, enabled: boolean) => Promise<void>;
  onDeleteCron: (id: string) => void;
  onPause: (id: string) => Promise<Trigger>;
  onResume: (id: string) => Promise<Trigger>;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
}

const TriggersTable: React.FC<TriggersTableProps> = ({
  cronTasks, triggers, eventSubs, teamMap, onToggleCron, onDeleteCron, onPause, onResume, onCancel, onDelete,
}) => {
  if (cronTasks.length === 0 && triggers.length === 0 && eventSubs.length === 0) return null;
  return (
    <table className="min-w-full text-sm">
      <thead className="bg-background-dark/60 border-b border-border-dark">
        <tr>
          <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary-dark">Type</th>
          <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary-dark hidden sm:table-cell">Team</th>
          <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary-dark">Schedule / Event</th>
          <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary-dark hidden md:table-cell">Task / Action</th>
          <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary-dark">Status</th>
          <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary-dark hidden lg:table-cell">Next Fire</th>
          <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary-dark hidden lg:table-cell">Last Fire</th>
          <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary-dark">Actions</th>
        </tr>
      </thead>
      <tbody>
        {cronTasks.map((task) => (
          <CronTaskRow key={`cron-${task.id}`} task={task} teamMap={teamMap} onToggle={onToggleCron} onDelete={onDeleteCron} />
        ))}
        {triggers.map((trigger) => (
          <TriggerRow
            key={`trigger-${trigger.id}`}
            trigger={trigger}
            onPause={onPause}
            onResume={onResume}
            onCancel={onCancel}
            onDelete={onDelete}
          />
        ))}
        {eventSubs.map((sub) => (
          <EventSubRow key={`sub-${sub.id}`} sub={sub} />
        ))}
      </tbody>
    </table>
  );
};

// =============================================================================
// Team Group Section
// =============================================================================

interface TeamGroupProps {
  teamName: string;
  cronTasks: CronTask[];
  triggers: Trigger[];
  eventSubs: EventSubscription[];
  teamMap: Record<string, string>;
  onToggleCron: (id: string, enabled: boolean) => Promise<void>;
  onDeleteCron: (id: string) => void;
  onPause: (id: string) => Promise<Trigger>;
  onResume: (id: string) => Promise<Trigger>;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
}

const TeamGroup: React.FC<TeamGroupProps> = ({ teamName, cronTasks, triggers, eventSubs = [], ...rest }) => {
  const [collapsed, setCollapsed] = useState(false);
  const total = cronTasks.length + triggers.length + eventSubs.length;
  const active = cronTasks.filter((t) => t.enabled).length + triggers.filter((t) => t.status === 'active').length + eventSubs.length;

  return (
    <div className="bg-surface-dark border border-border-dark rounded-lg overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-4 py-3 bg-background-dark/40 hover:bg-background-dark/60 transition-colors border-b border-border-dark"
      >
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-text-secondary-dark" />
          <span className="text-sm font-medium text-text-primary-dark">{teamName}</span>
          <span className="text-xs text-text-secondary-dark">({total} triggers, {active} active)</span>
        </div>
        <span className="text-xs text-text-secondary-dark">{collapsed ? '▶' : '▼'}</span>
      </button>
      {!collapsed && (
        <div className="overflow-x-auto">
          <TriggersTable cronTasks={cronTasks} triggers={triggers} eventSubs={eventSubs} {...rest} />
        </div>
      )}
    </div>
  );
};

// =============================================================================
// Triggers Page
// =============================================================================

/**
 * Triggers — unified V3 trigger management page.
 * Shows both legacy CronTask jobs and user-created V3 TriggerEngine triggers.
 */
export const Triggers: React.FC = () => {
  const {
    triggers,
    engineStatus,
    isLoading: triggersLoading,
    error: triggersError,
    refresh: refreshTriggers,
    createTrigger,
    pauseTrigger,
    resumeTrigger,
    cancelTrigger,
    deleteTrigger,
  } = useTriggers();

  const {
    tasks: cronTasks,
    isLoading: cronLoading,
    error: cronError,
    refresh: refreshCron,
    updateTask: updateCronTask,
    deleteTask: deleteCronTask,
  } = useCronTasks();

  const { showConfirm, ConfirmComponent } = useConfirm();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [refreshing, setRefreshing] = useState(false);
  const [teamMap, setTeamMap] = useState<Record<string, string>>({});
  const [eventSubs, setEventSubs] = useState<EventSubscription[]>([]);

  const isLoading = triggersLoading || cronLoading;
  const error = triggersError || cronError;

  // Load team names + event subscriptions
  useEffect(() => {
    apiService.getTeams().then((teams: any[]) => {
      const map: Record<string, string> = {};
      for (const t of teams) map[t.id] = t.name;
      setTeamMap(map);
    }).catch(() => {});

    apiService.getEventSubscriptions().then((subs) => {
      setEventSubs(subs);
    }).catch(() => {});
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refreshTriggers(),
        refreshCron(),
        apiService.getEventSubscriptions().then(setEventSubs).catch(() => {}),
      ]);
    } finally { setRefreshing(false); }
  };

  // Only show user/orchestrator/mission-created V3 triggers (hide system triggers)
  const userTriggers = triggers.filter((t) => t.createdBy !== 'system');

  // Only show non-system event subs (hide __reconciler__)
  const userEventSubs = eventSubs.filter((s) => s.subscriberSession !== '__reconciler__');

  // Apply status filter (event subs are always "active")
  const filteredCronTasks = filterTab === 'active' ? cronTasks.filter((t) => t.enabled)
    : filterTab === 'paused' ? cronTasks.filter((t) => !t.enabled)
    : cronTasks;
  const filteredTriggers = filterTab === 'active' ? userTriggers.filter((t) => t.status === 'active')
    : filterTab === 'paused' ? userTriggers.filter((t) => t.status === 'paused')
    : userTriggers;
  const filteredEventSubs = filterTab === 'paused' ? [] : userEventSubs;

  const totalRows = filteredCronTasks.length + filteredTriggers.length + filteredEventSubs.length;

  const activeCount = cronTasks.filter((t) => t.enabled).length + userTriggers.filter((t) => t.status === 'active').length + userEventSubs.length;
  const pausedCount = cronTasks.filter((t) => !t.enabled).length + userTriggers.filter((t) => t.status === 'paused').length;

  const handleToggleCron = async (id: string, enabled: boolean) => { await updateCronTask(id, { enabled }); };

  const handleDeleteCron = (id: string) => {
    showConfirm('This will permanently delete the scheduled task.', async () => { await deleteCronTask(id); },
      { title: 'Delete Scheduled Task', confirmText: 'Delete', type: 'warning' });
  };

  const handleCancelTrigger = (id: string) => {
    showConfirm('Cancelling is permanent and cannot be undone.', async () => { await cancelTrigger(id); },
      { title: 'Cancel Trigger', confirmText: 'Cancel Trigger', type: 'warning' });
  };

  const handleDeleteTrigger = (id: string) => {
    showConfirm('This will permanently delete the trigger.', async () => { await deleteTrigger(id); },
      { title: 'Delete Trigger', confirmText: 'Delete', type: 'warning' });
  };

  // Build team groups for "By Team" view
  const buildTeamGroups = () => {
    const groups: Record<string, { cronTasks: CronTask[]; triggers: Trigger[]; eventSubs: EventSubscription[] }> = {};

    const ensureGroup = (key: string) => {
      if (!groups[key]) groups[key] = { cronTasks: [], triggers: [], eventSubs: [] };
    };

    for (const task of filteredCronTasks) {
      const key = task.targetTeamId || 'unassigned';
      ensureGroup(key);
      groups[key].cronTasks.push(task);
    }
    for (const trigger of filteredTriggers) {
      const key = 'v3-triggers';
      ensureGroup(key);
      groups[key].triggers.push(trigger);
    }
    for (const sub of filteredEventSubs) {
      // Try to resolve subscriber session to a team
      const key = sub.subscriberSession === 'crewly-orc' ? 'orchestrator' : 'event-subs';
      ensureGroup(key);
      groups[key].eventSubs.push(sub);
    }

    return Object.entries(groups).map(([teamId, data]) => ({
      teamId,
      teamName: teamMap[teamId]
        || (teamId === 'unassigned' ? 'Unassigned'
        : teamId === 'v3-triggers' ? 'V3 Triggers'
        : teamId === 'event-subs' ? 'Event Subscriptions'
        : teamId === 'orchestrator' ? 'Orchestrator'
        : teamId),
      ...data,
    }));
  };

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: cronTasks.length + userTriggers.length + userEventSubs.length },
    { key: 'active', label: 'Active', count: activeCount },
    { key: 'paused', label: 'Paused', count: pausedCount },
  ];

  const sharedProps = {
    teamMap,
    onToggleCron: handleToggleCron,
    onDeleteCron: handleDeleteCron,
    onPause: pauseTrigger,
    onResume: resumeTrigger,
    onCancel: handleCancelTrigger,
    onDelete: handleDeleteTrigger,
  };

  return (
    <div className="flex flex-col h-full p-6 gap-4 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-text-primary-dark">Triggers</h1>
          <p className="mt-0.5 text-sm text-text-secondary-dark">
            Scheduled tasks and event-driven triggers for agent automation
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="p-2 rounded-lg text-text-secondary-dark hover:text-text-primary-dark hover:bg-surface-dark border border-border-dark transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
          <Button variant="primary" size="sm" onClick={() => setShowCreateModal(true)}>
            <Plus className="w-4 h-4 mr-1.5" />
            New Trigger
          </Button>
        </div>
      </div>

      {/* Engine status bar */}
      {engineStatus && (
        <div className="flex-shrink-0">
          <EngineStatusBar
            running={engineStatus.running}
            totalUserTriggers={userTriggers.length}
            totalCronTasks={cronTasks.length}
            activeCount={activeCount}
            pausedCount={pausedCount}
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <Alert variant="error" className="flex-shrink-0">
          {error}
        </Alert>
      )}

      {/* Filter tabs + view mode toggle */}
      <PageToolbar
        tabs={tabs.map(({ key, label, count }) => ({ value: key, label, count }))}
        activeTab={filterTab}
        onTabChange={(v) => setFilterTab(v as FilterTab)}
        viewModes={[
          { value: 'list', label: 'List view', icon: <List className="w-4 h-4" /> },
          { value: 'team', label: 'Group by team', icon: <Users className="w-4 h-4" /> },
        ]}
        activeViewMode={viewMode}
        onViewModeChange={(v) => setViewMode(v as 'list' | 'team')}
        className="flex-shrink-0"
      />

      {/* Content — scrollable */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-text-secondary-dark text-sm">
            Loading triggers…
          </div>
        ) : totalRows === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="w-12 h-12 rounded-full bg-surface-dark border border-border-dark flex items-center justify-center">
              <Clock className="w-5 h-5 text-text-secondary-dark" />
            </div>
            <p className="text-sm text-text-secondary-dark">
              {filterTab === 'all' ? 'No triggers yet' : `No ${filterTab} triggers`}
            </p>
            {filterTab === 'all' && (
              <Button variant="outline" size="sm" onClick={() => setShowCreateModal(true)}>
                <Plus className="w-4 h-4 mr-1.5" />
                Create your first trigger
              </Button>
            )}
          </div>
        ) : viewMode === 'list' ? (
          <div className="bg-surface-dark border border-border-dark rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <TriggersTable
                cronTasks={filteredCronTasks}
                triggers={filteredTriggers}
                eventSubs={filteredEventSubs}
                {...sharedProps}
              />
            </div>
          </div>
        ) : buildTeamGroups().length === 0 ? (
          <div className="flex items-center justify-center py-16 text-text-secondary-dark text-sm">
            No groups to display
          </div>
        ) : (
          <div className="flex flex-col gap-4 pb-4">
            {buildTeamGroups().map(({ teamId, teamName, cronTasks: tc, triggers: tt, eventSubs: es }) => (
              <TeamGroup
                key={teamId}
                teamName={teamName}
                cronTasks={tc}
                triggers={tt}
                eventSubs={es ?? []}
                {...sharedProps}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create Modal */}
      <CreateTriggerModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={async (input) => { await createTrigger(input); }}
      />

      <ConfirmComponent />
    </div>
  );
};

export default Triggers;
