/**
 * Crewly Agent Runner Service
 *
 * Core reasoning loop for the Crewly Agent runtime. Wraps Vercel AI SDK's
 * generateText with conversation history management, context compaction,
 * and structured result tracking.
 *
 * @module services/agent/crewly-agent/agent-runner.service
 */

import { generateText, stepCountIs, type ModelMessage, type LanguageModel } from 'ai';
import { TracingService } from '../../core/tracing.service.js';
import { ContextFlushService } from '../../memory/context-flush.service.js';
import { TRACING_CONSTANTS } from '../../../constants.js';
import { ModelManager } from './model-manager.js';
import { CrewlyApiClient } from './api-client.js';
import { createTools } from './tool-registry.js';
import { McpClientService } from '../../mcp-client.js';
import { connectAndLoadMcpTools } from './mcp-tool-bridge.js';
import { ApprovalQueueService, type PendingApproval } from './approval-queue.service.js';
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
  CREWLY_AGENT_DEFAULTS,
  WRITE_TOOLS,
  MODEL_CONTEXT_WINDOWS,
} from './types.js';

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
  private messageQueue: Array<{ message: string; conversationId?: string; metadata?: Record<string, string>; resolve: (result: AgentRunResult) => void; reject: (error: Error) => void }> = [];
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
   * @returns Result of the agent run including text, tool calls, and usage
   */
  async run(message: string, conversationId?: string, metadata?: Record<string, string>): Promise<AgentRunResult> {
    return new Promise<AgentRunResult>((resolve, reject) => {
      this.messageQueue.push({ message, conversationId, metadata, resolve, reject });
      if (!this.processing) {
        this.processQueue();
      }
    });
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
        const result = await this.tracing.withSpan(TRACING_CONSTANTS.SPANS.AGENT_RUN, {
          attributes: {
            'agent.session': this.config.sessionName,
            'agent.role': this.config.role,
          }
        }, async () => {
          return this.executeRun(item.message);
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
   * Execute a single generateText run with the current conversation context.
   *
   * @param message - New message to add to the conversation
   * @returns Agent run result
   */
  private async executeRun(message: string): Promise<AgentRunResult> {
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

    // Execute generateText with agentic loop
    const generateFn = this._generateTextFn || (generateText as Function);
    const result = await generateFn({
      model: this.model,
      system: this.state.systemPrompt,
      messages: this.state.messages,
      tools,
      stopWhen: stepCountIs(this.config.maxSteps),
      temperature: this.config.model.temperature,
      maxOutputTokens: this.config.model.maxTokens,
    });

    // Track tool calls across all steps
    const toolCalls: ToolCallRecord[] = [];
    for (const step of result.steps) {
      if (step.toolCalls) {
        for (const tc of step.toolCalls) {
          toolCalls.push({
            toolName: tc.toolName,
            args: (tc as Record<string, unknown>).input as Record<string, unknown> ?? {},
            result: step.toolResults?.find(
              (tr: { toolCallId: string }) => tr.toolCallId === tc.toolCallId,
            )?.output,
          });
        }
      }
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
    if (result.text) {
      this.state.messages.push({ role: 'assistant', content: result.text });
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
      text: result.text,
      steps: result.steps.length,
      usage,
      toolCalls,
      finishReason: result.finishReason,
      budgetWarning,
    };
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
    if (!this.model || this.state.messages.length < 10) {
      return {
        compacted: false,
        messagesBefore: this.state.messages.length,
        messagesAfter: this.state.messages.length,
        reason: 'History too small to compact',
      };
    }

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
