/**
 * Crewly Agent Evaluation Framework - Scoring Engine
 *
 * Implements the seven-dimension scoring model for evaluating agent task
 * performance. Each dimension produces a 0-100 raw score that is then
 * weighted according to {@link DIMENSION_WEIGHTS} and aggregated into a
 * composite score.
 *
 * @module eval-scorer
 */

import type { ToolCallRecord } from '../types.js';
import {
  DIMENSION_WEIGHTS,
  EVAL_VERSION,
  MODEL_PRICING,
  type DimensionId,
  type DimensionScore,
  type EvalLevel,
  type EvalMetrics,
  type EvalRunReport,
  type EvalTask,
  type EvalTaskResult,
  type EvalVerification,
  type RuntimeId,
  type RuntimeResult,
} from './eval-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a number to the [0, 100] range.
 *
 * @param value - raw score to clamp
 * @returns value clamped between 0 and 100
 */
function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Create a {@link DimensionScore} record from a dimension ID and raw score.
 *
 * @param dimensionId - the dimension being scored
 * @param raw         - raw score (0-100, will be clamped)
 * @returns fully populated DimensionScore
 */
export function makeDimensionScore(dimensionId: DimensionId, raw: number): DimensionScore {
  const clamped = clamp(raw);
  const weight = DIMENSION_WEIGHTS[dimensionId];
  return {
    dimensionId,
    raw: clamped,
    weight,
    weighted: clamped * weight,
  };
}

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the estimated cost of a model invocation in USD.
 *
 * Uses the {@link MODEL_PRICING} table. Falls back to zero if the model
 * is unknown.
 *
 * @param model        - model identifier (e.g. "claude-opus-4")
 * @param inputTokens  - number of input tokens consumed
 * @param outputTokens - number of output tokens produced
 * @returns estimated cost in USD
 */
export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    return 0;
  }
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return inputCost + outputCost;
}

// ---------------------------------------------------------------------------
// D1 -- Completion
// ---------------------------------------------------------------------------

/**
 * Score dimension D1: Task Completion.
 *
 * Awards 70 points for a passing verification, plus up to 30 points
 * proportional to the fraction of individual checks that passed.
 *
 * @param verification - result of the task verification step
 * @returns raw score 0-100
 */
export function scoreD1Completion(verification: EvalVerification): number {
  const passBonus = verification.passed ? 70 : 0;
  const checks = verification.checks;
  if (checks.length === 0) {
    return passBonus;
  }
  const passedChecks = checks.filter((c) => c.passed).length;
  const partial = (passedChecks / checks.length) * 30;
  return clamp(passBonus + partial);
}

// ---------------------------------------------------------------------------
// D2 -- Code Quality
// ---------------------------------------------------------------------------

/**
 * Score dimension D2: Code Quality.
 *
 * Four equally-weighted sub-scores (25 points each):
 * - TypeScript type-check passes
 * - ESLint lint passes
 * - Test coverage percentage
 * - Absence of anti-patterns
 *
 * If no code quality data is available, returns 50 (neutral).
 *
 * @param verification - result of the task verification step
 * @returns raw score 0-100
 */
export function scoreD2CodeQuality(verification: EvalVerification): number {
  const cq = verification.codeQuality;
  if (!cq) {
    return 50;
  }
  let score = 0;
  if (cq.typecheckPassed) score += 25;
  if (cq.lintPassed) score += 25;
  score += (cq.coveragePercent / 100) * 25;
  if (cq.noAntiPatterns) score += 25;
  return clamp(score);
}

// ---------------------------------------------------------------------------
// D3 -- Tool Accuracy
// ---------------------------------------------------------------------------

/**
 * Score dimension D3: Tool Accuracy.
 *
 * Weighted combination:
 * - 60% -- ratio of correct tool calls to total tool calls
 * - 20% -- penalty-free if no unnecessary tool calls
 * - 20% -- argument accuracy ratio
 *
 * @param metrics - extracted metrics from the task run
 * @returns raw score 0-100
 */
export function scoreD3ToolAccuracy(metrics: EvalMetrics): number {
  if (metrics.toolCallCount === 0) {
    return 0;
  }
  const correctRatio = metrics.correctToolCalls / metrics.toolCallCount;
  const noUnnecessary = metrics.unnecessaryToolCalls === 0 ? 1 : 0;
  const argAcc = metrics.argAccuracy;

  return clamp((correctRatio * 60 + noUnnecessary * 20 + argAcc * 20));
}

// ---------------------------------------------------------------------------
// D4 -- Autonomy
// ---------------------------------------------------------------------------

/**
 * Score dimension D4: Autonomy.
 *
 * Starts at 100 and deducts 20 points per human nudge.
 *
 * @param humanNudges - number of times the agent required manual intervention
 * @returns raw score 0-100
 */
export function scoreD4Autonomy(humanNudges: number): number {
  return clamp(100 - humanNudges * 20);
}

// ---------------------------------------------------------------------------
// D5 -- Collaboration
// ---------------------------------------------------------------------------

/**
 * Score dimension D5: Collaboration.
 *
 * Only meaningful for L4 (multi-agent) tasks. For L1-L3 tasks this
 * dimension returns a perfect score of 100.
 *
 * For L4 tasks, the score is derived from collaboration-specific checks
 * in the verification result.
 *
 * @param level        - task complexity level
 * @param verification - result of the task verification step
 * @returns raw score 0-100
 */
export function scoreD5Collaboration(level: EvalLevel, verification: EvalVerification): number {
  if (level !== 'L4') {
    return 100;
  }
  const checks = verification.collaborationChecks;
  if (!checks || checks.length === 0) {
    return 0;
  }
  const passedCount = checks.filter((c) => c.passed).length;
  return clamp((passedCount / checks.length) * 100);
}

// ---------------------------------------------------------------------------
// D6 -- Stability
// ---------------------------------------------------------------------------

/**
 * Score dimension D6: Stability & Self-Healing.
 *
 * Base stability scoring (penalties from 100):
 * - Loop detected: -30
 * - Each tool error: -10
 * - Timed out: -40
 *
 * For L4-T (trap) tasks, self-healing signals are folded into D6
 * as bonuses that partially offset penalties. This keeps the 7-dimension
 * schema unchanged while rewarding resilience:
 * - Discovered trap without being told: +25
 * - Correct diagnosis: +25
 * - Effective fix: +25
 * - Recovery from own mistakes: +10
 *
 * @param metrics      - extracted metrics from the task run
 * @param selfHealing  - optional self-healing signal scores for L4-T tasks
 * @returns raw score 0-100
 */
export function scoreD6Stability(
  metrics: EvalMetrics,
  selfHealing?: SelfHealingSignals,
): number {
  let score = 100;
  if (metrics.loopDetected) score -= 30;
  score -= metrics.toolErrors * 10;
  if (metrics.timedOut) score -= 40;

  // Self-healing bonuses for trap tasks (folded into D6)
  if (selfHealing) {
    let healingBonus = 0;
    if (selfHealing.discoveredTrap) healingBonus += 25;
    if (selfHealing.correctDiagnosis) healingBonus += 25;
    if (selfHealing.effectiveFix) healingBonus += 25;
    if (selfHealing.recoveredFromMistake) healingBonus += 10;
    // Bonus is scaled: it can offset penalties but max total is 100
    score += healingBonus;
  }

  return clamp(score);
}

/**
 * Signals indicating self-healing behavior during L4-T (trap) tasks.
 *
 * These signals are extracted from verification checks on trap tasks
 * and folded into the D6 (Stability) dimension score.
 */
export interface SelfHealingSignals {
  /** Agent discovered the undisclosed trap without being told */
  discoveredTrap: boolean;
  /** Agent correctly identified the root cause */
  correctDiagnosis: boolean;
  /** Agent applied an effective fix */
  effectiveFix: boolean;
  /** Agent made a wrong assumption first, then self-corrected */
  recoveredFromMistake: boolean;
}

/**
 * Extract self-healing signals from L4-T task verification results.
 *
 * Maps collaboration check names to self-healing signal fields.
 * Only applicable to trap tasks (L4-T1, L4-T2, L4-T3).
 *
 * @param taskId       - task identifier
 * @param verification - verification result from the task
 * @returns self-healing signals, or undefined for non-trap tasks
 */
export function extractSelfHealingSignals(
  taskId: string,
  verification: EvalVerification,
): SelfHealingSignals | undefined {
  if (!taskId.startsWith('L4-T')) {
    return undefined;
  }

  const checks = verification.collaborationChecks ?? [];
  const passed = (name: string): boolean =>
    checks.some((c) => c.name === name && c.passed);

  // Map verification check names to self-healing signals per task
  switch (taskId) {
    case 'L4-T1':
      return {
        discoveredTrap: passed('discovered_structure_discrepancy'),
        correctDiagnosis: passed('adapted_to_correct_location'),
        effectiveFix: passed('adapted_to_correct_location'),
        recoveredFromMistake: false, // Cannot detect from static checks
      };
    case 'L4-T2':
      return {
        discoveredTrap: passed('identified_multiple_issues'),
        correctDiagnosis: passed('reported_root_causes'),
        effectiveFix: passed('did_not_ignore_errors'),
        recoveredFromMistake: false,
      };
    case 'L4-T3':
      return {
        discoveredTrap: passed('handled_conflicting_state'),
        correctDiagnosis: passed('handled_malformed_json'),
        effectiveFix: passed('made_reasonable_decision'),
        recoveredFromMistake: false,
      };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// D7 -- Cost Efficiency
// ---------------------------------------------------------------------------

/**
 * Score dimension D7: Cost Efficiency.
 *
 * Compares the actual cost to a baseline cost using the ratio
 * `baseline / actual`. If the ratio is >= 1 (cheaper or equal), the
 * score is 100. Otherwise the score scales linearly down to 0.
 *
 * If no baseline is provided, defaults to 100.
 *
 * @param actualCostUSD   - actual cost of the task run in USD
 * @param baselineCostUSD - baseline cost for comparison in USD
 * @returns raw score 0-100
 */
export function scoreD7CostEfficiency(actualCostUSD: number, baselineCostUSD: number): number {
  if (baselineCostUSD <= 0 || actualCostUSD <= 0) {
    return 100;
  }
  const ratio = baselineCostUSD / actualCostUSD;
  if (ratio >= 1) {
    return 100;
  }
  return clamp(ratio * 100);
}

// ---------------------------------------------------------------------------
// Metric extraction
// ---------------------------------------------------------------------------

/**
 * Extract scoring metrics from a raw runtime result.
 *
 * Computes derived values such as cost, correct tool call counts, and
 * argument accuracy from the raw tool call records and expected tools.
 *
 * @param result - raw runtime result from the adapter
 * @param task   - the task definition (for expected tools)
 * @param model  - model identifier for cost calculation
 * @returns extracted metrics ready for the scorer
 */
export function extractMetrics(result: RuntimeResult, task: EvalTask, model: string): EvalMetrics {
  const costUSD = calculateCost(model, result.usage.input, result.usage.output);
  const expectedSet = new Set(task.expectedTools);
  const toolCalls = result.toolCalls;

  let correctToolCalls = 0;
  let unnecessaryToolCalls = 0;
  let toolErrors = 0;

  for (const call of toolCalls) {
    if (expectedSet.has(call.toolName)) {
      correctToolCalls++;
    } else {
      unnecessaryToolCalls++;
    }
    if (call.result && typeof call.result === 'object' && 'error' in (call.result as Record<string, unknown>)) {
      toolErrors++;
    }
  }

  // Argument accuracy: assume 1.0 unless tool errors indicate problems
  const argAccuracy = toolCalls.length > 0 ? Math.max(0, 1 - toolErrors / toolCalls.length) : 1;

  return {
    durationMs: result.durationMs,
    steps: result.steps,
    usage: { input: result.usage.input, output: result.usage.output },
    costUSD,
    toolCallCount: toolCalls.length,
    correctToolCalls,
    unnecessaryToolCalls,
    argAccuracy,
    toolErrors,
    humanNudges: result.humanNudges,
    loopDetected: result.loopDetected ?? false,
    timedOut: result.timedOut ?? false,
  };
}

// ---------------------------------------------------------------------------
// Task scoring
// ---------------------------------------------------------------------------

/**
 * Score a single task across all seven dimensions and produce a composite.
 *
 * @param task            - task definition
 * @param result          - raw runtime result
 * @param verification    - verification result
 * @param runtime         - runtime identifier
 * @param model           - model identifier
 * @param baselineCostUSD - optional baseline cost for D7 scoring
 * @returns complete task result with dimension scores and composite
 */
export function scoreTask(
  task: EvalTask,
  result: RuntimeResult,
  verification: EvalVerification,
  runtime: RuntimeId,
  model: string,
  baselineCostUSD?: number,
): EvalTaskResult {
  const metrics = extractMetrics(result, task, model);

  // Extract self-healing signals for L4-T trap tasks
  const selfHealing = extractSelfHealingSignals(task.id, verification);

  const dimensions: DimensionScore[] = [
    makeDimensionScore('D1_completion', scoreD1Completion(verification)),
    makeDimensionScore('D2_codeQuality', scoreD2CodeQuality(verification)),
    makeDimensionScore('D3_toolAccuracy', scoreD3ToolAccuracy(metrics)),
    makeDimensionScore('D4_autonomy', scoreD4Autonomy(metrics.humanNudges)),
    makeDimensionScore('D5_collaboration', scoreD5Collaboration(task.level, verification)),
    makeDimensionScore('D6_stability', scoreD6Stability(metrics, selfHealing)),
    makeDimensionScore('D7_costEfficiency', scoreD7CostEfficiency(metrics.costUSD, baselineCostUSD ?? 0)),
  ];

  const composite = dimensions.reduce((sum, d) => sum + d.weighted, 0);

  return {
    taskId: task.id,
    level: task.level,
    title: task.title,
    success: result.success,
    dimensions,
    composite,
    metrics,
    verification,
    error: result.error,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate individual task results into a full run report.
 *
 * Computes average dimension scores, overall composite, totals for
 * duration and cost, and pass counts.
 *
 * @param taskResults - array of scored task results
 * @param runtime     - runtime identifier
 * @param model       - model identifier
 * @returns complete evaluation run report
 */
export function aggregateResults(
  taskResults: EvalTaskResult[],
  runtime: RuntimeId,
  model: string,
): EvalRunReport {
  const dimensionIds: DimensionId[] = [
    'D1_completion',
    'D2_codeQuality',
    'D3_toolAccuracy',
    'D4_autonomy',
    'D5_collaboration',
    'D6_stability',
    'D7_costEfficiency',
  ];

  const aggregateDimensions: DimensionScore[] = dimensionIds.map((id) => {
    if (taskResults.length === 0) {
      return makeDimensionScore(id, 0);
    }
    const avgRaw =
      taskResults.reduce((sum, tr) => {
        const dim = tr.dimensions.find((d) => d.dimensionId === id);
        return sum + (dim?.raw ?? 0);
      }, 0) / taskResults.length;
    return makeDimensionScore(id, avgRaw);
  });

  const overallComposite = aggregateDimensions.reduce((sum, d) => sum + d.weighted, 0);
  const totalDurationMs = taskResults.reduce((sum, tr) => sum + tr.metrics.durationMs, 0);
  const totalCostUSD = taskResults.reduce((sum, tr) => sum + tr.metrics.costUSD, 0);
  const passedCount = taskResults.filter((tr) => tr.verification.passed).length;

  return {
    version: EVAL_VERSION,
    runtimeId: runtime,
    model,
    timestamp: new Date().toISOString(),
    taskResults,
    aggregateDimensions,
    overallComposite,
    totalDurationMs,
    totalCostUSD,
    passedCount,
    totalCount: taskResults.length,
  };
}

// ---------------------------------------------------------------------------
// Baseline normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a candidate report's scores relative to a baseline report.
 *
 * For each dimension, the normalized raw score is computed as:
 *   `(candidate_raw / baseline_raw) * 100`
 *
 * This allows fair comparison across different baseline configurations.
 *
 * @param report         - candidate evaluation report to normalize
 * @param baselineReport - baseline report to normalize against
 * @returns a new report with normalized dimension scores
 */
export function normalizeToBaseline(
  report: EvalRunReport,
  baselineReport: EvalRunReport,
): EvalRunReport {
  const normalizedAggregate = report.aggregateDimensions.map((dim) => {
    const baselineDim = baselineReport.aggregateDimensions.find(
      (bd) => bd.dimensionId === dim.dimensionId,
    );
    const baselineRaw = baselineDim?.raw ?? 100;
    const normalizedRaw = baselineRaw > 0 ? (dim.raw / baselineRaw) * 100 : dim.raw;
    return makeDimensionScore(dim.dimensionId, normalizedRaw);
  });

  const overallComposite = normalizedAggregate.reduce((sum, d) => sum + d.weighted, 0);

  return {
    ...report,
    aggregateDimensions: normalizedAggregate,
    overallComposite,
  };
}
