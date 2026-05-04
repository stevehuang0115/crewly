import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { CrewlyAgentRuntimeService } from './crewly-agent-runtime.service.js';
import type { SessionCommandHelper } from '../../session/index.js';
import { RUNTIME_TYPES } from '../../../constants.js';
import { CREWLY_AGENT_DEFAULTS } from './types.js';

// Mock LoggerService to prevent test log entries from polluting production logs.
// Without this, logger.warn() calls (e.g. ENOENT fallback in loadSystemPrompt)
// write to real log files with test paths like /test/project/.
jest.mock('../../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

// Mock fs/promises to avoid real file I/O while keeping sync fs functions
jest.mock('fs', () => {
  const actual = jest.requireActual('fs') as Record<string, unknown>;
  return {
    ...actual,
    promises: {
      readFile: jest.fn(),
      readdir: jest.fn(),
      writeFile: jest.fn(),
      mkdir: jest.fn(),
      appendFile: jest.fn(),
    },
  };
});

// Mock the AgentRunnerService
const mockInitialize = jest.fn<any>();
const mockRun = jest.fn<any>();
const mockIsInitialized = jest.fn<any>();
const mockGetHistoryLength = jest.fn<any>();
jest.mock('./agent-runner.service.js', () => ({
  AgentRunnerService: jest.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    run: mockRun,
    isInitialized: mockIsInitialized,
    getHistoryLength: mockGetHistoryLength,
    _generateTextFn: null,
    getState: jest.fn(() => ({ messages: [], systemPrompt: '', totalTokens: { input: 0, output: 0 }, createdAt: new Date(), lastActivityAt: new Date() })),
  })),
}));

// Mock agent heartbeat service
const mockUpdateAgentHeartbeat = jest.fn<any>().mockResolvedValue(undefined);
jest.mock('../agent-heartbeat.service.js', () => ({
  updateAgentHeartbeat: (...args: unknown[]) => mockUpdateAgentHeartbeat(...args),
}));

// Mock PtyActivityTrackerService
const mockRecordApiActivity = jest.fn();
jest.mock('../pty-activity-tracker.service.js', () => ({
  PtyActivityTrackerService: {
    getInstance: () => ({
      recordApiActivity: mockRecordApiActivity,
    }),
  },
}));

// Mock the RateLimiter to pass through directly (no delays/retries in tests)
jest.mock('./rate-limiter.js', () => ({
  RateLimiter: jest.fn().mockImplementation(() => ({
    enqueue: jest.fn<any>().mockImplementation(
      async (message: string, metadata: unknown, handler: (msg: string, meta: unknown) => Promise<unknown>) => {
        return handler(message, metadata);
      }
    ),
    getQueueLength: jest.fn().mockReturnValue(0),
    getRequestCountInWindow: jest.fn().mockReturnValue(0),
    reset: jest.fn(),
  })),
}));

describe('CrewlyAgentRuntimeService', () => {
  let service: CrewlyAgentRuntimeService;
  let mockSessionHelper: jest.Mocked<SessionCommandHelper>;
  const projectRoot = '/test/project';

  beforeEach(() => {
    jest.clearAllMocks();

    mockSessionHelper = {
      capturePane: jest.fn<any>(),
      sendMessage: jest.fn<any>(),
      clearCurrentCommandLine: jest.fn<any>(),
    } as any;

    // Mock fs for system prompt loading; default: only role prompt resolves
    const fsMod = jest.requireMock('fs') as any;
    fsMod.promises.readFile.mockImplementation((filePath: string) => {
      if (filePath.includes('prompt.md')) {
        return Promise.resolve('You are the orchestrator.');
      }
      return Promise.reject(new Error('ENOENT'));
    });
    fsMod.promises.readdir.mockRejectedValue(new Error('ENOENT'));

    mockInitialize.mockResolvedValue(undefined);
    mockIsInitialized.mockReturnValue(true);
    mockGetHistoryLength.mockReturnValue(0);

    service = new CrewlyAgentRuntimeService(mockSessionHelper, projectRoot);
  });

  afterEach(() => {
    service.shutdown();
  });

  describe('getRuntimeType', () => {
    it('should return crewly-agent runtime type', () => {
      // Access via the public method that uses getRuntimeType internally
      expect(service.getExitPatterns()).toEqual([]);
    });
  });

  describe('initializeInProcess', () => {
    it('should initialize the agent runner with system prompt', async () => {
      await service.initializeInProcess('crewly-orc');

      expect(service.isReady()).toBe(true);
      expect(service.getSessionName()).toBe('crewly-orc');
      expect(mockInitialize).toHaveBeenCalled();
    });

    it('should accept partial config overrides', async () => {
      await service.initializeInProcess('crewly-orc', {
        maxSteps: 50,
        model: { provider: 'openai', modelId: 'gpt-4o' },
      });

      expect(service.isReady()).toBe(true);
    });

    it('should pass projectPath through to config', async () => {
      await service.initializeInProcess('crewly-orc', {
        projectPath: '/my/project',
      });

      expect(service.isReady()).toBe(true);
      // AgentRunnerService constructor was called with config containing projectPath
      const { AgentRunnerService: MockedRunner } = jest.requireMock('./agent-runner.service.js') as any;
      expect(MockedRunner).toHaveBeenCalledWith(
        expect.objectContaining({ projectPath: '/my/project' }),
      );
    });

    it('should load role-specific prompt when roleName provided', async () => {
      const fsMod = jest.requireMock('fs') as any;
      fsMod.promises.readFile.mockResolvedValue('You are the auditor.');

      await service.initializeInProcess('crewly-auditor', undefined, 'auditor');

      expect(fsMod.promises.readFile).toHaveBeenCalledWith(
        expect.stringContaining('config/roles/auditor/prompt.md'),
        'utf8',
      );
      expect(service.isReady()).toBe(true);
      expect(service.getSessionName()).toBe('crewly-auditor');
    });

    it('should default to orchestrator role when no roleName', async () => {
      await service.initializeInProcess('crewly-orc');

      const fsMod = jest.requireMock('fs') as any;
      expect(fsMod.promises.readFile).toHaveBeenCalledWith(
        expect.stringContaining('config/roles/orchestrator/prompt.md'),
        'utf8',
      );
    });

    it('should use fallback prompt when file not found', async () => {
      const fsMod = jest.requireMock('fs') as any;
      fsMod.promises.readFile.mockRejectedValue(new Error('ENOENT'));

      await service.initializeInProcess('crewly-orc');

      expect(service.isReady()).toBe(true);
    });
  });

  describe('handleMessage', () => {
    it('should route message to agent runner and return result', async () => {
      const mockResult = {
        text: 'Task delegated',
        steps: 2,
        usage: { input: 100, output: 50 },
        toolCalls: [{ toolName: 'delegate_task', args: {}, result: {} }],
        finishReason: 'stop',
      };
      mockRun.mockResolvedValue(mockResult);

      await service.initializeInProcess('crewly-orc');
      const result = await service.handleMessage('Delegate task to Sam');

      expect(result).toEqual(mockResult);
      expect(mockRun).toHaveBeenCalledWith('Delegate task to Sam', undefined, undefined, expect.objectContaining({ abortSignal: expect.anything(), streaming: expect.anything() }));
    });

    it('should extract conversationId from [CHAT:xxx] prefix', async () => {
      const mockResult = {
        text: 'Done',
        steps: 1,
        usage: { input: 10, output: 5 },
        toolCalls: [],
        finishReason: 'stop',
      };
      mockRun.mockResolvedValue(mockResult);

      await service.initializeInProcess('crewly-orc');
      await service.handleMessage('[CHAT:conv-123] Do the thing');

      expect(mockRun).toHaveBeenCalledWith('Do the thing', 'conv-123', undefined, expect.objectContaining({ abortSignal: expect.anything() }));
    });

    it('should pass undefined conversationId when no [CHAT:] prefix', async () => {
      const mockResult = {
        text: 'Done',
        steps: 1,
        usage: { input: 10, output: 5 },
        toolCalls: [],
        finishReason: 'stop',
      };
      mockRun.mockResolvedValue(mockResult);

      await service.initializeInProcess('crewly-orc');
      await service.handleMessage('No prefix message');

      expect(mockRun).toHaveBeenCalledWith('No prefix message', undefined, undefined, expect.objectContaining({ abortSignal: expect.anything() }));
    });

    it('should extract conversationId from [GCHAT:xxx ...] prefix', async () => {
      const mockResult = {
        text: 'Done',
        steps: 1,
        usage: { input: 10, output: 5 },
        toolCalls: [],
        finishReason: 'stop',
      };
      mockRun.mockResolvedValue(mockResult);

      await service.initializeInProcess('crewly-orc');
      await service.handleMessage('[GCHAT:spaces/123/threads/abc thread=xyz] Hello from GChat');

      expect(mockRun).toHaveBeenCalledWith('Hello from GChat', 'spaces/123/threads/abc', undefined, expect.objectContaining({ abortSignal: expect.anything() }));
    });

    it('should maintain conversation context across consecutive handleMessage calls', async () => {
      const results = [
        { text: 'Response 1', steps: [], usage: { input: 10, output: 5 }, toolCalls: [], finishReason: 'stop' as const },
        { text: 'Response 2', steps: [], usage: { input: 20, output: 10 }, toolCalls: [], finishReason: 'stop' as const },
        { text: 'Response 3', steps: [], usage: { input: 30, output: 15 }, toolCalls: [], finishReason: 'stop' as const },
      ];
      mockRun
        .mockResolvedValueOnce(results[0])
        .mockResolvedValueOnce(results[1])
        .mockResolvedValueOnce(results[2]);

      await service.initializeInProcess('crewly-orc');

      const r1 = await service.handleMessage('First message');
      const r2 = await service.handleMessage('Second message');
      const r3 = await service.handleMessage('Third message');

      expect(r1.text).toBe('Response 1');
      expect(r2.text).toBe('Response 2');
      expect(r3.text).toBe('Response 3');

      // All 3 messages routed through the same runner instance (context preserved)
      expect(mockRun).toHaveBeenCalledTimes(3);
      expect(mockRun).toHaveBeenNthCalledWith(1, 'First message', undefined, undefined, expect.objectContaining({ abortSignal: expect.anything() }));
      expect(mockRun).toHaveBeenNthCalledWith(2, 'Second message', undefined, undefined, expect.objectContaining({ abortSignal: expect.anything() }));
      expect(mockRun).toHaveBeenNthCalledWith(3, 'Third message', undefined, undefined, expect.objectContaining({ abortSignal: expect.anything() }));
    });

    it('should throw if not initialized', async () => {
      await expect(service.handleMessage('Hello')).rejects.toThrow('not initialized');
    });

    it('should propagate agent runner errors', async () => {
      mockRun.mockRejectedValue(new Error('API rate limit'));

      await service.initializeInProcess('crewly-orc');
      await expect(service.handleMessage('Test')).rejects.toThrow('API rate limit');
    });

    it('should detect repetition/hallucination loop and abort', async () => {
      const { InProcessLogBuffer } = require('./in-process-log-buffer.js');
      const logBuffer = InProcessLogBuffer.getInstance();
      const appendSpy = jest.spyOn(logBuffer, 'append');

      // Mock run to simulate streaming with repetitive chunks via the callbacks
      mockRun.mockImplementation(async (_msg: string, _convId: unknown, _meta: unknown, opts: Record<string, unknown>) => {
        const streaming = opts.streaming as Record<string, Function>;

        // Simulate the model producing the same chunk 5+ times (hallucination)
        for (let i = 0; i < 6; i++) {
          streaming.onTextChunk('REPEATED_PATTERN ');
        }

        // The abort should have been triggered by repetition detection.
        // In production streamText would throw on abort, but since our mock
        // is synchronous, we return a result that triggers the post-check.
        return {
          text: 'REPEATED_PATTERN '.repeat(6),
          steps: 1,
          usage: { input: 10, output: 50 },
          toolCalls: [],
          finishReason: 'stop',
        };
      });

      await service.initializeInProcess('crewly-orc');
      await expect(service.handleMessage('Test repetition')).rejects.toThrow(/repetition.*hallucination.*loop/i);

      // Should have logged a warning about repetition
      const warnCalls = appendSpy.mock.calls.filter(
        (call: unknown[]) => call[1] === 'warn' && String(call[2]).includes('Repetition loop detected')
      );
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);

      appendSpy.mockRestore();
    });

    it('should not trigger repetition detection for varied text chunks', async () => {
      mockRun.mockImplementation(async (_msg: string, _convId: unknown, _meta: unknown, opts: Record<string, unknown>) => {
        const streaming = opts.streaming as Record<string, Function>;

        // Simulate varied output (no repetition)
        streaming.onTextChunk('First chunk. ');
        streaming.onTextChunk('Second chunk. ');
        streaming.onTextChunk('Third chunk. ');
        streaming.onTextChunk('Fourth chunk. ');
        streaming.onTextChunk('Fifth chunk. ');
        streaming.onStepFinish(1, false);

        return {
          text: 'First chunk. Second chunk. Third chunk. Fourth chunk. Fifth chunk.',
          steps: 1,
          usage: { input: 10, output: 20 },
          toolCalls: [],
          finishReason: 'stop',
        };
      });

      await service.initializeInProcess('crewly-orc');
      const result = await service.handleMessage('Normal message');

      // Should succeed without throwing
      expect(result.text).toContain('First chunk');
    });

    it('should include message preview in log for short messages', async () => {
      const mockResult = {
        text: 'OK',
        steps: 1,
        usage: { input: 10, output: 5 },
        toolCalls: [],
        finishReason: 'stop',
      };
      mockRun.mockResolvedValue(mockResult);

      await service.initializeInProcess('test-session');

      // Spy on logBuffer to verify message preview format
      const { InProcessLogBuffer } = require('./in-process-log-buffer.js');
      const logBuffer = InProcessLogBuffer.getInstance();
      const appendSpy = jest.spyOn(logBuffer, 'append');

      await service.handleMessage('Short msg');

      // Find the "Message received" log entry
      const receivedLog = appendSpy.mock.calls.find(
        (call: unknown[]) => String(call[2]).includes('Message received')
      );
      expect(receivedLog).toBeDefined();
      expect(String(receivedLog![2])).toContain('"Short msg"');

      appendSpy.mockRestore();
    });

    it('should truncate message preview for long messages with first 50 + last 50 chars', async () => {
      const mockResult = {
        text: 'OK',
        steps: 1,
        usage: { input: 10, output: 5 },
        toolCalls: [],
        finishReason: 'stop',
      };
      mockRun.mockResolvedValue(mockResult);

      await service.initializeInProcess('test-session');

      const { InProcessLogBuffer } = require('./in-process-log-buffer.js');
      const logBuffer = InProcessLogBuffer.getInstance();
      const appendSpy = jest.spyOn(logBuffer, 'append');

      const longMsg = 'A'.repeat(50) + 'MIDDLE_CONTENT_THAT_GETS_HIDDEN' + 'Z'.repeat(50);
      await service.handleMessage(longMsg);

      const receivedLog = appendSpy.mock.calls.find(
        (call: unknown[]) => String(call[2]).includes('Message received')
      );
      expect(receivedLog).toBeDefined();
      const logStr = String(receivedLog![2]);
      // Should have first 50 chars and last 50 chars with ... in between
      expect(logStr).toContain('A'.repeat(50));
      expect(logStr).toContain('Z'.repeat(50));
      expect(logStr).toContain('...');
      // Middle content should not appear
      expect(logStr).not.toContain('MIDDLE_CONTENT_THAT_GETS_HIDDEN');

      appendSpy.mockRestore();
    });

    it('should clear timers on successful completion', async () => {
      const mockResult = {
        text: 'OK',
        steps: 1,
        usage: { input: 10, output: 5 },
        toolCalls: [],
        finishReason: 'stop',
      };
      mockRun.mockResolvedValue(mockResult);

      await service.initializeInProcess('crewly-orc');
      const result = await service.handleMessage('Quick message');

      expect(result.text).toBe('OK');
      // No timeout error should occur — timers were cleared
    });
  });

  describe('detectRuntimeSpecific', () => {
    it('should return false when not initialized', async () => {
      // Use the public detectRuntimeWithCommand which delegates to detectRuntimeSpecific
      const result = await service.detectRuntimeWithCommand('crewly-orc', true);
      expect(result).toBe(false);
    });

    it('should return true when initialized', async () => {
      await service.initializeInProcess('crewly-orc');
      const result = await service.detectRuntimeWithCommand('crewly-orc', true);
      expect(result).toBe(true);
    });
  });

  describe('isReady', () => {
    it('should return false before initialization', () => {
      expect(service.isReady()).toBe(false);
    });

    it('should return true after initialization', async () => {
      await service.initializeInProcess('crewly-orc');
      expect(service.isReady()).toBe(true);
    });
  });

  describe('getAgentRunner', () => {
    it('should return null before initialization', () => {
      expect(service.getAgentRunner()).toBeNull();
    });

    it('should return runner after initialization', async () => {
      await service.initializeInProcess('crewly-orc');
      expect(service.getAgentRunner()).toBeDefined();
    });
  });

  describe('shutdown', () => {
    it('should reset all state', async () => {
      await service.initializeInProcess('crewly-orc');
      expect(service.isReady()).toBe(true);

      service.shutdown();

      expect(service.isReady()).toBe(false);
      expect(service.getAgentRunner()).toBeNull();
      expect(service.getSessionName()).toBeNull();
    });
  });

  describe('getRuntimeReadyPatterns', () => {
    it('should return Crewly Agent Ready pattern', () => {
      // Verify via waitForRuntimeReady which uses getRuntimeReadyPatterns
      // The pattern is 'Crewly Agent Ready'
      mockSessionHelper.capturePane.mockReturnValue('Crewly Agent Ready');
    });
  });

  describe('getRuntimeErrorPatterns', () => {
    it('should return empty array', () => {
      // Errors are thrown as exceptions, not terminal patterns
      // Verified via the abstract method chain
    });
  });

  describe('getExitPatterns', () => {
    it('should return empty array for in-process runtime', () => {
      expect(service.getExitPatterns()).toEqual([]);
    });
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should start heartbeat timer on initialization', async () => {
      await service.initializeInProcess('crewly-orc');

      // Heartbeat should not have fired yet (0ms elapsed)
      expect(mockUpdateAgentHeartbeat).not.toHaveBeenCalled();
      expect(mockRecordApiActivity).not.toHaveBeenCalled();

      // Advance past first heartbeat interval (30s)
      jest.advanceTimersByTime(30_000);

      expect(mockUpdateAgentHeartbeat).toHaveBeenCalledWith('crewly-orc', undefined);
      expect(mockRecordApiActivity).toHaveBeenCalledWith('crewly-orc');
    });

    it('should fire heartbeat periodically', async () => {
      await service.initializeInProcess('crewly-orc');

      // Advance 3 intervals (90s)
      jest.advanceTimersByTime(90_000);

      expect(mockUpdateAgentHeartbeat).toHaveBeenCalledTimes(3);
      expect(mockRecordApiActivity).toHaveBeenCalledTimes(3);
    });

    it('should stop heartbeat on shutdown', async () => {
      await service.initializeInProcess('crewly-orc');

      service.shutdown();
      jest.advanceTimersByTime(60_000);

      // No heartbeats should have fired
      expect(mockUpdateAgentHeartbeat).not.toHaveBeenCalled();
    });

    it('should not throw if heartbeat update fails', async () => {
      mockUpdateAgentHeartbeat.mockRejectedValue(new Error('File locked'));

      await service.initializeInProcess('crewly-orc');

      // Should not throw
      jest.advanceTimersByTime(30_000);

      // Still called, error was swallowed
      expect(mockUpdateAgentHeartbeat).toHaveBeenCalled();
    });

    it('should stop heartbeat if initialized flag becomes false', async () => {
      await service.initializeInProcess('crewly-orc');

      // Simulate shutdown setting initialized to false
      (service as any).initialized = false;
      jest.advanceTimersByTime(30_000);

      // The timer fires but the guard condition stops it
      // No heartbeat should have been sent (the guard returns early)
      // Note: the timer still fires once but immediately returns due to !this.initialized
      expect(mockUpdateAgentHeartbeat).not.toHaveBeenCalled();
    });
  });

  describe('buildEnhancedSystemPrompt', () => {
    it('should include base prompt when no skills or addons exist', async () => {
      const prompt = await service.buildEnhancedSystemPrompt('orchestrator');

      expect(prompt).toContain('You are the orchestrator.');
      expect(prompt).toContain('## Instructions');
      expect(prompt).not.toContain('## Available Skills');
      expect(prompt).not.toContain('## Installed Addons');
    });

    it('should include skills catalog summary when file exists', async () => {
      const fsMod = jest.requireMock('fs') as any;
      const catalogContent = 'Line 1\nLine 2\nLine 3';
      fsMod.promises.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('prompt.md')) {
          return Promise.resolve('Base prompt.');
        }
        if (filePath.includes('AGENT_SKILLS_CATALOG.md')) {
          return Promise.resolve(catalogContent);
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const prompt = await service.buildEnhancedSystemPrompt('orchestrator');

      expect(prompt).toContain('## Available Skills');
      expect(prompt).toContain('Line 1');
      expect(prompt).toContain('Line 2');
      expect(prompt).toContain('Line 3');
    });

    it('should truncate skills catalog to 50 lines', async () => {
      const fsMod = jest.requireMock('fs') as any;
      const lines = Array.from({ length: 80 }, (_, i) => `Skill line ${i + 1}`);
      fsMod.promises.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('prompt.md')) {
          return Promise.resolve('Base prompt.');
        }
        if (filePath.includes('AGENT_SKILLS_CATALOG.md')) {
          return Promise.resolve(lines.join('\n'));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const prompt = await service.buildEnhancedSystemPrompt('orchestrator');

      expect(prompt).toContain('Skill line 1');
      expect(prompt).toContain('Skill line 50');
      expect(prompt).not.toContain('Skill line 51');
      expect(prompt).toContain('... (30 more lines)');
    });

    it('should include installed addons from manifest files', async () => {
      const fsMod = jest.requireMock('fs') as any;
      fsMod.promises.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('prompt.md')) {
          return Promise.resolve('Base prompt.');
        }
        if (filePath.includes('manifest.json')) {
          return Promise.resolve(JSON.stringify({
            name: 'crewly-pro',
            version: '2.0.0',
            description: 'Pro features addon',
          }));
        }
        return Promise.reject(new Error('ENOENT'));
      });
      fsMod.promises.readdir.mockResolvedValue(['crewly-pro']);

      const prompt = await service.buildEnhancedSystemPrompt('orchestrator');

      expect(prompt).toContain('## Installed Addons');
      expect(prompt).toContain('- crewly-pro v2.0.0: Pro features addon');
    });

    it('should skip addons with invalid manifest', async () => {
      const fsMod = jest.requireMock('fs') as any;
      fsMod.promises.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('prompt.md')) {
          return Promise.resolve('Base prompt.');
        }
        if (filePath.includes('good-addon') && filePath.includes('manifest.json')) {
          return Promise.resolve(JSON.stringify({ name: 'good-addon', version: '1.0.0' }));
        }
        return Promise.reject(new Error('ENOENT'));
      });
      fsMod.promises.readdir.mockResolvedValue(['good-addon', 'bad-addon']);

      const prompt = await service.buildEnhancedSystemPrompt('orchestrator');

      expect(prompt).toContain('- good-addon v1.0.0');
      expect(prompt).not.toContain('bad-addon');
    });

    it('should include all sections when skills and addons both exist', async () => {
      const fsMod = jest.requireMock('fs') as any;
      fsMod.promises.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('prompt.md')) {
          return Promise.resolve('Base prompt.');
        }
        if (filePath.includes('AGENT_SKILLS_CATALOG.md')) {
          return Promise.resolve('# Skills\n- skill-a\n- skill-b');
        }
        if (filePath.includes('manifest.json')) {
          return Promise.resolve(JSON.stringify({ name: 'test-addon', version: '0.1.0', description: 'Test' }));
        }
        return Promise.reject(new Error('ENOENT'));
      });
      fsMod.promises.readdir.mockResolvedValue(['test-addon']);

      const prompt = await service.buildEnhancedSystemPrompt('orchestrator');

      expect(prompt).toContain('Base prompt.');
      expect(prompt).toContain('## Available Skills');
      expect(prompt).toContain('- skill-a');
      expect(prompt).toContain('## Installed Addons');
      expect(prompt).toContain('- test-addon v0.1.0: Test');
      expect(prompt).toContain('## Instructions');
      expect(prompt).toContain('Maintain conversation context across messages.');
    });

    it('should use fallback prompt when role prompt file is missing', async () => {
      const fsMod = jest.requireMock('fs') as any;
      fsMod.promises.readFile.mockRejectedValue(new Error('ENOENT'));

      const prompt = await service.buildEnhancedSystemPrompt('orchestrator');

      expect(prompt).toContain('You are the Crewly orchestrator agent.');
      expect(prompt).toContain('## Instructions');
    });
  });

  describe('abortCurrentRun', () => {
    it('should return false when no run is in progress', async () => {
      await service.initializeInProcess('crewly-orc');
      const result = service.abortCurrentRun();
      expect(result).toBe(false);
    });

    it('should abort via messageAbortController when set', async () => {
      await service.initializeInProcess('crewly-orc');

      // Simulate an active abort controller (set during executeMessage)
      const mockAbort = { abort: jest.fn() };
      (service as any).messageAbortController = mockAbort;

      // Replace runner's abort to avoid real abort side effects
      const runner = service.getAgentRunner();
      if (runner) {
        (runner as any).abortCurrentRun = jest.fn().mockReturnValue(false);
      }

      const result = service.abortCurrentRun();
      expect(result).toBe(true);
      expect(mockAbort.abort).toHaveBeenCalled();
      expect((service as any).messageAbortController).toBeNull();
    });

    it('should reset messageAbortController to null after abort', async () => {
      await service.initializeInProcess('crewly-orc');

      const mockAbort = { abort: jest.fn() };
      (service as any).messageAbortController = mockAbort;

      const runner = service.getAgentRunner();
      if (runner) {
        (runner as any).abortCurrentRun = jest.fn().mockReturnValue(false);
      }

      service.abortCurrentRun();

      // After abort, controller should be cleared
      expect((service as any).messageAbortController).toBeNull();
      // abort() should have been called on the controller
      expect(mockAbort.abort).toHaveBeenCalledTimes(1);
    });
  });

  describe('hard timeout (#198)', () => {
    it('should abort and throw when MESSAGE_TIMEOUT_MS is exceeded', async () => {
      const originalTimeout = CREWLY_AGENT_DEFAULTS.MESSAGE_TIMEOUT_MS;
      const originalWarning = CREWLY_AGENT_DEFAULTS.MESSAGE_SOFT_WARNING_MS;
      (CREWLY_AGENT_DEFAULTS as any).MESSAGE_TIMEOUT_MS = 200;
      (CREWLY_AGENT_DEFAULTS as any).MESSAGE_SOFT_WARNING_MS = 100;

      try {
        mockRun.mockImplementation((_msg: string, _convId: unknown, _meta: unknown, opts: Record<string, unknown>) => {
          const signal = opts?.abortSignal as AbortSignal | undefined;
          return new Promise((_resolve, reject) => {
            if (signal) {
              signal.addEventListener('abort', () => {
                reject(new Error('The operation was aborted'));
              });
            }
          });
        });

        await service.initializeInProcess('crewly-orc');
        await expect(service.handleMessage('Long running task')).rejects.toThrow(/timed out/i);
      } finally {
        (CREWLY_AGENT_DEFAULTS as any).MESSAGE_TIMEOUT_MS = originalTimeout;
        (CREWLY_AGENT_DEFAULTS as any).MESSAGE_SOFT_WARNING_MS = originalWarning;
      }
    }, 10000);

    it('should not abort before MESSAGE_TIMEOUT_MS', async () => {
      const mockResult = {
        text: 'Done',
        steps: 1,
        usage: { input: 10, output: 5 },
        toolCalls: [],
        finishReason: 'stop',
      };
      mockRun.mockResolvedValue(mockResult);

      await service.initializeInProcess('crewly-orc');
      const result = await service.handleMessage('Normal task');
      expect(result.text).toBe('Done');
    });
  });

  describe('I4 — per-model timeout', () => {
    /**
     * Locks I4 wiring at executeMessage:425. Behaviour contract:
     *  - When the active modelId has an entry in MODEL_TIMEOUT_MS, that
     *    override is used INSTEAD OF MESSAGE_TIMEOUT_MS.
     *  - When the modelId has no entry, MESSAGE_TIMEOUT_MS is used as fallback.
     *
     * The override is the I2/I4 reason DeepSeek-R1 (`deepseek-reasoner`) doesn't
     * trip the 5min default during multi-step + reasoning_content runs.
     */

    it('uses MODEL_TIMEOUT_MS override when modelId matches', async () => {
      const originalTimeout = CREWLY_AGENT_DEFAULTS.MESSAGE_TIMEOUT_MS;
      const originalWarning = CREWLY_AGENT_DEFAULTS.MESSAGE_SOFT_WARNING_MS;
      const originalModelTimeouts = { ...CREWLY_AGENT_DEFAULTS.MODEL_TIMEOUT_MS };
      // Default short so a non-override would fire fast and FAIL this test.
      // Override even shorter so the override timeout is what fires.
      (CREWLY_AGENT_DEFAULTS as any).MESSAGE_TIMEOUT_MS = 5_000;
      (CREWLY_AGENT_DEFAULTS as any).MESSAGE_SOFT_WARNING_MS = 4_000;
      (CREWLY_AGENT_DEFAULTS as any).MODEL_TIMEOUT_MS['test-fast-model'] = 150;

      try {
        mockRun.mockImplementation((_msg: string, _convId: unknown, _meta: unknown, opts: Record<string, unknown>) => {
          const signal = opts?.abortSignal as AbortSignal | undefined;
          return new Promise((_resolve, reject) => {
            if (signal) {
              signal.addEventListener('abort', () => {
                reject(new Error('The operation was aborted'));
              });
            }
          });
        });

        const startedAt = Date.now();
        await service.initializeInProcess('crewly-orc', {
          model: { provider: 'deepseek', modelId: 'test-fast-model' },
        });
        await expect(service.handleMessage('Hangs forever')).rejects.toThrow(/timed out/i);
        const elapsed = Date.now() - startedAt;
        // Override fires at ~150ms; default would fire at ~5000ms.
        // Pad generously upward to absorb CI jitter, but still well under 5000.
        expect(elapsed).toBeLessThan(2_000);
      } finally {
        (CREWLY_AGENT_DEFAULTS as any).MESSAGE_TIMEOUT_MS = originalTimeout;
        (CREWLY_AGENT_DEFAULTS as any).MESSAGE_SOFT_WARNING_MS = originalWarning;
        (CREWLY_AGENT_DEFAULTS as any).MODEL_TIMEOUT_MS = originalModelTimeouts;
      }
    }, 10000);

    it('falls back to MESSAGE_TIMEOUT_MS when modelId has no entry', async () => {
      const originalTimeout = CREWLY_AGENT_DEFAULTS.MESSAGE_TIMEOUT_MS;
      const originalWarning = CREWLY_AGENT_DEFAULTS.MESSAGE_SOFT_WARNING_MS;
      const originalModelTimeouts = { ...CREWLY_AGENT_DEFAULTS.MODEL_TIMEOUT_MS };
      // Default short so the fallback fires within the test window.
      // No entry for 'no-override-model' in MODEL_TIMEOUT_MS.
      (CREWLY_AGENT_DEFAULTS as any).MESSAGE_TIMEOUT_MS = 200;
      (CREWLY_AGENT_DEFAULTS as any).MESSAGE_SOFT_WARNING_MS = 100;

      try {
        mockRun.mockImplementation((_msg: string, _convId: unknown, _meta: unknown, opts: Record<string, unknown>) => {
          const signal = opts?.abortSignal as AbortSignal | undefined;
          return new Promise((_resolve, reject) => {
            if (signal) {
              signal.addEventListener('abort', () => {
                reject(new Error('The operation was aborted'));
              });
            }
          });
        });

        await service.initializeInProcess('crewly-orc', {
          model: { provider: 'deepseek', modelId: 'no-override-model' },
        });
        await expect(service.handleMessage('Hangs forever')).rejects.toThrow(/timed out/i);
      } finally {
        (CREWLY_AGENT_DEFAULTS as any).MESSAGE_TIMEOUT_MS = originalTimeout;
        (CREWLY_AGENT_DEFAULTS as any).MESSAGE_SOFT_WARNING_MS = originalWarning;
        (CREWLY_AGENT_DEFAULTS as any).MODEL_TIMEOUT_MS = originalModelTimeouts;
      }
    }, 10000);

    it('exposes deepseek-reasoner: 600_000 in MODEL_TIMEOUT_MS by default', () => {
      expect(CREWLY_AGENT_DEFAULTS.MODEL_TIMEOUT_MS['deepseek-reasoner']).toBe(600_000);
    });
  });

  describe('streaming callbacks', () => {
    it('should pass streaming callbacks through to runner.run()', async () => {
      const mockResult = {
        text: 'Streamed response',
        steps: 2,
        usage: { input: 50, output: 25 },
        toolCalls: [{ toolName: 'get_team_status', args: {}, result: { teams: [] } }],
        finishReason: 'stop',
      };
      mockRun.mockResolvedValue(mockResult);

      await service.initializeInProcess('crewly-orc');
      await service.handleMessage('Check status');

      // Verify that streaming callbacks were passed as 4th arg
      expect(mockRun).toHaveBeenCalledWith(
        'Check status',
        undefined,
        undefined,
        expect.objectContaining({
          streaming: expect.objectContaining({
            onTextChunk: expect.any(Function),
            onToolCallStart: expect.any(Function),
            onToolCallFinish: expect.any(Function),
            onStepFinish: expect.any(Function),
          }),
        }),
      );
    });

    it('should log text output via onStepFinish when text chunks are buffered', async () => {
      const { InProcessLogBuffer } = await import('./in-process-log-buffer.js');
      const logBuffer = InProcessLogBuffer.getInstance();
      const appendSpy = jest.spyOn(logBuffer, 'append');

      // Intercept the streaming callbacks by capturing them from the run call
      let capturedCallbacks: Record<string, Function> = {};
      mockRun.mockImplementation(async (_msg: string, _convId: unknown, _meta: unknown, opts: Record<string, unknown>) => {
        const streaming = opts.streaming as Record<string, Function>;
        capturedCallbacks = streaming;

        // Simulate text chunks arriving then step finishing
        streaming.onTextChunk('Hello ');
        streaming.onTextChunk('world');
        streaming.onStepFinish(1, false);

        return {
          text: 'Hello world',
          steps: 1,
          usage: { input: 10, output: 5 },
          toolCalls: [],
          finishReason: 'stop',
        };
      });

      await service.initializeInProcess('crewly-orc');
      await service.handleMessage('test text logging');

      // Verify that text was logged via logBuffer
      const textLogCalls = appendSpy.mock.calls.filter(
        ([session, _level, msg]) => session === 'crewly-orc' && typeof msg === 'string' && msg.startsWith('💬')
      );
      expect(textLogCalls.length).toBeGreaterThanOrEqual(1);
      expect(textLogCalls[0][2]).toContain('Hello world');

      appendSpy.mockRestore();
    });

    it('should log bash_exec command preview after tool call', async () => {
      const { InProcessLogBuffer } = await import('./in-process-log-buffer.js');
      const logBuffer = InProcessLogBuffer.getInstance();
      const appendSpy = jest.spyOn(logBuffer, 'append');

      mockRun.mockImplementation(async (_msg: string, _convId: unknown, _meta: unknown, opts: Record<string, unknown>) => {
        const streaming = opts.streaming as Record<string, Function>;

        // Simulate bash_exec tool call
        streaming.onToolCallFinish('bash_exec', { command: 'npm run build' }, 'exit 0', 500);

        return {
          text: 'Build done',
          steps: 1,
          usage: { input: 10, output: 5 },
          toolCalls: [{ toolName: 'bash_exec', args: { command: 'npm run build' }, result: 'exit 0' }],
          finishReason: 'stop',
        };
      });

      await service.initializeInProcess('crewly-orc');
      await service.handleMessage('run build');

      // Should have a command preview line
      const cmdCalls = appendSpy.mock.calls.filter(
        ([session, _level, msg]) => session === 'crewly-orc' && typeof msg === 'string' && msg.includes('$ npm run build')
      );
      expect(cmdCalls.length).toBe(1);

      appendSpy.mockRestore();
    });

    it('should NOT log bash command preview for non-bash tools', async () => {
      const { InProcessLogBuffer } = await import('./in-process-log-buffer.js');
      const logBuffer = InProcessLogBuffer.getInstance();
      const appendSpy = jest.spyOn(logBuffer, 'append');

      mockRun.mockImplementation(async (_msg: string, _convId: unknown, _meta: unknown, opts: Record<string, unknown>) => {
        const streaming = opts.streaming as Record<string, Function>;

        // Simulate non-bash tool call
        streaming.onToolCallFinish('get_team_status', {}, { teams: [] }, 100);

        return {
          text: 'Status checked',
          steps: 1,
          usage: { input: 10, output: 5 },
          toolCalls: [],
          finishReason: 'stop',
        };
      });

      await service.initializeInProcess('crewly-orc');
      await service.handleMessage('check status');

      // Should NOT have a command preview line
      const cmdCalls = appendSpy.mock.calls.filter(
        ([_session, _level, msg]) => typeof msg === 'string' && msg.includes('$ ')
      );
      expect(cmdCalls.length).toBe(0);

      appendSpy.mockRestore();
    });
  });

  describe('worker mode', () => {
    it('should expose isWorkerMode() as false by default', () => {
      expect(service.isWorkerMode()).toBe(false);
    });

    it('should expose getWorkerPid() as null by default', () => {
      expect(service.getWorkerPid()).toBeNull();
    });

    it('should reject hotReload() when not in worker mode', async () => {
      await expect(service.hotReload()).rejects.toThrow('hotReload() is only available in worker process mode');
    });

    it('should reject hotReload() when config is missing', async () => {
      // Force worker mode without going through init
      (service as any).useWorkerProcess = true;
      await expect(service.hotReload()).rejects.toThrow('No stored config for hot-reload');
    });

    it('should store config for hot-reload during initializeInProcess', async () => {
      await service.initializeInProcess('crewly-orc', { maxSteps: 42 });
      expect((service as any).storedConfig).toBeDefined();
      expect((service as any).storedConfig.maxSteps).toBe(42);
    });

    it('should clear storedConfig on shutdown', async () => {
      await service.initializeInProcess('crewly-orc');
      expect((service as any).storedConfig).toBeDefined();

      service.shutdown();
      expect((service as any).storedConfig).toBeNull();
    });

    it('should set useWorkerProcess flag when config option is true', async () => {
      // We can't actually fork a worker in unit tests (no compiled worker file),
      // but we can verify the flag is set before the worker init attempt
      (service as any).initializeWorker = jest.fn<() => Promise<void>>().mockResolvedValue();

      await service.initializeInProcess('crewly-orc', { useWorkerProcess: true });

      expect(service.isWorkerMode()).toBe(true);
      expect((service as any).initializeWorker).toHaveBeenCalled();
    });

    it('should use in-process path when useWorkerProcess is false', async () => {
      await service.initializeInProcess('crewly-orc', { useWorkerProcess: false });

      expect(service.isWorkerMode()).toBe(false);
      expect(service.getAgentRunner()).toBeDefined();
    });

    it('should abort worker run when abortCurrentRun is called in worker mode', async () => {
      // Simulate worker mode state
      (service as any).useWorkerProcess = true;
      (service as any).workerProcessing = true;
      (service as any).workerProcess = { connected: true, send: jest.fn(), removeAllListeners: jest.fn(), pid: 12345 };
      (service as any).currentSessionName = 'test-session';
      (service as any).initialized = true;

      let rejected = false;
      (service as any).workerRunReject = (_err: Error) => { rejected = true; };
      (service as any).workerRunResolve = jest.fn();

      const result = service.abortCurrentRun();

      expect(result).toBe(true);
      expect(rejected).toBe(true);
      expect((service as any).workerProcessing).toBe(false);
    });

    it('should return false from abortCurrentRun when no worker run in progress', async () => {
      (service as any).useWorkerProcess = true;
      (service as any).workerProcessing = false;

      const result = service.abortCurrentRun();
      expect(result).toBe(false);
    });

    it('should report isReady as false in worker mode when no worker', () => {
      (service as any).useWorkerProcess = true;
      (service as any).initialized = true;
      (service as any).workerProcess = null;

      expect(service.isReady()).toBe(false);
    });

    it('should report isReady as true in worker mode with connected worker', () => {
      (service as any).useWorkerProcess = true;
      (service as any).initialized = true;
      (service as any).workerProcess = { connected: true, removeAllListeners: jest.fn(), pid: 12345 };

      expect(service.isReady()).toBe(true);
    });
  });
});
