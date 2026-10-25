/**
 * CLI entry point for the Crewly Eval Runner.
 * Usage:
 *   crewly-eval run --all                    # Run all tasks with Claude Code
 *   crewly-eval run --task A1                # Run a specific task
 *   crewly-eval run --runtime crewly-agent   # Run with Crewly Agent
 *   crewly-eval report                       # Generate report from saved results
 */

import { Command } from 'commander';
import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
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
  });

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
