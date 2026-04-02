/**
 * Tests for the L4 Cross-Runtime Benchmark Script.
 *
 * Tests cover argument parsing, comparison building, and output formatting.
 * Does NOT test actual CLI execution (that requires installed runtimes).
 *
 * @module eval/run-eval-l4.test
 */

import { describe, it, expect } from 'vitest';

import { parseArgs, buildComparison } from './run-eval-l4.js';
import type { EvalRunReport, RuntimeId } from './eval-types.js';

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('should return defaults with no arguments', () => {
    const config = parseArgs([]);
    expect(config.runtimes).toEqual(['claude-code', 'codex-cli', 'gemini-cli']);
    expect(config.taskIds).toEqual([]);
    expect(config.verbose).toBe(false);
    expect(config.keepWorkDirs).toBe(false);
  });

  it('should parse --runtime=all', () => {
    const config = parseArgs(['--runtime=all']);
    expect(config.runtimes).toContain('crewly-agent');
    expect(config.runtimes).toContain('claude-code');
    expect(config.runtimes).toContain('codex-cli');
    expect(config.runtimes).toContain('gemini-cli');
  });

  it('should parse --runtime=cli', () => {
    const config = parseArgs(['--runtime=cli']);
    expect(config.runtimes).toEqual(['claude-code', 'codex-cli', 'gemini-cli']);
  });

  it('should parse --runtime=claude-code', () => {
    const config = parseArgs(['--runtime=claude-code']);
    expect(config.runtimes).toEqual(['claude-code']);
  });

  it('should parse comma-separated runtimes', () => {
    const config = parseArgs(['--runtime=claude-code,gemini-cli']);
    expect(config.runtimes).toEqual(['claude-code', 'gemini-cli']);
  });

  it('should parse --tasks', () => {
    const config = parseArgs(['--tasks=L4-C1,L4-T1']);
    expect(config.taskIds).toEqual(['L4-C1', 'L4-T1']);
  });

  it('should parse --model', () => {
    const config = parseArgs(['--model=claude-opus-4']);
    expect(config.model).toBe('claude-opus-4');
  });

  it('should parse --verbose and -v', () => {
    expect(parseArgs(['--verbose']).verbose).toBe(true);
    expect(parseArgs(['-v']).verbose).toBe(true);
  });

  it('should parse --keep-work-dirs', () => {
    expect(parseArgs(['--keep-work-dirs']).keepWorkDirs).toBe(true);
  });

  it('should parse --output', () => {
    const config = parseArgs(['--output=/tmp/results']);
    expect(config.outputDir).toBe('/tmp/results');
  });

  it('should handle multiple flags together', () => {
    const config = parseArgs([
      '--runtime=claude-code',
      '--tasks=L4-C1',
      '--model=claude-opus-4',
      '--verbose',
      '--keep-work-dirs',
    ]);
    expect(config.runtimes).toEqual(['claude-code']);
    expect(config.taskIds).toEqual(['L4-C1']);
    expect(config.model).toBe('claude-opus-4');
    expect(config.verbose).toBe(true);
    expect(config.keepWorkDirs).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildComparison
// ---------------------------------------------------------------------------

describe('buildComparison', () => {
  function makeReport(
    runtimeId: RuntimeId,
    composite: number,
    passed: number,
    total: number,
  ): EvalRunReport {
    return {
      version: '1.0.0',
      runtimeId,
      model: 'test-model',
      timestamp: new Date().toISOString(),
      taskResults: [
        {
          taskId: 'L4-C1',
          level: 'L4',
          title: 'Triage & Delegate',
          success: true,
          dimensions: [],
          composite: composite * 0.8,
          metrics: {
            durationMs: 5000, steps: 10,
            usage: { input: 1000, output: 500 },
            costUSD: 0.01, toolCallCount: 5, correctToolCalls: 5,
            unnecessaryToolCalls: 0, argAccuracy: 1, toolErrors: 0,
            humanNudges: 0, loopDetected: false, timedOut: false,
          },
          verification: { passed: true, checks: [] },
        },
        {
          taskId: 'L4-T1',
          level: 'L4',
          title: 'Broken Structure',
          success: passed > 1,
          dimensions: [],
          composite: composite * 0.6,
          metrics: {
            durationMs: 3000, steps: 8,
            usage: { input: 800, output: 400 },
            costUSD: 0.008, toolCallCount: 4, correctToolCalls: 3,
            unnecessaryToolCalls: 1, argAccuracy: 0.75, toolErrors: 0,
            humanNudges: 0, loopDetected: false, timedOut: false,
          },
          verification: { passed: passed > 1, checks: [] },
        },
      ],
      aggregateDimensions: [],
      overallComposite: composite,
      totalDurationMs: 8000,
      totalCostUSD: 0.018,
      passedCount: passed,
      totalCount: total,
    };
  }

  it('should rank runtimes by composite score descending', () => {
    const reports = [
      makeReport('claude-code', 75, 2, 2),
      makeReport('gemini-cli', 85, 2, 2),
      makeReport('codex-cli', 60, 1, 2),
    ];
    const comparison = buildComparison(reports);
    expect(comparison.ranking[0].runtimeId).toBe('gemini-cli');
    expect(comparison.ranking[1].runtimeId).toBe('claude-code');
    expect(comparison.ranking[2].runtimeId).toBe('codex-cli');
  });

  it('should include pass rate in ranking', () => {
    const reports = [makeReport('claude-code', 80, 1, 2)];
    const comparison = buildComparison(reports);
    expect(comparison.ranking[0].passRate).toBe('1/2');
  });

  it('should build per-task comparison', () => {
    const reports = [
      makeReport('claude-code', 80, 2, 2),
      makeReport('gemini-cli', 70, 1, 2),
    ];
    const comparison = buildComparison(reports);

    expect(comparison.taskComparison).toHaveLength(2);
    const c1 = comparison.taskComparison.find((tc) => tc.taskId === 'L4-C1');
    expect(c1).toBeDefined();
    expect(c1!.scores['claude-code']).toBeGreaterThan(0);
    expect(c1!.scores['gemini-cli']).toBeGreaterThan(0);
  });

  it('should handle single runtime', () => {
    const reports = [makeReport('claude-code', 90, 2, 2)];
    const comparison = buildComparison(reports);
    expect(comparison.ranking).toHaveLength(1);
    expect(comparison.ranking[0].composite).toBe(90);
  });

  it('should handle empty reports', () => {
    const comparison = buildComparison([]);
    expect(comparison.ranking).toEqual([]);
    expect(comparison.taskComparison).toEqual([]);
  });

  it('should include timestamp', () => {
    const comparison = buildComparison([]);
    expect(comparison.timestamp).toBeDefined();
    expect(new Date(comparison.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('should round scores to one decimal', () => {
    const reports = [makeReport('claude-code', 85.67, 2, 2)];
    const comparison = buildComparison(reports);
    expect(comparison.ranking[0].composite).toBe(85.7);
  });
});
