/**
 * Gemini CLI executor.
 * Invokes `gemini` CLI in non-interactive mode with the task prompt,
 * captures JSON output, and returns structured execution results.
 */

import { which } from '../utils/shell.js';
import { BaseExecutor, type ExecutionResult, type ExecutorOptions } from './base-executor.js';
import type { EvalTask, RuntimeType } from '../types/eval.types.js';

/**
 * Cost estimate per model (USD per 1K tokens).
 * Gemini CLI may use multiple models (router + main).
 * Using Gemini 2.5 Flash pricing as default.
 */
const GEMINI_PRICING: Record<string, { input: number; output: number }> = {
  'gemini-3-flash-preview': { input: 0.00015, output: 0.0006 },
  'gemini-2.5-flash': { input: 0.00015, output: 0.0006 },
  'gemini-2.5-flash-lite': { input: 0.0, output: 0.0 },  // Free tier / router
  'default': { input: 0.00015, output: 0.0006 },
};

/**
 * Parsed statistics from Gemini CLI JSON output.
 */
interface GeminiStats {
  /** Total tool calls made by the agent */
  totalToolCalls: number;
  /** Total input tokens across all models */
  totalInputTokens: number;
  /** Total output tokens across all models */
  totalOutputTokens: number;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
}

/**
 * Executor that drives Gemini CLI to solve eval tasks.
 * Uses `gemini -p` (prompt mode) for non-interactive execution.
 */
export class GeminiCliExecutor extends BaseExecutor {
  readonly runtime: RuntimeType = 'gemini-cli';

  private cliPath: string;

  /**
   * @param cliPath - Path to the gemini CLI binary (default: auto-detect via `which`)
   */
  constructor(cliPath?: string) {
    super();
    this.cliPath = cliPath ?? 'gemini';
  }

  /**
   * Execute a task using Gemini CLI.
   *
   * Strategy:
   * 1. Build a comprehensive prompt from the task definition
   * 2. Run `gemini -p "prompt" --yolo -o json` in the task's work directory
   * 3. Parse the JSON output for tool call counts and token usage
   * 4. Calculate cost from per-model token usage
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
      const logPath = await this.saveLog(options.logDir, task.id, `Error: gemini CLI not found at '${this.cliPath}'`);
      return {
        completionType: 'error',
        durationSeconds: 0,
        toolCallCount: 0,
        estimatedCostUsd: 0,
        logPath,
        error: `gemini CLI not found at '${this.cliPath}'`,
      };
    }

    // Build the prompt
    const prompt = this.buildPrompt(task);

    // Run gemini CLI in non-interactive mode with JSON output and auto-approve
    const args = [
      '-p', prompt,
      '--yolo',
      '-o', 'json',
    ];

    const timeLimitMs = options.timeLimitMinutes * 60 * 1000;
    const result = await this.spawnWithTimeout(
      resolvedPath,
      args,
      options.workDir,
      timeLimitMs
    );

    const durationSeconds = (Date.now() - startTime) / 1000;

    // Parse output for stats
    const stats = this.parseGeminiOutput(result.stdout);

    // Save full log
    const logContent = [
      `=== Gemini CLI Eval: ${task.id} ===`,
      `Duration: ${durationSeconds.toFixed(1)}s`,
      `Exit code: ${result.exitCode}`,
      `Timed out: ${result.timedOut}`,
      `Tool calls: ${stats.totalToolCalls}`,
      `Input tokens: ${stats.totalInputTokens}`,
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
   * Build a comprehensive task prompt for Gemini CLI.
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
   * Parse Gemini CLI JSON output to extract tool call count, token usage, and cost.
   * The JSON output contains:
   * - stats.tools.totalCalls: number of tool invocations
   * - stats.models.<model>.tokens: per-model token breakdown
   *
   * @param stdout - Raw stdout from gemini CLI
   * @returns Parsed statistics
   */
  private parseGeminiOutput(stdout: string): GeminiStats {
    const defaultStats: GeminiStats = {
      totalToolCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
    };

    try {
      // Gemini may append extra lines after JSON (e.g., "Shell cwd was reset to...")
      // Find the JSON object by looking for first { to last matching }
      const jsonStr = this.extractJson(stdout);
      if (!jsonStr) return defaultStats;

      const parsed = JSON.parse(jsonStr);

      // Extract tool call count from stats.tools.totalCalls
      const totalToolCalls = parsed?.stats?.tools?.totalCalls ?? 0;

      // Aggregate token usage across all models
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let estimatedCostUsd = 0;

      const models = parsed?.stats?.models;
      if (models && typeof models === 'object') {
        for (const [modelName, modelData] of Object.entries(models)) {
          const tokens = (modelData as Record<string, unknown>)?.tokens as Record<string, number> | undefined;
          if (tokens) {
            const inputTokens = tokens.input ?? 0;
            const outputTokens = tokens.candidates ?? 0;
            totalInputTokens += inputTokens;
            totalOutputTokens += outputTokens;

            // Calculate cost for this model
            const pricing = GEMINI_PRICING[modelName] ?? GEMINI_PRICING['default'];
            estimatedCostUsd +=
              (inputTokens / 1000) * pricing.input +
              (outputTokens / 1000) * pricing.output;
          }
        }
      }

      return {
        totalToolCalls,
        totalInputTokens,
        totalOutputTokens,
        estimatedCostUsd,
      };
    } catch {
      // JSON parse failed — try heuristic
      return this.heuristicParse(stdout);
    }
  }

  /**
   * Extract the JSON object from stdout, ignoring any trailing non-JSON lines.
   *
   * @param stdout - Raw stdout that may contain JSON followed by extra text
   * @returns The JSON string, or null if not found
   */
  private extractJson(stdout: string): string | null {
    const firstBrace = stdout.indexOf('{');
    if (firstBrace === -1) return null;

    // Find the matching closing brace by counting nesting
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = firstBrace; i < stdout.length; i++) {
      const ch = stdout[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          return stdout.slice(firstBrace, i + 1);
        }
      }
    }

    return null;
  }

  /**
   * Heuristic fallback: estimate tool calls from raw output patterns.
   *
   * @param stdout - Raw stdout from gemini CLI
   * @returns Estimated statistics
   */
  private heuristicParse(stdout: string): GeminiStats {
    // Count tool-related patterns in Gemini output
    const toolPatterns = /function_call|tool_use|toolCall|executing|read_file|write_file|run_command|shell/gi;
    const matches = stdout.match(toolPatterns) || [];
    const toolCallCount = matches.length || 1;

    return {
      totalToolCalls: toolCallCount,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
    };
  }
}
