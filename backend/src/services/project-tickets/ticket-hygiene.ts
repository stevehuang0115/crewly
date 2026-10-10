/**
 * Ticket hygiene, pure half: when is a ticket stale, which stale tickets go to
 * which lead today, and the brief that lead receives.
 *
 * Kept free of I/O so the thresholds, the cooldown and the batching are easy to
 * test; {@link ./ticket-hygiene.service} does the reading and writing.
 *
 * @module services/project-tickets/ticket-hygiene
 */

import { ORCHESTRATOR_SESSION_NAME, TICKET_HYGIENE_CONSTANTS } from '../../constants.js';
import type { Team, TeamMember } from '../../types/index.js';
import { getTeamLeads } from '../../utils/team.utils.js';

const C = TICKET_HYGIENE_CONSTANTS;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Statuses of a ticket that still counts as open work. */
export const OPEN_TICKET_STATUSES: ReadonlySet<string> = new Set(['backlog', 'ready', 'in_progress', 'review']);

/** Labels that say "leave this alone for now" (the autopilot's park / owner-wait labels). */
const QUIET_LABELS: ReadonlySet<string> = new Set(['parked', 'deferred', 'needs-owner']);

/** The ticket fields hygiene reads. */
export interface HygieneTicketFields {
  id: string;
  title: string;
  status: string;
  labels: string[];
  assignee: string | null;
  team: string | null;
  ownerReview?: boolean;
  deferUntil?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Log lines: `<iso> · <actor> · <message>` */
  log: string[];
}

/** A ticket with the project it belongs to. */
export interface HygieneTicket extends HygieneTicketFields {
  projectId: string;
  projectName: string;
  projectPath: string;
}

/** How stale a ticket is. */
export interface TicketStaleness {
  /** Open, past its threshold, and not parked / deferred / waiting on the owner */
  stale: boolean;
  /** Whole days since the last activity */
  idleDays: number;
  /** ISO time of the last activity */
  lastActivityAt: string;
  /** The threshold that applies to its status (days); null for a closed ticket */
  thresholdDays: number | null;
}

/**
 * The days of silence after which a ticket of this status is stale.
 *
 * @param status - Ticket status
 * @returns Days, or null when the status is not open
 */
export function staleThresholdDays(status: string): number | null {
  if (status === 'in_progress' || status === 'review') return C.STALE_ACTIVE_DAYS;
  if (status === 'ready' || status === 'backlog') return C.STALE_IDLE_DAYS;
  return null;
}

/**
 * The time of a ticket's last real activity: the later of `updatedAt` and its
 * newest Log line, ignoring lines the hygiene sweep wrote itself (a flag the
 * sweep adds is not someone working on the ticket).
 *
 * @param t - Ticket
 * @returns Epoch ms (0 when nothing parses)
 */
export function ticketLastActivityMs(t: Pick<HygieneTicketFields, 'updatedAt' | 'createdAt' | 'log'>): number {
  let best = Date.parse(t.updatedAt);
  if (!Number.isFinite(best)) best = Date.parse(t.createdAt);
  if (!Number.isFinite(best)) best = 0;
  for (const line of t.log ?? []) {
    const m = /^(\S+) · ([^·]+?) · /.exec(line);
    if (!m || m[2] === C.ACTOR) continue;
    const at = Date.parse(m[1]);
    if (Number.isFinite(at) && at > best) best = at;
  }
  return best;
}

/**
 * Whether a ticket is stale right now.
 *
 * Not stale: closed tickets, tickets labelled parked / deferred / needs-owner,
 * tickets deferred to a later date, and a `review` ticket that waits for the
 * owner (`ownerReview`) — nobody on the team can decide that one.
 *
 * @param t - Ticket
 * @param nowMs - Clock
 * @returns Staleness
 */
export function ticketStaleness(t: HygieneTicketFields, nowMs: number): TicketStaleness {
  const lastMs = ticketLastActivityMs(t);
  const thresholdDays = staleThresholdDays(t.status);
  const idleDays = lastMs > 0 ? Math.max(0, Math.floor((nowMs - lastMs) / DAY_MS)) : 0;
  const base = { idleDays, lastActivityAt: new Date(lastMs).toISOString(), thresholdDays };
  if (thresholdDays === null || lastMs === 0) return { ...base, stale: false };
  if ((t.labels ?? []).some((l) => QUIET_LABELS.has(l))) return { ...base, stale: false };
  if (t.status === 'review' && t.ownerReview) return { ...base, stale: false };
  if (t.deferUntil) {
    const until = Date.parse(t.deferUntil);
    if (Number.isFinite(until) && until > nowMs) return { ...base, stale: false };
  }
  return { ...base, stale: nowMs - lastMs >= thresholdDays * DAY_MS };
}

/**
 * Whether a name looks like an agent session (`<team>-<name>-<8 hex>`), as
 * opposed to a person's name. Only agent-looking assignees can be orphaned.
 *
 * @param name - Assignee
 * @returns True for a session-shaped name
 */
export function looksLikeAgentSession(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/.test(name);
}

/** Why a ticket has no live owner any more. */
export interface OrphanReason {
  assignee?: string;
  team?: string;
}

/**
 * Whether a ticket's assignee or team no longer exists.
 *
 * @param t - Ticket
 * @param teams - All teams
 * @returns The missing parts, or null when both (that are set) exist
 */
export function orphanReason(t: Pick<HygieneTicketFields, 'assignee' | 'team'>, teams: Team[]): OrphanReason | null {
  const live = teams.filter((x) => !x.archived);
  const reason: OrphanReason = {};
  if (t.team && !live.some((x) => x.id === t.team)) reason.team = t.team;
  if (t.assignee && t.assignee !== ORCHESTRATOR_SESSION_NAME && looksLikeAgentSession(t.assignee)) {
    const known = live.some((x) => (x.members ?? []).some((m) => m.sessionName === t.assignee || m.agentId === t.assignee));
    if (!known) reason.assignee = t.assignee;
  }
  return reason.assignee || reason.team ? reason : null;
}

/** One ticket picked for a lead's review, with why. */
export interface ReviewCandidate {
  ticket: HygieneTicket;
  staleness: TicketStaleness;
  /** `stale` and / or `orphaned` */
  reasons: string[];
}

/** The stale tickets of one team, and who decides them. */
export interface ReviewBatch {
  /** Team id, or `orchestrator` for tickets with no team */
  key: string;
  teamId: string | null;
  teamName: string;
  /** Session that receives the batch: the team lead, else the orchestrator */
  target: string;
  /** True when the target is the orchestrator because the team has no lead */
  fallbackToOrchestrator: boolean;
  /** Candidates, longest silence first, at most {@link TICKET_HYGIENE_CONSTANTS.MAX_TICKETS_PER_REVIEW} */
  candidates: ReviewCandidate[];
  /** How many more are waiting for the next batch */
  more: number;
}

/** Key of a ticket in the "already sent" memory. */
export function ticketKey(projectPath: string, id: string): string {
  return `${projectPath}#${id}`;
}

/**
 * The session that decides a team's stale tickets: its first lead that has a
 * session, else the orchestrator.
 *
 * @param team - Team (null = no team)
 * @returns Session and whether it is the fallback
 */
export function reviewTargetOf(team: Team | null): { target: string; fallback: boolean } {
  if (team) {
    const lead = getTeamLeads(team).find((m: TeamMember) => !!(m.sessionName || m.agentId));
    if (lead) return { target: (lead.sessionName || lead.agentId) as string, fallback: false };
  }
  return { target: ORCHESTRATOR_SESSION_NAME, fallback: true };
}

/** Inputs of {@link selectReviewBatches}. */
export interface SelectInput {
  tickets: HygieneTicket[];
  teams: Team[];
  nowMs: number;
  /** Ticket key → when it was last sent to a lead (ms) */
  sentAt: Readonly<Record<string, number>>;
  /** Tickets the sweep found orphaned (ticket key → reason); they are listed even when not stale */
  orphans?: ReadonlyMap<string, OrphanReason>;
  /** Teams that must not be woken (paused) */
  skipTeamIds?: ReadonlySet<string>;
}

/**
 * Group the stale tickets by owning team, drop the ones sent within the
 * cooldown, and cap each batch. A team with nothing stale has no batch.
 *
 * A ticket belongs to its `team`, else to the team its assignee is on, else to
 * the only team working on its project, else to the orchestrator.
 *
 * @param input - Tickets, teams, clock, memory
 * @returns One batch per team that has something to decide
 */
export function selectReviewBatches(input: SelectInput): ReviewBatch[] {
  const live = input.teams.filter((t) => !t.archived);
  const byId = new Map(live.map((t) => [t.id, t]));
  const teamOfSession = new Map<string, Team>();
  for (const t of live) for (const m of t.members ?? []) for (const s of [m.sessionName, m.agentId]) if (s && !teamOfSession.has(s)) teamOfSession.set(s, t);
  const cooldownMs = C.REVIEW_COOLDOWN_DAYS * DAY_MS;

  const groups = new Map<string, { team: Team | null; list: ReviewCandidate[] }>();
  for (const ticket of input.tickets) {
    if (!OPEN_TICKET_STATUSES.has(ticket.status)) continue;
    const staleness = ticketStaleness(ticket, input.nowMs);
    const orphan = input.orphans?.get(ticketKey(ticket.projectPath, ticket.id));
    const reasons: string[] = [];
    if (staleness.stale) reasons.push('stale');
    if (orphan) reasons.push('orphaned');
    if (reasons.length === 0) continue;
    const sent = input.sentAt[ticketKey(ticket.projectPath, ticket.id)];
    if (sent !== undefined && input.nowMs - sent < cooldownMs) continue;
    const projectTeams = live.filter((t) => (t.projectIds ?? []).includes(ticket.projectId));
    const team =
      (ticket.team && byId.get(ticket.team)) ||
      (ticket.assignee ? teamOfSession.get(ticket.assignee) : undefined) ||
      // A project with exactly one team: that team owns its unowned tickets.
      (projectTeams.length === 1 ? projectTeams[0] : undefined) ||
      null;
    if (team && input.skipTeamIds?.has(team.id)) continue;
    const key = team ? team.id : 'orchestrator';
    const g = groups.get(key) ?? { team, list: [] };
    g.list.push({ ticket, staleness, reasons });
    groups.set(key, g);
  }

  const batches: ReviewBatch[] = [];
  for (const [key, g] of groups) {
    const sorted = g.list.sort(
      (a, b) => b.staleness.idleDays - a.staleness.idleDays || a.ticket.projectPath.localeCompare(b.ticket.projectPath) || a.ticket.id.localeCompare(b.ticket.id, undefined, { numeric: true }),
    );
    const { target, fallback } = reviewTargetOf(g.team);
    batches.push({
      key,
      teamId: g.team?.id ?? null,
      teamName: g.team?.name ?? 'No team',
      target,
      fallbackToOrchestrator: fallback,
      candidates: sorted.slice(0, C.MAX_TICKETS_PER_REVIEW),
      more: Math.max(0, sorted.length - C.MAX_TICKETS_PER_REVIEW),
    });
  }
  return batches.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The brief the lead receives (WorkItem `briefMarkdown`): the list, the four
 * ways to decide, and the rule that nothing here goes to the owner.
 *
 * @param batch - The batch
 * @returns Markdown
 */
export function buildReviewBrief(batch: ReviewBatch): string {
  const tk = '$AGENT_SKILLS_PATH/core/project-tickets/execute.sh';
  const n = batch.candidates.length;
  const lines: string[] = [
    `# Ticket review — ${batch.teamName} (${n} ticket${n === 1 ? '' : 's'})`,
    '',
    'These tickets have had no activity for a while, so status views (Drive mode, boards) may show them wrongly.',
    `Decide every ticket below, then complete this WorkItem (complete-task with its id) with one line per ticket saying what you did. This is internal housekeeping: do not message the owner about it.`,
    '',
    '## For each ticket, do one of these',
    '',
    `1. **Finished** — a ticket in progress or in review: \`bash ${tk} update --project <PROJECT> --id <ID> --status done --note "<what shipped / where>"\`. A backlog or ready ticket cannot go straight to done: cancel it with the note "already done: <evidence>".`,
    `2. **No longer wanted** — \`bash ${tk} update --project <PROJECT> --id <ID> --status cancelled --note "<why>"\`.`,
    `3. **Still valid** — leave it and say so: \`bash ${tk} log --project <PROJECT> --id <ID> --note "still valid: <one line — status / next step / blocker>"\`. A ticket not worth doing soon: \`… update --project <PROJECT> --id <ID> --defer-until YYYY-MM-DD\`.`,
    `4. **Status is wrong** — move it (\`… update --project <PROJECT> --id <ID> --status ready|review|…\`) or reassign it (\`… assign --project <PROJECT> --id <ID> --to <member>\`) with a one-line note. A ticket marked orphaned lost its assignee or team: give it a new owner or cancel it.`,
    '',
    'Look at the ticket (`… show --project <PROJECT> --id <ID>`) and its linked work before deciding; do not close work you cannot confirm. Any of these actions counts as the review, so a reviewed ticket is not listed again for a few days.',
    '',
    '## Tickets',
    '',
  ];
  for (const c of batch.candidates) {
    const t = c.ticket;
    const last = c.staleness.lastActivityAt.slice(0, 10);
    const bits = [
      `**${t.id}**`,
      `[${t.status}]`,
      clip(t.title, C.TITLE_MAX_CHARS),
      `project \`${t.projectId}\` (${t.projectName})`,
      `no activity for ${c.staleness.idleDays} day${c.staleness.idleDays === 1 ? '' : 's'} (last ${last})`,
      t.assignee ? `assignee ${t.assignee}` : 'unassigned',
    ];
    if (c.reasons.includes('orphaned')) bits.push('ORPHANED (assignee or team no longer exists)');
    lines.push(`- ${bits.join(' · ')}`);
  }
  if (batch.more > 0) lines.push('', `${batch.more} more stale ticket${batch.more === 1 ? '' : 's'} will be listed in a later review.`);
  lines.push('', `List all tickets of a project: \`bash ${tk} list --project <PROJECT>\`.`);
  return lines.join('\n');
}

/**
 * Cut a one-line string.
 *
 * @param text - Text
 * @param max - Max characters
 * @returns Text on one line, within `max`
 */
function clip(text: string, max: number): string {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}
