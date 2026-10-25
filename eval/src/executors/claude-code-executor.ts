/**
 * Claude Code CLI executor.
 * Invokes `claude` CLI in non-interactive mode with the task prompt,
 * captures output, and returns structured execution results.
 */

import { which } from '../utils/shell.js';
import { BaseExecutor, type ExecutionResult, type ExecutorOptions } from './base-executor.js';
import type { EvalTask, RuntimeType } from '../types/eval.types.js';

/** Cost estimate: Claude Opus 4.6 input/output pricing */
const COST_PER_1K_INPUT_TOKENS = 0.015;
const COST_PER_1K_OUTPUT_TOKENS = 0.075;
const AVG_CHARS_PER_TOKEN = 4;

/**
 * Executor that drives Claude Code CLI to solve eval tasks.
 * Uses `claude -p` (print mode) for non-interactive execution.
 */
export class ClaudeCodeExecutor extends BaseExecutor {
  readonly runtime: RuntimeType = 'claude-code';

  private cliPath: string;

  /**
   * @param cliPath - Path to the claude CLI binary (default: auto-detect via `which`)
   */
  constructor(cliPath?: string) {
    super();
    this.cliPath = cliPath ?? 'claude';
  }

  /**
   * Execute a task using Claude Code CLI.
   *
   * Strategy:
   * 1. Build a comprehensive prompt from the task definition
   * 2. Run `claude -p --output-format json` in the task's work directory
   * 3. Parse the JSON output for tool call counts
   * 4. Estimate cost from token usage
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
      const logPath = await this.saveLog(options.logDir, task.id, `Error: claude CLI not found at '${this.cliPath}'`);
      return {
        completionType: 'error',
        durationSeconds: 0,
        toolCallCount: 0,
        estimatedCostUsd: 0,
        logPath,
        error: `claude CLI not found at '${this.cliPath}'`,
      };
    }

    // Build the prompt
    const prompt = this.buildPrompt(task);

    // Run claude CLI in print mode with JSON output and auto-approve permissions
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', '50',
      '--model', 'opus',
      '--dangerously-skip-permissions',
    ];

    const timeLimitMs = options.timeLimitMinutes * 60 * 1000;
    const result = await this.spawnWithTimeout(
      resolvedPath,
      args,
      options.workDir,
      timeLimitMs
    );

    const durationSeconds = (Date.now() - startTime) / 1000;

    // Parse output
    const { toolCallCount, costUsd } = this.parseOutput(result.stdout);

    // Save full log
    const logContent = [
      `=== Claude Code Eval: ${task.id} ===`,
      `Duration: ${durationSeconds.toFixed(1)}s`,
      `Exit code: ${result.exitCode}`,
      `Timed out: ${result.timedOut}`,
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
      toolCallCount,
      estimatedCostUsd: costUsd,
      logPath,
      error: result.exitCode !== 0 ? `Exit code ${result.exitCode}` : undefined,
    };
  }

  /**
   * Build a comprehensive task prompt for Claude Code.
   * Includes task description, file hints, and expected verification criteria.
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
   * Parse Claude Code JSON output to extract tool call count and cost.
   * Falls back to heuristic estimation if JSON parsing fails.
   */
  private parseOutput(stdout: string): { toolCallCount: number; costUsd: number } {
    try {
      // Claude Code --output-format json returns a JSON object
      const parsed = JSON.parse(stdout);

      // Try to extract from structured output
      if (parsed.num_turns !== undefined) {
        const inputTokens = parsed.input_tokens ?? 0;
        const outputTokens = parsed.output_tokens ?? 0;
        return {
          toolCallCount: parsed.num_turns ?? 0,
          costUsd:
            (inputTokens / 1000) * COST_PER_1K_INPUT_TOKENS +
            (outputTokens / 1000) * COST_PER_1K_OUTPUT_TOKENS,
        };
      }
    } catch {
      // JSON parse failed — estimate from raw output
    }

    // Heuristic: count tool usage patterns in raw output
    const toolCallCount = (stdout.match(/tool_use|function_call|<tool>/g) || []).length || 1;
    const estimatedTokens = stdout.length / AVG_CHARS_PER_TOKEN;
    const costUsd = (estimatedTokens / 1000) * COST_PER_1K_INPUT_TOKENS;

    return { toolCallCount, costUsd };
  }
}
