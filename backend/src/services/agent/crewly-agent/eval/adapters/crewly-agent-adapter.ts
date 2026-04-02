/**
 * Crewly Agent Adapter for the Evaluation Framework
 *
 * Wraps the {@link AgentRunnerService} to conform to the
 * {@link RuntimeAdapter} interface so that the crewly-agent runtime
 * can be benchmarked by the eval runner.
 *
 * @module crewly-agent-adapter
 */

import { AgentRunnerService } from '../../agent-runner.service.js';
import type { AgentRunResult, CrewlyAgentConfig } from '../../types.js';
import type {
  AdapterConfig,
  EvalTask,
  RuntimeAdapter,
  RuntimeResult,
} from '../eval-types.js';
import { calculateCost } from '../eval-scorer.js';

// ---------------------------------------------------------------------------
// Tool name normalization
// ---------------------------------------------------------------------------

/**
 * Maps Crewly runtime tool names to the canonical names expected by the eval scorer.
 *
 * The eval task definitions use standard names (e.g. `delegate-task`, `send-message`)
 * but the Crewly runtime registers tools under different names. This map bridges
 * the gap so that tool-accuracy scoring works correctly.
 */
export const TOOL_ALIAS_MAP: Readonly<Record<string, string>> = {
  handoff_task: 'handle-failure',
  assign_task: 'delegate-task',
  reply_slack: 'send-message',
  handle_failure: 'handle-failure',
  send_message: 'send-message',
} as const;

/**
 * Normalize a tool name using {@link TOOL_ALIAS_MAP}.
 *
 * If the tool name has a known alias, the canonical name is returned.
 * Otherwise the original name is returned unchanged.
 *
 * @param toolName - raw tool name from the runtime
 * @returns canonical tool name for eval scoring
 */
export function normalizeToolName(toolName: string): string {
  return TOOL_ALIAS_MAP[toolName] ?? toolName;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a model identifier string into a short model name.
 *
 * Strips common provider prefixes (e.g. "anthropic/" or "openai/").
 *
 * @param modelId - raw model identifier from config
 * @returns cleaned model name
 */
function parseModelId(modelId: string): string {
  const slashIdx = modelId.lastIndexOf('/');
  return slashIdx >= 0 ? modelId.slice(slashIdx + 1) : modelId;
}

/**
 * Count tool errors in an agent run result.
 *
 * A tool call is considered an error if its result is an object
 * containing an "error" key.
 *
 * @param runResult - agent run result to inspect
 * @returns number of tool errors
 */
function countToolErrors(runResult: AgentRunResult): number {
  let errors = 0;
  for (const call of runResult.toolCalls) {
    if (
      call.result &&
      typeof call.result === 'object' &&
      'error' in (call.result as Record<string, unknown>)
    ) {
      errors++;
    }
  }
  return errors;
}

/**
 * Build a failed RuntimeResult with the given error message.
 *
 * @param error      - error message
 * @param durationMs - wall-clock time before failure
 * @returns a RuntimeResult indicating failure
 */
function buildErrorResult(error: string, durationMs: number): RuntimeResult {
  return {
    success: false,
    output: '',
    durationMs,
    steps: 0,
    usage: { input: 0, output: 0 },
    toolCalls: [],
    humanNudges: 0,
    error,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * RuntimeAdapter implementation for the crewly-agent runtime.
 *
 * Creates an {@link AgentRunnerService} during initialization and
 * delegates each eval task to it.
 *
 * @example
 * ```typescript
 * const adapter = new CrewlyAgentAdapter();
 * await adapter.initialize({ runtimeId: 'crewly-agent', model: 'claude-opus-4', workDir: '/tmp' });
 * const result = await adapter.runTask(task, '/tmp/task-dir');
 * await adapter.shutdown();
 * ```
 */
export class CrewlyAgentAdapter implements RuntimeAdapter {
  private runner: AgentRunnerService | null = null;
  private config: AdapterConfig | null = null;

  /**
   * Initialize the adapter by creating and setting up an AgentRunnerService.
   *
   * @param config - adapter configuration with model, workDir, etc.
   */
  async initialize(config: AdapterConfig): Promise<void> {
    this.config = config;

    const agentConfig: CrewlyAgentConfig = {
      model: {
        provider: 'anthropic',
        modelId: config.model,
        maxTokens: 16384, // Higher output limit for eval tasks (default 8192 too low)
      },
      maxSteps: 200,
      sessionName: `eval-${config.runtimeId}-${Date.now()}`,
      apiBaseUrl: 'http://localhost:3000',
      systemPrompt: 'You are an AI coding agent being evaluated. Complete the given task.',
      maxHistoryMessages: 100,
      compactionThreshold: 0.8,
      projectPath: config.workDir,
      evalMode: true, // P0: Enable stop hook + P1: Strip delegation instructions
    };

    this.runner = new AgentRunnerService(agentConfig);
    await this.runner.initialize();
  }

  /**
   * Execute a single eval task using the crewly-agent runtime.
   *
   * Maps the {@link AgentRunResult} from the runner into the generic
   * {@link RuntimeResult} expected by the eval framework.
   *
   * @param task    - task definition with prompt and expected tools
   * @param workDir - absolute path to the task's work directory
   * @returns runtime result with timing, tool calls, and cost info
   */
  async runTask(task: EvalTask, workDir: string): Promise<RuntimeResult> {
    if (!this.runner || !this.config) {
      throw new Error('Adapter not initialized. Call initialize() first.');
    }

    const startMs = Date.now();

    try {
      const abortController = new AbortController();
      const timeout = setTimeout(() => {
        abortController.abort();
      }, task.timeoutMs);

      let runResult: AgentRunResult;
      try {
        runResult = await this.runner.run(
          task.prompt,
          undefined,
          undefined,
          { abortSignal: abortController.signal },
        );
      } finally {
        clearTimeout(timeout);
      }

      const durationMs = Date.now() - startMs;
      const modelName = parseModelId(this.config.model);
      const _costUSD = calculateCost(modelName, runResult.usage.input, runResult.usage.output);
      const _toolErrors = countToolErrors(runResult);

      // Normalize tool names so eval scorer matches against canonical names
      const normalizedToolCalls = runResult.toolCalls.map((call) => ({
        ...call,
        toolName: normalizeToolName(call.toolName),
      }));

      return {
        success: true,
        output: runResult.text,
        durationMs,
        steps: runResult.steps,
        usage: { input: runResult.usage.input, output: runResult.usage.output },
        toolCalls: normalizedToolCalls,
        humanNudges: 0,
        loopDetected: runResult.finishReason === 'loop-detected',
        timedOut: false,
      };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = message.includes('abort') || message.includes('timeout');
      return {
        ...buildErrorResult(message, durationMs),
        timedOut,
      };
    }
  }

  /**
   * Shut down the adapter and release resources.
   */
  async shutdown(): Promise<void> {
    this.runner = null;
    this.config = null;
  }
}
