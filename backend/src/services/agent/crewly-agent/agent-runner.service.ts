/**
 * Crewly Agent Runner Service
 *
 * Core reasoning loop for the Crewly Agent runtime. Wraps Vercel AI SDK's
 * generateText with conversation history management, context compaction,
 * and structured result tracking.
 *
 * @module services/agent/crewly-agent/agent-runner.service
 */

import { streamText, generateText, stepCountIs, type ModelMessage, type LanguageModel } from 'ai';
import { TracingService } from '../../core/tracing.service.js';
import { ContextFlushService } from '../../memory/context-flush.service.js';
import { TRACING_CONSTANTS } from '../../../constants.js';
import { ModelManager } from './model-manager.js';
import { CrewlyApiClient } from './api-client.js';
import { createTools } from './tool-registry.js';
import { McpClientService } from '../../mcp-client.js';
import { connectAndLoadMcpTools } from './mcp-tool-bridge.js';
import { ApprovalQueueService, type PendingApproval } from './approval-queue.service.js';
import { OutputFilterService } from './output-filter.service.js';
import type { ToolDefinition } from './types.js';
import {
  type CrewlyAgentConfig,
  type ConversationState,
  type AgentRunResult,
  type ToolCallRecord,
  type CompactionResult,
  type ContextBudgetStatus,
  type AuditEntry,
  type SecurityPolicy,
  type ToolCallbacks,
  type ApprovalCheckResult,
  type ToolSensitivity,
  type AuditLogFilters,
  type StreamingEventCallbacks,
  CREWLY_AGENT_DEFAULTS,
  WRITE_TOOLS,
  MODEL_CONTEXT_WINDOWS,
} from './types.js';

/**
 * Fingerprint a tool call for comparison: deterministic JSON of name + args.
 */
function toolCallFingerprint(toolName: string, args: Record<string, unknown>): string {
  return JSON.stringify({ t: toolName, a: args });
}

/**
 * Detects looping behavior in tool calls: consecutive identical calls or
 * consecutive error responses from the same tool.
 *
 * Usage: create per-run, call `recordToolCall()` in onStepFinish, check `loopDetected`.
 */
export class ToolCallLoopDetector {
  /** Consecutive identical tool call fingerprints */
  private consecutiveIdentical = 0;
  private lastFingerprint: string | null = null;
  /** Consecutive error results from the same tool */
  private consecutiveErrors = 0;
  private lastErrorTool: string | null = null;
  /** Whether a loop was detected */
  loopDetected = false;
  /** Human-readable reason when loop is detected */
  loopReason = '';

  constructor(
    private readonly identicalThreshold: number = CREWLY_AGENT_DEFAULTS.LOOP_DETECTION_THRESHOLD,
    private readonly errorThreshold: number = CREWLY_AGENT_DEFAULTS.ERROR_LOOP_THRESHOLD,
  ) {}

  /**
   * Record a tool call and check for loop patterns.
   *
   * @param toolName - Name of the tool called
   * @param args - Arguments passed to the tool
   * @param result - Result returned by the tool
   * @returns True if a loop was just detected on this call
   */
  recordToolCall(toolName: string, args: Record<string, unknown>, result: unknown): boolean {
    if (this.loopDetected) return true;

    // 1. Check consecutive identical calls
    const fp = toolCallFingerprint(toolName, args);
    if (fp === this.lastFingerprint) {
      this.consecutiveIdentical++;
    } else {
      this.consecutiveIdentical = 1;
      this.lastFingerprint = fp;
    }

    if (this.consecutiveIdentical >= this.identicalThreshold) {
      this.loopDetected = true;
      this.loopReason = `Identical tool call repeated ${this.consecutiveIdentical} times: ${toolName}(${JSON.stringify(args).slice(0, 120)})`;
      return true;
    }

    // 2. Check consecutive error results (404, 4xx, 5xx, error strings)
    if (this.isErrorResult(result)) {
      if (toolName === this.lastErrorTool) {
        this.consecutiveErrors++;
      } else {
        this.consecutiveErrors = 1;
        this.lastErrorTool = toolName;
      }
      if (this.consecutiveErrors >= this.errorThreshold) {
        this.loopDetected = true;
        this.loopReason = `Tool "${toolName}" returned errors ${this.consecutiveErrors} consecutive times. Last result: ${String(result).slice(0, 200)}`;
        return true;
      }
    } else {
      this.consecutiveErrors = 0;
      this.lastErrorTool = null;
    }

    return false;
  }

  /**
   * Check if a tool result looks like an error (404, HTTP error codes, error strings).
   */
  private isErrorResult(result: unknown): boolean {
    if (result === null || result === undefined) return false;
    const str = typeof result === 'string' ? result : JSON.stringify(result);
    // Match common error patterns: HTTP 4xx/5xx, "error", "not found", "failed"
    return /\b(404|403|500|502|503|4\d{2}|5\d{2})\b/.test(str)
      || /\b(error|not\s*found|failed|refused|denied|timeout)\b/i.test(str);
  }
}

/**
 * Core agent runner that manages the AI SDK generateText loop.
 *
 * Responsibilities:
 * - Maintains conversation history (messages array)
 * - Calls generateText with tools and maxSteps for agentic behavior
 * - Tracks token usage across invocations
 * - Triggers context compaction when history grows too large
 * - Serializes concurrent message handling
 *
 * @example
 * ```typescript
 * const runner = new AgentRunnerService(config);
 * await runner.initialize();
 * const result = await runner.run('Check all team statuses');
 * ```
 */
/** Function type for generateText — used for dependency injection in tests */
type GenerateTextFn = (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class AgentRunnerService {
  private config: CrewlyAgentConfig;
  private modelManager: ModelManager;
  private apiClient: CrewlyApiClient;
  private model: LanguageModel | null = null;
  private state: ConversationState;
  private processing = false;
  private messageQueue: Array<{ message: string; conversationId?: string; metadata?: Record<string, string>; resolve: (result: AgentRunResult) => void; reject: (error: Error) => void; options?: { abortSignal?: AbortSignal; streaming?: StreamingEventCallbacks } }> = [];
  private auditLog: AuditEntry[] = [];
  private securityPolicy: SecurityPolicy;
  /** Current conversationId extracted from [CHAT:xxx] prefix */
  private currentConversationId?: string;
  /** Last known conversationId — used as fallback when a message has no explicit conversationId */
  private lastKnownConversationId?: string;
  /** Current Slack context (channelId + threadTs) for routing NOTIFY responses */
  private currentSlackContext?: { channelId: string; threadTs?: string };
  /** MCP client for external tool integration */
  private mcpClient: McpClientService | null = null;
  /** Cached MCP tool definitions loaded during initialization */
  private mcpToolDefs: Record<string, ToolDefinition> = {};
  /** Approval queue for tools requiring explicit approval (shared singleton) */
  private approvalQueue: ApprovalQueueService = ApprovalQueueService.getInstance();
  private tracing = TracingService.getInstance();
  /** Guards against concurrent compaction — only one compaction at a time */
  private compacting = false;
  /** AbortController for the current run — allows external cancellation */
  private currentRunAbort: AbortController | null = null;
  /** Streaming event callbacks — set per run by the runtime service */
  private streamingCallbacks: StreamingEventCallbacks = {};
  /** Output filter for redacting API keys from agent responses */
  private outputFilter: OutputFilterService = new OutputFilterService();
  /** @internal Override for testing — replaces the AI SDK generateText call */
  _generateTextFn: GenerateTextFn | null = null;

  /**
   * Create a new AgentRunnerService.
   *
   * @param config - Agent configuration
   * @param modelManager - Optional model manager instance (for testing)
   * @param apiClient - Optional API client instance (for testing)
   */
  constructor(
    config: CrewlyAgentConfig,
    modelManager?: ModelManager,
    apiClient?: CrewlyApiClient,
  ) {
    this.config = config;
    this.modelManager = modelManager || new ModelManager();
    this.apiClient = apiClient || new CrewlyApiClient(
      config.apiBaseUrl,
      config.sessionName,
    );
    this.securityPolicy = { ...CREWLY_AGENT_DEFAULTS.SECURITY_POLICY };
    this.state = {
      messages: [],
      systemPrompt: config.systemPrompt,
      totalTokens: { input: 0, output: 0 },
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };
  }

  /**
   * Initialize the agent runner by loading the model.
   * Must be called before run().
   *
   * @throws Error if the model cannot be loaded
   */
  async initialize(): Promise<void> {
    this.model = await this.modelManager.getModel(this.config.model);

    // Connect to configured MCP servers and load their tools
    if (this.config.mcpServers && Object.keys(this.config.mcpServers).length > 0) {
      this.mcpClient = new McpClientService();
      const { tools, errors } = await connectAndLoadMcpTools(
        this.mcpClient,
        this.config.mcpServers,
        this.config.mcpSensitivityOverrides,
      );
      this.mcpToolDefs = tools;

      if (errors.size > 0) {
        for (const [name, error] of errors.entries()) {
          // Log but don't fail — partial MCP availability is acceptable
          console.warn(`MCP server "${name}" failed to connect: ${error.message}`);
        }
      }
    }
  }

  /**
   * Run the agent with a new user message.
   *
   * Messages are queued and processed serially to prevent concurrent
   * generateText calls which would corrupt conversation state.
   *
   * @param message - User/system message to process
   * @param conversationId - Optional conversation ID for routing
   * @param metadata - Optional metadata (Slack context, etc.)
   * @param options - Optional abort signal and streaming callbacks
   * @returns Result of the agent run including text, tool calls, and usage
   */
  async run(
    message: string,
    conversationId?: string,
    metadata?: Record<string, string>,
    options?: { abortSignal?: AbortSignal; streaming?: StreamingEventCallbacks },
  ): Promise<AgentRunResult> {
    return new Promise<AgentRunResult>((resolve, reject) => {
      this.messageQueue.push({ message, conversationId, metadata, resolve, reject, options });
      if (!this.processing) {
        this.processQueue();
      }
    });
  }

  /**
   * Abort the current in-progress run.
   * Signals the active streamText/generateText call to cancel.
   *
   * @returns True if an active run was aborted, false if no run was in progress
   */
  abortCurrentRun(): boolean {
    if (this.currentRunAbort) {
      this.currentRunAbort.abort();
      return true;
    }
    return false;
  }

  /**
   * Check if the agent is currently processing a message.
   *
   * @returns True if processing is in progress
   */
  isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Get current conversation state (for inspection/debugging).
   *
   * @returns Current conversation state
   */
  getState(): ConversationState {
    return { ...this.state };
  }

  /**
   * Shut down the agent runner, disconnecting MCP servers.
   *
   * Should be called when the agent session ends to clean up
   * child processes spawned by MCP server connections.
   */
  async shutdown(): Promise<void> {
    if (this.mcpClient) {
      await this.mcpClient.disconnectAll();
      this.mcpClient = null;
      this.mcpToolDefs = {};
    }
  }

  /**
   * Get the names of connected MCP servers.
   *
   * @returns Array of server names, or empty if no MCP client is configured
   */
  getMcpServerNames(): string[] {
    return this.mcpClient?.getConnectedServers() ?? [];
  }

  /**
   * Get the number of MCP tools currently loaded.
   *
   * @returns Number of MCP tool definitions
   */
  getMcpToolCount(): number {
    return Object.keys(this.mcpToolDefs).length;
  }

  /**
   * Get the current Slack context (channelId + threadTs).
   * Used by the runtime service to inject Slack awareness into the agent.
   *
   * @returns Current Slack context or undefined
   */
  getSlackContext(): { channelId: string; threadTs?: string } | undefined {
    return this.currentSlackContext;
  }

  /**
   * Get the number of messages in the conversation history.
   *
   * @returns Message count
   */
  getHistoryLength(): number {
    return this.state.messages.length;
  }

  /**
   * Check if the agent runner has been initialized.
   *
   * @returns True if initialize() has been called successfully
   */
  isInitialized(): boolean {
    return this.model !== null;
  }

  /**
   * Get current context budget status.
   *
   * Calculates token usage as a percentage of the model's context window
   * and determines the budget level (normal/warning/critical).
   *
   * @returns ContextBudgetStatus with usage stats and level
   */
  getContextBudget(): ContextBudgetStatus {
    const totalTokensUsed = this.state.totalTokens.input + this.state.totalTokens.output;
    const contextWindowSize = MODEL_CONTEXT_WINDOWS[this.config.model.modelId]
      ?? MODEL_CONTEXT_WINDOWS.default;
    const usagePercent = contextWindowSize > 0
      ? totalTokensUsed / contextWindowSize
      : 0;

    const threshold = this.config.compactionThreshold;
    const warningThreshold = threshold * 0.85; // warn at 85% of compaction threshold
    let level: ContextBudgetStatus['level'] = 'normal';
    if (usagePercent >= threshold) {
      level = 'critical';
    } else if (usagePercent >= warningThreshold) {
      level = 'warning';
    }

    const compactionPending = this.state.messages.length >= this.config.maxHistoryMessages
      || usagePercent >= threshold;

    const pct = (usagePercent * 100).toFixed(1);
    let summary = `${pct}% of context budget used (${totalTokensUsed.toLocaleString()}/${contextWindowSize.toLocaleString()} tokens, ${this.state.messages.length} messages)`;
    if (level === 'critical') {
      summary += ' — CRITICAL: compaction recommended immediately';
    } else if (level === 'warning') {
      summary += ' — WARNING: approaching compaction threshold';
    }

    return {
      totalTokensUsed,
      contextWindowSize,
      usagePercent,
      level,
      messageCount: this.state.messages.length,
      compactionPending,
      summary,
    };
  }

  /**
   * Process queued messages serially.
   */
  private async processQueue(): Promise<void> {
    this.processing = true;
    while (this.messageQueue.length > 0) {
      const item = this.messageQueue.shift()!;
      try {
        // Update current conversationId for tool context.
        // If the incoming message has an explicit conversationId, use it and
        // remember it for future messages. If not, fall back to the last known
        // conversationId so tools (especially [NOTIFY] output) can still route
        // responses correctly for system messages like scheduled checks.
        if (item.conversationId) {
          this.currentConversationId = item.conversationId;
          this.lastKnownConversationId = item.conversationId;
        } else {
          this.currentConversationId = this.lastKnownConversationId;
        }
        // Update Slack context from message metadata (Bug 5 fix).
        // When a message arrives via Slack, metadata contains channelId + threadTs
        // so the agent's tools (reply_slack) know where to reply.
        if (item.metadata?.channelId) {
          this.currentSlackContext = {
            channelId: item.metadata.channelId,
            threadTs: item.metadata.threadTs,
          };
        }
        // Set streaming callbacks for this run
        this.streamingCallbacks = item.options?.streaming ?? {};
        const result = await this.tracing.withSpan(TRACING_CONSTANTS.SPANS.AGENT_RUN, {
          attributes: {
            'agent.session': this.config.sessionName,
            'agent.role': this.config.role,
          }
        }, async () => {
          return this.executeRun(item.message, item.options?.abortSignal);
        });
        item.resolve(result);
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.processing = false;

    // Re-check: a message may have been pushed between the while-loop exit
    // condition check and this.processing = false. Without this guard, the
    // queued message would be stranded — nobody restarts processQueue.
    if (this.messageQueue.length > 0) {
      this.processQueue();
    }
  }

  /**
   * Execute a single streamText run with the current conversation context.
   *
   * Uses streamText for real-time token emission and tool call feedback.
   * Falls back to generateText when _generateTextFn is set (testing).
   *
   * @param message - New message to add to the conversation
   * @param externalAbortSignal - Optional external abort signal for cancellation
   * @returns Agent run result
   */
  private async executeRun(message: string, externalAbortSignal?: AbortSignal): Promise<AgentRunResult> {
    if (!this.model) {
      throw new Error('AgentRunner not initialized. Call initialize() first.');
    }

    // Check if compaction is needed before adding new message
    // Trigger on message count OR token budget threshold
    const budget = this.getContextBudget();
    if (this.state.messages.length >= this.config.maxHistoryMessages || budget.level === 'critical') {
      await this.compactHistory();
    }

    // Add user message to history
    this.state.messages.push({ role: 'user', content: message });
    this.state.lastActivityAt = new Date();

    // Build tools with callbacks for compaction, audit, and security enforcement
    const callbacks: ToolCallbacks = {
      onCompactMemory: () => this.requestCompaction(),
      onGetContextBudget: () => this.getContextBudget(),
      onAuditLog: (entry: AuditEntry) => this.recordAudit({ ...entry, sessionName: this.config.sessionName }),
      onCheckApproval: (toolName: string, sensitivity: ToolSensitivity) => this.checkApproval(toolName, sensitivity),
      onGetAuditLog: (filters: AuditLogFilters) => this.getFilteredAuditLog(filters),
      onEnqueueApproval: (toolName: string, sensitivity: ToolSensitivity, args: Record<string, unknown>) => {
        const approval = this.approvalQueue.enqueue(this.config.sessionName, toolName, sensitivity, args);
        return { approvalId: approval.id };
      },
    };
    const mcpTools = Object.keys(this.mcpToolDefs).length > 0 ? this.mcpToolDefs : undefined;
    const tools = createTools(this.apiClient, this.config.sessionName, this.config.projectPath, callbacks, this.currentConversationId, this.currentSlackContext, mcpTools);

    // Create abort controller that merges external signal with internal control
    const runAbort = new AbortController();
    this.currentRunAbort = runAbort;

    // If external signal is already aborted, abort immediately
    if (externalAbortSignal?.aborted) {
      runAbort.abort();
    } else if (externalAbortSignal) {
      externalAbortSignal.addEventListener('abort', () => runAbort.abort(), { once: true });
    }

    try {
      // If a test override is set, use generateText path (backward compatible)
      if (this._generateTextFn) {
        return await this.executeRunWithGenerateText(tools, runAbort.signal);
      }

      // Production path: streamText for real-time feedback
      return await this.executeRunWithStreamText(tools, runAbort.signal);
    } finally {
      this.currentRunAbort = null;
    }
  }

  /**
   * Check if an error is recoverable and eligible for automatic retry.
   *
   * Recoverable errors include:
   * - HTTP 429 (rate limit)
   * - HTTP 5xx (server errors)
   * - Network timeouts and connection errors
   *
   * @param error - The error to classify
   * @returns True if the error is recoverable
   */
  private isRecoverableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message.toLowerCase();
    const statusMatch = msg.match(/\b(429|5\d{2})\b/);
    if (statusMatch) return true;
    if (msg.includes('rate limit') || msg.includes('too many requests')) return true;
    if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('econnrefused')) return true;
    if (msg.includes('network') || msg.includes('fetch failed') || msg.includes('socket hang up')) return true;
    if (msg.includes('service unavailable') || msg.includes('internal server error')) return true;
    return false;
  }

  /**
   * Check if an error indicates the context length was exceeded.
   *
   * @param error - The error to classify
   * @returns True if the error is a context length exceeded error
   */
  private isContextLengthError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message.toLowerCase();
    return msg.includes('context length') || msg.includes('token limit')
      || msg.includes('max_tokens') || msg.includes('context window')
      || msg.includes('too long') || msg.includes('maximum context');
  }

  /**
   * Sleep for a specified duration.
   *
   * @param ms - Milliseconds to sleep
   * @returns Promise that resolves after the delay
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute run using streamText for real-time streaming output.
   * This is the production path — emits events as tokens arrive.
   *
   * Includes automatic retry with exponential backoff for recoverable errors
   * (429, 5xx, network) and progressive context trimming for context length errors.
   */
  private async executeRunWithStreamText(
    tools: Record<string, unknown>,
    abortSignal: AbortSignal,
  ): Promise<AgentRunResult> {
    const maxRetries = CREWLY_AGENT_DEFAULTS.MAX_RETRIES;
    const baseDelay = CREWLY_AGENT_DEFAULTS.RETRY_BASE_DELAY_MS;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.executeStreamTextAttempt(tools, abortSignal);
      } catch (error) {
        // Context length exceeded — try compaction then retry once
        if (this.isContextLengthError(error)) {
          this.streamingCallbacks.onTextChunk?.('[retry] Context length exceeded, compacting history...\n');
          const compactionResult = await this.requestCompaction();
          if (compactionResult.compacted) {
            try {
              return await this.executeStreamTextAttempt(tools, abortSignal);
            } catch (retryError) {
              // If still too long, remove earliest non-system messages and try once more
              if (this.isContextLengthError(retryError) && this.state.messages.length > 2) {
                this.streamingCallbacks.onTextChunk?.('[retry] Still too long, trimming oldest messages...\n');
                this.trimOldestNonSystemMessages();
                return await this.executeStreamTextAttempt(tools, abortSignal);
              }
              throw retryError;
            }
          }
        }

        // Recoverable error — retry with backoff
        if (this.isRecoverableError(error) && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt);
          this.streamingCallbacks.onTextChunk?.(`[retry] Recoverable error (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...\n`);
          await this.sleep(delay);
          continue;
        }

        throw error;
      }
    }

    // Unreachable — the loop always returns or throws
    throw new Error('Retry loop exhausted without result');
  }

  /**
   * Single attempt of streamText execution (no retry logic).
   */
  private async executeStreamTextAttempt(
    tools: Record<string, unknown>,
    abortSignal: AbortSignal,
  ): Promise<AgentRunResult> {
    const toolCalls: ToolCallRecord[] = [];
    let stepCount = 0;
    const loopDetector = new ToolCallLoopDetector();
    // Local abort controller so we can abort on loop detection
    const loopAbort = new AbortController();
    const mergedSignal = AbortSignal.any([abortSignal, loopAbort.signal]);

    const streamResult = streamText({
      model: this.model!,
      system: this.state.systemPrompt,
      messages: this.state.messages,
      tools: tools as any,
      stopWhen: stepCountIs(this.config.maxSteps),
      temperature: this.config.model.temperature,
      maxOutputTokens: this.config.model.maxTokens,
      abortSignal: mergedSignal,
      onChunk: ({ chunk }: { chunk: { type: string; text?: string } }) => {
        // Emit text chunks in real-time
        if (chunk.type === 'text-delta' && chunk.text) {
          this.streamingCallbacks.onTextChunk?.(chunk.text);
        }
      },
      experimental_onToolCallStart: (event: any) => {
        const tc = event.toolCall;
        const args = tc?.args ?? tc?.input ?? {};
        this.streamingCallbacks.onToolCallStart?.(tc?.toolName ?? 'unknown', (typeof args === 'string' ? JSON.parse(args) : args) as Record<string, unknown>);
      },
      experimental_onToolCallFinish: (event: any) => {
        const tc = event.toolCall;
        const args = tc?.args ?? tc?.input ?? {};
        this.streamingCallbacks.onToolCallFinish?.(tc?.toolName ?? 'unknown', (typeof args === 'string' ? JSON.parse(args) : args) as Record<string, unknown>, event.toolResult, event.durationMs ?? 0);
      },
      onStepFinish: ({ toolCalls: stepToolCalls, toolResults }: { stepNumber: number; toolCalls?: Array<{ toolName: string; toolCallId: string }>; toolResults?: Array<{ toolCallId: string; output?: unknown }> }) => {
        stepCount++;
        const hasTools = (stepToolCalls?.length ?? 0) > 0;

        // Collect tool calls from this step and check for loops
        if (stepToolCalls) {
          for (const tc of stepToolCalls) {
            const args = (tc as Record<string, unknown>).input as Record<string, unknown> ?? {};
            const result = toolResults?.find(
              (tr: { toolCallId: string }) => tr.toolCallId === tc.toolCallId,
            )?.output;
            toolCalls.push({ toolName: tc.toolName, args, result });
            loopDetector.recordToolCall(tc.toolName, args, result);
          }
        }

        // Abort if loop detected — will be caught below
        if (loopDetector.loopDetected) {
          console.warn('[AgentRunner] Loop detected, aborting run:', loopDetector.loopReason);
          loopAbort.abort();
        }

        this.streamingCallbacks.onStepFinish?.(stepCount, hasTools);
      },
    });

    // Await the full result (stream completes when all steps are done or aborted)
    let result;
    try {
      result = await streamResult;
    } catch (err) {
      // If aborted due to loop detection, handle gracefully
      if (loopDetector.loopDetected) {
        return this.handleLoopDetected(loopDetector, toolCalls, stepCount);
      }
      throw err;
    }

    // Also check post-completion in case the loop threshold was hit on the final step
    if (loopDetector.loopDetected) {
      return this.handleLoopDetected(loopDetector, toolCalls, stepCount);
    }

    // Warn if tool call count is excessive (polling dead-loop protection)
    const maxToolCalls = CREWLY_AGENT_DEFAULTS.MAX_TOOL_CALLS_PER_RESPONSE;
    if (toolCalls.length > maxToolCalls) {
      console.warn('[AgentRunner] Excessive tool calls in single response:', {
        count: toolCalls.length,
        limit: maxToolCalls,
        topTools: toolCalls.slice(0, 5).map(tc => tc.toolName),
      });
    }

    // Add assistant response to history
    let text = await result.text;
    if (text) {
      this.state.messages.push({ role: 'assistant', content: text });
    }

    // Empty response fallback: if model made tool calls but produced no text summary,
    // prompt it once more to generate a summary (prevents silent completions)
    if (!text && toolCalls.length > 0) {
      console.warn('[AgentRunner] Empty text response after tool calls, requesting summary fallback');
      const fallbackResult = await this.requestSummaryFallback();
      if (fallbackResult) {
        text = fallbackResult;
      }
    }

    // Security guardrail: redact any API keys from agent output
    if (text) {
      const scanResult = this.outputFilter.scan(text);
      if (scanResult.detected) {
        console.warn('[AgentRunner] API keys redacted from output:', scanResult.matchedPatterns);
        text = scanResult.redactedText;
      }
    }

    // Update token tracking
    const resultUsage = await result.usage;
    const usage = {
      input: resultUsage?.inputTokens ?? 0,
      output: resultUsage?.outputTokens ?? 0,
    };
    this.state.totalTokens.input += usage.input;
    this.state.totalTokens.output += usage.output;

    // Check budget after token update
    const postBudget = this.getContextBudget();
    const budgetWarning = postBudget.level !== 'normal' ? postBudget.summary : undefined;

    const finishReason = await result.finishReason;

    return {
      text,
      steps: stepCount,
      usage,
      toolCalls,
      finishReason,
      budgetWarning,
    };
  }

  /**
   * Execute run using generateText (batch mode).
   * Used when _generateTextFn is set for testing, or as fallback.
   *
   * Includes automatic retry with exponential backoff for recoverable errors
   * and progressive context trimming for context length errors.
   */
  private async executeRunWithGenerateText(
    tools: Record<string, unknown>,
    abortSignal: AbortSignal,
  ): Promise<AgentRunResult> {
    const maxRetries = CREWLY_AGENT_DEFAULTS.MAX_RETRIES;
    const baseDelay = CREWLY_AGENT_DEFAULTS.RETRY_BASE_DELAY_MS;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.executeGenerateTextAttempt(tools, abortSignal);
      } catch (error) {
        // Context length exceeded — try compaction then retry once
        if (this.isContextLengthError(error)) {
          const compactionResult = await this.requestCompaction();
          if (compactionResult.compacted) {
            try {
              return await this.executeGenerateTextAttempt(tools, abortSignal);
            } catch (retryError) {
              if (this.isContextLengthError(retryError) && this.state.messages.length > 2) {
                this.trimOldestNonSystemMessages();
                return await this.executeGenerateTextAttempt(tools, abortSignal);
              }
              throw retryError;
            }
          }
        }

        // Recoverable error — retry with backoff
        if (this.isRecoverableError(error) && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt);
          await this.sleep(delay);
          continue;
        }

        throw error;
      }
    }

    throw new Error('Retry loop exhausted without result');
  }

  /**
   * Single attempt of generateText execution (no retry logic).
   */
  private async executeGenerateTextAttempt(
    tools: Record<string, unknown>,
    abortSignal: AbortSignal,
  ): Promise<AgentRunResult> {
    const generateFn = this._generateTextFn || (generateText as Function);
    const result = await generateFn({
      model: this.model,
      system: this.state.systemPrompt,
      messages: this.state.messages,
      tools,
      stopWhen: stepCountIs(this.config.maxSteps),
      temperature: this.config.model.temperature,
      maxOutputTokens: this.config.model.maxTokens,
      abortSignal,
    });

    // Track tool calls across all steps with loop detection
    const toolCalls: ToolCallRecord[] = [];
    const loopDetector = new ToolCallLoopDetector();
    for (const step of result.steps) {
      if (step.toolCalls) {
        for (const tc of step.toolCalls) {
          const args = (tc as Record<string, unknown>).input as Record<string, unknown> ?? {};
          const tcResult = step.toolResults?.find(
            (tr: { toolCallId: string }) => tr.toolCallId === tc.toolCallId,
          )?.output;
          toolCalls.push({ toolName: tc.toolName, args, result: tcResult });
          loopDetector.recordToolCall(tc.toolName, args, tcResult);
        }
      }
    }

    // If loop detected in generateText path, handle gracefully
    if (loopDetector.loopDetected) {
      console.warn('[AgentRunner] Loop detected in generateText:', loopDetector.loopReason);
      return this.handleLoopDetected(loopDetector, toolCalls, result.steps.length);
    }

    // Warn if tool call count is excessive
    const maxToolCalls = CREWLY_AGENT_DEFAULTS.MAX_TOOL_CALLS_PER_RESPONSE;
    if (toolCalls.length > maxToolCalls) {
      console.warn('[AgentRunner] Excessive tool calls in single response:', {
        count: toolCalls.length,
        limit: maxToolCalls,
        topTools: toolCalls.slice(0, 5).map(tc => tc.toolName),
      });
    }

    // Add assistant response to history
    let finalText = result.text;
    if (finalText) {
      this.state.messages.push({ role: 'assistant', content: finalText });
    }

    // Empty response fallback: if model made tool calls but produced no text summary,
    // prompt it once more to generate a summary (prevents silent completions)
    if (!finalText && toolCalls.length > 0) {
      console.warn('[AgentRunner] Empty text response after tool calls, requesting summary fallback');
      const fallbackResult = await this.requestSummaryFallback();
      if (fallbackResult) {
        finalText = fallbackResult;
      }
    }

    // Security guardrail: redact any API keys from agent output
    if (finalText) {
      const scanResult = this.outputFilter.scan(finalText);
      if (scanResult.detected) {
        console.warn('[AgentRunner] API keys redacted from output:', scanResult.matchedPatterns);
        finalText = scanResult.redactedText;
      }
    }

    // Update token tracking
    const usage = {
      input: result.usage?.inputTokens ?? 0,
      output: result.usage?.outputTokens ?? 0,
    };
    this.state.totalTokens.input += usage.input;
    this.state.totalTokens.output += usage.output;

    // Check budget after token update and attach warning if approaching limits
    const postBudget = this.getContextBudget();
    const budgetWarning = postBudget.level !== 'normal' ? postBudget.summary : undefined;

    return {
      text: finalText,
      steps: result.steps.length,
      usage,
      toolCalls,
      finishReason: result.finishReason,
      budgetWarning,
    };
  }

  /**
   * Remove the oldest non-system messages to reduce context size.
   * Preserves the most recent messages and any system-role messages.
   */
  private trimOldestNonSystemMessages(): void {
    // Remove up to 5 of the oldest non-system messages
    let removed = 0;
    const maxRemove = 5;
    this.state.messages = this.state.messages.filter((msg) => {
      if (removed >= maxRemove) return true;
      if (msg.role === 'system') return true;
      removed++;
      return false;
    });
  }

  /**
   * Handle a detected tool call loop by injecting a corrective system message
   * into conversation history and returning a structured result.
   *
   * @param detector - The loop detector with reason details
   * @param toolCalls - Tool calls collected so far
   * @param steps - Number of steps taken
   * @returns AgentRunResult with the loop warning as text
   */
  private handleLoopDetected(
    detector: ToolCallLoopDetector,
    toolCalls: ToolCallRecord[],
    steps: number,
  ): AgentRunResult {
    const guidance = `[LOOP DETECTED] ${detector.loopReason}. ` +
      'You are repeating the same action without progress. ' +
      'STOP and try a different approach: use a different tool, change the arguments, ' +
      'skip this step, or ask for help. Do NOT repeat the same call again.';

    // Inject corrective message so the model sees it on the next run
    this.state.messages.push({ role: 'assistant', content: `[Loop detected — halting. ${detector.loopReason}]` });
    this.state.messages.push({ role: 'user', content: guidance });

    this.streamingCallbacks.onTextChunk?.(`\n⚠️ ${guidance}\n`);

    return {
      text: `[Loop detected] ${detector.loopReason}`,
      steps,
      usage: { input: 0, output: 0 },
      toolCalls,
      finishReason: 'loop-detected',
      budgetWarning: undefined,
    };
  }

  /**
   * Request a text summary from the model when the previous response had tool calls
   * but no text output. Injects a follow-up user message and makes a single
   * generateText call with no tools to force a text-only response.
   *
   * @returns The summary text, or empty string if the fallback also fails
   */
  private async requestSummaryFallback(): Promise<string> {
    if (!this.model) return '';

    const prompt =
      '请用文字总结你刚才完成的工作和发现的结果，然后调用report-status汇报。' +
      'Please summarize what you just did, what you found, and any issues encountered. ' +
      'Then call report-status to report your status.';

    this.state.messages.push({ role: 'user', content: prompt });

    try {
      const fallback = await generateText({
        model: this.model,
        system: this.state.systemPrompt,
        messages: this.state.messages,
        maxOutputTokens: this.config.model.maxTokens,
        temperature: this.config.model.temperature,
      });

      const text = fallback.text || '';
      if (text) {
        this.state.messages.push({ role: 'assistant', content: text });
        this.streamingCallbacks.onTextChunk?.(text);

        // Track fallback token usage
        const fallbackUsage = fallback.usage;
        if (fallbackUsage) {
          this.state.totalTokens.input += fallbackUsage.inputTokens ?? 0;
          this.state.totalTokens.output += fallbackUsage.outputTokens ?? 0;
        }
      }

      return text;
    } catch (err) {
      console.error('[AgentRunner] Summary fallback failed:', err instanceof Error ? err.message : err);
      return '';
    }
  }

  /**
   * Public method for agent-initiated context compaction.
   * Called by the compact_memory tool to intelligently summarize conversation state.
   *
   * Uses the model to generate a structured summary preserving:
   * - Active tasks and their status
   * - Key decisions made
   * - Important findings and blockers
   * - Current working context
   *
   * @returns CompactionResult with before/after stats
   */
  async requestCompaction(): Promise<CompactionResult> {
    if (!this.model || this.state.messages.length < 10) {
      return {
        compacted: false,
        messagesBefore: this.state.messages.length,
        messagesAfter: this.state.messages.length,
        reason: this.state.messages.length < 10
          ? 'Too few messages to compact'
          : 'Model not initialized',
      };
    }
    return this.compactHistory();
  }

  /**
   * Get the security audit log.
   *
   * @param limit - Maximum number of entries to return (most recent first)
   * @returns Array of audit entries
   */
  getAuditLog(limit?: number): AuditEntry[] {
    const entries = [...this.auditLog].reverse();
    return limit ? entries.slice(0, limit) : entries;
  }

  /**
   * Get the current security policy.
   *
   * @returns Current security policy configuration
   */
  getSecurityPolicy(): SecurityPolicy {
    return { ...this.securityPolicy };
  }

  /**
   * Update the security policy.
   *
   * @param updates - Partial security policy to merge
   */
  updateSecurityPolicy(updates: Partial<SecurityPolicy>): void {
    this.securityPolicy = { ...this.securityPolicy, ...updates };
  }

  /**
   * Get the approval queue service instance.
   * Used by the approvals controller to manage pending approvals.
   *
   * @returns The ApprovalQueueService instance
   */
  getApprovalQueue(): ApprovalQueueService {
    return this.approvalQueue;
  }

  /**
   * Record an audit entry for a tool invocation.
   *
   * @param entry - Audit entry to record
   */
  private recordAudit(entry: AuditEntry): void {
    if (!this.securityPolicy.auditEnabled) return;

    this.auditLog.push(entry);

    // Enforce max entries limit
    if (this.auditLog.length > this.securityPolicy.maxAuditEntries) {
      this.auditLog = this.auditLog.slice(-this.securityPolicy.maxAuditEntries);
    }
  }

  /**
   * Check if a tool is allowed to execute under the current security policy.
   *
   * Evaluates the tool against two checks:
   * 1. blockedTools — tools explicitly blocked by name (returns blocked=true)
   * 2. requireApproval — tools whose sensitivity requires approval (returns requiresApproval=true)
   *
   * @param toolName - Name of the tool being invoked
   * @param sensitivity - Sensitivity classification of the tool
   * @returns ApprovalCheckResult indicating if execution is allowed
   */
  private checkApproval(toolName: string, sensitivity: ToolSensitivity): ApprovalCheckResult {
    // Check read-only mode — block all write/modify tools
    if (this.securityPolicy.readOnlyMode && WRITE_TOOLS.includes(toolName)) {
      return {
        allowed: false,
        blocked: true,
        reason: `Tool '${toolName}' is blocked — read-only audit mode is active`,
      };
    }

    // Check blocked tools
    if (this.securityPolicy.blockedTools.includes(toolName)) {
      return {
        allowed: false,
        blocked: true,
        reason: `Tool '${toolName}' is blocked by security policy`,
      };
    }

    // Check approval requirements
    if (this.securityPolicy.requireApproval.includes(sensitivity)) {
      return {
        allowed: false,
        blocked: false,
        reason: `Tool '${toolName}' (${sensitivity}) requires approval — approval mode is active for '${sensitivity}' tools`,
      };
    }

    return { allowed: true };
  }

  /**
   * Get filtered audit log entries.
   *
   * @param filters - Query filters for limit, sensitivity, and toolName
   * @returns Filtered audit entries (most recent first)
   */
  private getFilteredAuditLog(filters: AuditLogFilters): AuditEntry[] {
    let entries = [...this.auditLog].reverse();

    if (filters.sensitivity) {
      entries = entries.filter(e => e.sensitivity === filters.sensitivity);
    }
    if (filters.toolName) {
      entries = entries.filter(e => e.toolName === filters.toolName);
    }

    return entries.slice(0, filters.limit);
  }

  /**
   * Compact conversation history using AI-generated structured summary.
   *
   * Keeps the most recent messages and uses the model to generate an
   * intelligent summary of older messages that preserves critical state:
   * decisions, active tasks, findings, and working context.
   *
   * Falls back to truncation-based summary if AI summarization fails.
   *
   * @returns CompactionResult with before/after statistics
   */
  private async compactHistory(): Promise<CompactionResult> {
    // Guard against concurrent compaction — if already compacting, skip
    if (this.compacting) {
      return {
        compacted: false,
        messagesBefore: this.state.messages.length,
        messagesAfter: this.state.messages.length,
        reason: 'Compaction already in progress',
      };
    }

    if (!this.model || this.state.messages.length < 10) {
      return {
        compacted: false,
        messagesBefore: this.state.messages.length,
        messagesAfter: this.state.messages.length,
        reason: 'History too small to compact',
      };
    }

    this.compacting = true;
    try {

    const messagesBefore = this.state.messages.length;
    const keepRecent = 10;
    const oldMessages = this.state.messages.slice(0, -keepRecent);
    const recentMessages = this.state.messages.slice(-keepRecent);

    // Pre-compaction context flush (#153): extract critical items from old
    // messages so they can be explicitly included in the AI summary prompt.
    // This ensures task progress, decisions, technical details, and blockers
    // survive compaction even if the AI summary would otherwise miss them.
    const flushService = ContextFlushService.getInstance();
    const oldText = oldMessages.map(msg => {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      return content;
    }).join('\n');
    const extractedItems = flushService.extract(oldText);

    // Attempt AI-powered summarization
    let summaryText: string;
    try {
      summaryText = await this.generateAISummary(oldMessages, extractedItems);
    } catch {
      // Fallback to truncation-based summary
      summaryText = this.generateFallbackSummary(oldMessages, extractedItems);
    }

    this.state.messages = [
      { role: 'assistant', content: summaryText },
      ...recentMessages,
    ];

    return {
      compacted: true,
      messagesBefore,
      messagesAfter: this.state.messages.length,
    };
    } finally {
      this.compacting = false;
    }
  }

  /**
   * Generate an AI-powered structured summary of conversation messages.
   *
   * Asks the model to extract and preserve critical state from the
   * conversation history in a structured format. Pre-extracted critical
   * items from ContextFlushService are included in the prompt to ensure
   * they are preserved even if the AI would otherwise miss them.
   *
   * @param messages - Messages to summarize
   * @param extractedItems - Critical items extracted by ContextFlushService
   * @returns Structured summary string
   */
  private async generateAISummary(
    messages: ModelMessage[],
    extractedItems: import('../../memory/context-flush.service.js').ExtractedContextItem[] = [],
  ): Promise<string> {
    const conversationText = messages.map(msg => {
      const content = typeof msg.content === 'string'
        ? msg.content.substring(0, 2000)
        : JSON.stringify(msg.content).substring(0, 2000);
      return `[${msg.role}]: ${content}`;
    }).join('\n');

    // Build critical items section if any were extracted
    let criticalItemsSection = '';
    if (extractedItems.length > 0) {
      const itemLines = extractedItems.map(
        item => `- [${item.category}] ${item.content} (confidence: ${item.confidence})`,
      ).join('\n');
      criticalItemsSection = `\n\nIMPORTANT — The following critical items were auto-extracted and MUST appear in your summary:\n${itemLines}\n`;
    }

    const summarizationPrompt = `Summarize this conversation history into a structured state snapshot. Preserve ALL of the following if present:

1. **Active Tasks**: What tasks are in progress, assigned to whom, their status
2. **Decisions Made**: Key decisions and their rationale
3. **Key Findings**: Important discoveries, patterns, or blockers found
4. **Current Context**: What the agent is currently working on
5. **Pending Items**: Anything awaiting response or follow-up
${criticalItemsSection}
Be concise but complete. This summary replaces the original messages.

Conversation (${messages.length} messages):
${conversationText}`;

    const generateFn = this._generateTextFn || (generateText as Function);
    const result = await generateFn({
      model: this.model,
      messages: [{ role: 'user', content: summarizationPrompt }],
      maxOutputTokens: 2048,
      temperature: 0.1,
    });

    const summary = result.text || '';
    if (!summary || summary.length < 20) {
      throw new Error('AI summary too short, falling back');
    }

    return `[Compacted State — ${messages.length} messages summarized]\n\n${summary}`;
  }

  /**
   * Generate a truncation-based fallback summary when AI summarization fails.
   * Includes pre-extracted critical items so they survive compaction.
   *
   * @param messages - Messages to summarize
   * @param extractedItems - Critical items extracted by ContextFlushService
   * @returns Simple concatenated summary string
   */
  private generateFallbackSummary(
    messages: ModelMessage[],
    extractedItems: import('../../memory/context-flush.service.js').ExtractedContextItem[] = [],
  ): string {
    const summaryParts: string[] = [];
    for (const msg of messages) {
      const content = typeof msg.content === 'string'
        ? msg.content.substring(0, 1000)
        : JSON.stringify(msg.content).substring(0, 1000);
      summaryParts.push(`[${msg.role}]: ${content}`);
    }

    let result = `Previous conversation summary (${messages.length} messages compressed):\n${summaryParts.join('\n')}`;

    if (extractedItems.length > 0) {
      const itemLines = extractedItems.map(
        item => `- [${item.category}] ${item.content}`,
      ).join('\n');
      result += `\n\nExtracted critical context:\n${itemLines}`;
    }

    return result;
  }
}
