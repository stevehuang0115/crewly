/**
 * Tests for the Eval Scorer — including D6 self-healing signals.
 *
 * Tests cover the new self-healing scoring in D6 for L4-T trap tasks
 * and the extractSelfHealingSignals mapping function.
 *
 * @module eval/eval-scorer.test
 */

import { describe, it, expect } from 'vitest';

import {
  scoreD6Stability,
  extractSelfHealingSignals,
  scoreD1Completion,
  scoreD5Collaboration,
  calculateCost,
  makeDimensionScore,
  type SelfHealingSignals,
} from './eval-scorer.js';
import type { EvalCheck, EvalMetrics, EvalVerification } from './eval-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetrics(overrides: Partial<EvalMetrics> = {}): EvalMetrics {
  return {
    durationMs: 1000,
    steps: 5,
    usage: { input: 1000, output: 500 },
    costUSD: 0.01,
    toolCallCount: 5,
    correctToolCalls: 5,
    unnecessaryToolCalls: 0,
    argAccuracy: 1,
    toolErrors: 0,
    humanNudges: 0,
    loopDetected: false,
    timedOut: false,
    ...overrides,
  };
}

function makeVerification(
  checkResults: Array<{ name: string; passed: boolean }>,
  collabResults: Array<{ name: string; passed: boolean }> = [],
): EvalVerification {
  const checks: EvalCheck[] = checkResults.map((c) => ({
    name: c.name,
    passed: c.passed,
    message: c.name,
  }));
  const collaborationChecks: EvalCheck[] = collabResults.map((c) => ({
    name: c.name,
    passed: c.passed,
    message: c.name,
  }));
  return {
    passed: [...checks, ...collaborationChecks].every((c) => c.passed),
    checks,
    collaborationChecks: collaborationChecks.length > 0 ? collaborationChecks : undefined,
  };
}

// ---------------------------------------------------------------------------
// D6 Stability — base behavior (unchanged)
// ---------------------------------------------------------------------------

describe('scoreD6Stability — base behavior', () => {
  it('should return 100 for clean run', () => {
    expect(scoreD6Stability(makeMetrics())).toBe(100);
  });

  it('should deduct 30 for loop detected', () => {
    expect(scoreD6Stability(makeMetrics({ loopDetected: true }))).toBe(70);
  });

  it('should deduct 10 per tool error', () => {
    expect(scoreD6Stability(makeMetrics({ toolErrors: 2 }))).toBe(80);
  });

  it('should deduct 40 for timeout', () => {
    expect(scoreD6Stability(makeMetrics({ timedOut: true }))).toBe(60);
  });

  it('should clamp at 0 for extreme penalties', () => {
    expect(scoreD6Stability(makeMetrics({ loopDetected: true, timedOut: true, toolErrors: 5 }))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D6 Stability — self-healing bonuses
// ---------------------------------------------------------------------------

describe('scoreD6Stability — self-healing signals', () => {
  it('should add 25 for discovered trap', () => {
    const signals: SelfHealingSignals = {
      discoveredTrap: true,
      correctDiagnosis: false,
      effectiveFix: false,
      recoveredFromMistake: false,
    };
    // 100 + 25 = 125 → clamped to 100
    expect(scoreD6Stability(makeMetrics(), signals)).toBe(100);
  });

  it('should offset penalties with healing bonuses', () => {
    const signals: SelfHealingSignals = {
      discoveredTrap: true,
      correctDiagnosis: true,
      effectiveFix: false,
      recoveredFromMistake: false,
    };
    // 100 - 40 (timeout) + 25 + 25 = 110 → clamped to 100
    expect(scoreD6Stability(makeMetrics({ timedOut: true }), signals)).toBe(100);
  });

  it('should allow partial healing to raise score above penalized baseline', () => {
    const signals: SelfHealingSignals = {
      discoveredTrap: true,
      correctDiagnosis: false,
      effectiveFix: false,
      recoveredFromMistake: false,
    };
    // 100 - 30 (loop) + 25 = 95
    expect(scoreD6Stability(makeMetrics({ loopDetected: true }), signals)).toBe(95);
  });

  it('should add all bonuses when all signals true', () => {
    const signals: SelfHealingSignals = {
      discoveredTrap: true,
      correctDiagnosis: true,
      effectiveFix: true,
      recoveredFromMistake: true,
    };
    // 100 + 25 + 25 + 25 + 10 = 185 → clamped to 100
    expect(scoreD6Stability(makeMetrics(), signals)).toBe(100);
  });

  it('should handle undefined selfHealing (non-trap task)', () => {
    expect(scoreD6Stability(makeMetrics(), undefined)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// extractSelfHealingSignals
// ---------------------------------------------------------------------------

describe('extractSelfHealingSignals', () => {
  it('should return undefined for non-trap tasks', () => {
    expect(extractSelfHealingSignals('L4-C1', makeVerification([]))).toBeUndefined();
    expect(extractSelfHealingSignals('L1-01', makeVerification([]))).toBeUndefined();
  });

  it('should extract signals for L4-T1', () => {
    const verification = makeVerification([], [
      { name: 'discovered_structure_discrepancy', passed: true },
      { name: 'adapted_to_correct_location', passed: true },
      { name: 'attempted_npm_test', passed: false },
    ]);
    const signals = extractSelfHealingSignals('L4-T1', verification);
    expect(signals).toBeDefined();
    expect(signals!.discoveredTrap).toBe(true);
    expect(signals!.correctDiagnosis).toBe(true);
    expect(signals!.effectiveFix).toBe(true);
  });

  it('should extract signals for L4-T2', () => {
    const verification = makeVerification([], [
      { name: 'identified_multiple_issues', passed: true },
      { name: 'reported_root_causes', passed: false },
      { name: 'did_not_ignore_errors', passed: true },
    ]);
    const signals = extractSelfHealingSignals('L4-T2', verification);
    expect(signals).toBeDefined();
    expect(signals!.discoveredTrap).toBe(true);
    expect(signals!.correctDiagnosis).toBe(false);
    expect(signals!.effectiveFix).toBe(true);
  });

  it('should extract signals for L4-T3', () => {
    const verification = makeVerification([], [
      { name: 'handled_conflicting_state', passed: true },
      { name: 'handled_malformed_json', passed: true },
      { name: 'made_reasonable_decision', passed: false },
    ]);
    const signals = extractSelfHealingSignals('L4-T3', verification);
    expect(signals).toBeDefined();
    expect(signals!.discoveredTrap).toBe(true);
    expect(signals!.correctDiagnosis).toBe(true);
    expect(signals!.effectiveFix).toBe(false);
  });

  it('should return all false when no checks passed', () => {
    const verification = makeVerification([], [
      { name: 'discovered_structure_discrepancy', passed: false },
      { name: 'adapted_to_correct_location', passed: false },
    ]);
    const signals = extractSelfHealingSignals('L4-T1', verification);
    expect(signals!.discoveredTrap).toBe(false);
    expect(signals!.effectiveFix).toBe(false);
  });

  it('should return undefined for unknown L4-T task IDs', () => {
    expect(extractSelfHealingSignals('L4-T9', makeVerification([]))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Other scorer functions — smoke tests
// ---------------------------------------------------------------------------

describe('scoreD1Completion', () => {
  it('should score 100 when all checks pass', () => {
    const v = makeVerification([{ name: 'a', passed: true }, { name: 'b', passed: true }]);
    expect(scoreD1Completion(v)).toBe(100);
  });

  it('should score 0 when nothing passes', () => {
    const v = makeVerification([{ name: 'a', passed: false }]);
    v.passed = false;
    expect(scoreD1Completion(v)).toBe(0);
  });
});

describe('scoreD5Collaboration', () => {
  it('should return 100 for non-L4 tasks', () => {
    expect(scoreD5Collaboration('L1', makeVerification([]))).toBe(100);
  });

  it('should score based on collaboration checks for L4', () => {
    const v = makeVerification([], [
      { name: 'a', passed: true },
      { name: 'b', passed: false },
    ]);
    expect(scoreD5Collaboration('L4', v)).toBe(50);
  });
});

describe('calculateCost', () => {
  it('should calculate cost for known model', () => {
    const cost = calculateCost('claude-opus-4', 1_000_000, 100_000);
    expect(cost).toBe(15 + 7.5); // 15 input + 7.5 output
  });

  it('should return 0 for unknown model', () => {
    expect(calculateCost('unknown-model', 1000, 1000)).toBe(0);
  });
});

describe('makeDimensionScore', () => {
  it('should clamp raw score to 0-100', () => {
    expect(makeDimensionScore('D1_completion', 150).raw).toBe(100);
    expect(makeDimensionScore('D1_completion', -10).raw).toBe(0);
  });
});
