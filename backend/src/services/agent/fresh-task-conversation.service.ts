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
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';

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

/**
 * Singleton that starts a fresh Claude Code conversation per new task.
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
    FreshTaskConversationService.instance = null;
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
  async prepareForTask(sessionName: string, workItem: Pick<WorkItem, 'id'>): Promise<PrepareForTaskResult> {
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
      const recentDelivery = last !== undefined && this.deps.now() - last < FRESH_TASK_CONVERSATION_CONSTANTS.RECENT_DELIVERY_MS;
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
    const transcript = claudeTranscriptPath({ sessionId: info.sessionId, cwd: info.cwd, claudeHome: this.deps.claudeHome });
    if (!fs.existsSync(transcript)) {
      this.logger.info('New task but the transcript is missing — not clearing', { sessionName, transcript });
      return { cleared: false };
    }

    // 1. Save the conversation (server-side, no agent turn).
    const summary = buildHandoverSummary(transcript);
    const handoverPath = this.writeHandover(sessionName, info.sessionId, transcript, previousRoot as string, summary);
    const memoryText = this.conciseHandover(sessionName, previousRoot as string, handoverPath, summary);
    void this.deps
      .remember({
        agentId: sessionName,
        projectPath: info.cwd,
        content: memoryText,
        title: `Conversation handover — ${sessionName} — task ${previousRoot}`,
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
      return { cleared: false };
    }
    await this.deps.sleep(FRESH_TASK_CONVERSATION_CONSTANTS.ESCAPE_DELAY_MS);
    this.deps.writeToSession(sessionName, `${FRESH_TASK_CONVERSATION_CONSTANTS.CLEAR_COMMAND}\r`);
    await this.deps.sleep(FRESH_TASK_CONVERSATION_CONSTANTS.POST_CLEAR_READY_MS);

    this.logger.info('Started a fresh conversation for a new task', {
      sessionName,
      previousRoot,
      newRoot,
      oldSessionId: info.sessionId,
      handover: handoverPath,
    });

    // 3. Learn the new conversation id in the background.
    void this.trackNewConversation(sessionName, info.cwd, info.sessionId, clearAt);
    return { cleared: true, handoverPath };
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
        `Your previous conversation (${oldSessionId}) was closed when you were given a new task; its last task was ${previousRoot}.` +
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
   * A candidate is a `.jsonl` in the agent's transcript directory, modified
   * since the clear, not the old id, not claimed by another session, and
   * mentioning this session's name (the dispatch text written right after the
   * clear carries it) — several agents can share one cwd.
   */
  private async trackNewConversation(sessionName: string, cwd: string, oldId: string, clearAt: number): Promise<void> {
    try {
      const dir = path.dirname(claudeTranscriptPath({ sessionId: oldId, cwd, claudeHome: this.deps.claudeHome }));
      const deadline = clearAt + FRESH_TASK_CONVERSATION_CONSTANTS.NEW_SESSION_DETECT_MS;
      while (this.deps.now() <= deadline) {
        const found = this.findNewTranscript(dir, sessionName, oldId, clearAt);
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
  private findNewTranscript(dir: string, sessionName: string, oldId: string, clearAt: number): string | null {
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
      if (!this.fileMentions(file, sessionName)) continue;
      candidates.push({ id, mtime });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.id ?? null;
  }

  /** Whether the start of a transcript mentions the session name. */
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
