/**
 * Schedules page (route `/triggers`).
 *
 * Owner-first view of the team's scheduled work:
 * - 定时任务 (default): active + paused recurring schedules — cron triggers
 *   and per-team cron tasks — grouped by team, each with a human name, the
 *   schedule in plain words, next/last run, who runs it, and runs left.
 * - 提醒: active one-shot reminders, plus anything waiting on an event.
 * - 历史: cancelled / exhausted, collapsed and paginated.
 * Harness-internal triggers stay behind the "显示系统任务" toggle.
 *
 * @module pages/Triggers
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Clock,
  Play,
  Pause,
  XCircle,
  Trash2,
  Plus,
  RefreshCw,
  Users,
  Bell,
  History as HistoryIcon,
  Zap,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  MinusCircle,
} from 'lucide-react';
import {
  Button,
  IconButton,
  Modal,
  ModalBody,
  ModalFooter,
  useConfirm,
  Alert,
  PageToolbar,
  Badge,
  Card,
  Drawer,
  EmptyState,
  LoadingSpinner,
  SegmentedControl,
  FormGroup,
  FormLabel,
  FormHelp,
  FormInput,
  FormTextarea,
  Toggle,
} from '@crewly/ui';
import { useTriggers } from '../hooks/useTriggers';
import { useCronTasks } from '../hooks/useCronTasks';
import { apiService } from '../services/api.service';
import {
  bucketSchedules,
  groupByTeam,
  formatAbsolute,
  formatRelative,
  formatShortDate,
  type ScheduleRow,
} from '../components/Triggers/schedule.utils';
import { SCHEDULE_HISTORY_PAGE_SIZE, SCHEDULE_TEXT } from '../constants/schedules.constants';
import type { TriggerType, CreateTriggerInput, EventSubscription } from '../types/trigger.types';
import type { Team } from '../types';

type ScheduleTab = 'scheduled' | 'reminders' | 'history';

// =============================================================================
// Row actions
// =============================================================================

/** Callbacks a row can invoke. */
interface RowActions {
  onPause: (row: ScheduleRow) => Promise<void>;
  onResume: (row: ScheduleRow) => Promise<void>;
  onCancel: (row: ScheduleRow) => void;
  onDelete: (row: ScheduleRow) => void;
}

/** Whether a row can be paused/resumed/cancelled from the page. */
function isLiveRow(row: ScheduleRow): boolean {
  return row.source !== 'event-sub' && (row.status === 'active' || row.status === 'paused');
}

/**
 * Pause/resume + cancel buttons for a live row. Clicks do not open the row.
 */
const RowActionButtons: React.FC<{ row: ScheduleRow; actions: RowActions }> = ({ row, actions }) => {
  const [busy, setBusy] = useState(false);
  if (!isLiveRow(row)) return null;
  const run = async (e: React.MouseEvent, fn: () => Promise<void>) => {
    e.stopPropagation();
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };
  return (
    <div className="flex items-center gap-1 flex-shrink-0">
      {row.status === 'active' ? (
        <IconButton size="sm" variant="ghost" icon={Pause} disabled={busy}
          onClick={(e) => run(e, () => actions.onPause(row))}
          title={SCHEDULE_TEXT.PAUSE} aria-label={`${SCHEDULE_TEXT.PAUSE} ${row.name}`} />
      ) : (
        <IconButton size="sm" variant="ghost" icon={Play} disabled={busy}
          onClick={(e) => run(e, () => actions.onResume(row))}
          title={SCHEDULE_TEXT.RESUME} aria-label={`${SCHEDULE_TEXT.RESUME} ${row.name}`} />
      )}
      <IconButton size="sm" variant="danger-ghost" icon={XCircle} disabled={busy}
        onClick={(e) => { e.stopPropagation(); actions.onCancel(row); }}
        title={SCHEDULE_TEXT.CANCEL} aria-label={`${SCHEDULE_TEXT.CANCEL} ${row.name}`} />
    </div>
  );
};

/** Small icon + label for the last run's result. */
const LastResult: React.FC<{ row: ScheduleRow }> = ({ row }) => {
  const r = row.lastResult;
  if (!r) return null;
  if (r.status === 'ok') {
    return <CheckCircle2 className="inline w-3.5 h-3.5 text-green-400" aria-label={SCHEDULE_TEXT.RESULT_OK} />;
  }
  if (r.status === 'skipped') {
    return <MinusCircle className="inline w-3.5 h-3.5 text-text-secondary-dark" aria-label={SCHEDULE_TEXT.RESULT_SKIPPED} />;
  }
  return <AlertTriangle className="inline w-3.5 h-3.5 text-red-400" aria-label={SCHEDULE_TEXT.RESULT_FAILED} />;
};

// =============================================================================
// Rows
// =============================================================================

interface RowProps {
  row: ScheduleRow;
  actions: RowActions;
  onOpen: (row: ScheduleRow) => void;
  /** One-line layout for reminders / history */
  compact?: boolean;
}

/**
 * One schedule. Tapping it opens the detail drawer.
 */
const ScheduleItem: React.FC<RowProps> = ({ row, actions, onOpen, compact = false }) => {
  const open = () => onOpen(row);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  };
  const ended = row.status === 'cancelled' || row.status === 'exhausted';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKey}
      data-testid="schedule-row"
      className="flex items-start gap-3 px-4 py-3 border-b border-border-dark last:border-b-0 cursor-pointer hover:bg-surface-dark/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-text-primary-dark truncate max-w-full">{row.name}</span>
          {row.status === 'paused' && <Badge size="sm" variant="default">{SCHEDULE_TEXT.PAUSED}</Badge>}
          {row.status === 'cancelled' && <Badge size="sm" variant="default">{SCHEDULE_TEXT.STATUS_CANCELLED}</Badge>}
          {row.status === 'exhausted' && <Badge size="sm" variant="info">{SCHEDULE_TEXT.STATUS_EXHAUSTED}</Badge>}
          {row.expiringSoon && <Badge size="sm" variant="warning">{SCHEDULE_TEXT.EXPIRING_SOON}</Badge>}
          {row.internal && <Badge size="sm" variant="default">{SCHEDULE_TEXT.SYSTEM_CHIP}</Badge>}
        </div>

        <div className="mt-0.5 text-xs text-text-secondary-dark flex items-center gap-x-2 gap-y-0.5 flex-wrap">
          <span title={row.cronExpression ? `${row.cronExpression}${row.timezone ? ` (${row.timezone})` : ''}` : undefined}>
            {row.scheduleText}
          </span>
          {row.runnerName && (
            <>
              <span aria-hidden="true">·</span>
              <span>{row.runnerName}</span>
            </>
          )}
        </div>

        {!compact && (
          <div className="mt-1 text-xs text-text-secondary-dark flex items-center gap-x-3 gap-y-0.5 flex-wrap">
            {row.nextRunAt && (
              <span>
                {SCHEDULE_TEXT.NEXT_RUN} <span className="text-text-primary-dark">{formatRelative(row.nextRunAt)}</span>
                {' '}({formatAbsolute(row.nextRunAt)})
              </span>
            )}
            <span>
              {row.lastRunAt
                ? <>{SCHEDULE_TEXT.LAST_RUN} {formatAbsolute(row.lastRunAt)} <LastResult row={row} /></>
                : SCHEDULE_TEXT.NEVER_RUN}
            </span>
            {row.maxFires !== undefined && row.fireCount !== undefined ? (
              <span>{SCHEDULE_TEXT.RUNS_OF(row.fireCount, row.maxFires)} · {SCHEDULE_TEXT.REMAINING(row.remaining ?? 0)}</span>
            ) : row.fireCount ? (
              <span>{SCHEDULE_TEXT.RUNS(row.fireCount)}</span>
            ) : null}
            {row.projectedEndAt && <span>{SCHEDULE_TEXT.ENDS_AROUND(formatShortDate(row.projectedEndAt))}</span>}
          </div>
        )}

        {compact && (row.nextRunAt || (ended && row.lastRunAt)) && (
          <div className="mt-0.5 text-xs text-text-secondary-dark">
            {row.nextRunAt
              ? <>{formatRelative(row.nextRunAt)} ({formatAbsolute(row.nextRunAt)})</>
              : <>{SCHEDULE_TEXT.LAST_RUN} {formatAbsolute(row.lastRunAt)}</>}
          </div>
        )}
      </div>
      <RowActionButtons row={row} actions={actions} />
    </div>
  );
};

/** A list of rows inside one card. */
const RowList: React.FC<Omit<RowProps, 'row'> & { rows: ScheduleRow[] }> = ({ rows, ...rest }) => (
  <Card padding="none" className="overflow-hidden">
    {rows.map((row) => <ScheduleItem key={row.key} row={row} {...rest} />)}
  </Card>
);

// =============================================================================
// Detail drawer
// =============================================================================

/** One label/value line in the detail drawer. */
const DetailLine: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex gap-3 py-1.5 text-sm">
    <dt className="w-20 flex-shrink-0 text-text-secondary-dark">{label}</dt>
    <dd className="min-w-0 flex-1 text-text-primary-dark break-words">{children}</dd>
  </div>
);

/**
 * Everything about one schedule, including its full description.
 */
const ScheduleDetail: React.FC<{
  row: ScheduleRow | null;
  onClose: () => void;
  actions: RowActions;
}> = ({ row, onClose, actions }) => {
  const [busy, setBusy] = useState(false);
  if (!row) return null;
  const live = isLiveRow(row);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };
  const resultText = row.lastResult
    ? row.lastResult.status === 'ok' ? SCHEDULE_TEXT.RESULT_OK
      : row.lastResult.status === 'skipped' ? SCHEDULE_TEXT.RESULT_SKIPPED
      : `${SCHEDULE_TEXT.RESULT_FAILED}${row.lastResult.detail ? `：${row.lastResult.detail}` : ''}`
    : '';

  const footer = (
    <div className="flex items-center justify-end gap-2 flex-wrap">
      {live && row.status === 'active' && (
        <Button variant="outline" size="sm" icon={Pause} disabled={busy} onClick={() => run(() => actions.onPause(row))}>{SCHEDULE_TEXT.PAUSE}</Button>
      )}
      {live && row.status === 'paused' && (
        <Button variant="outline" size="sm" icon={Play} disabled={busy} onClick={() => run(() => actions.onResume(row))}>{SCHEDULE_TEXT.RESUME}</Button>
      )}
      {live && (
        <Button variant="danger" size="sm" icon={XCircle} disabled={busy} onClick={() => actions.onCancel(row)}>{SCHEDULE_TEXT.CANCEL}</Button>
      )}
      {!live && row.source === 'trigger' && (
        <Button variant="ghost" size="sm" icon={Trash2} disabled={busy} onClick={() => actions.onDelete(row)}>{SCHEDULE_TEXT.DELETE}</Button>
      )}
    </div>
  );

  return (
    <Drawer isOpen onClose={onClose} title={row.name} subtitle={row.scheduleText} footer={footer} data-testid="schedule-detail">
      <div className="flex flex-col gap-4">
        {row.expiringSoon && (
          <Alert variant="warning">
            {SCHEDULE_TEXT.EXPIRING_SOON} · {SCHEDULE_TEXT.REMAINING(row.remaining ?? 0)}
            {row.projectedEndAt ? ` · ${SCHEDULE_TEXT.ENDS_AROUND(formatShortDate(row.projectedEndAt))}` : ''}
            {row.headsUpSentAt ? ` · ${SCHEDULE_TEXT.HEADS_UP_SENT}` : ''}
          </Alert>
        )}
        <dl>
          <DetailLine label={SCHEDULE_TEXT.SCHEDULE}>{row.scheduleText}</DetailLine>
          {row.cronExpression && (
            <DetailLine label={SCHEDULE_TEXT.RAW_CRON}>
              <span className="font-mono">{row.cronExpression}</span>{row.timezone ? ` · ${row.timezone}` : ''}
            </DetailLine>
          )}
          {row.nextRunAt && (
            <DetailLine label={SCHEDULE_TEXT.NEXT_RUN}>{formatRelative(row.nextRunAt)} · {formatAbsolute(row.nextRunAt)}</DetailLine>
          )}
          <DetailLine label={SCHEDULE_TEXT.LAST_RUN}>
            {row.lastRunAt ? `${formatAbsolute(row.lastRunAt)}${resultText ? ` · ${resultText}` : ''}` : SCHEDULE_TEXT.NEVER_RUN}
          </DetailLine>
          {row.fireCount !== undefined && (
            <DetailLine label="次数">
              {row.maxFires !== undefined
                ? `${SCHEDULE_TEXT.RUNS_OF(row.fireCount, row.maxFires)} · ${SCHEDULE_TEXT.REMAINING(row.remaining ?? 0)}`
                : SCHEDULE_TEXT.RUNS(row.fireCount)}
              {row.projectedEndAt ? ` · ${SCHEDULE_TEXT.ENDS_AROUND(formatShortDate(row.projectedEndAt))}` : ''}
            </DetailLine>
          )}
          {row.runnerName && <DetailLine label={SCHEDULE_TEXT.RUNS_AS}>{row.runnerName}</DetailLine>}
          <DetailLine label={SCHEDULE_TEXT.TEAM}>{row.teamName}</DetailLine>
          <DetailLine label={SCHEDULE_TEXT.CREATED_BY}>
            {row.createdByLabel}{row.createdAt ? ` · ${formatAbsolute(row.createdAt)}` : ''}
          </DetailLine>
          <DetailLine label={SCHEDULE_TEXT.ID}><span className="font-mono text-xs">{row.id}</span></DetailLine>
        </dl>
        <div>
          <div className="text-xs font-medium text-text-secondary-dark mb-1">{SCHEDULE_TEXT.DESCRIPTION}</div>
          <div className="text-sm text-text-primary-dark whitespace-pre-wrap break-words rounded-xl border border-border-dark bg-background-dark/40 p-3">
            {row.description || SCHEDULE_TEXT.NO_DESCRIPTION}
          </div>
        </div>
      </div>
    </Drawer>
  );
};

// =============================================================================
// Create modal
// =============================================================================

interface CreateTriggerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: CreateTriggerInput) => Promise<void>;
}

/** Owner-created schedule: a cron or event that sends an agent a message. */
const CreateTriggerModal: React.FC<CreateTriggerModalProps> = ({ isOpen, onClose, onCreate }) => {
  const [type, setType] = useState<TriggerType>('time');
  const [name, setName] = useState('');
  const [cronExpression, setCronExpression] = useState('0 9 * * 1-5');
  const [eventType, setEventType] = useState('agent:idle');
  const [messageTarget, setMessageTarget] = useState('');
  const [messageText, setMessageText] = useState('');
  const [maxFires, setMaxFires] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    setError('');
    if (type === 'time' && !cronExpression.trim()) { setError('请填写 cron 表达式'); return; }
    if (type === 'signal' && !eventType.trim()) { setError('请填写事件类型'); return; }
    if (!messageTarget.trim() || !messageText.trim()) { setError('请填写发给谁和内容'); return; }

    const config =
      type === 'time'
        ? { type: 'time' as const, cronExpression: cronExpression.trim(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
        : { type: 'signal' as const, eventType: eventType.trim() };

    const input: CreateTriggerInput = {
      type,
      config,
      action: { sendMessage: { target: messageTarget.trim(), message: messageText.trim() } },
      createdBy: 'user',
      ...(name.trim() ? { name: name.trim() } : {}),
      maxFires: maxFires ? parseInt(maxFires, 10) : undefined,
    };

    try {
      setSubmitting(true);
      await onCreate(input);
      onClose();
      setName('');
      setCronExpression('0 9 * * 1-5');
      setEventType('agent:idle');
      setMessageTarget('');
      setMessageText('');
      setMaxFires('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="新建定时任务" size="md">
      <ModalBody>
        <div className="space-y-4">
          <FormGroup>
            <FormLabel>类型</FormLabel>
            <SegmentedControl<TriggerType>
              aria-label="Trigger type"
              value={type}
              onChange={setType}
              options={[
                { value: 'time', label: '按时间', icon: Clock },
                { value: 'signal', label: '按事件', icon: Zap },
              ]}
            />
          </FormGroup>

          <FormGroup>
            <FormLabel htmlFor="trigger-name">名称</FormLabel>
            <FormInput id="trigger-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：每日运营日报" />
          </FormGroup>

          {type === 'time' && (
            <FormGroup>
              <FormLabel htmlFor="trigger-cron">Cron 表达式</FormLabel>
              <FormInput id="trigger-cron" className="font-mono"
                value={cronExpression} onChange={(e) => setCronExpression(e.target.value)} placeholder="0 9 * * 1-5" />
              <FormHelp>5 段 cron（分 时 日 月 周），按你所在时区</FormHelp>
            </FormGroup>
          )}

          {type === 'signal' && (
            <FormGroup>
              <FormLabel htmlFor="trigger-event-type">事件类型</FormLabel>
              <FormInput id="trigger-event-type" className="font-mono"
                value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="agent:idle" />
            </FormGroup>
          )}

          <FormGroup>
            <FormLabel htmlFor="trigger-target">发给</FormLabel>
            <FormInput id="trigger-target" className="font-mono"
              value={messageTarget} onChange={(e) => setMessageTarget(e.target.value)} placeholder="成员 session 名" />
          </FormGroup>

          <FormGroup>
            <FormLabel htmlFor="trigger-message">内容</FormLabel>
            <FormTextarea id="trigger-message"
              rows={3} value={messageText} onChange={(e) => setMessageText(e.target.value)} placeholder="到点要做什么？" />
          </FormGroup>

          <FormGroup>
            <FormLabel htmlFor="trigger-max-fires">最多运行次数（可选）</FormLabel>
            <div className="w-32">
              <FormInput id="trigger-max-fires" type="number" min="1"
                value={maxFires} onChange={(e) => setMaxFires(e.target.value)} placeholder="∞" />
            </div>
            <FormHelp>留空表示不限次数。</FormHelp>
          </FormGroup>

          {error && <Alert variant="error">{error}</Alert>}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>取消</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitting} loading={submitting}>
          {submitting ? '创建中…' : '创建'}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

// =============================================================================
// Page
// =============================================================================

/**
 * Schedules — what the team does on a timer, at a glance.
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
  const [tab, setTab] = useState<ScheduleTab>('scheduled');
  const [showSystem, setShowSystem] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [eventSubs, setEventSubs] = useState<EventSubscription[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);

  const isLoading = triggersLoading || cronLoading;
  const error = triggersError || cronError;

  useEffect(() => {
    apiService.getTeams().then(setTeams).catch(() => {});
    apiService.getEventSubscriptions().then(setEventSubs).catch(() => {});
  }, []);

  const buckets = useMemo(
    () => bucketSchedules({ triggers, cronTasks, eventSubs, teams, showSystem }),
    [triggers, cronTasks, eventSubs, teams, showSystem],
  );
  const scheduledGroups = useMemo(() => groupByTeam(buckets.scheduled), [buckets.scheduled]);

  const allRows = useMemo(
    () => [...buckets.scheduled, ...buckets.reminders, ...buckets.events, ...buckets.history],
    [buckets],
  );
  const selected = selectedKey ? allRows.find((r) => r.key === selectedKey) ?? null : null;

  const historyPages = Math.max(1, Math.ceil(buckets.history.length / SCHEDULE_HISTORY_PAGE_SIZE));
  const page = Math.min(historyPage, historyPages - 1);
  const historyRows = buckets.history.slice(page * SCHEDULE_HISTORY_PAGE_SIZE, (page + 1) * SCHEDULE_HISTORY_PAGE_SIZE);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refreshTriggers(),
        refreshCron(),
        apiService.getEventSubscriptions().then(setEventSubs).catch(() => {}),
        apiService.getTeams(true).then(setTeams).catch(() => {}),
      ]);
    } finally { setRefreshing(false); }
  };

  const actions: RowActions = {
    onPause: async (row) => {
      if (row.source === 'cron-task') await updateCronTask(row.id, { enabled: false });
      else await pauseTrigger(row.id);
    },
    onResume: async (row) => {
      if (row.source === 'cron-task') await updateCronTask(row.id, { enabled: true });
      else await resumeTrigger(row.id);
    },
    onCancel: (row) => {
      showConfirm(SCHEDULE_TEXT.CANCEL_CONFIRM_BODY, async () => {
        if (row.source === 'cron-task') await deleteCronTask(row.id);
        else await cancelTrigger(row.id);
      }, { title: SCHEDULE_TEXT.CANCEL_CONFIRM_TITLE, confirmText: SCHEDULE_TEXT.CANCEL, type: 'warning' });
    },
    onDelete: (row) => {
      showConfirm(SCHEDULE_TEXT.DELETE_CONFIRM_BODY, async () => {
        await deleteTrigger(row.id);
        setSelectedKey(null);
      }, { title: SCHEDULE_TEXT.DELETE_CONFIRM_TITLE, confirmText: SCHEDULE_TEXT.DELETE, type: 'warning' });
    },
  };

  const openRow = (row: ScheduleRow) => setSelectedKey(row.key);
  const rowProps = { actions, onOpen: openRow };

  const tabs = [
    { value: 'scheduled', label: SCHEDULE_TEXT.TAB_SCHEDULED, count: buckets.scheduled.length },
    { value: 'reminders', label: SCHEDULE_TEXT.TAB_REMINDERS, count: buckets.reminders.length + buckets.events.length },
    { value: 'history', label: SCHEDULE_TEXT.TAB_HISTORY, count: buckets.history.length },
  ];

  const renderScheduled = () => {
    if (buckets.scheduled.length === 0) {
      return <EmptyState icon={Clock} title={SCHEDULE_TEXT.EMPTY_SCHEDULED_TITLE} description={SCHEDULE_TEXT.EMPTY_SCHEDULED_BODY} />;
    }
    return (
      <div className="flex flex-col gap-5">
        {scheduledGroups.map((group) => (
          <section key={group.teamId} className="flex flex-col gap-2" aria-label={group.teamName}>
            <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-secondary-dark px-1">
              <Users className="w-3.5 h-3.5" />
              {group.teamName}
              <span className="font-normal normal-case">({group.rows.length})</span>
            </h2>
            <RowList rows={group.rows} {...rowProps} />
          </section>
        ))}
      </div>
    );
  };

  const renderReminders = () => {
    if (buckets.reminders.length === 0 && buckets.events.length === 0) {
      return <EmptyState icon={Bell} title={SCHEDULE_TEXT.EMPTY_REMINDERS_TITLE} description={SCHEDULE_TEXT.EMPTY_REMINDERS_BODY} />;
    }
    return (
      <div className="flex flex-col gap-5">
        {buckets.reminders.length > 0 && <RowList rows={buckets.reminders} compact {...rowProps} />}
        {buckets.events.length > 0 && (
          <section className="flex flex-col gap-2" aria-label={SCHEDULE_TEXT.WAITING_EVENTS}>
            <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-secondary-dark px-1">
              <Zap className="w-3.5 h-3.5" />
              {SCHEDULE_TEXT.WAITING_EVENTS}
              <span className="font-normal normal-case">({buckets.events.length})</span>
            </h2>
            <RowList rows={buckets.events} compact {...rowProps} />
          </section>
        )}
      </div>
    );
  };

  const renderHistory = () => {
    if (buckets.history.length === 0) {
      return <EmptyState icon={HistoryIcon} title={SCHEDULE_TEXT.EMPTY_HISTORY_TITLE} description={SCHEDULE_TEXT.EMPTY_HISTORY_BODY} />;
    }
    return (
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          aria-expanded={historyOpen}
          className="w-full flex items-center justify-between px-4 py-3 bg-surface-dark border border-border-dark rounded-2xl hover:border-primary/50 transition-colors text-sm"
        >
          <span className="flex items-center gap-2 text-text-primary-dark">
            {historyOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            {SCHEDULE_TEXT.HISTORY_SUMMARY(buckets.history.length)}
          </span>
          <span className="text-xs text-text-secondary-dark">{historyOpen ? SCHEDULE_TEXT.COLLAPSE : SCHEDULE_TEXT.EXPAND}</span>
        </button>
        {historyOpen && (
          <>
            <RowList rows={historyRows} compact {...rowProps} />
            {historyPages > 1 && (
              <div className="flex items-center justify-center gap-3 text-xs text-text-secondary-dark">
                <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setHistoryPage(page - 1)}>{SCHEDULE_TEXT.PREV_PAGE}</Button>
                <span>{SCHEDULE_TEXT.PAGE_OF(page + 1, historyPages)}</span>
                <Button variant="ghost" size="sm" disabled={page >= historyPages - 1} onClick={() => setHistoryPage(page + 1)}>{SCHEDULE_TEXT.NEXT_PAGE}</Button>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full min-w-0 max-w-full p-4 sm:p-6 gap-4 overflow-hidden" data-testid="schedules-page">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-shrink-0">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-text-primary-dark">{SCHEDULE_TEXT.PAGE_TITLE}</h1>
          <p className="mt-0.5 text-sm text-text-secondary-dark">{SCHEDULE_TEXT.PAGE_SUBTITLE}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <IconButton icon={RefreshCw} variant="outline" onClick={handleRefresh} loading={refreshing}
            title={SCHEDULE_TEXT.REFRESH} aria-label={SCHEDULE_TEXT.REFRESH} />
          <Button variant="primary" size="sm" icon={Plus} onClick={() => setShowCreateModal(true)}>{SCHEDULE_TEXT.NEW}</Button>
        </div>
      </div>

      {engineStatus && !engineStatus.running && (
        <Alert variant="warning" className="flex-shrink-0">{SCHEDULE_TEXT.ENGINE_STOPPED}</Alert>
      )}
      {error && <Alert variant="error" className="flex-shrink-0">{error}</Alert>}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between flex-shrink-0">
        <PageToolbar
          tabs={tabs}
          activeTab={tab}
          onTabChange={(v) => setTab(v as ScheduleTab)}
          className="min-w-0"
        />
        <Toggle
          size="sm"
          label={SCHEDULE_TEXT.SHOW_SYSTEM}
          checked={showSystem}
          onChange={(e) => setShowSystem(e.target.checked)}
        />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 pb-4">
        {isLoading ? (
          <LoadingSpinner size="md" className="py-16" />
        ) : (
          <>
            {tab === 'scheduled' && renderScheduled()}
            {tab === 'reminders' && renderReminders()}
            {tab === 'history' && renderHistory()}
            {!showSystem && buckets.hiddenInternal > 0 && (
              <p className="mt-4 text-center text-xs text-text-secondary-dark">
                {SCHEDULE_TEXT.HIDDEN_SYSTEM_HINT(buckets.hiddenInternal)}
              </p>
            )}
          </>
        )}
      </div>

      <ScheduleDetail row={selected} onClose={() => setSelectedKey(null)} actions={actions} />

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
