/**
 * Short-lived sub-agents for the in-process runtime (#1317, slice 1).
 *
 * A Claude Code agent can hand a bounded piece of work to a helper that does
 * it and exits. Agents on the in-process runtime (DeepSeek, Gemini API, …)
 * had no such thing: `createTools()` only knows named teammates. This module
 * gives the parent a `spawn_subagent` tool that runs a fresh
 * `AgentRunnerService` loop inside the same process with the task text as
 * its only context, and gives that child a tool set the harness has cut
 * down — no messaging, no delegation, no tickets, no nested spawning — plus
 * `report_to_parent`. The child's result (summary, tool-call count, files
 * changed, stop reason, usage) comes back as the tool result and the child
 * runner is disposed. Nothing persists: no session, no TeamMember, no Slack
 * identity.
 *
 * Scope is enforced here, not in the prompt (the lesson of #852 /
 * specs/2026-10-03-subagent-guard.md): a forbidden tool is absent from the
 * child's tool map, a write outside `cwd` is refused by a wrapper, and a
 * child has no `spawn_subagent` because {@link restrictToolsForSubagent}
 * never copies one.
 */

import { z } from 'zod';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  CREWLY_AGENT_DEFAULTS,
  isModelProvider,
  type AgentRunResult,
  type CrewlyAgentConfig,
  type ModelConfig,
  type SubagentPolicy,
  type ToolDefinition,
} from './types.js';

/** Tools a sub-agent may use in every mode: they read, they do not act. */
export const SUBAGENT_READ_TOOLS: readonly string[] = ['read_file', 'glob', 'grep', 'git_status', 'git_diff', 'web_search'];

/** Tools a sub-agent may use unless it was spawned `readOnly`. */
export const SUBAGENT_WRITE_TOOLS: readonly string[] = ['bash_exec', 'edit_file', 'write_file'];

/** Name of the tool a sub-agent reports with. */
export const REPORT_TOOL_NAME = 'report_to_parent';

/** Name of the tool a parent spawns with. */
export const SPAWN_TOOL_NAME = 'spawn_subagent';

/** Why a sub-agent stopped, as the parent sees it. */
export type SubagentStopReason =
  /** Ran to its natural end and did some work. */
  | 'done'
  /** Finished without a single working tool call — the parent must not read that as success. */
  | 'did_nothing'
  /** Hit its step cap with work outstanding. */
  | 'steps_exhausted'
  /** Hit the wall-clock budget. */
  | 'timeout'
  /** Ended early for another reason (truncated output, provider error…). */
  | 'incomplete'
  /** The runner threw. */
  | 'error';

/** What a sub-agent hands back through `report_to_parent`. */
export interface SubagentReport {
  /** The child's own account of what it found or changed. */
  summary: string;
  /** Files the child says it changed (merged with what its tool calls show). */
  filesChanged: string[];
}

/** The tool result the parent receives. */
export interface SubagentOutcome {
  /** True only when `stoppedReason` is `done`. */
  success: boolean;
  stoppedReason: SubagentStopReason;
  /** The child's report, else its final text (capped). */
  summary: string;
  /** Working tool calls the child made (`report_to_parent` not counted). */
  toolCalls: number;
  /** Distinct tool names used, so the parent can see what kind of work happened. */
  toolNames: string[];
  /** Files written or edited successfully, absolute paths. */
  filesChanged: string[];
  /** Tokens the child spent; also folded into the parent's usage. */
  usage: { input: number; output: number; cachedInput: number };
  /** Model steps the child took. */
  steps: number;
  /** The child's session name, `<parent>/sub-<n>`, for traces and logs. */
  sessionName: string;
  durationMs: number;
  /** Set when `stoppedReason` is `error` or `timeout`. */
  error?: string;
}

/** The arguments of `spawn_subagent`. */
export interface SpawnSubagentInput {
  task: string;
  cwd?: string;
  readOnly?: boolean;
  maxSteps?: number;
  /** `modelId` on the parent's provider, or `provider/modelId`. */
  model?: string;
}

/**
 * The part of `AgentRunnerService` a spawn needs. Injected so the tool can
 * be tested with a scripted runner and so this module does not import the
 * runner (which imports this module).
 */
export interface SubagentRunner {
  initialize(): Promise<void>;
  run(
    message: string,
    conversationId?: string,
    metadata?: Record<string, string>,
    options?: { abortSignal?: AbortSignal },
  ): Promise<AgentRunResult>;
  shutdown(): Promise<void>;
  getSubagentReport(): SubagentReport | null;
}

/** Per-parent bookkeeping: how many children run now, how many ever. */
export interface SubagentRegistry {
  active: number;
  spawned: number;
}

/**
 * A fresh registry for one parent runner.
 *
 * @returns Zeroed counters
 */
export function createSubagentRegistry(): SubagentRegistry {
  return { active: 0, spawned: 0 };
}

/**
 * Whether `target` is `dir` or lies beneath it (after resolving both).
 *
 * @param target - Path to test
 * @param dir - Directory that must contain it
 * @returns True when inside
 */
export function isInsideDir(target: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve a tool's path argument the way the file tools do (`~`, `$HOME`,
 * relative to the working directory), so the containment check sees the
 * same file the tool would touch.
 *
 * @param filePath - As the model passed it
 * @param cwd - The sub-agent's working directory
 * @returns Absolute path
 */
export function resolveSubagentPath(filePath: string, cwd: string): string {
  const home = homedir();
  let p = filePath;
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
  else if (p === '$HOME' || p.startsWith('$HOME/')) p = home + p.slice(5);
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

/**
 * Wrap one allowed tool so it cannot act outside the sub-agent's directory.
 *
 * `edit_file` / `write_file` refuse a path outside `cwd`; `bash_exec` runs in
 * `cwd` (or a directory beneath it) whatever `cwd` the model asked for. Read
 * tools pass through: the issue confines writes, not reads.
 *
 * @param name - Tool name
 * @param tool - The parent's definition of it
 * @param cwd - Containment root
 * @returns The same tool, confined
 */
function confineTool(name: string, tool: ToolDefinition, cwd: string): ToolDefinition {
  if (name === 'edit_file' || name === 'write_file') {
    return {
      ...tool,
      execute: async (args) => {
        const requested = String(args['file_path'] ?? '');
        const abs = resolveSubagentPath(requested, cwd);
        if (!isInsideDir(abs, cwd)) {
          return { success: false, error: `refused: ${requested} is outside the sub-agent working directory ${cwd}` };
        }
        return tool.execute({ ...args, file_path: abs });
      },
    };
  }
  if (name === 'bash_exec') {
    return {
      ...tool,
      execute: async (args) => {
        const requested = typeof args['cwd'] === 'string' && args['cwd'] ? resolveSubagentPath(args['cwd'], cwd) : cwd;
        return tool.execute({ ...args, cwd: isInsideDir(requested, cwd) ? requested : cwd });
      },
    };
  }
  return tool;
}

/**
 * The tool set a sub-agent gets: the allowed subset of the parent's tools,
 * confined to `policy.cwd`, plus `report_to_parent`. Everything else —
 * `send_message`, `reply_slack`, `broadcast`, `delegate_task`,
 * `handoff_task`, `report_status`, `complete_task`, `start_agent`,
 * `stop_agent`, `remember`, approvals, browser and desktop tools, MCP tools
 * and `spawn_subagent` itself — is simply not in the map.
 *
 * @param tools - The full `createTools()` result of the child runner
 * @param policy - The child's policy (cwd, readOnly)
 * @param onReport - Receives the child's `report_to_parent` payload
 * @returns The restricted tool map
 */
export function restrictToolsForSubagent(
  tools: Record<string, ToolDefinition>,
  policy: SubagentPolicy,
  onReport: (report: SubagentReport) => void,
): Record<string, ToolDefinition> {
  const allowed = policy.readOnly ? SUBAGENT_READ_TOOLS : [...SUBAGENT_READ_TOOLS, ...SUBAGENT_WRITE_TOOLS];
  const out: Record<string, ToolDefinition> = {};
  for (const name of allowed) {
    const tool = tools[name];
    if (tool) out[name] = confineTool(name, tool, policy.cwd);
  }
  out[REPORT_TOOL_NAME] = {
    description:
      'Hand your result to the agent that spawned you. Call it once, at the end: what you found or changed, '
      + 'the files you touched, what you could not do and why. The parent sees only this report and your final text.',
    inputSchema: z.object({
      summary: z.string().min(1).describe('Concrete findings or changes, with file paths and line references where they help'),
      filesChanged: z.array(z.string()).optional().describe('Files you created or edited'),
    }),
    sensitivity: 'safe',
    execute: async (args) => {
      onReport({
        summary: String(args['summary'] ?? ''),
        filesChanged: Array.isArray(args['filesChanged']) ? args['filesChanged'].map(String) : [],
      });
      return { success: true, note: 'Reported to the parent. Finish your turn now with one line at most.' };
    },
  };
  return out;
}

/**
 * The system prompt of a sub-agent. Short on purpose: the task text is the
 * context, and the harness rules are appended by the runner.
 *
 * @param parentSession - Who spawned it
 * @param cwd - Where it may write
 * @param readOnly - Whether writes are off
 * @returns Prompt text
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
 * Pick the child's model: the parent's by default, a different id on the
 * parent's provider, or `provider/modelId`.
 *
 * @param parent - Parent model
 * @param requested - The `model` argument, if any
 * @returns The model, or why it was refused
 */
export function resolveSubagentModel(parent: ModelConfig, requested?: string): { model: ModelConfig } | { error: string } {
  if (!requested || !requested.trim()) return { model: parent };
  const spec = requested.trim();
  const slash = spec.indexOf('/');
  if (slash < 0) return { model: { ...parent, modelId: spec } };
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  if (!isModelProvider(provider)) return { error: `unknown model provider "${provider}" in "${spec}"` };
  if (!modelId) return { error: `"${spec}" names no model` };
  return { model: { ...parent, provider, modelId } };
}

/**
 * The child's configuration, derived from the parent's.
 *
 * The child shares the API base URL, history and compaction settings; it
 * gets its own session name (`<parent>/sub-<n>`), its own short prompt, the
 * requested working directory as project path, no MCP servers (one process
 * per server is the parent's cost to bear, not every helper's), no member id
 * and the `subagent` policy that makes the runner restrict its tools.
 *
 * @param parent - Parent config
 * @param input - Spawn arguments
 * @param ordinal - 1-based child number for this parent
 * @returns The config, or why the spawn was refused
 */
export function buildSubagentConfig(
  parent: CrewlyAgentConfig,
  input: SpawnSubagentInput,
  ordinal: number,
): { config: CrewlyAgentConfig } | { error: string } {
  const task = (input.task ?? '').trim();
  if (!task) return { error: 'task is required' };
  if (task.length > CREWLY_AGENT_DEFAULTS.SUBAGENT.TASK_MAX_CHARS) {
    return { error: `task is too long (${task.length} chars; keep it under ${CREWLY_AGENT_DEFAULTS.SUBAGENT.TASK_MAX_CHARS})` };
  }
  const base = parent.projectPath ?? process.cwd();
  const cwd = input.cwd ? resolveSubagentPath(input.cwd, base) : base;
  const picked = resolveSubagentModel(parent.model, input.model);
  if ('error' in picked) return picked;
  const requestedSteps = Number.isFinite(input.maxSteps) && (input.maxSteps as number) > 0
    ? Math.floor(input.maxSteps as number)
    : CREWLY_AGENT_DEFAULTS.SUBAGENT.MAX_STEPS;
  const readOnly = input.readOnly === true;
  const sessionName = `${parent.sessionName}/sub-${ordinal}`;
  return {
    config: {
      model: picked.model,
      maxSteps: Math.min(requestedSteps, CREWLY_AGENT_DEFAULTS.SUBAGENT.MAX_STEPS_CAP),
      sessionName,
      role: 'subagent',
      apiBaseUrl: parent.apiBaseUrl,
      systemPrompt: buildSubagentPrompt(parent.sessionName, cwd, readOnly),
      maxHistoryMessages: parent.maxHistoryMessages,
      compactionThreshold: parent.compactionThreshold,
      projectPath: cwd,
      subagent: { cwd, readOnly, depth: (parent.subagent?.depth ?? 0) + 1, parentSession: parent.sessionName },
    },
  };
}

/**
 * Turn a child's run result into what the parent gets back.
 *
 * `report_to_parent` is not a working call: a child that only reported
 * "did nothing". Files changed are read off successful `edit_file` /
 * `write_file` calls and merged with the report's list, so a child cannot
 * claim a change its tools never made — and cannot hide one either.
 *
 * @param result - The child's run result
 * @param report - What it reported, if it did
 * @param sessionName - The child's session name
 * @param durationMs - Wall-clock time
 * @param timedOut - Whether the parent's timer fired
 * @returns The outcome
 */
export function summarizeSubagentRun(
  result: AgentRunResult,
  report: SubagentReport | null,
  sessionName: string,
  durationMs: number,
  timedOut: boolean,
): SubagentOutcome {
  const work = result.toolCalls.filter((tc) => tc.toolName !== REPORT_TOOL_NAME);
  const changed = new Set<string>();
  for (const tc of work) {
    if (tc.toolName !== 'edit_file' && tc.toolName !== 'write_file') continue;
    const ok = tc.result == null || typeof tc.result !== 'object' || (tc.result as Record<string, unknown>)['success'] !== false;
    const fp = tc.args['file_path'];
    if (ok && typeof fp === 'string' && fp) changed.add(fp);
  }
  for (const fp of report?.filesChanged ?? []) if (fp) changed.add(fp);

  let stoppedReason: SubagentStopReason = 'done';
  if (timedOut) stoppedReason = 'timeout';
  else if (work.length === 0) stoppedReason = 'did_nothing';
  else if (result.incomplete?.reason === 'steps-exhausted') stoppedReason = 'steps_exhausted';
  else if (result.incomplete) stoppedReason = 'incomplete';

  const raw = (report?.summary ?? result.text ?? '').trim();
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
    ...(timedOut ? { error: `sub-agent exceeded ${CREWLY_AGENT_DEFAULTS.SUBAGENT.TIMEOUT_MS} ms` } : {}),
  };
}

/** What the spawn tool needs from its parent runner. */
export interface SpawnSubagentContext {
  /** The parent's config; the child's is derived from it. */
  parentConfig: CrewlyAgentConfig;
  /** Shared counters for this parent. */
  registry: SubagentRegistry;
  /** Builds a child runner from a config (the runner injects `new AgentRunnerService`). */
  createRunner: (config: CrewlyAgentConfig) => SubagentRunner;
  /** Receives the child's usage so the parent's ledger counts it. */
  onUsage?: (usage: { input: number; output: number; cachedInput: number }) => void;
  /** Wall-clock budget per child; defaults to the runtime default. */
  timeoutMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/**
 * An outcome for a spawn that failed before or while running.
 *
 * @param sessionName - Child session name, or the parent's when none was built
 * @param reason - `error` or `timeout`
 * @param error - What went wrong
 * @param durationMs - Time spent
 * @returns The outcome
 */
function failedOutcome(sessionName: string, reason: 'error' | 'timeout', error: string, durationMs: number): SubagentOutcome {
  return {
    success: false,
    stoppedReason: reason,
    summary: '',
    toolCalls: 0,
    toolNames: [],
    filesChanged: [],
    usage: { input: 0, output: 0, cachedInput: 0 },
    steps: 0,
    sessionName,
    durationMs,
    error,
  };
}

/**
 * The parent's `spawn_subagent` tool.
 *
 * Refuses when the parent already has the maximum number of children
 * running. Otherwise builds the child config, runs the child once with the
 * task as its only message under a wall-clock budget, folds its usage into
 * the parent's, and always disposes the child runner — on success, error or
 * timeout.
 *
 * @param ctx - Parent-side dependencies
 * @returns The tool definition
 *
 * @example
 * ```ts
 * tools.spawn_subagent = createSpawnSubagentTool({
 *   parentConfig: this.config,
 *   registry: this.subagentRegistry,
 *   createRunner: (cfg) => new AgentRunnerService(cfg, this.modelManager, this.apiClient),
 *   onUsage: (u) => this.recordChildUsage(u),
 * });
 * ```
 */
export function createSpawnSubagentTool(ctx: SpawnSubagentContext): ToolDefinition {
  const limits = CREWLY_AGENT_DEFAULTS.SUBAGENT;
  const now = ctx.now ?? (() => Date.now());
  const timeoutMs = ctx.timeoutMs ?? limits.TIMEOUT_MS;
  return {
    description:
      'Run a short-lived helper agent on one bounded, self-contained piece of work — parallel research, a large read you want '
      + 'kept out of your own context, a scoped fix — and get its report back as this tool result. The helper starts with only '
      + 'your task text, works in the given directory with file, search and shell tools (no messaging, no delegation, no tickets, '
      + 'no further helpers), and is gone when it returns. Use a teammate instead for anything that needs a named owner, a review, '
      + `or communication. At most ${limits.MAX_CONCURRENT} helpers run at once; each gets up to ${limits.MAX_STEPS} steps `
      + `(cap ${limits.MAX_STEPS_CAP}) and ${Math.round(limits.TIMEOUT_MS / 60000)} minutes. A result with stoppedReason `
      + '"did_nothing" means the helper made no tool call: treat it as a failure, not as an answer.',
    inputSchema: z.object({
      task: z.string().min(1).describe('Everything the helper needs: the goal, the files or area, what "done" looks like, what to report'),
      cwd: z.string().optional().describe('Directory the helper works in and may write under (default: your project path)'),
      readOnly: z.boolean().optional().describe('True for research or review: no shell, no file writes'),
      maxSteps: z.number().int().positive().optional().describe(`Model steps the helper may take (default ${limits.MAX_STEPS}, cap ${limits.MAX_STEPS_CAP})`),
      model: z.string().optional().describe('A cheaper model for simple work: a model id on your provider, or provider/modelId'),
    }),
    sensitivity: 'sensitive',
    execute: async (args): Promise<SubagentOutcome> => {
      const started = now();
      if (ctx.registry.active >= limits.MAX_CONCURRENT) {
        return failedOutcome(
          ctx.parentConfig.sessionName,
          'error',
          `at most ${limits.MAX_CONCURRENT} sub-agents run at once; wait for one to finish`,
          now() - started,
        );
      }
      const built = buildSubagentConfig(ctx.parentConfig, args as unknown as SpawnSubagentInput, ctx.registry.spawned + 1);
      if ('error' in built) return failedOutcome(ctx.parentConfig.sessionName, 'error', built.error, now() - started);
      const { config } = built;
      ctx.registry.spawned += 1;
      ctx.registry.active += 1;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      let runner: SubagentRunner | null = null;
      try {
        runner = ctx.createRunner(config);
        await runner.initialize();
        const result = await runner.run(String(args['task']).trim(), undefined, undefined, { abortSignal: abort.signal });
        ctx.onUsage?.(result.usage);
        return summarizeSubagentRun(result, runner.getSubagentReport(), config.sessionName, now() - started, abort.signal.aborted);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failedOutcome(config.sessionName, abort.signal.aborted ? 'timeout' : 'error', message, now() - started);
      } finally {
        clearTimeout(timer);
        ctx.registry.active -= 1;
        if (runner) await runner.shutdown().catch(() => { /* the child is gone either way */ });
      }
    },
  };
}
