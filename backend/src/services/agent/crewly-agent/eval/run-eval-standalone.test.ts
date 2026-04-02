/**
 * Tests for standalone eval runner scoring — D2/D6 calibration fixes.
 *
 * Validates that:
 * - D2 scores based on actual code quality checks, not binary pass/fail
 * - D6 starts at 100 and only deducts for real instability (tool errors, timeout)
 *
 * @module eval/run-eval-standalone.test
 */

import { describe, it, expect } from 'vitest';
import { computeDimensions } from './run-eval-standalone.js';
import type { EvalVerification, EvalTask } from './eval-types.js';

/**
 * Build a minimal EvalTask stub for testing.
 */
function makeTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: 'L4-C1',
    level: 'L4',
    title: 'Test task',
    prompt: 'do something',
    expectedTools: ['read_file'],
    category: 'collaboration',
    timeoutMs: 120_000,
    setup: async () => {},
    verify: async () => ({ passed: false, checks: [] }),
    ...overrides,
  } as EvalTask;
}

describe('computeDimensions — D2 Code Quality calibration', () => {
  it('gives neutral score for collaboration-only tasks (no coding checks)', () => {
    const verification: EvalVerification = {
      passed: false,
      checks: [
        { name: 'read_context', passed: true, message: 'ok' },
        { name: 'used_delegate_skill', passed: true, message: 'ok' },
      ],
    };

    const dims = computeDimensions(verification, [], makeTask(), 5000);

    // Collaboration task that didn't fully pass → 60 (neutral)
    expect(dims.D2_codeQuality).toBe(60);
  });

  it('gives higher neutral score for passed collaboration tasks', () => {
    const verification: EvalVerification = {
      passed: true,
      checks: [
        { name: 'read_context', passed: true, message: 'ok' },
        { name: 'used_delegate_skill', passed: true, message: 'ok' },
      ],
    };

    const dims = computeDimensions(verification, [], makeTask(), 5000);
    expect(dims.D2_codeQuality).toBe(80);
  });

  it('scores coding tasks based on actual code checks', () => {
    const verification: EvalVerification = {
      passed: false,
      checks: [
        { name: 'created_controller', passed: true, message: 'ok' },
        { name: 'created_service', passed: true, message: 'ok' },
        { name: 'created_test', passed: false, message: 'missing' },
        { name: 'has_named_exports', passed: true, message: 'ok' },
      ],
    };

    const dims = computeDimensions(verification, [], makeTask(), 5000);
    // 3/4 coding checks passed → 75
    expect(dims.D2_codeQuality).toBe(75);
  });

  it('gives 0 when no coding checks pass', () => {
    const verification: EvalVerification = {
      passed: false,
      checks: [
        { name: 'created_controller', passed: false, message: 'fail' },
        { name: 'created_service', passed: false, message: 'fail' },
      ],
    };

    const dims = computeDimensions(verification, [], makeTask(), 5000);
    expect(dims.D2_codeQuality).toBe(0);
  });

  it('gives 100 when all coding checks pass', () => {
    const verification: EvalVerification = {
      passed: true,
      checks: [
        { name: 'created_controller', passed: true, message: 'ok' },
        { name: 'created_service', passed: true, message: 'ok' },
        { name: 'created_test', passed: true, message: 'ok' },
      ],
    };

    const dims = computeDimensions(verification, [], makeTask(), 5000);
    expect(dims.D2_codeQuality).toBe(100);
  });
});

describe('computeDimensions — D6 Stability calibration', () => {
  it('gives 100 when no instability signals present', () => {
    const verification: EvalVerification = {
      passed: true,
      checks: [{ name: 'read_context', passed: true, message: 'ok' }],
    };

    const dims = computeDimensions(verification, [
      { toolName: 'read_file', result: { success: true, content: 'data' } },
    ], makeTask(), 5000);

    expect(dims.D6_stability).toBe(100);
  });

  it('deducts 10 per tool error', () => {
    const verification: EvalVerification = { passed: false, checks: [] };
    const toolCalls = [
      { toolName: 'read_file', result: { error: 'ENOENT' } },
      { toolName: 'write_file', result: { error: 'EACCES' } },
      { toolName: 'bash_exec', result: { success: true } },
    ];

    const dims = computeDimensions(verification, toolCalls, makeTask(), 5000);
    // 100 - 2*10 = 80
    expect(dims.D6_stability).toBe(80);
  });

  it('deducts 40 for timeout', () => {
    const verification: EvalVerification = { passed: false, checks: [] };

    // Duration exceeds timeout
    const dims = computeDimensions(verification, [], makeTask({ timeoutMs: 60_000 }), 65_000);
    expect(dims.D6_stability).toBe(60);
  });

  it('deducts 10 for near-timeout (>90% of limit)', () => {
    const verification: EvalVerification = { passed: false, checks: [] };

    // 92% of 60s timeout
    const dims = computeDimensions(verification, [], makeTask({ timeoutMs: 60_000 }), 55_500);
    expect(dims.D6_stability).toBe(90);
  });

  it('does NOT penalize for failed task alone (no stability issues)', () => {
    const verification: EvalVerification = { passed: false, checks: [] };

    // Failed task but no tool errors, no timeout
    const dims = computeDimensions(verification, [
      { toolName: 'bash_exec', result: { success: true } },
    ], makeTask(), 5000);

    // Should be 100, not 60 (the old behavior)
    expect(dims.D6_stability).toBe(100);
  });

  it('clamps to 0 when many errors and timeout combined', () => {
    const verification: EvalVerification = { passed: false, checks: [] };
    const toolCalls = Array.from({ length: 8 }, (_, i) => ({
      toolName: `tool_${i}`,
      result: { error: 'fail' },
    }));

    // 100 - 80 (8 errors) - 40 (timeout) → clamped to 0
    const dims = computeDimensions(verification, toolCalls, makeTask({ timeoutMs: 60_000 }), 65_000);
    expect(dims.D6_stability).toBe(0);
  });
});
