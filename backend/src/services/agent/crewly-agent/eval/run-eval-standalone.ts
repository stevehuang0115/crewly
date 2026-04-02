#!/usr/bin/env npx tsx
/**
 * Crewly Eval Standalone Runner
 *
 * Runs eval tasks directly against the backend's POST /api/eval/run endpoint.
 * Unlike run-eval-cli.ts which uses /api/chat/eval, this uses the dedicated
 * eval endpoint that creates a temporary AgentRunnerService per task.
 *
 * If the /api/eval/run endpoint is not available (old backend), falls back
 * to a simulated scoring based on task setup + verify against manual execution.
 *
 * Usage:
 *   npx tsx backend/src/services/agent/crewly-agent/eval/run-eval-standalone.ts
 *   npx tsx ... --level=L1              # only L1 tasks
 *   npx tsx ... --level=L4              # only L4 tasks
 *   npx tsx ... --tasks=L1-01,L2-03     # specific tasks
 *   npx tsx ... --runtime=crewly-agent  # label for output
 *
 * @module eval/run-eval-standalone
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Import task definitions directly (no backend needed)
import { ALL_TASKS } from './tasks/index.js';
import { L1_TASKS } from './tasks/l1-tasks.js';
import { L2_TASKS } from './tasks/l2-tasks.js';
import { L3_TASKS } from './tasks/l3-tasks.js';
import { L4_TASKS } from './tasks/l4-tasks.js';
import {
  DIMENSION_WEIGHTS,
  EVAL_VERSION,
  type DimensionId,
  type EvalLevel,
  type EvalTask,
  type EvalVerification,
} from './eval-types.js';

// ─── Configuration ──────────────────────────────────────────────────────
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8787';
const OUTPUT_DIR = join(process.cwd(), 'eval-results');

// ─── Types ──────────────────────────────────────────────────────────────
interface TaskRunResult {
  taskId: string;
  level: string;
  title: string;
  passed: boolean;
  partialScore: number;
  durationMs: number;
  toolsUsed: string[];
  checks: Array<{ name: string; passed: boolean; message: string }>;
  collaborationChecks: Array<{ name: string; passed: boolean; message: string }>;
  output: string;
  error?: string;
  dimensions: Record<string, number>;
}

// ─── Backend API Client ─────────────────────────────────────────────────

/**
 * Attempt to run a task via the backend /api/eval/run endpoint.
 * Returns null if the endpoint is unavailable.
 */
async function tryBackendRun(
  prompt: string,
  workDir: string,
  timeoutMs: number,
): Promise<{ output: string; toolCalls: Array<{ toolName: string; args?: unknown; result?: unknown }> } | null> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/eval/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: `Working directory: ${workDir}\n\n${prompt}`,
        workDir,
        maxSteps: 200,
        timeoutMs,
      }),
      signal: AbortSignal.timeout(timeoutMs + 15_000),
    });

    if (!response.ok) return null;

    const result = await response.json() as {
      success: boolean;
      text?: string;
      toolCalls?: Array<{ toolName: string; args?: unknown; result?: unknown }>;
    };

    if (!result.success) return null;

    return {
      output: result.text || '',
      toolCalls: result.toolCalls || [],
    };
  } catch {
    return null;
  }
}

/**
 * Try the chat API endpoint as fallback.
 */
async function tryChatRun(
  prompt: string,
  workDir: string,
  timeoutMs: number,
): Promise<{ output: string; toolCalls: Array<{ toolName: string; args?: unknown; result?: unknown }> } | null> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/chat/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: `Working directory: ${workDir}\n\n${prompt}`,
        workDir,
        sessionName: `eval-standalone-${Date.now()}`,
        maxSteps: 200,
        timeoutMs,
      }),
      signal: AbortSignal.timeout(timeoutMs + 15_000),
    });

    if (!response.ok) return null;

    const result = await response.json() as {
      text?: string;
      toolCalls?: Array<{ toolName: string }>;
    };

    return {
      output: result.text || '',
      toolCalls: (result.toolCalls || []).map((tc) => ({ toolName: tc.toolName })),
    };
  } catch {
    return null;
  }
}

// ─── Scoring Helpers ────────────────────────────────────────────────────

/**
 * Compute per-dimension scores from verification results.
 *
 * D2 (Code Quality): For coding tasks, scores based on code-related
 * verification checks. For collaboration-only tasks, gives a neutral score.
 *
 * D6 (Stability): Starts at 100, deducts for actual instability signals
 * (tool errors, timeout, near-timeout) instead of using a pass/fail binary.
 *
 * @param verification - verification result from task.verify()
 * @param toolCalls    - tool calls recorded during the run
 * @param task         - the eval task definition
 * @param durationMs   - wall-clock duration of the task run
 * @returns per-dimension scores (0-100)
 */
export function computeDimensions(
  verification: EvalVerification,
  toolCalls: Array<{ toolName: string; args?: unknown; result?: unknown }>,
  task: EvalTask,
  durationMs: number,
): Record<string, number> {
  const checks = verification.checks;
  const collabChecks = verification.collaborationChecks ?? [];

  // D1 Completion
  const passBonus = verification.passed ? 70 : 0;
  const partialChecks = checks.length > 0
    ? (checks.filter((c) => c.passed).length / checks.length) * 30
    : 0;
  const d1 = Math.min(100, passBonus + partialChecks);

  // D2 Code Quality — analyze actual output quality
  // Coding tasks: score based on checks that verify code creation & structure
  // Collaboration-only tasks: give neutral score (no code expected)
  const codingCheckNames = new Set([
    'created_controller', 'created_service', 'created_test',
    'created_logger', 'created_file', 'has_named_exports',
    'has_typed_interfaces', 'has_error_handling', 'has_test_file',
    'used_patterns', 'no_any_types', 'fixed_build',
  ]);
  const codeChecks = checks.filter((c) => codingCheckNames.has(c.name));
  let d2: number;
  if (codeChecks.length === 0) {
    // No coding checks → collaboration task, neutral D2
    d2 = verification.passed ? 80 : 60;
  } else {
    // Coding task — score based on actual code quality checks
    const codePassed = codeChecks.filter((c) => c.passed).length;
    d2 = Math.round((codePassed / codeChecks.length) * 100);
  }

  // D3 Tool Accuracy
  const expectedSet = new Set(task.expectedTools.map((t) => t.toLowerCase()));
  const actualTools = toolCalls.map((tc) => tc.toolName.toLowerCase());
  const correctCalls = actualTools.filter((t) => {
    for (const exp of expectedSet) {
      if (t.includes(exp) || exp.includes(t)) return true;
    }
    return false;
  }).length;
  const totalCalls = actualTools.length || 1;
  const d3 = Math.min(100, (correctCalls / totalCalls) * 60 + (correctCalls > 0 ? 40 : 0));

  // D4 Autonomy (no nudges in automated eval)
  const d4 = 100;

  // D5 Collaboration
  let d5 = 100; // default for non-L4
  if (task.level === 'L4') {
    if (collabChecks.length === 0) {
      d5 = 0;
    } else {
      d5 = (collabChecks.filter((c) => c.passed).length / collabChecks.length) * 100;
    }
  }

  // D6 Stability — deduct only for actual instability signals
  // Start at 100, penalize for: tool errors (-10 each), timeout (-40), excessive duration (-10)
  let d6 = 100;
  const toolErrors = toolCalls.filter((tc) =>
    tc.result && typeof tc.result === 'object' && 'error' in (tc.result as Record<string, unknown>),
  ).length;
  d6 -= toolErrors * 10;
  // Timeout penalty: if durationMs exceeds task timeout (or 120s default)
  const taskTimeout = task.timeoutMs ?? 120_000;
  if (durationMs > taskTimeout) {
    d6 -= 40;
  } else if (durationMs > taskTimeout * 0.9) {
    // Near-timeout: minor penalty
    d6 -= 10;
  }
  d6 = Math.max(0, Math.min(100, d6));

  // D7 Cost Efficiency (assume baseline in standalone)
  const d7 = 100;

  return {
    D1_completion: Math.round(d1),
    D2_codeQuality: Math.round(d2),
    D3_toolAccuracy: Math.round(d3),
    D4_autonomy: Math.round(d4),
    D5_collaboration: Math.round(d5),
    D6_stability: Math.round(d6),
    D7_costEfficiency: Math.round(d7),
  };
}

/**
 * Calculate weighted composite score.
 */
function compositeScore(dimensions: Record<string, number>): number {
  let score = 0;
  for (const [dimId, raw] of Object.entries(dimensions)) {
    const weight = DIMENSION_WEIGHTS[dimId as DimensionId] ?? 0;
    score += raw * weight;
  }
  return Math.round(score * 10) / 10;
}

// ─── Main Runner ────────────────────────────────────────────────────────

async function runTask(task: EvalTask): Promise<TaskRunResult> {
  const workDir = join(tmpdir(), `crewly-eval-${task.id}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  const startMs = Date.now();
  let output = '';
  let toolCalls: Array<{ toolName: string; args?: unknown; result?: unknown }> = [];
  let verification: EvalVerification = { passed: false, checks: [] };
  let error: string | undefined;

  try {
    // Setup
    await task.setup(workDir);

    // Try running via backend
    let result = await tryBackendRun(task.prompt, workDir, task.timeoutMs);
    if (!result) {
      result = await tryChatRun(task.prompt, workDir, task.timeoutMs);
    }

    if (result) {
      output = result.output;
      toolCalls = result.toolCalls;

      // Verify
      const toolCallRecords = toolCalls.map((tc) => ({
        toolName: tc.toolName,
        args: (tc.args ?? {}) as Record<string, unknown>,
        result: (tc.result ?? '') as Record<string, unknown> | string,
      }));
      verification = await task.verify(workDir, toolCallRecords);
    } else {
      error = 'Backend not available (both /api/eval/run and /api/chat/eval failed)';
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    // Teardown
    try {
      if (task.teardown) await task.teardown(workDir);
      await rm(workDir, { recursive: true, force: true });
    } catch { /* */ }
  }

  const durationMs = Date.now() - startMs;
  const dimensions = computeDimensions(verification, toolCalls, task, durationMs);

  return {
    taskId: task.id,
    level: task.level,
    title: task.title,
    passed: verification.passed,
    partialScore: verification.checks.length > 0
      ? verification.checks.filter((c) => c.passed).length / verification.checks.length
      : 0,
    durationMs,
    toolsUsed: [...new Set(toolCalls.map((tc) => tc.toolName))],
    checks: verification.checks.map((c) => ({
      name: c.name,
      passed: c.passed,
      message: c.message,
    })),
    collaborationChecks: (verification.collaborationChecks ?? []).map((c) => ({
      name: c.name,
      passed: c.passed,
      message: c.message,
    })),
    output: output.slice(0, 500),
    error,
    dimensions,
  };
}

async function main(): Promise<void> {
  // Parse args
  const args = process.argv.slice(2);
  const levelArg = args.find((a) => a.startsWith('--level='))?.split('=')[1];
  const tasksArg = args.find((a) => a.startsWith('--tasks='))?.split('=')[1]?.split(',');
  const runtimeLabel = args.find((a) => a.startsWith('--runtime='))?.split('=')[1] || 'crewly-agent';

  // Select tasks
  let tasks: EvalTask[] = ALL_TASKS;
  if (levelArg) {
    const levels = levelArg.split(',') as EvalLevel[];
    tasks = tasks.filter((t) => levels.includes(t.level));
  }
  if (tasksArg) {
    const idSet = new Set(tasksArg);
    tasks = tasks.filter((t) => idSet.has(t.id));
  }

  console.log('═'.repeat(72));
  console.log(`  CREWLY EVAL RUNNER v${EVAL_VERSION} — Standalone`);
  console.log(`  Runtime: ${runtimeLabel} | Tasks: ${tasks.length} | Backend: ${BACKEND_URL}`);
  console.log(`  Levels: ${[...new Set(tasks.map((t) => t.level))].join(', ')}`);
  console.log('═'.repeat(72));

  // Check backend connectivity
  try {
    const health = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (health.ok) {
      console.log('  ✓ Backend connected');
    } else {
      console.log('  ⚠ Backend returned non-200');
    }
  } catch {
    console.log('  ✗ Backend not reachable — tasks will fail');
  }

  // Run tasks
  const results: TaskRunResult[] = [];

  for (const task of tasks) {
    console.log(`\n▸ ${task.id}: ${task.title} [${task.level}]`);

    const result = await runTask(task);
    results.push(result);

    const icon = result.passed ? '✅' : result.error ? '💥' : '❌';
    const composite = compositeScore(result.dimensions);
    console.log(`  ${icon} Score: ${composite}/100 | Duration: ${result.durationMs}ms`);

    if (result.error) {
      console.log(`  Error: ${result.error.slice(0, 100)}`);
    }

    for (const check of result.checks) {
      console.log(`    ${check.passed ? '✓' : '✗'} ${check.name}: ${check.message}`);
    }
    for (const check of result.collaborationChecks) {
      console.log(`    ${check.passed ? '✓' : '✗'} [collab] ${check.name}: ${check.message}`);
    }
  }

  // Summary
  console.log('\n' + '═'.repeat(72));
  console.log('  SUMMARY');
  console.log('═'.repeat(72));

  // Exclude errored tasks (backend unavailable) from scoring
  const scoredResults = results.filter((r) => !r.error);
  const erroredResults = results.filter((r) => r.error);
  const passed = scoredResults.filter((r) => r.passed).length;
  const avgComposite = scoredResults.length > 0
    ? scoredResults.reduce((sum, r) => sum + compositeScore(r.dimensions), 0) / scoredResults.length
    : 0;

  console.log(`  Pass: ${passed}/${scoredResults.length} scored | Avg Score: ${avgComposite.toFixed(1)}/100`);
  if (erroredResults.length > 0) {
    console.log(`  ⚠ ${erroredResults.length} task(s) excluded due to backend errors`);
  }
  console.log('');

  // Per-level breakdown
  const levels = ['L1', 'L2', 'L3', 'L4'];
  for (const level of levels) {
    const levelResults = scoredResults.filter((r) => r.level === level);
    if (levelResults.length === 0) continue;
    const levelAvg = levelResults.reduce((sum, r) => sum + compositeScore(r.dimensions), 0) / levelResults.length;
    const levelPassed = levelResults.filter((r) => r.passed).length;
    console.log(`  ${level}: ${levelPassed}/${levelResults.length} passed | Avg: ${levelAvg.toFixed(1)}`);
    for (const r of levelResults) {
      const icon = r.passed ? '✅' : '❌';
      console.log(`    ${icon} ${r.taskId}: ${compositeScore(r.dimensions)} (${r.durationMs}ms)`);
    }
  }

  // Dimension averages (scored tasks only)
  console.log('\n  Dimension Averages:');
  const dimIds: DimensionId[] = [
    'D1_completion', 'D2_codeQuality', 'D3_toolAccuracy',
    'D4_autonomy', 'D5_collaboration', 'D6_stability', 'D7_costEfficiency',
  ];
  for (const dimId of dimIds) {
    const avg = scoredResults.length > 0
      ? scoredResults.reduce((sum, r) => sum + (r.dimensions[dimId] ?? 0), 0) / scoredResults.length
      : 0;
    const weight = DIMENSION_WEIGHTS[dimId];
    console.log(`    ${dimId.padEnd(20)} ${avg.toFixed(1).padStart(6)} (w=${weight})`);
  }

  console.log('═'.repeat(72));

  // Save results
  await mkdir(OUTPUT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const filename = `eval-${runtimeLabel}-${timestamp}.json`;
  const report = {
    version: EVAL_VERSION,
    runtime: runtimeLabel,
    timestamp: new Date().toISOString(),
    summary: {
      totalTasks: results.length,
      scoredTasks: scoredResults.length,
      erroredTasks: erroredResults.length,
      passedTasks: passed,
      avgComposite: Math.round(avgComposite * 10) / 10,
      byLevel: Object.fromEntries(
        levels
          .filter((l) => scoredResults.some((r) => r.level === l))
          .map((l) => {
            const lr = scoredResults.filter((r) => r.level === l);
            return [l, {
              count: lr.length,
              passed: lr.filter((r) => r.passed).length,
              avgScore: Math.round(lr.reduce((s, r) => s + compositeScore(r.dimensions), 0) / lr.length * 10) / 10,
            }];
          }),
      ),
      dimensionAverages: Object.fromEntries(
        dimIds.map((d) => [d, scoredResults.length > 0
          ? Math.round(scoredResults.reduce((s, r) => s + (r.dimensions[d] ?? 0), 0) / scoredResults.length * 10) / 10
          : 0]),
      ),
    },
    taskResults: results,
  };

  await writeFile(join(OUTPUT_DIR, filename), JSON.stringify(report, null, 2));
  console.log(`\nResults saved to eval-results/${filename}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
