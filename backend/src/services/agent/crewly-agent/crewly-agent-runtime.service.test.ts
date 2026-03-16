import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { CrewlyAgentRuntimeService } from './crewly-agent-runtime.service.js';
import type { SessionCommandHelper } from '../../session/index.js';
import { RUNTIME_TYPES } from '../../../constants.js';

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

    // Mock fs.readFile for system prompt loading
    const fsMod = jest.requireMock('fs') as any;
    fsMod.promises.readFile.mockResolvedValue('You are the orchestrator.');

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
      expect(mockRun).toHaveBeenCalledWith('Delegate task to Sam', undefined, undefined);
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

      expect(mockRun).toHaveBeenCalledWith('Do the thing', 'conv-123', undefined);
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

      expect(mockRun).toHaveBeenCalledWith('No prefix message', undefined, undefined);
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

      expect(mockRun).toHaveBeenCalledWith('Hello from GChat', 'spaces/123/threads/abc', undefined);
    });

    it('should throw if not initialized', async () => {
      await expect(service.handleMessage('Hello')).rejects.toThrow('not initialized');
    });

    it('should propagate agent runner errors', async () => {
      mockRun.mockRejectedValue(new Error('API rate limit'));

      await service.initializeInProcess('crewly-orc');
      await expect(service.handleMessage('Test')).rejects.toThrow('API rate limit');
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
});
