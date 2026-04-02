/**
 * Eval Controller
 *
 * REST API for running evaluation tasks against the Crewly Agent runtime.
 * Provides endpoints for:
 * - Single task execution
 * - Batch evaluation runs
 * - Task listing and discovery
 * - Status and health checks
 *
 * @module controllers/eval/eval.controller
 */

import type { Request, Response } from 'express';
import { AgentRunnerService } from '../../services/agent/crewly-agent/agent-runner.service.js';
import type {
  CrewlyAgentConfig,
  AgentRunResult,
} from '../../services/agent/crewly-agent/types.js';
import {
  ALL_TASKS,
  getTasksByLevel,
  getTaskById,
  getTaskSummary,
  EVAL_VERSION,
  DIMENSION_WEIGHTS,
} from '../../services/agent/crewly-agent/eval/index.js';
import type { EvalLevel } from '../../services/agent/crewly-agent/eval/index.js';

/** Default model for eval runs */
const DEFAULT_MODEL = 'gemini-2.5-pro';
const DEFAULT_PROVIDER = 'google';
const DEFAULT_MAX_STEPS = 15;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * POST /api/eval/run
 *
 * Execute an evaluation task against the Crewly Agent runtime.
 *
 * @param req - Request with body: { prompt, workDir, model?, provider?, maxSteps?, timeoutMs? }
 * @param res - Response with AgentRunResult fields
 */
export async function runEvalTask(req: Request, res: Response): Promise<void> {
  const {
    prompt,
    workDir,
    model = DEFAULT_MODEL,
    provider = DEFAULT_PROVIDER,
    maxSteps = DEFAULT_MAX_STEPS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    systemPrompt,
  } = req.body;

  if (!prompt) {
    res.status(400).json({ success: false, error: 'prompt is required' });
    return;
  }

  if (!workDir) {
    res.status(400).json({ success: false, error: 'workDir is required' });
    return;
  }

  const sessionName = `eval-run-${Date.now()}`;
  const config: CrewlyAgentConfig = {
    model: {
      provider: provider as 'anthropic' | 'openai' | 'google' | 'ollama',
      modelId: model,
    },
    maxSteps,
    sessionName,
    apiBaseUrl: `http://localhost:${process.env.PORT || 8787}`,
    systemPrompt: systemPrompt || 'You are an AI coding agent being evaluated. Complete the given task autonomously. Do not ask questions — just do the work. The working directory is provided in the prompt.',
    maxHistoryMessages: 50,
    compactionThreshold: 0.9,
    projectPath: workDir,
  };

  let runner: AgentRunnerService | null = null;

  try {
    runner = new AgentRunnerService(config);
    await runner.initialize();

    // Run with abort timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

    let result: AgentRunResult;
    try {
      result = await runner.run(prompt, undefined, undefined, {
        abortSignal: abortController.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    res.json({
      success: true,
      text: result.text,
      steps: result.steps,
      usage: result.usage,
      toolCalls: result.toolCalls.map(tc => ({
        toolName: tc.toolName,
        args: tc.args,
        // Truncate large results to avoid huge responses
        result: typeof tc.result === 'string' && tc.result.length > 2000
          ? tc.result.slice(0, 2000) + '...[truncated]'
          : tc.result,
      })),
      finishReason: result.finishReason,
      model,
      provider,
      sessionName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = message.includes('abort') || message.includes('timeout');

    res.status(isTimeout ? 504 : 500).json({
      success: false,
      error: message,
      timedOut: isTimeout,
      model,
      provider,
      sessionName,
    });
  } finally {
    // Cleanup: dispose the runner
    runner = null;
  }
}

/**
 * GET /api/eval/status
 *
 * Health check for the eval API. Returns framework version,
 * available task counts, and scoring dimensions.
 *
 * @param _req - Express request (unused)
 * @param res  - Express response
 */
export function getEvalStatus(_req: Request, res: Response): void {
  const summary = getTaskSummary();
  const totalTasks = ALL_TASKS.length;

  res.json({
    success: true,
    available: true,
    version: EVAL_VERSION,
    defaultModel: DEFAULT_MODEL,
    defaultProvider: DEFAULT_PROVIDER,
    tasks: {
      total: totalTasks,
      byLevel: Object.fromEntries(
        Object.entries(summary).map(([level, data]) => [level, data.count]),
      ),
    },
    dimensions: Object.keys(DIMENSION_WEIGHTS),
  });
}

/**
 * GET /api/eval/tasks
 *
 * List all available evaluation tasks. Supports filtering by level.
 *
 * Query params:
 * - level: 'L1' | 'L2' | 'L3' | 'L4' (optional)
 *
 * @param req - Express request with optional query.level
 * @param res - Express response with task list
 */
export function listTasks(req: Request, res: Response): void {
  const level = req.query.level as string | undefined;

  let tasks = ALL_TASKS;
  if (level && ['L1', 'L2', 'L3', 'L4'].includes(level)) {
    tasks = getTasksByLevel(level as EvalLevel);
  }

  res.json({
    success: true,
    count: tasks.length,
    tasks: tasks.map((t) => ({
      id: t.id,
      level: t.level,
      title: t.title,
      maxSteps: t.maxSteps,
      timeoutMs: t.timeoutMs,
      expectedTools: t.expectedTools,
      tags: t.tags ?? [],
      multiAgent: t.multiAgent ?? false,
    })),
  });
}

/**
 * GET /api/eval/tasks/:taskId
 *
 * Get details of a specific evaluation task.
 *
 * @param req - Express request with params.taskId
 * @param res - Express response with task details
 */
export function getTask(req: Request, res: Response): void {
  const { taskId } = req.params;
  const task = getTaskById(taskId);

  if (!task) {
    res.status(404).json({
      success: false,
      error: `Task "${taskId}" not found`,
      availableTasks: ALL_TASKS.map((t) => t.id),
    });
    return;
  }

  res.json({
    success: true,
    task: {
      id: task.id,
      level: task.level,
      title: task.title,
      prompt: task.prompt,
      maxSteps: task.maxSteps,
      timeoutMs: task.timeoutMs,
      expectedTools: task.expectedTools,
      tags: task.tags ?? [],
      multiAgent: task.multiAgent ?? false,
    },
  });
}

/**
 * GET /api/eval/dimensions
 *
 * Return the scoring dimensions and their weights.
 *
 * @param _req - Express request (unused)
 * @param res  - Express response with dimension info
 */
export function getDimensions(_req: Request, res: Response): void {
  const dimensions = Object.entries(DIMENSION_WEIGHTS).map(([id, weight]) => ({
    id,
    weight,
    description: dimensionDescriptions[id] ?? '',
  }));

  res.json({
    success: true,
    version: EVAL_VERSION,
    dimensions,
    totalWeight: dimensions.reduce((sum, d) => sum + d.weight, 0),
  });
}

/**
 * Human-readable descriptions for each scoring dimension.
 */
const dimensionDescriptions: Record<string, string> = {
  D1_completion: 'Task completion — did the agent finish the task and pass verification checks?',
  D2_codeQuality: 'Code quality — TypeScript type-check, lint, coverage, anti-patterns.',
  D3_toolAccuracy: 'Tool accuracy — correct tool selection, argument accuracy, no unnecessary calls.',
  D4_autonomy: 'Autonomy — completed without human nudges or interventions.',
  D5_collaboration: 'Collaboration — delegation, fault recovery, knowledge sharing (L4 tasks only).',
  D6_stability: 'Stability — no loops, no tool errors, no timeouts.',
  D7_costEfficiency: 'Cost efficiency — token usage and cost relative to baseline.',
};
