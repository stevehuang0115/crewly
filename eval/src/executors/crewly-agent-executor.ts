/**
 * Crewly Agent executor.
 * Invokes the Crewly backend API to create a task, assigns it to an agent,
 * then monitors progress until completion or timeout.
 */

import { BaseExecutor, type ExecutionResult, type ExecutorOptions } from './base-executor.js';
import type { EvalTask, RuntimeType } from '../types/eval.types.js';

/** Cost estimate: Claude Sonnet 4 input/output pricing (CLI fallback default model) */
const COST_PER_1K_INPUT_TOKENS = 0.003;
const COST_PER_1K_OUTPUT_TOKENS = 0.015;
const AVG_CHARS_PER_TOKEN = 4;

/** Default Crewly backend API URL */
const DEFAULT_CREWLY_URL = 'http://localhost:8787';

/** Poll interval for checking task status (ms) */
const POLL_INTERVAL_MS = 5_000;

/**
 * Executor that drives a Crewly Agent (via backend API) to solve eval tasks.
 *
 * Workflow:
 * 1. POST /api/eval/run — submit the task to the Crewly eval endpoint
 * 2. Poll GET /api/eval/status/:runId until done/timeout
 * 3. Collect results from GET /api/eval/result/:runId
 *
 * If the eval API is not available, falls back to CLI-based execution
 * using `npx crewly agent run` command.
 */
export class CrewlyAgentExecutor extends BaseExecutor {
  readonly runtime: RuntimeType = 'crewly-agent';

  private apiUrl: string;

  private model?: string;
  private provider?: string;

  /**
   * @param apiUrl - Crewly backend API base URL (default: http://localhost:8787)
   * @param model - Model ID override (e.g., 'gemini-2.5-flash')
   * @param provider - Provider override (e.g., 'google')
   */
  constructor(apiUrl?: string, model?: string, provider?: string) {
    super();
    this.apiUrl = apiUrl ?? DEFAULT_CREWLY_URL;
    this.model = model;
    this.provider = provider;
  }

  /**
   * Execute a task using Crewly Agent.
   *
   * Tries the API-based approach first. If the eval endpoint doesn't exist,
   * falls back to CLI execution via `npx crewly agent run`.
   *
   * @param task - The eval task to execute
   * @param options - Work directory, log directory, time limit
   * @returns Structured execution result
   */
  async execute(task: EvalTask, options: ExecutorOptions): Promise<ExecutionResult> {
    const startTime = Date.now();

    // Try API-based execution first
    const apiAvailable = await this.checkApiHealth();
    if (apiAvailable) {
      return this.executeViaApi(task, options, startTime);
    }

    // Fallback: CLI-based execution
    return this.executeViaCli(task, options, startTime);
  }

  /**
   * Check if the Crewly backend eval API is available.
   */
  private async checkApiHealth(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.apiUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Execute via the Crewly backend eval API.
   * Uses the synchronous POST /api/eval/run endpoint which creates a
   * temporary AgentRunnerService, runs the prompt, and returns results.
   */
  private async executeViaApi(
    task: EvalTask,
    options: ExecutorOptions,
    startTime: number
  ): Promise<ExecutionResult> {
    try {
      // Build prompt (same format as other executors)
      const prompt = this.buildPrompt(task);
      const timeLimitMs = options.timeLimitMinutes * 60 * 1000;

      // Synchronous call — blocks until agent completes or times out
      const submitResp = await fetch(`${this.apiUrl}/api/eval/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          workDir: options.workDir,
          maxSteps: 25,
          timeoutMs: timeLimitMs,
          ...(this.model && { model: this.model }),
          ...(this.provider && { provider: this.provider }),
        }),
        signal: AbortSignal.timeout(timeLimitMs + 30_000),
      });

      const data = (await submitResp.json()) as {
        success: boolean;
        text?: string;
        steps?: number;
        usage?: { input: number; output: number };
        toolCalls?: Array<{ toolName: string }>;
        finishReason?: string;
        error?: string;
        timedOut?: boolean;
      };

      const durationSeconds = (Date.now() - startTime) / 1000;
      const toolCallCount = data.toolCalls?.length ?? 0;

      // Estimate cost from token usage
      const inputTokens = data.usage?.input ?? 0;
      const outputTokens = data.usage?.output ?? 0;
      const costUsd =
        (inputTokens / 1000) * COST_PER_1K_INPUT_TOKENS +
        (outputTokens / 1000) * COST_PER_1K_OUTPUT_TOKENS;

      const logContent = [
        `=== Crewly Agent Eval (API): ${task.id} ===`,
        `Duration: ${durationSeconds.toFixed(1)}s`,
        `Success: ${data.success}`,
        `Steps: ${data.steps ?? 0}`,
        `Tool calls: ${toolCallCount}`,
        `Input tokens: ${inputTokens}`,
        `Output tokens: ${outputTokens}`,
        `Cost: $${costUsd.toFixed(4)}`,
        '',
        '=== Agent Output ===',
        data.text ?? '(no output)',
      ].join('\n');

      const logPath = await this.saveLog(options.logDir, task.id, logContent);

      let completionType: ExecutionResult['completionType'];
      if (data.timedOut) {
        completionType = 'timeout';
      } else if (!data.success) {
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
        error: data.error,
      };
    } catch (err) {
      const durationSeconds = (Date.now() - startTime) / 1000;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const logPath = await this.saveLog(options.logDir, task.id, `API Error: ${errorMsg}`);

      return {
        completionType: 'error',
        durationSeconds,
        toolCallCount: 0,
        estimatedCostUsd: 0,
        logPath,
        error: errorMsg,
      };
    }
  }

  /**
   * Build a comprehensive task prompt for Crewly Agent.
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
   * Poll the eval status endpoint until completion or timeout.
   */
  private async pollForCompletion(
    runId: string,
    timeLimitMs: number
  ): Promise<{ status: string; output?: string; toolCalls?: number; costUsd?: number; error?: string }> {
    const deadline = Date.now() + timeLimitMs;

    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`${this.apiUrl}/api/eval/status/${runId}`);
        if (resp.ok) {
          const data = (await resp.json()) as {
            status: string;
            output?: string;
            toolCalls?: number;
            costUsd?: number;
            error?: string;
          };
          if (data.status === 'done' || data.status === 'error') {
            return data;
          }
        }
      } catch {
        // Network error — continue polling
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    return { status: 'timeout' };
  }

  /**
   * Fallback: Execute via Crewly CLI.
   * Uses `npx crewly` or a direct node command to run the agent.
   */
  private async executeViaCli(
    task: EvalTask,
    options: ExecutorOptions,
    startTime: number
  ): Promise<ExecutionResult> {
    const prompt = [
      `# Task: ${task.title}`,
      '',
      task.description,
      '',
      task.filesHint.length > 0 ? `Relevant files: ${task.filesHint.join(', ')}` : '',
      '',
      'Complete this task. Run verification checks before finishing.',
    ].join('\n');

    // Try using claude CLI with crewly project context as fallback
    const timeLimitMs = options.timeLimitMinutes * 60 * 1000;
    const result = await this.spawnWithTimeout(
      'claude',
      ['-p', prompt, '--output-format', 'json', '--max-turns', '50'],
      options.workDir,
      timeLimitMs
    );

    const durationSeconds = (Date.now() - startTime) / 1000;

    const logContent = [
      `=== Crewly Agent Eval (CLI fallback): ${task.id} ===`,
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

    // Parse output for real tool call count and cost (same as ClaudeCodeExecutor)
    const { toolCallCount, costUsd } = this.parseCliOutput(result.stdout);

    return {
      completionType: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'agent_done' : 'error',
      durationSeconds,
      toolCallCount,
      estimatedCostUsd: costUsd,
      logPath,
      error: result.exitCode !== 0 ? `CLI exit code ${result.exitCode}` : undefined,
    };
  }

  /**
   * Parse Claude CLI JSON output to extract tool call count and cost.
   * Falls back to heuristic estimation if JSON parsing fails.
   *
   * @param stdout - Raw stdout from claude CLI
   * @returns Tool call count and estimated cost
   */
  private parseCliOutput(stdout: string): { toolCallCount: number; costUsd: number } {
    try {
      const parsed = JSON.parse(stdout);

      if (parsed.num_turns !== undefined) {
        const inputTokens = parsed.input_tokens ?? 0;
        const outputTokens = parsed.output_tokens ?? 0;
        return {
          toolCallCount: parsed.num_turns ?? 1,
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
