/**
 * Crewly Agent Evaluation Framework
 *
 * Barrel export for types, constants, scoring functions, runner, tasks,
 * and adapters.
 *
 * @module eval
 */

// Types & constants
export type {
  EvalLevel,
  EvalTask,
  RuntimeId,
  AdapterConfig,
  RuntimeAdapter,
  RuntimeResult,
  EvalVerification,
  EvalCheck,
  CodeQualityResult,
  DimensionId,
  DimensionScore,
  EvalMetrics,
  EvalTaskResult,
  EvalRunReport,
  EvalComparison,
  ModelPricing,
} from './eval-types.js';

export {
  EVAL_VERSION,
  DEFAULT_TASK_TIMEOUT_MS,
  MAX_TASK_STEPS,
  DIMENSION_WEIGHTS,
  MODEL_PRICING,
} from './eval-types.js';

// Scorer
export {
  calculateCost,
  scoreD1Completion,
  scoreD2CodeQuality,
  scoreD3ToolAccuracy,
  scoreD4Autonomy,
  scoreD5Collaboration,
  scoreD6Stability,
  scoreD7CostEfficiency,
  extractMetrics,
  scoreTask,
  aggregateResults,
  normalizeToBaseline,
  makeDimensionScore,
  extractSelfHealingSignals,
} from './eval-scorer.js';
export type { SelfHealingSignals } from './eval-scorer.js';

// Runner
export { runEvaluation } from './eval-runner.js';
export type { RunnerConfig } from './eval-runner.js';

// Tasks
export {
  ALL_TASKS,
  getTasksByLevel,
  getTaskById,
  getTaskSummary,
  L1_TASKS,
  L2_TASKS,
  L3_TASKS,
  L4_TASKS,
} from './tasks/index.js';

// Adapters
export { CrewlyAgentAdapter, CLIAdapter, createAdapter } from './adapters/index.js';
export type { CLIAdapterConfig } from './adapters/index.js';

// Context & tool log
export {
  generateContextMarkdown,
  generateTeamConfig,
  setupEvalWorkspace,
  DEFAULT_EVAL_TEAM,
} from './context-generator.js';
export type { EvalContextConfig, EvalTeamMember, SetupOptions } from './context-generator.js';

export {
  parseToolLog,
  parseToolLogContent,
  skillWasUsed,
  getSkillCalls,
  getDelegationTargets,
  getMessageRecipients,
  countSkillCalls,
  mergeToolCallRecords,
} from './tool-log-parser.js';
