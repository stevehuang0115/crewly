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

    if (this.currentSessionName) {
      this.logBuffer.append(this.currentSessionName, 'info', 'Crewly Agent shutting down');
    }

    if (this.child && !this.child.killed) {
      try {
        this.sendMessage({ type: 'shutdown' });
      } catch {
        // Ignore shutdown send failures.
      }
      this.child.kill();
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
    const command = await this.resolveRuntimeCommand();
    const shell = process.env.SHELL || '/bin/bash';
    const env = {
      ...process.env,
      [ENV_CONSTANTS.CREWLY_SESSION_NAME]: config.sessionName,
      [ENV_CONSTANTS.CREWLY_ROLE]: this.currentRoleName,
      [ENV_CONSTANTS.CREWLY_API_URL]: config.apiBaseUrl,
      [ENV_CONSTANTS.CREWLY_PROJECT_PATH]: config.projectPath || this.projectRoot,
      [ENV_CONSTANTS.CREWLY_INSTALL_DIR]: this.projectRoot,
    };

    this.child = spawn(shell, ['-lc', command], {
      cwd: config.projectPath || this.projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => this.handleStderr(chunk));
    this.child.on('exit', (code, signal) => this.handleExit(code, signal));
    this.child.on('error', (error) => this.handleProcessError(error));

    await new Promise<void>((resolve, reject) => {
      this.pendingInitResolve = resolve;
      this.pendingInitReject = reject;
      this.sendMessage({ type: 'init', config });
    });
  }

  private async resolveRuntimeCommand(): Promise<string> {
    try {
      const settings = await getSettingsService().getSettings();
      const configured = settings.general.runtimeCommands?.['crewly-agent'];
      if (configured && configured.trim()) {
        return configured.trim();
      }
    } catch {
      // Fall through to default command.
    }
    return 'crewly-agent';
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
    this.ready = false;
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
