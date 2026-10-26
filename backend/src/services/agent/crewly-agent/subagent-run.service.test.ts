/**
 * SubagentRunService Tests
 *
 * The runtime is faked: tests assert the config the worker is started
 * with, the rules that refuse a run, the outcome mapping, the timeout,
 * and that the worker is always shut down and unregistered.
 *
 * @module services/agent/crewly-agent/subagent-run.service.test
 */

import {
  SubagentRunService,
  SubagentRunRefused,
  buildSubagentPrompt,
  parseRequestedModel,
  summarizeSubagentRun,
  type SubagentRuntime,
} from './subagent-run.service.js';
import { CREWLY_AGENT_DEFAULTS, type AgentRunResult, type CrewlyAgentConfig } from './types.js';
import {
  _resetInProcessRuntimeRegistryForTesting,
  getInProcessRuntime,
  isInProcessRuntimeActive,
} from './in-process-runtime-registry.js';

jest.mock('../runtime-service.factory.js', () => ({
  RuntimeServiceFactory: { createFresh: jest.fn() },
}));
jest.mock('../../runtime-fallback/runtime-fallback.service.js', () => ({
  getRuntimeFallbackService: () => null,
}));
jest.mock('../../../utils/local-api-url.utils.js', () => ({
  getLocalApiBaseUrl: () => 'http://localhost:8787',
}));

const MODEL = { provider: 'deepseek' as const, modelId: 'deepseek-chat', temperature: 0.3, maxTokens: 8192 };

/**
 * A run result fixture.
 *
 * @param overrides - Field overrides
 * @returns The result
 */
function result(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    text: 'done',
    steps: 2,
    usage: { input: 100, output: 20, cachedInput: 0 },
    toolCalls: [{ toolName: 'grep', args: { pattern: 'x' }, result: 'ok' }],
    finishReason: 'stop',
    ...overrides,
  } as AgentRunResult;
}

/**
 * A fake runtime that records what it was given.
 *
 * @param reply - What `handleMessage` resolves with (or a function that returns the promise)
 * @returns The fake and its spies
 */
function fakeRuntime(reply: AgentRunResult | (() => Promise<AgentRunResult>) = result()) {
  const init = jest.fn<Promise<void>, [string, Partial<CrewlyAgentConfig>, string | undefined]>().mockResolvedValue(undefined);
  const handle = jest.fn<Promise<AgentRunResult>, [string]>().mockImplementation(() =>
    typeof reply === 'function' ? reply() : Promise.resolve(reply));
  const shutdown = jest.fn();
  const runtime: SubagentRuntime = { initializeInProcess: init, handleMessage: handle, shutdown };
  return { runtime, init, handle, shutdown };
}

/**
 * A service wired to the fake.
 *
 * @param runtime - The fake runtime
 * @param extra - More deps
 * @returns The service and its log spy
 */
function service(runtime: SubagentRuntime, extra: ConstructorParameters<typeof SubagentRunService>[0] = {}) {
  const append = jest.fn();
  const svc = new SubagentRunService({
    createRuntime: () => runtime,
    logBuffer: { append },
    defaultModel: () => MODEL,
    isDirectory: (p) => p === '/repo',
    ...extra,
  });
  return { svc, append };
}

beforeEach(() => _resetInProcessRuntimeRegistryForTesting());

describe('parseRequestedModel', () => {
  it('accepts provider/modelId on a known provider', () => {
    expect(parseRequestedModel(' anthropic/claude-sonnet-4-5 ')).toEqual({ model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5', temperature: 0.3, maxTokens: 8192 } });
  });
  it('refuses a bare id, a trailing slash, and an unknown provider', () => {
    expect(parseRequestedModel('gpt-4o')).toEqual({ error: expect.stringContaining('provider/modelId') });
    expect(parseRequestedModel('openai/')).toEqual({ error: expect.stringContaining('provider/modelId') });
    expect(parseRequestedModel('acme/x')).toEqual({ error: 'unknown model provider "acme"' });
  });
});

describe('buildSubagentPrompt', () => {
  it('names the parent, the cwd and the write rule', () => {
    const rw = buildSubagentPrompt('dev-1', '/repo', false);
    expect(rw).toContain('spawned by the agent "dev-1"');
    expect(rw).toContain('You may change files only under /repo.');
    expect(rw).toContain('call report_to_parent once');
    expect(buildSubagentPrompt('dev-1', '/repo', true)).toContain('read-only tools');
  });
});

describe('summarizeSubagentRun', () => {
  it('prefers the report, collects files from successful writes plus the report, and strips the report from the counts', () => {
    const out = summarizeSubagentRun(result({
      text: 'final text',
      toolCalls: [
        { toolName: 'read_file', args: { file_path: '/repo/a.ts' }, result: 'x' },
        { toolName: 'edit_file', args: { file_path: '/repo/a.ts' }, result: { success: true } },
        { toolName: 'write_file', args: { file_path: '/repo/b.ts' }, result: { success: false, error: 'denied' } },
        { toolName: 'report_to_parent', args: { summary: 'changed a.ts', filesChanged: ['/repo/c.ts'] }, result: { ok: true } },
      ],
    }), 'dev-1/sub-1', 'deepseek/deepseek-chat', 1500, false);
    expect(out).toMatchObject({
      success: true,
      stoppedReason: 'done',
      summary: 'changed a.ts',
      toolCalls: 3,
      toolNames: ['read_file', 'edit_file', 'write_file'],
      filesChanged: ['/repo/a.ts', '/repo/c.ts'],
      steps: 2,
      sessionName: 'dev-1/sub-1',
      durationMs: 1500,
      model: 'deepseek/deepseek-chat',
    });
    expect(out.error).toBeUndefined();
  });

  it('reads did_nothing, steps_exhausted, incomplete and timeout', () => {
    expect(summarizeSubagentRun(result({ toolCalls: [] }), 's', 'm', 1, false)).toMatchObject({ success: false, stoppedReason: 'did_nothing' });
    expect(summarizeSubagentRun(result({ incomplete: { reason: 'steps-exhausted', finishReason: 'tool-calls' } } as Partial<AgentRunResult>), 's', 'm', 1, false)).toMatchObject({ stoppedReason: 'steps_exhausted' });
    expect(summarizeSubagentRun(result({ incomplete: { reason: 'truncated', finishReason: 'length' } } as Partial<AgentRunResult>), 's', 'm', 1, false)).toMatchObject({ stoppedReason: 'incomplete' });
    expect(summarizeSubagentRun(result(), 's', 'm', 1, true)).toMatchObject({ stoppedReason: 'timeout', error: expect.stringContaining('exceeded') });
  });

  it('caps the summary', () => {
    const long = 'x'.repeat(CREWLY_AGENT_DEFAULTS.SUBAGENT.SUMMARY_MAX_CHARS + 50);
    const out = summarizeSubagentRun(result({ text: long }), 's', 'm', 1, false);
    expect(out.summary.endsWith('…[truncated]')).toBe(true);
    expect(out.summary.length).toBeLessThan(long.length);
  });
});

describe('SubagentRunService.run', () => {
  it('refuses before starting a worker: no parent, nested parent, empty task, long task, bad cwd, bad model', async () => {
    const { runtime, init } = fakeRuntime();
    const { svc } = service(runtime);
    const base = { task: 'look', cwd: '/repo' };
    await expect(svc.run(undefined, base)).rejects.toMatchObject({ code: 'parent_required' });
    await expect(svc.run('dev-1/sub-2', base)).rejects.toMatchObject({ code: 'nested' });
    await expect(svc.run('dev-1', { ...base, task: '  ' })).rejects.toMatchObject({ code: 'task_missing' });
    await expect(svc.run('dev-1', { ...base, task: 'x'.repeat(CREWLY_AGENT_DEFAULTS.SUBAGENT.TASK_MAX_CHARS + 1) })).rejects.toMatchObject({ code: 'task_too_long' });
    await expect(svc.run('dev-1', { ...base, cwd: 'relative' })).rejects.toMatchObject({ code: 'cwd_invalid' });
    await expect(svc.run('dev-1', { ...base, cwd: '/missing' })).rejects.toMatchObject({ code: 'cwd_invalid' });
    await expect(svc.run('dev-1', { ...base, model: 'gpt-4o' })).rejects.toMatchObject({ code: 'model_invalid' });
    await expect(svc.run('dev-1', { ...base, model: 'gpt-4o' })).rejects.toBeInstanceOf(SubagentRunRefused);
    expect(init).not.toHaveBeenCalled();
  });

  it('starts the worker with the sub-agent policy, the parent prompt, defaults, and shuts it down after the reply', async () => {
    const { runtime, init, handle, shutdown } = fakeRuntime();
    const { svc, append } = service(runtime, { now: (() => { let t = 1000; return () => (t += 500); })() });
    const out = await svc.run('dev-1', { task: '  find the bug  ', cwd: '/repo' });

    expect(init).toHaveBeenCalledTimes(1);
    const [session, config, role] = init.mock.calls[0];
    expect(session).toBe('dev-1/sub-1');
    expect(role).toBe('subagent');
    expect(config).toMatchObject({
      model: MODEL,
      maxSteps: CREWLY_AGENT_DEFAULTS.SUBAGENT.MAX_STEPS,
      sessionName: 'dev-1/sub-1',
      role: 'subagent',
      apiBaseUrl: 'http://localhost:8787',
      projectPath: '/repo',
      subagent: { cwd: '/repo', readOnly: false, depth: 1, parentSession: 'dev-1' },
    });
    expect(config.systemPrompt).toBe(buildSubagentPrompt('dev-1', '/repo', false));
    expect(handle).toHaveBeenCalledWith('find the bug');
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(isInProcessRuntimeActive('dev-1/sub-1')).toBe(false);
    expect(svc.activeCount('dev-1')).toBe(0);
    expect(out).toMatchObject({ success: true, stoppedReason: 'done', sessionName: 'dev-1/sub-1', model: 'deepseek/deepseek-chat', toolCalls: 1 });
    expect(out.durationMs).toBeGreaterThan(0);
    expect(append).toHaveBeenCalledWith('dev-1', 'info', expect.stringContaining('spawn-subagent → dev-1/sub-1'));
    expect(append).toHaveBeenCalledWith('dev-1', 'info', expect.stringContaining('spawn-subagent ← dev-1/sub-1 done'));
  });

  it('honours readOnly, caps maxSteps, takes the named model, and numbers children per parent', async () => {
    const { runtime, init } = fakeRuntime();
    const { svc } = service(runtime);
    await svc.run('dev-1', { task: 'a', cwd: '/repo', readOnly: true, maxSteps: 999, model: 'anthropic/claude-haiku-4-5' });
    await svc.run('dev-1', { task: 'b', cwd: '/repo', maxSteps: 0 });
    await svc.run('dev-2', { task: 'c', cwd: '/repo' });
    const configs = init.mock.calls.map((c) => c[1]);
    expect(configs[0]).toMatchObject({
      sessionName: 'dev-1/sub-1',
      maxSteps: CREWLY_AGENT_DEFAULTS.SUBAGENT.MAX_STEPS_CAP,
      model: expect.objectContaining({ provider: 'anthropic', modelId: 'claude-haiku-4-5' }),
      subagent: expect.objectContaining({ readOnly: true }),
    });
    expect(configs[0].systemPrompt).toContain('read-only tools');
    expect(configs[1]).toMatchObject({ sessionName: 'dev-1/sub-2', maxSteps: CREWLY_AGENT_DEFAULTS.SUBAGENT.MAX_STEPS });
    expect(configs[2]).toMatchObject({ sessionName: 'dev-2/sub-1' });
  });

  it('registers the child while it runs so its process is attributed, then unregisters', async () => {
    let seen: boolean | null = null;
    const { runtime } = fakeRuntime(async () => {
      seen = getInProcessRuntime('dev-1/sub-1') === runtime;
      return result();
    });
    const { svc } = service(runtime);
    await svc.run('dev-1', { task: 'a', cwd: '/repo' });
    expect(seen).toBe(true);
    expect(isInProcessRuntimeActive('dev-1/sub-1')).toBe(false);
  });

  it('refuses a fourth concurrent child for the same parent and frees the slot afterwards', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { runtime } = fakeRuntime(async () => { await gate; return result(); });
    const { svc } = service(runtime);
    const running = Array.from({ length: CREWLY_AGENT_DEFAULTS.SUBAGENT.MAX_CONCURRENT }, () => svc.run('dev-1', { task: 'a', cwd: '/repo' }));
    await new Promise((r) => setImmediate(r));
    expect(svc.activeCount('dev-1')).toBe(CREWLY_AGENT_DEFAULTS.SUBAGENT.MAX_CONCURRENT);
    await expect(svc.run('dev-1', { task: 'a', cwd: '/repo' })).rejects.toMatchObject({ code: 'too_many' });
    // Another parent is not limited by this one's children.
    const other = svc.run('dev-2', { task: 'a', cwd: '/repo' });
    await new Promise((r) => setImmediate(r));
    expect(svc.activeCount('dev-2')).toBe(1);
    release();
    await Promise.all([...running, other]);
    expect(svc.activeCount('dev-1')).toBe(0);
    expect(svc.activeCount('dev-2')).toBe(0);
  });

  it('times out a child that never replies, shuts it down, and reports timeout', async () => {
    const { runtime, shutdown } = fakeRuntime(() => new Promise<AgentRunResult>(() => { /* never */ }));
    const { svc, append } = service(runtime, { timeoutMs: 20 });
    const out = await svc.run('dev-1', { task: 'a', cwd: '/repo' });
    expect(out).toMatchObject({ success: false, stoppedReason: 'timeout', toolCalls: 0, error: expect.stringContaining('exceeded 20 ms') });
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(isInProcessRuntimeActive('dev-1/sub-1')).toBe(false);
    expect(append).toHaveBeenCalledWith('dev-1', 'warn', expect.stringContaining('timeout'));
  });

  it('reports error when the worker fails to start, and still cleans up', async () => {
    const { runtime, init, shutdown } = fakeRuntime();
    init.mockRejectedValue(new Error('no API key for deepseek'));
    const { svc } = service(runtime);
    const out = await svc.run('dev-1', { task: 'a', cwd: '/repo' });
    expect(out).toMatchObject({ success: false, stoppedReason: 'error', error: 'no API key for deepseek', sessionName: 'dev-1/sub-1' });
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(svc.activeCount('dev-1')).toBe(0);
    expect(isInProcessRuntimeActive('dev-1/sub-1')).toBe(false);
  });
});
