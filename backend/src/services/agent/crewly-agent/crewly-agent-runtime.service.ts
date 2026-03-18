/**
 * Crewly Agent Runtime Service
 *
 * Concrete RuntimeAgentService subclass for the in-process Crewly Agent.
 * Unlike PTY-based runtimes (Claude Code, Gemini CLI), this runtime runs
 * entirely inside the Node.js process using the Vercel AI SDK.
 *
 * No tmux session, no shell commands — messages are routed directly to
 * the AgentRunnerService.handleMessage() method.
 *
 * @module services/agent/crewly-agent/crewly-agent-runtime.service
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { RuntimeAgentService } from '../runtime-agent.service.abstract.js';
import { AgentRunnerService } from './agent-runner.service.js';
import { RUNTIME_TYPES, CREWLY_CONSTANTS, ADDON_CONSTANTS, type RuntimeType } from '../../../constants.js';
import { homedir } from 'os';
import type { CrewlyAgentConfig, AgentRunResult, StreamingEventCallbacks } from './types.js';
import { CREWLY_AGENT_DEFAULTS } from './types.js';
import { SessionCommandHelper } from '../../session/index.js';
import { InProcessLogBuffer } from './in-process-log-buffer.js';
import { RateLimiter } from './rate-limiter.js';
import { updateAgentHeartbeat } from '../agent-heartbeat.service.js';
import { PtyActivityTrackerService } from '../pty-activity-tracker.service.js';
import { TokenUsageService } from '../../monitoring/token-usage.service.js';
import { getSettingsService } from '../../settings/settings.service.js';


/**
 * In-process Crewly Agent runtime powered by AI SDK generateText.
 *
 * Key differences from PTY-based runtimes:
 * - No tmux session needed — runs in-process
 * - Messages routed via handleMessage() instead of PTY write
 * - System prompt loaded from config/roles/orchestrator/prompt.md
 * - Ready immediately after initialization (no CLI startup wait)
 *
 * @example
 * ```typescript
 * const runtime = new CrewlyAgentRuntimeService(sessionHelper, projectRoot);
 * await runtime.initializeInProcess('crewly-orc');
 * const result = await runtime.handleMessage('Check all team statuses');
 * ```
 */
export class CrewlyAgentRuntimeService extends RuntimeAgentService {
  private agentRunner: AgentRunnerService | null = null;
  private initialized = false;
  private currentSessionName: string | null = null;
  private currentMemberId: string | undefined;
  private currentModelString: string = 'unknown';
  private logBuffer: InProcessLogBuffer;
  private rateLimiter: RateLimiter<AgentRunResult>;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** AbortController for the currently executing message — enables external abort */
  private messageAbortController: AbortController | null = null;

  constructor(sessionHelper: SessionCommandHelper, projectRoot: string) {
    super(sessionHelper, projectRoot);
    this.logBuffer = InProcessLogBuffer.getInstance();
    this.rateLimiter = new RateLimiter<AgentRunResult>();
  }

  // ===== Abstract method implementations =====

  /**
   * Get the runtime type identifier.
   *
   * @returns 'crewly-agent' runtime type constant
   */
  protected getRuntimeType(): RuntimeType {
    return RUNTIME_TYPES.CREWLY_AGENT as RuntimeType;
  }

  /**
   * Detect if the Crewly Agent runtime is running.
   * For in-process runtime, this checks if the AgentRunner is initialized.
   *
   * @param _sessionName - Session name (unused for in-process runtime)
   * @returns True if the agent runner is initialized
   */
  protected async detectRuntimeSpecific(_sessionName: string): Promise<boolean> {
    return this.initialized && this.agentRunner !== null && this.agentRunner.isInitialized();
  }

  /**
   * Get patterns that indicate the runtime is ready.
   * For in-process runtime, there are no terminal patterns — readiness is checked programmatically.
   *
   * @returns Empty array (no terminal output to match)
   */
  protected getRuntimeReadyPatterns(): string[] {
    return ['Crewly Agent Ready'];
  }

  /**
   * Get patterns that indicate runtime errors.
   *
   * @returns Empty array (errors are thrown as exceptions, not terminal patterns)
   */
  protected getRuntimeErrorPatterns(): string[] {
    return [];
  }

  /**
   * Get patterns that indicate the runtime has exited.
   *
   * @returns Empty array (in-process runtime doesn't exit via terminal)
   */
  protected getRuntimeExitPatterns(): RegExp[] {
    return [];
  }

  // ===== In-process lifecycle methods =====

  /**
   * Initialize the in-process agent runtime.
   *
   * Loads the system prompt from config/roles/orchestrator/prompt.md,
   * creates the AgentRunnerService, and initializes the model.
   *
   * @param sessionName - Session name for this agent instance
   * @param config - Optional partial config overrides
   * @param roleName - Role name for system prompt lookup (default: 'orchestrator')
   */
  async initializeInProcess(
    sessionName: string,
    config?: Partial<CrewlyAgentConfig>,
    roleName?: string,
  ): Promise<void> {
    this.currentSessionName = sessionName;
    this.currentMemberId = config?.memberId;

    // Build enhanced system prompt with skills and addon awareness
    const systemPrompt = await this.buildEnhancedSystemPrompt(roleName || 'orchestrator');

    // Build full config with defaults
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

    this.agentRunner = new AgentRunnerService(fullConfig);
    try {
      await this.agentRunner.initialize();
    } catch (error) {
      // Clean up on initialization failure to prevent partial state
      this.agentRunner = null;
      this.currentSessionName = null;
      throw error;
    }
    this.initialized = true;
    this.currentModelString = `${fullConfig.model.provider}/${fullConfig.model.modelId}`;

    // Start periodic heartbeat to keep in-process agent marked active
    this.startHeartbeat(sessionName);

    // Register in-process session for frontend terminal visibility
    this.logBuffer.registerSession(sessionName);
    this.logBuffer.append(sessionName, 'info', `Crewly Agent initialized (${this.currentModelString})`);

    this.logger.info('Crewly Agent runtime initialized', {
      sessionName,
      model: `${fullConfig.model.provider}/${fullConfig.model.modelId}`,
      maxSteps: fullConfig.maxSteps,
    });
  }

  /**
   * Handle an incoming message by routing it to the AgentRunner.
   *
   * This is the primary entry point for message delivery, replacing
   * the PTY write path used by other runtimes.
   *
   * @param message - The message to process
   * @param metadata - Optional metadata (e.g. Slack channelId, threadTs)
   * @returns Agent run result with text response and tool call records
   * @throws Error if the runtime is not initialized
   */
  async handleMessage(message: string, metadata?: Record<string, string>): Promise<AgentRunResult> {
    if (!this.agentRunner || !this.initialized) {
      throw new Error('Crewly Agent runtime not initialized. Call initializeInProcess() first.');
    }

    const session = this.currentSessionName!;

    // Extract conversationId from [CHAT:xxx] or [GCHAT:xxx ...] prefix if present
    let conversationId: string | undefined;
    let cleanMessage = message;
    const chatPrefixMatch = message.match(/^\[(?:G?CHAT):([^\]\s]+)[^\]]*\]\s*/);
    if (chatPrefixMatch) {
      conversationId = chatPrefixMatch[1];
      cleanMessage = message.slice(chatPrefixMatch[0].length);
      this.logger.debug('Extracted conversationId from message prefix', {
        sessionName: session,
        conversationId,
      });
    }

    const queueLen = this.rateLimiter.getQueueLength();
    const msgPreview = cleanMessage.length <= 120
      ? `"${cleanMessage}"`
      : `"${cleanMessage.substring(0, 50)}...${cleanMessage.substring(cleanMessage.length - 50)}"`;
    this.logBuffer.append(session, 'info', `← Message received (${cleanMessage.length} chars${conversationId ? `, conv:${conversationId}` : ''}${queueLen > 0 ? `, queue:${queueLen}` : ''}): ${msgPreview}`);

    this.logger.debug('Handling message via rate limiter', {
      sessionName: session,
      messageLength: cleanMessage.length,
      historyLength: this.agentRunner.getHistoryLength(),
      conversationId,
      queueLength: queueLen,
      requestsInWindow: this.rateLimiter.getRequestCountInWindow(),
    });

    // Route through rate limiter for throttling, coalescing, and 429 retry
    const result = await this.rateLimiter.enqueue(
      cleanMessage,
      metadata,
      async (msg, meta) => {
        return this.executeMessage(session, msg, conversationId, meta);
      },
    );

    return result;
  }

  /**
   * Execute a single message against the AgentRunner.
   *
   * Separated from handleMessage to allow the rate limiter to wrap this
   * with throttling, coalescing, and 429 retry logic.
   *
   * @param session - Session name
   * @param cleanMessage - Message content (prefix already stripped)
   * @param conversationId - Optional conversation ID
   * @param metadata - Optional metadata
   * @returns Agent run result
   */
  private async executeMessage(
    session: string,
    cleanMessage: string,
    conversationId?: string,
    metadata?: Record<string, string>,
  ): Promise<AgentRunResult> {
    const HARD_TIMEOUT_MS = CREWLY_AGENT_DEFAULTS.MESSAGE_TIMEOUT_MS;
    const SOFT_WARNING_MS = CREWLY_AGENT_DEFAULTS.MESSAGE_SOFT_WARNING_MS;

    // Execution tracking for enhanced timeout diagnostics
    const executionTracker = {
      phase: 'queued' as string,
      currentTool: null as string | null,
      toolCallsCompleted: [] as string[],
      startedAt: new Date(),
      lastActivityAt: new Date(),
      messagePreview: cleanMessage.length <= 100
        ? cleanMessage
        : `${cleanMessage.substring(0, 50)}...${cleanMessage.substring(cleanMessage.length - 50)}`,
    };

    // Soft warning timer — logs if processing exceeds threshold but does NOT kill it.
    const warningTimer = setTimeout(() => {
      executionTracker.lastActivityAt = new Date();
      this.logger.warn(`Message processing exceeding ${SOFT_WARNING_MS / 1000}s (still running)`, {
        sessionName: session,
        phase: executionTracker.phase,
        toolCallsCompleted: executionTracker.toolCallsCompleted.length,
        messagePreview: cleanMessage.substring(0, 100),
      });
    }, SOFT_WARNING_MS);

    // Hard timeout — AbortController kills the streamText/generateText call after MESSAGE_TIMEOUT_MS
    const abortController = new AbortController();
    this.messageAbortController = abortController;
    const hardTimer = setTimeout(() => {
      abortController.abort();
    }, HARD_TIMEOUT_MS);

    // Text chunk buffer — collects streaming text and flushes on step boundaries
    let textChunkBuffer = '';

    // Build streaming callbacks that write to InProcessLogBuffer in real-time
    const streamingCallbacks: StreamingEventCallbacks = {
      onTextChunk: (chunk: string) => {
        if (chunk.length > 0) {
          executionTracker.lastActivityAt = new Date();
          executionTracker.phase = 'model-thinking';
          textChunkBuffer += chunk;
        }
      },
      onToolCallStart: (toolName: string, _args: Record<string, unknown>) => {
        executionTracker.phase = 'tool-calling';
        executionTracker.currentTool = toolName;
        executionTracker.lastActivityAt = new Date();
      },
      onToolCallFinish: (toolName: string, args: Record<string, unknown>, result: unknown, _durationMs: number) => {
        executionTracker.toolCallsCompleted.push(toolName);
        executionTracker.currentTool = null;
        executionTracker.lastActivityAt = new Date();
        const argsPreview = JSON.stringify(args).substring(0, 120);
        this.logBuffer.append(session, 'info', `🔧 ${toolName}(${argsPreview})`);

        // For bash_exec, show the command as an extra log line for readability
        if (toolName === 'bash_exec' && args.command) {
          const cmdPreview = String(args.command).substring(0, 200);
          this.logBuffer.append(session, 'info', `  $ ${cmdPreview}`);
        }

        const resultPreview = result ? JSON.stringify(result).substring(0, 200) : 'void';
        this.logBuffer.append(session, 'debug', `  → ${resultPreview}`);
      },
      onStepFinish: (stepIndex: number, hasToolCalls: boolean) => {
        executionTracker.lastActivityAt = new Date();

        // Flush buffered text at each step boundary
        if (textChunkBuffer.trim().length > 0) {
          // Truncate very long text to keep logs readable
          const text = textChunkBuffer.trim();
          const preview = text.length > 500 ? text.substring(0, 500) + '...' : text;
          this.logBuffer.append(session, 'info', `💬 ${preview}`);
          textChunkBuffer = '';
        }

        if (!hasToolCalls) {
          executionTracker.phase = 'model-thinking';
        }
      },
    };

    try {
      executionTracker.phase = 'model-thinking';
      const result = await Promise.race([
        this.agentRunner!.run(cleanMessage, conversationId, metadata, {
          abortSignal: abortController.signal,
          streaming: streamingCallbacks,
        }),
        new Promise<never>((_resolve, reject) => {
          abortController.signal.addEventListener('abort', () => {
            const elapsed = Date.now() - executionTracker.startedAt.getTime();
            const lastActivity = Date.now() - executionTracker.lastActivityAt.getTime();
            const toolsSummary = executionTracker.toolCallsCompleted.length > 0
              ? executionTracker.toolCallsCompleted.join(', ')
              : 'none';
            const currentToolInfo = executionTracker.currentTool
              ? `Current tool: ${executionTracker.currentTool}. `
              : '';
            reject(new Error(
              `Message processing timed out after ${HARD_TIMEOUT_MS}ms. `
              + `Phase: ${executionTracker.phase}. `
              + `${currentToolInfo}`
              + `Tools completed: [${toolsSummary}] (${executionTracker.toolCallsCompleted.length} total). `
              + `Last activity: ${Math.round(lastActivity / 1000)}s ago. `
              + `Total elapsed: ${Math.round(elapsed / 1000)}s. `
              + `Message: "${executionTracker.messagePreview}"`
            ));
          }, { once: true });
        }),
      ]);

      clearTimeout(warningTimer);
      clearTimeout(hardTimer);
      this.messageAbortController = null;

      // Flush any remaining buffered text after the run completes
      if (textChunkBuffer.trim().length > 0) {
        const text = textChunkBuffer.trim();
        const preview = text.length > 500 ? text.substring(0, 500) + '...' : text;
        this.logBuffer.append(session, 'info', `💬 ${preview}`);
        textChunkBuffer = '';
      }

      // Tool calls already logged via streaming callbacks (onToolCallStart/Finish).
      // Only log tool calls retroactively if generateText path was used (test mock).
      if (this.agentRunner!._generateTextFn) {
        for (const tc of result.toolCalls) {
          executionTracker.toolCallsCompleted.push(tc.toolName);
          const argsPreview = JSON.stringify(tc.args).substring(0, 120);
          this.logBuffer.append(session, 'info', `🔧 ${tc.toolName}(${argsPreview})`);
          const resultPreview = tc.result ? JSON.stringify(tc.result).substring(0, 200) : 'void';
          this.logBuffer.append(session, 'debug', `  → ${resultPreview}`);
        }
      }

      // Log response summary
      executionTracker.phase = 'complete';
      const textPreview = result.text ? result.text.substring(0, 150) : '(no text)';
      this.logBuffer.append(session, 'info', `→ Response (${result.steps} steps, ${result.toolCalls.length} tools): ${textPreview}`);
      this.logBuffer.append(session, 'debug', `  Tokens: ${result.usage.input}in/${result.usage.output}out`);

      this.logger.info('Message processed', {
        sessionName: session,
        steps: result.steps,
        toolCalls: result.toolCalls.length,
        usage: result.usage,
        finishReason: result.finishReason,
      });

      // Record token usage when tracking is enabled
      this.recordTokenUsageIfEnabled(session, result).catch(() => {
        // Non-critical — don't let tracking errors affect message flow
      });

      return result;
    } catch (error) {
      clearTimeout(warningTimer);
      clearTimeout(hardTimer);
      this.messageAbortController = null;
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logBuffer.append(session, 'error', `Agent error: ${errMsg}`);
      throw error;
    }
  }

  /**
   * Record token usage to the TokenUsageService if tracking is enabled in settings.
   *
   * @param session - Session name
   * @param result - Agent run result containing usage data
   */
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

  /**
   * Check if the runtime is initialized and ready to handle messages.
   *
   * @returns True if initializeInProcess() has been called successfully
   */
  isReady(): boolean {
    return this.initialized && this.agentRunner !== null && this.agentRunner.isInitialized();
  }

  /**
   * Abort the currently executing message processing.
   *
   * Cancels the active model call, terminates running tool processes,
   * and returns partial results where possible. Safe to call at any time —
   * returns false if no run is in progress.
   *
   * @returns True if an active run was aborted, false if nothing was running
   */
  abortCurrentRun(): boolean {
    if (!this.messageAbortController) {
      return false;
    }

    const session = this.currentSessionName;
    this.messageAbortController.abort();
    this.messageAbortController = null;

    // Also tell the runner to abort (for cases where the runner has its own abort)
    if (this.agentRunner) {
      this.agentRunner.abortCurrentRun();
    }

    if (session) {
      this.logBuffer.append(session, 'warn', '⚠️ Run aborted by user');
    }

    this.logger.info('Agent run aborted', { sessionName: session });
    return true;
  }

  /**
   * Get the current agent runner instance (for inspection/testing).
   *
   * @returns The AgentRunnerService instance, or null if not initialized
   */
  getAgentRunner(): AgentRunnerService | null {
    return this.agentRunner;
  }

  /**
   * Get the session name this runtime was initialized with.
   *
   * @returns Session name string, or null if not initialized
   */
  getSessionName(): string | null {
    return this.currentSessionName;
  }

  /**
   * Shut down the in-process runtime.
   * Clears the agent runner and resets state.
   */
  shutdown(): void {
    this.logger.info('Shutting down Crewly Agent runtime', {
      sessionName: this.currentSessionName,
    });

    // Mark as not initialized first to reject new messages immediately
    this.initialized = false;

    // Stop heartbeat timer
    this.stopHeartbeat();

    if (this.currentSessionName) {
      this.logBuffer.append(this.currentSessionName, 'info', 'Crewly Agent shutting down');
      this.logBuffer.removeSession(this.currentSessionName);
    }
    this.rateLimiter.reset();
    this.agentRunner = null;
    this.currentSessionName = null;
  }

  // ===== Private helpers =====

  /**
   * Start periodic heartbeat to keep the in-process agent marked as active.
   *
   * Unlike PTY-based agents that get implicit heartbeats from every API call
   * via the middleware, in-process agents only touch the API during message
   * processing. Between messages, this timer ensures the agent stays registered
   * as active in teamAgentStatus.json and the PtyActivityTracker.
   *
   * @param sessionName - Session name to heartbeat for
   */
  private startHeartbeat(sessionName: string): void {
    this.stopHeartbeat();

    const interval = setInterval(() => {
      if (!this.initialized) {
        this.stopHeartbeat();
        return;
      }

      // Update heartbeat in teamAgentStatus.json (fire-and-forget)
      // Pass memberId so the entry is keyed by member ID (not session name)
      updateAgentHeartbeat(sessionName, this.currentMemberId).catch((err) => {
        this.logger.debug('Heartbeat update failed (non-critical)', {
          sessionName,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // Record API activity so PtyActivityTracker doesn't mark us idle
      try {
        PtyActivityTrackerService.getInstance().recordApiActivity(sessionName);
      } catch {
        // PtyActivityTracker may not be initialized yet
      }
    }, CREWLY_AGENT_DEFAULTS.HEARTBEAT_INTERVAL_MS);

    // Don't keep the process alive just for heartbeat
    interval.unref();
    this.heartbeatTimer = interval;

    this.logger.debug('In-process heartbeat started', {
      sessionName,
      intervalMs: CREWLY_AGENT_DEFAULTS.HEARTBEAT_INTERVAL_MS,
    });
  }

  /**
   * Stop the periodic heartbeat timer.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Load the base system prompt for a given role from file.
   *
   * @param roleName - Role name (maps to config/roles/{roleName}/prompt.md)
   * @returns System prompt content, or a generic fallback if file is missing
   */
  private async loadSystemPrompt(roleName: string = 'orchestrator'): Promise<string> {
    const promptPath = path.join(this.projectRoot, 'config', 'roles', roleName, 'prompt.md');
    try {
      const content = await fs.readFile(promptPath, 'utf8');
      this.logger.debug('System prompt loaded', {
        promptPath,
        length: content.length,
      });
      return content;
    } catch (error) {
      this.logger.warn('Failed to load system prompt, using fallback', {
        promptPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'You are the Crewly orchestrator agent. Manage teams and delegate tasks.';
    }
  }

  /**
   * Build an enhanced system prompt that includes the base role prompt
   * plus awareness of available skills and installed addons.
   *
   * Sections appended:
   * 1. Available Skills - summary from AGENT_SKILLS_CATALOG.md
   * 2. Installed Addons - names and versions from each addon's manifest.json
   * 3. Instructions - basic behavioral guidance for the agent
   *
   * All file reads are wrapped in try/catch so missing files are gracefully skipped.
   *
   * @param roleName - Role name for the base prompt lookup
   * @returns Combined system prompt string
   */
  async buildEnhancedSystemPrompt(roleName: string = 'orchestrator'): Promise<string> {
    const basePrompt = await this.loadSystemPrompt(roleName);
    const sections: string[] = [basePrompt];

    // --- Available Skills ---
    const skillsSummary = await this.loadSkillsCatalogSummary();
    if (skillsSummary) {
      sections.push(`\n## Available Skills\n${skillsSummary}`);
    }

    // --- Installed Addons ---
    const addonsSection = await this.loadInstalledAddons();
    if (addonsSection) {
      sections.push(`\n## Installed Addons\n${addonsSection}`);
    }

    // --- Instructions ---
    sections.push(
      '\n## Instructions\n'
      + 'You have access to the above skills via bash. '
      + 'When asked questions, use your tools to find answers. '
      + 'Maintain conversation context across messages.'
    );

    return sections.join('\n');
  }

  /**
   * Load and summarize the agent skills catalog file.
   *
   * Reads ~/.crewly/skills/AGENT_SKILLS_CATALOG.md and extracts up to
   * the first 50 lines as a summary. Returns null if the file is missing.
   *
   * @returns Skills summary string, or null if unavailable
   */
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
      this.logger.debug('Skills catalog loaded', { catalogPath, totalLines: lines.length });
      return summary + truncated;
    } catch {
      this.logger.debug('Skills catalog not found, skipping', { catalogPath });
      return null;
    }
  }

  /**
   * Scan installed addons and build a summary list.
   *
   * Reads manifest.json from each subdirectory under the addons directory
   * and returns a markdown list of addon names, versions, and descriptions.
   * Returns null if no addons are installed.
   *
   * @returns Addon list string, or null if no addons found
   */
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
      this.logger.debug('Addons directory not found, skipping', { addonsDir });
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
        // Skip directories without valid manifest
      }
    }

    if (addonLines.length === 0) {
      return null;
    }

    this.logger.debug('Installed addons loaded', { count: addonLines.length });
    return addonLines.join('\n');
  }
}
