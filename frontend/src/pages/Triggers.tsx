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
import {
  Button,
  IconButton,
  Modal,
  ModalBody,
  ModalFooter,
  useConfirm,
  StatusBadge,
  Alert,
  PageToolbar,
  Badge,
  Card,
  EmptyState,
  LoadingSpinner,
  SegmentedControl,
  FormGroup,
  FormLabel,
  FormHelp,
  FormInput,
  FormTextarea,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeader,
  TableCell,
} from '@crewly/ui';
import type { StatusType } from '@crewly/ui/StatusBadge';
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
    <TableRow className="hover:bg-surface-dark/60 transition-colors">
      {/* Type */}
      <TableCell className="whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary-dark">
          <Clock className="w-3.5 h-3.5" />
          Time
        </span>
      </TableCell>

      {/* Team */}
      <TableCell className="whitespace-nowrap text-xs text-text-secondary-dark max-w-[120px] hidden sm:table-cell">
        <span className="truncate block" title={teamName}>{teamName}</span>
      </TableCell>

      {/* Schedule */}
      <TableCell className="text-xs font-mono whitespace-nowrap">
        {cronExpr}
        {task.timezone && (
          <span className="ml-1.5 text-[10px] text-text-secondary-dark">{task.timezone}</span>
        )}
      </TableCell>

      {/* Task */}
      <TableCell className="text-sm text-text-secondary-dark max-w-[220px] hidden md:table-cell">
        <div className="flex items-center gap-1.5">
          <Bot className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate" title={desc}>{displayName}</span>
        </div>
      </TableCell>

      {/* Status */}
      <TableCell className="whitespace-nowrap">
        <StatusBadge status={task.enabled ? 'active' : 'paused'} />
      </TableCell>

      {/* Next Fire */}
      <TableCell className="whitespace-nowrap text-xs text-text-secondary-dark hidden lg:table-cell">
        {formatDate(task.nextRunAt)}
      </TableCell>

      {/* Last Fire */}
      <TableCell className="whitespace-nowrap text-xs text-text-secondary-dark hidden lg:table-cell">
        {formatDate(task.lastRunAt)}
      </TableCell>

      {/* Actions */}
      <TableCell className="whitespace-nowrap">
        <div className="flex items-center gap-1">
          <IconButton
            size="xs"
            icon={task.enabled ? Pause : Play}
            onClick={handleToggle}
            disabled={busy}
            title={task.enabled ? 'Pause' : 'Resume'}
            aria-label={task.enabled ? 'Pause' : 'Resume'}
          />
          <IconButton
            size="xs"
            icon={Trash2}
            variant="danger-ghost"
            onClick={() => onDelete(task.id)}
            disabled={busy}
            title="Delete"
            aria-label="Delete"
          />
        </div>
      </TableCell>
    </TableRow>
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
    <TableRow className="hover:bg-surface-dark/60 transition-colors">
      <TableCell className="whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary-dark">
          {triggerTypeIcon(trigger.type)}
          <span className="capitalize">{trigger.type}</span>
        </span>
      </TableCell>

      {/* Team — V3 triggers show createdBy */}
      <TableCell className="whitespace-nowrap text-xs text-text-secondary-dark hidden sm:table-cell">
        <span className="capitalize">{trigger.createdBy}</span>
      </TableCell>

      <TableCell className="text-xs font-mono max-w-[200px]">
        <span className="truncate block" title={triggerConfigSummary(trigger)}>
          {triggerConfigSummary(trigger)}
        </span>
      </TableCell>

      <TableCell className="text-sm text-text-secondary-dark max-w-[180px] hidden md:table-cell">
        <span className="truncate block">{triggerActionSummary(trigger)}</span>
      </TableCell>

      <TableCell className="whitespace-nowrap">
        <StatusBadge status={mapTriggerStatus(trigger.status)}>{trigger.status}</StatusBadge>
      </TableCell>

      <TableCell className="whitespace-nowrap text-xs text-text-secondary-dark hidden lg:table-cell">
        {formatDate(trigger.nextFireAt)}
      </TableCell>

      <TableCell className="whitespace-nowrap text-xs text-text-secondary-dark hidden lg:table-cell">
        {formatDate(trigger.lastFiredAt)}
      </TableCell>

      <TableCell className="whitespace-nowrap">
        <div className="flex items-center gap-1">
          {trigger.status === 'active' && (
            <IconButton size="xs" icon={Pause} onClick={() => act(() => onPause(trigger.id))} disabled={busy} title="Pause" aria-label="Pause" />
          )}
          {trigger.status === 'paused' && (
            <IconButton size="xs" icon={Play} onClick={() => act(() => onResume(trigger.id))} disabled={busy} title="Resume" aria-label="Resume" />
          )}
          {(trigger.status === 'active' || trigger.status === 'paused') && (
            <IconButton size="xs" icon={XCircle} variant="danger-ghost" onClick={() => onCancel(trigger.id)} disabled={busy} title="Cancel" aria-label="Cancel" />
          )}
          <IconButton size="xs" icon={Trash2} variant="danger-ghost" onClick={() => onDelete(trigger.id)} disabled={busy} title="Delete" aria-label="Delete" />
        </div>
      </TableCell>
    </TableRow>
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
    <TableRow className="hover:bg-surface-dark/60 transition-colors">
      {/* Type */}
      <TableCell className="whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary-dark">
          <Zap className="w-3.5 h-3.5" />
          Signal
        </span>
      </TableCell>

      {/* Team/subscriber */}
      <TableCell className="whitespace-nowrap text-xs text-text-secondary-dark max-w-[120px]">
        <span className="truncate block" title={session}>{isSystem ? 'System' : session}</span>
      </TableCell>

      {/* Event type */}
      <TableCell className="text-xs font-mono">
        {sub.eventType}
      </TableCell>

      {/* Action */}
      <TableCell className="text-sm text-text-secondary-dark">
        → {session}
      </TableCell>

      {/* Status */}
      <TableCell className="whitespace-nowrap">
        <StatusBadge status="active">active</StatusBadge>
      </TableCell>

      {/* Next Fire */}
      <TableCell className="whitespace-nowrap text-xs text-text-secondary-dark">
        {sub.expiresAt ? `Exp ${formatDate(sub.expiresAt)}` : '—'}
      </TableCell>

      {/* Last Fire */}
      <TableCell className="whitespace-nowrap text-xs text-text-secondary-dark">—</TableCell>

      {/* Actions (read-only for event subscriptions) */}
      <TableCell className="whitespace-nowrap text-xs text-text-secondary-dark">
        {sub.oneShot && <Badge variant="warning" size="sm">one-shot</Badge>}
      </TableCell>
    </TableRow>
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
          <FormGroup>
            <FormLabel>Trigger Type</FormLabel>
            <SegmentedControl<TriggerType>
              aria-label="Trigger type"
              value={type}
              onChange={setType}
              options={[
                { value: 'time', label: 'Time', icon: Clock },
                { value: 'signal', label: 'Signal', icon: Zap },
              ]}
            />
          </FormGroup>

          {type === 'time' && (
            <FormGroup>
              <FormLabel htmlFor="trigger-cron">Cron Expression</FormLabel>
              <FormInput id="trigger-cron" className="font-mono"
                value={cronExpression} onChange={(e) => setCronExpression(e.target.value)} placeholder="0 9 * * 1-5" />
              <FormHelp>Standard 5-field cron (min hour dom month dow)</FormHelp>
            </FormGroup>
          )}

          {type === 'signal' && (
            <FormGroup>
              <FormLabel htmlFor="trigger-event-type">Event Type</FormLabel>
              <FormInput id="trigger-event-type" className="font-mono"
                value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="agent:idle" />
              <FormHelp>EventBus event type (e.g. agent:idle, task:completed)</FormHelp>
            </FormGroup>
          )}

          <FormGroup>
            <FormLabel htmlFor="trigger-target">Send Message To</FormLabel>
            <FormInput id="trigger-target" className="font-mono"
              value={messageTarget} onChange={(e) => setMessageTarget(e.target.value)} placeholder="agent-session or #channel" />
          </FormGroup>

          <FormGroup>
            <FormLabel htmlFor="trigger-message">Message</FormLabel>
            <FormTextarea id="trigger-message"
              rows={3} value={messageText} onChange={(e) => setMessageText(e.target.value)} placeholder="What should the agent do?" />
          </FormGroup>

          <FormGroup>
            <FormLabel htmlFor="trigger-max-fires">Max Fires (optional)</FormLabel>
            <div className="w-32">
              <FormInput id="trigger-max-fires" type="number" min="1"
                value={maxFires} onChange={(e) => setMaxFires(e.target.value)} placeholder="∞" />
            </div>
            <FormHelp>Leave blank for unlimited.</FormHelp>
          </FormGroup>

          {error && (
            <Alert variant="error">{error}</Alert>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitting} loading={submitting}>
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
  <Card padding="none" className="flex items-center gap-4 px-4 py-2.5 text-xs text-text-secondary-dark flex-wrap">
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
  </Card>
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
    <Table className="min-w-full">
      <TableHead>
        <tr>
          <TableHeader>Type</TableHeader>
          <TableHeader className="hidden sm:table-cell">Team</TableHeader>
          <TableHeader>Schedule / Event</TableHeader>
          <TableHeader className="hidden md:table-cell">Task / Action</TableHeader>
          <TableHeader>Status</TableHeader>
          <TableHeader className="hidden lg:table-cell">Next Fire</TableHeader>
          <TableHeader className="hidden lg:table-cell">Last Fire</TableHeader>
          <TableHeader>Actions</TableHeader>
        </tr>
      </TableHead>
      <TableBody>
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
      </TableBody>
    </Table>
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
    <section className="flex flex-col gap-2">
      {/* Collapsible group header — a full-width row target, not a styled button */}
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-dark border border-border-dark rounded-2xl hover:border-primary/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-text-secondary-dark" />
          <span className="text-sm font-medium text-text-primary-dark">{teamName}</span>
          <span className="text-xs text-text-secondary-dark">({total} triggers, {active} active)</span>
        </div>
        <span className="text-xs text-text-secondary-dark">{collapsed ? '▶' : '▼'}</span>
      </button>
      {!collapsed && (
        <TriggersTable cronTasks={cronTasks} triggers={triggers} eventSubs={eventSubs} {...rest} />
      )}
    </section>
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
          <h1 className="text-2xl font-bold text-text-primary-dark">Triggers</h1>
          <p className="mt-0.5 text-sm text-text-secondary-dark">
            Scheduled tasks and event-driven triggers for agent automation
          </p>
        </div>
        <div className="flex items-center gap-2">
          <IconButton
            icon={RefreshCw}
            variant="outline"
            onClick={handleRefresh}
            loading={refreshing}
            title="Refresh"
            aria-label="Refresh"
          />
          <Button variant="primary" size="sm" icon={Plus} onClick={() => setShowCreateModal(true)}>
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
          <LoadingSpinner size="md" text="Loading triggers…" className="py-16" />
        ) : totalRows === 0 ? (
          <EmptyState
            icon={Clock}
            title={filterTab === 'all' ? 'No triggers yet' : `No ${filterTab} triggers`}
            action={filterTab === 'all' ? (
              <Button variant="outline" size="sm" icon={Plus} onClick={() => setShowCreateModal(true)}>
                Create your first trigger
              </Button>
            ) : undefined}
          />
        ) : viewMode === 'list' ? (
          <TriggersTable
            cronTasks={filteredCronTasks}
            triggers={filteredTriggers}
            eventSubs={filteredEventSubs}
            {...sharedProps}
          />
        ) : buildTeamGroups().length === 0 ? (
          <EmptyState title="No groups to display" compact />
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
