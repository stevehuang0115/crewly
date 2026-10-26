/**
 * Sub-agent runs for agents on any runtime (#1317, slice 2b fallback).
 *
 * The crewly-agent runtime has `spawn_subagent` built in: a parent runner
 * starts a child runner in the same worker with restricted tools. A Claude
 * Code, Codex or Gemini agent runs in a terminal and has no such tool, so
 * this service gives it the same thing over HTTP: `POST /api/subagents`
 * (wrapped by the `spawn-subagent` skill) starts one crewly-agent worker
 * with the sub-agent policy, sends it the task, waits for the one reply and
 * shuts the worker down. The parent gets the same outcome shape the
 * in-process tool returns, so "no tool calls = did nothing" reads the same.
 *
 * Rules, same as the in-process tool:
 * - a child cannot spawn (a `…/sub-N` caller is refused), so depth stays 1;
 * - at most `SUBAGENT.MAX_CONCURRENT` children per parent at once;
 * - a task longer than `SUBAGENT.TASK_MAX_CHARS` is refused — the parent is
 *   pasting context it should summarise;
 * - steps default to `SUBAGENT.MAX_STEPS`, capped at `MAX_STEPS_CAP`;
 * - the worker is always shut down, on success, failure or timeout.
 *
 * The child's token usage is booked under its own session name
 * (`<parent>/sub-<n>`): the parent runs in a terminal and has no ledger
 * row to fold it into.
 *
 * @module services/agent/crewly-agent/subagent-run.service
 */

import { statSync } from 'fs';
import { isAbsolute } from 'path';
import { RUNTIME_TYPES } from '../../../constants.js';
import { LoggerService } from '../../core/logger.service.js';
import { getLocalApiBaseUrl } from '../../../utils/local-api-url.utils.js';
import { getRuntimeFallbackService } from '../../runtime-fallback/runtime-fallback.service.js';
import { RuntimeServiceFactory } from '../runtime-service.factory.js';
import { InProcessLogBuffer } from './in-process-log-buffer.js';
import { registerInProcessRuntime, unregisterInProcessRuntime } from './in-process-runtime-registry.js';
import {
  CREWLY_AGENT_DEFAULTS,
  isModelProvider,
  type AgentRunResult,
  type CrewlyAgentConfig,
  type ModelConfig,
} from './types.js';
import type { CrewlyAgentExternalRuntimeService } from './crewly-agent-external-runtime.service.js';

/** Name of the one tool a child reports through (same as the worker's) */
const REPORT_TOOL_NAME = 'report_to_parent';

/** Session name of a child: `<parent>/sub-<n>` */
const CHILD_SESSION_RE = /\/sub-\d+$/;

/** What the caller asks for */
export interface SubagentRunInput {
  /** The one bounded task, in the parent's words */
  task: string;
  /** Absolute directory the child works in; it may write only under it */
  cwd: string;
  /** No shell and no file writes when true */
  readOnly?: boolean;
  /** Model steps granted; default `SUBAGENT.MAX_STEPS`, capped at `MAX_STEPS_CAP` */
  maxSteps?: number;
  /** `provider/modelId`; default the fallback settings' crewly-agent model */
  model?: string;
}

/** Why a child stopped */
export type SubagentStopReason = 'done' | 'did_nothing' | 'steps_exhausted' | 'incomplete' | 'timeout' | 'error';

/** What the parent gets back — the same shape as the in-process tool's result */
export interface SubagentRunOutcome {
  /** True only when the child did work and stopped on its own */
  success: boolean;
  stoppedReason: SubagentStopReason;
  /** The child's report (or final text), capped at `SUMMARY_MAX_CHARS` */
  summary: string;
  /** Tool calls the child made, not counting its report */
  toolCalls: number;
  /** Distinct tools it used */
  toolNames: string[];
  /** Files it wrote or edited (successful writes plus what it reported) */
  filesChanged: string[];
  usage: { input: number; output: number; cachedInput: number };
  steps: number;
  /** `<parent>/sub-<n>` — also the session its tokens are booked under */
  sessionName: string;
  durationMs: number;
  model: string;
  error?: string;
}

/** Codes a refusal carries, so the skill can say which rule it hit */
export type SubagentRefusalCode =
  | 'parent_required'
  | 'nested'
  | 'task_missing'
  | 'task_too_long'
  | 'cwd_invalid'
  | 'model_invalid'
  | 'too_many';

/** A run that was not started; `code` says which rule refused it */
export class SubagentRunRefused extends Error {
  constructor(readonly code: SubagentRefusalCode, message: string) {
    super(message);
    this.name = 'SubagentRunRefused';
  }
}

/** The part of the runtime this service drives (narrow so tests can fake it) */
export interface SubagentRuntime {
  initializeInProcess(sessionName: string, config: Partial<CrewlyAgentConfig>, roleName?: string): Promise<void>;
  handleMessage(message: string): Promise<AgentRunResult>;
  shutdown(): void;
}

/** Wiring the service takes, all optional outside tests */
export interface SubagentRunServiceDeps {
  /** Builds the worker runtime; defaults to a fresh crewly-agent runtime rooted at `cwd` */
  createRuntime?: (cwd: string) => SubagentRuntime;
  /** Where the child's tokens and the parent's spawn lines are logged */
  logBuffer?: Pick<InProcessLogBuffer, 'append'>;
  /** Wall-clock budget per child; default `SUBAGENT.TIMEOUT_MS` bounded by the IPC deadline */
  timeoutMs?: number;
  /** The model when the caller names none */
  defaultModel?: () => ModelConfig;
  /** Clock, for tests */
  now?: () => number;
  /** Directory check, for tests */
  isDirectory?: (path: string) => boolean;
}

/**
 * The prompt a child runs under — the same words as the worker's own
 * `buildSubagentPrompt`, kept in step by hand.
 *
 * @param parentSession - The agent that spawned it
 * @param cwd - Where it works
 * @param readOnly - Whether it may change files
 * @returns The system prompt
 */
export function buildSubagentPrompt(parentSession: string, cwd: string, readOnly: boolean): string {
  return [
    `You are a short-lived helper spawned by the agent "${parentSession}" for one bounded task.`,
    `Working directory: ${cwd}. ${readOnly ? 'You have read-only tools: look, do not change anything.' : `You may change files only under ${cwd}.`}`,
    'You cannot message anyone, delegate, schedule, or touch tickets; nobody but your parent will read you.',
    `Do the task with your tools, then call ${REPORT_TOOL_NAME} once with what you found or changed, the files you touched, and anything you could not do.`,
    'Report facts you verified, with paths and line numbers; if you did nothing, say so instead of inventing a result.',
  ].join('\n');
}

/**
 * Parse `provider/modelId`, refusing anything else: the default is decided
 * by the service, so an unparseable id must not silently become it.
 *
 * @param spec - The `model` field
 * @returns The model, or why it was refused
 */
export function parseRequestedModel(spec: string): { model: ModelConfig } | { error: string } {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { error: `model must look like provider/modelId, got "${trimmed}"` };
  }
  const provider = trimmed.slice(0, slash);
  const modelId = trimmed.slice(slash + 1);
  if (!isModelProvider(provider)) {
    return { error: `unknown model provider "${provider}"` };
  }
  return {
    model: {
      provider,
      modelId,
      temperature: CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL.temperature,
      maxTokens: CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL.maxTokens,
    },
  };
}

/**
 * The model a child runs when the parent names none: the fallback
 * settings' crewly-agent model (DeepSeek unless the owner changed it),
 * since that is the model the owner has a key for; else the runtime default.
 *
 * @returns The model
 */
export function defaultSubagentModel(): ModelConfig {
  const spec = getRuntimeFallbackService()?.getSettings().crewlyAgentModel;
  if (spec) {
    const parsed = parseRequestedModel(spec);
    if ('model' in parsed) return parsed.model;
  }
  return CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL;
}

/**
 * Turn the child's one run into the outcome the parent reads.
 *
 * @param result - The worker's run result
 * @param sessionName - The child's session
 * @param model - `provider/modelId` it ran on
 * @param durationMs - Wall-clock time
 * @param timedOut - Whether the budget ended the run
 * @returns The outcome
 */
export function summarizeSubagentRun(
  result: AgentRunResult,
  sessionName: string,
  model: string,
  durationMs: number,
  timedOut: boolean,
): SubagentRunOutcome {
  const report = result.toolCalls.find((tc) => tc.toolName === REPORT_TOOL_NAME);
  const work = result.toolCalls.filter((tc) => tc.toolName !== REPORT_TOOL_NAME);
  const changed = new Set<string>();
  for (const tc of work) {
    if (tc.toolName !== 'edit_file' && tc.toolName !== 'write_file') continue;
    const ok = tc.result == null || typeof tc.result !== 'object' || (tc.result as Record<string, unknown>)['success'] !== false;
    const fp = tc.args['file_path'];
    if (ok && typeof fp === 'string' && fp) changed.add(fp);
  }
  const reported = report?.args['filesChanged'];
  if (Array.isArray(reported)) {
    for (const fp of reported) if (typeof fp === 'string' && fp) changed.add(fp);
  }

  let stoppedReason: SubagentStopReason = 'done';
  if (timedOut) stoppedReason = 'timeout';
  else if (work.length === 0) stoppedReason = 'did_nothing';
  else if (result.incomplete?.reason === 'steps-exhausted') stoppedReason = 'steps_exhausted';
  else if (result.incomplete) stoppedReason = 'incomplete';

  const reportedSummary = report?.args['summary'];
  const raw = (typeof reportedSummary === 'string' && reportedSummary.trim() ? reportedSummary : result.text ?? '').trim();
  const cap = CREWLY_AGENT_DEFAULTS.SUBAGENT.SUMMARY_MAX_CHARS;
  const summary = raw.length > cap ? `${raw.slice(0, cap)}\n…[truncated]` : raw;
  return {
    success: stoppedReason === 'done',
    stoppedReason,
    summary,
    toolCalls: work.length,
    toolNames: [...new Set(work.map((tc) => tc.toolName))],
    filesChanged: [...changed],
    usage: result.usage,
    steps: result.steps,
    sessionName,
    durationMs,
    model,
    ...(timedOut ? { error: `sub-agent exceeded ${CREWLY_AGENT_DEFAULTS.SUBAGENT.TIMEOUT_MS} ms` } : {}),
  };
}

/**
 * Runs one bounded helper per call for an agent on any runtime.
 */
export class SubagentRunService {
  private readonly logger = LoggerService.getInstance().createComponentLogger('SubagentRunService');
  private readonly logBuffer: Pick<InProcessLogBuffer, 'append'>;
  private readonly createRuntime: (cwd: string) => SubagentRuntime;
  private readonly timeoutMs: number | undefined;
  private readonly defaultModel: () => ModelConfig;
  private readonly now: () => number;
  private readonly isDirectory: (path: string) => boolean;
  /** Children running per parent */
  private readonly active = new Map<string, number>();
  /** Children ever started per parent, for `sub-<n>` */
  private readonly ordinals = new Map<string, number>();

  constructor(deps: SubagentRunServiceDeps = {}) {
    this.logBuffer = deps.logBuffer ?? InProcessLogBuffer.getInstance();
    this.createRuntime = deps.createRuntime ?? ((cwd) =>
      RuntimeServiceFactory.createFresh(RUNTIME_TYPES.CREWLY_AGENT, undefined, cwd) as unknown as CrewlyAgentExternalRuntimeService);
    this.timeoutMs = deps.timeoutMs;
    this.defaultModel = deps.defaultModel ?? defaultSubagentModel;
    this.now = deps.now ?? Date.now;
    this.isDirectory = deps.isDirectory ?? ((p) => {
      try { return statSync(p).isDirectory(); } catch { return false; }
    });
  }

  /** Children a parent has running now */
  activeCount(parentSession: string): number {
    return this.active.get(parentSession) ?? 0;
  }

  /**
   * Start one child for `parentSession`, wait for its one reply, shut it down.
   *
   * @param parentSession - The calling agent's session name
   * @param input - The task and its bounds
   * @returns The outcome; a run that could not even start resolves with
   *   `stoppedReason: 'error'`
   * @throws SubagentRunRefused when a rule refuses the request before a worker starts
   */
  async run(parentSession: string | undefined, input: SubagentRunInput): Promise<SubagentRunOutcome> {
    const parent = (parentSession ?? '').trim();
    if (!parent) throw new SubagentRunRefused('parent_required', 'Only an agent session can spawn a sub-agent (X-Agent-Session missing).');
    if (CHILD_SESSION_RE.test(parent)) throw new SubagentRunRefused('nested', 'A sub-agent cannot spawn sub-agents.');

    const task = typeof input.task === 'string' ? input.task.trim() : '';
    if (!task) throw new SubagentRunRefused('task_missing', 'task is required.');
    if (task.length > CREWLY_AGENT_DEFAULTS.SUBAGENT.TASK_MAX_CHARS) {
      throw new SubagentRunRefused('task_too_long', `task is ${task.length} chars; the limit is ${CREWLY_AGENT_DEFAULTS.SUBAGENT.TASK_MAX_CHARS}. Summarise the context instead of pasting it.`);
    }

    const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
    if (!cwd || !isAbsolute(cwd) || !this.isDirectory(cwd)) {
      throw new SubagentRunRefused('cwd_invalid', `cwd must be an existing absolute directory, got "${cwd}".`);
    }

    let model: ModelConfig;
    if (typeof input.model === 'string' && input.model.trim()) {
      const parsed = parseRequestedModel(input.model);
      if ('error' in parsed) throw new SubagentRunRefused('model_invalid', parsed.error);
      model = parsed.model;
    } else {
      model = this.defaultModel();
    }

    const limit = CREWLY_AGENT_DEFAULTS.SUBAGENT.MAX_CONCURRENT;
    if (this.activeCount(parent) >= limit) {
      throw new SubagentRunRefused('too_many', `${parent} already has ${limit} sub-agents running; wait for one to finish.`);
    }

    const readOnly = input.readOnly === true;
    const requestedSteps = Number.isFinite(input.maxSteps) && (input.maxSteps as number) >= 1
      ? Math.floor(input.maxSteps as number)
      : CREWLY_AGENT_DEFAULTS.SUBAGENT.MAX_STEPS;
    const maxSteps = Math.min(requestedSteps, CREWLY_AGENT_DEFAULTS.SUBAGENT.MAX_STEPS_CAP);

    const ordinal = (this.ordinals.get(parent) ?? 0) + 1;
    this.ordinals.set(parent, ordinal);
    const childSession = `${parent}/sub-${ordinal}`;
    const modelString = `${model.provider}/${model.modelId}`;

    const config: Partial<CrewlyAgentConfig> = {
      model,
      maxSteps,
      sessionName: childSession,
      role: 'subagent',
      apiBaseUrl: getLocalApiBaseUrl(),
      systemPrompt: buildSubagentPrompt(parent, cwd, readOnly),
      maxHistoryMessages: CREWLY_AGENT_DEFAULTS.MAX_HISTORY_MESSAGES,
      compactionThreshold: CREWLY_AGENT_DEFAULTS.COMPACTION_THRESHOLD,
      projectPath: cwd,
      subagent: { cwd, readOnly, depth: 1, parentSession: parent },
    };

    // Stop before the runtime's own IPC deadline: that path recycles the
    // worker (respawns it), which would leave a fresh child alive after
    // this run shut the old one down.
    const ipcDeadline =
      (CREWLY_AGENT_DEFAULTS.MODEL_TIMEOUT_MS[model.modelId] ?? CREWLY_AGENT_DEFAULTS.MESSAGE_TIMEOUT_MS)
      + CREWLY_AGENT_DEFAULTS.IPC_RUN_TIMEOUT_GRACE_MS;
    const timeoutMs = this.timeoutMs ?? Math.max(1_000, Math.min(CREWLY_AGENT_DEFAULTS.SUBAGENT.TIMEOUT_MS, ipcDeadline - 5_000));

    this.active.set(parent, this.activeCount(parent) + 1);
    const started = this.now();
    const preview = task.length > 120 ? `${task.slice(0, 120)}…` : task;
    this.logBuffer.append(parent, 'info', `spawn-subagent → ${childSession} (${modelString}, ${maxSteps} steps${readOnly ? ', read-only' : ''}): ${preview}`);
    this.logger.info('Sub-agent starting', { parent, childSession, model: modelString, maxSteps, readOnly, cwd });

    let runtime: SubagentRuntime | null = null;
    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;
    let outcome: SubagentRunOutcome;
    try {
      const worker = this.createRuntime(cwd);
      runtime = worker;
      registerInProcessRuntime(childSession, worker as CrewlyAgentExternalRuntimeService);
      await worker.initializeInProcess(childSession, config, 'subagent');
      const result = await new Promise<AgentRunResult>((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`sub-agent exceeded ${timeoutMs} ms`));
        }, timeoutMs);
        worker.handleMessage(task).then(resolve, reject);
      });
      outcome = summarizeSubagentRun(result, childSession, modelString, this.now() - started, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = {
        success: false,
        stoppedReason: timedOut ? 'timeout' : 'error',
        summary: '',
        toolCalls: 0,
        toolNames: [],
        filesChanged: [],
        usage: { input: 0, output: 0, cachedInput: 0 },
        steps: 0,
        sessionName: childSession,
        durationMs: this.now() - started,
        model: modelString,
        error: message,
      };
    } finally {
      if (timer) clearTimeout(timer);
      this.active.set(parent, Math.max(0, this.activeCount(parent) - 1));
      if (runtime) {
        try { runtime.shutdown(); } catch { /* the worker is gone either way */ }
      }
      unregisterInProcessRuntime(childSession);
    }

    const tail = outcome.error ? `: ${outcome.error}` : '';
    this.logBuffer.append(parent, outcome.success ? 'info' : 'warn',
      `spawn-subagent ← ${childSession} ${outcome.stoppedReason} (${outcome.toolCalls} tool calls, ${outcome.filesChanged.length} files, ${Math.round(outcome.durationMs / 1000)} s)${tail}`);
    this.logger.info('Sub-agent finished', { parent, childSession, stoppedReason: outcome.stoppedReason, toolCalls: outcome.toolCalls, durationMs: outcome.durationMs });
    return outcome;
  }
}

/** Process-wide instance, created on first use */
let instance: SubagentRunService | null = null;

/**
 * The shared service.
 *
 * @returns The instance
 */
export function getSubagentRunService(): SubagentRunService {
  if (!instance) instance = new SubagentRunService();
  return instance;
}

/**
 * Replace the shared instance (tests).
 *
 * @param service - The instance to use, or null to reset
 */
export function setSubagentRunServiceForTesting(service: SubagentRunService | null): void {
  instance = service;
}
