/**
 * Crewly Agent Evaluation Framework - Type Definitions
 *
 * Defines all types, interfaces, and constants used by the eval framework
 * for benchmarking agent runtimes across multiple dimensions.
 *
 * @module eval-types
 */

import type { ToolCallRecord } from '../types.js';

// ---------------------------------------------------------------------------
// Version & defaults
// ---------------------------------------------------------------------------

/** Current evaluation framework version */
export const EVAL_VERSION = '1.0.0';

/** Default timeout per task in milliseconds (5 minutes) */
export const DEFAULT_TASK_TIMEOUT_MS = 300_000;

/** Maximum number of steps a task may take */
export const MAX_TASK_STEPS = 50;

// ---------------------------------------------------------------------------
// Task definitions
// ---------------------------------------------------------------------------

/**
 * Complexity level of an evaluation task.
 *
 * - L1 -- basic single-tool operations
 * - L2 -- multi-step workflows
 * - L3 -- complex reasoning and planning
 * - L4 -- multi-agent collaboration
 */
export type EvalLevel = 'L1' | 'L2' | 'L3' | 'L4';

/**
 * Setup / verify / teardown lifecycle hooks for a task.
 *
 * - `setup`    -- prepares the work directory before the agent runs
 * - `verify`   -- inspects the work directory after the agent finishes
 * - `teardown` -- cleans up resources regardless of outcome
 */
export interface EvalTask {
  /** Unique task identifier, e.g. "L1-01" */
  id: string;
  /** Complexity level */
  level: EvalLevel;
  /** Human-readable title */
  title: string;
  /** The prompt sent to the agent runtime */
  prompt: string;
  /** Maximum steps the agent is allowed to take */
  maxSteps: number;
  /** Per-task timeout in milliseconds */
  timeoutMs: number;
  /** Tool names the task is expected to exercise */
  expectedTools: string[];
  /**
   * Prepare the work directory before the task runs.
   *
   * @param workDir - absolute path to the temporary work directory
   */
  setup: (workDir: string) => Promise<void>;
  /**
   * Verify the agent's output after it finishes.
   *
   * @param workDir    - absolute path to the work directory
   * @param toolCalls  - tool call records from the runtime
   * @returns verification result with pass/fail and details
   */
  verify: (workDir: string, toolCalls: ToolCallRecord[]) => Promise<EvalVerification>;
  /**
   * Optional cleanup hook that runs after verify, even on failure.
   *
   * @param workDir - absolute path to the work directory
   */
  teardown?: (workDir: string) => Promise<void>;
  /** Freeform tags for filtering (e.g. "file-ops", "git") */
  tags?: string[];
  /** Whether this task requires multi-agent collaboration (L4) */
  multiAgent?: boolean;
}

// ---------------------------------------------------------------------------
// Runtime adapters
// ---------------------------------------------------------------------------

/** Supported runtime identifiers */
export type RuntimeId = 'crewly-agent' | 'claude-code' | 'gemini-cli' | 'codex-cli';

/**
 * Configuration passed to a RuntimeAdapter during initialization.
 */
export interface AdapterConfig {
  /** Runtime identifier */
  runtimeId: RuntimeId;
  /** Model identifier (e.g. "claude-opus-4") */
  model: string;
  /** Working directory root for all tasks */
  workDir: string;
  /** Whether to emit verbose logs */
  verbose?: boolean;
  /** Additional adapter-specific options */
  options?: Record<string, unknown>;
}

/**
 * Adapter interface that each supported runtime must implement.
 */
export interface RuntimeAdapter {
  /**
   * One-time initialization (start processes, authenticate, etc.).
   *
   * @param config - adapter configuration
   */
  initialize(config: AdapterConfig): Promise<void>;

  /**
   * Execute a single eval task and return the raw result.
   *
   * @param task    - the task definition
   * @param workDir - absolute path to the task's work directory
   * @returns raw runtime result with output, timing, and tool calls
   */
  runTask(task: EvalTask, workDir: string): Promise<RuntimeResult>;

  /**
   * Graceful shutdown -- release resources, kill child processes.
   */
  shutdown(): Promise<void>;
}

/**
 * Raw result returned by a runtime adapter after executing a task.
 */
export interface RuntimeResult {
  /** Whether the task completed without crashing */
  success: boolean;
  /** Final text output from the runtime */
  output: string;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** Number of reasoning / action steps taken */
  steps: number;
  /** Token usage */
  usage: { input: number; output: number };
  /** Ordered list of tool calls */
  toolCalls: ToolCallRecord[];
  /** Number of times the agent had to be nudged / re-prompted */
  humanNudges: number;
  /** Error message if the task failed */
  error?: string;
  /** Whether the task timed out */
  timedOut?: boolean;
  /** Whether a loop was detected */
  loopDetected?: boolean;
}

// ---------------------------------------------------------------------------
// Verification & code quality
// ---------------------------------------------------------------------------

/**
 * Result of verifying a completed task.
 */
export interface EvalVerification {
  /** Overall pass / fail */
  passed: boolean;
  /** Detailed check results */
  checks: EvalCheck[];
  /** Optional code quality analysis */
  codeQuality?: CodeQualityResult;
  /** Collaboration-specific checks for L4 tasks */
  collaborationChecks?: EvalCheck[];
}

/**
 * A single boolean check inside a verification.
 */
export interface EvalCheck {
  /** Short machine-readable name */
  name: string;
  /** Whether this check passed */
  passed: boolean;
  /** Human-readable explanation */
  message: string;
}

/**
 * Code quality metrics produced by static analysis of agent output.
 */
export interface CodeQualityResult {
  /** TypeScript type-check passes */
  typecheckPassed: boolean;
  /** ESLint passes with zero errors */
  lintPassed: boolean;
  /** Test coverage percentage (0-100) */
  coveragePercent: number;
  /** Whether prohibited patterns (e.g. `any`, `console.log`) are absent */
  noAntiPatterns: boolean;
}

// ---------------------------------------------------------------------------
// Scoring dimensions
// ---------------------------------------------------------------------------

/**
 * The seven evaluation dimensions.
 *
 * Dimension weights must sum to 1.0.
 */
export type DimensionId =
  | 'D1_completion'
  | 'D2_codeQuality'
  | 'D3_toolAccuracy'
  | 'D4_autonomy'
  | 'D5_collaboration'
  | 'D6_stability'
  | 'D7_costEfficiency';

/**
 * Weights applied to each dimension when computing the composite score.
 * All values sum to 1.0.
 */
export const DIMENSION_WEIGHTS: Readonly<Record<DimensionId, number>> = {
  D1_completion: 0.25,
  D2_codeQuality: 0.15,
  D3_toolAccuracy: 0.15,
  D4_autonomy: 0.15,
  D5_collaboration: 0.10,
  D6_stability: 0.10,
  D7_costEfficiency: 0.10,
} as const;

/**
 * Score for a single dimension, 0-100.
 */
export interface DimensionScore {
  /** Dimension identifier */
  dimensionId: DimensionId;
  /** Raw score before weighting (0-100) */
  raw: number;
  /** Weight applied to this dimension */
  weight: number;
  /** Weighted score contribution (raw * weight) */
  weighted: number;
}

// ---------------------------------------------------------------------------
// Metrics & results
// ---------------------------------------------------------------------------

/**
 * Extracted metrics from a single task run, used as input to the scorer.
 */
export interface EvalMetrics {
  /** Wall-clock duration in ms */
  durationMs: number;
  /** Number of steps taken */
  steps: number;
  /** Token usage */
  usage: { input: number; output: number };
  /** Estimated cost in USD */
  costUSD: number;
  /** Total number of tool calls */
  toolCallCount: number;
  /** Number of tool calls that matched expected tools */
  correctToolCalls: number;
  /** Number of unnecessary / unexpected tool calls */
  unnecessaryToolCalls: number;
  /** Ratio of correct argument usage (0-1) */
  argAccuracy: number;
  /** Number of tool errors encountered */
  toolErrors: number;
  /** Number of times the agent was nudged */
  humanNudges: number;
  /** Whether a loop was detected */
  loopDetected: boolean;
  /** Whether the task timed out */
  timedOut: boolean;
}

/**
 * Complete result for a single evaluated task.
 */
export interface EvalTaskResult {
  /** Task identifier */
  taskId: string;
  /** Task level */
  level: EvalLevel;
  /** Task title */
  title: string;
  /** Whether the runtime produced a result (did not crash) */
  success: boolean;
  /** Per-dimension scores */
  dimensions: DimensionScore[];
  /** Composite weighted score (0-100) */
  composite: number;
  /** Extracted metrics */
  metrics: EvalMetrics;
  /** Verification result */
  verification: EvalVerification;
  /** Error message if the task failed to run */
  error?: string;
}

/**
 * Aggregated report for a full evaluation run.
 */
export interface EvalRunReport {
  /** Framework version */
  version: string;
  /** Runtime that was evaluated */
  runtimeId: RuntimeId;
  /** Model used */
  model: string;
  /** ISO 8601 timestamp of when the run started */
  timestamp: string;
  /** Individual task results */
  taskResults: EvalTaskResult[];
  /** Aggregate dimension scores (averaged across tasks) */
  aggregateDimensions: DimensionScore[];
  /** Overall composite score (0-100) */
  overallComposite: number;
  /** Total duration in ms */
  totalDurationMs: number;
  /** Total estimated cost in USD */
  totalCostUSD: number;
  /** Number of tasks that passed */
  passedCount: number;
  /** Total number of tasks evaluated */
  totalCount: number;
}

/**
 * Side-by-side comparison between two eval run reports.
 */
export interface EvalComparison {
  /** Baseline report (reference) */
  baseline: EvalRunReport;
  /** Candidate report (being compared) */
  candidate: EvalRunReport;
  /** Per-dimension deltas (candidate minus baseline) */
  dimensionDeltas: Record<DimensionId, number>;
  /** Overall composite delta */
  compositeScoreDelta: number;
  /** Cost delta in USD */
  costDelta: number;
}

// ---------------------------------------------------------------------------
// Model pricing
// ---------------------------------------------------------------------------

/**
 * Pricing information for a single model, per million tokens.
 */
export interface ModelPricing {
  /** Cost per 1 M input tokens in USD */
  inputPerMillion: number;
  /** Cost per 1 M output tokens in USD */
  outputPerMillion: number;
}

/**
 * Known model pricing table.
 *
 * Prices are in USD per 1 million tokens.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-opus-4': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-sonnet-4': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-3-5-haiku': { inputPerMillion: 1, outputPerMillion: 5 },
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'o3-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  'gemini-2.0-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10 },
} as const;
