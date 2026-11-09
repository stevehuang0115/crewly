/**
 * Codex CLI executor.
 * Invokes `codex exec` in non-interactive mode with JSONL output,
 * parses structured events, and returns execution results.
 */

import { spawn } from 'node:child_process';
import { which, runCommand } from '../utils/shell.js';
import { BaseExecutor, type ExecutionResult, type ExecutorOptions } from './base-executor.js';
import type { EvalTask, RuntimeType } from '../types/eval.types.js';

/**
 * OpenAI pricing per 1K tokens (GPT-4.1 default for Codex CLI).
 * Codex CLI uses the Responses API with configurable models.
 */
const COST_PER_1K_INPUT_TOKENS = 0.002;
const COST_PER_1K_OUTPUT_TOKENS = 0.008;
const COST_PER_1K_CACHED_TOKENS = 0.0005;

/**
 * Parsed statistics from Codex CLI JSONL output.
 */
interface CodexStats {
  /** Total tool calls (command_execution + file_change items) */
  totalToolCalls: number;
  /** Total input tokens across all turns */
  totalInputTokens: number;
  /** Total cached input tokens across all turns */
  totalCachedInputTokens: number;
  /** Total output tokens across all turns */
  totalOutputTokens: number;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
}

/**
 * Executor that drives Codex CLI to solve eval tasks.
 * Uses `codex exec --full-auto --json` for non-interactive execution with JSONL output.
 */
export class CodexCliExecutor extends BaseExecutor {
  readonly runtime: RuntimeType = 'codex-cli';

  private cliPath: string;

  /**
   * @param cliPath - Path to the codex CLI binary (default: auto-detect via `which`)
   */
  constructor(cliPath?: string) {
    super();
    this.cliPath = cliPath ?? 'codex';
  }

  /**
   * Spawn a child process and immediately close stdin.
   * Codex CLI reads stdin for additional input — closing it signals "no more input"
   * so the agent proceeds with just the CLI argument prompt.
   *
   * @param command - The command to run
   * @param args - Command arguments
   * @param cwd - Working directory
   * @param timeLimitMs - Timeout in milliseconds
   * @returns Process output, exit code, and whether it timed out
   */
  private spawnAndCloseStdin(
    command: string,
    args: string[],
    cwd: string,
    timeLimitMs: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
      });

      // Immediately close stdin so Codex doesn't wait for more input
      proc.stdin.end();

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 10_000);
      }, timeLimitMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: 1, timedOut: false });
      });
    });
  }

  /**
   * Execute a task using Codex CLI.
   *
   * Strategy:
   * 1. Build a comprehensive prompt from the task definition
   * 2. Pipe prompt via stdin to `codex exec --full-auto --json`
   * 3. Parse JSONL events for tool call counts and token usage
   * 4. Calculate cost from aggregated token usage
   *
   * @param task - The eval task to execute
   * @param options - Work directory, log directory, time limit
   * @returns Structured execution result
   */
  async execute(task: EvalTask, options: ExecutorOptions): Promise<ExecutionResult> {
    const startTime = Date.now();

    // Verify CLI exists
    const resolvedPath = await which(this.cliPath);
    if (!resolvedPath) {
      const logPath = await this.saveLog(options.logDir, task.id, `Error: codex CLI not found at '${this.cliPath}'`);
      return {
        completionType: 'error',
        durationSeconds: 0,
        toolCallCount: 0,
        estimatedCostUsd: 0,
        logPath,
        error: `codex CLI not found at '${this.cliPath}'`,
      };
    }

    // Ensure work directory is a git repo (Codex CLI requires it)
    await this.ensureGitRepo(options.workDir);

    // Build the prompt
    const prompt = this.buildPrompt(task);

    // Run codex exec with full-auto (auto-approve + workspace-write sandbox) and JSON output
    // Use -C to set working directory, pipe prompt via stdin
    const args = [
      'exec',
      '--full-auto',
      '--json',
      '-C', options.workDir,
      prompt,
    ];

    const timeLimitMs = options.timeLimitMinutes * 60 * 1000;
    const result = await this.spawnAndCloseStdin(
      resolvedPath,
      args,
      options.workDir,
      timeLimitMs
    );

    const durationSeconds = (Date.now() - startTime) / 1000;

    // Parse JSONL output for stats
    const stats = this.parseCodexOutput(result.stdout);

    // Save full log
    const logContent = [
      `=== Codex CLI Eval: ${task.id} ===`,
      `Duration: ${durationSeconds.toFixed(1)}s`,
      `Exit code: ${result.exitCode}`,
      `Timed out: ${result.timedOut}`,
      `Tool calls: ${stats.totalToolCalls}`,
      `Input tokens: ${stats.totalInputTokens}`,
      `Cached tokens: ${stats.totalCachedInputTokens}`,
      `Output tokens: ${stats.totalOutputTokens}`,
      `Estimated cost: $${stats.estimatedCostUsd.toFixed(4)}`,
      '',
      '=== STDOUT ===',
      result.stdout,
      '',
      '=== STDERR ===',
      result.stderr,
    ].join('\n');

    const logPath = await this.saveLog(options.logDir, task.id, logContent);

    // Determine completion type
    let completionType: ExecutionResult['completionType'];
    if (result.timedOut) {
      completionType = 'timeout';
    } else if (result.exitCode !== 0) {
      completionType = 'error';
    } else {
      completionType = 'agent_done';
    }

    return {
      completionType,
      durationSeconds,
      toolCallCount: stats.totalToolCalls,
      estimatedCostUsd: stats.estimatedCostUsd,
      logPath,
      error: result.exitCode !== 0 ? `Exit code ${result.exitCode}` : undefined,
    };
  }

  /**
   * Ensure the work directory is a git repository.
   * Codex CLI refuses to run outside of a git repo unless --skip-git-repo-check is used.
   * We prefer init over the flag so Codex can track file changes.
   *
   * @param workDir - The working directory to check/init
   */
  private async ensureGitRepo(workDir: string): Promise<void> {
    const { exitCode } = await runCommand('git rev-parse --git-dir', workDir, 5_000);
    if (exitCode !== 0) {
      await runCommand('git init && git add -A && git commit -m "initial" --allow-empty', workDir, 15_000);
    }
  }

  /**
   * Build a comprehensive task prompt for Codex CLI.
   * Includes task description, file hints, and expected verification criteria.
   *
   * @param task - The eval task definition
   * @returns Formatted prompt string
   */
  private buildPrompt(task: EvalTask): string {
    const sections = [
      `# Task: ${task.title}`,
      '',
      task.description,
      '',
    ];

    if (task.filesHint.length > 0) {
      sections.push('## Relevant files:');
      task.filesHint.forEach((f) => sections.push(`- ${f}`));
      sections.push('');
    }

    sections.push('## Acceptance criteria:');
    task.verification.forEach((v) => {
      sections.push(`- ${v.name}: run \`${v.command}\` — expected: ${v.expected}`);
    });

    sections.push('');
    sections.push('Complete this task. Make sure all verification checks pass before finishing.');

    return sections.join('\n');
  }

  /**
   * Parse Codex CLI JSONL output to extract tool call count, token usage, and cost.
   *
   * Codex CLI outputs one JSON object per line with the following event types:
   * - thread.started: session info
   * - turn.started: new agent turn begins
   * - item.completed: completed item (agent_message, command_execution, file_change)
   * - turn.completed: turn ends with usage stats {input_tokens, cached_input_tokens, output_tokens}
   *
   * Tool calls are counted as completed items of type "command_execution" or "file_change".
   *
   * @param stdout - Raw JSONL stdout from codex CLI
   * @returns Parsed statistics
   */
  private parseCodexOutput(stdout: string): CodexStats {
    let totalToolCalls = 0;
    let totalInputTokens = 0;
    let totalCachedInputTokens = 0;
    let totalOutputTokens = 0;

    const lines = stdout.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;

      try {
        const event = JSON.parse(trimmed);

        // Count tool calls from completed items
        if (event.type === 'item.completed' && event.item) {
          const itemType = event.item.type;
          if (itemType === 'command_execution' || itemType === 'file_change') {
            totalToolCalls++;
          }
        }

        // Aggregate token usage from turn completions
        if (event.type === 'turn.completed' && event.usage) {
          totalInputTokens += event.usage.input_tokens ?? 0;
          totalCachedInputTokens += event.usage.cached_input_tokens ?? 0;
          totalOutputTokens += event.usage.output_tokens ?? 0;
        }
      } catch {
        // Skip non-JSON lines (e.g., "Reading prompt from stdin...")
      }
    }

    // Calculate cost
    const nonCachedInputTokens = totalInputTokens - totalCachedInputTokens;
    const estimatedCostUsd =
      (nonCachedInputTokens / 1000) * COST_PER_1K_INPUT_TOKENS +
      (totalCachedInputTokens / 1000) * COST_PER_1K_CACHED_TOKENS +
      (totalOutputTokens / 1000) * COST_PER_1K_OUTPUT_TOKENS;

    return {
      totalToolCalls,
      totalInputTokens,
      totalCachedInputTokens,
      totalOutputTokens,
      estimatedCostUsd,
    };
  }
}
