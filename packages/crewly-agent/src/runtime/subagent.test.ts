// Short-lived sub-agents (#1317): tool restriction, config derivation, spawn tool.
import { describe, it, expect, vi, type Mocked } from 'vitest';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  SUBAGENT_READ_TOOLS,
  SUBAGENT_WRITE_TOOLS,
  REPORT_TOOL_NAME,
  SPAWN_TOOL_NAME,
  buildSubagentConfig,
  buildSubagentPrompt,
  createSpawnSubagentTool,
  createSubagentRegistry,
  forwardChildToolCalls,
  isInsideDir,
  resolveSubagentModel,
  resolveSubagentPath,
  restrictToolsForSubagent,
  summarizeSubagentRun,
  type SubagentReport,
  type SubagentRunner,
} from './subagent.js';
import { createTools, getToolNames, TOOL_SENSITIVITY } from './tool-registry.js';
import { CrewlyApiClient } from './api-client.js';
import { CREWLY_AGENT_DEFAULTS, WRITE_TOOLS, type AgentRunResult, type CrewlyAgentConfig, type ToolDefinition } from './types.js';

const CWD = '/work/project';

const parentConfig: CrewlyAgentConfig = {
  model: { provider: 'deepseek', modelId: 'deepseek-chat', temperature: 0.2, maxTokens: 4096 },
  maxSteps: 500,
  sessionName: 'think-tank-kai',
  apiBaseUrl: 'http://localhost:8787',
  systemPrompt: 'You are Kai, the team lead.',
  maxHistoryMessages: 40,
  compactionThreshold: 0.8,
  projectPath: CWD,
  memberId: 'member-1',
  mcpServers: { playwright: { command: 'npx', args: ['playwright-mcp'] } },
};

/** A run result with the given tool calls and no incompleteness. */
function runResult(partial: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    text: 'final text',
    steps: 3,
    usage: { input: 100, output: 20, cachedInput: 5 },
    toolCalls: [],
    finishReason: 'stop',
    ...partial,
  };
}

/** A scripted child runner. */
function fakeRunner(opts: {
  result?: AgentRunResult | (() => Promise<AgentRunResult>);
  report?: SubagentReport | null;
  throwOn?: 'initialize' | 'run';
}): SubagentRunner & { shutdown: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (_m: string, _c?: string, _md?: Record<string, string>, _o?: { abortSignal?: AbortSignal }) => {
    if (opts.throwOn === 'run') throw new Error('provider exploded');
    return typeof opts.result === 'function' ? opts.result() : (opts.result ?? runResult());
  });
  return {
    initialize: vi.fn(async () => {
      if (opts.throwOn === 'initialize') throw new Error('no api key');
    }),
    run,
    shutdown: vi.fn(async () => undefined),
    getSubagentReport: () => opts.report ?? null,
  };
}

describe('subagent', () => {
  describe('isInsideDir / resolveSubagentPath', () => {
    it('accepts the directory itself and anything beneath it', () => {
      expect(isInsideDir(CWD, CWD)).toBe(true);
      expect(isInsideDir(`${CWD}/src/a.ts`, CWD)).toBe(true);
      expect(isInsideDir(`${CWD}/src/../src/b.ts`, CWD)).toBe(true);
    });

    it('rejects siblings, parents and look-alike prefixes', () => {
      expect(isInsideDir('/work/project2/a.ts', CWD)).toBe(false);
      expect(isInsideDir('/work', CWD)).toBe(false);
      expect(isInsideDir(`${CWD}/../other/x`, CWD)).toBe(false);
      expect(isInsideDir('/etc/passwd', CWD)).toBe(false);
    });

    it('resolves relative paths against cwd and expands ~ and $HOME like the file tools', () => {
      expect(resolveSubagentPath('src/a.ts', CWD)).toBe(`${CWD}/src/a.ts`);
      expect(resolveSubagentPath('/abs/x', CWD)).toBe('/abs/x');
      expect(resolveSubagentPath('~/notes.md', CWD)).toBe(path.join(homedir(), 'notes.md'));
      expect(resolveSubagentPath('$HOME/notes.md', CWD)).toBe(path.join(homedir(), 'notes.md'));
    });
  });

  describe('restrictToolsForSubagent', () => {
    let mockClient: Mocked<CrewlyApiClient>;
    let full: Record<string, ToolDefinition>;

    const policy = { cwd: CWD, readOnly: false, depth: 1, parentSession: 'think-tank-kai' };

    function freshTools(): Record<string, ToolDefinition> {
      mockClient = {
        get: vi.fn<any>().mockResolvedValue({ success: false, data: null, status: 404 }),
        post: vi.fn<any>(),
        delete: vi.fn<any>(),
      } as any;
      return createTools(mockClient, 'think-tank-kai/sub-1', CWD);
    }

    it('keeps only file, search and shell tools plus report_to_parent', () => {
      full = freshTools();
      const restricted = restrictToolsForSubagent(full, policy, () => undefined);
      const names = Object.keys(restricted).sort();
      const expected = [...SUBAGENT_READ_TOOLS, ...SUBAGENT_WRITE_TOOLS, REPORT_TOOL_NAME].filter((n) => n === REPORT_TOOL_NAME || full[n]).sort();
      expect(names).toEqual(expected);
      expect(names).toContain('read_file');
      expect(names).toContain('grep');
      expect(names).toContain('bash_exec');
      expect(names).toContain('edit_file');
    });

    it('has none of the communication, delegation, lifecycle, memory or ticket tools', () => {
      full = freshTools();
      const restricted = restrictToolsForSubagent(full, policy, () => undefined);
      for (const forbidden of [
        'send_message', 'reply_slack', 'broadcast', 'delegate_task', 'handoff_task', 'report_status', 'complete_task',
        'get_tasks', 'start_agent', 'stop_agent', 'handle_agent_failure', 'remember', 'recall_memory', 'schedule_check',
        'register_self', 'subscribe_event', 'get_audit_log', 'compact_memory', 'computer', 'desktop_task', 'git_commit',
        SPAWN_TOOL_NAME,
      ]) {
        expect(restricted[forbidden], forbidden).toBeUndefined();
      }
    });

    it('never passes through a spawn_subagent or MCP tool present in the input map', () => {
      full = freshTools();
      const withExtras: Record<string, ToolDefinition> = {
        ...full,
        [SPAWN_TOOL_NAME]: { description: 'x', inputSchema: {} as any, execute: async () => ({}) },
        'playwright:click': { description: 'x', inputSchema: {} as any, execute: async () => ({}) },
      };
      const restricted = restrictToolsForSubagent(withExtras, policy, () => undefined);
      expect(restricted[SPAWN_TOOL_NAME]).toBeUndefined();
      expect(restricted['playwright:click']).toBeUndefined();
    });

    it('readOnly drops the shell and the write tools', () => {
      full = freshTools();
      const restricted = restrictToolsForSubagent(full, { ...policy, readOnly: true }, () => undefined);
      const names = Object.keys(restricted);
      for (const w of SUBAGENT_WRITE_TOOLS) expect(names).not.toContain(w);
      for (const w of WRITE_TOOLS) expect(names).not.toContain(w);
      expect(names).toContain('read_file');
      expect(names).toContain(REPORT_TOOL_NAME);
    });

    it('refuses edit_file and write_file outside cwd and resolves relative paths inside it', async () => {
      const inner = vi.fn(async () => ({ success: true }));
      const tools: Record<string, ToolDefinition> = {
        edit_file: { description: 'e', inputSchema: {} as any, execute: inner },
        write_file: { description: 'w', inputSchema: {} as any, execute: inner },
      };
      const restricted = restrictToolsForSubagent(tools, policy, () => undefined);

      const outside = await restricted.edit_file.execute({ file_path: '/etc/hosts', old_string: 'a', new_string: 'b' }) as Record<string, unknown>;
      expect(outside.success).toBe(false);
      expect(String(outside.error)).toMatch(/outside the sub-agent working directory/);
      const climb = await restricted.write_file.execute({ file_path: '../sibling/x.ts', content: '' }) as Record<string, unknown>;
      expect(climb.success).toBe(false);
      const home = await restricted.write_file.execute({ file_path: '~/x.ts', content: '' }) as Record<string, unknown>;
      expect(home.success).toBe(false);
      expect(inner).not.toHaveBeenCalled();

      await restricted.edit_file.execute({ file_path: 'src/a.ts', old_string: 'a', new_string: 'b' });
      expect(inner).toHaveBeenCalledWith(expect.objectContaining({ file_path: `${CWD}/src/a.ts` }));
    });

    it('forces bash_exec into cwd when the model asks for a directory outside it', async () => {
      const inner = vi.fn(async () => ({ success: true, stdout: '' }));
      const tools: Record<string, ToolDefinition> = {
        bash_exec: { description: 'b', inputSchema: {} as any, execute: inner },
      };
      const restricted = restrictToolsForSubagent(tools, policy, () => undefined);
      await restricted.bash_exec.execute({ command: 'ls' });
      expect(inner).toHaveBeenLastCalledWith({ command: 'ls', cwd: CWD });
      await restricted.bash_exec.execute({ command: 'ls', cwd: '/' });
      expect(inner).toHaveBeenLastCalledWith({ command: 'ls', cwd: CWD });
      await restricted.bash_exec.execute({ command: 'ls', cwd: 'packages' });
      expect(inner).toHaveBeenLastCalledWith({ command: 'ls', cwd: `${CWD}/packages` });
    });

    it('report_to_parent records the report and tells the child to stop', async () => {
      const reports: SubagentReport[] = [];
      const restricted = restrictToolsForSubagent({}, policy, (r) => reports.push(r));
      const out = await restricted[REPORT_TOOL_NAME].execute({ summary: 'found 3 call sites', filesChanged: ['a.ts'] }) as Record<string, unknown>;
      expect(out.success).toBe(true);
      expect(String(out.note)).toMatch(/finish your turn/i);
      expect(reports).toEqual([{ summary: 'found 3 call sites', filesChanged: ['a.ts'] }]);
      expect(TOOL_SENSITIVITY[REPORT_TOOL_NAME]).toBe('safe');
      expect(TOOL_SENSITIVITY[SPAWN_TOOL_NAME]).toBe('sensitive');
      // Neither is a registry tool: the runner adds them per run.
      expect(getToolNames()).not.toContain(SPAWN_TOOL_NAME);
    });
  });

  describe('resolveSubagentModel', () => {
    const parent = parentConfig.model;

    it('keeps the parent model when none is asked for', () => {
      expect(resolveSubagentModel(parent)).toEqual({ model: parent });
      expect(resolveSubagentModel(parent, '  ')).toEqual({ model: parent });
    });

    it('swaps the model id on the same provider, or takes provider/modelId', () => {
      expect(resolveSubagentModel(parent, 'deepseek-reasoner')).toEqual({ model: { ...parent, modelId: 'deepseek-reasoner' } });
      expect(resolveSubagentModel(parent, 'google/gemini-3-flash-preview')).toEqual({
        model: { ...parent, provider: 'google', modelId: 'gemini-3-flash-preview' },
      });
    });

    it('refuses an unknown provider or an empty model id', () => {
      expect(resolveSubagentModel(parent, 'acme/foo')).toEqual({ error: expect.stringMatching(/unknown model provider "acme"/) });
      expect(resolveSubagentModel(parent, 'openai/')).toEqual({ error: expect.stringMatching(/names no model/) });
    });
  });

  describe('buildSubagentConfig', () => {
    it('derives a child config: own session name, short prompt, cwd as project path, policy, no MCP or member id', () => {
      const built = buildSubagentConfig(parentConfig, { task: 'Find every caller of foo()' }, 2);
      expect('config' in built).toBe(true);
      const cfg = (built as { config: CrewlyAgentConfig }).config;
      expect(cfg.sessionName).toBe('think-tank-kai/sub-2');
      expect(cfg.role).toBe('subagent');
      expect(cfg.model).toEqual(parentConfig.model);
      expect(cfg.maxSteps).toBe(CREWLY_AGENT_DEFAULTS.SUBAGENT.MAX_STEPS);
      expect(cfg.projectPath).toBe(CWD);
      expect(cfg.apiBaseUrl).toBe(parentConfig.apiBaseUrl);
      expect(cfg.systemPrompt).toBe(buildSubagentPrompt('think-tank-kai', CWD, false));
      expect(cfg.systemPrompt).not.toContain('You are Kai');
      expect(cfg.subagent).toEqual({ cwd: CWD, readOnly: false, depth: 1, parentSession: 'think-tank-kai' });
      expect(cfg.mcpServers).toBeUndefined();
      expect(cfg.memberId).toBeUndefined();
      expect(cfg.evalMode).toBeUndefined();
    });

    it('caps maxSteps, resolves cwd under the project, and honours readOnly', () => {
      const built = buildSubagentConfig(parentConfig, { task: 'x', maxSteps: 999, cwd: 'packages/ui', readOnly: true }, 1);
      const cfg = (built as { config: CrewlyAgentConfig }).config;
      expect(cfg.maxSteps).toBe(CREWLY_AGENT_DEFAULTS.SUBAGENT.MAX_STEPS_CAP);
      expect(cfg.projectPath).toBe(`${CWD}/packages/ui`);
      expect(cfg.subagent?.readOnly).toBe(true);
      expect(cfg.systemPrompt).toMatch(/read-only tools/);
      const small = buildSubagentConfig(parentConfig, { task: 'x', maxSteps: 5 }, 1);
      expect((small as { config: CrewlyAgentConfig }).config.maxSteps).toBe(5);
    });

    it('refuses an empty or oversized task and a bad model', () => {
      expect(buildSubagentConfig(parentConfig, { task: '   ' }, 1)).toEqual({ error: 'task is required' });
      const huge = 'x'.repeat(CREWLY_AGENT_DEFAULTS.SUBAGENT.TASK_MAX_CHARS + 1);
      expect(buildSubagentConfig(parentConfig, { task: huge }, 1)).toEqual({ error: expect.stringMatching(/too long/) });
      expect(buildSubagentConfig(parentConfig, { task: 'x', model: 'nope/m' }, 1)).toEqual({ error: expect.stringMatching(/unknown model provider/) });
    });

    it('a child of a child would be depth 2 — but a child never gets the spawn tool, so this stays theoretical', () => {
      const child = (buildSubagentConfig(parentConfig, { task: 'x' }, 1) as { config: CrewlyAgentConfig }).config;
      const grandchild = (buildSubagentConfig(child, { task: 'y' }, 1) as { config: CrewlyAgentConfig }).config;
      expect(grandchild.subagent?.depth).toBe(2);
      expect(grandchild.sessionName).toBe('think-tank-kai/sub-1/sub-1');
    });
  });

  describe('summarizeSubagentRun', () => {
    it('zero working tool calls is did_nothing, even when the child reported', () => {
      const out = summarizeSubagentRun(
        runResult({ toolCalls: [{ toolName: REPORT_TOOL_NAME, args: { summary: 'all good' }, result: { success: true } }] }),
        { summary: 'all good', filesChanged: [] },
        's/sub-1',
        10,
        false,
      );
      expect(out.stoppedReason).toBe('did_nothing');
      expect(out.success).toBe(false);
      expect(out.toolCalls).toBe(0);
      expect(out.summary).toBe('all good');
    });

    it('done: counts working calls, lists tool names, collects files from successful writes and the report', () => {
      const out = summarizeSubagentRun(
        runResult({
          toolCalls: [
            { toolName: 'grep', args: { pattern: 'foo' }, result: { success: true } },
            { toolName: 'edit_file', args: { file_path: `${CWD}/a.ts` }, result: { success: true } },
            { toolName: 'edit_file', args: { file_path: `${CWD}/b.ts` }, result: { success: false, error: 'not unique' } },
            { toolName: 'write_file', args: { file_path: `${CWD}/c.ts` }, result: { success: true } },
            { toolName: REPORT_TOOL_NAME, args: { summary: 'r' }, result: { success: true } },
          ],
        }),
        { summary: 'changed a and c', filesChanged: [`${CWD}/d.md`] },
        's/sub-1',
        1234,
        false,
      );
      expect(out.stoppedReason).toBe('done');
      expect(out.success).toBe(true);
      expect(out.toolCalls).toBe(4);
      expect(out.toolNames).toEqual(['grep', 'edit_file', 'write_file']);
      expect(out.filesChanged).toEqual([`${CWD}/a.ts`, `${CWD}/c.ts`, `${CWD}/d.md`]);
      expect(out.usage).toEqual({ input: 100, output: 20, cachedInput: 5 });
      expect(out.durationMs).toBe(1234);
      expect(out.sessionName).toBe('s/sub-1');
    });

    it('maps incompleteness and timeouts, and falls back to the final text without a report', () => {
      const calls = [{ toolName: 'read_file', args: { file_path: 'x' }, result: { success: true } }];
      expect(summarizeSubagentRun(runResult({ toolCalls: calls, incomplete: { reason: 'steps-exhausted', detail: '', finishReason: 'tool-calls', recoveryAttempts: 0 } }), null, 's', 1, false).stoppedReason).toBe('steps_exhausted');
      expect(summarizeSubagentRun(runResult({ toolCalls: calls, incomplete: { reason: 'truncated', detail: '', finishReason: 'length', recoveryAttempts: 3 } }), null, 's', 1, false).stoppedReason).toBe('incomplete');
      const timed = summarizeSubagentRun(runResult({ toolCalls: calls }), null, 's', 1, true);
      expect(timed.stoppedReason).toBe('timeout');
      expect(timed.error).toMatch(/exceeded/);
      expect(summarizeSubagentRun(runResult({ toolCalls: calls, text: '  the answer  ' }), null, 's', 1, false).summary).toBe('the answer');
    });

    it('caps a long summary', () => {
      const long = 'y'.repeat(CREWLY_AGENT_DEFAULTS.SUBAGENT.SUMMARY_MAX_CHARS + 50);
      const out = summarizeSubagentRun(runResult({ toolCalls: [{ toolName: 'grep', args: {}, result: {} }] }), { summary: long, filesChanged: [] }, 's', 1, false);
      expect(out.summary.length).toBeLessThan(long.length);
      expect(out.summary).toMatch(/\[truncated\]$/);
    });
  });

  describe('forwardChildToolCalls', () => {
    it('relays tool start/finish to the parent with a sub-n prefix and forwards nothing else', () => {
      const parent = { onToolCallStart: vi.fn(), onToolCallFinish: vi.fn(), onTextChunk: vi.fn(), onStepFinish: vi.fn() };
      const cb = forwardChildToolCalls(() => parent, 'think-tank-kai/sub-2');
      cb.onToolCallStart!('grep', { pattern: 'x' });
      cb.onToolCallFinish!('grep', { pattern: 'x' }, { success: true }, 12);
      expect(parent.onToolCallStart).toHaveBeenCalledWith('sub-2:grep', { pattern: 'x' });
      expect(parent.onToolCallFinish).toHaveBeenCalledWith('sub-2:grep', { pattern: 'x' }, { success: true }, 12);
      expect(cb.onTextChunk).toBeUndefined();
      expect(cb.onStepFinish).toBeUndefined();
    });

    it('reads the parent callbacks on every call, so a parent with none set is fine', () => {
      let parent: Record<string, unknown> = {};
      const cb = forwardChildToolCalls(() => parent, 'p/sub-1');
      expect(() => cb.onToolCallStart!('read_file', {})).not.toThrow();
      const start = vi.fn();
      parent = { onToolCallStart: start };
      cb.onToolCallStart!('read_file', { file_path: 'a' });
      expect(start).toHaveBeenCalledWith('sub-1:read_file', { file_path: 'a' });
    });
  });

  describe('createSpawnSubagentTool', () => {
    it('runs a child with the task as its only message, returns its outcome, counts usage and disposes it', async () => {
      const registry = createSubagentRegistry();
      const child = fakeRunner({
        result: runResult({ toolCalls: [{ toolName: 'grep', args: { pattern: 'x' }, result: { success: true } }] }),
        report: { summary: 'two call sites: a.ts:10, b.ts:42', filesChanged: [] },
      });
      const createRunner = vi.fn(() => child);
      const onUsage = vi.fn();
      const tool = createSpawnSubagentTool({
        parentConfig,
        registry,
        createRunner,
        onUsage,
        childStreaming: (sessionName) => ({ relay: sessionName }) as unknown as import('./types.js').StreamingEventCallbacks,
      });

      const out = await tool.execute({ task: '  Find callers of foo()  ', readOnly: true }) as Record<string, unknown>;

      expect(createRunner).toHaveBeenCalledTimes(1);
      const cfg = createRunner.mock.calls[0]![0] as unknown as CrewlyAgentConfig;
      expect(cfg.sessionName).toBe('think-tank-kai/sub-1');
      expect(cfg.subagent).toEqual({ cwd: CWD, readOnly: true, depth: 1, parentSession: 'think-tank-kai' });
      expect(child.initialize).toHaveBeenCalledTimes(1);
      expect(child.run).toHaveBeenCalledTimes(1);
      expect(child.run.mock.calls[0]![0]).toBe('Find callers of foo()');
      expect(child.run.mock.calls[0]![3]?.abortSignal).toBeInstanceOf(AbortSignal);
      expect((child.run.mock.calls[0]![3] as { streaming?: unknown })?.streaming).toEqual({ relay: 'think-tank-kai/sub-1' });
      expect(out.success).toBe(true);
      expect(out.stoppedReason).toBe('done');
      expect(out.summary).toBe('two call sites: a.ts:10, b.ts:42');
      expect(out.sessionName).toBe('think-tank-kai/sub-1');
      expect(onUsage).toHaveBeenCalledWith({ input: 100, output: 20, cachedInput: 5 });
      expect(child.shutdown).toHaveBeenCalledTimes(1);
      expect(registry).toEqual({ active: 0, spawned: 1 });
    });

    it('a child that made no tool call comes back as did_nothing, not success', async () => {
      const tool = createSpawnSubagentTool({
        parentConfig,
        registry: createSubagentRegistry(),
        createRunner: () => fakeRunner({ result: runResult({ toolCalls: [], text: 'I would look at the files.' }) }),
      });
      const out = await tool.execute({ task: 'look' }) as Record<string, unknown>;
      expect(out.success).toBe(false);
      expect(out.stoppedReason).toBe('did_nothing');
      expect(out.summary).toBe('I would look at the files.');
    });

    it('numbers children in spawn order and refuses a fourth concurrent child', async () => {
      const registry = createSubagentRegistry();
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const slow = () => fakeRunner({
        result: async () => { await gate; return runResult({ toolCalls: [{ toolName: 'grep', args: {}, result: {} }] }); },
      });
      const createRunner = vi.fn(slow);
      const tool = createSpawnSubagentTool({ parentConfig, registry, createRunner });

      const running = [tool.execute({ task: 'a' }), tool.execute({ task: 'b' }), tool.execute({ task: 'c' })];
      await Promise.resolve();
      expect(registry.active).toBe(CREWLY_AGENT_DEFAULTS.SUBAGENT.MAX_CONCURRENT);
      const refused = await tool.execute({ task: 'd' }) as Record<string, unknown>;
      expect(refused.success).toBe(false);
      expect(refused.stoppedReason).toBe('error');
      expect(String(refused.error)).toMatch(/at most 3 sub-agents/);
      expect(createRunner).toHaveBeenCalledTimes(3);

      release();
      const done = await Promise.all(running) as Array<Record<string, unknown>>;
      expect(done.map((d) => d.sessionName)).toEqual(['think-tank-kai/sub-1', 'think-tank-kai/sub-2', 'think-tank-kai/sub-3']);
      expect(registry).toEqual({ active: 0, spawned: 3 });

      // A slot is free again.
      const fifth = await createSpawnSubagentTool({ parentConfig, registry, createRunner: () => fakeRunner({ result: runResult({ toolCalls: [{ toolName: 'grep', args: {}, result: {} }] }) }) })
        .execute({ task: 'e' }) as Record<string, unknown>;
      expect(fifth.sessionName).toBe('think-tank-kai/sub-4');
    });

    it('a runner that throws yields error, still disposes the child and frees the slot', async () => {
      const registry = createSubagentRegistry();
      const child = fakeRunner({ throwOn: 'run' });
      const tool = createSpawnSubagentTool({ parentConfig, registry, createRunner: () => child });
      const out = await tool.execute({ task: 'boom' }) as Record<string, unknown>;
      expect(out.success).toBe(false);
      expect(out.stoppedReason).toBe('error');
      expect(out.error).toBe('provider exploded');
      expect(out.sessionName).toBe('think-tank-kai/sub-1');
      expect(child.shutdown).toHaveBeenCalledTimes(1);
      expect(registry.active).toBe(0);

      const bad = fakeRunner({ throwOn: 'initialize' });
      const out2 = await createSpawnSubagentTool({ parentConfig, registry, createRunner: () => bad }).execute({ task: 'x' }) as Record<string, unknown>;
      expect(out2.error).toBe('no api key');
      expect(bad.shutdown).toHaveBeenCalledTimes(1);
    });

    it('aborts the child when the wall-clock budget runs out and reports timeout', async () => {
      vi.useFakeTimers();
      try {
        const registry = createSubagentRegistry();
        const child = fakeRunner({
          result: () => new Promise<AgentRunResult>((_, reject) => {
            // The real runner rejects on abort; mirror that.
            setTimeout(() => reject(new Error('aborted')), 60_000);
          }),
        });
        const tool = createSpawnSubagentTool({ parentConfig, registry, createRunner: () => child, timeoutMs: 1_000 });
        const pending = tool.execute({ task: 'slow' });
        await vi.advanceTimersByTimeAsync(1_000);
        const signal = child.run.mock.calls[0]![3]?.abortSignal as AbortSignal;
        expect(signal.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(60_000);
        const out = await pending as Record<string, unknown>;
        expect(out.stoppedReason).toBe('timeout');
        expect(out.success).toBe(false);
        expect(child.shutdown).toHaveBeenCalledTimes(1);
        expect(registry.active).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses a bad spawn before creating any runner', async () => {
      const createRunner = vi.fn();
      const tool = createSpawnSubagentTool({ parentConfig, registry: createSubagentRegistry(), createRunner });
      const out = await tool.execute({ task: 'x', model: 'nope/m' }) as Record<string, unknown>;
      expect(out.success).toBe(false);
      expect(String(out.error)).toMatch(/unknown model provider/);
      expect(createRunner).not.toHaveBeenCalled();
    });

    it('describes when to use it and what did_nothing means, and declares its sensitivity', () => {
      const tool = createSpawnSubagentTool({ parentConfig, registry: createSubagentRegistry(), createRunner: vi.fn() });
      expect(tool.sensitivity).toBe('sensitive');
      expect(tool.description).toMatch(/teammate instead/);
      expect(tool.description).toMatch(/did_nothing/);
      const parsed = (tool.inputSchema as any).safeParse({ task: 'x', maxSteps: 0 });
      expect(parsed.success).toBe(false);
    });
  });
});
