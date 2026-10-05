/**
 * Ticket autopilot stats (specs/2026-10-03-autopilot-experiments.md §2):
 * per day and in total, what the autopilot moved (tickets triaged / started /
 * done / verified / sent back / stalled, cycle times, goal replans), how much the owner had
 * to step in, where it stalled and why, how much the harness pushed, what it
 * cost against the daily budget, and how long it sat paused on the budget.
 *
 * Pure: built from the trace events and the #984 metrics of the project's
 * tagged traces (the run traces and the ticket traces) plus the token ledger
 * numbers the caller passes in. No I/O.
 *
 * @module services/project-tickets/ticket-autopilot-stats
 */

import { computeTraceMetrics, STALL_CAUSES, usageOfEvent, type StallCause, type TraceMetrics } from '../trace/trace-metrics.js';
import type { TraceEvent, TraceIndexEntry } from '../trace/trace.types.js';
import { localDateKey } from './ticket-autopilot-decision.js';
import type { ExperimentProcessSummary } from '../../types/experiment.types.js';

/** One trace as the stats read it. */
export interface StatsTrace {
  entry: TraceIndexEntry;
  events: TraceEvent[];
  /**
   * #984 metrics computed with `detail` (every stall, each owner touch with
   * its time). Absent = computed here from the events.
   */
  metrics?: TraceMetrics | null;
}

/** Token ledger numbers of one day (the project's team sessions). */
export interface LedgerDay {
  /** Cost-weighted (budget) tokens: what the budget compares */
  tokens: number;
  /** Raw tokens (input incl. cached + output), for reporting */
  rawTokens?: number;
  costUsd: number;
}

/** Input of {@link computeAutopilotStats}. */
export interface AutopilotStatsInput {
  projectId: string;
  /** Only ticket traces carrying this label (null = all) */
  label?: string | null;
  /** Local days of the range, oldest first (YYYY-MM-DD) */
  days: string[];
  /** Run and ticket traces tagged with the project, active in the range */
  traces: StatsTrace[];
  /** Ledger per day (missing = 0) */
  ledger?: Record<string, LedgerDay>;
  /** Today's configured budget (tokens) */
  dailyBudgetTokens: number;
  /** Stall threshold the metrics used (minutes) */
  stallMinutes: number;
  now: Date;
  /** Traces that could not be read (the result is then incomplete) */
  unreadable?: number;
}

/** Median / mean of a set of durations. */
export interface CycleStat {
  count: number;
  medianMs: number | null;
  meanMs: number | null;
}

/** Owner touches (the #984 kinds; `manual` is not collected yet). */
export interface OwnerTouchCounts {
  answered: number;
  approved: number;
  sentBack: number;
  corrected: number;
  total: number;
}

/** Stalls by cause. */
export interface StallCounts {
  count: number;
  totalMs: number;
  byCause: Record<StallCause, { count: number; ms: number }>;
}

/** Harness interventions (the #984 definitions, counted by event day). */
export interface InterventionCounts {
  nudges: number;
  redeliveries: number;
  wakes: number;
  corrections: number;
  guardBlocks: number;
  misroutes: number;
  total: number;
}

/** The ledger against the budget. */
export interface BudgetUse {
  dailyBudgetTokens: number;
  /** Cost-weighted (budget) tokens, the unit {@link dailyBudgetTokens} is in */
  ledgerTokens: number;
  /** Raw tokens, for reporting */
  ledgerRawTokens: number;
  ledgerCostUsd: number;
  /** ledgerTokens / dailyBudgetTokens (0 with no budget) */
  pct: number;
}

/** Numbers of a day, or of the whole range. */
export interface AutopilotPeriodStats {
  triaged: number;
  /**
   * Goal replans: the driver woken to open the next tickets toward the goal
   * (specs/2026-10-04-autopilot-goal-replan.md). Not an owner touch.
   */
  replans: number;
  started: number;
  done: number;
  verified: number;
  sentBack: number;
  stalled: number;
  cycleTime: { toDone: CycleStat; toVerified: CycleStat };
  ownerTouches: OwnerTouchCounts;
  stalls: StallCounts;
  interventions: InterventionCounts;
  /** Tokens / USD of the traced autopilot work (run + ticket traces), by event day */
  tokens: number;
  costUsd: number;
  budget: BudgetUse;
  /** Time paused on the daily budget */
  pausedMs: number;
}

/** One day. */
export interface AutopilotDayStats extends AutopilotPeriodStats {
  day: string;
  /** The day's run trace */
  runTraceId: string | null;
  /** Ticket traces whose work started that day */
  ticketTraceIds: string[];
}

/** {@link computeAutopilotStats} output. */
export interface AutopilotStats {
  projectId: string;
  label: string | null;
  range: { start: string; end: string };
  stallMinutes: number;
  /** Oldest first */
  days: AutopilotDayStats[];
  total: AutopilotPeriodStats;
  /** Every label seen on the project's ticket traces (for a filter) */
  labels: string[];
  /** The budget and paused time are project-wide even with a label */
  scope: { budget: 'project'; pausedMs: 'project' };
  /** Run and ticket traces in the range (0 = no autopilot data, not zeros) */
  traceCount: number;
  /** Some traces could not be read: the numbers are short */
  incomplete: boolean;
}

/** Ticket status / work item status values the counts use. */
const WORK_DONE = new Set(['done_by_worker', 'done']);

/**
 * An empty stall map.
 *
 * @returns Zeroes per cause
 */
function emptyByCause(): Record<StallCause, { count: number; ms: number }> {
  const out = {} as Record<StallCause, { count: number; ms: number }>;
  for (const c of STALL_CAUSES) out[c] = { count: 0, ms: 0 };
  return out;
}

/** Mutable accumulator of a period. */
interface Acc {
  triaged: Set<string>;
  replans: number;
  started: Set<string>;
  done: Set<string>;
  verified: Set<string>;
  sentBack: number;
  stalled: Set<string>;
  toDone: number[];
  toVerified: number[];
  ownerTouches: OwnerTouchCounts;
  stalls: StallCounts;
  interventions: InterventionCounts;
  tokens: number;
  costUsd: number;
  ledgerTokens: number;
  ledgerRawTokens: number;
  ledgerCostUsd: number;
  pausedMs: number;
}

/**
 * A fresh accumulator.
 *
 * @returns Zeroed accumulator
 */
function newAcc(): Acc {
  return {
    triaged: new Set(),
    replans: 0,
    started: new Set(),
    done: new Set(),
    verified: new Set(),
    sentBack: 0,
    stalled: new Set(),
    toDone: [],
    toVerified: [],
    ownerTouches: { answered: 0, approved: 0, sentBack: 0, corrected: 0, total: 0 },
    stalls: { count: 0, totalMs: 0, byCause: emptyByCause() },
    interventions: { nudges: 0, redeliveries: 0, wakes: 0, corrections: 0, guardBlocks: 0, misroutes: 0, total: 0 },
    tokens: 0,
    costUsd: 0,
    ledgerTokens: 0,
    ledgerRawTokens: 0,
    ledgerCostUsd: 0,
    pausedMs: 0,
  };
}

/**
 * Median and mean.
 *
 * @param xs - Durations
 * @returns Stat
 */
export function cycleStat(xs: number[]): CycleStat {
  if (xs.length === 0) return { count: 0, medianMs: null, meanMs: null };
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return { count: s.length, medianMs: Math.round(median), meanMs: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
}

/**
 * The finished numbers of an accumulator.
 *
 * @param a - Accumulator
 * @param budget - Daily budget (tokens; × days for a range)
 * @returns Period stats
 */
function finish(a: Acc, budget: number): AutopilotPeriodStats {
  return {
    triaged: a.triaged.size,
    replans: a.replans,
    started: a.started.size,
    done: a.done.size,
    verified: a.verified.size,
    sentBack: a.sentBack,
    stalled: a.stalled.size,
    cycleTime: { toDone: cycleStat(a.toDone), toVerified: cycleStat(a.toVerified) },
    ownerTouches: { ...a.ownerTouches },
    stalls: { count: a.stalls.count, totalMs: a.stalls.totalMs, byCause: Object.fromEntries(Object.entries(a.stalls.byCause).map(([k, v]) => [k, { ...v }])) as StallCounts['byCause'] },
    interventions: { ...a.interventions },
    tokens: a.tokens,
    costUsd: Math.round(a.costUsd * 10_000) / 10_000,
    budget: {
      dailyBudgetTokens: budget,
      ledgerTokens: a.ledgerTokens,
      ledgerRawTokens: a.ledgerRawTokens,
      ledgerCostUsd: Math.round(a.ledgerCostUsd * 10_000) / 10_000,
      pct: budget > 0 ? Math.round((a.ledgerTokens / budget) * 1000) / 1000 : 0,
    },
    pausedMs: a.pausedMs,
  };
}

/**
 * Local midnight of a day key.
 *
 * @param day - YYYY-MM-DD
 * @returns Epoch ms
 */
export function dayStartMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/**
 * The next local midnight after a day starts (23 or 25 hours on a DST day).
 *
 * @param day - YYYY-MM-DD
 * @returns Epoch ms
 */
export function dayEndMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
}

/**
 * A local day shifted by whole days.
 *
 * @param day - YYYY-MM-DD
 * @param delta - Days (negative = earlier)
 * @returns YYYY-MM-DD
 */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return localDateKey(new Date(y, m - 1, d + delta, 12));
}

/**
 * The local days of a range ending today, oldest first.
 *
 * @param now - Today
 * @param days - Number of days (today included)
 * @returns Day keys
 */
export function rangeDays(now: Date, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12);
    out.push(localDateKey(d));
  }
  return out;
}

/**
 * The days between two dates (inclusive), oldest first.
 *
 * @param start - YYYY-MM-DD
 * @param end - YYYY-MM-DD
 * @returns Day keys
 */
export function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const s = dayStartMs(start);
  const e = dayStartMs(end);
  for (let i = 0; i < 400; i += 1) {
    const d = new Date(s);
    d.setDate(d.getDate() + i);
    d.setHours(12);
    if (d.getTime() > e + 12 * 3_600_000) break;
    out.push(localDateKey(d));
  }
  return out;
}

/**
 * A data value as a string.
 *
 * @param e - Event
 * @param key - Data key
 * @returns String or undefined
 */
function dataStr(e: TraceEvent, key: string): string | undefined {
  const v = e.data?.[key];
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
}

/**
 * Whether a comma-separated label list holds a label.
 *
 * @param list - "a,b"
 * @param label - Label
 * @returns True on a case-insensitive match
 */
function hasLabel(list: string | undefined, label: string): boolean {
  return (list ?? '')
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .includes(label.toLowerCase());
}

/** What happened to one ticket inside a trace. */
interface TicketLife {
  startAt?: number;
  doneAt?: number;
  verifiedAt?: number;
}

/** Root kinds that are autopilot bookkeeping (not a ticket's work). */
const RUN_KINDS: ReadonlySet<string> = new Set(['autopilot', 'triage']);

/**
 * When the autopilot's work on a ticket trace began: its first claim /
 * dispatch, else its first move to in_progress. Earlier events of a reused
 * trace (e.g. the Request conversation that created the ticket) are not
 * the autopilot's.
 *
 * @param events - Sorted events
 * @returns Epoch ms, or null when the trace never started work
 */
function workStartOf(events: ReadonlyArray<TraceEvent>): number | null {
  for (const e of events) {
    const action = e.type === 'autopilot.action' ? dataStr(e, 'action') : undefined;
    if (action === 'claim' || action === 'dispatch' || (e.type === 'ticket.status' && dataStr(e, 'to') === 'in_progress')) return Date.parse(e.ts);
  }
  return null;
}

/**
 * Compute the autopilot stats of a project over a range of days.
 *
 * Everything counts on the local day it happened: ticket moves, owner
 * touches (each touch's own time), stalls (their start), interventions,
 * tokens; paused time is clipped to each day. A ticket trace counts only
 * from the moment the autopilot started work on it.
 *
 * @param input - Traces, ledger, range, label
 * @returns Stats per day and in total
 */
export function computeAutopilotStats(input: AutopilotStatsInput): AutopilotStats {
  const label = input.label ? input.label.trim() : null;
  const days = input.days;
  const inRange = new Set(days);
  const accs = new Map<string, Acc>(days.map((d) => [d, newAcc()]));
  const total = newAcc();
  const dayOf = (ms: number): string => localDateKey(new Date(ms));
  const at = (day: string): Acc | null => accs.get(day) ?? null;
  const runTraces = new Map<string, string>();
  const ticketTraces = new Map<string, string[]>(days.map((d) => [d, []]));
  const labels = new Set<string>();
  const nowMs = input.now.getTime();
  let traceCount = 0;

  const isRun = (t: StatsTrace): boolean => RUN_KINDS.has(t.entry.root.kind);
  for (const t of input.traces) for (const l of t.entry.tags?.labels ?? []) labels.add(l);

  // Paused time (project-wide): budget_paused → budget_resumed, clipped to the pause's day.
  const budgetEvents = input.traces
    .filter(isRun)
    .flatMap((t) => t.events)
    .filter((e) => e.type === 'autopilot.action' && (dataStr(e, 'action') === 'budget_paused' || dataStr(e, 'action') === 'budget_resumed'))
    .map((e) => ({ action: dataStr(e, 'action'), t: Date.parse(e.ts) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  const pauses: Array<[number, number]> = [];
  let openAt: number | null = null;
  const closePause = (end: number): void => {
    if (openAt === null) return;
    pauses.push([openAt, Math.min(end, dayEndMs(dayOf(openAt)), nowMs)]);
    openAt = null;
  };
  for (const b of budgetEvents) {
    if (openAt !== null && dayOf(b.t) !== dayOf(openAt)) closePause(b.t);
    if (b.action === 'budget_paused' && openAt === null) openAt = b.t;
    else if (b.action === 'budget_resumed') closePause(b.t);
  }
  closePause(nowMs);
  for (const [s, e] of pauses) {
    if (e <= s) continue;
    const acc = at(dayOf(s));
    if (!acc) continue;
    acc.pausedMs += e - s;
    total.pausedMs += e - s;
  }

  // Ledger (project-wide).
  for (const day of days) {
    const l = input.ledger?.[day];
    if (!l) continue;
    const acc = accs.get(day) as Acc;
    acc.ledgerTokens += l.tokens;
    acc.ledgerRawTokens += l.rawTokens ?? l.tokens;
    acc.ledgerCostUsd += l.costUsd;
    total.ledgerTokens += l.tokens;
    total.ledgerRawTokens += l.rawTokens ?? l.tokens;
    total.ledgerCostUsd += l.costUsd;
  }

  for (const trace of input.traces) {
    const run = isRun(trace);
    const tagDay = trace.entry.tags?.autopilot?.day;
    if (run) {
      if (trace.entry.root.kind === 'autopilot' && tagDay && inRange.has(tagDay)) runTraces.set(tagDay, trace.entry.traceId);
    } else if (label && !(trace.entry.tags?.labels ?? []).some((l) => l.toLowerCase() === label.toLowerCase())) {
      continue;
    }
    traceCount += 1;
    if (!run && tagDay && ticketTraces.has(tagDay)) ticketTraces.get(tagDay)?.push(trace.entry.traceId);

    const events = [...trace.events].filter((e) => Number.isFinite(Date.parse(e.ts))).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const workStart = run ? -Infinity : workStartOf(events);
    if (workStart === null) continue;
    const wiTicket = new Map<string, string>();
    for (const e of events) if (e.refs.workItemId && e.refs.ticketId) wiTicket.set(e.refs.workItemId, e.refs.ticketId);
    const ticketIds = new Set(events.filter((e) => e.type === 'ticket.status' && e.refs.ticketId).map((e) => e.refs.ticketId as string));
    const onlyTicket = ticketIds.size === 1 ? [...ticketIds][0] : undefined;
    const ticketOf = (e: TraceEvent): string | undefined =>
      e.refs.ticketId && ticketIds.has(e.refs.ticketId) ? e.refs.ticketId : (e.refs.workItemId && wiTicket.get(e.refs.workItemId)) || onlyTicket;
    const lives = new Map<string, TicketLife>();
    const life = (id: string): TicketLife => {
      let l = lives.get(id);
      if (!l) {
        l = {};
        lives.set(id, l);
      }
      return l;
    };

    for (const e of events) {
      const t = Date.parse(e.ts);
      const day = dayOf(t);
      const acc = at(day);
      const both = (fn: (a: Acc) => void): void => {
        if (!acc) return;
        fn(acc);
        fn(total);
      };
      const action = e.type === 'autopilot.action' ? dataStr(e, 'action') : undefined;
      if (run && action === 'triage_ticket' && e.refs.ticketId) {
        if (label && !hasLabel(dataStr(e, 'labels'), label)) continue;
        const id = e.refs.ticketId;
        both((a) => a.triaged.add(id));
        continue;
      }
      if (run && action === 'replan') {
        // Project-wide (no ticket yet): a label filter does not hide it.
        if (trace.entry.root.kind === 'autopilot') both((a) => (a.replans += 1));
        continue;
      }
      if (t < workStart) continue;
      const usage = usageOfEvent(e);
      if (usage) {
        if (run && label) continue;
        both((a) => {
          a.tokens += usage.total;
          a.costUsd += usage.costUsd;
        });
        continue;
      }
      if (run) continue;
      const ticketId = ticketOf(e);
      switch (e.type) {
        case 'ticket.status': {
          if (!ticketId) break;
          const from = dataStr(e, 'from');
          const to = dataStr(e, 'to');
          const l = life(ticketId);
          if (to === 'in_progress') {
            if (l.startAt === undefined) l.startAt = t;
            both((a) => a.started.add(ticketId));
          } else if (to === 'review' && l.startAt !== undefined && l.doneAt === undefined) {
            l.doneAt = t;
            both((a) => {
              a.done.add(ticketId);
              a.toDone.push(t - (l.startAt as number));
            });
          } else if (to === 'done') {
            if (l.startAt !== undefined && l.doneAt === undefined) {
              l.doneAt = t;
              both((a) => {
                a.done.add(ticketId);
                a.toDone.push(t - (l.startAt as number));
              });
            }
            if (l.verifiedAt === undefined) {
              l.verifiedAt = t;
              both((a) => {
                a.verified.add(ticketId);
                if (l.startAt !== undefined) a.toVerified.push(t - l.startAt);
              });
            }
          }
          if (to === 'ready' && (from === 'review' || from === 'done')) both((a) => (a.sentBack += 1));
          break;
        }
        case 'workitem.status': {
          const from = dataStr(e, 'from');
          const to = dataStr(e, 'to') ?? '';
          if (from === 'done_by_worker' && to === 'rejected') both((a) => (a.sentBack += 1));
          if (!ticketId || !WORK_DONE.has(to)) break;
          const l = life(ticketId);
          if (l.doneAt === undefined) {
            l.doneAt = t;
            both((a) => {
              a.done.add(ticketId);
              if (l.startAt !== undefined) a.toDone.push(t - (l.startAt as number));
            });
          }
          break;
        }
        case 'harness.nudge':
          both((a) => (a.interventions.nudges += 1));
          break;
        case 'harness.redelivery':
          both((a) => (a.interventions.redeliveries += 1));
          break;
        case 'harness.wake':
          both((a) => (a.interventions.wakes += 1));
          break;
        case 'harness.correction':
          both((a) => (a.interventions.corrections += 1));
          break;
        case 'guard.block':
          both((a) => (a.interventions.guardBlocks += 1));
          break;
        case 'message.outbound':
          if (e.outcome === 'failed') both((a) => (a.interventions.misroutes += 1));
          break;
        default:
          break;
      }
    }

    if (run) continue;
    const m =
      trace.metrics === undefined
        ? computeTraceMetrics(trace.entry.root, trace.events, { stallMinutes: input.stallMinutes, now: input.now, detail: true })
        : trace.metrics;
    if (!m) continue;
    // Owner touches: each on the day it happened, from the start of the autopilot's work.
    for (const touch of m.ownerTouchEvents ?? []) {
      const t = Date.parse(touch.at);
      if (!(t >= workStart)) continue;
      const tAcc = at(dayOf(t));
      if (!tAcc) continue;
      for (const a of [tAcc, total]) {
        a.ownerTouches[touch.kind] += 1;
        a.ownerTouches.total += 1;
      }
    }
    // Stalls: each on the day it started.
    const primary = onlyTicket ?? [...ticketIds][0] ?? trace.entry.traceId;
    for (const st of m.stalls.items) {
      const t = Date.parse(st.start);
      if (!(t >= workStart)) continue;
      const sAcc = at(dayOf(t));
      if (!sAcc) continue;
      for (const a of [sAcc, total]) {
        a.stalls.count += 1;
        a.stalls.totalMs += st.ms;
        a.stalls.byCause[st.cause].count += 1;
        a.stalls.byCause[st.cause].ms += st.ms;
        a.stalled.add(primary);
      }
    }
  }

  for (const a of [...accs.values(), total]) {
    const i = a.interventions;
    i.total = i.nudges + i.redeliveries + i.wakes + i.corrections + i.guardBlocks + i.misroutes;
  }

  return {
    projectId: input.projectId,
    label,
    range: { start: days[0] ?? '', end: days[days.length - 1] ?? '' },
    stallMinutes: input.stallMinutes,
    days: days.map((day) => ({
      day,
      ...finish(accs.get(day) as Acc, input.dailyBudgetTokens),
      runTraceId: runTraces.get(day) ?? null,
      ticketTraceIds: ticketTraces.get(day) ?? [],
    })),
    total: finish(total, input.dailyBudgetTokens * Math.max(1, days.length)),
    labels: [...labels].sort((a, b) => a.localeCompare(b)),
    scope: { budget: 'project', pausedMs: 'project' },
    traceCount,
    incomplete: (input.unreadable ?? 0) > 0,
  };
}

/** The process numbers an experiment compares (spec §3). */
export type AutopilotProcessSummary = ExperimentProcessSummary;

/**
 * The experiment's process summary of a stats range.
 *
 * @param stats - Stats of the range
 * @returns Summary
 */
export function processSummary(stats: AutopilotStats): AutopilotProcessSummary {
  const t = stats.total;
  const shipped = t.verified;
  const round = (n: number): number => Math.round(n * 100) / 100;
  return {
    range: { ...stats.range },
    ticketsStarted: t.started,
    ticketsDone: t.done,
    ticketsShipped: shipped,
    ownerTouches: t.ownerTouches.total,
    ownerTouchesPerTicket: shipped > 0 ? round(t.ownerTouches.total / shipped) : null,
    stalls: t.stalls.count,
    stallMs: t.stalls.totalMs,
    interventions: t.interventions.total,
    tokens: t.tokens,
    costUsd: round(t.costUsd),
    costPerShippedTicket: shipped > 0 ? round(t.costUsd / shipped) : null,
    pausedMs: t.pausedMs,
    ...(stats.traceCount === 0 ? { noData: true } : {}),
  };
}
