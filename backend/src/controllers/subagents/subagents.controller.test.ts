/**
 * Sub-agents Controller Tests
 *
 * @module controllers/subagents/subagents.controller.test
 */

import type { Request, Response } from 'express';
import { runSubagent } from './subagents.controller.js';
import {
  setSubagentRunServiceForTesting,
  SubagentRunRefused,
  type SubagentRunOutcome,
  type SubagentRunService,
} from '../../services/agent/crewly-agent/subagent-run.service.js';

const readAgentSessionHeader = jest.fn<string | undefined, [unknown]>();
jest.mock('../../utils/agent-caller.utils.js', () => ({
  readAgentSessionHeader: (req: unknown) => readAgentSessionHeader(req),
}));

/**
 * Builds a mock request carrying a body.
 *
 * @param body - Request body
 * @returns Mock request
 */
function createMockRequest(body: Record<string, unknown> = {}): Request {
  return { body, headers: {}, params: {}, query: {} } as unknown as Request;
}

/**
 * Builds a mock response with spied status/json.
 *
 * @returns Mock response
 */
function createMockResponse(): Response {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

/**
 * An outcome fixture.
 *
 * @param overrides - Field overrides
 * @returns The outcome
 */
function outcome(overrides: Partial<SubagentRunOutcome> = {}): SubagentRunOutcome {
  return {
    success: true,
    stoppedReason: 'done',
    summary: 'found it at src/a.ts:12',
    toolCalls: 2,
    toolNames: ['grep', 'read_file'],
    filesChanged: [],
    usage: { input: 10, output: 5, cachedInput: 0 },
    steps: 3,
    sessionName: 'dev-1/sub-1',
    durationMs: 1200,
    model: 'deepseek/deepseek-chat',
    ...overrides,
  };
}

describe('runSubagent', () => {
  const run = jest.fn<Promise<SubagentRunOutcome>, [string | undefined, unknown]>();

  beforeEach(() => {
    run.mockReset();
    readAgentSessionHeader.mockReset();
    setSubagentRunServiceForTesting({ run } as unknown as SubagentRunService);
  });

  afterAll(() => setSubagentRunServiceForTesting(null));

  it('403s a caller that is not an agent session', async () => {
    readAgentSessionHeader.mockReturnValue(undefined);
    const res = createMockResponse();
    await runSubagent(createMockRequest({ task: 'x', cwd: '/tmp' }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'parent_required' }));
    expect(run).not.toHaveBeenCalled();
  });

  it('passes the body through for the caller session and returns the outcome', async () => {
    readAgentSessionHeader.mockReturnValue('dev-1');
    run.mockResolvedValue(outcome());
    const res = createMockResponse();
    await runSubagent(createMockRequest({ task: 'find the bug', cwd: '/repo', readOnly: true, maxSteps: 10, model: 'deepseek/deepseek-chat', extra: 1 }), res);
    expect(run).toHaveBeenCalledWith('dev-1', { task: 'find the bug', cwd: '/repo', readOnly: true, maxSteps: 10, model: 'deepseek/deepseek-chat' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: outcome() });
  });

  it('coerces a missing body into empty fields and leaves optionals out', async () => {
    readAgentSessionHeader.mockReturnValue('dev-1');
    run.mockResolvedValue(outcome());
    await runSubagent({ headers: {} } as unknown as Request, createMockResponse());
    expect(run).toHaveBeenCalledWith('dev-1', { task: '', cwd: '', readOnly: false });
  });

  it('400s with the refusal code when the service refuses', async () => {
    readAgentSessionHeader.mockReturnValue('dev-1/sub-1');
    run.mockRejectedValue(new SubagentRunRefused('nested', 'A sub-agent cannot spawn sub-agents.'));
    const res = createMockResponse();
    await runSubagent(createMockRequest({ task: 'x', cwd: '/repo' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, code: 'nested', error: 'A sub-agent cannot spawn sub-agents.' });
  });

  it('returns 200 with success:false when the child itself failed', async () => {
    readAgentSessionHeader.mockReturnValue('dev-1');
    run.mockResolvedValue(outcome({ success: false, stoppedReason: 'timeout', error: 'sub-agent exceeded 600000 ms' }));
    const res = createMockResponse();
    await runSubagent(createMockRequest({ task: 'x', cwd: '/repo' }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: expect.objectContaining({ success: false, stoppedReason: 'timeout' }) }));
  });

  it('500s on an unexpected error', async () => {
    readAgentSessionHeader.mockReturnValue('dev-1');
    run.mockRejectedValue(new Error('boom'));
    const res = createMockResponse();
    await runSubagent(createMockRequest({ task: 'x', cwd: '/repo' }), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, code: 'internal', error: 'boom' });
  });
});
