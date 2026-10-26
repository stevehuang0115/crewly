/**
 * CLI entry point for the Crewly Eval Runner.
 * Usage:
 *   crewly-eval run --all                    # Run all tasks with Claude Code
 *   crewly-eval run --task A1                # Run a specific task
 *   crewly-eval run --runtime crewly-agent   # Run with Crewly Agent
 *   crewly-eval run --all --diff             # Run, then diff against the latest baseline
 *   crewly-eval diff --runtime claude-code   # Diff saved results against the latest baseline
 *   crewly-eval record --date 2026-10-26     # Turn results/ into baselines/<date>/<runtime>/
 */

import { Command } from 'commander';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import type { EvalConfig, RuntimeType } from './types/eval.types.js';
import { ClaudeCodeExecutor } from './executors/claude-code-executor.js';
import { CrewlyAgentExecutor } from './executors/crewly-agent-executor.js';
import { GeminiCliExecutor } from './executors/gemini-cli-executor.js';
import { CodexCliExecutor } from './executors/codex-cli-executor.js';
import { runAllTasks } from './runner/eval-runner.js';
import { buildScorecard } from './scorer/scorer.js';
import { generateReport, printResultsSummary } from './results/report-generator.js';
import { ALL_TASKS } from './tasks/task-registry.js';
import type { BaseExecutor } from './executors/base-executor.js';
import {
  diffResults,
  findLatestBaselineDir,
  hasRegression,
  loadResults,
  recordBaseline,
  renderDiffMarkdown,
} from './diff/baseline-diff.js';

/** The eval package root (`eval/`), whether run from src/ or dist/. */
const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where recorded baselines live. */
const BASELINES_ROOT = resolve(EVAL_ROOT, 'baselines');

const program = new Command();

program
  .name('crewly-eval')
  .description('Crewly Agent Evaluation Runner — real execution benchmarks')
  .version('0.1.0');

program
  .command('run')
  .description('Run eval tasks against an agent runtime')
  .option('--all', 'Run all tasks')
  .option('--task <id>', 'Run a specific task by ID (e.g., A1, B1, C1)')
  .option('--runtime <type>', 'Runtime to test (claude-code | crewly-agent | gemini-cli | codex-cli)', 'claude-code')
  .option('--workspace <path>', 'Workspace root directory', resolve('.'))
  .option('--results <path>', 'Results output directory', resolve('./results'))
  .option('--claude-path <path>', 'Path to claude CLI binary')
  .option('--crewly-url <url>', 'Crewly Agent API base URL')
  .option('--time-limit <minutes>', 'Override time limit per task (minutes)')
  .option('--model <id>', 'Model override for agent runtime (e.g., gemini-2.5-flash)')
  .option('--provider <name>', 'Provider override (google, anthropic, openai, ollama)')
  .option('--diff', 'After the run, diff the results against the latest baseline (exit 1 on regression)')
  .option('--baseline <path>', 'Baseline directory to diff against (default: newest under baselines/)')
  .action(async (opts) => {
    const config: EvalConfig = {
      workspaceRoot: resolve(opts.workspace),
      resultsDir: resolve(opts.results),
      useWorktrees: false,
      maxParallel: 1,
      claudeCodePath: opts.claudePath ?? 'claude',
      crewlyAgentUrl: opts.crewlyUrl ?? 'http://localhost:3000',
      model: opts.model,
      provider: opts.provider,
    };

    await mkdir(config.resultsDir, { recursive: true });

    // Select executor
    const runtime = opts.runtime as RuntimeType;
    let executor: BaseExecutor;

    switch (runtime) {
      case 'claude-code':
        executor = new ClaudeCodeExecutor(config.claudeCodePath);
        break;
      case 'crewly-agent':
        executor = new CrewlyAgentExecutor(config.crewlyAgentUrl, config.model, config.provider);
        break;
      case 'gemini-cli':
        executor = new GeminiCliExecutor();
        break;
      case 'codex-cli':
        executor = new CodexCliExecutor();
        break;
      default:
        console.error(`Unknown runtime: ${runtime}. Supported: claude-code, crewly-agent, gemini-cli, codex-cli`);
        process.exit(1);
    }

    // Select tasks
    const taskIds = opts.all ? undefined : opts.task ? [opts.task] : undefined;
    if (!opts.all && !opts.task) {
      console.error('Specify --all or --task <id>');
      program.commands.find((c) => c.name() === 'run')?.help();
      process.exit(1);
    }

    console.log(`\nCrewly Eval Runner v0.1.0`);
    console.log(`Runtime: ${runtime}`);
    if (config.model) console.log(`Model: ${config.model}`);
    if (config.provider) console.log(`Provider: ${config.provider}`);
    console.log(`Tasks: ${taskIds ? taskIds.join(', ') : 'ALL'}`);
    console.log(`Workspace: ${config.workspaceRoot}`);
    console.log(`Results: ${config.resultsDir}\n`);

    // Run
    const results = await runAllTasks(executor, config, taskIds);

    // Print summary
    printResultsSummary(results);

    // Build scorecard and generate report
    const scorecard = buildScorecard(runtime, results);
    const reportPath = await generateReport([scorecard], config.resultsDir);
    console.log(`\nReport saved: ${reportPath}`);

    if (opts.diff) {
      const regressed = await printDiff(config.resultsDir, opts.baseline, runtime);
      if (regressed) process.exitCode = 1;
    }
  });

program
  .command('diff')
  .description('Compare saved results against the latest recorded baseline, per task (exit 1 on regression)')
  .option('--runtime <type>', 'Only this runtime (default: every runtime present)')
  .option('--results <path>', 'Results directory to read', resolve('./results'))
  .option('--baseline <path>', 'Baseline directory (default: newest under baselines/)')
  .option('--out <path>', 'Also write the markdown report to this file')
  .action(async (opts) => {
    const regressed = await printDiff(resolve(opts.results), opts.baseline, opts.runtime as RuntimeType | undefined, opts.out);
    if (regressed) process.exitCode = 1;
  });

program
  .command('record')
  .description('Copy the newest result per task from results/ into baselines/<date>/<runtime>/')
  .requiredOption('--date <YYYY-MM-DD>', 'Baseline date')
  .option('--runtime <type>', 'Only this runtime')
  .option('--results <path>', 'Results directory to read', resolve('./results'))
  .action(async (opts) => {
    try {
      const written = await recordBaseline(resolve(opts.results), BASELINES_ROOT, opts.date, EVAL_ROOT, opts.runtime as RuntimeType | undefined);
      console.log(`Recorded ${written.length} file(s) under baselines/${opts.date}/:`);
      for (const f of written) console.log(`  ${f}`);
      console.log('\nNow write or update the comparison-report.md there with the model names and CLI versions used.');
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

/**
 * Load both sides, print the markdown diff, optionally save it.
 *
 * @param resultsDir - Fresh results
 * @param baselineOpt - Explicit baseline dir, or undefined for the newest
 * @param runtime - Optional runtime filter
 * @param out - Optional file to write the markdown to
 * @returns true when a compared task regressed
 */
async function printDiff(resultsDir: string, baselineOpt: string | undefined, runtime?: RuntimeType, out?: string): Promise<boolean> {
  const baselineDir = baselineOpt ? resolve(baselineOpt) : await findLatestBaselineDir(BASELINES_ROOT);
  if (!baselineDir) {
    console.error(`No baseline found under ${BASELINES_ROOT}. Record one with: crewly-eval record --date YYYY-MM-DD`);
    return false;
  }
  const [baseline, current] = await Promise.all([loadResults(baselineDir, runtime), loadResults(resultsDir, runtime)]);
  const report = diffResults(baseline, current, { baselineDir, currentDir: resultsDir });
  const md = renderDiffMarkdown(report);
  console.log(`\n${md}`);
  if (out) {
    await writeFile(resolve(out), md, 'utf-8');
    console.log(`\nDiff saved: ${resolve(out)}`);
  }
  return hasRegression(report);
}

program
  .command('list')
  .description('List all available eval tasks')
  .action(() => {
    console.log('\nAvailable Eval Tasks:\n');
    for (const task of ALL_TASKS) {
      console.log(`  ${task.id} [${task.category}] (${task.tier}) — ${task.title}`);
      console.log(`     Time limit: ${task.timeLimitMinutes}min | Expert steps: ${task.minStepsExpert} | Baseline cost: $${task.baselineCostUsd}`);
    }
    console.log('');
  });

program.parse();
