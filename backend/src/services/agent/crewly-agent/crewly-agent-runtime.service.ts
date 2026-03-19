/**
 * Crewly Agent Runtime Service
 *
 * Concrete RuntimeAgentService subclass for the Crewly Agent.
 * Supports two execution modes:
 * - **In-process** (default): AgentRunner runs in the main Node.js process
 * - **Worker process**: AgentRunner runs in a child process via fork(),
 *   enabling hot-reload and crash isolation
 *
 * @module services/agent/crewly-agent/crewly-agent-runtime.service
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { fork, type ChildProcess } from 'child_process';
// fileURLToPath used for ESM __dirname equivalent — lazy-loaded to avoid CJS issues
import { RuntimeAgentService } from '../runtime-agent.service.abstract.js';
import { AgentRunnerService } from './agent-runner.service.js';
import { RUNTIME_TYPES, CREWLY_CONSTANTS, ADDON_CONSTANTS, type RuntimeType } from '../../../constants.js';
import { homedir } from 'os';
import type { CrewlyAgentConfig, AgentRunResult, StreamingEventCallbacks } from './types.js';
import { CREWLY_AGENT_DEFAULTS } from './types.js';
import type { ParentMessage, WorkerMessage } from './agent-worker.js';
import { SessionCommandHelper } from '../../session/index.js';
import { InProcessLogBuffer } from './in-process-log-buffer.js';
import { RateLimiter } from './rate-limiter.js';
import { updateAgentHeartbeat } from '../agent-heartbeat.service.js';
import { PtyActivityTrackerService } from '../pty-activity-tracker.service.js';
import { TokenUsageService } from '../../monitoring/token-usage.service.js';
import { getSettingsService } from '../../settings/settings.service.js';


/**
 * Crewly Agent runtime with optional worker process isolation.
 *
 * Supports two modes:
 * - **In-process** (default): AgentRunner runs directly in the main process
 * - **Worker process** (`useWorkerProcess: true`): AgentRunner runs in a
 *   forked child process, enabling hot-reload and crash isolation
 *
 * @example
 * ```typescript
 * // In-process mode (default)
 * const runtime = new CrewlyAgentRuntimeService(sessionHelper, projectRoot);
 * await runtime.initializeInProcess('crewly-orc');
 *
 * // Worker process mode
 * const runtime = new CrewlyAgentRuntimeService(sessionHelper, projectRoot);
 * await runtime.initializeInProcess('crewly-orc', { useWorkerProcess: true });
 *
 * // Hot-reload: restart worker with fresh code, preserving session
 * await runtime.hotReload();
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

  // ===== Worker process fields =====

  /** Whether this instance uses a worker process instead of in-process execution */
  private useWorkerProcess = false;
  /** The forked worker child process */
  private workerProcess: ChildProcess | null = null;
  /** Stored config for hot-reload — needed to re-init the worker */
  private storedConfig: CrewlyAgentConfig | null = null;
  /** Pending promise resolver for the current worker run */
  private workerRunResolve: ((result: AgentRunResult) => void) | null = null;
  /** Pending promise rejector for the current worker run */
  private workerRunReject: ((error: Error) => void) | null = null;
  /** Whether the worker is currently processing a message */
  private workerProcessing = false;

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
    if (this.useWorkerProcess) {
      return this.initialized && this.workerProcess !== null && this.workerProcess.connected;
    }
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
   * Initialize the agent runtime.
   *
   * Loads the system prompt from config/roles/orchestrator/prompt.md,
   * creates the AgentRunnerService (in-process or worker), and initializes the model.
   *
   * @param sessionName - Session name for this agent instance
   * @param config - Optional partial config overrides. Set `useWorkerProcess: true` to run in a child process.
   * @param roleName - Role name for system prompt lookup (default: 'orchestrator')
   */
  async initializeInProcess(
    sessionName: string,
    config?: Partial<CrewlyAgentConfig> & { useWorkerProcess?: boolean },
    roleName?: string,
  ): Promise<void> {
    this.currentSessionName = sessionName;
    this.currentMemberId = config?.memberId;
    this.useWorkerProcess = config?.useWorkerProcess ?? false;

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

    // Store config for hot-reload
    this.storedConfig = fullConfig;

    if (this.useWorkerProcess) {
      await this.initializeWorker(fullConfig);
    } else {
      this.agentRunner = new AgentRunnerService(fullConfig);
      try {
        await this.agentRunner.initialize();
      } catch (error) {
        // Clean up on initialization failure to prevent partial state
        this.agentRunner = null;
        this.currentSessionName = null;
        throw error;
      }
    }

    this.initialized = true;
    this.currentModelString = `${fullConfig.model.provider}/${fullConfig.model.modelId}`;

    // Start periodic heartbeat to keep in-process agent marked active
    this.startHeartbeat(sessionName);

    // Register in-process session for frontend terminal visibility
    this.logBuffer.registerSession(sessionName);
    const mode = this.useWorkerProcess ? 'worker' : 'in-process';
    this.logBuffer.append(sessionName, 'info', `Crewly Agent initialized [${mode}] (${this.currentModelString})`);

    this.logger.info('Crewly Agent runtime initialized', {
      sessionName,
      mode,
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
    if (!this.initialized) {
      throw new Error('Crewly Agent runtime not initialized. Call initializeInProcess() first.');
    }
    if (!this.useWorkerProcess && !this.agentRunner) {
      throw new Error('Crewly Agent runtime not initialized. Call initializeInProcess() first.');
    }
    if (this.useWorkerProcess && (!this.workerProcess || !this.workerProcess.connected)) {
      throw new Error('Worker process not available. Call initializeInProcess() or hotReload() first.');
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

    if (!this.useWorkerProcess) {
      this.logger.debug('Handling message via rate limiter', {
        sessionName: session,
        messageLength: cleanMessage.length,
        historyLength: this.agentRunner!.getHistoryLength(),
        conversationId,
        queueLength: queueLen,
        requestsInWindow: this.rateLimiter.getRequestCountInWindow(),
      });
    }

    // Route through rate limiter for throttling, coalescing, and 429 retry
    const result = await this.rateLimiter.enqueue(
      cleanMessage,
      metadata,
      async (msg, meta) => {
        if (this.useWorkerProcess) {
          return this.executeMessageViaWorker(session, msg, conversationId, meta);
        }
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
    const SOFT_WARNING_MS = CREWLY_AGENT_DEFAULTS.MESSAGE_SOFT_WARNING_MS;

    // Execution tracking for diagnostics
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

    // AbortController for external abort (abortCurrentRun) and repetition detection
    const abortController = new AbortController();
    this.messageAbortController = abortController;

    // Text chunk buffer — collects streaming text and flushes on step boundaries
    let textChunkBuffer = '';

    // Repetition/hallucination detection — tracks recent chunks to detect loops
    const recentChunks: string[] = [];
    const REPETITION_WINDOW = 20;   // number of recent chunks to track
    const REPETITION_THRESHOLD = 5; // consecutive repeated patterns to trigger abort
    let repetitionDetected = false;

    // Build streaming callbacks that write to InProcessLogBuffer in real-time
    const streamingCallbacks: StreamingEventCallbacks = {
      onTextChunk: (chunk: string) => {
        if (chunk.length > 0) {
          executionTracker.lastActivityAt = new Date();
          executionTracker.phase = 'model-thinking';
          textChunkBuffer += chunk;

          // Repetition detection: track recent chunks and check for loops
          const trimmed = chunk.trim();
          if (trimmed.length > 0) {
            recentChunks.push(trimmed);
            if (recentChunks.length > REPETITION_WINDOW) {
              recentChunks.shift();
            }
            // Check if the last REPETITION_THRESHOLD chunks are identical
            if (recentChunks.length >= REPETITION_THRESHOLD) {
              const tail = recentChunks.slice(-REPETITION_THRESHOLD);
              const allSame = tail.every(c => c === tail[0]);
              if (allSame && tail[0].length >= 3) {
                repetitionDetected = true;
                this.logBuffer.append(session, 'warn', `⚠️ Repetition loop detected: "${tail[0].substring(0, 80)}" repeated ${REPETITION_THRESHOLD}x — aborting generation`);
                this.logger.warn('Repetition/hallucination loop detected, aborting', {
                  sessionName: session,
                  repeatedChunk: tail[0].substring(0, 100),
                  count: REPETITION_THRESHOLD,
                });
                abortController.abort();
              }
            }
          }
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
      const result = await this.agentRunner!.run(cleanMessage, conversationId, metadata, {
        abortSignal: abortController.signal,
        streaming: streamingCallbacks,
      });

      clearTimeout(warningTimer);
      this.messageAbortController = null;

      // If we got here after a repetition-triggered abort, treat as error
      if (repetitionDetected) {
        throw new Error(
          'Generation aborted: repetition/hallucination loop detected. '
          + `Repeated pattern: "${recentChunks[recentChunks.length - 1]?.substring(0, 80)}"`
        );
      }

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
      this.messageAbortController = null;

      // If this was a repetition-triggered abort, wrap with a clear error
      if (repetitionDetected) {
        const repErr = new Error(
          'Generation aborted: repetition/hallucination loop detected. '
          + `Repeated pattern: "${recentChunks[recentChunks.length - 1]?.substring(0, 80)}"`
        );
        this.logBuffer.append(session, 'error', `Agent error: ${repErr.message}`);
        throw repErr;
      }

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
    if (this.useWorkerProcess) {
      return this.initialized && this.workerProcess !== null && this.workerProcess.connected;
    }
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
    const session = this.currentSessionName;

    if (this.useWorkerProcess) {
      if (!this.workerProcessing || !this.workerProcess) {
        return false;
      }
      this.sendToWorker({ type: 'abort' });
      if (this.workerRunReject) {
        this.workerRunReject(new Error('Run aborted by user'));
        this.workerRunResolve = null;
        this.workerRunReject = null;
      }
      this.workerProcessing = false;
      if (session) {
        this.logBuffer.append(session, 'warn', '⚠️ Run aborted by user');
      }
      this.logger.info('Agent run aborted (worker)', { sessionName: session });
      return true;
    }

    if (!this.messageAbortController) {
      return false;
    }

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
      mode: this.useWorkerProcess ? 'worker' : 'in-process',
    });

    // Mark as not initialized first to reject new messages immediately
    this.initialized = false;

    // Stop heartbeat timer
    this.stopHeartbeat();

    // Shut down worker process if running
    if (this.workerProcess) {
      this.terminateWorker();
    }

    if (this.currentSessionName) {
      this.logBuffer.append(this.currentSessionName, 'info', 'Crewly Agent shutting down');
      this.logBuffer.removeSession(this.currentSessionName);
    }
    this.rateLimiter.reset();
    this.agentRunner = null;
    this.currentSessionName = null;
    this.storedConfig = null;
  }

  // ===== Worker process methods =====

  /**
   * Hot-reload the worker process.
   *
   * Kills the existing worker and spawns a fresh one with the stored config.
   * This allows updating agent code without restarting the main backend.
   * Conversation state is reset — use this when deploying new agent logic.
   *
   * @throws Error if not in worker mode or config is missing
   */
  async hotReload(): Promise<void> {
    if (!this.useWorkerProcess) {
      throw new Error('hotReload() is only available in worker process mode');
    }
    if (!this.storedConfig) {
      throw new Error('No stored config for hot-reload. Was initializeInProcess() called?');
    }

    const session = this.currentSessionName!;
    this.logBuffer.append(session, 'info', 'Hot-reloading worker process...');
    this.logger.info('Hot-reloading worker process', { sessionName: session });

    // Terminate old worker
    this.terminateWorker();

    // Spawn new worker with same config
    await this.initializeWorker(this.storedConfig);

    this.logBuffer.append(session, 'info', 'Worker hot-reload complete');
    this.logger.info('Worker hot-reload complete', { sessionName: session });
  }

  /**
   * Check if the runtime is using a worker process.
   *
   * @returns True if running in worker process mode
   */
  isWorkerMode(): boolean {
    return this.useWorkerProcess;
  }

  /**
   * Get the worker process PID (for monitoring/debugging).
   *
   * @returns Worker PID, or null if not in worker mode or worker is not running
   */
  getWorkerPid(): number | null {
    return this.workerProcess?.pid ?? null;
  }

  /**
   * Initialize a worker child process via fork().
   *
   * Forks the agent-worker.ts entry point and sends the init message
   * with the agent config. Waits for the 'ready' response before resolving.
   *
   * @param config - Full agent config to send to the worker
   * @throws Error if worker fails to initialize within timeout
   */
  private async initializeWorker(config: CrewlyAgentConfig): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const workerPath = this.getWorkerEntryPath();

      this.workerProcess = fork(workerPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env },
      });

      const initTimeout = setTimeout(() => {
        this.terminateWorker();
        reject(new Error('Worker initialization timed out (30s)'));
      }, 30_000);

      let initResolved = false;

      this.workerProcess.on('message', (msg: WorkerMessage) => {
        // Handle init response
        if (!initResolved && msg.type === 'ready') {
          initResolved = true;
          clearTimeout(initTimeout);
          resolve();
          return;
        }
        if (!initResolved && msg.type === 'error' && (msg as { code?: string }).code === 'INIT_FAILED') {
          initResolved = true;
          clearTimeout(initTimeout);
          reject(new Error(msg.error));
          return;
        }

        // Handle runtime messages
        this.handleWorkerMessage(msg);
      });

      this.workerProcess.on('exit', (code, signal) => {
        this.logger.warn('Worker process exited', {
          sessionName: this.currentSessionName,
          code,
          signal,
        });

        if (!initResolved) {
          initResolved = true;
          clearTimeout(initTimeout);
          reject(new Error(`Worker exited during init (code=${code}, signal=${signal})`));
        }

        // Reject any pending run
        if (this.workerRunReject) {
          this.workerRunReject(new Error(`Worker process exited unexpectedly (code=${code}, signal=${signal})`));
          this.workerRunResolve = null;
          this.workerRunReject = null;
          this.workerProcessing = false;
        }

        this.workerProcess = null;

        if (this.currentSessionName) {
          this.logBuffer.append(this.currentSessionName, 'warn', `Worker process exited (code=${code}, signal=${signal})`);
        }
      });

      this.workerProcess.on('error', (err) => {
        this.logger.error('Worker process error', {
          sessionName: this.currentSessionName,
          error: err.message,
        });

        if (!initResolved) {
          initResolved = true;
          clearTimeout(initTimeout);
          reject(err);
        }
      });

      // Capture worker stdout/stderr for debugging
      this.workerProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text && this.currentSessionName) {
          this.logBuffer.append(this.currentSessionName, 'debug', `[worker stdout] ${text}`);
        }
      });

      this.workerProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text && this.currentSessionName) {
          this.logBuffer.append(this.currentSessionName, 'warn', `[worker stderr] ${text}`);
        }
      });

      // Send init message with config
      this.sendToWorker({ type: 'init', config });
    });
  }

  /**
   * Execute a message via the worker process using IPC.
   *
   * Sends a 'run' message to the worker and waits for the 'result' or 'error'
   * response. Streaming events are forwarded to the InProcessLogBuffer in real-time.
   *
   * @param session - Session name
   * @param cleanMessage - Message content (prefix already stripped)
   * @param conversationId - Optional conversation ID
   * @param _metadata - Optional metadata (passed to worker)
   * @returns Agent run result from the worker
   */
  private executeMessageViaWorker(
    session: string,
    cleanMessage: string,
    conversationId?: string,
    _metadata?: Record<string, string>,
  ): Promise<AgentRunResult> {
    return new Promise<AgentRunResult>((resolve, reject) => {
      if (!this.workerProcess || !this.workerProcess.connected) {
        reject(new Error('Worker process not available'));
        return;
      }

      this.workerProcessing = true;
      this.workerRunResolve = (result) => {
        this.workerProcessing = false;
        this.workerRunResolve = null;
        this.workerRunReject = null;

        // Log response summary
        const textPreview = result.text ? result.text.substring(0, 150) : '(no text)';
        this.logBuffer.append(session, 'info', `→ Response (${result.steps} steps, ${result.toolCalls.length} tools): ${textPreview}`);
        this.logBuffer.append(session, 'debug', `  Tokens: ${result.usage.input}in/${result.usage.output}out`);

        this.logger.info('Message processed (worker)', {
          sessionName: session,
          steps: result.steps,
          toolCalls: result.toolCalls.length,
          usage: result.usage,
          finishReason: result.finishReason,
        });

        // Record token usage
        this.recordTokenUsageIfEnabled(session, result).catch(() => {});

        resolve(result);
      };

      this.workerRunReject = (error) => {
        this.workerProcessing = false;
        this.workerRunResolve = null;
        this.workerRunReject = null;
        this.logBuffer.append(session, 'error', `Agent error (worker): ${error.message}`);
        reject(error);
      };

      this.sendToWorker({
        type: 'run',
        message: cleanMessage,
        conversationId,
        metadata: _metadata,
      });
    });
  }

  /**
   * Handle messages received from the worker process.
   *
   * Routes streaming events to the InProcessLogBuffer and resolves/rejects
   * pending run promises on result/error messages.
   *
   * @param msg - Worker message received via IPC
   */
  private handleWorkerMessage(msg: WorkerMessage): void {
    const session = this.currentSessionName;

    switch (msg.type) {
      case 'result':
        if (this.workerRunResolve) {
          this.workerRunResolve(msg.data);
        }
        break;

      case 'error':
        if (this.workerRunReject) {
          this.workerRunReject(new Error(msg.error));
        } else if (session) {
          // Error outside of a run (e.g. crash notification)
          this.logBuffer.append(session, 'error', `Worker error: ${msg.error}`);
        }
        break;

      case 'log':
        if (session) {
          this.logBuffer.append(session, msg.level, `[worker] ${msg.message}`);
        }
        break;

      case 'stream':
        if (!session) break;
        switch (msg.event) {
          case 'text':
            // Text chunks are buffered and flushed at step boundaries
            break;
          case 'toolStart':
            // No-op: logged on finish
            break;
          case 'toolFinish': {
            const { toolName, args, result } = msg.data;
            const argsPreview = JSON.stringify(args).substring(0, 120);
            this.logBuffer.append(session, 'info', `🔧 ${toolName}(${argsPreview})`);
            if (toolName === 'bash_exec' && args.command) {
              const cmdPreview = String(args.command).substring(0, 200);
              this.logBuffer.append(session, 'info', `  $ ${cmdPreview}`);
            }
            const resultPreview = result ? JSON.stringify(result).substring(0, 200) : 'void';
            this.logBuffer.append(session, 'debug', `  → ${resultPreview}`);
            break;
          }
          case 'stepFinish':
            // Step boundaries are tracked by the worker
            break;
        }
        break;

      case 'state':
        // State query responses (used internally)
        break;

      default:
        break;
    }
  }

  /**
   * Send a typed message to the worker process.
   *
   * @param msg - Parent message to send
   */
  private sendToWorker(msg: ParentMessage): void {
    if (this.workerProcess && this.workerProcess.connected) {
      this.workerProcess.send(msg);
    }
  }

  /**
   * Terminate the worker process gracefully, with a forced kill fallback.
   */
  private terminateWorker(): void {
    if (!this.workerProcess) return;

    // Try graceful shutdown first
    try {
      if (this.workerProcess.connected) {
        this.sendToWorker({ type: 'shutdown' });
      }
    } catch {
      // Ignore send errors during shutdown
    }

    // Force kill after 5s if still alive
    const pid = this.workerProcess.pid;
    const killTimer = setTimeout(() => {
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }, 5_000);
    killTimer.unref();

    this.workerProcess.removeAllListeners();
    this.workerProcess = null;
    this.workerProcessing = false;

    // Reject any pending run
    if (this.workerRunReject) {
      this.workerRunReject(new Error('Worker terminated'));
      this.workerRunResolve = null;
      this.workerRunReject = null;
    }
  }

  /**
   * Get the path to the compiled worker entry file.
   *
   * @returns Absolute path to the agent-worker.js compiled file
   */
  /**
   * @internal Visible for testing — override to provide a custom worker path.
   */
  _workerEntryPath: string | null = null;

  private getWorkerEntryPath(): string {
    if (this._workerEntryPath) return this._workerEntryPath;

    // Resolve path relative to the compiled dist/ directory.
    // The worker file is always alongside this file after tsc compilation.
    // Use __dirname (available in both CJS and compiled ESM with tsconfig module: NodeNext).
    const thisDir = path.dirname(__filename);
    return path.join(thisDir, 'agent-worker.js');
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
