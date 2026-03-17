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
import { RUNTIME_TYPES, type RuntimeType } from '../../../constants.js';
import type { CrewlyAgentConfig, AgentRunResult } from './types.js';
import { CREWLY_AGENT_DEFAULTS } from './types.js';
import { SessionCommandHelper } from '../../session/index.js';
import { InProcessLogBuffer } from './in-process-log-buffer.js';
import { RateLimiter } from './rate-limiter.js';


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
  private logBuffer: InProcessLogBuffer;
  private rateLimiter: RateLimiter<AgentRunResult>;

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

    // Load system prompt from file (role-specific)
    const systemPrompt = await this.loadSystemPrompt(roleName || 'orchestrator');

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

    // Register in-process session for frontend terminal visibility
    this.logBuffer.registerSession(sessionName);
    this.logBuffer.append(sessionName, 'info', `Crewly Agent initialized (${fullConfig.model.provider}/${fullConfig.model.modelId})`);

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
    this.logBuffer.append(session, 'info', `← Message received (${cleanMessage.length} chars${conversationId ? `, conv:${conversationId}` : ''}${queueLen > 0 ? `, queue:${queueLen}` : ''})`);

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
    try {
      const result = await this.agentRunner!.run(cleanMessage, conversationId, metadata);

      // Log tool calls to buffer for frontend visibility
      for (const tc of result.toolCalls) {
        const argsPreview = JSON.stringify(tc.args).substring(0, 120);
        this.logBuffer.append(session, 'info', `🔧 ${tc.toolName}(${argsPreview})`);
        const resultPreview = tc.result ? JSON.stringify(tc.result).substring(0, 200) : 'void';
        this.logBuffer.append(session, 'debug', `  → ${resultPreview}`);
      }

      // Log response summary
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

      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logBuffer.append(session, 'error', `Agent error: ${errMsg}`);
      throw error;
    }
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
   * Load the system prompt for a given role from file.
   *
   * @param roleName - Role name (maps to config/roles/{roleName}/prompt.md)
   * @returns System prompt content
   * @throws Error if the prompt file cannot be read
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
}
