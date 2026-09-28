/**
 * Fresh Task Conversation Service
 *
 * Claude Code agents keep one conversation forever, so a small new task
 * re-reads hundreds of thousands of tokens of unrelated history on every
 * turn (81% of measured usage came from turns over 300k context). This
 * service starts a fresh conversation when a team member is handed a task
 * whose ROOT differs from the last one it was given:
 *
 *   1. The old conversation is saved server-side — a handover file under
 *      `<CREWLY_HOME>/handover/` (same format the orchestrator uses at
 *      restart) and a concise copy through the memory `remember` path, which
 *      mirrors into the wiki. No agent turn is spent on it.
 *   2. `/clear` is written to the PTY the same way context compaction writes
 *      its command (Escape, 200 ms, command + CR), then a short pause for the
 *      prompt to come back.
 *   3. The dispatch goes on with a one-line note pointing at the handover.
 *   4. In the background the new transcript Claude Code starts is found and
 *      its id stored, so a restart resumes the NEW conversation; if it cannot
 *      be found the stored id is cleared so a restart starts fresh instead of
 *      resuming the huge pre-clear one.
 *
 * Retries, verifications and reviews of the same task share its root
 * (`<id>:retry:N`, `<id>:verify:<id>`, `<id>:review:…`), so they keep their
 * context. Never the orchestrator, only Claude Code, only when the agent is
 * idle and nobody else just wrote to it; any failure falls back to plain
 * delivery — nothing here throws into dispatch.
 *
 * Idle-boundary context cap: one task can run for 1000+ turns, so a new root
 * alone does not bound the context. A periodic sweep
 * ({@link FreshTaskConversationService.startContextCapSweep}) saves and
 * clears an idle Claude Code member whose last turn carried more than
 * `CREWLY_MEMBER_CONTEXT_CAP_TOKENS` (300k by default, `0` disables), then
 * writes one line naming its active WorkItem and the handover. Same safety
 * rules — never the orchestrator, never mid-turn, never while a message is
 * queued for or being delivered to it — plus at most one cap per 20 minutes.
 *
 * @module services/agent/fresh-task-conversation.service
 */

import * as fs from 'fs';
import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import {
  CREWLY_CONSTANTS,
  FRESH_TASK_CONVERSATION_CONSTANTS,
  ORC_CONVERSATION_CONSTANTS,
  ORCHESTRATOR_SESSION_NAME,
  RUNTIME_TYPES,
} from '../../constants.js';
import { buildHandoverSummary, claudeTranscriptPath, lastTurnContextTokens } from './runtime-session-recovery.js';
import { getSessionStatePersistence } from '../session/session-state-persistence.js';
import { getSessionBackendSync } from '../session/session-backend.factory.js';
import { PtyActivityTrackerService } from './pty-activity-tracker.service.js';
import { SubAgentMessageQueue } from '../messaging/sub-agent-message-queue.service.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import { STANDING_ANSWERS_CONSTANTS } from '../../constants.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The root task id of a work item: its id with any follow-up suffix
 * (`:retry:N`, `:verify:…`, `:review:…`) removed, so every follow-up of one
 * task maps to the same root.
 *
 * @param workItemId - WorkItem id
 * @returns The root id
 *
 * @example
 * ```typescript
 * rootWorkItemId('abc:retry:2');        // 'abc'
 * rootWorkItemId('abc:verify:abc');     // 'abc'
 * rootWorkItemId('abc:retry:1:retry:2'); // 'abc'
 * ```
 */
export function rootWorkItemId(workItemId: string): string {
  let cut = workItemId.length;
  for (const marker of FRESH_TASK_CONVERSATION_CONSTANTS.ROOT_SUFFIX_MARKERS) {
    const i = workItemId.indexOf(marker);
    if (i > 0 && i < cut) cut = i;
  }
  return workItemId.slice(0, cut);
}

/**
 * Whether the feature is switched on by the environment.
 *
 * @param env - Environment (tests)
 * @returns False when CREWLY_FRESH_TASK_CONVERSATION is 0 / false / off / no
 */
export function freshTaskConversationEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[FRESH_TASK_CONVERSATION_CONSTANTS.ENV_TOGGLE];
  if (raw === undefined) return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

/** Everything the clear decision depends on. */
export interface FreshTaskDecisionInput {
  /** Agent session */
  sessionName: string;
  /** Its runtime (from session persistence) */
  runtimeType?: string;
  /** Root of the last task delivered to it, if any */
  previousRoot: string | null;
  /** Root of the task being delivered */
  newRoot: string;
  /** Env + settings kill-switch */
  enabled: boolean;
  /** Agent is mid-turn */
  busy: boolean;
  /** Someone else wrote to the session moments ago */
  recentDelivery: boolean;
  /** Roots of OTHER work the agent is actively running */
  otherActiveRoots: string[];
  /**
   * The agent already started this very task a while ago (e.g. the lead
   * handed it over directly and this is a re-delivery). Clearing now would
   * wipe the live context of work in progress.
   */
  alreadyStarted?: boolean;
}

/** The clear decision and why. */
export interface FreshTaskDecision {
  /** Clear before delivering */
  clear: boolean;
  /** Short reason (logged) */
  reason: string;
}

/**
 * Decide whether to start a fresh conversation before delivering a task.
 *
 * @param input - Decision inputs
 * @returns The decision
 */
export function decideFreshConversation(input: FreshTaskDecisionInput): FreshTaskDecision {
  if (input.sessionName === ORCHESTRATOR_SESSION_NAME) return { clear: false, reason: 'orchestrator' };
  if (input.runtimeType !== RUNTIME_TYPES.CLAUDE_CODE) return { clear: false, reason: 'not claude-code' };
  if (!input.enabled) return { clear: false, reason: 'disabled' };
  if (!input.previousRoot) return { clear: false, reason: 'first task' };
  if (input.previousRoot === input.newRoot) return { clear: false, reason: 'same task' };
  if (input.busy) return { clear: false, reason: 'busy' };
  if (input.recentDelivery) return { clear: false, reason: 'recent delivery' };
  if (input.alreadyStarted) return { clear: false, reason: 'already working on it' };
  if (input.otherActiveRoots.some((r) => r !== input.newRoot)) return { clear: false, reason: 'other work in progress' };
  return { clear: true, reason: 'new task' };
}

/**
 * The line put in front of the task text after a fresh start.
 *
 * @param handoverPath - Handover file written for the old conversation
 * @returns One line
 */
export function freshConversationNote(handoverPath: string): string {
  return `Fresh conversation for this task — your earlier work is in ${handoverPath} and your wiki; read them only if this task needs it.`;
}

/**
 * The context cap for members, from the environment.
 *
 * @param env - Environment (tests)
 * @returns Tokens; 0 means the cap is off. Unset or invalid → the default.
 */
export function memberContextCapTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[FRESH_TASK_CONVERSATION_CONSTANTS.MEMBER_CONTEXT_CAP_ENV];
  if (raw === undefined || raw.trim() === '') return FRESH_TASK_CONVERSATION_CONSTANTS.MEMBER_CONTEXT_CAP_TOKENS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return FRESH_TASK_CONVERSATION_CONSTANTS.MEMBER_CONTEXT_CAP_TOKENS;
  return Math.floor(n);
}

/** Everything the idle-boundary context-cap decision depends on. */
export interface ContextCapDecisionInput {
  /** Agent session */
  sessionName: string;
  /** Its runtime */
  runtimeType?: string;
  /** Cap in tokens (0 = off) */
  capTokens: number;
  /** Env + settings kill-switch of the fresh-conversation feature */
  enabled: boolean;
  /** Last turn's context, or null when unknown */
  contextTokens: number | null;
  /** Agent is mid-turn */
  busy: boolean;
  /** How long the PTY has been quiet (null = unknown) */
  quietMs: number | null;
  /** A message is being delivered, was just delivered, or a prepare/clear is running */
  deliveryActive: boolean;
  /** Messages are queued for the agent */
  queuedMessages: boolean;
  /** When the session was last capped (ms), if ever */
  lastCapAt: number | null;
  /** Now (ms) */
  now: number;
  /** Id of the WorkItem the agent is on (null = none) */
  activeWorkItemId: string | null;
}

/**
 * Decide whether to cap (save + clear + re-orient) a member's conversation.
 * Pure; the order of checks is also the order of the logged reasons.
 *
 * @param input - Decision inputs
 * @returns The decision
 */
export function decideContextCap(input: ContextCapDecisionInput): FreshTaskDecision {
  if (input.sessionName === ORCHESTRATOR_SESSION_NAME) return { clear: false, reason: 'orchestrator' };
  if (input.runtimeType !== RUNTIME_TYPES.CLAUDE_CODE) return { clear: false, reason: 'not claude-code' };
  if (input.capTokens <= 0) return { clear: false, reason: 'cap off' };
  if (!input.enabled) return { clear: false, reason: 'disabled' };
  if (input.contextTokens === null || input.contextTokens <= input.capTokens) return { clear: false, reason: 'under cap' };
  if (
    input.lastCapAt !== null &&
    input.now - input.lastCapAt < FRESH_TASK_CONVERSATION_CONSTANTS.CONTEXT_CAP_MIN_INTERVAL_MS
  ) {
    return { clear: false, reason: 'rate limited' };
  }
  if (input.busy) return { clear: false, reason: 'busy' };
  if (input.quietMs === null || input.quietMs < FRESH_TASK_CONVERSATION_CONSTANTS.CONTEXT_CAP_MIN_QUIET_MS) {
    return { clear: false, reason: 'not quiet long enough' };
  }
  if (input.deliveryActive) return { clear: false, reason: 'delivery in progress' };
  if (input.queuedMessages) return { clear: false, reason: 'messages queued' };
  // The new conversation is found by the WorkItem id in the re-orientation
  // line; with no WorkItem there is nothing safe to track it by, and the
  // next task's own prepare will start a fresh conversation anyway.
  if (!input.activeWorkItemId) return { clear: false, reason: 'no active work item' };
  return { clear: true, reason: 'context over cap' };
}

/**
 * The one line written after a context-cap clear. It must carry the WorkItem
 * id: the new conversation id is found by it.
 *
 * @param args - WorkItem, handover file and the old context size
 * @returns One line
 */
export function contextCapReorientation(args: {
  workItem: Pick<WorkItem, 'id' | 'title'>;
  handoverPath: string;
  contextTokens: number;
}): string {
  const title = args.workItem.title.length > 80 ? `${args.workItem.title.slice(0, 77)}...` : args.workItem.title;
  return (
    `${FRESH_TASK_CONVERSATION_CONSTANTS.CONTEXT_CAP_TAG} Your conversation reached ${args.contextTokens.toLocaleString('en-US')} tokens, so it was saved and restarted. ` +
    `You are on WorkItem ${args.workItem.id} ("${title}"). Your handover is in ${args.handoverPath} (also in your wiki) — read it, then continue that WorkItem where you left off.`
  );
}

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

/** What the service needs to know about a session. */
export interface FreshTaskSessionInfo {
  /** Runtime */
  runtimeType?: string;
  /** Working directory (Claude Code transcripts are keyed on it) */
  cwd?: string;
  /** Current Claude conversation id */
  sessionId?: string;
}

/** Collaborators; the defaults talk to the running backend. */
export interface FreshTaskDeps {
  /** Session runtime / cwd / conversation id */
  getSessionInfo: (sessionName: string) => FreshTaskSessionInfo | null;
  /** Conversation ids of every OTHER registered session */
  getClaimedSessionIds: (sessionName: string) => Set<string>;
  /** Store the new conversation id */
  updateSessionId: (sessionName: string, id: string) => void;
  /** Forget the conversation id (restart starts fresh) */
  clearSessionId: (sessionName: string) => void;
  /** Agent is mid-turn */
  isBusy: (sessionName: string) => Promise<boolean>;
  /** Settings flag (general.freshConversationPerTask, default true) */
  settingEnabled: () => Promise<boolean>;
  /** Open work items targeting the session */
  getActiveItems: (sessionName: string) => Promise<WorkItem[]>;
  /** Raw PTY write; false when the session is gone */
  writeToSession: (sessionName: string, data: string) => boolean;
  /** Store the concise handover through memory (mirrors into the wiki) */
  remember: (args: { agentId: string; projectPath?: string; content: string; title: string }) => Promise<unknown>;
  /** Crewly home (handover + state files) */
  crewlyHome: () => string;
  /** Claude home override (tests) */
  claudeHome?: string;
  /** Clock */
  now: () => number;
  /** Sleep */
  sleep: (ms: number) => Promise<void>;
  /** Environment */
  env: NodeJS.ProcessEnv;
  /** Registered agent sessions (context-cap sweep) */
  listSessions: () => string[];
  /** Messages are queued for the session and not yet written */
  hasQueuedMessages: (sessionName: string) => boolean;
  /** How long the session's PTY has been quiet (ms), or null when unknown */
  getQuietMs: (sessionName: string) => number | null;
  /** Write one message into the session (paste + Enter); false when the session is gone */
  sendMessage: (sessionName: string, text: string) => Promise<boolean>;
}

/** Statuses that mean the agent is actively on a work item. */
const ACTIVE_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(['running', 'accepted', 'proposed']);

/** Where the per-session last-root map lives. */
interface FreshTaskState {
  version: 1;
  sessions: Record<string, { root: string; at: string }>;
}

/**
 * Default collaborators. Heavy services are imported lazily so importing this
 * module (from the dispatch subscriber, the terminal controller) stays cheap.
 *
 * @returns Deps bound to the running backend
 */
function defaultDeps(): FreshTaskDeps {
  const getPersistence = () => {
    try {
      return getSessionStatePersistence();
    } catch {
      return null;
    }
  };
  return {
    getSessionInfo: (sessionName) => {
      const meta = getPersistence()?.getSessionMetadata(sessionName);
      if (!meta) return null;
      return { runtimeType: meta.runtimeType, cwd: meta.cwd, sessionId: meta.claudeSessionId };
    },
    getClaimedSessionIds: (sessionName) => {
      const p = getPersistence();
      const ids = new Set<string>();
      if (!p) return ids;
      for (const name of p.getRegisteredSessions()) {
        const id = p.getSessionId(name);
        if (id && name !== sessionName) ids.add(id);
      }
      return ids;
    },
    updateSessionId: (sessionName, id) => getPersistence()?.updateSessionId(sessionName, id),
    clearSessionId: (sessionName) => getPersistence()?.clearSessionId(sessionName),
    isBusy: async (sessionName) => {
      const { StorageService } = await import('../core/storage.service.js');
      const info = await StorageService.getInstance().findMemberBySessionName(sessionName).catch(() => null);
      if (info?.member.workingStatus === CREWLY_CONSTANTS.WORKING_STATUSES.IN_PROGRESS) return true;
      const tracker = PtyActivityTrackerService.getInstance();
      return tracker.hasActivity(sessionName) && tracker.getIdleTimeMs(sessionName) < FRESH_TASK_CONVERSATION_CONSTANTS.MIN_QUIET_MS;
    },
    settingEnabled: async () => {
      try {
        const { getSettingsService } = await import('../settings/settings.service.js');
        return (await getSettingsService().getSettings()).general.freshConversationPerTask !== false;
      } catch {
        return true;
      }
    },
    getActiveItems: async (sessionName) => {
      const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
      const all = await TaskPoolService.getInstance().getAllItems();
      return all.filter((wi) => wi.target === sessionName && ACTIVE_STATUSES.has(wi.status));
    },
    writeToSession: (sessionName, data) => {
      const session = getSessionBackendSync()?.getSession(sessionName);
      if (!session) return false;
      session.write(data);
      return true;
    },
    remember: async ({ agentId, projectPath, content, title }) => {
      const { MemoryService } = await import('../memory/memory.service.js');
      return MemoryService.getInstance().remember({
        agentId,
        projectPath,
        content,
        category: 'fact',
        scope: 'agent',
        metadata: { title },
      });
    },
    crewlyHome: getCrewlyHomePath,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    env: process.env,
    listSessions: () => getPersistence()?.getRegisteredSessions() ?? [],
    hasQueuedMessages: (sessionName) => {
      try {
        return SubAgentMessageQueue.getInstance().hasPending(sessionName);
      } catch {
        return true;
      }
    },
    getQuietMs: (sessionName) => {
      const tracker = PtyActivityTrackerService.getInstance();
      return tracker.hasActivity(sessionName) ? tracker.getIdleTimeMs(sessionName) : null;
    },
    sendMessage: async (sessionName, text) => {
      const session = getSessionBackendSync()?.getSession(sessionName);
      if (!session) return false;
      // Same two-step write as the terminal controller's message mode:
      // pasted text first, Enter separately so paste mode cannot swallow it.
      session.write(`\x1b[200~${text}\x1b[201~`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 + Math.ceil(text.length / 10), 5000)));
      session.write('\r');
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Result of {@link FreshTaskConversationService.prepareForTask}. */
export interface PrepareForTaskResult {
  /** A fresh conversation was started */
  cleared: boolean;
  /** Handover file for the old conversation (when cleared) */
  handoverPath?: string;
}

/** Result of {@link FreshTaskConversationService.capContextIfNeeded}. */
export interface ContextCapResult {
  /** The conversation was saved, cleared and the agent re-oriented */
  capped: boolean;
  /** Why (logged; the decision reason when not capped) */
  reason: string;
  /** Handover file for the old conversation (when capped) */
  handoverPath?: string;
  /** WorkItem the agent was re-oriented on (when capped) */
  workItemId?: string;
}

/**
 * Singleton that starts a fresh Claude Code conversation per new task, and
 * caps a long task's conversation at idle boundaries.
 */
export class FreshTaskConversationService {
  private static instance: FreshTaskConversationService | null = null;

  private readonly logger: ComponentLogger;
  private deps: FreshTaskDeps;
  private state: FreshTaskState | null = null;
  /** Per-session in-flight prepare (serialises prepares; waited on by terminal writes) */
  private readonly inFlight = new Map<string, Promise<PrepareForTaskResult>>();
  /** Last time a message was written to a session (terminal write / deliver) */
  private readonly lastDelivery = new Map<string, number>();
  /** Deliveries currently being written to a session (see {@link beginDelivery}) */
  private readonly deliveriesInFlight = new Map<string, number>();
  /** Last context-cap clear per session (rate limit) */
  private readonly lastCapAt = new Map<string, number>();
  /** Context-cap sweep timer */
  private capSweepTimer: NodeJS.Timeout | null = null;
  /** A sweep is running (sweeps never overlap) */
  private capSweepRunning = false;

  private constructor(deps?: Partial<FreshTaskDeps>) {
    this.logger = LoggerService.getInstance().createComponentLogger('FreshTaskConversation');
    this.deps = { ...defaultDeps(), ...(deps ?? {}) };
  }

  /**
   * @returns The singleton
   */
  public static getInstance(): FreshTaskConversationService {
    if (!FreshTaskConversationService.instance) {
      FreshTaskConversationService.instance = new FreshTaskConversationService();
    }
    return FreshTaskConversationService.instance;
  }

  /**
   * Replace the singleton with one using the given collaborators (tests).
   *
   * @param deps - Overrides for the default deps
   * @returns The new singleton
   */
  public static createForTesting(deps: Partial<FreshTaskDeps>): FreshTaskConversationService {
    FreshTaskConversationService.instance = new FreshTaskConversationService(deps);
    return FreshTaskConversationService.instance;
  }

  /** Drop the singleton (tests). */
  public static resetInstance(): void {
    FreshTaskConversationService.instance?.stopContextCapSweep();
    FreshTaskConversationService.instance = null;
  }

  /**
   * Mark a delivery to a session as in progress until the returned function
   * is called. Neither a new-task clear nor a context-cap clear starts while
   * one is running: it would wipe the message before the agent reads it.
   *
   * @param sessionName - Session being written to
   * @returns Call when the delivery has finished (idempotent)
   */
  beginDelivery(sessionName: string): () => void {
    this.deliveriesInFlight.set(sessionName, (this.deliveriesInFlight.get(sessionName) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.deliveriesInFlight.get(sessionName) ?? 1) - 1;
      if (left > 0) this.deliveriesInFlight.set(sessionName, left);
      else this.deliveriesInFlight.delete(sessionName);
      this.lastDelivery.set(sessionName, this.deps.now());
    };
  }

  /**
   * Whether a delivery is being written to the session right now.
   *
   * @param sessionName - Session
   * @returns True while a {@link beginDelivery} is open
   */
  isDelivering(sessionName: string): boolean {
    return (this.deliveriesInFlight.get(sessionName) ?? 0) > 0;
  }

  /**
   * Record that a message is being written to a session. A clear right after
   * would wipe it before the agent reads it, so {@link prepareForTask} skips
   * clearing for a short window (this includes the dispatcher's own briefs,
   * so two tasks dispatched back to back never clear each other).
   *
   * @param sessionName - Session written to
   */
  noteDelivery(sessionName: string): void {
    this.lastDelivery.set(sessionName, this.deps.now());
  }

  /**
   * Wait (bounded) while a prepare — possibly a `/clear` — is running for the
   * session, so a message written now is not wiped by it.
   *
   * @param sessionName - Session about to be written to
   * @param maxMs - Upper bound on the wait
   */
  async waitIfClearing(
    sessionName: string,
    maxMs: number = FRESH_TASK_CONVERSATION_CONSTANTS.WAIT_IF_CLEARING_MAX_MS,
  ): Promise<void> {
    const pending = this.inFlight.get(sessionName);
    if (!pending) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      pending.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, maxMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /**
   * Root of the last task delivered to a session.
   *
   * @param sessionName - Session
   * @returns Root id or null
   */
  getLastRoot(sessionName: string): string | null {
    return this.loadState().sessions[sessionName]?.root ?? null;
  }

  /**
   * Called right before a task is written to an agent. Starts a fresh
   * conversation when the task's root differs from the previous one and it
   * is safe to; always records the new root. Never throws.
   *
   * @param sessionName - Target session
   * @param workItem - Task being delivered
   * @returns Whether it cleared, and the handover file when it did
   */
  async prepareForTask(sessionName: string, workItem: Pick<WorkItem, 'id' | 'metadata'>): Promise<PrepareForTaskResult> {
    // A standing-refresh WorkItem re-raises the page an already-idle member
    // was working on; it is not a new task for that member's conversation,
    // so clearing here would /clear a member just to hand it a page refresh.
    // Never record it as a root either — the next real task must still see
    // whatever root preceded this refresh.
    if (workItem.metadata?.['kind'] === STANDING_ANSWERS_CONSTANTS.WORKITEM_KIND) {
      return { cleared: false };
    }
    const previous = this.inFlight.get(sessionName);
    const run = (async (): Promise<PrepareForTaskResult> => {
      if (previous) await previous.catch(() => undefined);
      try {
        return await this.doPrepare(sessionName, workItem);
      } catch (err) {
        this.logger.warn('Fresh-conversation prepare failed — delivering without clearing', {
          sessionName,
          workItemId: workItem.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return { cleared: false };
      }
    })();
    this.inFlight.set(sessionName, run);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(sessionName) === run) this.inFlight.delete(sessionName);
    }
  }

  // -------------------------------------------------------------------------
  // Idle-boundary context cap
  // -------------------------------------------------------------------------

  /**
   * Start the periodic context-cap sweep (idempotent). The timer is unref'd
   * so it never keeps the process alive.
   *
   * @param intervalMs - Sweep interval
   */
  startContextCapSweep(intervalMs: number = FRESH_TASK_CONVERSATION_CONSTANTS.CONTEXT_CAP_SWEEP_MS): void {
    if (this.capSweepTimer) return;
    this.capSweepTimer = setInterval(() => {
      void this.runContextCapSweep();
    }, intervalMs);
    this.capSweepTimer.unref?.();
    this.logger.info('Member context-cap sweep started', {
      intervalMs,
      capTokens: memberContextCapTokens(this.deps.env),
    });
  }

  /** Stop the periodic context-cap sweep. */
  stopContextCapSweep(): void {
    if (this.capSweepTimer) clearInterval(this.capSweepTimer);
    this.capSweepTimer = null;
  }

  /**
   * Check every registered session once. Sessions are handled one after
   * another and sweeps never overlap. Never throws.
   *
   * @returns Per-session results (sessions skipped cheaply are omitted)
   */
  async runContextCapSweep(): Promise<Record<string, ContextCapResult>> {
    const results: Record<string, ContextCapResult> = {};
    if (this.capSweepRunning) return results;
    if (memberContextCapTokens(this.deps.env) <= 0) return results;
    this.capSweepRunning = true;
    try {
      let sessions: string[] = [];
      try {
        sessions = this.deps.listSessions();
      } catch {
        sessions = [];
      }
      for (const sessionName of sessions) {
        if (sessionName === ORCHESTRATOR_SESSION_NAME) continue;
        results[sessionName] = await this.capContextIfNeeded(sessionName);
      }
    } finally {
      this.capSweepRunning = false;
    }
    return results;
  }

  /**
   * If the member is idle between turns and its last turn carried more than
   * the cap, save the conversation (handover file + wiki), `/clear` it and
   * write one line naming its WorkItem and the handover. Runs in the same
   * per-session chain as {@link prepareForTask}, so terminal writes wait for
   * it. Never throws.
   *
   * @param sessionName - Member session
   * @returns What happened
   */
  async capContextIfNeeded(sessionName: string): Promise<ContextCapResult> {
    // Never queue behind (or start during) a prepare / another cap.
    if (this.inFlight.has(sessionName)) return { capped: false, reason: 'clear in progress' };
    const run = (async (): Promise<PrepareForTaskResult & { cap: ContextCapResult }> => {
      try {
        const cap = await this.doCapContext(sessionName);
        return { cleared: cap.capped, handoverPath: cap.handoverPath, cap };
      } catch (err) {
        this.logger.warn('Context-cap check failed (non-fatal)', {
          sessionName,
          error: err instanceof Error ? err.message : String(err),
        });
        return { cleared: false, cap: { capped: false, reason: 'error' } };
      }
    })();
    this.inFlight.set(sessionName, run);
    try {
      return (await run).cap;
    } finally {
      if (this.inFlight.get(sessionName) === run) this.inFlight.delete(sessionName);
    }
  }

  private async doCapContext(sessionName: string): Promise<ContextCapResult> {
    const info = this.deps.getSessionInfo(sessionName);
    const capTokens = memberContextCapTokens(this.deps.env);
    const base = {
      sessionName,
      runtimeType: info?.runtimeType,
      capTokens,
      enabled: true,
      contextTokens: Number.MAX_SAFE_INTEGER,
      busy: false,
      quietMs: Number.MAX_SAFE_INTEGER,
      deliveryActive: false,
      queuedMessages: false,
      lastCapAt: null,
      now: this.deps.now(),
      activeWorkItemId: 'pending',
    };
    // Cheap checks first (orchestrator, runtime, cap off).
    let decision = decideContextCap(base);
    if (!decision.clear) return { capped: false, reason: decision.reason };
    if (!info?.cwd || !info.sessionId) return { capped: false, reason: 'conversation id unknown' };

    const transcript = claudeTranscriptPath({ sessionId: info.sessionId, cwd: info.cwd, claudeHome: this.deps.claudeHome });
    const contextTokens = fs.existsSync(transcript) ? lastTurnContextTokens(transcript) : null;
    const last = this.lastDelivery.get(sessionName);
    const lastCapAt = this.lastCapAt.get(sessionName) ?? null;
    decision = decideContextCap({ ...base, contextTokens, lastCapAt, now: this.deps.now() });
    if (!decision.clear) return { capped: false, reason: decision.reason };

    const enabled = freshTaskConversationEnvEnabled(this.deps.env) && (await this.deps.settingEnabled());
    const busy = enabled ? await this.deps.isBusy(sessionName).catch(() => true) : false;
    const active = enabled && !busy ? await this.deps.getActiveItems(sessionName).catch(() => null) : [];
    const current = this.pickCurrentItem(active ?? []);
    decision = decideContextCap({
      ...base,
      contextTokens,
      lastCapAt,
      now: this.deps.now(),
      enabled,
      busy: busy || active === null,
      quietMs: this.deps.getQuietMs(sessionName),
      deliveryActive:
        this.isDelivering(sessionName) ||
        (last !== undefined && this.deps.now() - last < FRESH_TASK_CONVERSATION_CONSTANTS.RECENT_DELIVERY_MS),
      queuedMessages: this.deps.hasQueuedMessages(sessionName),
      activeWorkItemId: current?.id ?? null,
    });
    if (!decision.clear || !current) return { capped: false, reason: decision.reason };

    // Last look right before the clear: anything written since the checks
    // above means the agent is (about to be) working.
    if (this.isDelivering(sessionName) || (await this.deps.isBusy(sessionName).catch(() => true))) {
      return { capped: false, reason: 'busy' };
    }

    const saved = await this.saveAndClear(sessionName, { cwd: info.cwd, sessionId: info.sessionId }, {
      lastTask: current.id,
      why: `because it had grown past ${capTokens.toLocaleString('en-US')} tokens per turn (you are still on the same WorkItem)`,
    });
    if (!saved) return { capped: false, reason: 'not cleared' };
    this.lastCapAt.set(sessionName, this.deps.now());

    const line = contextCapReorientation({ workItem: current, handoverPath: saved.handoverPath, contextTokens: contextTokens as number });
    // Tracking matches on the WorkItem id in the first message, which the
    // re-orientation line carries.
    void this.trackNewConversation(sessionName, info.cwd, info.sessionId, saved.clearAt, current.id);
    const sent = await this.deps.sendMessage(sessionName, line).catch(() => false);
    this.lastDelivery.set(sessionName, this.deps.now());
    this.logger.info('Capped a member conversation at an idle boundary', {
      sessionName,
      workItemId: current.id,
      contextTokens,
      capTokens,
      oldSessionId: info.sessionId,
      handover: saved.handoverPath,
      reoriented: sent,
    });
    return { capped: true, reason: decision.reason, handoverPath: saved.handoverPath, workItemId: current.id };
  }

  /**
   * The WorkItem a member is on: running before accepted before proposed,
   * then the most recently started.
   */
  private pickCurrentItem(items: WorkItem[]): WorkItem | null {
    const rank: Record<string, number> = { running: 0, accepted: 1, proposed: 2 };
    const sorted = [...items].sort((a, b) => {
      const r = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
      if (r !== 0) return r;
      return (Date.parse(b.startedAt ?? '') || 0) - (Date.parse(a.startedAt ?? '') || 0);
    });
    return sorted[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async doPrepare(sessionName: string, workItem: Pick<WorkItem, 'id'>): Promise<PrepareForTaskResult> {
    const newRoot = rootWorkItemId(workItem.id);
    const previousRoot = this.getLastRoot(sessionName);
    const info = this.deps.getSessionInfo(sessionName);

    // Cheap checks first; the async ones only when a clear is still possible.
    let decision = decideFreshConversation({
      sessionName,
      runtimeType: info?.runtimeType,
      previousRoot,
      newRoot,
      enabled: true,
      busy: false,
      recentDelivery: false,
      otherActiveRoots: [],
    });
    if (decision.clear) {
      const enabled = freshTaskConversationEnvEnabled(this.deps.env) && (await this.deps.settingEnabled());
      const busy = enabled ? await this.deps.isBusy(sessionName).catch(() => true) : false;
      const last = this.lastDelivery.get(sessionName);
      const recentDelivery =
        this.isDelivering(sessionName) ||
        (last !== undefined && this.deps.now() - last < FRESH_TASK_CONVERSATION_CONSTANTS.RECENT_DELIVERY_MS);
      const active = enabled && !busy ? await this.deps.getActiveItems(sessionName).catch(() => null) : [];
      decision = decideFreshConversation({
        sessionName,
        runtimeType: info?.runtimeType,
        previousRoot,
        newRoot,
        enabled,
        busy: busy || active === null,
        recentDelivery,
        otherActiveRoots: (active ?? []).filter((wi) => wi.id !== workItem.id).map((wi) => rootWorkItemId(wi.id)),
        alreadyStarted: (active ?? []).some(
          (wi) =>
            rootWorkItemId(wi.id) === newRoot &&
            !!wi.startedAt &&
            this.deps.now() - Date.parse(wi.startedAt) > FRESH_TASK_CONVERSATION_CONSTANTS.ALREADY_STARTED_MS,
        ),
      });
    }

    this.recordRoot(sessionName, newRoot);
    if (!decision.clear) {
      if (previousRoot && previousRoot !== newRoot) {
        this.logger.debug('New task — keeping the current conversation', { sessionName, newRoot, previousRoot, reason: decision.reason });
      }
      return { cleared: false };
    }

    if (!info?.cwd || !info.sessionId) {
      this.logger.info('New task but the conversation id is unknown — not clearing', { sessionName, newRoot });
      return { cleared: false };
    }
    const saved = await this.saveAndClear(sessionName, { cwd: info.cwd, sessionId: info.sessionId }, {
      lastTask: previousRoot as string,
      why: 'when you were given a new task',
    });
    if (!saved) return { cleared: false };

    this.logger.info('Started a fresh conversation for a new task', {
      sessionName,
      previousRoot,
      newRoot,
      oldSessionId: info.sessionId,
      handover: saved.handoverPath,
    });

    // 3. Learn the new conversation id in the background.
    void this.trackNewConversation(sessionName, info.cwd, info.sessionId, saved.clearAt, workItem.id);
    return { cleared: true, handoverPath: saved.handoverPath };
  }

  /**
   * Save the current conversation (handover file + memory/wiki copy, no
   * agent turn) and write `/clear`. Shared by the new-task and the
   * context-cap paths.
   *
   * @param sessionName - Agent session
   * @param conv - Its cwd and current conversation id
   * @param handover - Task the old conversation was on, and why it closed
   * @returns The handover file and the time `/clear` was written, or null
   *   when nothing was cleared (transcript missing, session gone)
   */
  private async saveAndClear(
    sessionName: string,
    conv: { cwd: string; sessionId: string },
    handover: { lastTask: string; why: string },
  ): Promise<{ handoverPath: string; clearAt: number } | null> {
    const transcript = claudeTranscriptPath({ sessionId: conv.sessionId, cwd: conv.cwd, claudeHome: this.deps.claudeHome });
    if (!fs.existsSync(transcript)) {
      this.logger.info('Transcript missing — not clearing', { sessionName, transcript });
      return null;
    }

    // 1. Save the conversation (server-side, no agent turn).
    const summary = buildHandoverSummary(transcript);
    const handoverPath = this.writeHandover(sessionName, conv.sessionId, transcript, handover.lastTask, summary, handover.why);
    const memoryText = this.conciseHandover(sessionName, handover.lastTask, handoverPath, summary);
    void this.deps
      .remember({
        agentId: sessionName,
        projectPath: conv.cwd,
        content: memoryText,
        title: `Conversation handover — ${sessionName} — task ${handover.lastTask}`,
      })
      .catch((err: unknown) => {
        this.logger.debug('Handover memory write failed (non-fatal; the file is on disk)', {
          sessionName,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    // 2. Clear, exactly as context compaction writes its command.
    const clearAt = this.deps.now();
    if (!this.deps.writeToSession(sessionName, '\x1b')) {
      this.logger.info('Session not found — not clearing', { sessionName });
      return null;
    }
    await this.deps.sleep(FRESH_TASK_CONVERSATION_CONSTANTS.ESCAPE_DELAY_MS);
    this.deps.writeToSession(sessionName, `${FRESH_TASK_CONVERSATION_CONSTANTS.CLEAR_COMMAND}\r`);
    await this.deps.sleep(FRESH_TASK_CONVERSATION_CONSTANTS.POST_CLEAR_READY_MS);
    return { handoverPath, clearAt };
  }

  /**
   * Write the handover file (same shape as the orchestrator's restart handover).
   *
   * @returns Its path
   */
  private writeHandover(
    sessionName: string,
    oldSessionId: string,
    transcript: string,
    previousRoot: string,
    body: string,
    why: string = 'when you were given a new task',
  ): string {
    const dir = path.join(this.deps.crewlyHome(), ORC_CONVERSATION_CONSTANTS.HANDOVER_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(this.deps.now()).toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${sessionName}-${stamp}.md`);
    const tokens = lastTurnContextTokens(transcript);
    fs.writeFileSync(
      file,
      [
        `# Handover from your previous conversation`,
        ``,
        `Your previous conversation (${oldSessionId}) was closed ${why}; its last task was ${previousRoot}.` +
          (tokens !== null ? ` It had grown to ${tokens.toLocaleString('en-US')} tokens per turn.` : ''),
        `Everything Crewly tracks — tasks, teams, OKRs, wiki — is still there; this file keeps only the end of what was said.`,
        `The full transcript: ${transcript}`,
        ``,
        body || '_Nothing readable was found at the end of the old conversation._',
        ``,
      ].join('\n'),
      'utf-8',
    );
    return file;
  }

  /**
   * The capped text stored through memory: where the handover is plus the
   * newest part of what was said.
   */
  private conciseHandover(sessionName: string, previousRoot: string, handoverPath: string, summary: string): string {
    const head = `${sessionName} finished its conversation on task ${previousRoot}; full handover: ${handoverPath}\n\n`;
    const room = Math.max(0, FRESH_TASK_CONVERSATION_CONSTANTS.MEMORY_MAX_CHARS - head.length);
    const tail = summary.length > room ? `…${summary.slice(summary.length - room + 1)}` : summary;
    return head + (tail || '(nothing readable at the end of the conversation)');
  }

  /**
   * After `/clear`, find the transcript Claude Code starts for this agent and
   * store its id; if none shows up in time, clear the stored id so a restart
   * starts fresh rather than resuming the pre-clear conversation.
   *
   * A candidate is a `.jsonl` in the agent's transcript directory that was
   * STARTED after the clear (its first entry, not just a later write), is not
   * the old id or claimed by another session, and contains this task's
   * work-item id — the dispatch text written right after the clear carries
   * it. Several agents share one cwd and their transcripts mention each
   * other's session names, so matching on the name alone picked another
   * agent's conversation (Atlas resumed Ella's, 2026-09-28).
   */
  private async trackNewConversation(sessionName: string, cwd: string, oldId: string, clearAt: number, workItemId: string): Promise<void> {
    try {
      const dir = path.dirname(claudeTranscriptPath({ sessionId: oldId, cwd, claudeHome: this.deps.claudeHome }));
      const deadline = clearAt + FRESH_TASK_CONVERSATION_CONSTANTS.NEW_SESSION_DETECT_MS;
      while (this.deps.now() <= deadline) {
        const found = this.findNewTranscript(dir, sessionName, oldId, clearAt, workItemId);
        if (found) {
          this.deps.updateSessionId(sessionName, found);
          this.logger.info('Recorded the conversation id started by /clear', { sessionName, sessionId: found });
          return;
        }
        await this.deps.sleep(FRESH_TASK_CONVERSATION_CONSTANTS.NEW_SESSION_POLL_MS);
      }
      this.deps.clearSessionId(sessionName);
      this.logger.warn('New conversation id not found after /clear — cleared the stored id so a restart starts fresh', {
        sessionName,
        oldSessionId: oldId,
      });
    } catch (err) {
      this.logger.warn('New conversation id tracking failed — clearing the stored id', {
        sessionName,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        this.deps.clearSessionId(sessionName);
      } catch {
        // nothing more to do
      }
    }
  }

  /**
   * One scan of the transcript directory.
   *
   * @returns The new conversation id, or null
   */
  private findNewTranscript(dir: string, sessionName: string, oldId: string, clearAt: number, workItemId: string): string | null {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return null;
    }
    const claimed = this.deps.getClaimedSessionIds(sessionName);
    const candidates: Array<{ id: string; mtime: number }> = [];
    for (const name of entries) {
      const id = name.slice(0, -'.jsonl'.length);
      if (id === oldId || claimed.has(id)) continue;
      const file = path.join(dir, name);
      let mtime: number;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      // One second of slack for filesystem timestamp granularity.
      if (mtime < clearAt - 1_000) continue;
      if (!this.startedAfter(file, clearAt - 1_000)) continue;
      if (!this.fileMentions(file, workItemId)) continue;
      candidates.push({ id, mtime });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.id ?? null;
  }

  /**
   * Whether a transcript's first timestamped entry is at or after `since`,
   * i.e. the conversation began after the clear rather than being an older
   * one that happened to be written to recently.
   */
  private startedAfter(file: string, since: number): boolean {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(Math.min(64 * 1024, fs.fstatSync(fd).size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        for (const line of buf.toString('utf-8').split('\n')) {
          const m = /"timestamp":"([^"]+)"/.exec(line);
          if (m) return Date.parse(m[1]) >= since;
        }
        return false;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  /** Whether the start of a transcript contains the given text. */
  private fileMentions(file: string, needle: string): boolean {
    const MAX_BYTES = 256 * 1024;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(Math.min(MAX_BYTES, fs.fstatSync(fd).size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.toString('utf-8').includes(needle);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  private statePath(): string {
    return path.join(this.deps.crewlyHome(), FRESH_TASK_CONVERSATION_CONSTANTS.STATE_FILE);
  }

  private loadState(): FreshTaskState {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath(), 'utf-8')) as Partial<FreshTaskState>;
      this.state = { version: 1, sessions: parsed && typeof parsed.sessions === 'object' && parsed.sessions ? parsed.sessions : {} };
    } catch {
      this.state = { version: 1, sessions: {} };
    }
    return this.state;
  }

  private recordRoot(sessionName: string, root: string): void {
    const state = this.loadState();
    if (state.sessions[sessionName]?.root === root) return;
    state.sessions[sessionName] = { root, at: new Date(this.deps.now()).toISOString() };
    try {
      const file = this.statePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
      fs.renameSync(tmp, file);
    } catch (err) {
      this.logger.debug('Could not persist the last task root (non-fatal)', {
        sessionName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
