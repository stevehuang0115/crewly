/**
 * Crewly Agent Evaluation Framework - Runner
 *
 * Orchestrates a full evaluation run: filters tasks, initializes the
 * runtime adapter, executes tasks sequentially, scores results, and
 * produces a final report.
 *
 * @module eval-runner
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import type {
  EvalLevel,
  EvalRunReport,
  EvalTask,
  EvalTaskResult,
  EvalVerification,
  RuntimeAdapter,
  RuntimeId,
  RuntimeResult,
} from './eval-types.js';
import { DEFAULT_TASK_TIMEOUT_MS } from './eval-types.js';
import { aggregateResults, normalizeToBaseline, scoreTask } from './eval-scorer.js';

// ---------------------------------------------------------------------------
// Runner configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link runEvaluation}.
 */
export interface RunnerConfig {
  /** Initialized runtime adapter */
  adapter: RuntimeAdapter;
  /** Runtime identifier (used in reports and file names) */
  runtimeId: RuntimeId;
  /** Model identifier for cost calculation */
  model: string;
  /** Optional list of specific task IDs to run */
  taskIds?: string[];
  /** Optional list of levels to include */
  levels?: EvalLevel[];
  /** Directory where report JSON files are written */
  outputDir: string;
  /** Path to a baseline report JSON for normalization */
  baselinePath?: string;
  /** If true, keep temporary work directories after evaluation */
  keepWorkDirs?: boolean;
  /** If true, emit verbose progress logs */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Log a message to stdout when verbose mode is enabled.
 *
 * @param verbose - whether verbose logging is on
 * @param args    - values to log
 */
function log(verbose: boolean, ...args: unknown[]): void {
  if (verbose) {
    console.log('[eval]', ...args);
  }
}

/**
 * Format a timestamp for use in filenames (ISO without colons).
 *
 * @returns formatted timestamp string
 */
function formatTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Sanitize a string for use as a filename component.
 *
 * @param name - raw string to sanitize
 * @returns filesystem-safe string
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Create a temporary work directory for a single task.
 *
 * @param taskId - task identifier used in the directory name
 * @returns absolute path to the created directory
 */
function setupWorkDir(taskId: string): string {
  const dir = path.join(os.tmpdir(), `crewly-eval-${sanitizeFilename(taskId)}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Build a failed {@link EvalTaskResult} for tasks that error before scoring.
 *
 * @param task  - the task that failed
 * @param error - error message
 * @returns a task result with zero scores
 */
function createFailedResult(task: EvalTask, error: string): EvalTaskResult {
  return {
    taskId: task.id,
    level: task.level,
    title: task.title,
    success: false,
    dimensions: [],
    composite: 0,
    metrics: {
      durationMs: 0,
      steps: 0,
      usage: { input: 0, output: 0 },
      costUSD: 0,
      toolCallCount: 0,
      correctToolCalls: 0,
      unnecessaryToolCalls: 0,
      argAccuracy: 0,
      toolErrors: 0,
      humanNudges: 0,
      loopDetected: false,
      timedOut: false,
    },
    verification: { passed: false, checks: [] },
    error,
  };
}

/**
 * Print a human-readable summary of the evaluation run to stdout.
 *
 * @param report - the completed evaluation report
 */
function printSummary(report: EvalRunReport): void {
  console.log('\n========================================');
  console.log('  Evaluation Summary');
  console.log('========================================');
  console.log(`  Runtime : ${report.runtimeId}`);
  console.log(`  Model   : ${report.model}`);
  console.log(`  Tasks   : ${report.passedCount}/${report.totalCount} passed`);
  console.log(`  Score   : ${report.overallComposite.toFixed(1)}/100`);
  console.log(`  Cost    : $${report.totalCostUSD.toFixed(4)}`);
  console.log(`  Duration: ${(report.totalDurationMs / 1000).toFixed(1)}s`);
  console.log('----------------------------------------');
  for (const dim of report.aggregateDimensions) {
    console.log(`  ${dim.dimensionId.padEnd(20)} ${dim.raw.toFixed(1).padStart(6)} (w=${dim.weight})`);
  }
  console.log('========================================\n');
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/**
 * Run a full evaluation across the provided tasks.
 *
 * The runner performs the following steps:
 * 1. Filter tasks by ID and/or level if specified in config
 * 2. Initialize the runtime adapter
 * 3. For each task: setup work dir, run via adapter, verify, score, teardown
 * 4. Aggregate results into a run report
 * 5. Optionally normalize against a baseline report
 * 6. Save JSON report to outputDir
 * 7. Print summary to stdout
 *
 * @param config   - runner configuration
 * @param allTasks - full list of available eval tasks
 * @returns the completed evaluation run report
 *
 * @example
 * ```typescript
 * const report = await runEvaluation(
 *   { adapter, model: 'claude-opus-4', outputDir: './reports' },
 *   ALL_TASKS,
 * );
 * ```
 */
export async function runEvaluation(
  config: RunnerConfig,
  allTasks: EvalTask[],
): Promise<EvalRunReport> {
  const verbose = config.verbose ?? false;

  // -- Step 1: Filter tasks --
  let tasks = allTasks;

  if (config.taskIds && config.taskIds.length > 0) {
    const idSet = new Set(config.taskIds);
    tasks = tasks.filter((t) => idSet.has(t.id));
  }

  if (config.levels && config.levels.length > 0) {
    const levelSet = new Set(config.levels);
    tasks = tasks.filter((t) => levelSet.has(t.level));
  }

  log(verbose, `Running ${tasks.length} task(s) with model ${config.model}`);

  // -- Step 2: Ensure output directory exists --
  fs.mkdirSync(config.outputDir, { recursive: true });

  // -- Step 3: Run each task --
  const taskResults: EvalTaskResult[] = [];

  for (const task of tasks) {
    log(verbose, `[${task.id}] ${task.title} -- starting`);
    const workDir = setupWorkDir(task.id);

    let result: RuntimeResult | undefined;
    let verification: EvalVerification = { passed: false, checks: [] };

    try {
      // Setup
      await task.setup(workDir);
      log(verbose, `[${task.id}] work dir ready: ${workDir}`);

      // Run
      result = await config.adapter.runTask(task, workDir);
      log(verbose, `[${task.id}] runtime finished in ${result.durationMs}ms`);

      // Verify
      verification = await task.verify(workDir, result.toolCalls);
      log(verbose, `[${task.id}] verification: ${verification.passed ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(verbose, `[${task.id}] ERROR: ${message}`);
      taskResults.push(createFailedResult(task, message));
      continue;
    } finally {
      // Teardown
      try {
        if (task.teardown) {
          await task.teardown(workDir);
        }
        if (!config.keepWorkDirs) {
          fs.rmSync(workDir, { recursive: true, force: true });
        }
      } catch {
        // Teardown errors are non-fatal
      }
    }

    // Score
    const taskResult = scoreTask(task, result, verification, config.runtimeId, config.model);
    taskResults.push(taskResult);
    log(verbose, `[${task.id}] composite score: ${taskResult.composite.toFixed(1)}`);
  }

  // -- Step 4: Aggregate --
  let report = aggregateResults(taskResults, config.runtimeId, config.model);

  // -- Step 5: Normalize to baseline if provided --
  if (config.baselinePath) {
    try {
      const baselineJson = fs.readFileSync(config.baselinePath, 'utf-8');
      const baselineReport = JSON.parse(baselineJson) as EvalRunReport;
      report = normalizeToBaseline(report, baselineReport);
      log(verbose, 'Normalized to baseline report');
    } catch (err) {
      log(verbose, `WARNING: Could not load baseline: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // -- Step 6: Save report --
  const filename = `eval-${sanitizeFilename(config.model)}-${formatTimestamp()}.json`;
  const reportPath = path.join(config.outputDir, filename);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  log(verbose, `Report saved to ${reportPath}`);

  // -- Step 7: Print summary --
  printSummary(report);

  return report;
}
