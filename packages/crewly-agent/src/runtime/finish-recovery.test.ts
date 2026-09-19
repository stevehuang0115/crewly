/**
 * Tests for how a turn that did not end naturally is classified, continued
 * and — when it cannot be rescued — reported as incomplete.
 *
 * The bug these lock down: a turn ending on `length` or `other` used to be
 * returned as a finished answer, so the agent could promise work, get cut
 * off, and report success (2026-09-19, the orchestrator ended four turns in
 * a row on `other` and silently created nothing).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunnerService, classifyFinish, mergeRuns } from './agent-runner.service.js';
import { CREWLY_AGENT_DEFAULTS, type AgentRunResult, type CrewlyAgentConfig } from './types.js';

const MAX_STEPS = 50;

/** A run result with sensible defaults. */
function runResult(over: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    text: 'text',
    steps: 1,
    usage: { input: 10, output: 5 },
    toolCalls: [],
    finishReason: 'stop',
    ...over,
  };
}

describe('classifyFinish', () => {
  it('treats stop and tool-calls as the only healthy endings', () => {
    for (const reason of ['stop', 'tool-calls']) {
      expect(classifyFinish(reason, 3, MAX_STEPS)).toMatchObject({ reason: null, recoverable: false });
    }
  });

  it('continues a turn cut off by the output limit, within the continuation budget', () => {
    const out = classifyFinish('length', 3, MAX_STEPS);
    expect(out).toMatchObject({ reason: 'truncated', recoverable: true, budget: CREWLY_AGENT_DEFAULTS.MAX_CONTINUATIONS });
    expect(out.nudge).toMatch(/continue from exactly where you stopped/i);
    expect(out.nudge).toMatch(/do not repeat/i);
  });

  it('retries an abnormal provider finish once, naming the reason', () => {
    for (const reason of ['other', 'error', 'unknown', 'insufficient_system_resource']) {
      const out = classifyFinish(reason, 3, MAX_STEPS);
      expect(out).toMatchObject({ reason: 'abnormal-finish', recoverable: true, budget: CREWLY_AGENT_DEFAULTS.MAX_ABNORMAL_RETRIES });
      expect(out.detail).toContain(reason);
    }
  });

  it('never retries a content-filter refusal', () => {
    expect(classifyFinish('content-filter', 3, MAX_STEPS)).toMatchObject({ reason: 'content-filter', recoverable: false, budget: 0 });
  });

  it('reports the step ceiling as incomplete whatever the provider says, and does not retry into it', () => {
    // Even a 'stop' at the ceiling means the loop was cut from outside.
    expect(classifyFinish('stop', MAX_STEPS, MAX_STEPS)).toMatchObject({ reason: 'steps-exhausted', recoverable: false });
    expect(classifyFinish('length', MAX_STEPS + 2, MAX_STEPS)).toMatchObject({ reason: 'steps-exhausted' });
    expect(classifyFinish('stop', MAX_STEPS - 1, MAX_STEPS)).toMatchObject({ reason: null });
  });
});

describe('mergeRuns', () => {
  it('appends text and accumulates steps, usage and tool calls', () => {
    const merged = mergeRuns(
      runResult({ text: 'part one', steps: 4, usage: { input: 10, output: 20 }, toolCalls: [{ toolName: 'a', args: {}, result: 1 }], finishReason: 'length' }),
      runResult({ text: 'part two', steps: 2, usage: { input: 3, output: 7 }, toolCalls: [{ toolName: 'b', args: {}, result: 2 }], finishReason: 'stop' }),
    );
    expect(merged.text).toBe('part one\n\npart two');
    expect(merged.steps).toBe(6);
    expect(merged.usage).toEqual({ input: 13, output: 27 });
    expect(merged.toolCalls.map((t) => t.toolName)).toEqual(['a', 'b']);
    expect(merged.finishReason).toBe('stop');
  });

  it('drops empty halves rather than leaving blank gaps, and keeps the newer metadata', () => {
    expect(mergeRuns(runResult({ text: '' }), runResult({ text: 'only' })).text).toBe('only');
    expect(mergeRuns(runResult({ text: 'only' }), runResult({ text: '   ' })).text).toBe('only');
    const merged = mergeRuns(runResult({ budgetWarning: 'old', reasoning: 'r1' }), runResult({ budgetWarning: undefined, reasoning: null }));
    expect(merged.budgetWarning).toBe('old');
    expect(merged.reasoning).toBe('r1');
  });
});

describe('recovery loop', () => {
  let runner: AgentRunnerService;
  let attempts: AgentRunResult[];
  let attemptSpy: ReturnType<typeof vi.fn>;

  const config = {
    sessionName: 'test-agent',
    role: 'developer',
    projectPath: '/tmp',
    maxSteps: MAX_STEPS,
    model: { provider: 'deepseek', modelId: 'deepseek-chat' },
  } as unknown as CrewlyAgentConfig;

  /** Drive the private recovery loop with a scripted sequence of attempts. */
  async function runLoop(): Promise<AgentRunResult> {
    return await (runner as unknown as {
      executeRunWithStreamText(tools: Record<string, unknown>, signal: AbortSignal): Promise<AgentRunResult>;
    }).executeRunWithStreamText({}, new AbortController().signal);
  }

  beforeEach(() => {
    runner = new AgentRunnerService(config);
    attempts = [];
    attemptSpy = vi.fn(async () => attempts.shift() ?? runResult());
    (runner as unknown as Record<string, unknown>).attemptWithErrorRetries = attemptSpy;
  });

  it('returns a healthy turn untouched, with no extra model call', async () => {
    attempts = [runResult({ text: 'done', finishReason: 'stop' })];
    const out = await runLoop();
    expect(out.text).toBe('done');
    expect(out.incomplete).toBeUndefined();
    expect(attemptSpy).toHaveBeenCalledTimes(1);
  });

  it('continues a truncated turn until the model stops, and returns the joined answer', async () => {
    attempts = [
      runResult({ text: 'first half', finishReason: 'length' }),
      runResult({ text: 'second half', finishReason: 'stop' }),
    ];
    const out = await runLoop();
    expect(out.text).toBe('first half\n\nsecond half');
    expect(out.incomplete).toBeUndefined();
    expect(attemptSpy).toHaveBeenCalledTimes(2);
  });

  it('gives up after the continuation budget and reports what it kept', async () => {
    attempts = Array.from({ length: 10 }, (_, i) => runResult({ text: `chunk ${i}`, finishReason: 'length' }));
    const out = await runLoop();
    expect(attemptSpy).toHaveBeenCalledTimes(CREWLY_AGENT_DEFAULTS.MAX_CONTINUATIONS + 1);
    expect(out.incomplete).toMatchObject({ reason: 'truncated', recoveryAttempts: CREWLY_AGENT_DEFAULTS.MAX_CONTINUATIONS });
    expect(out.text).toContain('chunk 0');
  });

  it('recovers the deepseek case: an abnormal finish retried once that then completes', async () => {
    attempts = [
      runResult({ text: "I'll create the team", finishReason: 'other' }),
      runResult({ text: 'Team created.', finishReason: 'stop' }),
    ];
    const out = await runLoop();
    expect(out.incomplete).toBeUndefined();
    expect(out.text).toBe("I'll create the team\n\nTeam created.");
  });

  it('marks the turn incomplete when the provider keeps bailing', async () => {
    attempts = [
      runResult({ text: "I'll create the team", finishReason: 'other' }),
      runResult({ text: '', finishReason: 'other' }),
    ];
    const out = await runLoop();
    expect(attemptSpy).toHaveBeenCalledTimes(2);
    expect(out.incomplete).toMatchObject({ reason: 'abnormal-finish', finishReason: 'other', recoveryAttempts: 1 });
  });

  it('does not retry a step-exhausted or content-filtered turn', async () => {
    attempts = [runResult({ steps: MAX_STEPS, finishReason: 'tool-calls' })];
    expect((await runLoop()).incomplete).toMatchObject({ reason: 'steps-exhausted', recoveryAttempts: 0 });
    expect(attemptSpy).toHaveBeenCalledTimes(1);

    attemptSpy.mockClear();
    attempts = [runResult({ finishReason: 'content-filter' })];
    expect((await runLoop()).incomplete).toMatchObject({ reason: 'content-filter' });
    expect(attemptSpy).toHaveBeenCalledTimes(1);
  });

  it('pushes a continuation instruction into the conversation before retrying', async () => {
    attempts = [runResult({ finishReason: 'length' }), runResult({ finishReason: 'stop' })];
    await runLoop();
    const messages = (runner as unknown as { state: { messages: Array<{ role: string; content: string }> } }).state.messages;
    const nudge = messages.filter((m) => m.role === 'user').pop();
    expect(nudge?.content).toMatch(/continue from exactly where you stopped/i);
  });
});
