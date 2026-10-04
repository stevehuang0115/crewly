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
 * - whether to send the owner the evening digest ({@link decideDigest}).
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
  /** A goal replan WorkItem of this project is still live (the driver is opening tickets) */
  liveReplan?: boolean;
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
 * Tickets the driver should triage now, in brief order.
 *
 * - `backlog` tickets not waiting on the owner (no `needs-owner` label);
 * - `ready` tickets nobody can take (no eligible claimer), or untouched for
 *   {@link TICKET_AUTOPILOT_CONSTANTS.READY_STALE_MS};
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
 * replan live (the driver is opening tickets in that turn) → nothing
 * to triage → nobody idle → too soon since the last one (30 min on the
 * periodic tick, {@link TICKET_AUTOPILOT_CONSTANTS.IDLE_TRIGGER_MIN_INTERVAL_MS}
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
  if (input.liveReplan) return { action: 'skip', reason: 'replan_in_flight' };
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
  /** The project has an active goal (goals log or an active project OKR) */
  hasGoal: boolean;
  /** Replans allowed per local day (the `replansPerDay` setting; 0 = off) */
  maxReplansPerDay: number;
  /** Replans already created today (local day) */
  replansToday: number;
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
  | 'replanned_today';

/** Outcome of {@link decideReplan}. */
export type ReplanDecision = { action: 'replan' } | { action: 'skip'; reason: ReplanSkipReason };

/**
 * Whether to wake the driver with a goal replan now: the project has a goal
 * but nothing is left to triage, so nobody would otherwise plan the next
 * step (specs/2026-10-04-autopilot-goal-replan.md). Checked in order:
 * switch off → no driver → no goal → replans set to 0 → budget reached → a
 * triage live → a replan live → tickets to triage → nobody idle → every idle
 * member at the in-progress cap → today's replans used up.
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
  if (!input.hasGoal) return { action: 'skip', reason: 'no_goal' };
  if (!(input.maxReplansPerDay > 0)) return { action: 'skip', reason: 'replan_off' };
  if (input.usedTodayTokens >= input.dailyBudgetTokens) return { action: 'skip', reason: 'budget_reached' };
  if (input.liveTriage) return { action: 'skip', reason: 'triage_in_flight' };
  if (input.liveReplan) return { action: 'skip', reason: 'replan_in_flight' };
  if (input.candidateCount > 0) return { action: 'skip', reason: 'tickets_to_triage' };
  if (!input.anyoneIdle) return { action: 'skip', reason: 'nobody_idle' };
  if (!input.idleWithRoom) return { action: 'skip', reason: 'at_capacity' };
  if (input.replansToday >= input.maxReplansPerDay) return { action: 'skip', reason: 'replanned_today' };
  return { action: 'replan' };
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
