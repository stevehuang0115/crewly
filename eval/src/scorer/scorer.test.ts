import { describe, expect, it } from 'vitest';
import type { ExecutionResult } from '../executors/base-executor.js';
import type { DimensionScores, EvalResult, EvalTask, VerificationResult } from '../types/eval.types.js';
import { buildScorecard, computeDimensionScores, computeWeightedScore, scoreRun } from './scorer.js';

/** A task where an expert needs 8 steps and the baseline run cost $0.10. */
const TASK = {
  id: 'T1',
  title: 'Test task',
  category: 'bug_fix',
  tier: 'easy',
  description: '',
  repoPath: 'fixtures/T1',
  setupCommands: [],
  fixtureCommands: [],
  verification: [],
  filesHint: [],
  minStepsExpert: 8,
  timeLimitMinutes: 5,
  baselineCostUsd: 0.1,
} as unknown as EvalTask;

/** An execution that matched the expert step count and the baseline cost exactly. */
const EXPERT_RUN: ExecutionResult = {
  completionType: 'agent_done',
  durationSeconds: 10,
  toolCallCount: 8,
  estimatedCostUsd: 0.1,
  logPath: 'logs/T1.log',
};

const check = (name: string, passed: boolean): VerificationResult => ({ name, passed, output: '', exitCode: passed ? 0 : 1 });

const allDimensions = (value: number): DimensionScores => ({
  d1Correctness: value,
  d2CodeQuality: value,
  d3Reasoning: value,
  d4Autonomy: value,
  d5ContextMgmt: value,
  d6Collaboration: value,
  d7CostEfficiency: value,
});

describe('computeWeightedScore', () => {
  it('maps all-100 to 100 and all-0 to 0', () => {
    expect(computeWeightedScore(allDimensions(100))).toBe(100);
    expect(computeWeightedScore(allDimensions(0))).toBe(0);
  });

  it('weights correctness (25%) more than collaboration (5%)', () => {
    const onlyCorrectness = { ...allDimensions(0), d1Correctness: 100 };
    const onlyCollaboration = { ...allDimensions(0), d6Collaboration: 100 };
    expect(computeWeightedScore(onlyCorrectness)).toBe(25);
    expect(computeWeightedScore(onlyCollaboration)).toBe(5);
  });
});

describe('computeDimensionScores', () => {
  it('scores an expert-level run at the ceiling of every automated dimension', () => {
    const scores = computeDimensionScores(TASK, EXPERT_RUN, [check('typescript', true), check('tests', true)]);
    expect(scores).toEqual({
      d1Correctness: 100,
      d2CodeQuality: 85, // 50 baseline + 20 tsc + 15 tests; no lint check present
      d3Reasoning: 100,
      d4Autonomy: 100,
      d5ContextMgmt: 100,
      d6Collaboration: 0,
      d7CostEfficiency: 100,
    });
  });

  it('counts the verification pass rate as correctness', () => {
    const scores = computeDimensionScores(TASK, EXPERT_RUN, [
      check('typescript', true),
      check('tests', false),
      check('constants_exist', false),
      check('no_hardcoded_ports', true),
    ]);
    expect(scores.d1Correctness).toBe(50);
    expect(scores.d2CodeQuality).toBe(70);
  });

  it('gives 0 correctness when no checks ran, never a divide-by-zero', () => {
    expect(computeDimensionScores(TASK, EXPERT_RUN, []).d1Correctness).toBe(0);
  });

  it('penalises timeouts and errors on autonomy', () => {
    expect(computeDimensionScores(TASK, { ...EXPERT_RUN, completionType: 'timeout' }, []).d4Autonomy).toBe(30);
    expect(computeDimensionScores(TASK, { ...EXPERT_RUN, completionType: 'error' }, []).d4Autonomy).toBe(0);
  });

  it('decays reasoning and context scores as tool calls grow past the expert count', () => {
    const fourX = computeDimensionScores(TASK, { ...EXPERT_RUN, toolCallCount: 32 }, []);
    expect(fourX.d3Reasoning).toBe(25);
    expect(fourX.d5ContextMgmt).toBe(75);
    const tenX = computeDimensionScores(TASK, { ...EXPERT_RUN, toolCallCount: 80 }, []);
    expect(tenX.d5ContextMgmt).toBe(0);
  });

  it('caps cost efficiency at 100 and halves it when cost doubles', () => {
    expect(computeDimensionScores(TASK, { ...EXPERT_RUN, estimatedCostUsd: 0 }, []).d7CostEfficiency).toBe(100);
    expect(computeDimensionScores(TASK, { ...EXPERT_RUN, estimatedCostUsd: 0.2 }, []).d7CostEfficiency).toBe(50);
  });
});

describe('scoreRun', () => {
  it('copies the execution facts and attaches the scores', () => {
    const result = scoreRun(TASK, { ...EXPERT_RUN, error: undefined }, [check('tests', true)]);
    expect(result.taskId).toBe('T1');
    expect(result.completionType).toBe('agent_done');
    expect(result.toolCallCount).toBe(8);
    expect(result.logPath).toBe('logs/T1.log');
    expect(result.verificationResults).toHaveLength(1);
    expect(result.overallScore).toBe(computeWeightedScore(result.scores));
    expect(Date.parse(result.startedAt)).toBeLessThanOrEqual(Date.parse(result.completedAt));
  });
});

describe('buildScorecard', () => {
  const resultWith = (overallScore: number, cost: number, seconds: number): EvalResult => ({
    taskId: 'T1',
    runtime: 'codex-cli',
    startedAt: '',
    completedAt: '',
    durationSeconds: seconds,
    completionType: 'agent_done',
    verificationResults: [],
    scores: allDimensions(overallScore),
    overallScore,
    toolCallCount: 1,
    estimatedCostUsd: cost,
    logPath: '',
  });

  it('averages the task scores and sums cost and time', () => {
    const card = buildScorecard('codex-cli', [resultWith(80, 0.1, 30), resultWith(60, 0.3, 90)]);
    expect(card.runtime).toBe('codex-cli');
    expect(card.normalizedScore).toBe(70);
    expect(card.avgDimensionScores.d1Correctness).toBe(70);
    expect(card.totalCostUsd).toBeCloseTo(0.4);
    expect(card.totalDurationSeconds).toBe(120);
    expect(card.taskResults).toHaveLength(2);
  });

  it('normalises against a baseline score when one is given', () => {
    const card = buildScorecard('codex-cli', [resultWith(84, 0, 0)], 70);
    expect(card.normalizedScore).toBe(120);
  });

  it('returns zeros for an empty result set instead of NaN', () => {
    const card = buildScorecard('codex-cli', []);
    expect(card.normalizedScore).toBe(0);
    expect(card.avgDimensionScores.d1Correctness).toBe(0);
    expect(card.totalCostUsd).toBe(0);
  });
});
