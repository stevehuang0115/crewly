/**
 * Ticket autopilot — the pure decisions (specs/2026-09-30-ticket-autopilot.md).
 *
 * Everything here is a function of its inputs (tickets, teams, clock, the
 * autopilot's own bookkeeping), so the rules can be unit-tested without a
 * pool, a filesystem or timers:
 * - which tickets need the driver's triage ({@link selectTriageCandidates});
 * - whether to wake the driver now ({@link decideTriage});
 * - whether to wake the driver to plan toward the goal when nothing is left
 *   to triage ({@link decideReplan}, specs/2026-10-04-autopilot-goal-replan.md);
 * - whether to send the owner the evening digest ({@link decideDigest});
 * - why the autopilot is not producing work ({@link classifyStopReason},
 *   specs/2026-10-04-autopilot-speed-modes.md);
 * - whether the driver's self-review is due ({@link decideSelfReview}).
 *
 * @module services/project-tickets/ticket-autopilot-decision
 */

import { ORCHESTRATOR_SESSION_NAME, PROJECT_TICKET_CONSTANTS, TICKET_AUTOPILOT_CONSTANTS } from '../../constants.js';
import { projectTicketPriorityRank, type ProjectTicket } from '../../types/project-ticket.types.js';
import type { Team, TeamMember } from '../../types/index.js';
import { isTeamLead } from '../../utils/team.utils.js';

/** A member's availability for new work (see {@link memberAvailability}). */
export type MemberAvailability = 'idle' | 'working' | 'stopped';

/** Why a ticket is put in front of the driver. */
export type TriageReason = 'backlog' | 'ready_no_taker' | 'ready_stale';

/** One ticket for the triage brief. */
export interface TriageCandidate {
  ticket: ProjectTicket;
  reason: TriageReason;
  /** Filed by a team member (not the owner, a lead or the orchestrator): review before it becomes ready */
  workerCreated: boolean;
}

/** When a ticket was last put in a triage brief, and how it looked then. */
export interface ListedTicket {
  /** Ticket `updatedAt` at the time it was listed */
  updatedAt: string;
  /** When it was listed (epoch ms) */
  at: number;
}

/** Inputs of {@link selectTriageCandidates}. */
export interface SelectTriageInput {
  tickets: ProjectTicket[];
  /** Non-archived teams working on the project */
  teams: Team[];
  /** Clock (epoch ms) */
  now: number;
  /** Tickets listed in earlier triage briefs (by ticket id) */
  listed?: Record<string, ListedTicket>;
  /**
   * Labels that keep a ticket out of triage (parked / deferred). Default:
   * {@link TICKET_AUTOPILOT_CONSTANTS.DEFAULT_SKIP_LABELS}.
   */
  skipLabels?: readonly string[];
}

/** Output of {@link selectTriageCandidates}. */
export interface TriageSelection {
  /** At most {@link TICKET_AUTOPILOT_CONSTANTS.TRIAGE_MAX_TICKETS}, highest priority then oldest first */
  candidates: TriageCandidate[];
  /** Tickets that need triage but did not fit in this brief */
  more: number;
}

/** What set off the evaluation. */
export type TriageTrigger = 'tick' | 'member_idle';

/** Inputs of {@link decideTriage}. */
export interface TriageDecisionInput {
  enabled: boolean;
  /** Resolved driver session, or null when the project has no lead */
  driver: string | null;
  trigger: TriageTrigger;
  /** Clock (epoch ms) */
  now: number;
  /** Tickets that need triage (after de-duplication) */
  candidateCount: number;
  /** A triage WorkItem of this project is still live */
  liveTriage: boolean;
  /**
   * When the project's live goal replan was created (epoch ms), absent when
   * none is live. It holds triage while the driver is opening tickets, but
   * yields once there are tickets to triage and it is older than
   * {@link TICKET_AUTOPILOT_CONSTANTS.REPLAN_YIELD_AFTER_MS}.
   */
  liveReplanAt?: number;
  /** When the last triage item was created (epoch ms) */
  lastTriageAt?: number;
  /** A member of the project's teams (or the driver) is idle */
  anyoneIdle: boolean;
  /** Tokens used today by the project's team agents */
  usedTodayTokens: number;
  /** Daily budget in tokens (boosts included); Infinity = unlimited today */
  dailyBudgetTokens: number;
}

/** Why the driver is not woken. */
export type TriageSkipReason =
  | 'off'
  | 'no_driver'
  | 'budget_reached'
  | 'triage_in_flight'
  | 'replan_in_flight'
  | 'nothing_to_triage'
  | 'nobody_idle'
  | 'too_soon';

/** Outcome of {@link decideTriage}. */
export type TriageDecision = { action: 'triage' } | { action: 'skip'; reason: TriageSkipReason };

/**
 * Whether a ticket carries the needs-owner label.
 *
 * @param ticket - Ticket
 * @returns True when it waits on the owner
 */
export function hasNeedsOwnerLabel(ticket: Pick<ProjectTicket, 'labels'>): boolean {
  return ticket.labels.includes(TICKET_AUTOPILOT_CONSTANTS.NEEDS_OWNER_LABEL);
}

/**
 * The one-line question for the owner recorded on a ticket (the latest Log
 * line written by `ask-owner`), or null.
 *
 * @param ticket - Ticket
 * @returns The question text, or null
 */
export function readOwnerQuestion(ticket: Pick<ProjectTicket, 'log'>): string | null {
  const prefix = TICKET_AUTOPILOT_CONSTANTS.OWNER_QUESTION_LOG_PREFIX;
  for (let i = ticket.log.length - 1; i >= 0; i--) {
    const at = ticket.log[i].indexOf(prefix);
    if (at >= 0) {
      const text = ticket.log[i].slice(at + prefix.length).trim();
      if (text) return text;
    }
  }
  return null;
}

/**
 * Whether a ticket was filed by a worker — an agent that is neither the
 * orchestrator nor a lead of one of the project's teams. Owner, request,
 * migration and lead/orc tickets are not worker-created.
 *
 * @param ticket - Ticket
 * @param teams - The project's teams
 * @returns True for a worker-created ticket
 */
export function isWorkerCreated(ticket: Pick<ProjectTicket, 'source'>, teams: Team[]): boolean {
  const source = ticket.source ?? '';
  if (!source.startsWith('agent:')) return false;
  const session = source.slice('agent:'.length).trim();
  if (!session || session === ORCHESTRATOR_SESSION_NAME) return false;
  for (const team of teams) {
    for (const m of team.members ?? []) {
      if ((m.sessionName === session || m.agentId === session) && isTeamLead(team, m)) return false;
    }
  }
  return true;
}

/**
 * Whether a member is running and idle.
 *
 * @param member - Team member
 * @returns True when active (or started) and not working
 */
export function isMemberIdle(member: Pick<TeamMember, 'agentStatus' | 'workingStatus'>): boolean {
  return (member.agentStatus === 'active' || member.agentStatus === 'started') && member.workingStatus === 'idle';
}

/**
 * How available a member is for a new ticket, as the triage brief shows it:
 * - `idle` — running with nothing to do (also while it is starting up);
 * - `working` — running and busy with a turn;
 * - `stopped` — not running (stopped, idle-stopped, suspended). Available:
 *   assigning it a ticket starts it. Never "busy".
 *
 * @param member - Team member
 * @returns The member's availability
 */
export function memberAvailability(member: Pick<TeamMember, 'agentStatus' | 'workingStatus'>): MemberAvailability {
  const status = member.agentStatus;
  if (status === 'active' || status === 'started') return member.workingStatus === 'in_progress' ? 'working' : 'idle';
  if (status === 'starting' || status === 'activating') return 'idle';
  return 'stopped';
}

/**
 * The one line saying what a member is responsible for, for the triage
 * brief: the member's own `jobDescription`, else its role's description
 * (`config/roles/<role>/role.json` or a user override), else a built-in line
 * for roles that ship without one ({@link TICKET_AUTOPILOT_CONSTANTS.ROLE_RESPONSIBILITY_FALLBACKS}).
 *
 * @param member - Team member
 * @param roleDescription - Description of the member's role, when known
 * @returns One line, or undefined when nothing is known
 */
export function memberResponsibility(
  member: Pick<TeamMember, 'role' | 'jobDescription'>,
  roleDescription?: string | null,
): string | undefined {
  const own = member.jobDescription?.trim();
  if (own) return own;
  const described = roleDescription?.trim();
  if (described) return described;
  return TICKET_AUTOPILOT_CONSTANTS.ROLE_RESPONSIBILITY_FALLBACKS[String(member.role ?? '')];
}

/**
 * Whether anyone could ever auto-claim a `ready` ticket: a member of an
 * eligible team (the ticket's `team`, else any project team) who is not a
 * lead — or a lead who is the only member of its team. Mirrors the
 * AutoClaim rule (specs/2026-09-28-project-tickets.md §5).
 *
 * @param ticket - Ticket
 * @param teams - The project's teams
 * @returns True when some member could take it
 */
export function hasPossibleTaker(ticket: Pick<ProjectTicket, 'team'>, teams: Team[]): boolean {
  return teams
    .filter((t) => !ticket.team || t.id === ticket.team)
    .some((t) => {
      const members = t.members ?? [];
      return members.some((m) => !isTeamLead(t, m) || members.length === 1);
    });
}

/**
 * Whether a ticket is parked for now: it carries a skip label, or its
 * `deferUntil` date has not come yet.
 *
 * @param ticket - Ticket
 * @param now - Clock (epoch ms)
 * @param skipLabels - Labels that park a ticket (case-insensitive)
 * @returns True when triage must leave it alone
 */
export function isParkedTicket(ticket: Pick<ProjectTicket, 'labels' | 'deferUntil'>, now: number, skipLabels: readonly string[] = TICKET_AUTOPILOT_CONSTANTS.DEFAULT_SKIP_LABELS): boolean {
  const skip = new Set(skipLabels.map((l) => l.toLowerCase()));
  if (ticket.labels.some((l) => skip.has(l.toLowerCase()))) return true;
  const until = ticket.deferUntil ? Date.parse(ticket.deferUntil) : NaN;
  return Number.isFinite(until) && now < until;
}

/**
 * Tickets the driver should triage now, in brief order.
 *
 * - `backlog` tickets not waiting on the owner (no `needs-owner` label);
 * - `ready` tickets nobody can take (no eligible claimer), or untouched for
 *   {@link TICKET_AUTOPILOT_CONSTANTS.READY_STALE_MS};
 * - minus parked tickets: a skip label (`parked` / `deferred` by default,
 *   per project) or a `deferUntil` date in the future ({@link isParkedTicket});
 * - minus tickets already listed in a brief and unchanged since, until
 *   {@link TICKET_AUTOPILOT_CONSTANTS.TRIAGE_RELIST_AFTER_MS} has passed (a
 *   ticket the driver chose to leave is not re-sent every half hour).
 *
 * @param input - Tickets, teams, clock, earlier listings
 * @returns Candidates (capped) and how many more are waiting
 */
export function selectTriageCandidates(input: SelectTriageInput): TriageSelection {
  const listed = input.listed ?? {};
  const all: TriageCandidate[] = [];
  for (const ticket of input.tickets) {
    let reason: TriageReason | null = null;
    // Parked / deferred (skip label, or deferUntil not reached): never offered, whatever its status.
    if (isParkedTicket(ticket, input.now, input.skipLabels)) continue;
    // A retro harness gap waits for the owner's card (retro-pending): never triaged.
    if (ticket.labels.includes(TICKET_AUTOPILOT_CONSTANTS.RETRO_PENDING_LABEL)) continue;
    if (ticket.status === 'backlog' && !hasNeedsOwnerLabel(ticket)) {
      reason = 'backlog';
    } else if (ticket.status === 'ready' && !hasNeedsOwnerLabel(ticket)) {
      if (!hasPossibleTaker(ticket, input.teams)) reason = 'ready_no_taker';
      else if (input.now - (Date.parse(ticket.updatedAt) || input.now) >= TICKET_AUTOPILOT_CONSTANTS.READY_STALE_MS) reason = 'ready_stale';
    }
    if (!reason) continue;
    const seen = listed[ticket.id];
    if (seen && seen.updatedAt === ticket.updatedAt && input.now - seen.at < TICKET_AUTOPILOT_CONSTANTS.TRIAGE_RELIST_AFTER_MS) continue;
    all.push({ ticket, reason, workerCreated: isWorkerCreated(ticket, input.teams) });
  }
  all.sort(
    (a, b) =>
      projectTicketPriorityRank(a.ticket.priority) - projectTicketPriorityRank(b.ticket.priority) ||
      (Date.parse(a.ticket.createdAt) || 0) - (Date.parse(b.ticket.createdAt) || 0) ||
      a.ticket.id.localeCompare(b.ticket.id),
  );
  const max = TICKET_AUTOPILOT_CONSTANTS.TRIAGE_MAX_TICKETS;
  return { candidates: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/**
 * Whether to wake the driver with a triage item now. Checked in order:
 * switch off → no driver → budget reached → a triage already live → a goal
 * replan live (the driver is opening tickets in that turn; it yields after
 * an hour once there are tickets to triage) → nothing to triage → nobody
 * idle → too soon since the last one (30 min on the periodic tick, {@link TICKET_AUTOPILOT_CONSTANTS.IDLE_TRIGGER_MIN_INTERVAL_MS}
 * when a member just went idle with nothing ready).
 *
 * @param input - State of the project
 * @returns `triage`, or `skip` with the reason
 */
export function decideTriage(input: TriageDecisionInput): TriageDecision {
  if (!input.enabled) return { action: 'skip', reason: 'off' };
  if (!input.driver) return { action: 'skip', reason: 'no_driver' };
  if (input.usedTodayTokens >= input.dailyBudgetTokens) return { action: 'skip', reason: 'budget_reached' };
  if (input.liveTriage) return { action: 'skip', reason: 'triage_in_flight' };
  if (
    input.liveReplanAt !== undefined &&
    (input.candidateCount === 0 || input.now - input.liveReplanAt < TICKET_AUTOPILOT_CONSTANTS.REPLAN_YIELD_AFTER_MS)
  ) {
    return { action: 'skip', reason: 'replan_in_flight' };
  }
  if (input.candidateCount === 0) return { action: 'skip', reason: 'nothing_to_triage' };
  if (!input.anyoneIdle) return { action: 'skip', reason: 'nobody_idle' };
  const gap =
    input.trigger === 'member_idle' ? TICKET_AUTOPILOT_CONSTANTS.IDLE_TRIGGER_MIN_INTERVAL_MS : TICKET_AUTOPILOT_CONSTANTS.TRIAGE_MIN_INTERVAL_MS;
  if (input.lastTriageAt !== undefined && input.now - input.lastTriageAt < gap) return { action: 'skip', reason: 'too_soon' };
  return { action: 'triage' };
}

/** Inputs of {@link decideReplan}. */
export interface ReplanDecisionInput {
  enabled: boolean;
  /** Resolved driver session, or null when the project has no lead */
  driver: string | null;
  /**
   * The project has an active goal (goals log or an active project OKR).
   * Checked last: the service reads the goal only after every other gate passed.
   */
  hasGoal: boolean;
  /** Backing off after replans that opened no tickets (see {@link replanBackoffDays}) */
  backedOff: boolean;
  /** Replans allowed per local day (the `replansPerDay` setting; 0 = off) */
  maxReplansPerDay: number;
  /** Replans already created today (local day) */
  replansToday: number;
  /** When the last replan was created (epoch ms), if any */
  lastReplanAt?: number;
  /** A replan never starts sooner than this after the last one (the speed mode's gap, ms; 0 = none) */
  minGapMs?: number;
  /** Clock (epoch ms), for the gap */
  now?: number;
  /**
   * Nothing is in flight: no ready or in-progress ticket (parked ones do not
   * count), nothing to triage, every non-paused member idle. The mode's gap
   * then does not apply; only the idle debounce does.
   */
  idleAndEmpty?: boolean;
  /** Debounce after the last replan when idle and empty (ms) */
  idleReplanDebounceMs?: number;
  /** Tokens used today by the project's team agents */
  usedTodayTokens: number;
  /** Daily budget in tokens (boosts included); Infinity = unlimited today */
  dailyBudgetTokens: number;
  /** A triage WorkItem of this project is still live */
  liveTriage: boolean;
  /** A replan WorkItem of this project is still live */
  liveReplan: boolean;
  /** Tickets that need triage (after de-duplication) */
  candidateCount: number;
  /** A member of the project's teams is idle */
  anyoneIdle: boolean;
  /** An idle member holds fewer in-progress tickets than the per-member cap */
  idleWithRoom: boolean;
}

/** Why the driver is not woken to replan. */
export type ReplanSkipReason =
  | 'off'
  | 'no_driver'
  | 'no_goal'
  | 'replan_off'
  | 'budget_reached'
  | 'triage_in_flight'
  | 'replan_in_flight'
  | 'tickets_to_triage'
  | 'nobody_idle'
  | 'at_capacity'
  | 'replanned_today'
  | 'replan_too_soon'
  | 'backed_off';

/** Outcome of {@link decideReplan}. */
export type ReplanDecision = { action: 'replan' } | { action: 'skip'; reason: ReplanSkipReason };

/**
 * Whether to wake the driver with a goal replan now: the project has a goal
 * but nothing is left to triage, so nobody would otherwise plan the next
 * step (specs/2026-10-04-autopilot-goal-replan.md). Checked in order,
 * cheapest first: switch off → no driver → replans set to 0 → budget
 * reached → a triage live → a replan live → tickets to triage → nobody idle
 * → every idle member at the in-progress cap → today's replans used up (the
 * mode's hard cap) → too soon after the last one (the mode's gap) → backing
 * off → no goal (the only gate that reads files).
 *
 * The autopilot only wakes the driver; the driver opens the tickets. It never
 * makes a ticket ready or starts work.
 *
 * @param input - State of the project
 * @returns `replan`, or `skip` with the reason
 */
export function decideReplan(input: ReplanDecisionInput): ReplanDecision {
  if (!input.enabled) return { action: 'skip', reason: 'off' };
  if (!input.driver) return { action: 'skip', reason: 'no_driver' };
  if (!(input.maxReplansPerDay > 0)) return { action: 'skip', reason: 'replan_off' };
  if (input.usedTodayTokens >= input.dailyBudgetTokens) return { action: 'skip', reason: 'budget_reached' };
  if (input.liveTriage) return { action: 'skip', reason: 'triage_in_flight' };
  if (input.liveReplan) return { action: 'skip', reason: 'replan_in_flight' };
  if (input.candidateCount > 0) return { action: 'skip', reason: 'tickets_to_triage' };
  if (!input.anyoneIdle) return { action: 'skip', reason: 'nobody_idle' };
  if (!input.idleWithRoom) return { action: 'skip', reason: 'at_capacity' };
  if (input.replansToday >= input.maxReplansPerDay) return { action: 'skip', reason: 'replanned_today' };
  if (input.lastReplanAt !== undefined && input.now !== undefined) {
    const gap = effectiveReplanGapMs(input.minGapMs ?? 0, !!input.idleAndEmpty, input.idleReplanDebounceMs ?? 0);
    if (gap > 0 && input.now - input.lastReplanAt < gap) return { action: 'skip', reason: 'replan_too_soon' };
  }
  if (input.backedOff) return { action: 'skip', reason: 'backed_off' };
  if (!input.hasGoal) return { action: 'skip', reason: 'no_goal' };
  return { action: 'replan' };
}

/**
 * The wait after the last replan: the mode's gap while its work is in flight;
 * only the (shorter) debounce once everything is idle and empty.
 *
 * @param minGapMs - The mode's gap
 * @param idleAndEmpty - Nothing in flight
 * @param debounceMs - The idle debounce
 * @returns Milliseconds to wait after the last replan
 */
export function effectiveReplanGapMs(minGapMs: number, idleAndEmpty: boolean, debounceMs: number): number {
  return idleAndEmpty ? Math.min(minGapMs, debounceMs) : minGapMs;
}

/** How long the next replan waits after one that opened no tickets (the speed mode's retry). */
export interface EmptyReplanRetry {
  unit: 'hours' | 'days';
  amount: number;
}

/** The replan backoff as the autopilot remembers it. */
export interface ReplanBackoff {
  /** Empty replans in a row */
  streak: number;
  /** When it started (epoch ms): goal changes and tickets created after this lift it */
  since: number;
  /** First local day a replan may run again (YYYY-MM-DD) */
  resumeDay: string;
  /**
   * When a replan may run again (epoch ms). Absent on backoffs stored before
   * speed modes: those wait for `resumeDay`.
   */
  resumeAt?: number;
}

/**
 * The backoff after a finished replan: none when it opened a ticket (any
 * ticket created since the replan was queued), else the speed mode's retry:
 * `hours` after now (Rush: 1 h), or the local day `days` after the replan's
 * day (Normal: the next day, Chill: a week later).
 *
 * @param input - The replan, the tickets, the previous backoff, the retry, the clock
 * @returns The new backoff, or null (no backoff)
 */
export function nextReplanBackoff(input: {
  /** When the replan was queued (epoch ms) */
  replanAt: number;
  /** Its local day */
  replanDay: string;
  tickets: Array<Pick<ProjectTicket, 'createdAt'>>;
  previous?: ReplanBackoff | null;
  /** The speed mode's retry (default: the next day) */
  retry?: EmptyReplanRetry;
  now: number;
}): ReplanBackoff | null {
  const opened = input.tickets.some((t) => (Date.parse(t.createdAt) || 0) >= input.replanAt);
  if (opened) return null;
  const streak = (input.previous?.streak ?? 0) + 1;
  const retry = input.retry ?? { unit: 'days', amount: 1 };
  if (retry.unit === 'hours') {
    const resumeAt = input.now + Math.max(0, retry.amount) * 60 * 60 * 1000;
    return { streak, since: input.now, resumeDay: localDateKey(new Date(resumeAt)), resumeAt };
  }
  const [y, m, d] = input.replanDay.split('-').map(Number);
  const resume = new Date(y, m - 1, d + Math.max(1, retry.amount), 0, 0, 0, 0);
  return { streak, since: input.now, resumeDay: localDateKey(resume), resumeAt: resume.getTime() };
}

/**
 * Where a stored backoff stands today:
 * - `holds` — skip replans today;
 * - `lifted` — a ticket was created, or the goal / an OKR changed, after it
 *   started: drop it and its streak;
 * - `elapsed` — its days are over: replans may run again, but the streak is
 *   kept so the next empty replan backs off longer;
 * - `none` — no backoff.
 *
 * @param backoff - The stored backoff
 * @param input - Today, the tickets, when the goal last changed
 * @returns State
 */
export function replanBackoffState(
  backoff: ReplanBackoff | null | undefined,
  input: { today: string; tickets: Array<Pick<ProjectTicket, 'createdAt'>>; goalChangedAt?: number | null; now?: number },
): 'holds' | 'lifted' | 'elapsed' | 'none' {
  if (!backoff) return 'none';
  if (input.tickets.some((t) => (Date.parse(t.createdAt) || 0) > backoff.since)) return 'lifted';
  if (typeof input.goalChangedAt === 'number' && input.goalChangedAt > backoff.since) return 'lifted';
  if (typeof backoff.resumeAt === 'number' && input.now !== undefined) return input.now >= backoff.resumeAt ? 'elapsed' : 'holds';
  return input.today >= backoff.resumeDay ? 'elapsed' : 'holds';
}

/**
 * Whether a stored backoff still holds at a moment (no lift checks): for
 * status and stop-reason views.
 *
 * @param backoff - Stored backoff
 * @param now - Clock (epoch ms)
 * @param today - Local day key of `now`
 * @returns True while it holds
 */
export function replanBackoffHolds(backoff: ReplanBackoff | null | undefined, now: number, today: string): boolean {
  if (!backoff) return false;
  if (typeof backoff.resumeAt === 'number') return now < backoff.resumeAt;
  return today < backoff.resumeDay;
}

/** Why the autopilot is not producing work (specs/2026-10-04-autopilot-speed-modes.md). */
export type AutopilotStopReason =
  | 'paused'
  | 'budget_reached'
  | 'system_error'
  | 'waiting_on_owner'
  | 'no_ideas'
  | 'daily_replan_cap'
  | 'waiting_for_replan';

/** Inputs of {@link classifyStopReason}. */
export interface StopReasonInput {
  /** Teams on the project (paused ones included) */
  teamsTotal: number;
  /** Teams on the project that are not paused */
  teamsActive: number;
  usedTodayTokens: number;
  /** Today's budget (Infinity = unlimited) */
  dailyBudgetTokens: number;
  /** Tickets in progress */
  inProgress: number;
  /** Tickets ready to take */
  ready: number;
  /** Backlog tickets the driver has not decided yet (triage will list them) */
  toTriage: number;
  /** A triage / goal replan of the project is live (the autopilot is producing work) */
  liveAutopilotItem: boolean;
  /** Project WorkItems that failed recently */
  failedRecently: number;
  /** An autopilot WorkItem queued long ago and never picked up */
  stuckDelivery: boolean;
  /** Open tickets waiting on the owner (review, needs-owner, retro-pending) */
  waitingOnOwner: number;
  /** The last goal replan opened no tickets and the retry has not come yet */
  emptyReplanBackoff: boolean;
  /** Today's replans are used up (the mode's or the explicit daily cap) */
  replanCapReached?: boolean;
  /** The next replan may run at this time (epoch ms) and it is still ahead (gap / debounce) */
  replanWaitUntil?: number;
}

/** Outcome of {@link classifyStopReason}. */
export interface StopReasonResult {
  /** The work is still moving (in progress, ready, being triaged or planned) */
  running: boolean;
  /** Why it stopped (null while running, or stopped for none of the named reasons) */
  reason: AutopilotStopReason | null;
  /** When the autopilot may act again (epoch ms), for the waiting / cap reasons */
  until?: number;
}

/**
 * Why the autopilot is not producing work, most decisive first:
 * every team paused → over the daily budget → stuck delivery → (still
 * running? none) → failed work → waiting on the owner → the last replan had
 * no ideas → the daily replan cap is hit → waiting for the next replan
 * (gap / debounce). A project stopped for none of these (between replans) has no
 * reason: the next replan comes at the mode's gap.
 *
 * @param input - Project state
 * @returns Running flag and the reason
 */
export function classifyStopReason(input: StopReasonInput): StopReasonResult {
  const running = input.inProgress > 0 || input.ready > 0 || input.toTriage > 0 || input.liveAutopilotItem;
  if (input.teamsTotal > 0 && input.teamsActive === 0) return { running: false, reason: 'paused' };
  if (input.usedTodayTokens >= input.dailyBudgetTokens) return { running: false, reason: 'budget_reached' };
  if (input.stuckDelivery) return { running: false, reason: 'system_error' };
  if (running) return { running: true, reason: null };
  if (input.failedRecently > 0) return { running: false, reason: 'system_error' };
  if (input.waitingOnOwner > 0) return { running: false, reason: 'waiting_on_owner' };
  if (input.emptyReplanBackoff) return { running: false, reason: 'no_ideas' };
  if (input.replanCapReached) return { running: false, reason: 'daily_replan_cap', ...(input.replanWaitUntil !== undefined ? { until: input.replanWaitUntil } : {}) };
  if (input.replanWaitUntil !== undefined) return { running: false, reason: 'waiting_for_replan', until: input.replanWaitUntil };
  return { running: false, reason: null };
}

/** Inputs of {@link decideSelfReview}. */
export interface SelfReviewDecisionInput {
  enabled: boolean;
  driver: string | null;
  now: number;
  /** The mode's cadence (ms) */
  everyMs: number;
  /** When the last self-review was asked (epoch ms) */
  lastAskedAt?: number;
  /** A self-review of the project is live */
  live: boolean;
  usedTodayTokens: number;
  dailyBudgetTokens: number;
  /** Something changed since the last one (tickets, goal, stop reason) */
  changed: boolean;
  anyoneIdle: boolean;
}

/** Why no self-review is asked. */
export type SelfReviewSkipReason = 'off' | 'no_driver' | 'budget_reached' | 'not_due' | 'in_flight' | 'unchanged';

/** Outcome of {@link decideSelfReview}. */
export type SelfReviewDecision = { action: 'review' } | { action: 'skip'; reason: SelfReviewSkipReason };

/**
 * Whether to ask the driver for a self-review now: at the mode's cadence,
 * one live at a time, never over the budget, and skipped when nothing
 * changed since the last one and nobody is idle (nothing to say, nobody to
 * give the next bet to).
 *
 * @param input - Project state
 * @returns `review`, or `skip` with the reason
 */
export function decideSelfReview(input: SelfReviewDecisionInput): SelfReviewDecision {
  if (!input.enabled) return { action: 'skip', reason: 'off' };
  if (!input.driver) return { action: 'skip', reason: 'no_driver' };
  if (input.usedTodayTokens >= input.dailyBudgetTokens) return { action: 'skip', reason: 'budget_reached' };
  if (input.lastAskedAt !== undefined && input.now - input.lastAskedAt < input.everyMs) return { action: 'skip', reason: 'not_due' };
  if (input.live) return { action: 'skip', reason: 'in_flight' };
  if (!input.changed && !input.anyoneIdle) return { action: 'skip', reason: 'unchanged' };
  return { action: 'review' };
}

/**
 * Whether a ticket description (or the create call's `metric`) names the
 * goal metric it moves: a `Metric: …` line (any case, optional bullet /
 * bold) of at least METRIC_MIN_CHARS characters.
 *
 * @param input - The create call's description and metric
 * @returns The metric reference, or null when there is none
 */
export function ticketMetricRef(input: { description?: string | null; metric?: string | null }): string | null {
  const C = TICKET_AUTOPILOT_CONSTANTS;
  const direct = typeof input.metric === 'string' ? input.metric.replace(/\s+/g, ' ').trim() : '';
  if (direct.length >= C.METRIC_MIN_CHARS) return direct;
  const m = /^\s*(?:[-*]\s*)?(?:\*\*)?metric(?:\*\*)?\s*[:：](?:\*\*)?\s*(.+)$/im.exec(input.description ?? '');
  const line = m ? m[1].trim() : '';
  return line.length >= C.METRIC_MIN_CHARS ? line : null;
}

/**
 * Tickets closed (done or cancelled) since a moment, newest first.
 *
 * @param tickets - Tickets of a project
 * @param sinceMs - Lower bound (epoch ms) on the ticket's `updatedAt`
 * @param max - Most tickets returned
 * @returns Closed tickets
 */
export function closedTicketsSince(tickets: ProjectTicket[], sinceMs: number, max: number): ProjectTicket[] {
  return tickets
    .filter((t) => (t.status === 'done' || t.status === 'cancelled') && (Date.parse(t.updatedAt) || 0) >= sinceMs)
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, max));
}

/** Inputs of {@link decideDigest}. */
export interface DigestDecisionInput {
  now: Date;
  /** Local date (YYYY-MM-DD) of the last digest sent */
  lastSentDate?: string;
  /** When the last digest went out (epoch ms) */
  lastSentAt?: number;
  /** Latest `updatedAt` (epoch ms) over the tickets of the enabled projects */
  latestTicketChangeAt: number;
}

/**
 * Whether to send the daily digest now: once per local day, at or after
 * {@link TICKET_AUTOPILOT_CONSTANTS.DIGEST_HOUR_LOCAL}, and only when some
 * ticket changed since the previous digest (or in the last day, for the
 * first one).
 *
 * @param input - Clock, last digest, latest ticket change
 * @returns `send` and why
 */
export function decideDigest(input: DigestDecisionInput): { send: boolean; reason: 'not_yet' | 'already_sent' | 'nothing_changed' | 'due' } {
  if (input.now.getHours() < TICKET_AUTOPILOT_CONSTANTS.DIGEST_HOUR_LOCAL) return { send: false, reason: 'not_yet' };
  if (input.lastSentDate === localDateKey(input.now)) return { send: false, reason: 'already_sent' };
  const since = input.lastSentAt ?? input.now.getTime() - 24 * 60 * 60 * 1000;
  if (!(input.latestTicketChangeAt > since)) return { send: false, reason: 'nothing_changed' };
  return { send: true, reason: 'due' };
}

/**
 * Local midnight of a moment's day.
 *
 * @param now - Moment
 * @returns 00:00 local time of that day
 */
export function localMidnight(now: Date): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Local calendar date key.
 *
 * @param now - Moment
 * @returns `YYYY-MM-DD` in local time
 */
export function localDateKey(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Tickets in progress per assignee.
 *
 * @param tickets - Tickets of a project
 * @returns Session → count of `in_progress` tickets
 */
export function inFlightByAssignee(tickets: ProjectTicket[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tickets) {
    if (t.status === 'in_progress' && t.assignee) out.set(t.assignee, (out.get(t.assignee) ?? 0) + 1);
  }
  return out;
}

/** Statuses that count as "open" for owner questions (a closed ticket asks nothing). */
export const OPEN_TICKET_STATUSES: ReadonlySet<string> = new Set(
  PROJECT_TICKET_CONSTANTS.STATUSES.filter((s) => s !== 'done' && s !== 'cancelled'),
);
