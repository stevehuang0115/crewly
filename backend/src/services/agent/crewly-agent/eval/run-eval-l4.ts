#!/usr/bin/env npx tsx
/**
 * L4 Cross-Runtime Benchmark Script
 *
 * Runs all L4 eval tasks (collaboration + trap/resilience) across multiple
 * CLI runtimes and produces a comparison report.
 *
 * Each runtime receives the same CONTEXT.md, skill shims, and fixtures.
 * Tool call tracking uses the `.crewly/.tool-log.jsonl` written by skill
 * shims plus filesystem diffing.
 *
 * Usage:
 *   npx tsx backend/src/services/agent/crewly-agent/eval/run-eval-l4.ts
 *   npx tsx ... --runtime=claude-code           # single runtime
 *   npx tsx ... --runtime=all                   # all 4 runtimes
 *   npx tsx ... --runtime=claude-code,gemini-cli # specific runtimes
 *   npx tsx ... --tasks=L4-C1,L4-T1             # specific tasks
 *   npx tsx ... --verbose                        # detailed output
 *   npx tsx ... --keep-work-dirs                 # preserve temp dirs
 *   npx tsx ... --model=claude-sonnet-4    # override model name
 *
 * @module eval/run-eval-l4
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { L4_TASKS } from './tasks/l4-tasks.js';
import { createAdapter } from './adapters/index.js';
import { scoreTask, aggregateResults } from './eval-scorer.js';
import type {
  EvalRunReport,
  EvalTask,
  EvalVerification,
  RuntimeId,
  RuntimeResult,
} from './eval-types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** All supported runtimes for L4 benchmarking */
const ALL_RUNTIMES: RuntimeId[] = ['claude-code', 'codex-cli', 'gemini-cli', 'crewly-agent'];

/** CLI runtimes only (excludes crewly-agent which needs a running backend) */
const CLI_RUNTIMES: RuntimeId[] = ['claude-code', 'codex-cli', 'gemini-cli'];

const OUTPUT_DIR = join(process.cwd(), 'eval-results');

/** Default model names per runtime (used for cost calculation) */
const DEFAULT_MODELS: Record<RuntimeId, string> = {
  'claude-code': 'claude-sonnet-4',
  'codex-cli': 'o3-mini',
  'gemini-cli': 'gemini-2.5-pro',
  'crewly-agent': 'claude-sonnet-4',
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface BenchmarkConfig {
  /** Runtimes to benchmark */
  runtimes: RuntimeId[];
  /** Task IDs to run (empty = all L4) */
  taskIds: string[];
  /** Model override */
  model?: string;
  /** Verbose output */
  verbose: boolean;
  /** Keep work directories after run */
  keepWorkDirs: boolean;
  /** Output directory */
  outputDir: string;
}

/**
 * Parse CLI arguments into a BenchmarkConfig.
 *
 * @param argv - process.argv.slice(2)
 * @returns parsed configuration
 */
export function parseArgs(argv: string[]): BenchmarkConfig {
  const config: BenchmarkConfig = {
    runtimes: CLI_RUNTIMES,
    taskIds: [],
    verbose: false,
    keepWorkDirs: false,
    outputDir: OUTPUT_DIR,
  };

  for (const arg of argv) {
    if (arg.startsWith('--runtime=')) {
      const val = arg.split('=')[1];
      if (val === 'all') {
        config.runtimes = [...ALL_RUNTIMES];
      } else if (val === 'cli') {
        config.runtimes = [...CLI_RUNTIMES];
      } else {
        config.runtimes = val.split(',') as RuntimeId[];
      }
    } else if (arg.startsWith('--tasks=')) {
      config.taskIds = arg.split('=')[1].split(',');
    } else if (arg.startsWith('--model=')) {
      config.model = arg.split('=')[1];
    } else if (arg === '--verbose' || arg === '-v') {
      config.verbose = true;
    } else if (arg === '--keep-work-dirs') {
      config.keepWorkDirs = true;
    } else if (arg.startsWith('--output=')) {
      config.outputDir = arg.split('=')[1];
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Runtime availability check
// ---------------------------------------------------------------------------

/**
 * Check which runtimes are available on this machine.
 *
 * @param runtimes - list of runtimes to check
 * @returns object with available and unavailable lists
 */
export async function checkRuntimeAvailability(
  runtimes: RuntimeId[],
): Promise<{ available: RuntimeId[]; unavailable: Array<{ id: RuntimeId; reason: string }> }> {
  const available: RuntimeId[] = [];
  const unavailable: Array<{ id: RuntimeId; reason: string }> = [];

  for (const id of runtimes) {
    if (id === 'crewly-agent') {
      // crewly-agent needs a running backend — skip availability check
      unavailable.push({ id, reason: 'Requires running backend (use eval-runner instead)' });
      continue;
    }

    try {
      const adapter = createAdapter(id);
      const tmpWorkDir = join(tmpdir(), `eval-check-${id}-${Date.now()}`);
      mkdirSync(tmpWorkDir, { recursive: true });
      try {
        await adapter.initialize({
          runtimeId: id,
          model: DEFAULT_MODELS[id],
          workDir: tmpWorkDir,
        });
        await adapter.shutdown();
        available.push(id);
      } finally {
        rmSync(tmpWorkDir, { recursive: true, force: true });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      unavailable.push({ id, reason });
    }
  }

  return { available, unavailable };
}

// ---------------------------------------------------------------------------
// Single-runtime benchmark
// ---------------------------------------------------------------------------

/**
 * Run all L4 tasks against a single runtime and produce a report.
 *
 * @param runtimeId    - which runtime to benchmark
 * @param tasks        - L4 tasks to run
 * @param model        - model identifier for cost calculation
 * @param verbose      - whether to emit progress logs
 * @param keepWorkDirs - whether to preserve work directories
 * @returns evaluation run report
 */
async function benchmarkRuntime(
  runtimeId: RuntimeId,
  tasks: EvalTask[],
  model: string,
  verbose: boolean,
  keepWorkDirs: boolean,
): Promise<EvalRunReport> {
  const adapter = createAdapter(runtimeId);

  const tmpWorkDir = join(tmpdir(), `eval-l4-${runtimeId}-${Date.now()}`);
  mkdirSync(tmpWorkDir, { recursive: true });

  try {
    await adapter.initialize({
      runtimeId,
      model,
      workDir: tmpWorkDir,
    });

    const taskResults = [];

    for (const task of tasks) {
      if (verbose) {
        console.log(`  [${runtimeId}] ${task.id}: ${task.title}`);
      }

      const workDir = join(tmpWorkDir, task.id);
      mkdirSync(workDir, { recursive: true });

      let result: RuntimeResult | undefined;
      let verification: EvalVerification = { passed: false, checks: [] };

      try {
        // Setup
        await task.setup(workDir);

        // Run
        result = await adapter.runTask(task, workDir);
        if (verbose) {
          const status = result.success ? '✓' : '✗';
          console.log(`    ${status} Runtime: ${result.durationMs}ms, ${result.toolCalls.length} tool calls`);
        }

        // Verify
        verification = await task.verify(workDir, result.toolCalls);
        if (verbose) {
          const vStatus = verification.passed ? 'PASS' : 'FAIL';
          console.log(`    Verify: ${vStatus}`);
          for (const c of [...verification.checks, ...(verification.collaborationChecks ?? [])]) {
            console.log(`      ${c.passed ? '✓' : '✗'} ${c.name}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (verbose) console.log(`    ERROR: ${msg}`);
        taskResults.push({
          taskId: task.id,
          level: task.level,
          title: task.title,
          success: false,
          dimensions: [],
          composite: 0,
          metrics: {
            durationMs: 0, steps: 0, usage: { input: 0, output: 0 },
            costUSD: 0, toolCallCount: 0, correctToolCalls: 0,
            unnecessaryToolCalls: 0, argAccuracy: 0, toolErrors: 0,
            humanNudges: 0, loopDetected: false, timedOut: false,
          },
          verification: { passed: false, checks: [] },
          error: msg,
        });
        continue;
      } finally {
        if (!keepWorkDirs) {
          try { rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
        }
      }

      if (result) {
        taskResults.push(scoreTask(task, result, verification, runtimeId, model));
      }
    }

    await adapter.shutdown();

    return aggregateResults(taskResults, runtimeId, model);
  } finally {
    if (!keepWorkDirs) {
      try { rmSync(tmpWorkDir, { recursive: true, force: true }); } catch { /* */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Comparison report
// ---------------------------------------------------------------------------

/**
 * Comparison report across multiple runtimes.
 */
export interface CrossRuntimeComparison {
  /** ISO timestamp of benchmark run */
  timestamp: string;
  /** Per-runtime reports */
  reports: EvalRunReport[];
  /** Ranking by composite score (descending) */
  ranking: Array<{
    runtimeId: RuntimeId;
    model: string;
    composite: number;
    passRate: string;
    totalCostUSD: number;
    totalDurationMs: number;
  }>;
  /** Per-task comparison across runtimes */
  taskComparison: Array<{
    taskId: string;
    title: string;
    scores: Record<string, number>;
  }>;
}

/**
 * Build a cross-runtime comparison from individual reports.
 *
 * @param reports - array of per-runtime reports
 * @returns structured comparison
 */
export function buildComparison(reports: EvalRunReport[]): CrossRuntimeComparison {
  // Ranking by composite score
  const ranking = reports
    .map((r) => ({
      runtimeId: r.runtimeId,
      model: r.model,
      composite: Math.round(r.overallComposite * 10) / 10,
      passRate: `${r.passedCount}/${r.totalCount}`,
      totalCostUSD: Math.round(r.totalCostUSD * 10000) / 10000,
      totalDurationMs: r.totalDurationMs,
    }))
    .sort((a, b) => b.composite - a.composite);

  // Per-task comparison
  const allTaskIds = new Set<string>();
  const taskTitles = new Map<string, string>();
  for (const r of reports) {
    for (const tr of r.taskResults) {
      allTaskIds.add(tr.taskId);
      taskTitles.set(tr.taskId, tr.title);
    }
  }

  const taskComparison = Array.from(allTaskIds).map((taskId) => {
    const scores: Record<string, number> = {};
    for (const r of reports) {
      const tr = r.taskResults.find((t) => t.taskId === taskId);
      scores[r.runtimeId] = tr ? Math.round(tr.composite * 10) / 10 : 0;
    }
    return {
      taskId,
      title: taskTitles.get(taskId) ?? taskId,
      scores,
    };
  });

  return {
    timestamp: new Date().toISOString(),
    reports,
    ranking,
    taskComparison,
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Print a formatted comparison to stdout.
 *
 * @param comparison - cross-runtime comparison data
 */
function printComparison(comparison: CrossRuntimeComparison): void {
  const SEP = '═'.repeat(76);
  const THIN = '─'.repeat(76);

  console.log(`\n${SEP}`);
  console.log('  L4 CROSS-RUNTIME BENCHMARK RESULTS');
  console.log(`  ${comparison.timestamp}`);
  console.log(SEP);

  // Ranking table
  console.log('\n  RANKING');
  console.log(THIN);
  console.log('  Rank  Runtime          Score   Pass Rate   Cost($)   Duration');
  console.log(THIN);
  comparison.ranking.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(4)}  ` +
      `${r.runtimeId.padEnd(16)} ` +
      `${String(r.composite).padStart(5)}   ` +
      `${r.passRate.padStart(9)}   ` +
      `${r.totalCostUSD.toFixed(4).padStart(7)}   ` +
      `${(r.totalDurationMs / 1000).toFixed(1).padStart(7)}s`,
    );
  });
  console.log(THIN);

  // Per-task breakdown
  console.log('\n  PER-TASK SCORES');
  console.log(THIN);

  const runtimeIds = comparison.ranking.map((r) => r.runtimeId);
  const header = '  Task       ' + runtimeIds.map((r) => r.padStart(14)).join('');
  console.log(header);
  console.log(THIN);

  for (const tc of comparison.taskComparison) {
    const scores = runtimeIds.map((r) => {
      const s = tc.scores[r] ?? 0;
      return String(s).padStart(14);
    }).join('');
    console.log(`  ${tc.taskId.padEnd(11)} ${scores}`);
  }
  console.log(THIN);

  // Winner
  if (comparison.ranking.length > 0) {
    const winner = comparison.ranking[0];
    console.log(`\n  🏆 WINNER: ${winner.runtimeId} (${winner.model}) — ${winner.composite}/100`);
  }

  console.log(`${SEP}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Main entry point for the benchmark script.
 *
 * @param argv - command line arguments (process.argv.slice(2))
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = parseArgs(argv);

  console.log('═'.repeat(76));
  console.log('  L4 CROSS-RUNTIME BENCHMARK');
  console.log(`  Runtimes: ${config.runtimes.join(', ')}`);
  console.log(`  Tasks: ${config.taskIds.length > 0 ? config.taskIds.join(', ') : 'all L4'}`);
  console.log('═'.repeat(76));

  // Filter tasks
  let tasks = L4_TASKS;
  if (config.taskIds.length > 0) {
    const idSet = new Set(config.taskIds);
    tasks = tasks.filter((t) => idSet.has(t.id));
  }

  if (tasks.length === 0) {
    console.error('No tasks match the filter. Available: ' + L4_TASKS.map((t) => t.id).join(', '));
    process.exit(1);
  }

  console.log(`\n  Running ${tasks.length} tasks across ${config.runtimes.length} runtime(s)...`);

  // Check availability
  const { available, unavailable } = await checkRuntimeAvailability(config.runtimes);

  if (unavailable.length > 0) {
    console.log('\n  ⚠ Unavailable runtimes (will be skipped):');
    for (const u of unavailable) {
      console.log(`    ✗ ${u.id}: ${u.reason}`);
    }
  }

  if (available.length === 0) {
    console.error('\n  No runtimes available. Install at least one CLI:');
    console.error('    - claude (Claude Code)');
    console.error('    - codex (Codex CLI)');
    console.error('    - gemini (Gemini CLI)');
    process.exit(1);
  }

  console.log(`\n  ✓ Available: ${available.join(', ')}`);

  // Run benchmarks
  const reports: EvalRunReport[] = [];

  for (const runtimeId of available) {
    const model = config.model ?? DEFAULT_MODELS[runtimeId];
    console.log(`\n${'─'.repeat(76)}`);
    console.log(`  Benchmarking: ${runtimeId} (${model})`);
    console.log('─'.repeat(76));

    try {
      const report = await benchmarkRuntime(
        runtimeId,
        tasks,
        model,
        config.verbose,
        config.keepWorkDirs,
      );
      reports.push(report);
      console.log(`  ✓ ${runtimeId}: ${report.overallComposite.toFixed(1)}/100 (${report.passedCount}/${report.totalCount} passed)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${runtimeId} FAILED: ${msg}`);
    }
  }

  if (reports.length === 0) {
    console.error('\nAll runtimes failed. No report generated.');
    process.exit(1);
  }

  // Build comparison
  const comparison = buildComparison(reports);

  // Print
  printComparison(comparison);

  // Save
  mkdirSync(config.outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `l4-comparison-${timestamp}.json`;
  const reportPath = join(config.outputDir, filename);
  writeFileSync(reportPath, JSON.stringify(comparison, null, 2));
  console.log(`  Report saved: ${reportPath}`);

  // Also save individual runtime reports
  for (const report of reports) {
    const rFilename = `l4-${report.runtimeId}-${timestamp}.json`;
    writeFileSync(join(config.outputDir, rFilename), JSON.stringify(report, null, 2));
  }
}

// Run if executed directly
const isDirectExecution = process.argv[1]?.includes('run-eval-l4');
if (isDirectExecution) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
