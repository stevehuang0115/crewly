/**
 * Monitoring Types
 *
 * Type definitions for token usage monitoring, cost tracking,
 * and budget configuration.
 *
 * @module types/monitoring
 */

// =============================================================================
// Token Usage Types
// =============================================================================

/**
 * Token usage summary for a single agent session.
 * Returned by the GET /api/monitoring/token-usage endpoint.
 */
export interface SessionUsageSummary {
  /** Terminal session name for the agent */
  sessionName: string;
  /** Agent member ID */
  agentId: string;
  /** Total input tokens consumed */
  totalInput: number;
  /** Total output tokens consumed */
  totalOutput: number;
  /** Number of LLM events recorded */
  eventCount: number;
  /** Server-computed cost in USD */
  cost?: number;
  /** Per-model usage breakdown */
  modelBreakdown?: ModelUsageBreakdown[];
}

/**
 * Token usage breakdown for a specific model.
 * Returned by the backend as part of SessionUsageSummary.
 */
export interface ModelUsageBreakdown {
  /** Model identifier (e.g. 'claude-sonnet-4-20250514') */
  model: string;
  /** Input tokens for this model */
  inputTokens: number;
  /** Output tokens for this model */
  outputTokens: number;
  /** Computed cost for this model in USD */
  cost: number;
}

// =============================================================================
// Budget Configuration Types
// =============================================================================

/**
 * Budget limits and warning thresholds for cost control.
 * Persisted in localStorage.
 */
export interface BudgetConfig {
  /** Maximum daily spend in USD */
  dailyLimit: number;
  /** Maximum weekly spend in USD */
  weeklyLimit: number;
  /** Maximum monthly spend in USD */
  monthlyLimit: number;
  /** Maximum tokens allowed per single task */
  maxTokensPerTask: number;
  /** Warning threshold as a percentage (e.g., 80 means warn at 80% of limit) */
  warningThreshold: number;
}

// =============================================================================
// Cost Calculation Types
// =============================================================================

/**
 * Per-model token cost rates (cost per token in USD).
 */
export interface TokenCostRate {
  /** Cost per input token in USD */
  input: number;
  /** Cost per output token in USD */
  output: number;
}

/**
 * Computed cost data for a single agent session.
 */
export interface AgentCostEntry {
  /** Agent session name */
  sessionName: string;
  /** Agent member ID */
  agentId: string;
  /** Input tokens consumed */
  inputTokens: number;
  /** Output tokens consumed */
  outputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
  /** Estimated cost in USD */
  cost: number;
  /** Number of LLM events */
  eventCount: number;
}
