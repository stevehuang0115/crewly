/**
 * Core eval runner — orchestrates task execution, verification, and scoring.
 *
 * This is the main loop that:
 * 1. Selects tasks from the registry
 * 2. Sets up isolated work directories (git worktrees or copies)
 * 3. Runs fixture commands to plant the scenario
 * 4. Invokes the executor (Claude Code, Crewly Agent, etc.)
 * 5. Runs verification checks
 * 6. Scores the results
 * 7. Writes results to disk
 */

import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalConfig, EvalResult, EvalTask, RuntimeType, VerificationResult } from '../types/eval.types.js';
import type { BaseExecutor, ExecutionResult } from '../executors/base-executor.js';
import { runCommand } from '../utils/shell.js';
import { scoreRun } from '../scorer/scorer.js';
import { ALL_TASKS } from '../tasks/task-registry.js';

/**
 * Run a single eval task against a given executor.
 *
 * @param task - The task definition
 * @param executor - The runtime executor to use
 * @param config - Eval configuration (paths, settings)
 * @returns Complete eval result with scores
 */
export async function runSingleTask(
  task: EvalTask,
  executor: BaseExecutor,
  config: EvalConfig
): Promise<EvalResult> {
  const runId = `${task.id}-${executor.runtime}-${Date.now()}`;
  const workDir = join(config.workspaceRoot, 'runs', runId);
  const logDir = join(config.resultsDir, 'logs');
  const fixtureDir = join(config.workspaceRoot, task.repoPath);

  console.log(`\n[${task.id}] Setting up work directory: ${workDir}`);

  // Step 1: Create isolated work directory
  await mkdir(workDir, { recursive: true });

  // Copy fixture to work directory if it exists
  if (existsSync(fixtureDir)) {
    await cp(fixtureDir, workDir, { recursive: true });
  }

  // Step 2: Run setup commands
  for (const cmd of task.setupCommands) {
    console.log(`[${task.id}] Setup: ${cmd}`);
    const { exitCode, stderr } = await runCommand(cmd, workDir, 120_000);
    if (exitCode !== 0) {
      console.warn(`[${task.id}] Setup command failed (non-fatal): ${stderr.slice(0, 200)}`);
    }
  }

  // Step 3: Run fixture commands (inject bugs, create scenarios)
  for (const cmd of task.fixtureCommands) {
    console.log(`[${task.id}] Fixture: ${cmd}`);
    await runCommand(cmd, workDir, 60_000);
  }

  // Step 4: Execute the task with the agent
  console.log(`[${task.id}] Executing with ${executor.runtime}...`);
  const execResult: ExecutionResult = await executor.execute(task, {
    workDir,
    logDir,
    timeLimitMinutes: task.timeLimitMinutes,
  });

  console.log(`[${task.id}] Execution complete: ${execResult.completionType} (${execResult.durationSeconds.toFixed(1)}s)`);

  // Step 5: Run verification checks
  console.log(`[${task.id}] Running verification checks...`);
  const verificationResults = await runVerificationChecks(task, workDir);

  // Step 6: Score the run
  const result = scoreRun(task, execResult, verificationResults);
  result.runtime = executor.runtime;

  // Step 7: Save result to disk
  await saveResult(result, config.resultsDir);

  // Cleanup work directory (optional — keep for debugging)
  // await rm(workDir, { recursive: true, force: true });

  return result;
}

/**
 * Run all tasks against a given executor.
 *
 * @param executor - The runtime executor
 * @param config - Eval configuration
 * @param taskIds - Optional subset of task IDs to run (default: all)
 * @returns Array of eval results
 */
export async function runAllTasks(
  executor: BaseExecutor,
  config: EvalConfig,
  taskIds?: string[]
): Promise<EvalResult[]> {
  const tasks = taskIds
    ? ALL_TASKS.filter((t) => taskIds.includes(t.id))
    : ALL_TASKS;

  if (tasks.length === 0) {
    console.error('No tasks matched the given IDs');
    return [];
  }

  console.log(`\n=== Eval Run: ${executor.runtime} ===`);
  console.log(`Tasks: ${tasks.map((t) => t.id).join(', ')}`);
  console.log(`Results dir: ${config.resultsDir}`);

  await mkdir(config.resultsDir, { recursive: true });
  await mkdir(join(config.resultsDir, 'logs'), { recursive: true });

  const results: EvalResult[] = [];

  for (const task of tasks) {
    try {
      const result = await runSingleTask(task, executor, config);
      results.push(result);
      printTaskSummary(result);
    } catch (err) {
      console.error(`[${task.id}] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
      // Create an error result
      results.push({
        taskId: task.id,
        runtime: executor.runtime,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationSeconds: 0,
        completionType: 'error',
        verificationResults: [],
        scores: {
          d1Correctness: 0, d2CodeQuality: 0, d3Reasoning: 0,
          d4Autonomy: 0, d5ContextMgmt: 0, d6Collaboration: 0, d7CostEfficiency: 0,
        },
        overallScore: 0,
        toolCallCount: 0,
        estimatedCostUsd: 0,
        logPath: '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * Run verification checks for a task in the work directory.
 *
 * @param task - The task with verification definitions
 * @param workDir - The directory where the agent made changes
 * @returns Array of verification results
 */
async function runVerificationChecks(
  task: EvalTask,
  workDir: string
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const check of task.verification) {
    console.log(`  [verify] ${check.name}: ${check.command}`);
    const { stdout, stderr, exitCode } = await runCommand(check.command, workDir, 60_000);
    const output = (stdout + '\n' + stderr).trim();

    let passed = false;
    if (check.expected === 'all_pass') {
      passed = exitCode === 0;
    } else if (check.expected === 'no_new_errors') {
      passed = exitCode === 0;
    } else {
      // Treat expected as a string to find in output
      passed = output.includes(check.expected) || exitCode === 0;
    }

    results.push({ name: check.name, passed, output: output.slice(0, 5000), exitCode });
    console.log(`  [verify] ${check.name}: ${passed ? 'PASS' : 'FAIL'} (exit: ${exitCode})`);
  }

  return results;
}

/**
 * Save an eval result to the results directory as JSON.
 */
async function saveResult(result: EvalResult, resultsDir: string): Promise<void> {
  const filename = `${result.taskId}-${result.runtime}-${Date.now()}.json`;
  const filePath = join(resultsDir, filename);
  await writeFile(filePath, JSON.stringify(result, null, 2), 'utf-8');
}

/**
 * Print a concise summary of a task result to console.
 */
function printTaskSummary(result: EvalResult): void {
  const checks = result.verificationResults;
  const passed = checks.filter((c) => c.passed).length;
  const total = checks.length;

  console.log(`\n  [${result.taskId}] Score: ${result.overallScore}/100 | Checks: ${passed}/${total} | Time: ${result.durationSeconds.toFixed(1)}s | Cost: $${result.estimatedCostUsd.toFixed(3)}`);
  console.log(`    D1=${result.scores.d1Correctness} D2=${result.scores.d2CodeQuality} D3=${result.scores.d3Reasoning} D4=${result.scores.d4Autonomy} D5=${result.scores.d5ContextMgmt} D6=${result.scores.d6Collaboration} D7=${result.scores.d7CostEfficiency}`);
}
