/**
 * Ticket autopilot (specs/2026-09-30-ticket-autopilot.md).
 *
 * A per-project switch (default off). While it is on:
 * - the project's driver (its team lead) is woken with ONE `ticket_triage`
 *   WorkItem listing the backlog tickets to decide (ready + assign, split,
 *   ask the owner, cancel) — only when someone on the team is idle, at most
 *   one live triage per project, at most every 30 min (sooner when a member
 *   goes idle with nothing ready);
 * - brakes hold: a daily USD budget over the team's agents (pauses the
 *   autopilot and ticket auto-claim for the day, owner told once) and an
 *   in-progress cap per member ({@link ProjectTicketAutopilotPolicy});
 * - owner questions are decision cards (specs/2026-10-01-decision-cards.md),
 *   posted by the asking agent in the ticket's thread; the owner gets one
 *   evening digest (skipped when nothing changed) that links to open cards.
 *
 * The approval boundary is unchanged: the autopilot only wakes the lead and
 * talks to the owner; it never makes a ticket ready or starts work itself.
 *
 * @module services/project-tickets/ticket-autopilot.service
 */

import * as path from 'path';
import { TICKET_AUTOPILOT_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import type { Project, Team, TeamMember } from '../../types/index.js';
import { createWorkItem, MAX_BRIEF_MARKDOWN_BYTES, type WorkItem, type WorkItemStatus } from '../../types/v2/work-item.types.js';
import type { ProjectTicket, ProjectTicketList } from '../../types/project-ticket.types.js';
import {
  applyTicketAutopilotInput,
  resolveTicketAutopilotSettings,
  type ResolvedTicketAutopilotSettings,
  type TicketAutopilotSettingsInput,
} from '../../types/ticket-autopilot.types.js';
import { ProjectTicketError } from './project-ticket.service.js';
import { getTeamLeads } from '../../utils/team.utils.js';
import {
  isTeamLead,
  type ProjectTicketAccess,
  type ProjectTicketAutopilotPolicy,
  type ProjectTicketCaller,
} from './project-ticket-workflow.service.js';
import {
  OPEN_TICKET_STATUSES,
  decideDigest,
  decideTriage,
  hasNeedsOwnerLabel,
  inFlightByAssignee,
  isMemberIdle,
  localDateKey,
  memberAvailability,
  memberResponsibility,
  localMidnight,
  selectTriageCandidates,
  type ListedTicket,
  type TriageDecision,
  type TriageTrigger,
} from './ticket-autopilot-decision.js';
import {
  buildBudgetPausedMessage,
  buildDigestMessage,
  buildTriageBrief,
  type DigestProject,
  type TriageBriefMember,
} from './ticket-autopilot-messages.js';

/** WorkItem statuses that keep a triage "live" (one per project). */
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

/** The subset of the task pool the autopilot uses. */
export interface TicketAutopilotPool {
  addToPool(workItem: WorkItem): Promise<void>;
  getAllItems(): Promise<WorkItem[]>;
  cancelQueued(workItemId: string, reason: string): Promise<void>;
}

/** The subset of storage the autopilot uses. */
export interface TicketAutopilotDirectory {
  getTeams(): Promise<Team[]>;
  getProjects(): Promise<Project[]>;
  saveProject(project: Project): Promise<void>;
}

/** The ticket store (read only). */
export interface TicketAutopilotTicketStore {
  list(projectPath: string): Promise<ProjectTicketList>;
}

/** Project resolution + caller access (the ticket workflow). */
export interface TicketAutopilotWorkflow {
  resolveProject(ref: string): Promise<Project>;
  accessOf(caller: ProjectTicketCaller, project: Project): Promise<{ access: ProjectTicketAccess }>;
  setAutopilotPolicy?(policy: ProjectTicketAutopilotPolicy | null): void;
}

/** Token / cost ledger (see TokenUsageService.getSessionUsageSince). */
export interface TicketAutopilotLedger {
  getSessionUsageSince(sessionName: string, since: Date, until?: Date): { cost: number };
}

/** A message to the owner through the usual owner-notification path. */
export interface OwnerNotice {
  title: string;
  message: string;
  urgent: boolean;
}

/** Dependencies. */
export interface TicketAutopilotDeps {
  tickets: TicketAutopilotTicketStore;
  pool: TicketAutopilotPool;
  directory: TicketAutopilotDirectory;
  workflow: TicketAutopilotWorkflow;
  ledger: TicketAutopilotLedger;
  /** Sends to the owner; resolves false when it could not be sent (retried on the next tick) */
  notifyOwner: (notice: OwnerNotice) => Promise<boolean>;
  /** JSON file holding the autopilot's bookkeeping */
  stateFile: string;
  /**
   * Link to the Slack card / thread where a ticket waits on the owner
   * (decision cards). The digest links to it; it never repeats the question.
   */
  cardLinkOf?: (projectPath: string, ticketId: string) => Promise<string | null>;
  /** Description of a role (role.json / user override), for the brief's role lines; absent = built-in fallbacks only */
  roleDescription?: (role: string) => Promise<string | null>;
  now?: () => Date;
  logger?: ComponentLogger;
}

/** Per-project bookkeeping. */
interface ProjectState {
  lastTriageAt?: number;
  lastTriageWorkItemId?: string;
  listed?: Record<string, ListedTicket>;
  /** Local date the budget-paused notice went out */
  budgetNoticeDate?: string;
}

/** Everything the autopilot remembers across restarts. */
interface AutopilotState {
  projects: Record<string, ProjectState>;
  questions: { lastSentAt?: number; sentKeys: string[] };
  digest: { lastSentDate?: string; lastSentAt?: number };
}

/** The driver of a project. */
export interface ResolvedDriver {
  session: string;
  teamId: string;
  source: 'setting' | 'team_lead';
}

/** What {@link TicketAutopilotService.getStatus} returns. */
export interface TicketAutopilotStatus {
  project: { id: string; name: string; path: string };
  settings: ResolvedTicketAutopilotSettings;
  driver: ResolvedDriver | null;
  spentTodayUsd: number;
  pausedForToday: boolean;
  triageInFlight: boolean;
  lastTriageAt: string | null;
}

/** Outcome of one project evaluation. */
export interface ProjectEvaluation {
  projectId: string;
  decision: TriageDecision;
  /** The triage WorkItem created, when the decision was `triage` */
  workItem?: WorkItem;
}

/**
 * Session of a member (the running session, else its stable agent id).
 *
 * @param m - Team member
 * @returns Session name or empty string
 */
function sessionOf(m: TeamMember): string {
  return m.sessionName || m.agentId || '';
}

export class TicketAutopilotService {
  private static instance: TicketAutopilotService | null = null;

  private readonly deps: TicketAutopilotDeps;
  private readonly logger: ComponentLogger;
  private readonly now: () => Date;
  private state: AutopilotState | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Serialises evaluations so an idle event and the tick never create two triages */
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param deps - Stores, pool, ledger, owner notifier, state file, clock
   */
  constructor(deps: TicketAutopilotDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('TicketAutopilot');
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * The wired process-wide instance, or null before boot wired it.
   *
   * @returns Instance or null
   */
  static getInstance(): TicketAutopilotService | null {
    return TicketAutopilotService.instance;
  }

  /**
   * Install the process-wide instance (boot path).
   *
   * @param service - Instance, or null to clear (tests)
   */
  static setInstance(service: TicketAutopilotService | null): void {
    TicketAutopilotService.instance = service;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Install the brakes on the ticket workflow and start the periodic tick.
   *
   * @param intervalMs - Tick interval (0 = no timer; tests call {@link tick})
   */
  start(intervalMs: number = TICKET_AUTOPILOT_CONSTANTS.TICK_INTERVAL_MS): void {
    this.deps.workflow.setAutopilotPolicy?.(this.policy());
    if (intervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => {
        void this.tick().catch((err) =>
          this.logger.warn('Ticket autopilot tick failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) }),
        );
      }, intervalMs);
      this.timer.unref?.();
    }
  }

  /** Stop the tick and remove the brakes. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.deps.workflow.setAutopilotPolicy?.(null);
  }

  /**
   * The brakes the ticket workflow asks about.
   *
   * @returns Policy bound to this service
   */
  policy(): ProjectTicketAutopilotPolicy {
    return {
      isAutoClaimPaused: async (project) => {
        const settings = resolveTicketAutopilotSettings(project.ticketAutopilot);
        if (!settings.enabled) return false;
        const teams = await this.projectTeams(project);
        return this.spentToday(teams) >= settings.dailyBudgetUsd;
      },
      maxInFlightPerMember: async (project) => {
        const settings = resolveTicketAutopilotSettings(project.ticketAutopilot);
        return settings.enabled ? settings.maxInFlightPerMember : null;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Settings (owner / orchestrator only)
  // ---------------------------------------------------------------------------

  /**
   * The project's autopilot settings and live status.
   *
   * @param ref - Project id, name or path
   * @param caller - Owner or orchestrator
   * @returns Settings, driver, today's spend, pause / triage state
   * @throws ProjectTicketError(403/404)
   */
  async getStatus(ref: string, caller: ProjectTicketCaller): Promise<TicketAutopilotStatus> {
    const project = await this.deps.workflow.resolveProject(ref);
    await this.requireOwnerOrOrc(caller, project);
    return this.statusOf(project);
  }

  /**
   * Change the project's autopilot settings.
   *
   * @param ref - Project id, name or path
   * @param input - `enabled`, `driver`, `dailyBudgetUsd`, `maxInFlightPerMember` (null resets one)
   * @param caller - Owner or orchestrator
   * @returns The new status
   * @throws ProjectTicketError(400) on invalid input or a driver who is not a lead of a project team; (403/404)
   */
  async updateSettings(ref: string, input: TicketAutopilotSettingsInput, caller: ProjectTicketCaller): Promise<TicketAutopilotStatus> {
    const resolved = await this.deps.workflow.resolveProject(ref);
    await this.requireOwnerOrOrc(caller, resolved);
    // Re-read the stored record right before the write so a concurrent change
    // of another field is not lost.
    const project = (await this.deps.directory.getProjects()).find((p) => p.id === resolved.id) ?? resolved;
    const result = applyTicketAutopilotInput(project.ticketAutopilot, input);
    if (!result.ok) throw new ProjectTicketError(400, result.error);
    const teams = await this.projectTeams(project);
    if (result.settings.driver && !this.findLead(teams, result.settings.driver)) {
      throw new ProjectTicketError(400, `driver ${result.settings.driver} is not a team lead on a team that works on ${project.name}`);
    }
    const updated: Project = { ...project, ticketAutopilot: result.settings, updatedAt: this.now().toISOString() };
    await this.deps.directory.saveProject(updated);
    this.logger.info('Ticket autopilot settings changed', {
      projectId: project.id,
      by: caller.session ?? 'owner',
      settings: result.settings,
    });
    return this.statusOf(updated);
  }

  // ---------------------------------------------------------------------------
  // Triggers
  // ---------------------------------------------------------------------------

  /**
   * Periodic pass: evaluate every enabled project, then the daily digest.
   * Owner questions are decision cards now (specs/2026-10-01-decision-cards.md):
   * the asking agent posts them in the ticket's thread; there is no batched DM.
   *
   * @returns Per-project evaluations
   */
  async tick(): Promise<ProjectEvaluation[]> {
    return this.serial(async () => {
      const projects = (await this.deps.directory.getProjects()).filter((p) => resolveTicketAutopilotSettings(p.ticketAutopilot).enabled);
      const out: ProjectEvaluation[] = [];
      for (const project of projects) {
        try {
          out.push(await this.evaluateProject(project, 'tick'));
        } catch (err) {
          this.logger.warn('Ticket autopilot evaluation failed', { projectId: project.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (projects.length > 0) {
        await this.processDigest(projects).catch((err) =>
          this.logger.warn('Ticket digest pass failed', { error: err instanceof Error ? err.message : String(err) }),
        );
      }
      return out;
    });
  }

  /**
   * A member went idle and AutoClaim found nothing ready for it: evaluate
   * the enabled projects it works on right away (bounded by
   * {@link TICKET_AUTOPILOT_CONSTANTS.IDLE_TRIGGER_MIN_INTERVAL_MS}).
   *
   * @param session - The idle agent
   * @returns Per-project evaluations
   */
  async onMemberIdle(session: string): Promise<ProjectEvaluation[]> {
    if (!session) return [];
    return this.serial(async () => {
      const teams = (await this.deps.directory.getTeams()).filter(
        (t) => !t.archived && (t.members ?? []).some((m) => sessionOf(m) === session || m.sessionName === session),
      );
      const projectIds = new Set(teams.flatMap((t) => t.projectIds ?? []));
      if (projectIds.size === 0) return [];
      const projects = (await this.deps.directory.getProjects()).filter(
        (p) => projectIds.has(p.id) && resolveTicketAutopilotSettings(p.ticketAutopilot).enabled,
      );
      const out: ProjectEvaluation[] = [];
      for (const project of projects) {
        try {
          out.push(await this.evaluateProject(project, 'member_idle', session));
        } catch (err) {
          this.logger.warn('Ticket autopilot idle evaluation failed', { projectId: project.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return out;
    });
  }

  // ---------------------------------------------------------------------------
  // Evaluation
  // ---------------------------------------------------------------------------

  /**
   * Evaluate one project and, when {@link decideTriage} says so, wake its
   * driver with a triage WorkItem.
   *
   * @param project - Project (with its stored settings)
   * @param trigger - Periodic tick or a member going idle
   * @param idleSession - The member that just went idle
   * @returns The decision (and the WorkItem when one was created)
   */
  private async evaluateProject(project: Project, trigger: TriageTrigger, idleSession?: string): Promise<ProjectEvaluation> {
    const settings = resolveTicketAutopilotSettings(project.ticketAutopilot);
    const state = await this.loadState();
    const ps = (state.projects[project.id] ??= {});
    const now = this.now();
    const nowMs = now.getTime();
    const teams = await this.projectTeams(project);
    const driver = this.resolveDriver(settings, teams);
    const spent = this.spentToday(teams);

    if (settings.enabled && spent >= settings.dailyBudgetUsd) await this.noticeBudgetPaused(project, ps, spent, settings.dailyBudgetUsd, now);

    const { tickets } = await this.deps.tickets.list(project.path);
    const live = await this.liveTriageItem(project, nowMs);
    const selection = selectTriageCandidates({ tickets, teams, now: nowMs, listed: ps.listed });
    const members = teams.flatMap((t) => t.members ?? []);
    const anyoneIdle =
      (!!idleSession && members.some((m) => sessionOf(m) === idleSession || m.sessionName === idleSession)) || members.some((m) => isMemberIdle(m));

    const decision = decideTriage({
      enabled: settings.enabled,
      driver: driver?.session ?? null,
      trigger,
      now: nowMs,
      candidateCount: selection.candidates.length,
      liveTriage: !!live,
      lastTriageAt: ps.lastTriageAt,
      anyoneIdle,
      spentTodayUsd: spent,
      dailyBudgetUsd: settings.dailyBudgetUsd,
    });
    if (decision.action === 'skip' || !driver) {
      this.logger.debug('Ticket autopilot: no triage', { projectId: project.id, trigger, decision });
      await this.saveState();
      return { projectId: project.id, decision };
    }

    const inFlight = inFlightByAssignee(tickets);
    const seen = new Set<string>();
    const roster = teams.flatMap((t) =>
      (t.members ?? [])
        .filter((m) => {
          const s = sessionOf(m);
          if (!s || seen.has(s)) return false;
          seen.add(s);
          return true;
        })
        .map((m) => ({ team: t, m })),
    );
    const roleLines = await this.roleDescriptions(roster.map(({ m }) => m.role));
    const briefMembers: TriageBriefMember[] = roster.map(({ team: t, m }) => {
      const session = sessionOf(m);
      // Stopped (idle-stopped, suspended) is "available — started when
      // assigned", never "busy"; its in-progress count is its real one.
      const availability = session === idleSession && memberAvailability(m) !== 'stopped' ? 'idle' : memberAvailability(m);
      return {
        session,
        name: m.name,
        role: m.role,
        lead: isTeamLead(t, m),
        availability,
        responsibility: memberResponsibility(m, roleLines.get(String(m.role ?? ''))),
        inFlight: inFlight.get(session) ?? 0,
      };
    });
    const brief = buildTriageBrief({
      project: { id: project.id, name: project.name },
      candidates: selection.candidates,
      more: selection.more,
      members: briefMembers,
      maxInFlightPerMember: settings.maxInFlightPerMember,
      now: nowMs,
    });
    const n = selection.candidates.length;
    const workItem = createWorkItem({
      type: TICKET_AUTOPILOT_CONSTANTS.TRIAGE_WORK_ITEM_TYPE,
      owner: 'team_lead',
      target: driver.session,
      title: `Ticket triage: ${project.name} (${n} ticket${n === 1 ? '' : 's'})`,
      description: `Decide ${n} ticket${n === 1 ? '' : 's'} of ${project.name}: ready + assign, split, ask the owner, or cancel.`,
      briefMarkdown: capBrief(brief),
      metadata: {
        kind: TICKET_AUTOPILOT_CONSTANTS.TRIAGE_METADATA_KIND,
        projectId: project.id,
        projectPath: project.path,
        teamId: driver.teamId,
        requiresVerification: false,
        ticketIds: selection.candidates.map((c) => c.ticket.id),
        trigger,
      },
    });
    workItem.createdAt = now.toISOString();
    workItem.targetSource = 'assigned';
    await this.deps.pool.addToPool(workItem);

    ps.lastTriageAt = nowMs;
    ps.lastTriageWorkItemId = workItem.id;
    const listed: Record<string, ListedTicket> = {};
    const openIds = new Set(tickets.map((t) => t.id));
    for (const [id, entry] of Object.entries(ps.listed ?? {})) if (openIds.has(id)) listed[id] = entry;
    for (const c of selection.candidates) listed[c.ticket.id] = { updatedAt: c.ticket.updatedAt, at: nowMs };
    ps.listed = listed;
    await this.saveState();
    this.logger.info('Ticket autopilot woke the driver to triage', {
      projectId: project.id,
      driver: driver.session,
      trigger,
      tickets: workItem.metadata?.ticketIds,
      workItemId: workItem.id,
    });
    return { projectId: project.id, decision, workItem };
  }

  /**
   * The project's live triage item, if any. A triage item still queued
   * (never picked up) after {@link TICKET_AUTOPILOT_CONSTANTS.TRIAGE_STALE_QUEUED_MS}
   * is cancelled so a fresh one can replace it.
   *
   * @param project - Project
   * @param nowMs - Clock
   * @returns The live item, or null
   */
  private async liveTriageItem(project: Project, nowMs: number): Promise<WorkItem | null> {
    const items = (await this.deps.pool.getAllItems()).filter(
      (wi) =>
        wi.metadata?.kind === TICKET_AUTOPILOT_CONSTANTS.TRIAGE_METADATA_KIND && wi.metadata?.projectId === project.id && LIVE_STATUSES.has(wi.status),
    );
    let live: WorkItem | null = null;
    for (const wi of items) {
      const age = nowMs - (Date.parse(wi.createdAt) || nowMs);
      if (wi.status === 'queued' && age >= TICKET_AUTOPILOT_CONSTANTS.TRIAGE_STALE_QUEUED_MS) {
        await this.deps.pool.cancelQueued(wi.id, 'ticket triage never picked up; replaced by a fresh one').catch(() => undefined);
        this.logger.info('Stale ticket triage cancelled', { projectId: project.id, workItemId: wi.id });
        continue;
      }
      live = wi;
    }
    return live;
  }

  // ---------------------------------------------------------------------------
  // Owner notifications
  // ---------------------------------------------------------------------------

  /**
   * Send the evening digest of the enabled projects when due.
   *
   * @param projects - Enabled projects
   * @returns True when a digest went out
   */
  private async processDigest(projects: Project[]): Promise<boolean> {
    const state = await this.loadState();
    const now = this.now();
    const lists: Array<{ project: Project; tickets: ProjectTicket[] }> = [];
    let latest = 0;
    for (const project of projects) {
      const { tickets } = await this.deps.tickets.list(project.path);
      lists.push({ project, tickets });
      for (const t of tickets) latest = Math.max(latest, Date.parse(t.updatedAt) || 0);
    }
    const decision = decideDigest({ now, lastSentDate: state.digest.lastSentDate, lastSentAt: state.digest.lastSentAt, latestTicketChangeAt: latest });
    if (!decision.send) return false;
    const midnight = localMidnight(now).getTime();
    const sections: DigestProject[] = [];
    for (const { project, tickets } of lists) {
      const waitingOnOwner = tickets.filter((t) => t.status === 'review' || (OPEN_TICKET_STATUSES.has(t.status) && hasNeedsOwnerLabel(t)));
      const links = new Map<string, string>();
      if (this.deps.cardLinkOf) {
        for (const t of waitingOnOwner) {
          const link = await this.deps.cardLinkOf(project.path, t.id).catch(() => null);
          if (link) links.set(t.id, link);
        }
      }
      sections.push({
        name: project.name,
        doneToday: tickets.filter((t) => t.status === 'done' && (Date.parse(t.updatedAt) || 0) >= midnight),
        inProgress: tickets.filter((t) => t.status === 'in_progress'),
        waitingOnOwner,
        ...(links.size > 0 ? { links } : {}),
      });
    }
    const message = buildDigestMessage(sections);
    const ok = message
      ? await this.deps.notifyOwner({ title: 'Tickets today', message, urgent: false }).catch(() => false)
      : true; // nothing worth a message: count the day as done
    if (ok) {
      state.digest = { lastSentDate: localDateKey(now), lastSentAt: now.getTime() };
      await this.saveState();
      if (message) this.logger.info('Ticket digest sent', { projects: sections.length });
    }
    return ok && !!message;
  }

  /**
   * Tell the owner once per day that a project's autopilot paused on its budget.
   *
   * @param project - Project
   * @param ps - Its bookkeeping
   * @param spent - Spent today
   * @param budget - Daily budget
   * @param now - Clock
   */
  private async noticeBudgetPaused(project: Project, ps: ProjectState, spent: number, budget: number, now: Date): Promise<void> {
    const today = localDateKey(now);
    if (ps.budgetNoticeDate === today) return;
    const ok = await this.deps
      .notifyOwner({ title: 'Ticket autopilot paused', message: buildBudgetPausedMessage(project.name, spent, budget), urgent: false })
      .catch(() => false);
    if (ok) {
      ps.budgetNoticeDate = today;
      this.logger.info('Ticket autopilot paused on its daily budget', { projectId: project.id, spent, budget });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * The settings view plus live status of a project.
   *
   * @param project - Project
   * @returns Status
   */
  private async statusOf(project: Project): Promise<TicketAutopilotStatus> {
    const settings = resolveTicketAutopilotSettings(project.ticketAutopilot);
    const teams = await this.projectTeams(project);
    const spent = this.spentToday(teams);
    const state = await this.loadState();
    const ps = state.projects[project.id];
    const live = (await this.deps.pool.getAllItems()).some(
      (wi) => wi.metadata?.kind === TICKET_AUTOPILOT_CONSTANTS.TRIAGE_METADATA_KIND && wi.metadata?.projectId === project.id && LIVE_STATUSES.has(wi.status),
    );
    return {
      project: { id: project.id, name: project.name, path: project.path },
      settings,
      driver: this.resolveDriver(settings, teams),
      spentTodayUsd: Math.round(spent * 100) / 100,
      pausedForToday: settings.enabled && spent >= settings.dailyBudgetUsd,
      triageInFlight: live,
      lastTriageAt: ps?.lastTriageAt ? new Date(ps.lastTriageAt).toISOString() : null,
    };
  }

  /**
   * Refuse anyone but the owner and the orchestrator.
   *
   * @param caller - Caller
   * @param project - Project
   * @throws ProjectTicketError(403)
   */
  private async requireOwnerOrOrc(caller: ProjectTicketCaller, project: Project): Promise<void> {
    const { access } = await this.deps.workflow.accessOf(caller, project);
    if (access !== 'owner' && access !== 'orchestrator') {
      throw new ProjectTicketError(403, 'Only the owner or the orchestrator can see or change the ticket autopilot');
    }
  }

  /**
   * Non-archived teams working on a project.
   *
   * @param project - Project
   * @returns Teams
   */
  private async projectTeams(project: Project): Promise<Team[]> {
    return (await this.deps.directory.getTeams()).filter((t) => !t.archived && (t.projectIds ?? []).includes(project.id));
  }

  /**
   * A lead of one of the teams running as `session`.
   *
   * @param teams - Project teams
   * @param session - Session
   * @returns The team id, or null
   */
  private findLead(teams: Team[], session: string): string | null {
    for (const team of teams) {
      for (const m of team.members ?? []) {
        if ((m.sessionName === session || m.agentId === session) && isTeamLead(team, m)) return team.id;
      }
    }
    return null;
  }

  /**
   * Who triages. By default the lead of the project's (first) team by the
   * team-lead rule (`utils/team.utils`); the `driver` setting is an optional
   * override and must itself be a lead by that rule.
   *
   * @param settings - Resolved settings
   * @param teams - Project teams
   * @returns Driver, or null when there is none
   */
  private resolveDriver(settings: ResolvedTicketAutopilotSettings, teams: Team[]): ResolvedDriver | null {
    if (settings.driver) {
      const teamId = this.findLead(teams, settings.driver);
      return teamId ? { session: settings.driver, teamId, source: 'setting' } : null;
    }
    for (const team of teams) {
      const lead = getTeamLeads(team).find((m) => sessionOf(m));
      if (lead) return { session: sessionOf(lead), teamId: team.id, source: 'team_lead' };
    }
    return null;
  }

  /**
   * Role descriptions for the brief's role lines (best-effort; a failed
   * lookup just falls back to the built-in lines).
   *
   * @param roles - Roles of the members listed
   * @returns Role → description
   */
  private async roleDescriptions(roles: Array<string | undefined>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const lookup = this.deps.roleDescription;
    if (!lookup) return out;
    for (const role of new Set(roles.filter((r): r is string => !!r))) {
      const text = await lookup(role).catch(() => null);
      if (text) out.set(role, text);
    }
    return out;
  }

  /**
   * USD spent since local midnight by the agents of the given teams.
   *
   * @param teams - Teams
   * @returns Spend
   */
  private spentToday(teams: Team[]): number {
    const since = localMidnight(this.now());
    const sessions = new Set(teams.flatMap((t) => (t.members ?? []).map(sessionOf)).filter((s) => !!s));
    let total = 0;
    for (const s of sessions) {
      try {
        total += this.deps.ledger.getSessionUsageSince(s, since).cost;
      } catch {
        // A ledger read failure never blocks the autopilot on its own.
      }
    }
    return total;
  }

  /**
   * Run `fn` after every evaluation queued before it.
   *
   * @param fn - Work
   * @returns Its result
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Load the bookkeeping (once per process).
   *
   * @returns State
   */
  private async loadState(): Promise<AutopilotState> {
    if (this.state) return this.state;
    const raw = await safeReadJson<Partial<AutopilotState>>(this.deps.stateFile, {});
    const sentKeys = raw.questions?.sentKeys;
    this.state = {
      projects: raw.projects && typeof raw.projects === 'object' ? raw.projects : {},
      questions: { lastSentAt: raw.questions?.lastSentAt, sentKeys: Array.isArray(sentKeys) ? sentKeys : [] },
      digest: raw.digest && typeof raw.digest === 'object' ? raw.digest : {},
    };
    return this.state;
  }

  /** Persist the bookkeeping (best-effort). */
  private async saveState(): Promise<void> {
    if (!this.state) return;
    try {
      await atomicWriteJson(this.deps.stateFile, this.state);
    } catch (err) {
      this.logger.warn('Could not save ticket autopilot state', { file: path.basename(this.deps.stateFile), error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * Keep a brief within the WorkItem brief budget.
 *
 * @param text - Brief
 * @returns Brief within {@link MAX_BRIEF_MARKDOWN_BYTES}
 */
function capBrief(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_BRIEF_MARKDOWN_BYTES) return text;
  let out = text.slice(0, MAX_BRIEF_MARKDOWN_BYTES);
  while (Buffer.byteLength(out, 'utf8') > MAX_BRIEF_MARKDOWN_BYTES - 64) out = out.slice(0, -64);
  return `${out}\n\n…(truncated — list the tickets with project-tickets)`;
}
