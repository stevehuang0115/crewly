/**
 * Schedules page view-model: turns raw triggers and cron tasks into rows the
 * owner can read at a glance — a human name, the schedule in plain words, who
 * runs it, and how many runs are left. Pure functions only.
 *
 * @module components/Triggers/schedule.utils
 */

import type { Trigger, EventSubscription, TriggerLastFireResult } from '../../types/trigger.types';
import type { CronTask } from '../../types/cron-task.types';
import type { Team } from '../../types';
import {
  AUTO_FOLLOWUP_NAME_PATTERN,
  CREATOR_LABEL,
  ORCHESTRATOR_SESSION,
  RECONCILER_SUBSCRIBER,
  SCHEDULE_EXPIRY_WARN_REMAINING,
  SCHEDULE_TEXT,
  TIMEZONE_SHORT_LABEL,
  WEEKDAY_LABEL,
} from '../../constants/schedules.constants';

// =============================================================================
// Schedule text
// =============================================================================

/**
 * Short label for an IANA timezone ("ET", "北京时间", …).
 *
 * @param timezone - IANA name
 * @returns Short label, or the city part of the name
 */
export function timezoneLabel(timezone: string | undefined): string {
  if (!timezone) return '';
  if (TIMEZONE_SHORT_LABEL[timezone]) return TIMEZONE_SHORT_LABEL[timezone];
  const city = timezone.split('/').pop() ?? timezone;
  return city.replace(/_/g, ' ');
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Parse a plain non-negative integer cron field; null for anything else. */
function asInt(field: string): number | null {
  return /^\d+$/.test(field) ? Number(field) : null;
}

/** Parse "1,3,5" / "1-5" / "5" into a sorted day-of-week list (0-6). */
function parseDow(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const range = part.match(/^(\d)-(\d)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) return null;
      for (let d = from; d <= to; d += 1) days.add(d % 7);
    } else if (/^\d$/.test(part)) {
      days.add(Number(part) % 7);
    } else {
      return null;
    }
  }
  return [...days].sort((a, b) => a - b);
}

/** Days phrase for a day-of-week list ("每天", "工作日", "每周五", "每周一、三"). */
function daysPhrase(days: number[]): string {
  const key = days.join(',');
  if (days.length === 7) return '每天';
  if (key === '1,2,3,4,5') return '工作日';
  if (key === '0,6') return '周末';
  return `每周${days.map((d) => WEEKDAY_LABEL[d]).join('、')}`;
}

/**
 * The time part of a cron expression in plain Chinese, without timezone.
 * Covers the shapes agents actually write; anything else returns null so the
 * caller can fall back to the raw expression.
 *
 * @param cron - 5-field cron expression
 * @returns e.g. "每天 22:30", "每周五 22:00", "每 15 分钟", or null
 */
export function describeCronCore(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts;
  if (month !== '*') return null;

  const everyMin = min.match(/^\*\/(\d+)$/);
  if (everyMin && hour === '*' && dom === '*' && dow === '*') {
    return Number(everyMin[1]) === 1 ? '每分钟' : `每 ${everyMin[1]} 分钟`;
  }
  if (min === '*' && hour === '*' && dom === '*' && dow === '*') return '每分钟';

  const m = asInt(min);
  if (m === null) return null;

  const everyHour = hour.match(/^\*\/(\d+)$/);
  if (everyHour && dom === '*' && dow === '*') {
    const n = Number(everyHour[1]);
    return n === 1 ? `每小时第 ${m} 分` : `每 ${n} 小时（第 ${m} 分）`;
  }
  if (hour === '*' && dom === '*' && dow === '*') return `每小时第 ${m} 分`;

  const hours = hour.split(',').map(asInt);
  if (hours.some((h) => h === null)) return null;
  const times = (hours as number[]).map((h) => `${pad2(h)}:${pad2(m)}`).join('、');

  if (dom === '*' && dow === '*') return `每天 ${times}`;
  if (dom === '*') {
    const days = parseDow(dow);
    return days ? `${daysPhrase(days)} ${times}` : null;
  }
  const d = asInt(dom);
  if (d !== null && dow === '*') return `每月 ${d} 日 ${times}`;
  return null;
}

/**
 * Plain-words schedule with timezone ("每天 22:30 ET"), falling back to the
 * raw cron expression when the shape is unusual.
 *
 * @param cron - 5-field cron expression
 * @param timezone - IANA timezone
 * @returns Human schedule text
 */
export function describeCron(cron: string, timezone?: string): string {
  const core = describeCronCore(cron);
  const tz = timezoneLabel(timezone);
  if (!core) return tz ? `${cron} (${tz})` : cron;
  // "每 15 分钟" does not depend on the timezone — leave it off.
  if (/^每( \d+ )?分钟$/.test(core) || core === '每分钟') return core;
  return tz ? `${core} ${tz}` : core;
}

// =============================================================================
// Time formatting
// =============================================================================

/**
 * Short absolute date-time ("10月1日 22:30").
 *
 * @param iso - ISO time
 * @returns Formatted text, or an em-dash
 */
export function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Short date ("11月24日").
 *
 * @param iso - ISO time
 * @returns Formatted date, or an em-dash
 */
export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * Relative time in Chinese ("3 小时后", "2 天前", "马上").
 *
 * @param iso - ISO time
 * @param now - Reference time (ms)
 * @returns Relative text, or an empty string for missing input
 */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = t - now;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return '马上';
  let text: string;
  if (minutes < 60) text = `${minutes} 分钟`;
  else if (minutes < 60 * 24) text = `${Math.round(minutes / 60)} 小时`;
  else text = `${Math.round(minutes / (60 * 24))} 天`;
  return diff >= 0 ? `${text}后` : `${text}前`;
}

// =============================================================================
// Classification
// =============================================================================

/**
 * Whether the owner should see this trigger without "show system". Uses the
 * backend's `internal` flag; a row from an older backend without it falls
 * back to the creator.
 *
 * @param trigger - Trigger to check
 * @returns True for harness-internal triggers
 */
export function isInternalTrigger(trigger: Trigger): boolean {
  if (typeof trigger.internal === 'boolean') return trigger.internal;
  return trigger.createdBy === 'system' || trigger.createdBy === 'delegate-task';
}

/**
 * Whether a trigger repeats on a cron schedule.
 *
 * @param trigger - Trigger to check
 * @returns True for a time trigger with a cron expression
 */
export function isRecurring(trigger: Trigger): boolean {
  return trigger.config.type === 'time' && !!trigger.config.cronExpression;
}

/** Live (still able to fire) statuses. */
export function isLive(trigger: Trigger): boolean {
  return trigger.status === 'active' || trigger.status === 'paused';
}

// =============================================================================
// Lookups
// =============================================================================

/** Lookups the rows need from the team list. */
export interface ScheduleDirectory {
  teamName: (teamId: string | undefined) => string | undefined;
  memberName: (session: string | undefined) => string | undefined;
  teamOfSession: (session: string | undefined) => string | undefined;
}

/**
 * Build name lookups from the team list.
 *
 * @param teams - All teams
 * @returns Directory of team and member names
 */
export function buildDirectory(teams: readonly Team[]): ScheduleDirectory {
  const teamNames = new Map<string, string>();
  const members = new Map<string, { name: string; teamId: string }>();
  for (const team of teams) {
    teamNames.set(team.id, team.name);
    for (const m of team.members ?? []) {
      if (m.sessionName) members.set(m.sessionName, { name: m.name, teamId: team.id });
    }
  }
  return {
    teamName: (id) => (id ? teamNames.get(id) : undefined),
    memberName: (session) => {
      if (!session) return undefined;
      if (session === ORCHESTRATOR_SESSION) return SCHEDULE_TEXT.ORCHESTRATOR;
      return members.get(session)?.name;
    },
    teamOfSession: (session) => (session ? members.get(session)?.teamId : undefined),
  };
}

// =============================================================================
// Rows
// =============================================================================

/** One line on the Scheduled / Reminders / History lists. */
export interface ScheduleRow {
  /** Unique React key */
  key: string;
  /** `trigger` = TriggerEngine row, `cron-task` = CronTaskService row, `event-sub` = EventBus subscription (read-only) */
  source: 'trigger' | 'cron-task' | 'event-sub';
  /** Id in its own store */
  id: string;
  /** Human name */
  name: string;
  /** Secondary line under the name (work item title when it differs) */
  subtitle?: string;
  /** Schedule in plain words */
  scheduleText: string;
  /** Raw cron, for hover / the detail view */
  cronExpression?: string;
  timezone?: string;
  status: Trigger['status'];
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastResult?: TriggerLastFireResult;
  /** Session that does the work */
  runnerSession?: string;
  /** Display name of that session */
  runnerName?: string;
  teamId?: string;
  teamName: string;
  fireCount?: number;
  maxFires?: number;
  remaining?: number;
  /** Few runs left — the owner should renew */
  expiringSoon: boolean;
  projectedEndAt?: string;
  headsUpSentAt?: string;
  description?: string;
  createdByLabel: string;
  createdAt?: string;
  internal: boolean;
  /** Reminders: waiting on an event rather than a time */
  eventType?: string;
}

/** Work item title / message of a trigger, if any. */
function actionTitle(trigger: Trigger): string | undefined {
  const title = trigger.action.createWorkItem?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : undefined;
}

/** Full description of what the trigger does. */
function actionDescription(trigger: Trigger): string | undefined {
  const desc = trigger.action.createWorkItem?.description;
  if (typeof desc === 'string' && desc.trim()) return desc;
  if (trigger.action.sendMessage?.message) return trigger.action.sendMessage.message;
  return actionTitle(trigger);
}

/** Session that does the work for a trigger. */
function actionRunner(trigger: Trigger): string | undefined {
  const target = trigger.action.createWorkItem?.target;
  if (typeof target === 'string' && target) return target;
  return trigger.action.sendMessage?.target;
}

/**
 * Plain schedule text for any trigger config.
 *
 * @param trigger - Trigger
 * @returns e.g. "每天 22:30 ET", "一次性提醒 · 10月1日 09:00", "当 agent:idle 发生时"
 */
export function triggerScheduleText(trigger: Trigger): string {
  const c = trigger.config;
  if (c.type === 'time') {
    if (c.cronExpression) return describeCron(c.cronExpression, c.timezone);
    const at = trigger.nextFireAt ?? c.fireAt;
    return at ? `${SCHEDULE_TEXT.ONE_SHOT} · ${formatAbsolute(at)}` : SCHEDULE_TEXT.ONE_SHOT;
  }
  if (c.type === 'signal') return SCHEDULE_TEXT.WHEN_EVENT(c.eventType);
  return `${c.operator.toUpperCase()} (${c.conditions.length})`;
}

/**
 * Human name: the trigger's `name` (unless auto-generated), else its work
 * item title, else the plain schedule ("每天 22:30").
 *
 * @param trigger - Trigger
 * @returns Name to show
 */
export function triggerDisplayName(trigger: Trigger): string {
  if (trigger.name && !AUTO_FOLLOWUP_NAME_PATTERN.test(trigger.name)) return trigger.name;
  return actionTitle(trigger) ?? triggerScheduleText(trigger);
}

/**
 * Who created a trigger, in words.
 *
 * @param trigger - Trigger
 * @param dir - Name lookups
 * @returns e.g. "Owen", "你", "系统"
 */
export function creatorLabel(trigger: Trigger, dir: ScheduleDirectory): string {
  if (trigger.createdBySession) {
    return dir.memberName(trigger.createdBySession) ?? trigger.createdBySession;
  }
  return CREATOR_LABEL[trigger.createdBy] ?? trigger.createdBy;
}

/**
 * Row for a TriggerEngine trigger.
 *
 * @param trigger - Trigger
 * @param dir - Name lookups
 * @returns Row
 */
export function triggerToRow(trigger: Trigger, dir: ScheduleDirectory): ScheduleRow {
  const runner = actionRunner(trigger);
  const teamId = trigger.teamId ?? dir.teamOfSession(runner) ?? dir.teamOfSession(trigger.createdBySession);
  const remaining = trigger.maxFires !== undefined ? Math.max(0, trigger.maxFires - trigger.fireCount) : undefined;
  const name = triggerDisplayName(trigger);
  const title = actionTitle(trigger);
  return {
    key: `trigger-${trigger.id}`,
    source: 'trigger',
    id: trigger.id,
    name,
    subtitle: title && title !== name ? title : undefined,
    scheduleText: triggerScheduleText(trigger),
    cronExpression: trigger.config.type === 'time' ? trigger.config.cronExpression : undefined,
    timezone: trigger.config.type === 'time' ? trigger.config.timezone : undefined,
    status: trigger.status,
    nextRunAt: isLive(trigger) ? trigger.nextFireAt : undefined,
    lastRunAt: trigger.lastFiredAt,
    lastResult: trigger.lastFireResult,
    runnerSession: runner,
    runnerName: dir.memberName(runner) ?? runner,
    teamId,
    teamName: dir.teamName(teamId) ?? SCHEDULE_TEXT.OTHER_TEAM,
    fireCount: trigger.fireCount,
    maxFires: trigger.maxFires,
    remaining,
    expiringSoon: isRecurring(trigger) && isLive(trigger) && remaining !== undefined && remaining <= SCHEDULE_EXPIRY_WARN_REMAINING,
    projectedEndAt: trigger.projectedLastFireAt,
    headsUpSentAt: trigger.expiryNoticeSentAt,
    description: actionDescription(trigger),
    createdByLabel: creatorLabel(trigger, dir),
    createdAt: trigger.createdAt,
    internal: isInternalTrigger(trigger),
    eventType: trigger.config.type === 'signal' ? trigger.config.eventType : undefined,
  };
}

/** First line of a cron task's description, without a 【title】 wrapper. */
function cronTaskTitle(task: CronTask): string | undefined {
  const text = (task.taskDescription ?? '').trim();
  if (!text) return undefined;
  const bracket = text.match(/^【([^】]+)】/);
  if (bracket) return bracket[1];
  const first = text.split('\n')[0];
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

/**
 * Row for a CronTaskService per-team cron task.
 *
 * @param task - Cron task
 * @param dir - Name lookups
 * @returns Row
 */
export function cronTaskToRow(task: CronTask, dir: ScheduleDirectory): ScheduleRow {
  const teamId = task.targetTeamId || dir.teamOfSession(task.targetAgent);
  const scheduleText = describeCron(task.cronExpression, task.timezone);
  return {
    key: `cron-${task.id}`,
    source: 'cron-task',
    id: task.id,
    name: cronTaskTitle(task) ?? describeCronCore(task.cronExpression) ?? task.cronExpression,
    scheduleText,
    cronExpression: task.cronExpression,
    timezone: task.timezone,
    status: task.enabled ? 'active' : 'paused',
    nextRunAt: task.enabled ? task.nextRunAt : undefined,
    lastRunAt: task.lastRunAt,
    runnerSession: task.targetAgent,
    runnerName: dir.memberName(task.targetAgent) ?? task.targetAgent,
    teamId,
    teamName: dir.teamName(teamId) ?? SCHEDULE_TEXT.OTHER_TEAM,
    expiringSoon: false,
    description: task.taskDescription,
    createdByLabel: CREATOR_LABEL[task.createdBy] ?? task.createdBy,
    createdAt: task.createdAt,
    internal: false,
  };
}

/**
 * Row for an EventBus subscription (shown under Reminders → 等待事件).
 *
 * @param sub - Subscription
 * @param dir - Name lookups
 * @returns Row
 */
export function eventSubToRow(sub: EventSubscription, dir: ScheduleDirectory): ScheduleRow {
  const internal = sub.subscriberSession === RECONCILER_SUBSCRIBER;
  const teamId = dir.teamOfSession(sub.subscriberSession);
  return {
    key: `sub-${sub.id}`,
    source: 'event-sub',
    id: sub.id,
    name: SCHEDULE_TEXT.WHEN_EVENT(sub.eventType),
    scheduleText: sub.oneShot ? SCHEDULE_TEXT.ONE_SHOT : SCHEDULE_TEXT.WHEN_EVENT(sub.eventType),
    status: 'active',
    nextRunAt: undefined,
    runnerSession: sub.subscriberSession,
    runnerName: internal ? CREATOR_LABEL.system : (dir.memberName(sub.subscriberSession) ?? sub.subscriberSession),
    teamId,
    teamName: dir.teamName(teamId) ?? SCHEDULE_TEXT.OTHER_TEAM,
    expiringSoon: false,
    createdByLabel: internal ? CREATOR_LABEL.system : (dir.memberName(sub.subscriberSession) ?? sub.subscriberSession),
    createdAt: sub.createdAt,
    internal,
    eventType: sub.eventType,
  };
}

// =============================================================================
// Buckets
// =============================================================================

/** Rows split into the page's three tabs. */
export interface ScheduleBuckets {
  /** Active + paused recurring schedules */
  scheduled: ScheduleRow[];
  /** Active one-shot reminders */
  reminders: ScheduleRow[];
  /** Live event subscriptions / signal waits */
  events: ScheduleRow[];
  /** Cancelled / exhausted, newest first */
  history: ScheduleRow[];
  /** Internal rows left out because "show system" is off */
  hiddenInternal: number;
  /** Active recurring schedules (the nav badge) */
  activeRecurring: number;
}

/** Inputs to {@link bucketSchedules}. */
export interface BucketInput {
  triggers: readonly Trigger[];
  cronTasks: readonly CronTask[];
  eventSubs: readonly EventSubscription[];
  teams: readonly Team[];
  showSystem: boolean;
}

/** Sort key for "soonest next run first", rows without one last. */
function byNextRun(a: ScheduleRow, b: ScheduleRow): number {
  const ta = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
  const tb = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;
  return a.name.localeCompare(b.name);
}

/**
 * Split everything into the page's tabs.
 *
 * @param input - Raw lists + the "show system" toggle
 * @returns Buckets
 */
export function bucketSchedules(input: BucketInput): ScheduleBuckets {
  const dir = buildDirectory(input.teams);
  const scheduled: ScheduleRow[] = [];
  const reminders: ScheduleRow[] = [];
  const events: ScheduleRow[] = [];
  const history: ScheduleRow[] = [];
  let hiddenInternal = 0;
  let activeRecurring = 0;

  for (const trigger of input.triggers) {
    const internal = isInternalTrigger(trigger);
    if (internal && !input.showSystem) {
      if (isLive(trigger)) hiddenInternal += 1;
      continue;
    }
    const row = triggerToRow(trigger, dir);
    if (!isLive(trigger)) history.push(row);
    else if (isRecurring(trigger)) {
      scheduled.push(row);
      if (trigger.status === 'active' && !internal) activeRecurring += 1;
    } else if (trigger.config.type === 'time') reminders.push(row);
    else events.push(row);
  }

  for (const task of input.cronTasks) {
    scheduled.push(cronTaskToRow(task, dir));
    if (task.enabled) activeRecurring += 1;
  }

  for (const sub of input.eventSubs) {
    const row = eventSubToRow(sub, dir);
    if (row.internal && !input.showSystem) {
      hiddenInternal += 1;
      continue;
    }
    events.push(row);
  }

  scheduled.sort(byNextRun);
  reminders.sort(byNextRun);
  history.sort((a, b) => {
    const ta = new Date(a.lastRunAt ?? a.createdAt ?? 0).getTime();
    const tb = new Date(b.lastRunAt ?? b.createdAt ?? 0).getTime();
    return tb - ta;
  });

  return { scheduled, reminders, events, history, hiddenInternal, activeRecurring };
}

/** Rows of one team. */
export interface TeamGroup {
  teamId: string;
  teamName: string;
  rows: ScheduleRow[];
}

/**
 * Group rows by team, teams sorted by name with "其他" last.
 *
 * @param rows - Rows to group (order inside a group is kept)
 * @returns Groups
 */
export function groupByTeam(rows: readonly ScheduleRow[]): TeamGroup[] {
  const groups = new Map<string, TeamGroup>();
  for (const row of rows) {
    const key = row.teamId && row.teamName !== SCHEDULE_TEXT.OTHER_TEAM ? row.teamId : '__other__';
    const group = groups.get(key) ?? { teamId: key, teamName: key === '__other__' ? SCHEDULE_TEXT.OTHER_TEAM : row.teamName, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.teamId === '__other__') return 1;
    if (b.teamId === '__other__') return -1;
    return a.teamName.localeCompare(b.teamName);
  });
}
