/**
 * Tests for the runtime half of text-emitted tool-call recovery: executing
 * what the model wrote as prose and feeding the results back into the turn.
 *
 * The bug these lock down: deepseek-chat wrote `<｜｜DSML｜｜ invoke …>` into
 * its reply, the SDK saw no tool call, and the step ended having done
 * nothing — the agent said it would create a team and created nothing
 * (2026-09-19).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunnerService } from './agent-runner.service.js';
import { CREWLY_AGENT_DEFAULTS, type AgentRunResult, type CrewlyAgentConfig } from './types.js';

const MAX_STEPS = 50;

/** A run result with sensible defaults. */
function runResult(over: Partial<AgentRunResult> = {}): AgentRunResult {
  return { text: 'text', steps: 1, usage: { input: 10, output: 5 }, toolCalls: [], finishReason: 'stop', ...over };
}

/** The envelope deepseek-chat actually emits, around one call. */
function dsml(tool: string, param: string, value: string): string {
  return [
    '<｜｜DSML｜｜ calls>',
    `<｜｜DSML｜｜ invoke name="${tool}">`,
    `<｜｜DSML｜｜ parameter name="${param}" string="true">${value}</｜｜DSML｜｜ parameter>`,
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n');
}

describe('salvaging tool calls the model wrote as text', () => {
  let runner: AgentRunnerService;
  let attempts: AgentRunResult[];
  let attemptSpy: ReturnType<typeof vi.fn>;
  let bashExec: ReturnType<typeof vi.fn>;
  let tools: Record<string, unknown>;

  const config = {
    sessionName: 'test-agent',
    role: 'developer',
    projectPath: '/tmp',
    maxSteps: MAX_STEPS,
    model: { provider: 'deepseek', modelId: 'deepseek-chat' },
  } as unknown as CrewlyAgentConfig;

  /** Drive the private loop with a scripted sequence of attempts. */
  async function runLoop(): Promise<AgentRunResult> {
    return await (runner as unknown as {
      executeRunWithStreamText(tools: Record<string, unknown>, signal: AbortSignal): Promise<AgentRunResult>;
    }).executeRunWithStreamText(tools, new AbortController().signal);
  }

  /** The messages the runner has accumulated for the turn. */
  function messages(): Array<{ role: string; content: string }> {
    return (runner as unknown as { state: { messages: Array<{ role: string; content: string }> } }).state.messages;
  }

  beforeEach(() => {
    runner = new AgentRunnerService(config);
    attempts = [];
    attemptSpy = vi.fn(async () => {
      const next = attempts.shift() ?? runResult();
      // Mirror what a real attempt does: its text lands in the transcript.
      if (next.text) messages().push({ role: 'assistant', content: next.text });
      return next;
    });
    (runner as unknown as Record<string, unknown>).attemptWithErrorRetries = attemptSpy;
    bashExec = vi.fn(async () => ({ success: true, stdout: 'M src/index.ts', exitCode: 0 }));
    tools = { bash_exec: { description: 'run a command', inputSchema: undefined, execute: bashExec } };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('executes the call, hides the markup, and lets the turn finish', async () => {
    attempts = [
      runResult({ text: `Checking the repo.\n${dsml('bash_exec', 'command', 'git status --short')}` }),
      runResult({ text: 'One file is modified.' }),
    ];
    const out = await runLoop();

    expect(bashExec).toHaveBeenCalledWith({ command: 'git status --short' });
    expect(out.text).toBe('Checking the repo.\n\nOne file is modified.');
    expect(out.text).not.toContain('DSML');
    expect(out.incomplete).toBeUndefined();
  });

  it('records the salvaged call in the run ledger, so it is not invisible work', async () => {
    attempts = [runResult({ text: dsml('bash_exec', 'command', 'ls') }), runResult({ text: 'done' })];
    const out = await runLoop();
    expect(out.toolCalls).toEqual([
      { toolName: 'bash_exec', args: { command: 'ls' }, result: { success: true, stdout: 'M src/index.ts', exitCode: 0 } },
    ]);
  });

  it('feeds the result back and tells the model to use real tool calls', async () => {
    attempts = [runResult({ text: dsml('bash_exec', 'command', 'ls') }), runResult({ text: 'done' })];
    await runLoop();
    const fedBack = messages().filter((m) => m.role === 'user').pop();
    expect(fedBack?.content).toContain('M src/index.ts');
    expect(fedBack?.content).toMatch(/executes nothing/i);
  });

  it('rewrites the transcript so the markup is not modelled as the way to call a tool', async () => {
    attempts = [runResult({ text: `Checking.\n${dsml('bash_exec', 'command', 'ls')}` }), runResult({ text: 'done' })];
    await runLoop();
    expect(messages().some((m) => m.content.includes('DSML'))).toBe(false);
    expect(messages().some((m) => m.role === 'assistant' && m.content === 'Checking.')).toBe(true);
  });

  it('reports an unknown tool back to the model instead of failing silently', async () => {
    attempts = [runResult({ text: dsml('Bash', 'command', 'ls') }), runResult({ text: 'ok' })];
    await runLoop();
    expect(bashExec).not.toHaveBeenCalled();
    const fedBack = messages().filter((m) => m.role === 'user').pop();
    expect(fedBack?.content).toMatch(/no tool with that name/i);
    expect(fedBack?.content).toContain('bash_exec');
  });

  it('reports a schema complaint rather than calling the tool with bad arguments', async () => {
    tools = {
      bash_exec: {
        execute: bashExec,
        inputSchema: { safeParse: () => ({ success: false, error: { message: 'command is required' } }) },
      },
    };
    attempts = [runResult({ text: dsml('bash_exec', 'cmd', 'ls') }), runResult({ text: 'ok' })];
    await runLoop();
    expect(bashExec).not.toHaveBeenCalled();
    expect(messages().filter((m) => m.role === 'user').pop()?.content).toContain('command is required');
  });

  it('hands a thrown tool error back as a result instead of losing the turn', async () => {
    bashExec.mockRejectedValueOnce(new Error('spawn ENOENT'));
    attempts = [runResult({ text: dsml('bash_exec', 'command', 'nope') }), runResult({ text: 'ok' })];
    const out = await runLoop();
    expect(out.toolCalls[0].result).toEqual({ error: 'spawn ENOENT' });
    expect(messages().filter((m) => m.role === 'user').pop()?.content).toContain('spawn ENOENT');
  });

  it('gives up after the salvage budget rather than looping on a model that will not learn', async () => {
    attempts = Array.from({ length: 12 }, () => runResult({ text: dsml('bash_exec', 'command', 'ls') }));
    await runLoop();
    expect(bashExec).toHaveBeenCalledTimes(CREWLY_AGENT_DEFAULTS.MAX_TEXT_TOOL_SALVAGES);
  });

  it('caps how many calls one confused turn can fan out to', async () => {
    const many = Array.from({ length: 9 }, (_, i) => `<invoke name="bash_exec"><parameter name="command">echo ${i}</parameter></invoke>`).join('\n');
    attempts = [runResult({ text: many }), runResult({ text: 'ok' })];
    await runLoop();
    expect(bashExec).toHaveBeenCalledTimes(CREWLY_AGENT_DEFAULTS.MAX_SALVAGED_CALLS_PER_ROUND);
    expect(messages().filter((m) => m.role === 'user').pop()?.content).toMatch(/4 further call\(s\) were not run/);
  });

  it('truncates a huge result so one salvaged command cannot blow the context', async () => {
    bashExec.mockResolvedValueOnce('x'.repeat(CREWLY_AGENT_DEFAULTS.SALVAGED_RESULT_MAX_CHARS + 500));
    attempts = [runResult({ text: dsml('bash_exec', 'command', 'cat big') }), runResult({ text: 'ok' })];
    await runLoop();
    const fedBack = messages().filter((m) => m.role === 'user').pop()?.content ?? '';
    expect(fedBack).toMatch(/truncated, 500 more characters/);
    expect(fedBack.length).toBeLessThan(CREWLY_AGENT_DEFAULTS.SALVAGED_RESULT_MAX_CHARS + 1500);
  });

  it('leaves a healthy turn completely alone', async () => {
    attempts = [runResult({ text: 'All done, nothing to salvage.' })];
    const out = await runLoop();
    expect(attemptSpy).toHaveBeenCalledTimes(1);
    expect(bashExec).not.toHaveBeenCalled();
    expect(out.text).toBe('All done, nothing to salvage.');
  });

  it('still reports the turn incomplete when the retried attempt bails', async () => {
    attempts = [
      runResult({ text: dsml('bash_exec', 'command', 'ls') }),
      runResult({ text: '', finishReason: 'other' }),
      runResult({ text: '', finishReason: 'other' }),
    ];
    const out = await runLoop();
    expect(bashExec).toHaveBeenCalledTimes(1);
    expect(out.incomplete).toMatchObject({ reason: 'abnormal-finish' });
  });
});
