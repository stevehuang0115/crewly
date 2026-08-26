/**
 * Crewly Agent External Runtime Service
 *
 * Runs the Crewly Agent as a dedicated executable process and communicates
 * with it over a newline-delimited JSON protocol on stdin/stdout.
 *
 * This keeps OSS integration points intact while moving the agent runtime
 * behind an external process boundary so it can be versioned separately.
 *
 * @module services/agent/crewly-agent/crewly-agent-external-runtime.service
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { RuntimeAgentService } from '../runtime-agent.service.abstract.js';
import { InProcessLogBuffer } from './in-process-log-buffer.js';
import type { AgentRunResult, CrewlyAgentConfig, ModelConfig } from './types.js';
import { CREWLY_AGENT_DEFAULTS } from './types.js';
import { SessionCommandHelper } from '../../session/index.js';
import { updateAgentHeartbeat } from '../agent-heartbeat.service.js';
import { PtyActivityTrackerService } from '../pty-activity-tracker.service.js';
import { TokenUsageService } from '../../monitoring/token-usage.service.js';
import { getSettingsService } from '../../settings/settings.service.js';
import { LoggerService } from '../../core/logger.service.js';
import {
  ADDON_CONSTANTS,
  CREWLY_CONSTANTS,
  CREWLY_AGENT_MANAGED_COMMAND,
  ENV_CONSTANTS,
  LEGACY_CREWLY_AGENT_SENTINELS,
  RUNTIME_TYPES,
  type RuntimeType,
} from '../../../constants.js';

/** Handlers for one in-flight run, awaiting the child's reply. */
interface PendingRun {
  resolve: (result: AgentRunResult) => void;
  reject: (error: Error) => void;
}

type ParentMessage =
  | { type: 'init'; config: CrewlyAgentConfig }
  | { type: 'run'; runId: string; message: string; conversationId?: string; metadata?: Record<string, string> }
  | { type: 'abort' }
  | { type: 'get-state' }
  | { type: 'shutdown' };

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; runId?: string; data: AgentRunResult }
  | { type: 'error'; runId?: string; error: string; code?: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'stream'; event: 'text'; data: { chunk: string } }
  | { type: 'stream'; event: 'toolStart'; data: { toolName: string; args: Record<string, unknown> } }
  | { type: 'stream'; event: 'toolFinish'; data: { toolName: string; args: Record<string, unknown>; result: unknown; durationMs: number } }
  | { type: 'stream'; event: 'stepFinish'; data: { stepIndex: number; hasToolCalls: boolean } }
  | { type: 'state'; data: { historyLength: number; isProcessing: boolean; isInitialized: boolean } };

export class CrewlyAgentExternalRuntimeService extends RuntimeAgentService {
  private initialized = false;
  private ready = false;
  private currentSessionName: string | null = null;
  private currentMemberId: string | undefined;
  private currentRoleName = 'orchestrator';
  private currentModelString = 'unknown';
  private child: ChildProcessWithoutNullStreams | null = null;
  private logBuffer: InProcessLogBuffer;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stdoutBuffer = '';
  /**
   * In-flight runs keyed by correlation id, in dispatch order.
   *
   * A single resolve/reject pair used to live here instead. Delivery is
   * fire-and-forget, so two messages dispatched milliseconds apart both wrote
   * that pair: the first run's handlers were overwritten and its promise was
   * orphaned forever, while the second promise got settled with the FIRST
   * run's result. Observed live — a reply meant for one Slack thread was
   * booked against another, the orphan later tripped the IPC deadline and
   * recycled a perfectly healthy child, and the second message's real answer
   * was swallowed by the `?.` on an already-cleared slot.
   */
  private readonly pendingRuns = new Map<string, PendingRun>();
  /** Monotonic source for run correlation ids. */
  private runCounter = 0;
  private pendingInitResolve: (() => void) | null = null;
  private pendingInitReject: ((error: Error) => void) | null = null;
  private storedConfig: CrewlyAgentConfig | null = null;
  /** Guard against overlapping {@link recycleChild} calls. */
  private recycling = false;
  /**
   * Bound signal forwarder so we can register it on parent SIGINT/
   * SIGTERM/SIGHUP and detach the same identity on shutdown. Null
   * when no child is currently attached.
   */
  private signalForwarder: ((signal: NodeJS.Signals) => void) | null = null;

  constructor(sessionHelper: SessionCommandHelper, projectRoot: string) {
    super(sessionHelper, projectRoot);
    this.logBuffer = InProcessLogBuffer.getInstance();
  }

  protected getRuntimeType(): RuntimeType {
    return RUNTIME_TYPES.CREWLY_AGENT as RuntimeType;
  }

  protected async detectRuntimeSpecific(_sessionName: string): Promise<boolean> {
    return this.isReady();
  }

  protected getRuntimeReadyPatterns(): string[] {
    return ['Crewly Agent Ready'];
  }

  protected getRuntimeErrorPatterns(): string[] {
    return [];
  }

  protected getRuntimeExitPatterns(): RegExp[] {
    return [];
  }

  async initializeInProcess(
    sessionName: string,
    config?: Partial<CrewlyAgentConfig> & { memberId?: string },
    roleName?: string,
  ): Promise<void> {
    this.currentSessionName = sessionName;
    this.currentMemberId = config?.memberId;
    this.currentRoleName = roleName || 'orchestrator';

    const systemPrompt = await this.buildEnhancedSystemPrompt(this.currentRoleName);
    const fullConfig: CrewlyAgentConfig = {
      model: config?.model || CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL,
      maxSteps: config?.maxSteps || CREWLY_AGENT_DEFAULTS.MAX_STEPS,
      sessionName,
      apiBaseUrl: config?.apiBaseUrl || CREWLY_AGENT_DEFAULTS.API_BASE_URL,
      systemPrompt: config?.systemPrompt || systemPrompt,
      maxHistoryMessages: config?.maxHistoryMessages || CREWLY_AGENT_DEFAULTS.MAX_HISTORY_MESSAGES,
      compactionThreshold: config?.compactionThreshold || CREWLY_AGENT_DEFAULTS.COMPACTION_THRESHOLD,
      projectPath: config?.projectPath,
    };
    this.storedConfig = fullConfig;
    this.currentModelString = `${fullConfig.model.provider}/${fullConfig.model.modelId}`;

    await this.spawnAgentProcess(fullConfig);

    this.initialized = true;
    this.ready = true;
    this.logBuffer.registerSession(sessionName);
    this.logBuffer.append(sessionName, 'info', `Crewly Agent initialized [external] (${this.currentModelString})`);
    this.startHeartbeat(sessionName);
  }

  async handleMessage(message: string, metadata?: Record<string, string>): Promise<AgentRunResult> {
    if (!this.isReady() || !this.child) {
      throw new Error('Crewly Agent runtime not initialized. Call initializeInProcess() first.');
    }

    const session = this.currentSessionName!;
    let conversationId: string | undefined;
    let cleanMessage = message;
    const chatPrefixMatch = message.match(/^\[(?:G?CHAT):([^\]\s]+)[^\]]*\]\s*/);
    if (chatPrefixMatch) {
      conversationId = chatPrefixMatch[1];
      cleanMessage = message.slice(chatPrefixMatch[0].length);
    }

    this.logBuffer.append(session, 'info', `← Message received (${cleanMessage.length} chars): ${cleanMessage.substring(0, 150)}`);

    // Backstop deadline on the child's IPC reply.
    //
    // This promise settles ONLY when the child writes `result` or `error` to
    // stdout. A child that can no longer write — blocked event loop, broken
    // pipe, SIGSTOP — leaves it pending forever, and because delivery is
    // fire-and-forget the caller's .then/.catch never run either: no log, no
    // status reset, no alert. That is exactly how the orchestrator went
    // silently catatonic for 12 days. The child enforces its own (shorter) run
    // budget, so reaching this deadline means the child itself is gone-but-
    // breathing — hence the recycle.
    const timeoutMs = this.resolveIpcTimeoutMs();
    const runId = `run-${++this.runCounter}-${Date.now().toString(36)}`;

    return await new Promise<AgentRunResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRuns.delete(runId);
        const message =
          `Crewly Agent did not reply within ${timeoutMs}ms — the runtime process is `
          + `alive but unresponsive. Recycling it.`;
        this.logBuffer.append(session, 'error', message);
        this.logger.error('Crewly Agent IPC timeout — recycling wedged runtime', {
          sessionName: session,
          runId,
          timeoutMs,
        });
        // Respawn before rejecting so the session is usable again by the time
        // the caller handles the failure.
        void this.recycleChild();
        reject(new Error(message));
      }, timeoutMs);

      this.pendingRuns.set(runId, {
        resolve: (result) => {
          clearTimeout(timer);
          this.pendingRuns.delete(runId);

          const textPreview = result.text ? result.text.substring(0, 150) : '(no text)';
          this.logBuffer.append(session, 'info', `→ Response (${result.steps} steps, ${result.toolCalls.length} tools): ${textPreview}`);
          // Cache hits are reported alongside the raw counts: prompt caching
          // was off for a long time and nothing surfaced it, because the only
          // numbers ever logged were the ones that look identical either way.
          // A run whose prefix is cached shows most of its input under `cached`;
          // a persistent 0 there means caching silently stopped engaging.
          const cached = result.usage.cachedInput ?? 0;
          const promptTokens = result.usage.input + cached;
          const hitRate = promptTokens > 0 ? Math.round((cached / promptTokens) * 100) : 0;
          this.logBuffer.append(
            session,
            'debug',
            `  Tokens: ${result.usage.input}in/${result.usage.output}out, ${cached} cached (${hitRate}% of prompt)`,
          );
          this.recordTokenUsageIfEnabled(session, result).catch(() => {});
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pendingRuns.delete(runId);
          this.logBuffer.append(session, 'error', `Agent error: ${error.message}`);
          reject(error);
        },
      });

      try {
        this.sendMessage({
          type: 'run',
          runId,
          message: cleanMessage,
          conversationId,
          metadata,
        });
      } catch (sendError) {
        // stdin already gone — fail now rather than idling until the deadline.
        clearTimeout(timer);
        this.pendingRuns.delete(runId);
        reject(sendError instanceof Error ? sendError : new Error(String(sendError)));
      }
    });
  }

  /**
   * Settle the pending run a worker message belongs to.
   *
   * Correlates on `runId` when the child echoes one. Falls back to the OLDEST
   * pending run when it does not — the child processes runs strictly serially
   * (its own queue is FIFO), so the oldest outstanding request is the one being
   * answered. The fallback keeps an older `crewly-agent` binary working.
   *
   * @param runId - Correlation id echoed by the child, if any
   * @param settle - Applied to the matched run's handlers
   * @returns True when a pending run was matched and settled
   */
  private settlePendingRun(
    runId: string | undefined,
    settle: (handlers: PendingRun) => void,
  ): boolean {
    let key = runId;
    if (key === undefined || !this.pendingRuns.has(key)) {
      // Map preserves insertion order — first key is the oldest run.
      key = this.pendingRuns.keys().next().value;
    }
    if (key === undefined) return false;
    const handlers = this.pendingRuns.get(key);
    if (!handlers) return false;
    settle(handlers);
    return true;
  }

  /**
   * Resolve how long the parent waits for the child's IPC reply.
   *
   * Deliberately the child's own run budget plus a grace window, so the child
   * always gets to report its own timeout with proper context first; the parent
   * timer only fires when the child has stopped reporting altogether.
   *
   * @returns Deadline in milliseconds
   */
  private resolveIpcTimeoutMs(): number {
    const modelId = this.storedConfig?.model.modelId ?? '';
    const childBudget =
      CREWLY_AGENT_DEFAULTS.MODEL_TIMEOUT_MS[modelId]
      ?? CREWLY_AGENT_DEFAULTS.MESSAGE_TIMEOUT_MS;
    return childBudget + CREWLY_AGENT_DEFAULTS.IPC_RUN_TIMEOUT_GRACE_MS;
  }

  /**
   * Replace a wedged child process with a fresh one.
   *
   * Without this, a single unresponsive child left the session permanently
   * dead: `handleExit` nulls the child and clears `initialized`, and nothing
   * ever spawned a replacement, so every later message failed the `isReady()`
   * check for the lifetime of the backend process.
   *
   * Concurrent calls are collapsed — the delivery mutex serializes sends, but
   * a process 'error' event can race the IPC deadline.
   *
   * @returns Resolves once the replacement is ready, or after logging a failure
   */
  private async recycleChild(): Promise<void> {
    if (this.recycling) return;
    const config = this.storedConfig;
    const session = this.currentSessionName;
    if (!config || !session) return;

    this.recycling = true;
    try {
      const doomed = this.child;
      // Drop the reference FIRST so the imminent 'exit' event is recognized as
      // belonging to a superseded child and does not clobber the new one.
      this.child = null;
      this.ready = false;
      this.stdoutBuffer = '';
      if (doomed && !doomed.killed) {
        try { doomed.kill('SIGKILL'); } catch { /* already gone */ }
      }

      await this.spawnAgentProcess(config);
      this.initialized = true;
      this.ready = true;
      this.logBuffer.append(session, 'info', 'Crewly Agent runtime recycled after timeout');
      this.logger.info('Crewly Agent runtime recycled', { sessionName: session });
      this.startHeartbeat(session);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logBuffer.append(session, 'error', `Runtime recycle failed: ${errMsg}`);
      this.logger.error('Crewly Agent runtime recycle failed', { sessionName: session, error: errMsg });
    } finally {
      this.recycling = false;
    }
  }

  isReady(): boolean {
    return this.initialized && this.ready && this.child !== null && !this.child.killed;
  }

  shutdown(): void {
    this.initialized = false;
    this.ready = false;
    this.stopHeartbeat();
    this.detachSignalForwarders();

    if (this.currentSessionName) {
      this.logBuffer.append(this.currentSessionName, 'info', 'Crewly Agent shutting down');
    }

    if (this.child && !this.child.killed) {
      try {
        this.sendMessage({ type: 'shutdown' });
      } catch {
        // Ignore shutdown send failures.
      }
      // Give the child a brief grace window to drain stdout + exit
      // cleanly after receiving the shutdown message, then SIGTERM,
      // then SIGKILL. All three are no-ops on an already-exited child.
      const child = this.child;
      setTimeout(() => {
        if (!child.killed) {
          try { child.kill('SIGTERM'); } catch { /* gone */ }
        }
        setTimeout(() => {
          if (!child.killed) {
            try { child.kill('SIGKILL'); } catch { /* gone */ }
          }
        }, 2000).unref();
      }, 500).unref();
    }

    if (this.currentSessionName) {
      this.logBuffer.removeSession(this.currentSessionName);
    }

    this.child = null;
    this.stdoutBuffer = '';
    this.pendingInitResolve = null;
    this.pendingInitReject = null;
    this.rejectAllPendingRuns(new Error('Crewly Agent runtime shut down'));
    this.currentSessionName = null;
    this.storedConfig = null;
  }

  /**
   * Fail every in-flight run with the same cause.
   *
   * Used on teardown paths where the child is gone: leaving any pending run
   * unsettled would strand its caller forever, which is precisely the silent
   * hang this runtime has been hardened against.
   *
   * @param error - Cause reported to every waiting caller
   */
  private rejectAllPendingRuns(error: Error): void {
    // Snapshot first — each reject() deletes its own entry from the map.
    const handlers = [...this.pendingRuns.values()];
    this.pendingRuns.clear();
    for (const h of handlers) {
      try {
        h.reject(error);
      } catch {
        // A caller's rejection handler must not block the rest.
      }
    }
  }

  private async spawnAgentProcess(config: CrewlyAgentConfig): Promise<void> {
    const { command, useShell } = await this.resolveRuntimeCommand();
    const env = {
      ...process.env,
      [ENV_CONSTANTS.CREWLY_SESSION_NAME]: config.sessionName,
      [ENV_CONSTANTS.CREWLY_ROLE]: this.currentRoleName,
      [ENV_CONSTANTS.CREWLY_API_URL]: config.apiBaseUrl,
      [ENV_CONSTANTS.CREWLY_PROJECT_PATH]: config.projectPath || this.projectRoot,
      [ENV_CONSTANTS.CREWLY_INSTALL_DIR]: this.projectRoot,
    };

    // Pre-flight check: when running the default `crewly-agent` binary
    // (no shell, no custom user command), confirm it resolves on PATH
    // BEFORE spawn so we can return a clear error instead of a cryptic
    // exit-code-127 a few hundred milliseconds later. Skip the check
    // when the user supplied a custom shell command — they own that
    // path resolution.
    if (!useShell) {
      const found = await this.lookupOnPath(command, process.env.PATH);
      if (!found) {
        throw new Error(
          `crewly-agent binary not found on PATH. Either:\n` +
          `  • install crewly-agent (npm i crewly-agent / npm i -g crewly-agent),\n` +
          `  • make sure the install directory is on the engine's PATH (e.g. PM2 ecosystem env), or\n` +
          `  • point settings.general.runtimeCommands['crewly-agent'] at the absolute path of an alternate binary.\n` +
          `Engine PATH at spawn time: ${process.env.PATH ?? '(unset)'}`,
        );
      }
    }

    if (useShell) {
      // Custom command path: the user explicitly set
      // settings.general.runtimeCommands['crewly-agent'] to a shell-ready
      // string. Validated against a strict allow-list (see
      // resolveRuntimeCommand) before reaching here.
      const shell = process.env.SHELL || '/bin/bash';
      this.child = spawn(shell, ['-lc', command], {
        cwd: config.projectPath || this.projectRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      // Default path: spawn the binary directly, no shell. Removes
      // any shell-injection surface area (the command string is
      // argv[0], not interpreted).
      this.child = spawn(command, [], {
        cwd: config.projectPath || this.projectRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    }

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    // Bind handlers to THIS child instance. A recycled runtime has an old
    // process whose 'exit' fires after the replacement is already installed;
    // without the identity check in the handlers, that late event would tear
    // down the healthy new child.
    const spawned = this.child;
    spawned.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    spawned.stderr.on('data', (chunk: string) => this.handleStderr(chunk));
    spawned.on('exit', (code, signal) => this.handleExit(spawned, code, signal));
    spawned.on('error', (error) => this.handleProcessError(spawned, error));

    // Forward parent termination signals to the child so PM2 restarts /
    // SIGINT / SIGTERM don't leave the agent process orphaned and
    // reparented to PID 1 (regression of the zombie fix tracked in
    // user-memory session_zombie_fix_progress).
    this.attachSignalForwarders();

    await new Promise<void>((resolve, reject) => {
      this.pendingInitResolve = resolve;
      this.pendingInitReject = reject;
      this.sendMessage({ type: 'init', config });
    });
  }

  /**
   * Resolve the runtime command. Returns the bare binary name (no shell)
   * by default, or, if the user has configured a custom shell command in
   * settings, returns it with `useShell=true` after validating it against
   * a strict allow-list.
   *
   * Allow-list rationale: a shell-ready command is anything matching the
   * shape `<word>[ <flag-or-arg>]*` — no shell metacharacters like
   * `;` `|` `&` `$` backticks. Anything richer is suspicious and is
   * silently dropped (we fall back to the default binary). Settings are
   * user-controlled in principle but flow through HTTP APIs, so we
   * treat the value as semi-trusted input.
   */
  private async resolveRuntimeCommand(): Promise<{ command: string; useShell: boolean }> {
    try {
      const settings = await getSettingsService().getSettings();
      const configured = settings.general.runtimeCommands?.['crewly-agent'];
      if (configured && configured.trim()) {
        const trimmed = configured.trim();

        // Managed sentinels are NOT real shell commands — route them to the
        // managed binary (no shell). This is the root-cause guard for issue
        // #693: the legacy default `'crewly-agent-in-process'` passes the
        // shell allow-list below (no metacharacters), so without this branch
        // it would be shelled out via `sh -lc` to a non-existent command and
        // exit-127. We also treat the managed command name itself as a
        // sentinel so the explicit default never accidentally shells out.
        // Routing through `useShell: false` re-enables the pre-flight
        // `lookupOnPath` check in spawnAgentProcess(), turning a cryptic
        // exit-127 into a clear "binary not found on PATH" error.
        if (
          trimmed === CREWLY_AGENT_MANAGED_COMMAND ||
          (LEGACY_CREWLY_AGENT_SENTINELS as readonly string[]).includes(trimmed)
        ) {
          return { command: await this.resolveManagedBinary(), useShell: false };
        }

        if (CrewlyAgentExternalRuntimeService.SAFE_SHELL_COMMAND_RE.test(trimmed)) {
          return { command: trimmed, useShell: true };
        }
        // Suspicious shell metacharacters — drop silently and use the
        // default. Logging the raw value would echo whatever a malicious
        // settings write tried to plant; log a fingerprint instead.
        const log = LoggerService.getInstance().createComponentLogger(
          'CrewlyAgentExternalRuntimeService',
        );
        log.warn('settings.runtimeCommands["crewly-agent"] rejected — shell metacharacters detected; falling back to default binary');
      }
    } catch {
      // Fall through to default command.
    }
    return { command: await this.resolveManagedBinary(), useShell: false };
  }

  /**
   * Resolve the managed `crewly-agent` runtime to an executable path.
   *
   * Prefers the binary VENDORED inside crewly itself at
   * `packages/crewly-agent/bin/crewly-agent` (relative to the install dir,
   * {@link this.projectRoot}). This is what makes the in-process runtime work
   * out of the box now that crewly-agent lives in the OSS monorepo — it
   * resolves identically whether the engine was started via an npm script
   * (which puts `node_modules/.bin` on PATH) or directly via `node dist/...`
   * (which does not), and whether running from a checkout or an installed
   * npm package (the tarball ships `packages/crewly-agent/`).
   *
   * Falls back to the bare {@link CREWLY_AGENT_MANAGED_COMMAND} name (PATH
   * lookup) for legacy global installs where the vendored copy is absent.
   *
   * @returns Absolute path to the vendored binary, or the bare command name
   */
  private async resolveManagedBinary(): Promise<string> {
    const vendored = path.join(
      this.projectRoot,
      'packages',
      'crewly-agent',
      'bin',
      'crewly-agent',
    );
    const found = await this.lookupOnPath(vendored, undefined);
    return found ?? CREWLY_AGENT_MANAGED_COMMAND;
  }

  /**
   * Allow-list for custom runtime commands. Matches an executable path or
   * name followed by space-separated flags/args, where each token is a
   * combination of letters, digits, and the path-safe punctuation
   * (`. _ / - = :`). Rejects anything containing shell control characters
   * (`; | & $ \` < > ( ) { } [ ]`), newlines, or quotes.
   */
  private static readonly SAFE_SHELL_COMMAND_RE = /^[A-Za-z0-9._\/\-]+( +[A-Za-z0-9._\/\-=:]+)*$/;

  /**
   * Find an executable on the engine's PATH. Returns the absolute path
   * when found, or null when not. Async so we never block the event
   * loop on slow disks. Exported behavior is "is `name` runnable?";
   * we don't care which exact entry won the search.
   */
  private async lookupOnPath(name: string, pathEnv: string | undefined): Promise<string | null> {
    // Absolute or relative path — skip the search, just check existence.
    if (name.includes('/')) {
      try {
        const stat = await fs.stat(name);
        if (stat.isFile()) return name;
      } catch {
        return null;
      }
      return null;
    }
    const dirs = (pathEnv ?? '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // Not in this dir, keep searching.
      }
    }
    return null;
  }

  /**
   * Forward parent SIGINT/SIGTERM/SIGHUP to the spawned child so it gets
   * a chance to flush + exit instead of being orphaned. Idempotent —
   * calling more than once just replaces the previous listeners.
   *
   * Removes its own listeners on `handleExit` so old callbacks don't
   * fire against a recycled `this.child` reference after a restart.
   */
  private attachSignalForwarders(): void {
    if (this.signalForwarder) {
      // Belt-and-braces: shouldn't happen, but clean previous wiring.
      this.detachSignalForwarders();
    }
    const forwarder = (signal: NodeJS.Signals) => {
      if (this.child && !this.child.killed) {
        try {
          this.child.kill(signal);
        } catch {
          // Process already gone — handleExit will run.
        }
      }
    };
    this.signalForwarder = forwarder;
    process.on('SIGINT', forwarder);
    process.on('SIGTERM', forwarder);
    process.on('SIGHUP', forwarder);
  }

  private detachSignalForwarders(): void {
    if (!this.signalForwarder) return;
    process.off('SIGINT', this.signalForwarder);
    process.off('SIGTERM', this.signalForwarder);
    process.off('SIGHUP', this.signalForwarder);
    this.signalForwarder = null;
  }

  private sendMessage(message: ParentMessage): void {
    if (!this.child?.stdin.writable) {
      throw new Error('Crewly Agent process stdin is not writable');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed) as WorkerMessage;
        this.handleWorkerMessage(message);
      } catch {
        if (this.currentSessionName) {
          this.logBuffer.append(this.currentSessionName, 'debug', `[raw] ${trimmed}`);
        }
      }
    }
  }

  private handleWorkerMessage(message: WorkerMessage): void {
    const session = this.currentSessionName;

    switch (message.type) {
      case 'ready':
        if (this.pendingInitResolve) {
          this.pendingInitResolve();
          this.pendingInitResolve = null;
          this.pendingInitReject = null;
        }
        break;
      case 'result': {
        const matched = this.settlePendingRun(message.runId, (h) => h.resolve(message.data));
        if (!matched && session) {
          // A result nobody is waiting for. Previously `?.` swallowed this
          // silently; say so, because it means an answer was computed and
          // then thrown away.
          this.logBuffer.append(
            session,
            'warn',
            `Discarded a result with no matching pending run (runId=${message.runId ?? 'none'})`,
          );
          this.logger.warn('Crewly Agent result had no matching pending run', {
            sessionName: session,
            runId: message.runId ?? null,
          });
        }
        break;
      }
      case 'error': {
        const error = new Error(message.error);
        if (this.pendingInitReject) {
          this.pendingInitReject(error);
          this.pendingInitResolve = null;
          this.pendingInitReject = null;
          break;
        }
        const matched = this.settlePendingRun(message.runId, (h) => h.reject(error));
        if (!matched && session) {
          this.logBuffer.append(session, 'error', message.error);
        }
        break;
      }
      case 'log':
        if (session) {
          this.logBuffer.append(session, message.level, `[external] ${message.message}`);
        }
        break;
      case 'stream':
        if (!session) break;
        if (message.event === 'toolFinish') {
          const { toolName, args, result } = message.data;
          const argsPreview = JSON.stringify(args).substring(0, 120);
          this.logBuffer.append(session, 'info', `tool ${toolName}(${argsPreview})`);
          const resultPreview = result ? JSON.stringify(result).substring(0, 200) : 'void';
          this.logBuffer.append(session, 'debug', `  -> ${resultPreview}`);
        }
        break;
      case 'state':
        break;
      default:
        break;
    }
  }

  private handleStderr(chunk: string): void {
    if (!this.currentSessionName) return;
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        this.logBuffer.append(this.currentSessionName, 'warn', `[stderr] ${trimmed}`);
      }
    }
  }

  /**
   * Handle child process exit.
   *
   * @param child - The process that exited; ignored when it is not the current
   *   one (a superseded child from a recycle)
   * @param code - Exit code, if any
   * @param signal - Terminating signal, if any
   */
  private handleExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) {
      // Superseded child finishing its death throes — its replacement owns the
      // runtime state now.
      return;
    }
    // Clear initialized + detach signal handlers — the child is gone,
    // any tick-aligned work (heartbeat, signal forwarding) referring
    // to it would be writing to a corpse.
    this.initialized = false;
    this.ready = false;
    this.stopHeartbeat();
    this.detachSignalForwarders();
    const error = new Error(`Crewly Agent process exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})`);
    if (this.pendingInitReject) this.pendingInitReject(error);
    this.pendingInitResolve = null;
    this.pendingInitReject = null;
    // EVERY in-flight run dies with the process, not just the newest one.
    this.rejectAllPendingRuns(error);
    if (this.currentSessionName) {
      this.logBuffer.append(this.currentSessionName, 'warn', error.message);
    }
    this.child = null;
  }

  /**
   * Handle a child process-level error (spawn failure, EPIPE, …).
   *
   * @param child - The process that errored; ignored when superseded
   * @param error - The emitted error
   */
  private handleProcessError(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.ready = false;
    if (this.pendingInitReject) this.pendingInitReject(error);
    this.pendingInitResolve = null;
    this.pendingInitReject = null;
    this.rejectAllPendingRuns(error);
    if (this.currentSessionName) {
      this.logBuffer.append(this.currentSessionName, 'error', `Process error: ${error.message}`);
    }
  }

  private async recordTokenUsageIfEnabled(session: string, result: AgentRunResult): Promise<void> {
    const settings = await getSettingsService().getSettings();
    if (!settings.general.tokenTracking) return;

    TokenUsageService.getInstance().recordUsage(
      session,
      session,
      result.usage.input,
      result.usage.output,
      this.currentModelString,
    );
  }

  private startHeartbeat(sessionName: string): void {
    this.stopHeartbeat();

    const interval = setInterval(() => {
      if (!this.initialized) {
        this.stopHeartbeat();
        return;
      }

      updateAgentHeartbeat(sessionName, this.currentMemberId).catch(() => {});
      try {
        PtyActivityTrackerService.getInstance().recordApiActivity(sessionName);
      } catch {
        // Non-fatal.
      }
    }, CREWLY_AGENT_DEFAULTS.HEARTBEAT_INTERVAL_MS);

    interval.unref();
    this.heartbeatTimer = interval;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async loadSystemPrompt(roleName = 'orchestrator'): Promise<string> {
    const promptPath = path.join(this.projectRoot, 'config', 'roles', roleName, 'prompt.md');
    try {
      return await fs.readFile(promptPath, 'utf8');
    } catch {
      return 'You are the Crewly orchestrator agent. Manage teams and delegate tasks.';
    }
  }

  async buildEnhancedSystemPrompt(roleName = 'orchestrator'): Promise<string> {
    const basePrompt = await this.loadSystemPrompt(roleName);
    const sections: string[] = [basePrompt];

    const skillsSummary = await this.loadSkillsCatalogSummary();
    if (skillsSummary) {
      sections.push(`\n## Available Skills\n${skillsSummary}`);
    }

    const addonsSection = await this.loadInstalledAddons();
    if (addonsSection) {
      sections.push(`\n## Installed Addons\n${addonsSection}`);
    }

    sections.push(
      '\n## Instructions\n'
      + 'You have access to the above skills via bash. '
      + 'When asked questions, use your tools to find answers. '
      + 'Maintain conversation context across messages.\n\n'
      + '**IMPORTANT - Output Requirements:**\n'
      + 'Each task must end with a text summary of findings, results, and issues encountered, '
      + 'then call report-status. Never finish with only tool calls and no text output.'
    );

    return sections.join('\n');
  }

  private async loadSkillsCatalogSummary(): Promise<string | null> {
    const catalogPath = path.join(
      homedir(),
      CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
      CREWLY_CONSTANTS.PATHS.SKILLS_DIR,
      CREWLY_CONSTANTS.PATHS.SKILLS_CATALOG_FILE,
    );

    try {
      const content = await fs.readFile(catalogPath, 'utf8');
      const lines = content.split('\n');
      const maxLines = 50;
      const summary = lines.slice(0, maxLines).join('\n');
      const truncated = lines.length > maxLines ? `\n... (${lines.length - maxLines} more lines)` : '';
      return summary + truncated;
    } catch {
      return null;
    }
  }

  private async loadInstalledAddons(): Promise<string | null> {
    const addonsDir = path.join(
      homedir(),
      CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
      ADDON_CONSTANTS.PATHS.ADDONS_DIR,
    );

    let entries: string[];
    try {
      entries = await fs.readdir(addonsDir);
    } catch {
      return null;
    }

    const addonLines: string[] = [];
    for (const entry of entries) {
      const manifestPath = path.join(addonsDir, entry, ADDON_CONSTANTS.MANIFEST_FILE);
      try {
        const raw = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw) as { name?: string; version?: string; description?: string };
        const name = manifest.name || entry;
        const version = manifest.version || 'unknown';
        const desc = manifest.description ? `: ${manifest.description}` : '';
        addonLines.push(`- ${name} v${version}${desc}`);
      } catch {
        // Skip directories without valid manifest.
      }
    }

    return addonLines.length > 0 ? addonLines.join('\n') : null;
  }
}
