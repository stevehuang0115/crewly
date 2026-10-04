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
 * - when the project has a goal but nothing is left to triage and someone is
 *   idle, the driver is woken with ONE `goal_replan` WorkItem to open the
 *   next tickets toward the goal (at most `replansPerDay` a day, same budget
 *   and in-progress brakes; specs/2026-10-04-autopilot-goal-replan.md);
 * - owner questions are decision cards (specs/2026-10-01-decision-cards.md),
 *   posted by the asking agent in the ticket's thread; the owner gets one
 *   evening digest (skipped when nothing changed) that links to open cards;
 * - a speed mode (Rush / Normal / Chill, specs/2026-10-04-autopilot-speed-modes.md)
 *   sets the replan gap and daily cap, the retry after an empty replan, the
 *   driver's self-review cadence and the default budget; tickets a replan
 *   opens must name the goal metric they move; and why the autopilot stopped
 *   (paused / budget / system error / waiting on the owner / no ideas) is
 *   traced and shown in the status and the digest.
 *
 * The approval boundary is unchanged: the autopilot only wakes the lead and
 * talks to the owner; it never makes a ticket ready or starts work itself.
 *
 * @module services/project-tickets/ticket-autopilot.service
 */

import * as path from 'path';
import { ORCHESTRATOR_SESSION_NAME, TICKET_AUTOPILOT_CONSTANTS, USAGE_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import type { Project, Team, TeamMember } from '../../types/index.js';
import { createWorkItem, MAX_BRIEF_MARKDOWN_BYTES, type WorkItem, type WorkItemStatus } from '../../types/v2/work-item.types.js';
import type { ProjectTicket, ProjectTicketList } from '../../types/project-ticket.types.js';
import {
  applyTicketAutopilotInput,
  legacyBudgetTokens,
  resolveTicketAutopilotSettings,
  type AutopilotSpeedMode,
  type ResolvedTicketAutopilotSettings,
  type TicketAutopilotSettingsInput,
} from '../../types/ticket-autopilot.types.js';
import { ProjectTicketError } from './project-ticket.service.js';
import { getTeamLeads } from '../../utils/team.utils.js';
import { isTeamPausedNow } from '../team/team-pause.registry.js';
import type { CreateProjectTicketInput } from './project-ticket.service.js';
import {
  isTeamLead,
  type ProjectTicketAccess,
  type ProjectTicketAutopilotPolicy,
  type ProjectTicketCaller,
} from './project-ticket-workflow.service.js';
import {
  OPEN_TICKET_STATUSES,
  classifyStopReason,
  closedTicketsSince,
  decideDigest,
  decideReplan,
  decideSelfReview,
  decideTriage,
  nextReplanBackoff,
  replanBackoffHolds,
  replanBackoffState,
  ticketMetricRef,
  type AutopilotStopReason,
  hasNeedsOwnerLabel,
  inFlightByAssignee,
  isMemberIdle,
  localDateKey,
  memberAvailability,
  memberResponsibility,
  localMidnight,
  selectTriageCandidates,
  type ListedTicket,
  type ReplanBackoff,
  type ReplanDecision,
  type TriageDecision,
  type TriageTrigger,
} from './ticket-autopilot-decision.js';
import {
  buildBudgetPausedMessage,
  buildDigestMessage,
  buildReplanBrief,
  buildSelfReviewBrief,
  buildTriageBrief,
  REPLAN_ASK,
  replanMetricRejection,
  STOP_REASON_WORDS,
  type DigestProject,
  type SelfReviewRecord,
  type TriageBriefMember,
} from './ticket-autopilot-messages.js';
import type { ProjectGoal, ReplanExperiment } from './ticket-autopilot-goal.js';
import { autopilotRunTrace, startReplanTrace, startTriageTrace, traceAutopilotAction, type AutopilotTicketChange, createAutopilotTicketListener } from './ticket-autopilot-trace.js';
import {
  computeAutopilotStats,
  dayEndMs,
  daysBetween,
  dayStartMs,
  rangeDays,
  type AutopilotStats,
  type LedgerDay,
  type StatsTrace,
} from './ticket-autopilot-stats.js';
import {
  buildRetroBrief,
  duplicateOf,
  renderRetroMarkdown,
  RetroInputError,
  validateRetroInput,
  type RetroInput,
} from './ticket-autopilot-retro.js';
import { getTraceStore } from '../trace/trace-store.js';
import { clampStallMinutes, defaultStallMinutes } from '../trace/trace-metrics.js';
import type { TraceEvent, TraceIndexEntry, TraceRoot } from '../trace/trace.types.js';
import type { TraceListFilter } from '../trace/trace-store.js';
import type { OwnerDecision } from '../../types/decision.types.js';

/** Skip reasons in words (run trace). */
const SKIP_WORDS: Record<string, string> = {
  no_driver: 'no team lead to drive it',
  budget_reached: 'daily budget reached',
  triage_in_flight: 'a triage is still open',
  replan_in_flight: 'a goal replan is still open',
  nothing_to_triage: 'nothing to triage',
  nobody_idle: 'nobody on the team is idle',
  too_soon: 'too soon after the last triage',
};

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
  /** Release a running item's claim (used to expire a goal replan; absent = not expired in the pool) */
  releaseClaim?(workItemId: string, endReason: string): Promise<void>;
  /** Guarded status change (used to cancel an expired goal replan that is not queued) */
  transitionStatus?(
    workItemId: string,
    status: WorkItemStatus,
    actorRole: 'system',
    mutator?: (wi: WorkItem) => void,
    reason?: string,
  ): Promise<WorkItem | null>;
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
  /** Ticket writes that changed status / labels (traced while the autopilot runs) */
  onChange?(listener: (change: AutopilotTicketChange) => void): () => void;
}

/** Project resolution + caller access (the ticket workflow). */
export interface TicketAutopilotWorkflow {
  resolveProject(ref: string): Promise<Project>;
  accessOf(caller: ProjectTicketCaller, project: Project): Promise<{ access: ProjectTicketAccess }>;
  setAutopilotPolicy?(policy: ProjectTicketAutopilotPolicy | null): void;
}

/** Token ledger (see TokenUsageService.getSessionUsageSince; `totalTokens` is the token unit). */
export interface TicketAutopilotLedger {
  getSessionUsageSince(sessionName: string, since: Date, until?: Date): { totalTokens: number; cost?: number };
}

/** Reads the project's tagged traces (the stats and the runs list). */
export interface AutopilotTraceReader {
  listTagged(filter: TraceListFilter & { autopilotProjectId: string }): TraceIndexEntry[];
  readAll(traceId: string): Promise<{ root?: TraceRoot; events: TraceEvent[] } | null>;
}

/** What the daily retro does outside the autopilot (specs/2026-10-03-autopilot-experiments.md §4). */
export interface AutopilotRetroDeps {
  /** Write a page into the project's wiki vault; false = not written (no vault) */
  writeWiki(projectPath: string, relativePath: string, markdown: string, by: string): Promise<boolean>;
  /** The project harness gaps are filed on, or null when there is none */
  harnessProject(): Promise<Project | null>;
  /** Create a backlog ticket (as the harness) */
  createTicket(project: Project, input: { title: string; description: string; labels: string[]; source: string }): Promise<{ id: string; title: string }>;
  /**
   * Apply the owner's answer to a filed gap ticket. Approve: drop the
   * `retro-pending` hold and make it ready. Otherwise: cancel it, but only
   * while it has not started (backlog / ready); started work is left alone.
   *
   * @returns What happened to the ticket
   */
  applyGapDecision(projectPath: string, id: string, approve: boolean, note: string): Promise<'ready' | 'cancelled' | 'left'>;
  /** Ask the owner ONE system decision (Approve / Skip) */
  askOwner(input: { key: string; title: string; question: string; body: string[]; approveLabel: string; skipLabel: string; deadline: Date }): Promise<{ id: string }>;
}

/** What a retro submission did. */
export interface RetroResult {
  day: string;
  wikiPath: string;
  written: boolean;
  filed: Array<{ id: string; title: string }>;
  duplicates: Array<{ title: string; duplicateOf: string }>;
  /** Gaps over the day's cap (not filed) */
  overCap: string[];
  decisionId: string | null;
  /** Tickets cancelled because the owner card could not be asked */
  unasked?: string[];
}

/** One day of the runs list. */
export interface AutopilotRunDay {
  day: string;
  runTraceId: string | null;
  traces: Array<{ traceId: string; kind: string; summary: string; ticketId?: string; labels: string[]; updatedAt: string }>;
}

/** Usage boosts in force for a set of teams (the token cap service). */
export type TicketAutopilotBoostSource = (teamIds: string[]) => { extra: number; unlimited: boolean };

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
  /**
   * Boosts on the project's teams (team or everyone boosts). The daily
   * budget honours them: +X raises it for the day, unlimited lifts it.
   */
  boosts?: TicketAutopilotBoostSource;
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
  /** Tagged traces for the stats (default: the process trace store + analysis) */
  traces?: AutopilotTraceReader;
  /** Whether an autopilot experiment on the project is running (turns the retro on by default) */
  runningExperiment?: (projectId: string) => Promise<boolean>;
  /** Retro side effects; absent = no retro is scheduled and submits answer 503 */
  retro?: AutopilotRetroDeps;
  /**
   * The project's active goal (goals log / active project OKRs) for the goal
   * replan (specs/2026-10-04-autopilot-goal-replan.md). Absent = no goal: the
   * autopilot never replans.
   */
  goalOf?: (project: Project, now: Date) => Promise<ProjectGoal | null>;
  /**
   * When the project's goal / OKRs last changed (file times only, no reads);
   * a change after a replan backoff started lifts it. Absent = only a new
   * ticket lifts a backoff.
   */
  goalChangedAt?: (project: Project) => Promise<number | null>;
  /** Open experiment cards of the project, for the replan brief (absent = none) */
  openExperiments?: (project: Project) => Promise<ReplanExperiment[]>;
  /**
   * The "Team leads" block of the evening digest: lead share of team tokens,
   * nudges, kept work (crewly#1083). Absent or null = no block.
   */
  leadShareDigest?: (now: Date) => Promise<string | null>;
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
  /** When the autopilot paused on its budget (ms), until it resumes (traced) */
  budgetPausedAt?: number;
  /** Skip reasons already traced today (one event per reason per day) */
  skips?: { day: string; reasons: string[] };
  /** Tickets already traced as listed in a triage today */
  triaged?: { day: string; ids: string[] };
  /** Reviewed day of the last retro scheduled */
  retroScheduledFor?: string;
  /** Retro scheduling reads keep failing: next try (ms) and how many failed */
  retroRetryAt?: number;
  retroFailures?: number;
  retroWorkItemId?: string;
  /**
   * Goal replans of the local day (the daily limit) and the last one;
   * `assessed` once its outcome (tickets opened or not) set the backoff
   */
  replans?: { day: string; count: number; lastAt?: number; lastWorkItemId?: string; assessed?: boolean };
  /** Backing off after replans that opened no tickets */
  replanBackoff?: ReplanBackoff;
  /** Why the autopilot stopped (traced on change), and since when (ms) */
  stop?: { reason: AutopilotStopReason; since: number };
  /** Self-reviews filed (newest last, capped) */
  selfReviews?: SelfReviewRecord[];
  /**
   * The last self-review asked: when, its WorkItem, and what the project
   * looked like then (latest ticket change, stop reason) — "nothing
   * changed" is measured against it
   */
  selfReviewAsk?: { at: number; workItemId: string; ticketsAt: number; stopReason: AutopilotStopReason | null };
}

/** Retro bookkeeping across projects. */
interface RetroState {
  /** Harness-gap tickets filed per local day (the cap) */
  gapDays: Record<string, number>;
  /** Gaps filed earlier (dedupe) */
  gaps: Array<{ title: string; at: number }>;
  /** Open approval cards → the tickets they decide */
  decisions: Record<string, { projectId: string; projectPath: string; ticketIds: string[] }>;
}

/** Everything the autopilot remembers across restarts. */
interface AutopilotState {
  projects: Record<string, ProjectState>;
  questions: { lastSentAt?: number; sentKeys: string[] };
  digest: { lastSentDate?: string; lastSentAt?: number };
  retro: RetroState;
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
  /** Tokens used today by the project's team agents */
  usedTodayTokens: number;
  /** Today's budget with boosts (null = unlimited today) */
  budgetTodayTokens: number | null;
  /** Boost tokens added today */
  boostTokens: number;
  pausedForToday: boolean;
  triageInFlight: boolean;
  lastTriageAt: string | null;
  /** A goal replan of the project is live */
  replanInFlight: boolean;
  /** Goal replans created today */
  replansToday: number;
  lastReplanAt: string | null;
  /** First day replans may run again while backing off after empty replans (null = not backing off) */
  replanBackoffUntil: string | null;
  /** When replans may run again while backing off (ISO; null = not backing off) */
  replanBackoffUntilAt: string | null;
  /** Whether the daily retro runs (the setting, else on while an autopilot experiment runs) */
  retroOn: boolean;
  /** Speed mode (also in `settings.speedMode`) */
  speedMode: AutopilotSpeedMode;
  /** Why the autopilot is not producing work (null = running, or between replans) */
  stopReason: AutopilotStopReason | null;
  /** The stop reason in words */
  stopReasonText: string | null;
  /** Since when it has been stopped for that reason (ISO) */
  stoppedSince: string | null;
  /** The driver's latest self-review */
  lastSelfReview: SelfReviewRecord | null;
  /** When the next self-review is due (ISO; asked then only if something changed or someone is idle) */
  nextSelfReviewAt: string | null;
}

/** A self-review submission (`POST …/self-review`). */
export interface SelfReviewInput {
  gap: string;
  moved?: string;
  nextBet: string;
}

/** Outcome of one project evaluation. */
export interface ProjectEvaluation {
  projectId: string;
  decision: TriageDecision;
  /**
   * The goal-replan decision, when triage found nothing to triage and the
   * project has a goal (absent otherwise: the evaluation is as before)
   */
  replan?: ReplanDecision;
  /** The triage WorkItem created (decision `triage`), or the replan WorkItem (replan `replan`) */
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
  /** Unsubscribe of the ticket-change tracing listener */
  private unlisten: (() => void) | null = null;
  /** Serialises retro submissions */
  private retroChain: Promise<unknown> = Promise.resolve();

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
    // Ticket status / label changes go into the ticket's autopilot trace
    // (specs/2026-10-03-autopilot-experiments.md §1).
    if (!this.unlisten && this.deps.tickets.onChange) {
      this.unlisten = this.deps.tickets.onChange(createAutopilotTicketListener(() => this.deps.directory.getProjects(), this.now));
    }
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
    this.unlisten?.();
    this.unlisten = null;
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
        const teams = await this.projectTeams(project, { includePaused: true });
        return this.usedToday(teams) >= this.budgetToday(settings, teams).tokens;
      },
      maxInFlightPerMember: async (project) => {
        const settings = resolveTicketAutopilotSettings(project.ticketAutopilot);
        return settings.enabled ? settings.maxInFlightPerMember : null;
      },
      checkCreate: (project, caller, input) => this.checkReplanTicket(project, caller, input),
    };
  }

  /**
   * The metric rule of replan tickets (specs/2026-10-04-autopilot-speed-modes.md §3):
   * a ticket created by the driver of a live goal replan of the project must
   * name the goal metric it moves. The owner's, the orchestrator's and any
   * ticket created outside a replan are never checked.
   *
   * @param project - Project
   * @param caller - Who creates the ticket
   * @param input - The create input
   * @returns Why it is refused (sent back to the agent), or null to allow it
   */
  async checkReplanTicket(project: Project, caller: ProjectTicketCaller, input: Pick<CreateProjectTicketInput, 'title' | 'description'> & { metric?: string }): Promise<string | null> {
    if (!caller.session || caller.session === ORCHESTRATOR_SESSION_NAME) return null;
    const settings = resolveTicketAutopilotSettings(project.ticketAutopilot);
    if (!settings.enabled) return null;
    const nowMs = this.now().getTime();
    const ttlMs = settings.replanTtlHours * 60 * 60 * 1000;
    const replan = (await this.deps.pool.getAllItems()).find(
      (wi) =>
        wi.metadata?.kind === TICKET_AUTOPILOT_CONSTANTS.REPLAN_METADATA_KIND &&
        wi.metadata?.projectId === project.id &&
        wi.target === caller.session &&
        LIVE_STATUSES.has(wi.status) &&
        nowMs - (Date.parse(wi.createdAt) || nowMs) < ttlMs,
    );
    if (!replan) return null;
    if (ticketMetricRef(input)) return null;
    traceAutopilotAction(project, 'replan_ticket_rejected', {
      summary: `${project.name}: a replan ticket without a goal metric was refused ("${String(input.title ?? '').slice(0, 80)}")`,
      outcome: 'blocked',
      workItemId: replan.id,
      session: caller.session,
      data: { title: String(input.title ?? '').slice(0, 140) },
      alsoTraceId: replan.traceId ?? null,
      now: this.now(),
    });
    return replanMetricRejection(String(input.title ?? ''), project.name);
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
   * @param input - `enabled`, `driver`, `dailyBudgetTokens`, `maxInFlightPerMember` (null resets one)
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
    const before = resolveTicketAutopilotSettings(project.ticketAutopilot);
    const after = resolveTicketAutopilotSettings(result.settings);
    if (before.speedMode !== after.speedMode) await this.onSpeedModeChanged(updated, before.speedMode, after, caller);
    return this.statusOf(updated);
  }

  /**
   * A project's speed mode changed: re-time a backoff that still holds to the
   * new mode's retry (switching to Rush must not wait out Normal's "next
   * day"), and trace the change.
   *
   * @param project - The saved project
   * @param from - Previous mode
   * @param settings - New resolved settings
   * @param caller - Who changed it
   */
  private async onSpeedModeChanged(project: Project, from: AutopilotSpeedMode, settings: ResolvedTicketAutopilotSettings, caller: ProjectTicketCaller): Promise<void> {
    const state = await this.loadState();
    const ps = state.projects[project.id];
    const now = this.now();
    const backoff = ps?.replanBackoff;
    if (ps && backoff && replanBackoffHolds(backoff, now.getTime(), localDateKey(now))) {
      const retry = settings.emptyReplanRetry;
      let resumeAt: number;
      if (retry.unit === 'hours') resumeAt = backoff.since + retry.amount * 60 * 60 * 1000;
      else {
        const d = new Date(backoff.since);
        resumeAt = new Date(d.getFullYear(), d.getMonth(), d.getDate() + Math.max(1, retry.amount), 0, 0, 0, 0).getTime();
      }
      ps.replanBackoff = { ...backoff, resumeAt, resumeDay: localDateKey(new Date(resumeAt)) };
      await this.saveState();
    }
    traceAutopilotAction(project, 'mode_changed', {
      summary: `${project.name}: autopilot speed ${from} → ${settings.speedMode}`,
      outcome: 'ok',
      ...(caller.session ? { session: caller.session, actor: { kind: 'agent' as const, session: caller.session } } : { actor: { kind: 'owner' as const } }),
      data: {
        from,
        to: settings.speedMode,
        replansPerDay: settings.replansPerDay,
        replanMinGapMs: settings.replanMinGapMs,
        selfReviewEveryMs: settings.selfReviewEveryMs,
        dailyBudgetTokens: settings.dailyBudgetTokens,
        budgetSource: settings.budgetSource,
      },
      now,
    });
    this.logger.info('Ticket autopilot speed mode changed', { projectId: project.id, from, to: settings.speedMode, by: caller.session ?? 'owner' });
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
        await this.processStopReasons(projects).catch((err) =>
          this.logger.warn('Autopilot stop-reason pass failed', { error: err instanceof Error ? err.message : String(err) }),
        );
        await this.processSelfReviews(projects).catch((err) =>
          this.logger.warn('Autopilot self-review pass failed', { error: err instanceof Error ? err.message : String(err) }),
        );
        await this.processDigest(projects).catch((err) =>
          this.logger.warn('Ticket digest pass failed', { error: err instanceof Error ? err.message : String(err) }),
        );
        await this.processRetros(projects).catch((err) =>
          this.logger.warn('Autopilot retro pass failed', { error: err instanceof Error ? err.message : String(err) }),
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
    const spendTeams = await this.projectTeams(project, { includePaused: true });
    const spent = this.usedToday(spendTeams);
    const budget = this.budgetToday(settings, spendTeams).tokens;

    if (settings.enabled && spent >= budget) await this.noticeBudgetPaused(project, ps, spent, budget, now, teams[0]?.name);
    this.traceBudgetState(project, ps, settings.enabled && spent >= budget, spent, budget, now);

    const { tickets } = await this.deps.tickets.list(project.path);
    const live = await this.liveItem(project, nowMs, TICKET_AUTOPILOT_CONSTANTS.TRIAGE_METADATA_KIND);
    const liveReplan = await this.liveItem(project, nowMs, TICKET_AUTOPILOT_CONSTANTS.REPLAN_METADATA_KIND, settings.replanTtlHours);
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
      ...(liveReplan ? { liveReplanAt: Date.parse(liveReplan.createdAt) || nowMs } : {}),
      lastTriageAt: ps.lastTriageAt,
      anyoneIdle,
      usedTodayTokens: spent,
      dailyBudgetTokens: budget,
    });
    if (decision.action === 'skip' || !driver) {
      // Nothing to triage: a project with a goal may wake its driver to plan
      // the next tickets instead (specs/2026-10-04-autopilot-goal-replan.md).
      if (decision.action === 'skip' && decision.reason === 'nothing_to_triage' && driver) {
        const replan = await this.evaluateReplan(project, {
          settings,
          ps,
          driver,
          trigger,
          now,
          tickets,
          teams,
          idleSession,
          spent,
          budget,
          liveTriage: !!live,
          liveReplanId: liveReplan?.id ?? null,
          candidateCount: selection.candidates.length,
          anyoneIdle,
        });
        if (replan?.workItem) return { projectId: project.id, decision, replan: replan.decision, workItem: replan.workItem };
        this.logger.debug('Ticket autopilot: no triage', { projectId: project.id, trigger, decision, replan: replan?.decision });
        this.traceSkip(project, ps, decision.reason, trigger, selection.candidates.length, now);
        await this.saveState();
        return { projectId: project.id, decision, ...(replan ? { replan: replan.decision } : {}) };
      }
      this.logger.debug('Ticket autopilot: no triage', { projectId: project.id, trigger, decision });
      if (decision.action === 'skip') this.traceSkip(project, ps, decision.reason, trigger, selection.candidates.length, now);
      await this.saveState();
      return { projectId: project.id, decision };
    }

    const briefMembers = await this.briefMembers(teams, tickets, idleSession);
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
    // The triage turn runs in its own trace (tagged with the project and day),
    // so its calls and usage never eat the run trace's event budget.
    autopilotRunTrace(project, now);
    const triageTrace = startTriageTrace(project, n, now);
    if (triageTrace) workItem.traceId = triageTrace;
    await this.deps.pool.addToPool(workItem);
    this.traceTriage(project, ps, workItem, driver.session, trigger, selection.candidates.map((c) => c.ticket), now);

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
   * Evaluate a goal replan for a project with nothing to triage and, when
   * {@link decideReplan} says so, wake the driver with ONE `goal_replan`
   * WorkItem: the goal, the tickets closed lately, open experiment cards and
   * the ask. The driver opens the tickets; the autopilot never makes them
   * ready or starts work.
   *
   * @param project - Project
   * @param c - The evaluation's state
   * @returns The decision and the WorkItem created, or null when the project has no goal (nothing changes)
   */
  private async evaluateReplan(
    project: Project,
    c: {
      settings: ResolvedTicketAutopilotSettings;
      ps: ProjectState;
      driver: ResolvedDriver;
      trigger: TriageTrigger;
      now: Date;
      tickets: ProjectTicket[];
      teams: Team[];
      idleSession?: string;
      spent: number;
      budget: number;
      liveTriage: boolean;
      /** The live (not expired) replan, if any */
      liveReplanId: string | null;
      candidateCount: number;
      anyoneIdle: boolean;
    },
  ): Promise<{ decision: ReplanDecision; workItem?: WorkItem } | null> {
    const C = TICKET_AUTOPILOT_CONSTANTS;
    // No goal reader: never replans; the evaluation is as before.
    if (!this.deps.goalOf) return null;

    const nowMs = c.now.getTime();
    const today = localDateKey(c.now);
    const inFlight = inFlightByAssignee(c.tickets);
    const members = c.teams.flatMap((t) => t.members ?? []);
    const isIdle = (m: TeamMember): boolean =>
      isMemberIdle(m) || (!!c.idleSession && (sessionOf(m) === c.idleSession || m.sessionName === c.idleSession));
    const held = (m: TeamMember): number => Math.max(inFlight.get(sessionOf(m)) ?? 0, m.sessionName ? inFlight.get(m.sessionName) ?? 0 : 0, m.agentId ? inFlight.get(m.agentId) ?? 0 : 0);
    const idleWithRoom = members.some((m) => isIdle(m) && held(m) < c.settings.maxInFlightPerMember);
    const replansToday = c.ps.replans?.day === today ? c.ps.replans.count : 0;

    // The last replan is over: did it open tickets? None → wait for the mode's retry.
    this.assessLastReplan(project, c.ps, c.tickets, c.liveReplanId, nowMs, c.settings.emptyReplanRetry);

    // Cheap gates first (in-memory state only); the goal is read last.
    const gates = {
      enabled: c.settings.enabled,
      driver: c.driver.session,
      maxReplansPerDay: c.settings.replansPerDay,
      replansToday,
      // The speed mode's gap counts from the last replan, across days.
      ...(c.ps.replans?.lastAt !== undefined ? { lastReplanAt: c.ps.replans.lastAt } : {}),
      minGapMs: c.settings.replanMinGapMs,
      now: nowMs,
      usedTodayTokens: c.spent,
      dailyBudgetTokens: c.budget,
      liveTriage: c.liveTriage,
      liveReplan: !!c.liveReplanId,
      candidateCount: c.candidateCount,
      anyoneIdle: c.anyoneIdle,
      idleWithRoom,
    };
    const skip = (d: ReplanDecision): { decision: ReplanDecision } => {
      this.logger.debug('Ticket autopilot: no goal replan', { projectId: project.id, trigger: c.trigger, decision: d });
      return { decision: d };
    };
    const pre = decideReplan({ ...gates, backedOff: false, hasGoal: true });
    if (pre.action === 'skip') return skip(pre);

    // Backoff after empty replans: lifted by a new ticket or a goal / OKR
    // change (file times only).
    let backedOff = false;
    if (c.ps.replanBackoff) {
      const changedAt = this.deps.goalChangedAt ? await this.deps.goalChangedAt(project).catch(() => null) : null;
      const state = replanBackoffState(c.ps.replanBackoff, { today, tickets: c.tickets, goalChangedAt: changedAt, now: nowMs });
      if (state === 'lifted') {
        this.logger.info('Goal replan backoff lifted (new ticket or goal change)', { projectId: project.id, streak: c.ps.replanBackoff.streak });
        delete c.ps.replanBackoff;
        await this.saveState();
      }
      backedOff = state === 'holds';
    }
    if (backedOff) return skip(decideReplan({ ...gates, backedOff, hasGoal: true }));

    const goal = await this.deps.goalOf(project, c.now).catch((err) => {
      this.logger.warn('Could not read the project goal (no replan)', { projectId: project.id, error: err instanceof Error ? err.message : String(err) });
      return null;
    });
    // No goal: the evaluation is what it was before goal replans.
    if (!goal || !goal.text.trim()) return null;
    const decision = decideReplan({ ...gates, backedOff, hasGoal: true });
    if (decision.action === 'skip') return skip(decision);

    const closed = closedTicketsSince(c.tickets, nowMs - C.REPLAN_CLOSED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000, C.REPLAN_MAX_CLOSED_TICKETS);
    const experiments = this.deps.openExperiments ? await this.deps.openExperiments(project).catch(() => []) : [];
    const brief = buildReplanBrief({
      project: { id: project.id, name: project.name },
      goal: goal.text,
      closed,
      lookbackDays: C.REPLAN_CLOSED_LOOKBACK_DAYS,
      experiments,
      members: await this.briefMembers(c.teams, c.tickets, c.idleSession),
      maxInFlightPerMember: c.settings.maxInFlightPerMember,
      now: nowMs,
      lastSelfReview: c.ps.selfReviews?.[c.ps.selfReviews.length - 1] ?? null,
    });
    const workItem = createWorkItem({
      type: C.REPLAN_WORK_ITEM_TYPE,
      owner: 'team_lead',
      target: c.driver.session,
      title: `Plan next tickets toward the goal: ${project.name}`,
      description: `Nothing is left to triage on ${project.name}. ${REPLAN_ASK}`,
      briefMarkdown: capBrief(brief),
      metadata: {
        kind: C.REPLAN_METADATA_KIND,
        projectId: project.id,
        projectPath: project.path,
        teamId: c.driver.teamId,
        requiresVerification: false,
        trigger: c.trigger,
        goalSources: goal.sources,
        closedTicketIds: closed.map((t) => t.id),
        experimentIds: experiments.map((e) => e.id),
      },
    });
    workItem.createdAt = c.now.toISOString();
    workItem.targetSource = 'assigned';
    const replanTrace = startReplanTrace(project, c.now);
    if (replanTrace) workItem.traceId = replanTrace;
    await this.deps.pool.addToPool(workItem);

    const count = replansToday + 1;
    c.ps.replans = { day: today, count, lastAt: nowMs, lastWorkItemId: workItem.id, assessed: false };
    // A replan is autopilot work: it starts the day's run trace. Not an owner touch.
    traceAutopilotAction(project, 'replan', {
      summary: `${project.name}: ${c.driver.session} woken to plan the next tickets toward the goal (nothing left to triage)`,
      outcome: 'queued',
      workItemId: workItem.id,
      session: c.driver.session,
      data: {
        trigger: c.trigger,
        goalSources: goal.sources.join(','),
        closed: closed.length,
        experiments: experiments.length,
        replansToday: count,
        replansPerDay: c.settings.replansPerDay,
        speedMode: c.settings.speedMode,
      },
      alsoTraceId: workItem.traceId ?? null,
      now: c.now,
    });
    await this.saveState();
    this.logger.info('Ticket autopilot woke the driver to plan toward the goal', {
      projectId: project.id,
      driver: c.driver.session,
      trigger: c.trigger,
      workItemId: workItem.id,
      replansToday: count,
    });
    return { decision, workItem };
  }

  /**
   * The team section of a brief: every member once, with availability,
   * role line and in-progress count.
   *
   * @param teams - Project teams
   * @param tickets - Project tickets (in-progress counts)
   * @param idleSession - The member that just went idle
   * @returns Brief members
   */
  private async briefMembers(teams: Team[], tickets: ProjectTicket[], idleSession?: string): Promise<TriageBriefMember[]> {
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
    return roster.map(({ team: t, m }) => {
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
  }

  /**
   * Record the outcome of the last goal replan once it is no longer live:
   * a ticket created since it was queued clears the backoff; none ("there
   * are none") waits for the speed mode's retry (Rush 1 h, Normal the next
   * day, Chill a week).
   *
   * @param project - Project
   * @param ps - Its bookkeeping
   * @param tickets - Its tickets
   * @param liveReplanId - The live replan, if any
   * @param nowMs - Clock
   * @param retry - The speed mode's retry after an empty replan
   */
  private assessLastReplan(
    project: Project,
    ps: ProjectState,
    tickets: ProjectTicket[],
    liveReplanId: string | null,
    nowMs: number,
    retry: { unit: 'hours' | 'days'; amount: number },
  ): void {
    const last = ps.replans;
    if (!last?.lastWorkItemId || last.lastAt === undefined || last.assessed !== false) return;
    if (liveReplanId === last.lastWorkItemId) return;
    const next = nextReplanBackoff({ replanAt: last.lastAt, replanDay: last.day, tickets, previous: ps.replanBackoff, retry, now: nowMs });
    if (next) ps.replanBackoff = next;
    else delete ps.replanBackoff;
    last.assessed = true;
    this.logger.info(next ? 'Goal replan opened no tickets: backing off' : 'Goal replan opened tickets', {
      projectId: project.id,
      workItemId: last.lastWorkItemId,
      ...(next ? { streak: next.streak, resumeDay: next.resumeDay, resumeAt: next.resumeAt } : {}),
    });
  }

  /**
   * Expire a goal replan past its TTL so it cannot hold triage forever:
   * cancelled where the pool allows it (queued / blocked / scheduled,
   * running, proposed / accepted / escalated). One the driver already
   * finished (`done_by_worker`) waits on a verdict the autopilot cannot
   * give; it is only no longer counted as live.
   *
   * @param project - Project
   * @param wi - The replan
   * @param ttlHours - Its TTL
   */
  private async expireReplan(project: Project, wi: WorkItem, ttlHours: number): Promise<void> {
    const reason = `goal replan still open after ${ttlHours}h; expired by the ticket autopilot`;
    const pool = this.deps.pool;
    try {
      if (wi.status === 'queued' || wi.status === 'blocked' || wi.status === 'scheduled') {
        await pool.cancelQueued(wi.id, reason);
      } else if (wi.status === 'running') {
        await pool.releaseClaim?.(wi.id, reason);
        await pool.transitionStatus?.(wi.id, 'cancelled', 'system', undefined, reason);
      } else if (wi.status === 'proposed' || wi.status === 'accepted' || wi.status === 'escalated') {
        await pool.transitionStatus?.(wi.id, 'cancelled', 'system', undefined, reason);
      } else {
        this.logger.debug('Expired goal replan left as is (not cancellable from its status)', { projectId: project.id, workItemId: wi.id, status: wi.status });
        return;
      }
      this.logger.info('Goal replan expired', { projectId: project.id, workItemId: wi.id, status: wi.status, ttlHours });
    } catch (err) {
      // Still expired: it no longer holds triage even if the pool refused.
      this.logger.warn('Could not cancel an expired goal replan (no longer counted as live)', {
        projectId: project.id,
        workItemId: wi.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The project's live autopilot item of a kind (triage or goal replan), if
   * any. A triage still queued (never picked up) after
   * {@link TICKET_AUTOPILOT_CONSTANTS.TRIAGE_STALE_QUEUED_MS} is cancelled so
   * a fresh one can replace it. A replan older than its TTL in any live
   * status is expired ({@link expireReplan}) and not returned.
   *
   * @param project - Project
   * @param nowMs - Clock
   * @param kind - `metadata.kind` (triage or replan)
   * @param replanTtlHours - Replan TTL (replan kind only)
   * @returns The live item, or null
   */
  private async liveItem(project: Project, nowMs: number, kind: string, replanTtlHours?: number): Promise<WorkItem | null> {
    const items = (await this.deps.pool.getAllItems()).filter(
      (wi) => wi.metadata?.kind === kind && wi.metadata?.projectId === project.id && LIVE_STATUSES.has(wi.status),
    );
    const what = kind === TICKET_AUTOPILOT_CONSTANTS.REPLAN_METADATA_KIND ? 'goal replan' : 'ticket triage';
    let live: WorkItem | null = null;
    for (const wi of items) {
      const age = nowMs - (Date.parse(wi.createdAt) || nowMs);
      if (replanTtlHours !== undefined) {
        if (age >= replanTtlHours * 60 * 60 * 1000) {
          await this.expireReplan(project, wi, replanTtlHours);
          continue;
        }
      } else if (wi.status === 'queued' && age >= TICKET_AUTOPILOT_CONSTANTS.TRIAGE_STALE_QUEUED_MS) {
        await this.deps.pool.cancelQueued(wi.id, `${what} never picked up; replaced by a fresh one`).catch(() => undefined);
        this.logger.info(`Stale ${what} cancelled`, { projectId: project.id, workItemId: wi.id });
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
      const ps = state.projects[project.id];
      const review = ps?.selfReviews?.[ps.selfReviews.length - 1] ?? null;
      const freshReview = review && now.getTime() - (Date.parse(review.at) || 0) <= TICKET_AUTOPILOT_CONSTANTS.SELF_REVIEW_DIGEST_MAX_AGE_MS ? review : null;
      sections.push({
        name: project.name,
        doneToday: tickets.filter((t) => t.status === 'done' && (Date.parse(t.updatedAt) || 0) >= midnight),
        inProgress: tickets.filter((t) => t.status === 'in_progress'),
        waitingOnOwner,
        ...(links.size > 0 ? { links } : {}),
        ...(ps?.stop ? { stopReason: ps.stop.reason } : {}),
        ...(freshReview ? { selfReview: freshReview } : {}),
      });
    }
    const leadBlock = this.deps.leadShareDigest ? await this.deps.leadShareDigest(now).catch(() => null) : null;
    const message = buildDigestMessage(sections, leadBlock);
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
   * @param spent - Tokens used today
   * @param budget - Daily budget (tokens, boosts included)
   * @param now - Clock
   * @param teamName - The project's team, for the boost hint
   */
  private async noticeBudgetPaused(project: Project, ps: ProjectState, spent: number, budget: number, now: Date, teamName?: string): Promise<void> {
    const today = localDateKey(now);
    if (ps.budgetNoticeDate === today) return;
    const ok = await this.deps
      .notifyOwner({ title: 'Ticket autopilot paused', message: buildBudgetPausedMessage(project.name, spent, budget, teamName), urgent: false })
      .catch(() => false);
    if (ok) {
      ps.budgetNoticeDate = today;
      this.logger.info('Ticket autopilot paused on its daily budget', { projectId: project.id, spent, budget });
    }
  }

  // ---------------------------------------------------------------------------
  // Tracing (specs/2026-10-03-autopilot-experiments.md §1)
  // ---------------------------------------------------------------------------

  /**
   * Trace the budget brake turning on or off. A pause from an earlier day
   * ends at that day's rollover (the budget resets at midnight).
   *
   * @param project - Project
   * @param ps - Its bookkeeping
   * @param paused - Over the budget now
   * @param spent - Tokens used today
   * @param budget - Today's budget
   * @param now - Clock
   */
  private traceBudgetState(project: Project, ps: ProjectState, paused: boolean, spent: number, budget: number, now: Date): void {
    const today = localDateKey(now);
    if (ps.budgetPausedAt !== undefined) {
      const fromEarlierDay = localDateKey(new Date(ps.budgetPausedAt)) !== today;
      if (!paused || fromEarlierDay) {
        traceAutopilotAction(project, 'budget_resumed', {
          summary: fromEarlierDay ? `${project.name}: the daily budget reset at midnight; the autopilot runs again` : `${project.name}: under the daily budget again (boost); the autopilot runs again`,
          outcome: 'ok',
          data: { reason: fromEarlierDay ? 'new_day' : 'boost', pausedSince: new Date(ps.budgetPausedAt).toISOString(), spentTokens: spent, budgetTokens: Number.isFinite(budget) ? budget : -1 },
          now,
        });
        delete ps.budgetPausedAt;
      }
    }
    if (paused && ps.budgetPausedAt === undefined) {
      ps.budgetPausedAt = now.getTime();
      traceAutopilotAction(project, 'budget_paused', {
        summary: `${project.name}: daily budget reached (${spent} of ${budget} tokens); no triage or auto-claim until it resets`,
        outcome: 'blocked',
        data: { spentTokens: spent, budgetTokens: budget },
        now,
      });
    }
  }

  /**
   * Trace a skipped evaluation, once per reason change per day (the tick
   * runs every few minutes and must not flood the run trace).
   *
   * @param project - Project
   * @param ps - Its bookkeeping
   * @param reason - Why no triage
   * @param trigger - Tick or idle member
   * @param candidates - Tickets that would be triaged
   * @param now - Clock
   */
  private traceSkip(project: Project, ps: ProjectState, reason: string, trigger: TriageTrigger, candidates: number, now: Date): void {
    if (reason === 'off') return;
    const day = localDateKey(now);
    const seen = ps.skips?.day === day ? ps.skips.reasons : [];
    if (seen.includes(reason)) return;
    // A skip alone never starts the day's run trace: a day with nothing but
    // skips is not an autopilot run (and gets no retro).
    const run = traceAutopilotAction(project, 'skip', {
      summary: `${project.name}: no triage — ${SKIP_WORDS[reason] ?? reason}`,
      outcome: 'skipped',
      data: { reason, trigger, candidates },
      create: false,
      now,
    });
    if (run) ps.skips = { day, reasons: [...seen, reason] };
  }

  /**
   * Trace a triage: the step, and each ticket listed for the first time today.
   *
   * @param project - Project
   * @param ps - Its bookkeeping
   * @param workItem - The triage item
   * @param driver - Who triages
   * @param trigger - Tick or idle member
   * @param tickets - Tickets listed
   * @param now - Clock
   */
  private traceTriage(project: Project, ps: ProjectState, workItem: WorkItem, driver: string, trigger: TriageTrigger, tickets: ProjectTicket[], now: Date): void {
    traceAutopilotAction(project, 'triage', {
      summary: `${project.name}: ${driver} woken to triage ${tickets.length} ticket${tickets.length === 1 ? '' : 's'}`,
      outcome: 'queued',
      workItemId: workItem.id,
      session: driver,
      data: { trigger, count: tickets.length, tickets: tickets.map((t) => t.id).join(',') },
      alsoTraceId: workItem.traceId ?? null,
      now,
    });
    const day = localDateKey(now);
    const seen = new Set(ps.triaged?.day === day ? ps.triaged.ids : []);
    for (const t of tickets) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      traceAutopilotAction(project, 'triage_ticket', {
        summary: `${t.id} listed for triage: ${t.title}`,
        ticketId: t.id,
        session: driver,
        data: { status: t.status, priority: t.priority, labels: t.labels.join(',') },
        now,
      });
    }
    ps.triaged = { day, ids: [...seen] };
  }

  // ---------------------------------------------------------------------------
  // Stats and runs (specs/2026-10-03-autopilot-experiments.md §2)
  // ---------------------------------------------------------------------------

  /**
   * Stats of a project over the last `days` days (today included).
   *
   * @param ref - Project id, name or path
   * @param caller - Owner, orchestrator or a lead of a project team
   * @param opts - days (1..STATS_MAX_DAYS), label, stallMinutes
   * @returns Stats, with the project and its settings
   * @throws ProjectTicketError(400/403/404)
   */
  async getStats(
    ref: string,
    caller: ProjectTicketCaller,
    opts: { days?: number; label?: string; stallMinutes?: number } = {},
  ): Promise<AutopilotStats & { project: { id: string; name: string }; settings: ResolvedTicketAutopilotSettings; pausedForToday: boolean }> {
    const project = await this.deps.workflow.resolveProject(ref);
    await this.requireReader(caller, project);
    const days = this.daysParam(opts.days);
    const range = rangeDays(this.now(), days);
    const stats = await this.statsFor(project, range[0], range[range.length - 1], opts.label ?? null, opts.stallMinutes);
    const status = await this.statusOf(project);
    return { ...stats, project: { id: project.id, name: project.name }, settings: status.settings, pausedForToday: status.pausedForToday };
  }

  /**
   * Stats of a project between two local days (no access check: experiments
   * and the retro call it).
   *
   * @param projectRef - Project id, name or path
   * @param start - First day (YYYY-MM-DD)
   * @param end - Last day (YYYY-MM-DD)
   * @param label - Only tickets with this label
   * @param stallMinutes - Stall threshold
   * @returns Stats
   */
  async statsBetween(projectRef: string, start: string, end: string, label: string | null = null, stallMinutes?: number): Promise<AutopilotStats> {
    const project = await this.deps.workflow.resolveProject(projectRef);
    return this.statsFor(project, start, end, label, stallMinutes);
  }

  /**
   * Stats of a project over a range of days.
   *
   * @param project - Project
   * @param start - First day
   * @param end - Last day
   * @param label - Label filter
   * @param stallMinutes - Stall threshold
   * @returns Stats
   */
  private async statsFor(project: Project, start: string, end: string, label: string | null, stallMinutes?: number): Promise<AutopilotStats> {
    const reader = this.traceReader();
    const minutes = clampStallMinutes(stallMinutes ?? defaultStallMinutes());
    const days = daysBetween(start, end);
    const since = new Date(dayStartMs(start));
    const until = dayEndMs(end);
    // listTagged throws when the index cannot be read: a read failure is
    // never reported as a range without autopilot work.
    const entries = reader.listTagged({ autopilotProjectId: project.id, since }).filter((e) => Date.parse(e.root.createdAt) < until);
    const traces: StatsTrace[] = [];
    let unreadable = 0;
    for (const entry of entries) {
      try {
        const full = await reader.readAll(entry.traceId);
        if (!full) {
          unreadable += 1;
          continue;
        }
        // Metrics are computed per day by the stats (event times, every stall).
        traces.push({ entry: { ...entry, root: full.root ?? entry.root }, events: full.events });
      } catch {
        unreadable += 1;
      }
    }
    const settings = resolveTicketAutopilotSettings(project.ticketAutopilot);
    const teams = await this.projectTeams(project, { includePaused: true });
    return computeAutopilotStats({
      projectId: project.id,
      label,
      days,
      traces,
      ledger: this.ledgerByDay(teams, days),
      dailyBudgetTokens: settings.dailyBudgetTokens,
      stallMinutes: minutes,
      now: this.now(),
      unreadable,
    });
  }

  /**
   * Run traces and ticket traces of the last `days` days, newest day first.
   *
   * @param ref - Project id, name or path
   * @param caller - Owner, orchestrator or a lead of a project team
   * @param opts - days, label
   * @returns Days with their traces
   */
  async getRuns(ref: string, caller: ProjectTicketCaller, opts: { days?: number; label?: string } = {}): Promise<{ project: { id: string; name: string }; days: AutopilotRunDay[] }> {
    const project = await this.deps.workflow.resolveProject(ref);
    await this.requireReader(caller, project);
    const range = rangeDays(this.now(), this.daysParam(opts.days));
    const wanted = new Set(range);
    const entries = this.traceReader().listTagged({ autopilotProjectId: project.id, since: new Date(dayStartMs(range[0])) });
    const label = opts.label?.trim().toLowerCase();
    const byDay = new Map<string, AutopilotRunDay>(range.map((d) => [d, { day: d, runTraceId: null, traces: [] }]));
    for (const e of entries) {
      const day = e.tags?.autopilot?.day;
      if (!day || !wanted.has(day)) continue;
      const row = byDay.get(day) as AutopilotRunDay;
      if (e.root.kind === 'autopilot') {
        row.runTraceId = e.traceId;
        continue;
      }
      const labels = e.tags?.labels ?? [];
      if (label && !labels.some((l) => l.toLowerCase() === label)) continue;
      row.traces.push({
        traceId: e.traceId,
        kind: e.root.kind,
        summary: e.root.summary,
        ...(e.root.refs.ticketId ? { ticketId: e.root.refs.ticketId } : {}),
        labels,
        updatedAt: e.updatedAt,
      });
    }
    return { project: { id: project.id, name: project.name }, days: [...byDay.values()].reverse() };
  }

  /**
   * `?days=` within bounds.
   *
   * @param days - Requested
   * @returns 1..STATS_MAX_DAYS (default STATS_DEFAULT_DAYS)
   */
  private daysParam(days: number | undefined): number {
    const C = TICKET_AUTOPILOT_CONSTANTS;
    if (days === undefined || !Number.isFinite(days)) return C.STATS_DEFAULT_DAYS;
    const n = Math.floor(days);
    if (n < 1 || n > C.STATS_MAX_DAYS) throw new ProjectTicketError(400, `days must be 1 to ${C.STATS_MAX_DAYS}`);
    return n;
  }

  /**
   * The ledger of the project's team sessions per day (what the budget counts).
   *
   * @param teams - Project teams
   * @param days - Day keys
   * @returns Tokens and USD per day
   */
  private ledgerByDay(teams: Team[], days: string[]): Record<string, LedgerDay> {
    const sessions = new Set(teams.flatMap((t) => (t.members ?? []).map(sessionOf)).filter((x) => !!x));
    const out: Record<string, LedgerDay> = {};
    for (const day of days) {
      const since = new Date(dayStartMs(day));
      const until = new Date(dayEndMs(day) - 1);
      let tokens = 0;
      let costUsd = 0;
      for (const s of sessions) {
        try {
          const u = this.deps.ledger.getSessionUsageSince(s, since, until);
          tokens += u.totalTokens;
          costUsd += u.cost ?? 0;
        } catch {
          // A ledger read failure leaves the day's number short, never fails the stats.
        }
      }
      out[day] = { tokens, costUsd };
    }
    return out;
  }

  /**
   * The trace reader (injected, else the process store + analysis).
   *
   * @returns Reader
   */
  private traceReader(): AutopilotTraceReader {
    if (this.deps.traces) return this.deps.traces;
    return {
      listTagged: (filter) => getTraceStore().listTagged(filter),
      readAll: (id) => getTraceStore().readAll(id),
    };
  }

  /**
   * Whether an agent may read a project's autopilot traces: anyone on a team
   * that works on the project (the rule decision cards use for tickets).
   * The owner and the orchestrator are let through without a lookup.
   *
   * @param projectRef - Project id, name or path
   * @param caller - Caller
   * @returns True when allowed (false for an unknown project)
   */
  async canReadProjectTraces(projectRef: string, caller: ProjectTicketCaller): Promise<boolean> {
    if (!caller.session || caller.session === ORCHESTRATOR_SESSION_NAME) return true;
    let project: Project;
    try {
      project = await this.deps.workflow.resolveProject(projectRef);
    } catch {
      return false;
    }
    const { access } = await this.deps.workflow.accessOf(caller, project);
    return access !== 'outsider';
  }

  /**
   * Owner, orchestrator, or a lead of a project team (the driver).
   *
   * @param caller - Caller
   * @param project - Project
   * @throws ProjectTicketError(403)
   */
  private async requireReader(caller: ProjectTicketCaller, project: Project): Promise<void> {
    const { access } = await this.deps.workflow.accessOf(caller, project);
    if (access !== 'owner' && access !== 'orchestrator' && access !== 'lead') {
      throw new ProjectTicketError(403, 'Only the owner, the orchestrator or a team lead of the project can read its autopilot stats');
    }
  }

  // ---------------------------------------------------------------------------
  // Daily retro (specs/2026-10-03-autopilot-experiments.md §4)
  // ---------------------------------------------------------------------------

  /**
   * Whether the daily retro runs for a project: its setting, else on while
   * an autopilot experiment on the project is running.
   *
   * @param project - Project
   * @returns True when on
   */
  async retroOn(project: Project): Promise<boolean> {
    const setting = resolveTicketAutopilotSettings(project.ticketAutopilot).retro;
    if (setting !== null) return setting;
    if (!this.deps.runningExperiment) return false;
    return this.deps.runningExperiment(project.id).catch(() => false);
  }

  /**
   * Schedule yesterday's retro for every enabled project that wants one
   * (once per project per day, at or after RETRO_HOUR_LOCAL).
   *
   * @param projects - Enabled projects
   * @returns WorkItems created
   */
  private async processRetros(projects: Project[]): Promise<WorkItem[]> {
    if (!this.deps.retro) return [];
    const now = this.now();
    if (now.getHours() < TICKET_AUTOPILOT_CONSTANTS.RETRO_HOUR_LOCAL) return [];
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
    const day = localDateKey(yesterday);
    const state = await this.loadState();
    const out: WorkItem[] = [];
    let items: WorkItem[] | null = null;
    for (const project of projects) {
      const ps = (state.projects[project.id] ??= {});
      if (ps.retroScheduledFor === day) continue;
      if (ps.retroRetryAt && now.getTime() < ps.retroRetryAt) continue;
      if (!(await this.retroOn(project))) continue;
      const runTrace = autopilotRunTrace(project, yesterday, false);
      if (!runTrace) {
        // The autopilot did nothing that day: nothing to review.
        ps.retroScheduledFor = day;
        continue;
      }
      const teams = await this.projectTeams(project);
      const driver = this.resolveDriver(resolveTicketAutopilotSettings(project.ticketAutopilot), teams);
      if (!driver) continue;
      // Unreadable traces: try again on a later tick rather than judge the day.
      const stats = await this.statsFor(project, day, day, null).catch(() => null);
      const dayStats = stats?.days[0];
      if (!stats || !dayStats || stats.incomplete) {
        // Back off while the reads keep failing (doubling, capped).
        ps.retroFailures = (ps.retroFailures ?? 0) + 1;
        ps.retroRetryAt = now.getTime() + retryBackoffMs(ps.retroFailures);
        continue;
      }
      delete ps.retroFailures;
      delete ps.retroRetryAt;
      ps.retroScheduledFor = day;
      // Only a day with real autopilot work gets a retro (skips and budget
      // notices alone are not a run).
      if (dayStats.triaged + dayStats.replans + dayStats.started + dayStats.done + dayStats.verified === 0) {
        this.logger.debug('Autopilot retro skipped: no autopilot work that day', { projectId: project.id, day });
        continue;
      }
      items ??= await this.deps.pool.getAllItems();
      const live = items.some(
        (wi) => wi.metadata?.kind === TICKET_AUTOPILOT_CONSTANTS.RETRO_METADATA_KIND && wi.metadata?.projectId === project.id && LIVE_STATUSES.has(wi.status),
      );
      if (live) {
        this.logger.info('Autopilot retro skipped: the previous one is still open', { projectId: project.id, day });
        continue;
      }
      const runs = this.traceReader()
        .listTagged({ autopilotProjectId: project.id, day })
        .filter((e) => e.root.kind !== 'autopilot' && e.root.kind !== 'triage')
        .slice(0, 25)
        .map((e) => ({ traceId: e.traceId, title: e.root.summary }));
      const brief = buildRetroBrief({ project: { id: project.id, name: project.name }, day, stats: dayStats, traces: [{ traceId: runTrace, title: `Run trace ${day}` }, ...runs] });
      const workItem = createWorkItem({
        type: TICKET_AUTOPILOT_CONSTANTS.RETRO_WORK_ITEM_TYPE,
        owner: 'team_lead',
        target: driver.session,
        title: `Autopilot retro: ${project.name} ${day}`,
        description: `Review the ${day} autopilot run of ${project.name}: what shipped, where it stalled and why; classify each problem and submit the retro.`,
        briefMarkdown: capBrief(brief),
        metadata: {
          kind: TICKET_AUTOPILOT_CONSTANTS.RETRO_METADATA_KIND,
          projectId: project.id,
          projectPath: project.path,
          teamId: driver.teamId,
          day,
          requiresVerification: false,
        },
      });
      workItem.createdAt = now.toISOString();
      workItem.targetSource = 'assigned';
      workItem.traceId = runTrace;
      await this.deps.pool.addToPool(workItem);
      ps.retroWorkItemId = workItem.id;
      traceAutopilotAction(project, 'retro_scheduled', {
        summary: `${driver.session} asked for the ${day} retro of ${project.name}`,
        outcome: 'queued',
        workItemId: workItem.id,
        session: driver.session,
        data: { day },
        // Recorded in the reviewed day's run only: scheduling never starts today's run trace.
        runTraceId: runTrace,
        now,
      });
      this.logger.info('Autopilot retro scheduled', { projectId: project.id, day, driver: driver.session, workItemId: workItem.id });
      out.push(workItem);
    }
    await this.saveState();
    return out;
  }

  /**
   * A retro came in: write it to the project wiki, file the harness gaps on
   * the Crewly project (deduped, capped) and ask the owner ONE card for them.
   *
   * @param ref - Project id, name or path
   * @param body - `{day, summary, problems}`
   * @param caller - Owner, orchestrator or a lead of a project team
   * @returns What was written and filed
   * @throws ProjectTicketError(400/403/404/503)
   */
  async submitRetro(ref: string, body: unknown, caller: ProjectTicketCaller): Promise<RetroResult> {
    // One retro at a time: the gap dedupe and the daily cap read and write the same state.
    const run = this.retroChain.then(
      () => this.submitRetroNow(ref, body, caller),
      () => this.submitRetroNow(ref, body, caller),
    );
    this.retroChain = run.catch(() => undefined);
    return run;
  }

  /**
   * {@link submitRetro}, serialised.
   *
   * @param ref - Project
   * @param body - Retro
   * @param caller - Caller
   * @returns What was written and filed
   */
  private async submitRetroNow(ref: string, body: unknown, caller: ProjectTicketCaller): Promise<RetroResult> {
    const project = await this.deps.workflow.resolveProject(ref);
    await this.requireReader(caller, project);
    const retroDeps = this.deps.retro;
    if (!retroDeps) throw new ProjectTicketError(503, 'Retros are not available (the autopilot is not fully started)');
    let retro: RetroInput;
    try {
      retro = validateRetroInput(body);
    } catch (err) {
      if (err instanceof RetroInputError) throw new ProjectTicketError(400, err.message);
      throw err;
    }
    const by = caller.session ?? 'owner';
    const now = this.now();
    if (retro.day > localDateKey(now)) throw new ProjectTicketError(400, `day ${retro.day} is in the future`);
    const stats = await this.statsFor(project, retro.day, retro.day, null).catch(() => null);
    const runTrace = autopilotRunTrace(project, new Date(dayStartMs(retro.day) + 12 * 3_600_000), false);
    const filed = await this.fileHarnessGaps(project, retro, retroDeps, now);
    const wikiPath = `${TICKET_AUTOPILOT_CONSTANTS.RETRO_WIKI_DIR}/${retro.day}.md`;
    const markdown = renderRetroMarkdown({ project, retro, stats: stats?.days[0] ?? null, by, filed: filed.filed, runTraceId: runTrace });
    const written = await retroDeps.writeWiki(project.path, wikiPath, markdown, by).catch((err) => {
      this.logger.warn('Could not write the autopilot retro to the wiki', { projectId: project.id, error: err instanceof Error ? err.message : String(err) });
      return false;
    });
    const counts: Record<string, number> = {};
    for (const p of retro.problems) counts[p.class] = (counts[p.class] ?? 0) + 1;
    traceAutopilotAction(project, 'retro_filed', {
      summary: `${by} filed the ${retro.day} retro of ${project.name}: ${retro.problems.length} problem${retro.problems.length === 1 ? '' : 's'}, ${filed.filed.length} harness-gap ticket${filed.filed.length === 1 ? '' : 's'}`,
      outcome: 'ok',
      ...(caller.session ? { session: caller.session, actor: { kind: 'agent' as const, session: caller.session } } : { actor: { kind: 'owner' as const } }),
      data: { day: retro.day, wiki: written ? wikiPath : 'not written', ...counts, filed: filed.filed.length, duplicates: filed.duplicates.length, overCap: filed.overCap.length },
      alsoTraceId: runTrace,
      now,
    });
    this.logger.info('Autopilot retro filed', { projectId: project.id, day: retro.day, by, written, filed: filed.filed.map((t) => t.id) });
    return { day: retro.day, wikiPath, written, ...filed };
  }

  /**
   * File the retro's harness gaps on the Crewly project and ask the owner
   * one card for them.
   *
   * @param project - The reviewed project
   * @param retro - The retro
   * @param retroDeps - Side effects
   * @param now - Clock
   * @returns Filed, duplicate and over-cap gaps, and the card
   */
  private async fileHarnessGaps(
    project: Project,
    retro: RetroInput,
    retroDeps: AutopilotRetroDeps,
    now: Date,
  ): Promise<Pick<RetroResult, 'filed' | 'duplicates' | 'overCap' | 'decisionId' | 'unasked'>> {
    const C = TICKET_AUTOPILOT_CONSTANTS;
    const gaps = retro.problems.filter((p) => p.class === 'harness_gap');
    const out: Pick<RetroResult, 'filed' | 'duplicates' | 'overCap' | 'decisionId' | 'unasked'> = { filed: [], duplicates: [], overCap: [], decisionId: null };
    if (gaps.length === 0) return out;
    const target = await retroDeps.harnessProject();
    if (!target) {
      this.logger.warn('No harness project to file retro gaps on', { name: C.RETRO_HARNESS_PROJECT });
      out.overCap = gaps.map((g) => g.title);
      return out;
    }
    const state = await this.loadState();
    const today = localDateKey(now);
    const memory = now.getTime() - C.RETRO_GAP_MEMORY_DAYS * 24 * 3_600_000;
    state.retro.gaps = state.retro.gaps.filter((g) => g.at >= memory);
    const { tickets } = await this.deps.tickets.list(target.path);
    const known = [...tickets.filter((t) => t.status !== 'done' && t.status !== 'cancelled').map((t) => t.title), ...state.retro.gaps.map((g) => g.title)];
    for (const gap of gaps) {
      const dup = duplicateOf(gap.title, known);
      if (dup) {
        out.duplicates.push({ title: gap.title, duplicateOf: dup });
        continue;
      }
      if ((state.retro.gapDays[today] ?? 0) >= C.RETRO_MAX_GAPS_PER_DAY) {
        out.overCap.push(gap.title);
        continue;
      }
      const description = [
        `Found by the ${retro.day} autopilot retro of ${project.name}.`,
        '',
        gap.detail ?? '',
        '',
        gap.evidence ? `Evidence: ${gap.evidence}` : '',
        `Retro: ${project.name} wiki, ${C.RETRO_WIKI_DIR}/${retro.day}.md`,
      ]
        .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
        .join('\n')
        .trim();
      const ticket = await retroDeps.createTicket(target, {
        title: gap.title,
        description,
        // Held until the owner approves: triage skips retro-pending tickets,
        // and nothing but this retro's card lifts the hold.
        labels: [...C.RETRO_GAP_LABELS, C.RETRO_PENDING_LABEL],
        source: `retro:${project.name}:${retro.day}`,
      });
      out.filed.push({ id: ticket.id, title: ticket.title });
      known.push(gap.title);
      state.retro.gaps.push({ title: gap.title, at: now.getTime() });
      state.retro.gapDays[today] = (state.retro.gapDays[today] ?? 0) + 1;
      traceAutopilotAction(project, 'retro_gap_ticket', {
        summary: `Harness gap filed on ${target.name} as ${ticket.id}: ${gap.title}`,
        outcome: 'queued',
        ticketId: ticket.id,
        data: { day: retro.day, harnessProject: target.name },
        now,
      });
    }
    for (const d of Object.keys(state.retro.gapDays)) if (d < localDateKey(new Date(memory))) delete state.retro.gapDays[d];
    if (out.filed.length > 0) {
      const n = out.filed.length;
      try {
        const decision = await retroDeps.askOwner({
          key: `retro:${project.id}:${retro.day}`,
          title: `Harness gaps from the ${project.name} retro (${retro.day})`,
          question: `File ${n === 1 ? 'this harness gap' : `these ${n} harness gaps`} for the ${target.name} team?`,
          body: out.filed.map((t) => `• *${t.id}* ${t.title}`),
          approveLabel: C.RETRO_APPROVE_LABEL,
          skipLabel: C.RETRO_SKIP_LABEL,
          deadline: new Date(now.getTime() + C.RETRO_DECISION_DEADLINE_MS),
        });
        out.decisionId = decision.id;
        state.retro.decisions[decision.id] = { projectId: project.id, projectPath: target.path, ticketIds: out.filed.map((t) => t.id) };
      } catch (err) {
        // No card, no approval: the tickets must not wait on a question nobody asked.
        this.logger.warn('Could not ask the owner about the retro gaps; the tickets are cancelled', { error: err instanceof Error ? err.message : String(err) });
        for (const t of out.filed) {
          await retroDeps
            .applyGapDecision(target.path, t.id, false, `the owner could not be asked (${err instanceof Error ? err.message : String(err)})`)
            .catch(() => 'left');
        }
        out.unasked = out.filed.map((t) => t.id);
      }
    }
    await this.saveState();
    return out;
  }

  /**
   * Tell the lead of the harness project that the owner skipped a gap
   * ticket someone already started (a `notify` WorkItem: the normal
   * dispatch path, which also wakes a stopped lead).
   *
   * @param projectPath - Harness project root
   * @param ticketId - The started ticket
   * @param decisionId - The card
   */
  private async tellGapLead(projectPath: string, ticketId: string, decisionId: string): Promise<void> {
    const wanted = path.resolve(projectPath);
    const project = (await this.deps.directory.getProjects()).find((p) => !!p.path && path.resolve(p.path) === wanted);
    if (!project) return;
    const lead = this.resolveDriver(resolveTicketAutopilotSettings(project.ticketAutopilot), await this.projectTeams(project));
    if (!lead) return;
    const wi = createWorkItem({
      type: 'notify',
      owner: 'team_lead',
      target: lead.session,
      title: `Owner skipped harness gap ${ticketId}`,
      description: `The owner skipped harness-gap ticket ${ticketId} (decision ${decisionId}), but work on it has already started. Decide whether to stop it (cancel the ticket) or finish it, and note why on the ticket.`,
      metadata: { projectId: project.id, projectPath: project.path, teamId: lead.teamId, ticketId, requiresVerification: false },
    });
    wi.createdAt = this.now().toISOString();
    wi.targetSource = 'assigned';
    await this.deps.pool.addToPool(wi);
    this.logger.info('Told the lead about a skipped gap ticket already in progress', { ticketId, lead: lead.session });
  }

  /**
   * The owner answered a retro-gaps card: Approve releases its tickets
   * (needs-owner hold removed, `ready`); anything else (Skip, the default at
   * the deadline, a withdrawn card) cancels those that have not started.
   *
   * @param decision - The settled decision
   * @returns Nothing for an agent (no agent asked it)
   */
  async onRetroDecision(decision: OwnerDecision): Promise<null> {
    if (!this.deps.retro) return null;
    const state = await this.loadState();
    const entry = state.retro.decisions[decision.id];
    if (!entry) return null;
    const approved =
      (decision.status === 'resolved' || decision.status === 'defaulted') &&
      decision.options.find((o) => o.key === decision.chosenKey)?.label === TICKET_AUTOPILOT_CONSTANTS.RETRO_APPROVE_LABEL;
    for (const id of entry.ticketIds) {
      const note = approved ? `owner approved (decision ${decision.id})` : `owner did not approve (decision ${decision.id}, ${decision.status})`;
      const outcome = await this.deps.retro
        .applyGapDecision(entry.projectPath, id, approved, note)
        .catch((err) => {
          this.logger.warn('Could not apply the retro decision to a ticket', { id, error: err instanceof Error ? err.message : String(err) });
          return null;
        });
      // Skipped, but someone already works on it: its lead decides what to do.
      if (!approved && outcome === 'left') await this.tellGapLead(entry.projectPath, id, decision.id).catch(() => undefined);
    }
    delete state.retro.decisions[decision.id];
    await this.saveState();
    this.logger.info('Retro harness gaps decided', { decisionId: decision.id, approved, tickets: entry.ticketIds });
    return null;
  }

  // ---------------------------------------------------------------------------
  // Stop reasons and self-review (specs/2026-10-04-autopilot-speed-modes.md)
  // ---------------------------------------------------------------------------

  /**
   * Why a project's autopilot is not producing work right now (see
   * {@link classifyStopReason}). Reads only: the pool, the tickets, the ledger.
   *
   * @param project - Project
   * @param ps - Its bookkeeping (listed tickets, replan backoff)
   * @param items - The pool's items (read once per pass)
   * @returns The reason, or null while running / between replans
   */
  private async stopReasonOf(project: Project, ps: ProjectState, items: WorkItem[]): Promise<AutopilotStopReason | null> {
    const C = TICKET_AUTOPILOT_CONSTANTS;
    const settings = resolveTicketAutopilotSettings(project.ticketAutopilot);
    const now = this.now();
    const nowMs = now.getTime();
    const allTeams = await this.projectTeams(project, { includePaused: true });
    const activeTeams = allTeams.filter((t) => !isTeamPausedNow(t));
    const spent = this.usedToday(allTeams);
    const budget = this.budgetToday(settings, allTeams).tokens;
    const { tickets } = await this.deps.tickets.list(project.path);
    const kinds = new Set<string>([C.TRIAGE_METADATA_KIND, C.REPLAN_METADATA_KIND, C.SELF_REVIEW_METADATA_KIND]);
    const ttlMs = settings.replanTtlHours * 60 * 60 * 1000;
    const members = activeTeams.flatMap((t) => t.members ?? []);
    const idleSessions = new Set(members.filter((m) => isMemberIdle(m)).flatMap((m) => [sessionOf(m), m.sessionName, m.agentId].filter((x): x is string => !!x)));
    let liveAutopilotItem = false;
    let stuckDelivery = false;
    let failedRecently = 0;
    for (const wi of items) {
      const md = wi.metadata ?? {};
      const link = md.projectTicket as { projectPath?: string } | undefined;
      const ofProject = md.projectId === project.id || (!!link?.projectPath && !!project.path && path.resolve(link.projectPath) === path.resolve(project.path));
      if (!ofProject) continue;
      const age = nowMs - (Date.parse(wi.createdAt) || nowMs);
      if (typeof md.kind === 'string' && kinds.has(md.kind) && LIVE_STATUSES.has(wi.status)) {
        // A live triage or replan is the autopilot producing work; a self-review is not (it never masks a stop).
        const producing = md.kind !== C.SELF_REVIEW_METADATA_KIND;
        if (producing && !(md.kind === C.REPLAN_METADATA_KIND && age >= ttlMs)) liveAutopilotItem = true;
        // Queued for long while its target sits idle: the wake never landed.
        if (wi.status === 'queued' && age >= C.STOP_STUCK_DELIVERY_MS && !!wi.target && idleSessions.has(wi.target)) stuckDelivery = true;
      }
      if (wi.status === 'failed') {
        const at = Date.parse(wi.statusChangedAt ?? wi.completedAt ?? wi.createdAt) || 0;
        if (nowMs - at <= C.STOP_SYSTEM_ERROR_LOOKBACK_MS) failedRecently += 1;
      }
    }
    const selection = selectTriageCandidates({ tickets, teams: activeTeams, now: nowMs, listed: ps.listed });
    const waitingOnOwner = tickets.filter(
      (t) =>
        t.status === 'review' ||
        (OPEN_TICKET_STATUSES.has(t.status) && (hasNeedsOwnerLabel(t) || t.labels.includes(C.RETRO_PENDING_LABEL))),
    ).length;
    return classifyStopReason({
      teamsTotal: allTeams.length,
      teamsActive: activeTeams.length,
      usedTodayTokens: spent,
      dailyBudgetTokens: budget,
      inProgress: tickets.filter((t) => t.status === 'in_progress').length,
      ready: tickets.filter((t) => t.status === 'ready').length,
      toTriage: selection.candidates.length,
      liveAutopilotItem,
      failedRecently,
      stuckDelivery,
      waitingOnOwner,
      emptyReplanBackoff: replanBackoffHolds(ps.replanBackoff, nowMs, localDateKey(now)),
    }).reason;
  }

  /**
   * Classify every enabled project's stop reason and trace each change
   * (`stopped` with the reason, `resumed` when the work moves again).
   *
   * @param projects - Enabled projects
   */
  private async processStopReasons(projects: Project[]): Promise<void> {
    const state = await this.loadState();
    const items = await this.deps.pool.getAllItems();
    const now = this.now();
    let dirty = false;
    for (const project of projects) {
      const ps = (state.projects[project.id] ??= {});
      let reason: AutopilotStopReason | null;
      try {
        reason = await this.stopReasonOf(project, ps, items);
      } catch (err) {
        this.logger.warn('Could not classify the autopilot stop reason', { projectId: project.id, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const previous = ps.stop?.reason ?? null;
      if (reason === previous) continue;
      dirty = true;
      if (reason) {
        ps.stop = { reason, since: now.getTime() };
        traceAutopilotAction(project, 'stopped', {
          summary: `${project.name}: autopilot stopped — ${STOP_REASON_WORDS[reason]}`,
          outcome: 'blocked',
          data: { reason, ...(previous ? { previous } : {}) },
          now,
        });
        this.logger.info('Ticket autopilot stopped', { projectId: project.id, reason });
      } else {
        const since = ps.stop?.since;
        delete ps.stop;
        traceAutopilotAction(project, 'resumed', {
          summary: `${project.name}: autopilot moving again (was: ${previous ? STOP_REASON_WORDS[previous] : 'stopped'})`,
          outcome: 'ok',
          data: { previous: previous ?? '', ...(since ? { stoppedMs: now.getTime() - since } : {}) },
          now,
        });
        this.logger.info('Ticket autopilot moving again', { projectId: project.id, previous });
      }
    }
    if (dirty) await this.saveState();
  }

  /**
   * Ask each enabled project's driver for a short self-review at the speed
   * mode's cadence (Rush hourly, Normal daily, Chill weekly): one live at a
   * time, never for a paused team (no driver), never over the budget, and
   * skipped when nothing changed since the last one and nobody is idle.
   * Projects without a goal get none.
   *
   * @param projects - Enabled projects
   * @returns WorkItems created
   */
  private async processSelfReviews(projects: Project[]): Promise<WorkItem[]> {
    const C = TICKET_AUTOPILOT_CONSTANTS;
    if (!this.deps.goalOf) return [];
    const state = await this.loadState();
    const now = this.now();
    const nowMs = now.getTime();
    const out: WorkItem[] = [];
    let items: WorkItem[] | null = null;
    for (const project of projects) {
      const settings = resolveTicketAutopilotSettings(project.ticketAutopilot);
      const ps = (state.projects[project.id] ??= {});
      const ask = ps.selfReviewAsk;
      // Not due: decided on bookkeeping alone, no reads.
      if (ask && nowMs - ask.at < settings.selfReviewEveryMs) continue;
      const teams = await this.projectTeams(project);
      const driver = this.resolveDriver(settings, teams);
      const spendTeams = await this.projectTeams(project, { includePaused: true });
      const spent = this.usedToday(spendTeams);
      const budget = this.budgetToday(settings, spendTeams).tokens;
      items ??= await this.deps.pool.getAllItems();
      let live = false;
      for (const wi of items) {
        if (wi.metadata?.kind !== C.SELF_REVIEW_METADATA_KIND || wi.metadata?.projectId !== project.id || !LIVE_STATUSES.has(wi.status)) continue;
        const age = nowMs - (Date.parse(wi.createdAt) || nowMs);
        if (age < C.SELF_REVIEW_LIVE_MAX_MS) live = true;
        else if (wi.status === 'queued') await this.deps.pool.cancelQueued(wi.id, 'self-review never picked up; replaced at the next cadence').catch(() => undefined);
      }
      const { tickets } = await this.deps.tickets.list(project.path);
      const latestTicketAt = tickets.reduce((m, t) => Math.max(m, Date.parse(t.updatedAt) || 0), 0);
      const stopReason = ps.stop?.reason ?? null;
      let changed = !ask || latestTicketAt > ask.ticketsAt || stopReason !== ask.stopReason;
      if (!changed && ask && this.deps.goalChangedAt) {
        const goalAt = await this.deps.goalChangedAt(project).catch(() => null);
        changed = typeof goalAt === 'number' && goalAt > ask.at;
      }
      const members = teams.flatMap((t) => t.members ?? []);
      const decision = decideSelfReview({
        enabled: settings.enabled,
        driver: driver?.session ?? null,
        now: nowMs,
        everyMs: settings.selfReviewEveryMs,
        ...(ask ? { lastAskedAt: ask.at } : {}),
        live,
        usedTodayTokens: spent,
        dailyBudgetTokens: budget,
        changed,
        anyoneIdle: members.some((m) => isMemberIdle(m)),
      });
      if (decision.action === 'skip' || !driver) {
        this.logger.debug('Autopilot self-review not asked', { projectId: project.id, decision });
        continue;
      }
      const goal = await this.deps.goalOf(project, now).catch(() => null);
      if (!goal || !goal.text.trim()) {
        // No goal, nothing to review against: try again at the next cadence.
        ps.selfReviewAsk = { at: nowMs, workItemId: '', ticketsAt: latestTicketAt, stopReason };
        continue;
      }
      const since = ask?.at ?? nowMs - 24 * 60 * 60 * 1000;
      const cadence = settings.selfReviewEveryMs <= 60 * 60 * 1000 ? 'hourly' : settings.selfReviewEveryMs <= 24 * 60 * 60 * 1000 ? 'daily' : 'weekly';
      const brief = buildSelfReviewBrief({
        project: { id: project.id, name: project.name },
        mode: settings.speedMode,
        cadence,
        goal: goal.text,
        closedSince: tickets.filter((t) => (t.status === 'done' || t.status === 'cancelled') && (Date.parse(t.updatedAt) || 0) >= since).length,
        open: {
          ready: tickets.filter((t) => t.status === 'ready').length,
          inProgress: tickets.filter((t) => t.status === 'in_progress').length,
          backlog: tickets.filter((t) => t.status === 'backlog').length,
          waitingOnOwner: tickets.filter((t) => t.status === 'review' || (OPEN_TICKET_STATUSES.has(t.status) && hasNeedsOwnerLabel(t))).length,
        },
        stopReason,
        previous: ps.selfReviews?.[ps.selfReviews.length - 1] ?? null,
      });
      const workItem = createWorkItem({
        type: C.SELF_REVIEW_WORK_ITEM_TYPE,
        owner: 'team_lead',
        target: driver.session,
        title: `Self-review: ${project.name}`,
        description: `Short self-review of ${project.name} against its goal: the gap to the target, what moved it, and the next bet.`,
        briefMarkdown: capBrief(brief),
        metadata: {
          kind: C.SELF_REVIEW_METADATA_KIND,
          projectId: project.id,
          projectPath: project.path,
          teamId: driver.teamId,
          requiresVerification: false,
          speedMode: settings.speedMode,
        },
      });
      workItem.createdAt = now.toISOString();
      workItem.targetSource = 'assigned';
      await this.deps.pool.addToPool(workItem);
      ps.selfReviewAsk = { at: nowMs, workItemId: workItem.id, ticketsAt: latestTicketAt, stopReason };
      traceAutopilotAction(project, 'self_review_scheduled', {
        summary: `${project.name}: ${driver.session} asked for a ${cadence} self-review (${settings.speedMode})`,
        outcome: 'queued',
        workItemId: workItem.id,
        session: driver.session,
        data: { speedMode: settings.speedMode, cadence },
        now,
      });
      this.logger.info('Autopilot self-review asked', { projectId: project.id, driver: driver.session, workItemId: workItem.id, speedMode: settings.speedMode });
      out.push(workItem);
    }
    await this.saveState();
    return out;
  }

  /**
   * The driver filed a self-review: kept on the project (newest last,
   * capped), shown in the status and the digest, and quoted in the next
   * goal replan brief.
   *
   * @param ref - Project id, name or path
   * @param body - `{ gap, moved?, nextBet }`
   * @param caller - Owner, orchestrator or a lead of a project team
   * @returns The stored record
   * @throws ProjectTicketError(400/403/404)
   */
  async submitSelfReview(ref: string, body: unknown, caller: ProjectTicketCaller): Promise<SelfReviewRecord> {
    const C = TICKET_AUTOPILOT_CONSTANTS;
    const project = await this.deps.workflow.resolveProject(ref);
    await this.requireReader(caller, project);
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const field = (key: string, required: boolean): string => {
      const raw = b[key];
      const v = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
      if (required && !v) throw new ProjectTicketError(400, `${key} is required`);
      if (v.length > C.SELF_REVIEW_FIELD_MAX_CHARS) throw new ProjectTicketError(400, `${key} is longer than ${C.SELF_REVIEW_FIELD_MAX_CHARS} characters`);
      return v;
    };
    const now = this.now();
    const record: SelfReviewRecord = {
      at: now.toISOString(),
      by: caller.session ?? 'owner',
      gap: field('gap', true),
      moved: field('moved', false),
      nextBet: field('nextBet', true),
    };
    const state = await this.loadState();
    const ps = (state.projects[project.id] ??= {});
    ps.selfReviews = [...(ps.selfReviews ?? []), record].slice(-C.SELF_REVIEW_HISTORY);
    await this.saveState();
    traceAutopilotAction(project, 'self_review_filed', {
      summary: `${record.by} filed a self-review of ${project.name}: next bet ${record.nextBet.slice(0, 120)}`,
      outcome: 'ok',
      ...(caller.session ? { session: caller.session, actor: { kind: 'agent' as const, session: caller.session } } : { actor: { kind: 'owner' as const } }),
      ...(ps.selfReviewAsk?.workItemId ? { workItemId: ps.selfReviewAsk.workItemId } : {}),
      data: { gap: record.gap.slice(0, 200), nextBet: record.nextBet.slice(0, 200) },
      now,
    });
    this.logger.info('Autopilot self-review filed', { projectId: project.id, by: record.by });
    return record;
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
    const spent = this.usedToday(teams);
    const budget = this.budgetToday(settings, teams);
    const state = await this.loadState();
    const ps = state.projects[project.id];
    const items = await this.deps.pool.getAllItems();
    const nowMs = this.now().getTime();
    const ttlMs = settings.replanTtlHours * 60 * 60 * 1000;
    const liveOf = (kind: string): boolean =>
      items.some(
        (wi) =>
          wi.metadata?.kind === kind &&
          wi.metadata?.projectId === project.id &&
          LIVE_STATUSES.has(wi.status) &&
          (kind !== TICKET_AUTOPILOT_CONSTANTS.REPLAN_METADATA_KIND || nowMs - (Date.parse(wi.createdAt) || nowMs) < ttlMs),
      );
    const live = liveOf(TICKET_AUTOPILOT_CONSTANTS.TRIAGE_METADATA_KIND);
    const today = localDateKey(this.now());
    return {
      project: { id: project.id, name: project.name, path: project.path },
      settings,
      driver: this.resolveDriver(settings, teams),
      usedTodayTokens: spent,
      budgetTodayTokens: Number.isFinite(budget.tokens) ? budget.tokens : null,
      boostTokens: budget.extra,
      pausedForToday: settings.enabled && spent >= budget.tokens,
      triageInFlight: live,
      lastTriageAt: ps?.lastTriageAt ? new Date(ps.lastTriageAt).toISOString() : null,
      replanInFlight: liveOf(TICKET_AUTOPILOT_CONSTANTS.REPLAN_METADATA_KIND),
      replansToday: ps?.replans?.day === today ? ps.replans.count : 0,
      lastReplanAt: ps?.replans?.lastAt ? new Date(ps.replans.lastAt).toISOString() : null,
      replanBackoffUntil: replanBackoffHolds(ps?.replanBackoff, nowMs, today) ? (ps?.replanBackoff?.resumeDay ?? null) : null,
      replanBackoffUntilAt:
        ps?.replanBackoff && replanBackoffHolds(ps.replanBackoff, nowMs, today)
          ? new Date(ps.replanBackoff.resumeAt ?? new Date(`${ps.replanBackoff.resumeDay}T00:00:00`).getTime()).toISOString()
          : null,
      retroOn: await this.retroOn(project),
      speedMode: settings.speedMode,
      stopReason: ps?.stop?.reason ?? null,
      stopReasonText: ps?.stop ? STOP_REASON_WORDS[ps.stop.reason] : null,
      stoppedSince: ps?.stop ? new Date(ps.stop.since).toISOString() : null,
      lastSelfReview: ps?.selfReviews?.[ps.selfReviews.length - 1] ?? null,
      nextSelfReviewAt: settings.enabled
        ? new Date(ps?.selfReviewAsk ? ps.selfReviewAsk.at + settings.selfReviewEveryMs : nowMs).toISOString()
        : null,
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
  private async projectTeams(project: Project, options: { includePaused?: boolean } = {}): Promise<Team[]> {
    // A paused team is left out (specs/2026-10-04-team-pause.md): its lead is
    // never the driver woken to triage, plan or write a retro, and its
    // members are not offered in the triage brief. Spend accounting still
    // counts it (`includePaused`): its running work keeps spending.
    return (await this.deps.directory.getTeams()).filter(
      (t) => !t.archived && (options.includePaused || !isTeamPausedNow(t)) && (t.projectIds ?? []).includes(project.id),
    );
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
   * Today's budget: the setting plus the boosts on the project's teams.
   *
   * @param settings - Resolved settings
   * @param teams - The project's teams
   * @returns Tokens (Infinity when a boost made today unlimited) and the boost part
   */
  private budgetToday(settings: ResolvedTicketAutopilotSettings, teams: Team[]): { tokens: number; extra: number } {
    let boost = { extra: 0, unlimited: false };
    try {
      boost = this.deps.boosts?.(teams.map((t) => t.id)) ?? boost;
    } catch {
      // No boost information: the plain budget applies.
    }
    return { tokens: boost.unlimited ? Infinity : settings.dailyBudgetTokens + boost.extra, extra: boost.extra };
  }

  /**
   * Convert every project's pre-token USD budget to tokens, once, and log it
   * (USAGE_CONSTANTS.TOKENS_PER_USD).
   *
   * @returns How many projects were converted
   */
  async migrateUsdBudgets(): Promise<number> {
    let n = 0;
    for (const project of await this.deps.directory.getProjects()) {
      const stored = project.ticketAutopilot;
      if (!stored || typeof stored.dailyBudgetUsd !== 'number') continue;
      const { dailyBudgetUsd, ...rest } = stored;
      const tokens = stored.dailyBudgetTokens ?? legacyBudgetTokens(stored) ?? undefined;
      const next = { ...rest, ...(tokens !== undefined ? { dailyBudgetTokens: tokens } : {}) };
      await this.deps.directory.saveProject({ ...project, ticketAutopilot: next, updatedAt: this.now().toISOString() });
      this.logger.info('Ticket autopilot budget converted from USD to tokens', {
        projectId: project.id,
        dailyBudgetUsd,
        dailyBudgetTokens: tokens,
        tokensPerUsd: USAGE_CONSTANTS.TOKENS_PER_USD,
      });
      n += 1;
    }
    return n;
  }

  /**
   * Tokens used since local midnight by the agents of the given teams.
   *
   * @param teams - Teams
   * @returns Tokens
   */
  private usedToday(teams: Team[]): number {
    const since = localMidnight(this.now());
    const sessions = new Set(teams.flatMap((t) => (t.members ?? []).map(sessionOf)).filter((s) => !!s));
    let total = 0;
    for (const s of sessions) {
      try {
        total += this.deps.ledger.getSessionUsageSince(s, since).totalTokens;
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
      retro: {
        gapDays: raw.retro?.gapDays && typeof raw.retro.gapDays === 'object' ? raw.retro.gapDays : {},
        gaps: Array.isArray(raw.retro?.gaps) ? raw.retro.gaps : [],
        decisions: raw.retro?.decisions && typeof raw.retro.decisions === 'object' ? raw.retro.decisions : {},
      },
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
 * Backoff after `failures` failed tries: RETRY_BACKOFF_MIN_MS doubling up to RETRY_BACKOFF_MAX_MS.
 *
 * @param failures - Failed tries so far (≥ 1)
 * @returns Milliseconds
 */
export function retryBackoffMs(failures: number): number {
  const C = TICKET_AUTOPILOT_CONSTANTS;
  return Math.min(C.RETRY_BACKOFF_MAX_MS, C.RETRY_BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1));
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
