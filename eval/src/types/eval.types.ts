/**
 * Core type definitions for the Crewly Eval Runner.
 * All benchmark tasks, scoring dimensions, and results are typed here.
 */

/** Evaluation task categories */
export type TaskCategory =
  | 'bug_fix'
  | 'feature'
  | 'refactor'
  | 'analysis'
  | 'collaboration'
  | 'business';

/**
 * Where a task's pass condition came from.
 * - `inferred`: written by us from what the owner's teams are seen doing; the
 *   bar may not match what a real owner would accept.
 * - `interviewed`: confirmed with an owner of that kind of business.
 */
export type TaskProvenance = 'inferred' | 'interviewed';

/** Difficulty tier */
export type TaskTier = 'easy' | 'medium' | 'hard';

/** Runtime being evaluated */
export type RuntimeType = 'claude-code' | 'crewly-agent' | 'gemini-cli' | 'codex-cli';

/** Verification check types */
export interface VerificationCheck {
  /** Name of the check (e.g., "test_suite", "typescript", "lint") */
  name: string;
  /** Shell command to run */
  command: string;
  /** Expected outcome: "all_pass", "no_new_errors", or a regex pattern */
  expected: string;
}

/**
 * Benchmark task definition.
 * Each task is a self-contained unit of work with setup, execution, and verification.
 */
export interface EvalTask {
  /** Unique task identifier (e.g., "A1", "B3") */
  id: string;
  /** Human-readable title */
  title: string;
  /** Category of work */
  category: TaskCategory;
  /** Difficulty tier */
  tier: TaskTier;
  /** Full task description given to the agent */
  description: string;
  /** Target repository/project path (relative to workspace root) */
  repoPath: string;
  /** Setup commands to run before the agent starts (npm install, git checkout, etc.) */
  setupCommands: string[];
  /** Commands to plant the bug/scenario before the agent starts */
  fixtureCommands: string[];
  /** Automated verification checks run after the agent finishes */
  verification: VerificationCheck[];
  /** File hints given to the agent */
  filesHint: string[];
  /** Minimum steps an expert human would take */
  minStepsExpert: number;
  /** Time limit in minutes */
  timeLimitMinutes: number;
  /** Baseline cost in USD (Claude Code Opus) */
  baselineCostUsd: number;
  /** How the pass condition was established (business tasks); omitted for code tasks */
  provenance?: TaskProvenance;
}

/**
 * Result of a single verification check.
 */
export interface VerificationResult {
  /** Check name */
  name: string;
  /** Whether the check passed */
  passed: boolean;
  /** Raw stdout/stderr output */
  output: string;
  /** Exit code */
  exitCode: number;
}

/**
 * Scoring dimensions — each 0-100.
 */
export interface DimensionScores {
  /** D1: Task Completion & Correctness (automated test results) */
  d1Correctness: number;
  /** D2: Code Quality (tsc + lint + LLM judge) */
  d2CodeQuality: number;
  /** D3: Multi-Step Reasoning (step efficiency) */
  d3Reasoning: number;
  /** D4: Autonomy (human intervention count) */
  d4Autonomy: number;
  /** D5: Context Management */
  d5ContextMgmt: number;
  /** D6: Collaboration (Crewly only) */
  d6Collaboration: number;
  /** D7: Cost Efficiency */
  d7CostEfficiency: number;
}

/**
 * Complete result of one eval run (one task × one runtime).
 */
export interface EvalResult {
  /** Task ID */
  taskId: string;
  /** Runtime used */
  runtime: RuntimeType;
  /** ISO timestamp of run start */
  startedAt: string;
  /** ISO timestamp of run end */
  completedAt: string;
  /** Wall-clock duration in seconds */
  durationSeconds: number;
  /** Whether the agent declared "done" vs time limit */
  completionType: 'agent_done' | 'timeout' | 'error';
  /** Verification results */
  verificationResults: VerificationResult[];
  /** Per-dimension scores */
  scores: DimensionScores;
  /** Weighted overall score (0-100) */
  overallScore: number;
  /** Total tool calls made by the agent */
  toolCallCount: number;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
  /** Raw agent output / conversation log path */
  logPath: string;
  /** Error message if completionType is 'error' */
  error?: string;
}

/**
 * Summary scorecard for a runtime across all tasks.
 */
export interface RuntimeScorecard {
  /** Runtime name */
  runtime: RuntimeType;
  /** Per-task results */
  taskResults: EvalResult[];
  /** Average scores per dimension */
  avgDimensionScores: DimensionScores;
  /** Overall normalized score (Claude Code = 100) */
  normalizedScore: number;
  /** Total cost across all tasks */
  totalCostUsd: number;
  /** Total duration across all tasks */
  totalDurationSeconds: number;
}

/**
 * Configuration for the eval runner.
 */
export interface EvalConfig {
  /** Workspace root where repos live */
  workspaceRoot: string;
  /** Directory to store results */
  resultsDir: string;
  /** Whether to use git worktrees for isolation */
  useWorktrees: boolean;
  /** Max parallel tasks (default 1 for determinism) */
  maxParallel: number;
  /** Claude Code CLI path */
  claudeCodePath: string;
  /** Crewly Agent API base URL */
  crewlyAgentUrl: string;
  /** Model override for the agent runtime (e.g., 'gemini-2.5-flash') */
  model?: string;
  /** Provider override (e.g., 'google', 'anthropic') */
  provider?: string;
}
