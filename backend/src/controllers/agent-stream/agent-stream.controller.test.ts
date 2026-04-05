/**
 * Tests for Agent Stream Controller
 *
 * @module controllers/agent-stream/agent-stream.controller.test
 */

import { streamAgentEvents } from './agent-stream.controller.js';
import { AgentStreamService } from '../../services/agent/crewly-agent/agent-stream.service.js';

/**
 * Create a mock Express Request object
 */
function mockRequest(params: Record<string, string> = {}): any {
  const listeners: Record<string, Function[]> = {};
  return {
    params,
    on: (event: string, handler: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    },
    _emit: (event: string) => {
      listeners[event]?.forEach(fn => fn());
    },
  };
}

/**
 * Create a mock Express Response object for SSE
 */
function mockResponse(): any {
  const headers: Record<string, string> = {};
  const written: string[] = [];
  return {
    setHeader: (key: string, value: string) => { headers[key] = value; },
    flushHeaders: jest.fn(),
    write: jest.fn((data: string) => { written.push(data); return true; }),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    _headers: headers,
    _written: written,
  };
}

describe('streamAgentEvents', () => {
  beforeEach(() => {
    AgentStreamService.resetInstance();
  });

  afterEach(() => {
    AgentStreamService.resetInstance();
  });

  it('should return 400 if sessionName is missing', () => {
    const req = mockRequest({});
    const res = mockResponse();

    streamAgentEvents(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it('should set SSE headers', () => {
    const req = mockRequest({ sessionName: 'test-agent' });
    const res = mockResponse();

    streamAgentEvents(req, res);

    expect(res._headers['Content-Type']).toBe('text/event-stream');
    expect(res._headers['Cache-Control']).toBe('no-cache');
    expect(res._headers['Connection']).toBe('keep-alive');
    expect(res.flushHeaders).toHaveBeenCalled();
  });

  it('should send connected event on initial connection', () => {
    const req = mockRequest({ sessionName: 'test-agent' });
    const res = mockResponse();

    streamAgentEvents(req, res);

    expect(res.write).toHaveBeenCalled();
    const firstWrite = res._written[0];
    const parsed = JSON.parse(firstWrite.replace('data: ', '').trim());
    expect(parsed.type).toBe('connected');
    expect(parsed.sessionName).toBe('test-agent');
  });

  it('should forward matching stream events to client', () => {
    const req = mockRequest({ sessionName: 'my-agent' });
    const res = mockResponse();

    streamAgentEvents(req, res);

    // Clear the initial connected event
    res._written.length = 0;
    res.write.mockClear();

    // Emit a matching event
    const streamService = AgentStreamService.getInstance();
    streamService.emitTextChunk('my-agent', 'Hello world');

    expect(res.write).toHaveBeenCalledTimes(1);
    const eventData = res._written[0];
    const parsed = JSON.parse(eventData.replace('data: ', '').trim());
    expect(parsed.type).toBe('text_chunk');
    expect(parsed.text).toBe('Hello world');
  });

  it('should NOT forward events for other sessions', () => {
    const req = mockRequest({ sessionName: 'my-agent' });
    const res = mockResponse();

    streamAgentEvents(req, res);
    res.write.mockClear();

    const streamService = AgentStreamService.getInstance();
    streamService.emitTextChunk('other-agent', 'Should not appear');

    // write should not have been called (after connected event)
    expect(res.write).not.toHaveBeenCalled();
  });

  it('should cleanup listener on client disconnect', () => {
    const req = mockRequest({ sessionName: 'my-agent' });
    const res = mockResponse();

    streamAgentEvents(req, res);
    res.write.mockClear();

    // Simulate disconnect
    req._emit('close');

    // Events should no longer be forwarded
    const streamService = AgentStreamService.getInstance();
    streamService.emitTextChunk('my-agent', 'After disconnect');

    expect(res.write).not.toHaveBeenCalled();
  });

  it('should forward tool_call_start and tool_call_finish events', () => {
    const req = mockRequest({ sessionName: 'dev-agent' });
    const res = mockResponse();

    streamAgentEvents(req, res);
    res._written.length = 0;
    res.write.mockClear();

    const streamService = AgentStreamService.getInstance();
    streamService.emitToolCallStart('dev-agent', 'bash_exec', { command: 'ls' });
    streamService.emitToolCallFinish('dev-agent', 'bash_exec', { command: 'ls' }, 'file1\nfile2', 50);

    expect(res.write).toHaveBeenCalledTimes(2);
    const events = res._written.map((w: string) =>
      JSON.parse(w.replace('data: ', '').trim()),
    );
    expect(events[0].type).toBe('tool_call_start');
    expect(events[0].toolName).toBe('bash_exec');
    expect(events[1].type).toBe('tool_call_finish');
    expect(events[1].durationMs).toBe(50);
  });
});
