/**
 * Project ticket workflow — who may do what, claiming / assigning a ticket
 * through a linked WorkItem, and syncing the WorkItem's outcome back into the
 * ticket (specs/2026-09-28-project-tickets.md §4–§5).
 *
 * Layering: {@link ProjectTicketService} owns the files; the task pool owns
 * WorkItems; this service is the only place that connects the two. The link
 * is one metadata key on the WorkItem (`metadata.projectTicket`) plus the
 * ticket's `workItemId`. Invariant: one ticket = at most one live WorkItem,
 * enforced under the ticket folder lock at claim time.
 *
 * @module services/project-tickets/project-ticket-workflow.service
 */

import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ORCHESTRATOR_SESSION_NAME, PROJECT_TICKET_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { Project, Team, TeamMember } from '../../types/index.js';
import {
  MAX_BRIEF_MARKDOWN_BYTES,
  getWorkItemDisposition,
  type WorkItem,
  type WorkItemStatus,
} from '../../types/v2/work-item.types.js';
import {
  projectTicketPriorityRank,
  readProjectTicketLink,
  type ProjectTicket,
  type ProjectTicketFields,
  type ProjectTicketList,
  type ProjectTicketStatus,
} from '../../types/project-ticket.types.js';
import {
  ProjectTicketError,
  ProjectTicketService,
  type CreateProjectTicketInput,
  type UpdateProjectTicketInput,
} from './project-ticket.service.js';
import { SUPERSEDED_BY_METADATA_KEY } from '../v3/request-completion.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';

/** WorkItem statuses that still carry the ticket's work. */
const LIVE_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  'queued',
  'scheduled',
  'proposed',
  'accepted',
  'running',
  'blocked',
  'escalated',
  'done_by_worker',
]);

/** Statuses of an agent's own WorkItems that keep it from picking up a ticket. */
const BUSY_STATUSES: ReadonlySet<WorkItemStatus> = new Set(['queued', 'proposed', 'accepted', 'running']);

/** Pool events that can change a linked ticket. */
export const PROJECT_TICKET_SYNC_EVENTS: readonly EventType[] = ['task:verified', 'task:done', 'task:rejected', 'task:cancelled', 'task:failed'];

/** Max ticket claims tried per idle agent (another agent may win a race). */
const MAX_AUTO_CLAIM_ATTEMPTS = 3;

/** WorkItem description cap (callers cap `description` at 500 chars). */
const WORK_ITEM_DESCRIPTION_MAX = 500;

/** Who is calling. `session` absent = the owner (dashboard / CLI). */
export interface ProjectTicketCaller {
  session?: string;
}

/** The caller's standing on a project. */
export type ProjectTicketAccess = 'owner' | 'orchestrator' | 'lead' | 'member' | 'outsider';

/** The subset of the task pool this service uses. */
export interface ProjectTicketPool {
  addToPool(workItem: WorkItem): Promise<void>;
  claimSpecificItem(agentId: string, workItemId: string): Promise<{ workItem: WorkItem } | null>;
  findWorkItem(workItemId: string): Promise<WorkItem | null>;
  getAllItems(): Promise<WorkItem[]>;
  cancelQueued(workItemId: string, reason: string): Promise<void>;
  transitionStatus(workItemId: string, status: WorkItemStatus, actor: 'system', mutator?: (wi: WorkItem) => void, reason?: string): Promise<WorkItem | null>;
  releaseClaim(workItemId: string, endReason: string): Promise<void>;
}

/** The subset of storage this service uses. */
export interface ProjectTicketDirectory {
  getTeams(): Promise<Team[]>;
  getProjects(): Promise<Project[]>;
}

/** Dependencies. */
export interface ProjectTicketWorkflowDeps {
  tickets: ProjectTicketService;
  pool: ProjectTicketPool;
  directory: ProjectTicketDirectory;
  logger?: ComponentLogger;
  now?: () => string;
}

/** Outcome of a claim / assignment that started work. */
export interface StartedTicketWork {
  ticket: ProjectTicket;
  workItem: WorkItem;
  /** True when the WorkItem was claimed for the assignee right away */
  claimed: boolean;
}

/** What {@link ProjectTicketWorkflowService.syncTicket} did. */
export type TicketSyncOutcome = 'unchanged' | 'done' | 'review' | 'relinked' | 'returned';

/** Where a ticket's WorkItem chain ends. */
type ChainEnd =
  | { kind: 'success'; wi: WorkItem }
  | { kind: 'live'; wi: WorkItem }
  | { kind: 'returned'; id: string; why: string }
  | { kind: 'pending' };

/** Tickets of one project, for the per-agent listing. */
export interface ProjectTicketsOfProject {
  project: { id: string; name: string; path: string };
  tickets: ProjectTicket[];
}

/**
 * Whether a member leads a team.
 *
 * @param team - Team
 * @param member - Member of that team
 * @returns True for a team lead
 */
export function isTeamLead(team: Team, member: TeamMember): boolean {
  return (
    (team.leaderIds ?? []).includes(member.id) ||
    team.leaderId === member.id ||
    member.canDelegate === true ||
    member.role === 'team-leader'
  );
}

/**
 * Whether a member runs as the given session.
 *
 * @param member - Team member
 * @param session - Session name / agent id
 * @returns True on a match
 */
function isSession(member: TeamMember, session: string): boolean {
  return member.sessionName === session || member.agentId === session;
}

/**
 * Cut a string to a byte budget (UTF-8), keeping whole characters.
 *
 * @param text - Text
 * @param maxBytes - Budget
 * @returns Text within the budget
 */
function capBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = text.slice(0, maxBytes);
  while (Buffer.byteLength(out, 'utf8') > maxBytes - 32) out = out.slice(0, -64);
  return `${out}\n\n…(truncated — read the ticket file)`;
}

export class ProjectTicketWorkflowService {
  private static instance: ProjectTicketWorkflowService | null = null;

  private readonly tickets: ProjectTicketService;
  private readonly pool: ProjectTicketPool;
  private readonly directory: ProjectTicketDirectory;
  private readonly logger: ComponentLogger;
  private readonly now: () => string;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private sweeping = false;

  /**
   * @param deps - Ticket store, task pool, team/project directory
   */
  constructor(deps: ProjectTicketWorkflowDeps) {
    this.tickets = deps.tickets;
    this.pool = deps.pool;
    this.directory = deps.directory;
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('ProjectTicketWorkflow');
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * The wired process-wide instance, or null before boot wired it.
   *
   * @returns Instance or null
   */
  static getInstance(): ProjectTicketWorkflowService | null {
    return ProjectTicketWorkflowService.instance;
  }

  /**
   * Install the process-wide instance (boot path).
   *
   * @param service - Instance, or null to clear (tests)
   */
  static setInstance(service: ProjectTicketWorkflowService | null): void {
    ProjectTicketWorkflowService.instance = service;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to WorkItem lifecycle events and start the periodic sweep.
   *
   * @param events - Event bus with `onInProcess` (optional in tests)
   * @param intervalMs - Sweep interval (0 disables the timer)
   */
  start(
    events?: { onInProcess(types: EventType[], handler: (event: AgentEvent) => void | Promise<void>): () => void },
    intervalMs: number = PROJECT_TICKET_CONSTANTS.SYNC_SWEEP_INTERVAL_MS,
  ): void {
    if (events) {
      this.unsubscribe = events.onInProcess([...PROJECT_TICKET_SYNC_EVENTS], async (event: AgentEvent) => {
        if (event?.workItemId) await this.onWorkItemEvent(event.workItemId);
      });
    }
    if (intervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.syncAll().catch((err) =>
          this.logger.debug('Project ticket sweep failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) }),
        );
      }, intervalMs);
      this.sweepTimer.unref?.();
    }
  }

  /** Stop the sweep and the event subscription. */
  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // ---------------------------------------------------------------------------
  // Directory helpers
  // ---------------------------------------------------------------------------

  /**
   * Find a project by id, name (case-insensitive) or absolute path.
   *
   * @param ref - Project reference
   * @returns The project
   * @throws ProjectTicketError(404) when no project matches
   */
  async resolveProject(ref: string): Promise<Project> {
    const projects = await this.directory.getProjects();
    const wanted = String(ref ?? '').trim();
    const asPath = wanted.startsWith('/') ? path.resolve(wanted) : null;
    const hit =
      projects.find((p) => p.id === wanted) ??
      (asPath ? projects.find((p) => path.resolve(p.path) === asPath) : undefined) ??
      projects.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
    if (!hit) throw new ProjectTicketError(404, `Project not found: ${ref}`);
    return hit;
  }

  /**
   * Teams working on a project (not archived).
   *
   * @param project - Project
   * @param teams - All teams
   * @returns Teams whose `projectIds` contain the project
   */
  private projectTeams(project: Project, teams: Team[]): Team[] {
    return teams.filter((t) => !t.archived && (t.projectIds ?? []).includes(project.id));
  }

  /**
   * The caller's standing on a project.
   *
   * @param caller - Caller
   * @param project - Project
   * @returns Access level and the caller's memberships in the project's teams
   */
  async accessOf(caller: ProjectTicketCaller, project: Project): Promise<{ access: ProjectTicketAccess; memberships: Array<{ team: Team; member: TeamMember }> }> {
    if (!caller.session) return { access: 'owner', memberships: [] };
    if (caller.session === ORCHESTRATOR_SESSION_NAME) return { access: 'orchestrator', memberships: [] };
    const teams = this.projectTeams(project, await this.directory.getTeams());
    const memberships: Array<{ team: Team; member: TeamMember }> = [];
    for (const team of teams) {
      for (const member of team.members ?? []) {
        if (isSession(member, caller.session)) memberships.push({ team, member });
      }
    }
    if (memberships.length === 0) return { access: 'outsider', memberships };
    return { access: memberships.some((m) => isTeamLead(m.team, m.member)) ? 'lead' : 'member', memberships };
  }

  /**
   * Name recorded in Log lines for a caller.
   *
   * @param caller - Caller
   * @returns `owner` or the session name
   */
  private actorName(caller: ProjectTicketCaller): string {
    return caller.session ?? 'owner';
  }

  /**
   * Refuse unless the caller has one of the given access levels.
   *
   * @param access - Caller's access
   * @param allowed - Allowed levels
   * @param what - Action (for the message)
   * @throws ProjectTicketError(403)
   */
  private requireAccess(access: ProjectTicketAccess, allowed: ProjectTicketAccess[], what: string): void {
    if (!allowed.includes(access)) {
      throw new ProjectTicketError(403, `Not allowed to ${what}: only ${allowed.join(', ')} of this project may`);
    }
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * List a project's tickets, optionally filtered.
   *
   * @param ref - Project reference
   * @param filter - `status`, `assignee`, `label`
   * @returns Project and tickets
   */
  async list(ref: string, filter: { status?: string; assignee?: string; label?: string } = {}): Promise<{ project: Project } & ProjectTicketList> {
    const project = await this.resolveProject(ref);
    const result = await this.tickets.list(project.path);
    const statuses = filter.status ? filter.status.split(',').map((s) => s.trim()) : null;
    const tickets = result.tickets.filter(
      (t) =>
        (!statuses || statuses.includes(t.status)) &&
        (!filter.assignee || t.assignee === filter.assignee) &&
        (!filter.label || t.labels.includes(filter.label)),
    );
    return { project, tickets, invalid: result.invalid };
  }

  /**
   * One ticket.
   *
   * @param ref - Project reference
   * @param id - Ticket id
   * @returns The ticket
   * @throws ProjectTicketError(404)
   */
  async get(ref: string, id: string): Promise<ProjectTicket> {
    const project = await this.resolveProject(ref);
    const ticket = await this.tickets.get(project.path, id);
    if (!ticket) throw new ProjectTicketError(404, `Ticket not found: ${id}`);
    return ticket;
  }

  /**
   * Tickets of every project a session's teams work on.
   *
   * @param session - Agent session
   * @param filter - Optional status filter
   * @returns Per-project tickets
   */
  async listForSession(session: string, filter: { status?: string } = {}): Promise<ProjectTicketsOfProject[]> {
    const teams = (await this.directory.getTeams()).filter((t) => !t.archived && (t.members ?? []).some((m) => isSession(m, session)));
    const projectIds = new Set(teams.flatMap((t) => t.projectIds ?? []));
    const projects = (await this.directory.getProjects()).filter((p) => projectIds.has(p.id));
    const out: ProjectTicketsOfProject[] = [];
    for (const project of projects) {
      const { tickets } = await this.list(project.id, filter);
      out.push({ project: { id: project.id, name: project.name, path: project.path }, tickets });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Create a ticket. Workers' tickets always start in `backlog`.
   *
   * @param ref - Project reference
   * @param input - Content
   * @param caller - Caller
   * @returns New ticket
   * @throws ProjectTicketError(403) for outsiders, (400) for a team not on the project
   */
  async create(ref: string, input: CreateProjectTicketInput, caller: ProjectTicketCaller): Promise<ProjectTicket> {
    const project = await this.resolveProject(ref);
    const { access } = await this.accessOf(caller, project);
    this.requireAccess(access, ['owner', 'orchestrator', 'lead', 'member'], 'create tickets');
    await this.assertTeamOnProject(project, input.team);
    const status = access === 'member' ? 'backlog' : input.status ?? 'backlog';
    if (status === 'in_progress' || status === 'review' || status === 'done') {
      throw new ProjectTicketError(400, 'A new ticket starts in backlog or ready; claim or assign it to start work');
    }
    const source = input.source ?? (caller.session ? `agent:${caller.session}` : 'owner');
    return this.tickets.create(project.path, project.name, { ...input, status, source, assignee: input.assignee ?? null }, this.actorName(caller));
  }

  /**
   * Change fields / sections, optionally followed by a status transition.
   *
   * @param ref - Project reference
   * @param id - Ticket id
   * @param input - Changes (+ optional `status`)
   * @param caller - Caller
   * @param note - Optional Log note
   * @returns Updated ticket
   */
  async update(
    ref: string,
    id: string,
    input: UpdateProjectTicketInput & { status?: ProjectTicketStatus },
    caller: ProjectTicketCaller,
    note?: string,
  ): Promise<ProjectTicket> {
    const project = await this.resolveProject(ref);
    const { access } = await this.accessOf(caller, project);
    this.requireAccess(access, ['owner', 'orchestrator', 'lead', 'member'], 'edit tickets');
    if (input.team !== undefined) await this.assertTeamOnProject(project, input.team);
    const { status, ...fields } = input;
    let ticket = await this.tickets.update(project.path, id, fields, this.actorName(caller), status ? undefined : note);
    if (status && status !== ticket.status) ticket = await this.transition(project.id, id, status, caller, note);
    return ticket;
  }

  /**
   * Move a ticket to another status (spec §3–§4). Starting work goes through
   * {@link claim} / {@link assign}, not here. Moving a ticket out of
   * `in_progress` by hand cancels its live WorkItem; ready / backlog /
   * cancelled also clear the assignee and the WorkItem link.
   *
   * @param ref - Project reference
   * @param id - Ticket id
   * @param to - New status
   * @param caller - Caller
   * @param note - Optional reason
   * @returns Updated ticket
   * @throws ProjectTicketError(400/403/404)
   */
  async transition(ref: string, id: string, to: ProjectTicketStatus, caller: ProjectTicketCaller, note?: string): Promise<ProjectTicket> {
    const project = await this.resolveProject(ref);
    const { access } = await this.accessOf(caller, project);
    if (to === 'in_progress') throw new ProjectTicketError(400, 'Use claim or assign to start work on a ticket');
    const current = await this.tickets.get(project.path, id);
    if (!current) throw new ProjectTicketError(404, `Ticket not found: ${id}`);
    const isRelease = current.status === 'in_progress' && (to === 'ready' || to === 'backlog');
    const ownRelease = isRelease && !!caller.session && current.assignee === caller.session;
    if (!(ownRelease && access === 'member')) {
      this.requireAccess(access, ['owner', 'orchestrator', 'lead'], `move tickets to ${to}`);
    }
    const clearsWork = to === 'ready' || to === 'backlog' || to === 'cancelled';
    const extra: Partial<ProjectTicketFields> = clearsWork ? { assignee: null, workItemId: null } : {};
    const updated = await this.tickets.transition(project.path, id, to, this.actorName(caller), note, extra);
    // A person moving the ticket out of in_progress stops the work: a live
    // WorkItem is cancelled (one already submitted for review is left to
    // its reviewer — done_by_worker cannot be cancelled).
    if (current.status === 'in_progress' && current.workItemId) {
      await this.cancelLiveWorkItem(current.workItemId, `project ticket ${id} moved to ${to} by ${this.actorName(caller)}`);
    }
    return updated;
  }

  /**
   * Append a note to a ticket's Log.
   *
   * @param ref - Project reference
   * @param id - Ticket id
   * @param caller - Caller
   * @param note - The note
   * @returns Updated ticket
   */
  async log(ref: string, id: string, caller: ProjectTicketCaller, note: string): Promise<ProjectTicket> {
    const project = await this.resolveProject(ref);
    const { access } = await this.accessOf(caller, project);
    this.requireAccess(access, ['owner', 'orchestrator', 'lead', 'member'], 'write to ticket logs');
    return this.tickets.appendLog(project.path, id, this.actorName(caller), note);
  }

  /**
   * The calling agent claims a `ready` ticket: it becomes `in_progress`,
   * assigned to the caller, with a new linked WorkItem claimed for it.
   *
   * @param ref - Project reference
   * @param id - Ticket id
   * @param caller - Must be an agent on one of the project's (eligible) teams
   * @returns Ticket, WorkItem, whether the WorkItem is claimed
   * @throws ProjectTicketError(403) for non-members, (409) when not claimable
   */
  async claim(ref: string, id: string, caller: ProjectTicketCaller): Promise<StartedTicketWork> {
    const project = await this.resolveProject(ref);
    if (!caller.session) throw new ProjectTicketError(400, 'Claiming needs an agent session (X-Agent-Session); the owner assigns instead');
    const ticket = await this.tickets.get(project.path, id);
    if (!ticket) throw new ProjectTicketError(404, `Ticket not found: ${id}`);
    const teamId = await this.eligibleTeamOf(project, ticket, caller.session);
    if (!teamId) throw new ProjectTicketError(403, `${caller.session} is not on a team that works on ${ticket.id}`);
    return this.startWork(project, id, caller.session, caller.session, teamId, { self: true, allowed: ['ready'] });
  }

  /**
   * Assign a ticket (owner, orchestrator or a lead of a project team). An
   * agent assignee on an eligible team gets a linked WorkItem (queued for it,
   * dispatched by the normal path) unless `start` is false; any other
   * assignee (a human) is only recorded.
   *
   * @param ref - Project reference
   * @param id - Ticket id
   * @param assignee - Session name or a human's name
   * @param caller - Caller
   * @param options - `start` (default true)
   * @returns The ticket, plus the WorkItem when work started
   */
  async assign(
    ref: string,
    id: string,
    assignee: string,
    caller: ProjectTicketCaller,
    options: { start?: boolean } = {},
  ): Promise<{ ticket: ProjectTicket; workItem?: WorkItem }> {
    const project = await this.resolveProject(ref);
    const { access } = await this.accessOf(caller, project);
    this.requireAccess(access, ['owner', 'orchestrator', 'lead'], 'assign tickets');
    const who = String(assignee ?? '').trim();
    if (!who) throw new ProjectTicketError(400, 'assignee is required');
    const ticket = await this.tickets.get(project.path, id);
    if (!ticket) throw new ProjectTicketError(404, `Ticket not found: ${id}`);
    const teamId = await this.eligibleTeamOf(project, ticket, who);
    const isAgent = await this.isKnownAgent(who);
    if (isAgent && !teamId) throw new ProjectTicketError(403, `${who} is not on a team that works on ${ticket.id}`);
    if (teamId && options.start !== false) {
      const started = await this.startWork(project, id, who, this.actorName(caller), teamId, { self: false, allowed: ['backlog', 'ready'] });
      return { ticket: started.ticket, workItem: started.workItem };
    }
    if (ticket.status === 'in_progress') throw new ProjectTicketError(409, `${ticket.id} is in progress; release it before reassigning`);
    const updated = await this.tickets.mutate(project.path, id, this.actorName(caller), (t) =>
      t.assignee === who ? null : { fields: { assignee: who }, log: [`assigned to ${who}`] },
    );
    return { ticket: updated };
  }

  /**
   * Claim the best `ready` ticket for an idle agent (AutoClaim fallback, spec
   * §5): highest priority, then oldest, across its teams' projects. Skipped
   * when the agent already works a ticket or still has WorkItems of its own.
   *
   * A team lead is not fed tickets automatically in a team that has other
   * members — leads delegate (they can still claim or assign explicitly). A
   * lead who is the only member of its team is treated like any member.
   *
   * @param session - Idle agent
   * @returns The started work, or null
   */
  async claimNextForAgent(session: string): Promise<StartedTicketWork | null> {
    if (!session || session === ORCHESTRATOR_SESSION_NAME) return null;
    const teams = (await this.directory.getTeams()).filter((t) => {
      if (t.archived) return false;
      const me = (t.members ?? []).find((m) => isSession(m, session));
      if (!me) return false;
      return !isTeamLead(t, me) || (t.members ?? []).length === 1;
    });
    if (teams.length === 0) return null;
    const pool = await this.pool.getAllItems();
    if (pool.some((wi) => wi.target === session && BUSY_STATUSES.has(wi.status))) return null;

    const projectIds = new Set(teams.flatMap((t) => t.projectIds ?? []));
    const projects = (await this.directory.getProjects()).filter((p) => projectIds.has(p.id));
    const candidates: Array<{ project: Project; ticket: ProjectTicket; teamId: string }> = [];
    for (const project of projects) {
      const { tickets } = await this.tickets.list(project.path);
      if (tickets.some((t) => t.status === 'in_progress' && t.assignee === session)) return null;
      for (const ticket of tickets) {
        if (ticket.status !== 'ready') continue;
        const team = teams.find((t) => (t.projectIds ?? []).includes(project.id) && (!ticket.team || ticket.team === t.id));
        if (team) candidates.push({ project, ticket, teamId: team.id });
      }
    }
    candidates.sort(
      (a, b) =>
        projectTicketPriorityRank(a.ticket.priority) - projectTicketPriorityRank(b.ticket.priority) ||
        (Date.parse(a.ticket.createdAt) || 0) - (Date.parse(b.ticket.createdAt) || 0) ||
        Number(a.ticket.id.split('-').pop()) - Number(b.ticket.id.split('-').pop()),
    );
    for (const c of candidates.slice(0, MAX_AUTO_CLAIM_ATTEMPTS)) {
      try {
        return await this.startWork(c.project, c.ticket.id, session, session, c.teamId, { self: true, allowed: ['ready'] });
      } catch (err) {
        // Lost a race (someone claimed it, a human moved it) — try the next.
        this.logger.debug('Ticket auto-claim attempt skipped', {
          ticketId: c.ticket.id,
          session,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Sync (WorkItem → ticket)
  // ---------------------------------------------------------------------------

  /**
   * React to a pool lifecycle event: find the ticket the WorkItem (or one of
   * its ancestors — a reviewer's retry or review item) belongs to and sync it.
   *
   * @param workItemId - WorkItem from the event
   */
  async onWorkItemEvent(workItemId: string): Promise<void> {
    try {
      let wi = await this.pool.findWorkItem(workItemId);
      for (let hop = 0; wi && hop < PROJECT_TICKET_CONSTANTS.MAX_SUCCESSOR_HOPS; hop++) {
        const link = readProjectTicketLink(wi.metadata);
        if (link) {
          await this.syncTicket(link.projectPath, link.id);
          return;
        }
        const parentId = wi.parentWorkItemId ?? (typeof wi.metadata?.verifyOf === 'string' ? wi.metadata.verifyOf : undefined);
        wi = parentId ? await this.pool.findWorkItem(parentId) : null;
      }
    } catch (err) {
      this.logger.warn('Project ticket sync on WorkItem event failed (sweep will retry)', {
        workItemId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Reconcile every `in_progress` ticket of every project with its WorkItem.
   *
   * @returns Number of tickets changed
   */
  async syncAll(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let changed = 0;
    try {
      for (const project of await this.directory.getProjects()) {
        let tickets: ProjectTicket[] = [];
        try {
          tickets = (await this.tickets.list(project.path)).tickets;
        } catch {
          continue;
        }
        for (const t of tickets) {
          if (t.status !== 'in_progress' || !t.workItemId) continue;
          const outcome = await this.syncTicket(project.path, t.id).catch(() => 'unchanged' as const);
          if (outcome !== 'unchanged') changed += 1;
        }
      }
    } finally {
      this.sweeping = false;
    }
    return changed;
  }

  /**
   * Bring one ticket in line with its WorkItem chain (spec §5 table).
   * Only an `in_progress` ticket is ever changed, so human moves are never
   * fought.
   *
   * @param projectPath - Project root
   * @param id - Ticket id
   * @returns What changed
   */
  async syncTicket(projectPath: string, id: string): Promise<TicketSyncOutcome> {
    const ticket = await this.tickets.get(projectPath, id);
    if (!ticket || ticket.status !== 'in_progress' || !ticket.workItemId) return 'unchanged';
    const end = await this.followChain(ticket.workItemId);
    let outcome: TicketSyncOutcome = 'unchanged';
    await this.tickets.mutate(projectPath, id, 'crewly', (t) => {
      // Re-checked under the lock: a human or another sync may have moved it.
      if (t.status !== 'in_progress' || t.workItemId !== ticket.workItemId) return null;
      switch (end.kind) {
        case 'success': {
          const to: ProjectTicketStatus = t.ownerReview ? 'review' : 'done';
          outcome = to;
          return {
            fields: { status: to, workItemId: end.wi.id },
            log: [`WorkItem ${end.wi.id} ${end.wi.status} → ${to}${to === 'review' ? ' (waiting for the owner)' : ''}`],
          };
        }
        case 'live':
          if (end.wi.id === t.workItemId) return null;
          outcome = 'relinked';
          return {
            fields: { workItemId: end.wi.id, ...(end.wi.target ? { assignee: end.wi.target } : {}) },
            log: [`work continues in WorkItem ${end.wi.id}`],
          };
        case 'returned':
          outcome = 'returned';
          return {
            fields: { status: 'ready', assignee: null, workItemId: null },
            log: [`WorkItem ${end.id} ${end.why} — back to ready`],
          };
        default:
          return null;
      }
    });
    if (outcome !== 'unchanged') this.logger.info('Project ticket synced from its WorkItem', { projectPath, id, outcome });
    return outcome;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Start work on a ticket under the folder lock: refuse when a live WorkItem
   * already carries it, create the WorkItem, write the ticket, roll the
   * WorkItem back if the write fails; then claim it for a self-claim.
   *
   * @param project - Project
   * @param id - Ticket id
   * @param assignee - Agent that will do the work
   * @param actor - Who started it (Log)
   * @param teamId - Team the assignee works on it for
   * @param options - `self`: claim the WorkItem for the assignee; `allowed`: statuses work may start from
   * @returns Started work
   */
  private async startWork(
    project: Project,
    id: string,
    assignee: string,
    actor: string,
    teamId: string,
    options: { self: boolean; allowed: ProjectTicketStatus[] },
  ): Promise<StartedTicketWork> {
    let created: WorkItem | null = null;
    let ticket: ProjectTicket;
    try {
      ticket = await this.tickets.mutate(project.path, id, actor, async (t) => {
        if (!options.allowed.includes(t.status)) {
          throw new ProjectTicketError(409, `${t.id} is ${t.status}; only ${options.allowed.join(' or ')} tickets can be ${options.self ? 'claimed' : 'assigned'}`);
        }
        if (t.team && t.team !== teamId) throw new ProjectTicketError(403, `${t.id} belongs to team ${t.team}`);
        const live = await this.findLiveLinkedWorkItem(project.path, t);
        if (live) throw new ProjectTicketError(409, `${t.id} is already being worked in WorkItem ${live.id}`);
        created = this.buildWorkItem(project, t, assignee, teamId);
        await this.pool.addToPool(created);
        return {
          fields: { status: 'in_progress', assignee, workItemId: created.id },
          log: [options.self ? `claimed by ${assignee} — WorkItem ${created.id}` : `assigned to ${assignee} — WorkItem ${created.id}`],
        };
      });
    } catch (err) {
      const orphan = created as WorkItem | null;
      if (orphan) {
        await this.pool.cancelQueued(orphan.id, `project ticket ${id} could not be updated`).catch(() => undefined);
      }
      throw err;
    }
    let workItem = created as unknown as WorkItem;
    let claimed = false;
    if (options.self) {
      const result = await this.pool.claimSpecificItem(assignee, workItem.id).catch(() => null);
      if (result) {
        workItem = result.workItem;
        claimed = true;
      }
    }
    this.logger.info('Project ticket work started', { projectPath: project.path, id, assignee, workItemId: workItem.id, claimed });
    return { ticket, workItem, claimed };
  }

  /**
   * Build the WorkItem that carries a ticket's work.
   *
   * @param project - Project
   * @param t - Ticket
   * @param assignee - Target agent
   * @param teamId - Team
   * @returns WorkItem (queued)
   */
  private buildWorkItem(project: Project, t: ProjectTicket, assignee: string, teamId: string): WorkItem {
    const criteria = t.acceptance.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n');
    const brief = [
      `# ${t.id}: ${t.title}`,
      '',
      `Project ticket file: \`${t.filePath}\` (project ${project.name}). Priority ${t.priority}.`,
      'When you finish, complete this WorkItem as usual (complete-task / report-status with this WorkItem id);',
      'your lead reviews it and the ticket moves to done by itself. Use `project-tickets log` for progress notes.',
      '',
      '## Description',
      '',
      t.description || '_No description._',
      '',
      '## Acceptance criteria',
      '',
      criteria || '_None listed._',
    ].join('\n');
    const priorityMeta = t.priority.toLowerCase();
    return {
      id: uuidv4(),
      type: 'project_task',
      owner: 'agent',
      target: assignee,
      targetSource: 'assigned',
      title: `${t.id}: ${t.title}`,
      description: (t.description || t.title).slice(0, WORK_ITEM_DESCRIPTION_MAX),
      briefMarkdown: capBytes(brief, MAX_BRIEF_MARKDOWN_BYTES),
      status: 'queued',
      createdAt: this.now(),
      retryCount: 0,
      maxRetries: 3,
      projectTaskId: t.id,
      ...(t.requestId ? { requestId: t.requestId } : {}),
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      metadata: {
        [PROJECT_TICKET_CONSTANTS.WORK_ITEM_METADATA_KEY]: { projectPath: project.path, id: t.id },
        projectId: project.id,
        projectPath: project.path,
        teamId,
        priority: priorityMeta,
        requiresVerification: true,
      },
    };
  }

  /**
   * A live WorkItem already carrying this ticket: the ticket's own
   * `workItemId` chain, or any pool item whose metadata links the ticket.
   *
   * @param projectPath - Project root
   * @param t - Ticket
   * @returns The live item, or null
   */
  private async findLiveLinkedWorkItem(projectPath: string, t: ProjectTicket): Promise<WorkItem | null> {
    if (t.workItemId) {
      const end = await this.followChain(t.workItemId);
      if (end.kind === 'live') return end.wi;
    }
    const root = path.resolve(projectPath);
    const items = await this.pool.getAllItems();
    return (
      items.find((wi) => {
        if (!LIVE_STATUSES.has(wi.status)) return false;
        const link = readProjectTicketLink(wi.metadata);
        return !!link && link.id === t.id && path.resolve(link.projectPath) === root;
      }) ?? null
    );
  }

  /**
   * Follow a WorkItem through its successors to where the work stands now.
   *
   * @param startId - The ticket's WorkItem
   * @returns Where the chain ends
   */
  private async followChain(startId: string): Promise<ChainEnd> {
    let current = startId;
    for (let hop = 0; hop < PROJECT_TICKET_CONSTANTS.MAX_SUCCESSOR_HOPS; hop++) {
      const wi = await this.pool.findWorkItem(current);
      if (!wi) return { kind: 'returned', id: current, why: 'no longer exists' };
      if (wi.status === 'verified' || wi.status === 'done') return { kind: 'success', wi };
      if (LIVE_STATUSES.has(wi.status)) return { kind: 'live', wi };
      const superseded = wi.metadata?.[SUPERSEDED_BY_METADATA_KEY];
      const supersededBy = Array.isArray(superseded) && typeof superseded[0] === 'string' ? superseded[0] : undefined;
      const disposition = getWorkItemDisposition(wi);
      const successor = supersededBy ?? (disposition?.kind === 'succeeded_by' ? disposition.successorWorkItemId : undefined);
      if (successor && successor !== current) {
        current = successor;
        continue;
      }
      if (wi.status === 'cancelled') return { kind: 'returned', id: wi.id, why: `cancelled${wi.cancelReason ? `: ${wi.cancelReason}` : ''}` };
      if (disposition?.kind === 'terminal') return { kind: 'returned', id: wi.id, why: `${wi.status}${wi.error ? `: ${wi.error}` : ''}` };
      // failed / rejected with no decision yet: the harness is still choosing
      // between a retry in place and a successor — wait.
      return { kind: 'pending' };
    }
    return { kind: 'pending' };
  }

  /**
   * Cancel a WorkItem if it is still live (best-effort).
   *
   * @param workItemId - Item
   * @param reason - Cancel reason
   */
  private async cancelLiveWorkItem(workItemId: string, reason: string): Promise<void> {
    try {
      const end = await this.followChain(workItemId);
      if (end.kind !== 'live') return;
      const wi = end.wi;
      if (wi.status === 'queued' || wi.status === 'blocked' || wi.status === 'scheduled') {
        await this.pool.cancelQueued(wi.id, reason);
      } else if (wi.status === 'running') {
        await this.pool.releaseClaim(wi.id, reason);
        await this.pool.transitionStatus(wi.id, 'cancelled', 'system', undefined, reason);
      } else {
        this.logger.info('Linked WorkItem left as is (not cancellable from its status)', { workItemId: wi.id, status: wi.status });
      }
    } catch (err) {
      this.logger.warn('Could not cancel the linked WorkItem', { workItemId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * The team an agent would work a ticket for, or null when it may not.
   *
   * @param project - Project
   * @param ticket - Ticket (its `team` narrows the choice)
   * @param session - Agent session
   * @returns Team id or null
   */
  private async eligibleTeamOf(project: Project, ticket: ProjectTicket, session: string): Promise<string | null> {
    const teams = this.projectTeams(project, await this.directory.getTeams());
    const team = teams.find((t) => (!ticket.team || ticket.team === t.id) && (t.members ?? []).some((m) => isSession(m, session)));
    return team?.id ?? null;
  }

  /**
   * Whether a name is an agent session on any team.
   *
   * @param name - Candidate
   * @returns True for a known agent
   */
  private async isKnownAgent(name: string): Promise<boolean> {
    if (name === ORCHESTRATOR_SESSION_NAME) return true;
    return (await this.directory.getTeams()).some((t) => (t.members ?? []).some((m) => isSession(m, name)));
  }

  /**
   * Refuse a `team` value that is not one of the project's teams.
   *
   * @param project - Project
   * @param team - Team id (null/empty = any)
   * @throws ProjectTicketError(400)
   */
  private async assertTeamOnProject(project: Project, team: string | null | undefined): Promise<void> {
    if (!team) return;
    const teams = this.projectTeams(project, await this.directory.getTeams());
    if (!teams.some((t) => t.id === team)) throw new ProjectTicketError(400, `Team ${team} does not work on project ${project.name}`);
  }
}
