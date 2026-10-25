/**
 * Eval scorer — computes per-dimension and overall scores for eval runs.
 * Implements the 7-dimension scoring model from the eval spec.
 */

import type {
  DimensionScores,
  EvalResult,
  EvalTask,
  RuntimeScorecard,
  RuntimeType,
  VerificationResult,
} from '../types/eval.types.js';
import type { ExecutionResult } from '../executors/base-executor.js';

/** Dimension weights (must sum to 1.0) */
const WEIGHTS = {
  d1Correctness: 0.25,
  d2CodeQuality: 0.15,
  d3Reasoning: 0.20,
  d4Autonomy: 0.15,
  d5ContextMgmt: 0.10,
  d6Collaboration: 0.05,
  d7CostEfficiency: 0.10,
} as const;

/**
 * Score a single eval run — one task executed by one runtime.
 *
 * @param task - The task definition with verification criteria
 * @param execResult - The execution result from the runtime
 * @param verificationResults - Results of post-execution verification checks
 * @returns Complete EvalResult with per-dimension scores and overall score
 */
export function scoreRun(
  task: EvalTask,
  execResult: ExecutionResult,
  verificationResults: VerificationResult[]
): EvalResult {
  const scores = computeDimensionScores(task, execResult, verificationResults);
  const overallScore = computeWeightedScore(scores);

  return {
    taskId: task.id,
    runtime: 'claude-code', // Will be overridden by caller
    startedAt: new Date(Date.now() - execResult.durationSeconds * 1000).toISOString(),
    completedAt: new Date().toISOString(),
    durationSeconds: execResult.durationSeconds,
    completionType: execResult.completionType,
    verificationResults,
    scores,
    overallScore,
    toolCallCount: execResult.toolCallCount,
    estimatedCostUsd: execResult.estimatedCostUsd,
    logPath: execResult.logPath,
    error: execResult.error,
  };
}

/**
 * Compute scores for all 7 dimensions.
 *
 * D1 (Correctness): Based on verification check pass rate
 * D2 (Code Quality): Based on TSC + lint passing
 * D3 (Reasoning): Based on step efficiency (min steps / actual steps)
 * D4 (Autonomy): Based on completion type (done=100, timeout=30, error=0)
 * D5 (Context Mgmt): Based on tool call efficiency
 * D6 (Collaboration): Crewly-only dimension (0 for single-agent runtimes)
 * D7 (Cost Efficiency): Based on cost vs baseline
 */
export function computeDimensionScores(
  task: EvalTask,
  execResult: ExecutionResult,
  verificationResults: VerificationResult[]
): DimensionScores {
  // D1: Correctness — verification pass rate
  const totalChecks = verificationResults.length || 1;
  const passedChecks = verificationResults.filter((v) => v.passed).length;
  const d1 = Math.round((passedChecks / totalChecks) * 100);

  // D2: Code Quality — TypeScript and lint checks
  const tsCheck = verificationResults.find((v) => v.name === 'typescript');
  const lintCheck = verificationResults.find((v) => v.name === 'lint');
  const testCheck = verificationResults.find((v) => v.name === 'tests');
  let d2 = 50; // baseline
  if (tsCheck?.passed) d2 += 20;
  if (lintCheck?.passed) d2 += 15;
  if (testCheck?.passed) d2 += 15;
  d2 = Math.min(d2, 100);

  // D3: Reasoning — step efficiency
  const stepEfficiency = Math.min(task.minStepsExpert / Math.max(execResult.toolCallCount, 1), 1.0);
  const d3 = Math.round(stepEfficiency * 100);

  // D4: Autonomy — did it finish without human help?
  let d4: number;
  switch (execResult.completionType) {
    case 'agent_done':
      d4 = 100;
      break;
    case 'timeout':
      d4 = 30;
      break;
    case 'error':
      d4 = 0;
      break;
  }

  // D5: Context Management — tool call efficiency (fewer is better)
  // Score: 100 if <= 2x expert steps, linearly decreasing to 0 at 10x
  const ratio = execResult.toolCallCount / Math.max(task.minStepsExpert, 1);
  const d5 = Math.max(0, Math.round(Math.min(100, 100 - ((ratio - 2) / 8) * 100)));

  // D6: Collaboration — 0 for single-agent, will be overridden for Crewly
  const d6 = 0;

  // D7: Cost Efficiency — ratio of baseline cost to actual cost
  const costRatio = task.baselineCostUsd / Math.max(execResult.estimatedCostUsd, 0.01);
  const d7 = Math.min(100, Math.round(costRatio * 100));

  return { d1Correctness: d1, d2CodeQuality: d2, d3Reasoning: d3, d4Autonomy: d4, d5ContextMgmt: d5, d6Collaboration: d6, d7CostEfficiency: d7 };
}

/**
 * Compute weighted overall score from dimension scores.
 * @param scores - Per-dimension scores (0-100 each)
 * @returns Weighted average score (0-100)
 */
export function computeWeightedScore(scores: DimensionScores): number {
  return Math.round(
    scores.d1Correctness * WEIGHTS.d1Correctness +
    scores.d2CodeQuality * WEIGHTS.d2CodeQuality +
    scores.d3Reasoning * WEIGHTS.d3Reasoning +
    scores.d4Autonomy * WEIGHTS.d4Autonomy +
    scores.d5ContextMgmt * WEIGHTS.d5ContextMgmt +
    scores.d6Collaboration * WEIGHTS.d6Collaboration +
    scores.d7CostEfficiency * WEIGHTS.d7CostEfficiency
  );
}

/**
 * Build a scorecard summarizing a runtime's performance across all tasks.
 *
 * @param runtime - The runtime being scored
 * @param results - All eval results for this runtime
 * @param baselineScore - The baseline overall score (Claude Code) for normalization
 * @returns Aggregated scorecard
 */
export function buildScorecard(
  runtime: RuntimeType,
  results: EvalResult[],
  baselineScore?: number
): RuntimeScorecard {
  const avgDimensionScores = averageDimensions(results.map((r) => r.scores));
  const overallAvg = results.reduce((sum, r) => sum + r.overallScore, 0) / Math.max(results.length, 1);
  const normalizedScore = baselineScore ? Math.round((overallAvg / baselineScore) * 100) : Math.round(overallAvg);

  return {
    runtime,
    taskResults: results,
    avgDimensionScores,
    normalizedScore,
    totalCostUsd: results.reduce((sum, r) => sum + r.estimatedCostUsd, 0),
    totalDurationSeconds: results.reduce((sum, r) => sum + r.durationSeconds, 0),
  };
}

/**
 * Average dimension scores across multiple results.
 */
function averageDimensions(allScores: DimensionScores[]): DimensionScores {
  const n = Math.max(allScores.length, 1);
  const sum = (key: keyof DimensionScores): number =>
    allScores.reduce((acc, s) => acc + s[key], 0);

  return {
    d1Correctness: Math.round(sum('d1Correctness') / n),
    d2CodeQuality: Math.round(sum('d2CodeQuality') / n),
    d3Reasoning: Math.round(sum('d3Reasoning') / n),
    d4Autonomy: Math.round(sum('d4Autonomy') / n),
    d5ContextMgmt: Math.round(sum('d5ContextMgmt') / n),
    d6Collaboration: Math.round(sum('d6Collaboration') / n),
    d7CostEfficiency: Math.round(sum('d7CostEfficiency') / n),
  };
}
