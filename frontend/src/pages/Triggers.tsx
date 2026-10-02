/**
 * Schedules page (route `/triggers`).
 *
 * Owner-first view of the team's scheduled work
 * (specs/2026-10-02-ui-redesign.md, simplify level):
 * - Schedules (default): active + paused recurring schedules — cron triggers
 *   and per-team cron tasks — grouped by team as compact rows: a human name,
 *   the schedule in plain words, who runs it and when it runs next.
 * - Reminders: active one-shot reminders, plus anything waiting on an event.
 * - History: cancelled / exhausted, paginated.
 * The tab lives in `?tab=`. Team and "system tasks" filters sit behind one
 * Filter button. Run counts, raw cron, ids and exact times are in the
 * detail drawer a row opens; a row only says "Expiring soon" when it is.
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
  Bell,
  History as HistoryIcon,
  Zap,
  PanelRightOpen,
} from 'lucide-react';
import {
  Button,
  IconButton,
  Modal,
  ModalBody,
  ModalFooter,
  useConfirm,
  Alert,
  Drawer,
  EmptyState,
  LoadingSpinner,
  SegmentedControl,
  FormGroup,
  FormLabel,
  FormHelp,
  FormInput,
  FormTextarea,
  PageHeader,
  UnderlineTabs,
  CompactRow,
  ShowAll,
  StatusLabel,
  FilterButton,
  type FilterValue,
  type OverflowMenuItem,
} from '@crewly/ui';
import { useTriggers } from '../hooks/useTriggers';
import { useCronTasks } from '../hooks/useCronTasks';
import { useTabParam } from '../hooks/useTabParam';
import { apiService } from '../services/api.service';
import {
  bucketSchedules,
  groupByTeam,
  formatAbsolute,
  formatRelative,
  formatShortDate,
  type ScheduleRow,
} from '../components/Triggers/schedule.utils';
import {
  SCHEDULE_FORM_TEXT,
  SCHEDULE_HISTORY_PAGE_SIZE,
  SCHEDULE_LIST_LIMIT,
  SCHEDULE_TEXT,
  SCHEDULES_TABS,
  type SchedulesTab,
} from '../constants/schedules.constants';
import type { TriggerType, CreateTriggerInput, EventSubscription } from '../types/trigger.types';
import type { Team } from '../types';

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
 * Pause or resume button for a live row (its one visible action).
 */
const PauseResumeButton: React.FC<{ row: ScheduleRow; actions: RowActions }> = ({ row, actions }) => {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };
  return row.status === 'active' ? (
    <IconButton size="sm" variant="ghost" icon={Pause} disabled={busy}
      onClick={() => run(() => actions.onPause(row))}
      title={SCHEDULE_TEXT.PAUSE} aria-label={`${SCHEDULE_TEXT.PAUSE} ${row.name}`} />
  ) : (
    <IconButton size="sm" variant="ghost" icon={Play} disabled={busy}
      onClick={() => run(() => actions.onResume(row))}
      title={SCHEDULE_TEXT.RESUME} aria-label={`${SCHEDULE_TEXT.RESUME} ${row.name}`} />
  );
};

/**
 * The status words worth showing on a row, most important first; nothing
 * when the schedule is simply running. Several can apply at once (an
 * expiring schedule that is also paused, or whose last run failed).
 */
const RowStatus: React.FC<{ row: ScheduleRow }> = ({ row }) => {
  const labels: React.ReactNode[] = [];
  if (row.expiringSoon) labels.push(<StatusLabel key="expiring" tone="attention" size="sm">{SCHEDULE_TEXT.EXPIRING_SOON}</StatusLabel>);
  if (row.lastResult?.status === 'failed') labels.push(<StatusLabel key="failed" tone="danger" size="sm">{SCHEDULE_TEXT.LAST_RUN_FAILED}</StatusLabel>);
  if (row.status === 'paused') labels.push(<StatusLabel key="paused" tone="attention" size="sm">{SCHEDULE_TEXT.PAUSED}</StatusLabel>);
  if (row.status === 'cancelled') labels.push(<StatusLabel key="cancelled" tone="neutral" size="sm">{SCHEDULE_TEXT.STATUS_CANCELLED}</StatusLabel>);
  if (row.status === 'exhausted') labels.push(<StatusLabel key="exhausted" tone="neutral" size="sm">{SCHEDULE_TEXT.STATUS_EXHAUSTED}</StatusLabel>);
  if (labels.length === 0) return null;
  return <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">{labels}</span>;
};

// =============================================================================
// Rows
// =============================================================================

interface RowProps {
  row: ScheduleRow;
  actions: RowActions;
  onOpen: (row: ScheduleRow) => void;
}

/**
 * One schedule as a compact row: name, then one quiet line (schedule · who ·
 * next run). Pause/resume is the visible action; details, cancel and delete
 * sit behind "⋯". Tapping the row opens the detail drawer.
 */
const ScheduleItem: React.FC<RowProps> = ({ row, actions, onOpen }) => {
  const live = isLiveRow(row);
  const ended = row.status === 'cancelled' || row.status === 'exhausted';
  const when = row.nextRunAt
    ? SCHEDULE_TEXT.NEXT_IN(formatRelative(row.nextRunAt))
    : ended && row.lastRunAt
      ? SCHEDULE_TEXT.RAN_AGO(formatRelative(row.lastRunAt))
      : null;

  const overflow: OverflowMenuItem[] = [
    { label: SCHEDULE_TEXT.OPEN_DETAILS, icon: PanelRightOpen, onClick: () => onOpen(row) },
  ];
  if (live) overflow.push({ label: SCHEDULE_TEXT.CANCEL, icon: XCircle, danger: true, separator: true, onClick: () => actions.onCancel(row) });
  if (!live && row.source === 'trigger') overflow.push({ label: SCHEDULE_TEXT.DELETE, icon: Trash2, danger: true, separator: true, onClick: () => actions.onDelete(row) });

  const meta = (
    <>
      <span title={row.cronExpression ? `${row.cronExpression}${row.timezone ? ` (${row.timezone})` : ''}` : undefined}>
        {row.scheduleText}
      </span>
      {row.runnerName && (
        <>
          <span aria-hidden="true"> · </span>
          <span>{row.runnerName}</span>
        </>
      )}
      {when && (
        <>
          <span aria-hidden="true"> · </span>
          <span title={formatAbsolute(row.nextRunAt ?? row.lastRunAt)}>{when}</span>
        </>
      )}
      {row.internal && (
        <>
          <span aria-hidden="true"> · </span>
          <span>{SCHEDULE_TEXT.SYSTEM_CHIP}</span>
        </>
      )}
    </>
  );

  return (
    <CompactRow
      data-testid="schedule-row"
      primary={row.name}
      meta={meta}
      onClick={() => onOpen(row)}
      trailing={<RowStatus row={row} />}
      actions={live ? [<PauseResumeButton key="pause" row={row} actions={actions} />] : undefined}
      overflow={overflow}
      overflowLabel={SCHEDULE_TEXT.MORE_ACTIONS(row.name)}
    />
  );
};

/** One list of rows: a single surface, about five rows, then "Show all N". */
const RowList: React.FC<Omit<RowProps, 'row'> & { rows: ScheduleRow[]; limit?: number }> = ({ rows, limit = SCHEDULE_LIST_LIMIT, ...rest }) => (
  <div className="overflow-hidden rounded-2xl border border-border-soft bg-surface">
    <ShowAll limit={limit}>
      {rows.map((row) => <ScheduleItem key={row.key} row={row} {...rest} />)}
    </ShowAll>
  </div>
);

/** Section heading inside a tab: name + count, quiet. */
const ListHeading: React.FC<{ icon?: React.ElementType; children: React.ReactNode; count: number }> = ({ icon: Icon, children, count }) => (
  <h2 className="flex items-center gap-2 px-1 text-[15px] font-semibold text-text">
    {Icon && <Icon className="h-4 w-4 text-text-3" aria-hidden="true" />}
    {children}
    <span className="text-[13px] font-normal text-text-3">{count}</span>
  </h2>
);

// =============================================================================
// Detail drawer
// =============================================================================

/** One label/value line in the detail drawer. */
const DetailLine: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex gap-3 py-1.5 text-sm">
    <dt className="w-20 flex-shrink-0 text-text-2">{label}</dt>
    <dd className="min-w-0 flex-1 text-text break-words">{children}</dd>
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
      : `${SCHEDULE_TEXT.RESULT_FAILED}${row.lastResult.detail ? `: ${row.lastResult.detail}` : ''}`
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
            <DetailLine label={SCHEDULE_FORM_TEXT.RUNS}>
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
          <div className="text-xs font-medium text-text-2 mb-1">{SCHEDULE_TEXT.DESCRIPTION}</div>
          <div className="text-sm text-text whitespace-pre-wrap break-words rounded-[0.5rem] border border-border-soft bg-bg/40 p-3">
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
    if (type === 'time' && !cronExpression.trim()) { setError(SCHEDULE_FORM_TEXT.ERROR_CRON); return; }
    if (type === 'signal' && !eventType.trim()) { setError(SCHEDULE_FORM_TEXT.ERROR_EVENT); return; }
    if (!messageTarget.trim() || !messageText.trim()) { setError(SCHEDULE_FORM_TEXT.ERROR_TARGET); return; }

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
      setError(err instanceof Error ? err.message : SCHEDULE_FORM_TEXT.ERROR_CREATE);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={SCHEDULE_FORM_TEXT.TITLE} size="md">
      <ModalBody>
        <div className="space-y-4">
          <FormGroup>
            <FormLabel>{SCHEDULE_FORM_TEXT.TYPE}</FormLabel>
            <SegmentedControl<TriggerType>
              aria-label="Trigger type"
              value={type}
              onChange={setType}
              options={[
                { value: 'time', label: SCHEDULE_FORM_TEXT.TYPE_TIME, icon: Clock },
                { value: 'signal', label: SCHEDULE_FORM_TEXT.TYPE_SIGNAL, icon: Zap },
              ]}
            />
          </FormGroup>

          <FormGroup>
            <FormLabel htmlFor="trigger-name">{SCHEDULE_FORM_TEXT.NAME}</FormLabel>
            <FormInput id="trigger-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={SCHEDULE_FORM_TEXT.NAME_PLACEHOLDER} />
          </FormGroup>

          {type === 'time' && (
            <FormGroup>
              <FormLabel htmlFor="trigger-cron">{SCHEDULE_FORM_TEXT.CRON}</FormLabel>
              <FormInput id="trigger-cron" className="font-mono"
                value={cronExpression} onChange={(e) => setCronExpression(e.target.value)} placeholder="0 9 * * 1-5" />
              <FormHelp>{SCHEDULE_FORM_TEXT.CRON_HELP}</FormHelp>
            </FormGroup>
          )}

          {type === 'signal' && (
            <FormGroup>
              <FormLabel htmlFor="trigger-event-type">{SCHEDULE_FORM_TEXT.EVENT_TYPE}</FormLabel>
              <FormInput id="trigger-event-type" className="font-mono"
                value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="agent:idle" />
            </FormGroup>
          )}

          <FormGroup>
            <FormLabel htmlFor="trigger-target">{SCHEDULE_FORM_TEXT.TARGET}</FormLabel>
            <FormInput id="trigger-target" className="font-mono"
              value={messageTarget} onChange={(e) => setMessageTarget(e.target.value)} placeholder={SCHEDULE_FORM_TEXT.TARGET_PLACEHOLDER} />
          </FormGroup>

          <FormGroup>
            <FormLabel htmlFor="trigger-message">{SCHEDULE_FORM_TEXT.MESSAGE}</FormLabel>
            <FormTextarea id="trigger-message"
              rows={3} value={messageText} onChange={(e) => setMessageText(e.target.value)} placeholder={SCHEDULE_FORM_TEXT.MESSAGE_PLACEHOLDER} />
          </FormGroup>

          <FormGroup>
            <FormLabel htmlFor="trigger-max-fires">{SCHEDULE_FORM_TEXT.MAX_FIRES}</FormLabel>
            <div className="w-32">
              <FormInput id="trigger-max-fires" type="number" min="1"
                value={maxFires} onChange={(e) => setMaxFires(e.target.value)} placeholder="∞" />
            </div>
            <FormHelp>{SCHEDULE_FORM_TEXT.MAX_FIRES_HELP}</FormHelp>
          </FormGroup>

          {error && <Alert variant="error">{error}</Alert>}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>{SCHEDULE_FORM_TEXT.CANCEL}</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitting} loading={submitting}>
          {submitting ? SCHEDULE_FORM_TEXT.CREATING : SCHEDULE_FORM_TEXT.CREATE}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

// =============================================================================
// Page
// =============================================================================

/** Filter groups on the page: team (any tab) and whether system tasks show. */
const FILTER_SYSTEM = 'system';

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
  const [tab, setTab] = useTabParam<SchedulesTab>(SCHEDULES_TABS);
  const [filters, setFilters] = useState<FilterValue>({});
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [eventSubs, setEventSubs] = useState<EventSubscription[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(0);

  const showSystem = (filters.show ?? []).includes(FILTER_SYSTEM);
  const teamFilter = filters.team ?? [];
  const setShowSystem = (on: boolean) => setFilters((f) => ({ ...f, show: on ? [FILTER_SYSTEM] : [] }));

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

  /** Team filter applied to one bucket ("Other" groups rows without a known team). */
  const byTeam = useMemo(() => {
    if (teamFilter.length === 0) return (rows: ScheduleRow[]) => rows;
    return (rows: ScheduleRow[]) => rows.filter((r) => teamFilter.includes(groupByTeam([r])[0]?.teamId ?? ''));
  }, [teamFilter]);

  const scheduled = useMemo(() => byTeam(buckets.scheduled), [byTeam, buckets.scheduled]);
  const reminders = useMemo(() => byTeam(buckets.reminders), [byTeam, buckets.reminders]);
  const events = useMemo(() => byTeam(buckets.events), [byTeam, buckets.events]);
  const history = useMemo(() => byTeam(buckets.history), [byTeam, buckets.history]);
  const scheduledGroups = useMemo(() => groupByTeam(scheduled), [scheduled]);

  /** Every team that has at least one row, for the Filter popover. */
  const teamOptions = useMemo(
    () => groupByTeam([...buckets.scheduled, ...buckets.reminders, ...buckets.events, ...buckets.history])
      .map((g) => ({ value: g.teamId, label: g.teamName, count: g.rows.length })),
    [buckets],
  );

  const allRows = useMemo(
    () => [...buckets.scheduled, ...buckets.reminders, ...buckets.events, ...buckets.history],
    [buckets],
  );
  const selected = selectedKey ? allRows.find((r) => r.key === selectedKey) ?? null : null;

  const historyPages = Math.max(1, Math.ceil(history.length / SCHEDULE_HISTORY_PAGE_SIZE));
  const page = Math.min(historyPage, historyPages - 1);
  const historyRows = history.slice(page * SCHEDULE_HISTORY_PAGE_SIZE, (page + 1) * SCHEDULE_HISTORY_PAGE_SIZE);

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
  const filtering = teamFilter.length > 0;

  const tabs = [
    { value: 'scheduled', label: SCHEDULE_TEXT.TAB_SCHEDULED, count: scheduled.length },
    { value: 'reminders', label: SCHEDULE_TEXT.TAB_REMINDERS, count: reminders.length + events.length },
    { value: 'history', label: SCHEDULE_TEXT.TAB_HISTORY, count: history.length },
  ];

  const noMatch = <p className="py-10 text-center text-sm text-text-2">{SCHEDULE_TEXT.NO_MATCH}</p>;

  const renderScheduled = () => {
    if (scheduled.length === 0) {
      if (filtering) return noMatch;
      return <EmptyState icon={Clock} title={SCHEDULE_TEXT.EMPTY_SCHEDULED_TITLE} description={SCHEDULE_TEXT.EMPTY_SCHEDULED_BODY} />;
    }
    return (
      <div className="flex flex-col gap-7">
        {scheduledGroups.map((group) => (
          <section key={group.teamId} className="flex flex-col gap-2" aria-label={group.teamName}>
            <ListHeading count={group.rows.length}>{group.teamName}</ListHeading>
            <RowList rows={group.rows} {...rowProps} />
          </section>
        ))}
      </div>
    );
  };

  const renderReminders = () => {
    if (reminders.length === 0 && events.length === 0) {
      if (filtering) return noMatch;
      return <EmptyState icon={Bell} title={SCHEDULE_TEXT.EMPTY_REMINDERS_TITLE} description={SCHEDULE_TEXT.EMPTY_REMINDERS_BODY} />;
    }
    return (
      <div className="flex flex-col gap-7">
        {reminders.length > 0 && <RowList rows={reminders} {...rowProps} />}
        {events.length > 0 && (
          <section className="flex flex-col gap-2" aria-label={SCHEDULE_TEXT.WAITING_EVENTS}>
            <ListHeading icon={Zap} count={events.length}>{SCHEDULE_TEXT.WAITING_EVENTS}</ListHeading>
            <RowList rows={events} {...rowProps} />
          </section>
        )}
      </div>
    );
  };

  const renderHistory = () => {
    if (history.length === 0) {
      if (filtering) return noMatch;
      return <EmptyState icon={HistoryIcon} title={SCHEDULE_TEXT.EMPTY_HISTORY_TITLE} description={SCHEDULE_TEXT.EMPTY_HISTORY_BODY} />;
    }
    return (
      <div className="flex flex-col gap-3">
        <p className="px-1 text-[13px] text-text-2">{SCHEDULE_TEXT.HISTORY_SUMMARY(history.length)}</p>
        <RowList rows={historyRows} limit={SCHEDULE_HISTORY_PAGE_SIZE} {...rowProps} />
        {historyPages > 1 && (
          <div className="flex items-center justify-center gap-3 text-xs text-text-2">
            <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setHistoryPage(page - 1)}>{SCHEDULE_TEXT.PREV_PAGE}</Button>
            <span>{SCHEDULE_TEXT.PAGE_OF(page + 1, historyPages)}</span>
            <Button variant="ghost" size="sm" disabled={page >= historyPages - 1} onClick={() => setHistoryPage(page + 1)}>{SCHEDULE_TEXT.NEXT_PAGE}</Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col min-w-0 max-w-4xl" data-testid="schedules-page">
      <PageHeader
        title={SCHEDULE_TEXT.PAGE_TITLE}
        subtitle={SCHEDULE_TEXT.PAGE_SUBTITLE}
        actions={
          <>
            <IconButton icon={RefreshCw} variant="outline" onClick={handleRefresh} loading={refreshing}
              title={SCHEDULE_TEXT.REFRESH} aria-label={SCHEDULE_TEXT.REFRESH} />
            <Button variant="primary" size="sm" icon={Plus} onClick={() => setShowCreateModal(true)}>{SCHEDULE_TEXT.NEW}</Button>
          </>
        }
        tabs={
          <UnderlineTabs
            aria-label="Schedule views"
            idPrefix="schedules"
            value={tab}
            onChange={(v) => setTab(v as SchedulesTab)}
            tabs={tabs}
          />
        }
      />

      {engineStatus && !engineStatus.running && (
        <Alert variant="warning" className="mb-4">{SCHEDULE_TEXT.ENGINE_STOPPED}</Alert>
      )}
      {error && <Alert variant="error" className="mb-4">{error}</Alert>}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FilterButton
          value={filters}
          onChange={(next) => { setFilters(next); setHistoryPage(0); }}
          groups={[
            ...(teamOptions.length > 1 ? [{ id: 'team', label: SCHEDULE_TEXT.FILTER_TEAM, options: teamOptions }] : []),
            { id: 'show', label: SCHEDULE_TEXT.FILTER_SHOW, options: [{ value: FILTER_SYSTEM, label: SCHEDULE_TEXT.FILTER_SYSTEM }] },
          ]}
        />
        {!showSystem && buckets.hiddenInternal > 0 && (
          <p className="text-[13px] text-text-3">
            <span>{SCHEDULE_TEXT.HIDDEN_SYSTEM_HINT(buckets.hiddenInternal)}</span>
            <span aria-hidden="true"> · </span>
            <button type="button" className="font-semibold text-primary-text hover:underline" onClick={() => setShowSystem(true)}>
              {SCHEDULE_TEXT.SHOW_HIDDEN}
            </button>
          </p>
        )}
      </div>

      <div
        role="tabpanel"
        id={`schedules-panel-${tab}`}
        aria-labelledby={`schedules-tab-${tab}`}
        className="pb-4"
      >
        {isLoading ? (
          <LoadingSpinner size="md" className="py-16" />
        ) : (
          <>
            {tab === 'scheduled' && renderScheduled()}
            {tab === 'reminders' && renderReminders()}
            {tab === 'history' && renderHistory()}
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
