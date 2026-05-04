/**
 * Crewly Agent Runtime Type Definitions
 *
 * Types for the in-process Crewly Agent runtime powered by Vercel AI SDK.
 * Covers model configuration, conversation state, and agent lifecycle.
 *
 * @module services/agent/crewly-agent/types
 */

import type { ModelMessage } from 'ai';
import type { z } from 'zod';
import type { McpServerConfig } from '../../mcp-client.js';
import type { McpSensitivityOverrides } from './mcp-tool-bridge.js';

/**
 * Supported model providers for Crewly Agent.
 *
 * Note: 'deepseek' is served through the OpenAI-compatible API at
 * https://api.deepseek.com/v1, but is exposed as a distinct provider
 * so users can select it explicitly. Its API key (DEEPSEEK_API_KEY) is
 * read from the environment, not from the settings service — see
 * model-manager.ts for details.
 */
export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'ollama' | 'deepseek';

/**
 * All valid model providers
 */
export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  'anthropic',
  'openai',
  'google',
  'ollama',
  'deepseek',
] as const;

/**
 * Configuration for a specific model instance
 */
export interface ModelConfig {
  /** Model provider (e.g., 'anthropic', 'openai', 'google', 'ollama') */
  provider: ModelProvider;
  /** Model identifier (e.g., 'claude-sonnet-4-20250514', 'gpt-4o', 'gemini-2.0-flash') */
  modelId: string;
  /** Optional temperature override (0-1) */
  temperature?: number;
  /** Optional max tokens per response */
  maxTokens?: number;
}

/**
 * Conversation state maintained by the AgentRunner
 */
export interface ConversationState {
  /** AI SDK ModelMessage array — the full conversation history */
  messages: ModelMessage[];
  /** System prompt loaded from prompt.md */
  systemPrompt: string;
  /** Cumulative token usage across all generateText calls */
  totalTokens: { input: number; output: number };
  /** Conversation creation time */
  createdAt: Date;
  /** Last activity timestamp */
  lastActivityAt: Date;
}

/**
 * Configuration for the Crewly Agent runtime
 */
export interface CrewlyAgentConfig {
  /** Model configuration for the agent */
  model: ModelConfig;
  /** Maximum reasoning steps per generateText call */
  maxSteps: number;
  /** Session name for this agent instance */
  sessionName: string;
  /** Agent role (e.g. developer, product-manager) */
  role?: string;
  /** Base URL for the Crewly REST API */
  apiBaseUrl: string;
  /** System prompt content (loaded from prompt.md) */
  systemPrompt: string;
  /** Maximum conversation history messages before compaction triggers */
  maxHistoryMessages: number;
  /** Token budget threshold (percentage of context window) for compaction */
  compactionThreshold: number;
  /** Project path for memory and task tools (auto-injected) */
  projectPath?: string;
  /** Team member ID for heartbeat tracking (used as key in teamAgentStatus.json) */
  memberId?: string;
  /** MCP server configurations for external tool integration */
  mcpServers?: Record<string, McpServerConfig>;
  /** Sensitivity overrides for MCP tools (key: 'serverName:toolName' or 'toolName') */
  mcpSensitivityOverrides?: McpSensitivityOverrides;
  /**
   * Eval mode flag. When true:
   * - Strips TL delegation-first instructions from system prompt
   * - Agent implements directly instead of delegating to workers
   * - Enables post-execution deliverable self-check (Stop Hook)
   */
  evalMode?: boolean;
}

/**
 * Result of a single agent run (one generateText invocation)
 */
export interface AgentRunResult {
  /** Final text response from the model */
  text: string;
  /** Number of steps taken in this run */
  steps: number;
  /** Token usage for this run */
  usage: { input: number; output: number };
  /** Tool calls made during this run */
  toolCalls: ToolCallRecord[];
  /** Reason the generation finished */
  finishReason: string;
  /** Budget warning message when token usage is approaching limits */
  budgetWarning?: string;
  /**
   * I2: DeepSeek-R1 chain-of-thought text extracted from `delta.reasoning_content`.
   *
   * Present only for `deepseek-reasoner` model runs. `null` if the run did not
   * produce any reasoning content (e.g. non-R1 model, or R1 returned content-only).
   * `undefined` for non-DeepSeek providers (no extraction is performed).
   *
   * Concatenated across all agentic steps in this single AgentRunResult — i.e.
   * if the model made N HTTP calls during this run, the reasoning from all N
   * is joined in call order.
   */
  reasoning?: string | null;
}

/**
 * Record of a single tool call during agent execution
 */
export interface ToolCallRecord {
  /** Tool name */
  toolName: string;
  /** Arguments passed to the tool */
  args: Record<string, unknown>;
  /** Result returned by the tool */
  result: unknown;
}

/**
 * Result of an API call to the Crewly backend
 */
export interface ApiCallResult<T = unknown> {
  /** Whether the call succeeded (HTTP 2xx) */
  success: boolean;
  /** Response data on success */
  data?: T;
  /** Error message on failure */
  error?: string;
  /** HTTP status code */
  status: number;
}

/**
 * Sensitivity classification for tool security auditing.
 *
 * - 'safe': Read-only or informational tools (no side effects)
 * - 'sensitive': Tools that modify state or communicate externally
 * - 'destructive': Tools that can cause irreversible damage
 */
export type ToolSensitivity = 'safe' | 'sensitive' | 'destructive';

/**
 * Tool definition shape matching AI SDK Tool interface.
 * Shared by both the main tool registry and the auditor tool registry.
 */
export interface ToolDefinition {
  /** Human-readable description of what the tool does */
  description: string;
  /** Zod schema for validating tool input */
  inputSchema: z.ZodType;
  /** Execute the tool with the given validated arguments */
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  /** Security sensitivity classification for audit purposes */
  sensitivity?: ToolSensitivity;
}

/**
 * Callbacks for streaming events during agent execution.
 * Emitted in real-time as the model generates text and calls tools.
 */
export interface StreamingEventCallbacks {
  /** Called when a text chunk arrives from the model */
  onTextChunk?: (chunk: string) => void;
  /** Called when a tool call starts executing */
  onToolCallStart?: (toolName: string, args: Record<string, unknown>) => void;
  /** Called when a tool call completes */
  onToolCallFinish?: (toolName: string, args: Record<string, unknown>, result: unknown, durationMs: number) => void;
  /** Called when a reasoning step completes */
  onStepFinish?: (stepIndex: number, hasToolCalls: boolean) => void;
}

/**
 * A single entry in the security audit trail.
 * Records every tool invocation with timing, classification, and result status.
 */
export interface AuditEntry {
  /** ISO timestamp of the tool invocation */
  timestamp: string;
  /** Agent session name that invoked the tool */
  sessionName?: string;
  /** Name of the tool that was called */
  toolName: string;
  /** Sensitivity classification of the tool */
  sensitivity: ToolSensitivity;
  /** Arguments passed to the tool (sanitized — no secrets) */
  args: Record<string, unknown>;
  /** Whether the tool call succeeded */
  success: boolean;
  /** Error message if the call failed */
  error?: string;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Security policy configuration for the agent runtime.
 * Controls which tool sensitivity levels require approval or are blocked.
 */
export interface SecurityPolicy {
  /** Whether audit logging is enabled */
  auditEnabled: boolean;
  /** Tool sensitivity levels that require explicit approval */
  requireApproval: ToolSensitivity[];
  /** Tool names that are completely blocked */
  blockedTools: string[];
  /** Maximum audit log entries to retain in memory */
  maxAuditEntries: number;
  /**
   * Read-only audit mode. When enabled, all tools classified as
   * 'sensitive' or 'destructive' are blocked — only 'safe' (read-only)
   * tools can execute. Tool invocations are still logged to the audit trail.
   */
  readOnlyMode: boolean;
}

/**
 * Tools that perform write/modify operations.
 * Used by readOnlyMode to determine which tools to block.
 */
export const WRITE_TOOLS: readonly string[] = [
  'edit_file',
  'write_file',
  'start_agent',
  'stop_agent',
  'handle_agent_failure',
  'delegate_task',
  'send_message',
  'reply_slack',
  'broadcast',
  'schedule_check',
  'cancel_schedule',
  'register_self',
  'report_status',
  'remember',
  'complete_task',
] as const;

/**
 * Context budget status for the current conversation.
 * Tracks token usage against the model's context window limit.
 */
export interface ContextBudgetStatus {
  /** Total tokens used so far (input + output) */
  totalTokensUsed: number;
  /** Estimated context window size for the current model */
  contextWindowSize: number;
  /** Usage as a fraction (0.0 - 1.0) */
  usagePercent: number;
  /** Current threshold level based on compactionThreshold */
  level: 'normal' | 'warning' | 'critical';
  /** Number of messages in conversation history */
  messageCount: number;
  /** Whether auto-compaction will trigger on next message */
  compactionPending: boolean;
  /** Human-readable summary */
  summary: string;
}

/**
 * Estimated context window sizes (in tokens) for known models.
 * Used for budget tracking when the model doesn't report its own limit.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  'claude-opus-4-20250514': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-haiku-4-20250506': 200_000,
  // Google
  'gemini-2.0-flash': 1_000_000,
  'gemini-2.5-flash-preview-05-20': 1_000_000,
  'gemini-3-flash-preview': 1_000_000,
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  // DeepSeek — V3 chat and R1 reasoner both ship with a 64k context window.
  // Without these entries the manager falls back to `default: 128_000`, which
  // would let Crewly's compaction trigger (0.8 × budget) skip past the real
  // 64k cap and let DeepSeek 4xx with context_length_exceeded.
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
  // Fallback
  default: 128_000,
} as const;

/**
 * Per-model floor on `maxOutputTokens` (the AI SDK's name for the
 * `max_tokens` request param). Used to defend against a class of bugs where
 * a low user-configured limit silently produces an empty response.
 *
 * Currently only `deepseek-reasoner` has a real floor: R1 mixes
 * `reasoning_tokens` into the same `max_tokens` budget as `completion_tokens`,
 * so a user value < ~200 can be entirely consumed by the reasoning trace,
 * leaving `message.content = ""` (200 OK, no error).
 *
 * Models not listed here resolve to a floor of 0 (no clamp).
 *
 * Discovered 2026-05-03 via live smoke test D — see
 * `.crewly/specs/2026-05-03-crewly-agent-deepseek-gap-list.md` (finding N5).
 */
export const MODEL_OUTPUT_TOKEN_FLOORS: Record<string, number> = {
  'deepseek-reasoner': 1024,
} as const;

/**
 * Resolve the effective `maxOutputTokens` for a given model configuration,
 * applying any per-model floor from `MODEL_OUTPUT_TOKEN_FLOORS`.
 *
 * If `config.maxTokens` is unset, falls back to the runtime default
 * (`CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL.maxTokens`). The result is always
 * `>= floor` for the model, where `floor` defaults to 0.
 *
 * @param config - Model configuration (may have `maxTokens` undefined)
 * @returns Effective max output tokens to pass to generateText/streamText
 */
export function resolveMaxOutputTokens(config: ModelConfig): number {
  const requested = config.maxTokens ?? CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL.maxTokens ?? 0;
  const floor = MODEL_OUTPUT_TOKEN_FLOORS[config.modelId] ?? 0;
  return Math.max(requested, floor);
}

/**
 * Result of an autonomous context compaction operation.
 * Returned by the compact_memory tool and requestCompaction().
 */
export interface CompactionResult {
  /** Whether compaction was performed */
  compacted: boolean;
  /** Number of messages before compaction */
  messagesBefore: number;
  /** Number of messages after compaction */
  messagesAfter: number;
  /** Reason if compaction was skipped */
  reason?: string;
}

/**
 * Result of a tool approval check.
 * Returned by the onCheckApproval callback to determine if a tool can execute.
 */
export interface ApprovalCheckResult {
  /** Whether the tool is allowed to execute */
  allowed: boolean;
  /** Reason if the tool is blocked or requires approval */
  reason?: string;
  /** Whether the tool was blocked (vs requiring approval) */
  blocked?: boolean;
}

/**
 * Callbacks from tool registry to the agent runner.
 * Allows tools to trigger runner-level operations like compaction and security checks.
 */
export interface ToolCallbacks {
  /** Trigger intelligent context compaction */
  onCompactMemory?: () => Promise<CompactionResult>;
  /** Get current context budget status */
  onGetContextBudget?: () => ContextBudgetStatus;
  /** Record an audit entry for a tool call */
  onAuditLog?: (entry: AuditEntry) => void;
  /** Check if a tool is allowed to execute given current security policy */
  onCheckApproval?: (toolName: string, sensitivity: ToolSensitivity) => ApprovalCheckResult;
  /** Retrieve audit log entries with optional filters */
  onGetAuditLog?: (filters: AuditLogFilters) => AuditEntry[];
  /** Enqueue a tool call for approval when it requires explicit approval */
  onEnqueueApproval?: (toolName: string, sensitivity: ToolSensitivity, args: Record<string, unknown>) => { approvalId: string };
}

/**
 * Filters for querying the audit log.
 */
export interface AuditLogFilters {
  /** Maximum entries to return (most recent first) */
  limit: number;
  /** Filter by sensitivity level */
  sensitivity?: ToolSensitivity;
  /** Filter by specific tool name */
  toolName?: string;
}

/**
 * Configuration for API key security guardrails.
 * Controls output filtering, environment isolation, and prompt protection.
 */
export interface SecurityGuardrailConfig {
  /** Enable output filtering (redact API keys from agent responses) */
  outputFilterEnabled: boolean;
  /** Enable environment isolation (strip secrets from bash child processes) */
  envIsolationEnabled: boolean;
  /** Enable prompt guard (block key extraction commands and prompt injections) */
  promptGuardEnabled: boolean;
  /** Additional env vars to explicitly allow in child processes */
  explicitEnvVars: string[];
}

/**
 * Default configuration values for Crewly Agent
 */
export const CREWLY_AGENT_DEFAULTS = {
  /** Default max reasoning steps per generateText call (high to mimic unlimited like Claude Code) */
  MAX_STEPS: 500,
  /** Maximum tool calls allowed per single response to prevent polling dead-loops */
  MAX_TOOL_CALLS_PER_RESPONSE: 15,
  /** Consecutive identical tool calls before aborting (loop detection) */
  LOOP_DETECTION_THRESHOLD: 3,
  /** Consecutive error responses (404, 4xx, 5xx) from the same tool before aborting */
  ERROR_LOOP_THRESHOLD: 3,
  /** Default API base URL */
  API_BASE_URL: 'http://localhost:8787',
  /** Default max history messages before compaction */
  MAX_HISTORY_MESSAGES: 100,
  /** Default compaction threshold (80% of context window) */
  COMPACTION_THRESHOLD: 0.8,
  /** Default model configuration */
  DEFAULT_MODEL: {
    provider: 'google' as ModelProvider,
    modelId: 'gemini-3-flash-preview',
    temperature: 0.3,
    maxTokens: 8192,
  } satisfies ModelConfig,
  /** HTTP request timeout in milliseconds */
  API_TIMEOUT_MS: 30_000,
  /** Heartbeat interval in milliseconds for keeping in-process agent active between messages */
  HEARTBEAT_INTERVAL_MS: 30_000,
  /** Maximum time in milliseconds for a single message processing (generateText call) — hard abort.
   *  Override via CREWLY_AGENT_MESSAGE_TIMEOUT_MS env var.
   *
   *  This is the **default** timeout used when the model has no entry in
   *  `MODEL_TIMEOUT_MS`. Per-model overrides take precedence — see below. */
  MESSAGE_TIMEOUT_MS: Number(process.env.CREWLY_AGENT_MESSAGE_TIMEOUT_MS) || 300_000,
  /** I4 — Per-model hard-timeout overrides. Looked up by `modelId`.
   *
   *  When the runtime service is about to run a message, it checks
   *  `MODEL_TIMEOUT_MS[config.model.modelId]` first; falls back to
   *  `MESSAGE_TIMEOUT_MS` if no entry exists.
   *
   *  **Why per-model:** different models have radically different latency
   *  characteristics. DeepSeek-R1 (`deepseek-reasoner`) emits chain-of-thought
   *  reasoning_tokens which are slower to generate than plain content tokens.
   *  Live smoke (2026-05-03) measured R1 single-step at avg 2.8s/max 4.8s, but
   *  long-context (>32k) latency rises sharply per vendor docs, and multi-step
   *  agentic loops can accumulate 30+ steps. 5min default is tight; 10min gives
   *  safety margin without inviting runaway loops. See gap-list spec §I4 for
   *  measurement evidence. */
  MODEL_TIMEOUT_MS: {
    /** DeepSeek-R1: 2× default — reasoning chain-of-thought is slower per token. */
    'deepseek-reasoner': 600_000,
  } as Record<string, number>,
  /** Soft warning threshold in milliseconds — logs a warning but does not kill the request.
   *  Override via CREWLY_AGENT_MESSAGE_SOFT_WARNING_MS env var. */
  MESSAGE_SOFT_WARNING_MS: Number(process.env.CREWLY_AGENT_MESSAGE_SOFT_WARNING_MS) || 240_000,
  /** Cooldown period in milliseconds after rate limit retries are exhausted */
  RATE_LIMIT_COOLDOWN_MS: 300_000,
  /** Maximum number of automatic retries for recoverable errors (429, 5xx, network) */
  MAX_RETRIES: 3,
  /** Base delay in milliseconds for exponential backoff between retries */
  RETRY_BASE_DELAY_MS: 1_000,
  /** Default Ollama API base URL for local LLM provider */
  OLLAMA_BASE_URL: 'http://localhost:11434/api',
  /** Default security policy */
  SECURITY_POLICY: {
    auditEnabled: true,
    requireApproval: [] as ToolSensitivity[],
    blockedTools: [] as string[],
    maxAuditEntries: 500,
    readOnlyMode: false,
  } satisfies SecurityPolicy,
  /** Default security guardrail configuration */
  SECURITY_GUARDRAILS: {
    outputFilterEnabled: true,
    envIsolationEnabled: true,
    promptGuardEnabled: true,
    explicitEnvVars: [],
  } satisfies SecurityGuardrailConfig,
} as const;

/**
 * Type guard to check if a string is a valid ModelProvider
 *
 * @param value - String to check
 * @returns True if the value is a valid ModelProvider
 */
export function isModelProvider(value: string): value is ModelProvider {
  return MODEL_PROVIDERS.includes(value as ModelProvider);
}

/**
 * Supported models for the UI dropdown.
 * Format: provider/modelId → display label
 */
export const SUPPORTED_MODELS: Array<{ id: string; label: string; provider: ModelProvider }> = [
  { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)', provider: 'google' },
  { id: 'google/gemini-2.5-flash-preview-05-20', label: 'Gemini 2.5 Flash', provider: 'google' },
  { id: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4', provider: 'anthropic' },
  { id: 'anthropic/claude-haiku-4-20250514', label: 'Claude Haiku 4', provider: 'anthropic' },
  { id: 'openai/gpt-4o', label: 'GPT-4o', provider: 'openai' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini', provider: 'openai' },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3', provider: 'deepseek' },
  { id: 'deepseek/deepseek-reasoner', label: 'DeepSeek R1', provider: 'deepseek' },
  { id: 'ollama/llama3', label: 'Llama 3 (Ollama)', provider: 'ollama' },
];

/**
 * Parse a modelId string (provider/modelId) into a ModelConfig.
 * Falls back to DEFAULT_MODEL if the input is invalid.
 *
 * @param modelId - Format: "provider/modelId" (e.g. "google/gemini-3-flash-preview")
 * @returns Parsed ModelConfig
 */
export function parseModelId(modelId: string | undefined): ModelConfig {
  if (!modelId || !modelId.includes('/')) {
    return CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL;
  }

  const slashIdx = modelId.indexOf('/');
  const provider = modelId.substring(0, slashIdx);
  const model = modelId.substring(slashIdx + 1);

  if (!isModelProvider(provider) || !model) {
    return CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL;
  }

  return {
    provider,
    modelId: model,
    temperature: CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL.temperature,
    maxTokens: CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL.maxTokens,
  };
}

/**
 * Type guard to check if an object is a valid ModelConfig
 *
 * @param obj - Object to validate
 * @returns True if the object has all required ModelConfig fields
 */
export function isModelConfig(obj: unknown): obj is ModelConfig {
  if (typeof obj !== 'object' || obj === null) return false;
  const candidate = obj as Record<string, unknown>;
  return (
    typeof candidate.provider === 'string' &&
    isModelProvider(candidate.provider) &&
    typeof candidate.modelId === 'string' &&
    candidate.modelId.length > 0
  );
}
