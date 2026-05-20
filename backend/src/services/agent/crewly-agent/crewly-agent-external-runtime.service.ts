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
  ENV_CONSTANTS,
  RUNTIME_TYPES,
  type RuntimeType,
} from '../../../constants.js';

type ParentMessage =
  | { type: 'init'; config: CrewlyAgentConfig }
  | { type: 'run'; message: string; conversationId?: string; metadata?: Record<string, string> }
  | { type: 'abort' }
  | { type: 'get-state' }
  | { type: 'shutdown' };

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; data: AgentRunResult }
  | { type: 'error'; error: string; code?: string }
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
  private pendingRunResolve: ((result: AgentRunResult) => void) | null = null;
  private pendingRunReject: ((error: Error) => void) | null = null;
  private pendingInitResolve: (() => void) | null = null;
  private pendingInitReject: ((error: Error) => void) | null = null;
  private storedConfig: CrewlyAgentConfig | null = null;
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

    return await new Promise<AgentRunResult>((resolve, reject) => {
      this.pendingRunResolve = async (result) => {
        this.pendingRunResolve = null;
        this.pendingRunReject = null;

        const textPreview = result.text ? result.text.substring(0, 150) : '(no text)';
        this.logBuffer.append(session, 'info', `→ Response (${result.steps} steps, ${result.toolCalls.length} tools): ${textPreview}`);
        this.logBuffer.append(session, 'debug', `  Tokens: ${result.usage.input}in/${result.usage.output}out`);
        this.recordTokenUsageIfEnabled(session, result).catch(() => {});
        resolve(result);
      };

      this.pendingRunReject = (error) => {
        this.pendingRunResolve = null;
        this.pendingRunReject = null;
        this.logBuffer.append(session, 'error', `Agent error: ${error.message}`);
        reject(error);
      };

      this.sendMessage({
        type: 'run',
        message: cleanMessage,
        conversationId,
        metadata,
      });
    });
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
    this.pendingRunResolve = null;
    this.pendingRunReject = null;
    this.currentSessionName = null;
    this.storedConfig = null;
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
    this.child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => this.handleStderr(chunk));
    this.child.on('exit', (code, signal) => this.handleExit(code, signal));
    this.child.on('error', (error) => this.handleProcessError(error));

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
    return { command: 'crewly-agent', useShell: false };
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
      case 'result':
        this.pendingRunResolve?.(message.data);
        break;
      case 'error': {
        const error = new Error(message.error);
        if (this.pendingInitReject) {
          this.pendingInitReject(error);
          this.pendingInitResolve = null;
          this.pendingInitReject = null;
        } else if (this.pendingRunReject) {
          this.pendingRunReject(error);
        } else if (session) {
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

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    // Clear initialized + detach signal handlers — the child is gone,
    // any tick-aligned work (heartbeat, signal forwarding) referring
    // to it would be writing to a corpse.
    this.initialized = false;
    this.ready = false;
    this.stopHeartbeat();
    this.detachSignalForwarders();
    const error = new Error(`Crewly Agent process exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})`);
    if (this.pendingInitReject) this.pendingInitReject(error);
    if (this.pendingRunReject) this.pendingRunReject(error);
    this.pendingInitResolve = null;
    this.pendingInitReject = null;
    this.pendingRunResolve = null;
    this.pendingRunReject = null;
    if (this.currentSessionName) {
      this.logBuffer.append(this.currentSessionName, 'warn', error.message);
    }
    this.child = null;
  }

  private handleProcessError(error: Error): void {
    this.ready = false;
    if (this.pendingInitReject) this.pendingInitReject(error);
    if (this.pendingRunReject) this.pendingRunReject(error);
    this.pendingInitResolve = null;
    this.pendingInitReject = null;
    this.pendingRunResolve = null;
    this.pendingRunReject = null;
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
