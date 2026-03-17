/**
 * E2E Integration Tests — Crewly Agent Runtime
 *
 * Tests the full message pipeline: CrewlyAgentRuntimeService → RateLimiter →
 * AgentRunnerService → generateText (mocked) → tool calls → response routing.
 *
 * Validates:
 * 1. Consecutive 3+ messages all receive responses
 * 2. Different conversationIds are correctly routed
 * 3. Slack/Chat response routing works end-to-end
 * 4. Error recovery and initialization edge cases
 *
 * @module tests/crewly-agent-e2e-integration
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { CrewlyAgentRuntimeService } from './crewly-agent-runtime.service.js';
import { AgentRunnerService } from './agent-runner.service.js';
import type { SessionCommandHelper } from '../../session/index.js';
import type { AgentRunResult } from './types.js';

// Mock LoggerService
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

// Mock fs/promises
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

// Mock ModelManager to avoid real SDK imports
jest.mock('./model-manager.js', () => ({
  ModelManager: jest.fn().mockImplementation(() => ({
    getModel: jest.fn<any>().mockResolvedValue({ modelId: 'test-model' }),
    getAvailableProviders: jest.fn<any>().mockResolvedValue({ google: true }),
    clearCache: jest.fn(),
  })),
}));

// Mock ApiClient
jest.mock('./api-client.js', () => ({
  CrewlyApiClient: jest.fn().mockImplementation(() => ({
    get: jest.fn<any>().mockResolvedValue({}),
    post: jest.fn<any>().mockResolvedValue({}),
  })),
}));

// Mock TracingService
jest.mock('../../core/tracing.service.js', () => ({
  TracingService: {
    getInstance: () => ({
      withSpan: jest.fn<any>().mockImplementation(
        (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn()
      ),
    }),
  },
}));

// Mock ContextFlushService
jest.mock('../../memory/context-flush.service.js', () => ({
  ContextFlushService: {
    getInstance: () => ({
      extract: jest.fn<any>().mockReturnValue([]),
    }),
  },
}));

// Mock tool-registry (return minimal tools)
jest.mock('./tool-registry.js', () => ({
  createTools: jest.fn<any>().mockReturnValue({}),
}));

// Mock MCP
jest.mock('../../mcp-client.js', () => ({
  McpClientService: jest.fn(),
}));
jest.mock('./mcp-tool-bridge.js', () => ({
  connectAndLoadMcpTools: jest.fn<any>().mockResolvedValue({ tools: {}, errors: new Map() }),
}));

// Mock ApprovalQueueService
jest.mock('./approval-queue.service.js', () => ({
  ApprovalQueueService: {
    getInstance: () => ({
      enqueue: jest.fn(),
      getPending: jest.fn<any>().mockReturnValue([]),
    }),
  },
}));

// Mock SettingsService for ModelManager
jest.mock('../../settings/settings.service.js', () => ({
  getSettingsService: () => ({
    getApiKey: jest.fn<any>().mockResolvedValue('test-key'),
  }),
}));

/**
 * Create a mock generateText function that returns predictable responses.
 * Each call gets a unique response based on the user message content.
 */
function createMockGenerateText() {
  let callCount = 0;
  return jest.fn<any>().mockImplementation(async (opts: Record<string, unknown>) => {
    callCount++;
    const messages = opts.messages as Array<{ role: string; content: string }>;
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const userContent = lastUserMsg?.content || '';

    return {
      text: `Response #${callCount} to: ${userContent.substring(0, 50)}`,
      steps: [{ toolCalls: [], toolResults: [] }],
      usage: { inputTokens: 100 * callCount, outputTokens: 50 * callCount },
      finishReason: 'stop',
    };
  });
}

describe('Crewly Agent E2E Integration', () => {
  let runtime: CrewlyAgentRuntimeService;
  let mockSessionHelper: jest.Mocked<SessionCommandHelper>;
  const projectRoot = '/test/project';

  beforeEach(async () => {
    jest.clearAllMocks();

    mockSessionHelper = {
      capturePane: jest.fn<any>(),
      sendMessage: jest.fn<any>(),
      clearCurrentCommandLine: jest.fn<any>(),
    } as any;

    // Mock fs.readFile for system prompt
    const fsMod = jest.requireMock('fs') as any;
    fsMod.promises.readFile.mockResolvedValue('You are a test orchestrator.');

    runtime = new CrewlyAgentRuntimeService(mockSessionHelper, projectRoot);
  });

  afterEach(() => {
    runtime.shutdown();
  });

  /**
   * Helper: initialize runtime and inject mock generateText.
   */
  async function initWithMockGenerate(mockFn?: jest.Mock<any>): Promise<jest.Mock<any>> {
    await runtime.initializeInProcess('test-session');
    const runner = runtime.getAgentRunner()!;
    const mockGen = mockFn || createMockGenerateText();
    runner._generateTextFn = mockGen;
    return mockGen;
  }

  // =========================================================================
  // Test 1: Consecutive 3+ messages all get responses
  // =========================================================================
  describe('consecutive message handling (3+ messages)', () => {
    it('should respond to 3 consecutive messages sequentially', async () => {
      const mockGen = await initWithMockGenerate();

      const r1 = await runtime.handleMessage('First message');
      const r2 = await runtime.handleMessage('Second message');
      const r3 = await runtime.handleMessage('Third message');

      expect(r1.text).toContain('Response #1');
      expect(r1.text).toContain('First message');
      expect(r2.text).toContain('Response #2');
      expect(r2.text).toContain('Second message');
      expect(r3.text).toContain('Response #3');
      expect(r3.text).toContain('Third message');

      // Each message should have been processed individually
      expect(mockGen).toHaveBeenCalledTimes(3);
    });

    it('should respond to 5 consecutive messages without dropping any', async () => {
      const mockGen = await initWithMockGenerate();
      const responses: AgentRunResult[] = [];

      for (let i = 1; i <= 5; i++) {
        const result = await runtime.handleMessage(`Message ${i}`);
        responses.push(result);
      }

      expect(responses).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(responses[i].text).toContain(`Response #${i + 1}`);
        expect(responses[i].text).toContain(`Message ${i + 1}`);
        expect(responses[i].steps).toBeGreaterThan(0);
        expect(responses[i].usage.input).toBeGreaterThan(0);
        expect(responses[i].usage.output).toBeGreaterThan(0);
      }

      expect(mockGen).toHaveBeenCalledTimes(5);
    }, 30000);

    it('should accumulate conversation history across messages', async () => {
      await initWithMockGenerate();

      await runtime.handleMessage('First');
      await runtime.handleMessage('Second');
      const r3 = await runtime.handleMessage('Third');

      // History should contain: 3 user messages + assistant responses
      const runner = runtime.getAgentRunner()!;
      const history = runner.getHistoryLength();
      // 3 user messages + up to 3 assistant responses (depends on generateText text output)
      expect(history).toBeGreaterThanOrEqual(3);
    });

    it('should handle interleaved system and user messages', async () => {
      const mockGen = await initWithMockGenerate();

      const r1 = await runtime.handleMessage('[CHAT:conv-1] User says hello');
      const r2 = await runtime.handleMessage('System event: agent status changed');
      const r3 = await runtime.handleMessage('[CHAT:conv-1] User says goodbye');

      expect(r1.text).toBeDefined();
      expect(r2.text).toBeDefined();
      expect(r3.text).toBeDefined();
      expect(mockGen).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // Test 2: Different conversationId routing
  // =========================================================================
  describe('conversationId routing', () => {
    it('should extract different conversationIds from [CHAT:xxx] prefix', async () => {
      const mockGen = await initWithMockGenerate();

      // Track what conversationId is passed to run()
      const runner = runtime.getAgentRunner()!;
      const originalRun = runner.run.bind(runner);
      const runCalls: Array<{ msg: string; convId?: string }> = [];
      runner.run = jest.fn<any>().mockImplementation(
        async (msg: string, convId?: string, meta?: Record<string, string>) => {
          runCalls.push({ msg, convId });
          return originalRun(msg, convId, meta);
        }
      );

      await runtime.handleMessage('[CHAT:conv-alpha] Hello from Alpha');
      await runtime.handleMessage('[CHAT:conv-beta] Hello from Beta');
      await runtime.handleMessage('[CHAT:conv-alpha] Alpha again');

      expect(runCalls).toHaveLength(3);
      expect(runCalls[0]).toEqual({ msg: 'Hello from Alpha', convId: 'conv-alpha' });
      expect(runCalls[1]).toEqual({ msg: 'Hello from Beta', convId: 'conv-beta' });
      expect(runCalls[2]).toEqual({ msg: 'Alpha again', convId: 'conv-alpha' });
    });

    it('should extract conversationId from [GCHAT:xxx ...] prefix', async () => {
      await initWithMockGenerate();

      const runner = runtime.getAgentRunner()!;
      const runCalls: Array<{ msg: string; convId?: string }> = [];
      const originalRun = runner.run.bind(runner);
      runner.run = jest.fn<any>().mockImplementation(
        async (msg: string, convId?: string, meta?: Record<string, string>) => {
          runCalls.push({ msg, convId });
          return originalRun(msg, convId, meta);
        }
      );

      await runtime.handleMessage('[GCHAT:spaces/123/threads/abc thread=xyz] Google Chat message');

      expect(runCalls).toHaveLength(1);
      expect(runCalls[0].convId).toBe('spaces/123/threads/abc');
      expect(runCalls[0].msg).toBe('Google Chat message');
    });

    it('should pass undefined conversationId for unprefixed messages', async () => {
      await initWithMockGenerate();

      const runner = runtime.getAgentRunner()!;
      const runCalls: Array<{ msg: string; convId?: string }> = [];
      const originalRun = runner.run.bind(runner);
      runner.run = jest.fn<any>().mockImplementation(
        async (msg: string, convId?: string, meta?: Record<string, string>) => {
          runCalls.push({ msg, convId });
          return originalRun(msg, convId, meta);
        }
      );

      await runtime.handleMessage('Plain message without prefix');

      expect(runCalls[0].convId).toBeUndefined();
      expect(runCalls[0].msg).toBe('Plain message without prefix');
    });

    it('should handle mixed prefixed and unprefixed messages', async () => {
      await initWithMockGenerate();

      const runner = runtime.getAgentRunner()!;
      const runCalls: Array<{ msg: string; convId?: string }> = [];
      const originalRun = runner.run.bind(runner);
      runner.run = jest.fn<any>().mockImplementation(
        async (msg: string, convId?: string, meta?: Record<string, string>) => {
          runCalls.push({ msg, convId });
          return originalRun(msg, convId, meta);
        }
      );

      await runtime.handleMessage('[CHAT:web-1] From web');
      await runtime.handleMessage('System notification');
      await runtime.handleMessage('[GCHAT:spaces/x thread=t] From GChat');
      await runtime.handleMessage('[CHAT:web-2] From another web conv');

      expect(runCalls).toHaveLength(4);
      expect(runCalls[0].convId).toBe('web-1');
      expect(runCalls[1].convId).toBeUndefined();
      expect(runCalls[2].convId).toBe('spaces/x');
      expect(runCalls[3].convId).toBe('web-2');
    });
  });

  // =========================================================================
  // Test 3: Slack and Chat response routing metadata
  // =========================================================================
  describe('Slack and Chat metadata routing', () => {
    it('should pass Slack metadata through to agent runner', async () => {
      await initWithMockGenerate();

      const slackMetadata = {
        channelId: 'C0123456',
        threadTs: '1234567890.123456',
      };

      const result = await runtime.handleMessage('Slack message', slackMetadata);
      expect(result.text).toBeDefined();

      // Verify the agent runner received the Slack context
      const runner = runtime.getAgentRunner()!;
      const slackCtx = runner.getSlackContext();
      expect(slackCtx).toEqual({
        channelId: 'C0123456',
        threadTs: '1234567890.123456',
      });
    });

    it('should update Slack context with each new Slack message', async () => {
      await initWithMockGenerate();

      await runtime.handleMessage('Msg 1', { channelId: 'C111', threadTs: 'ts1' });
      const runner = runtime.getAgentRunner()!;
      expect(runner.getSlackContext()).toEqual({ channelId: 'C111', threadTs: 'ts1' });

      await runtime.handleMessage('Msg 2', { channelId: 'C222', threadTs: 'ts2' });
      expect(runner.getSlackContext()).toEqual({ channelId: 'C222', threadTs: 'ts2' });
    });

    it('should not overwrite Slack context for non-Slack messages', async () => {
      await initWithMockGenerate();

      await runtime.handleMessage('Slack msg', { channelId: 'C111', threadTs: 'ts1' });
      await runtime.handleMessage('Web message without metadata');

      const runner = runtime.getAgentRunner()!;
      // Slack context should persist from previous Slack message
      expect(runner.getSlackContext()).toEqual({ channelId: 'C111', threadTs: 'ts1' });
    });

    it('should handle Telegram metadata routing', async () => {
      await initWithMockGenerate();

      const telegramMeta = { chatId: '12345', messageId: '67890' };
      const result = await runtime.handleMessage('Telegram message', telegramMeta);
      expect(result.text).toBeDefined();
    });
  });

  // =========================================================================
  // Test 4: Error recovery and edge cases
  // =========================================================================
  describe('error recovery', () => {
    it('should throw on message before initialization', async () => {
      await expect(runtime.handleMessage('Too early')).rejects.toThrow('not initialized');
    });

    it('should recover from a failed message and process the next one', async () => {
      let callCount = 0;
      const mockGen = jest.fn<any>().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Transient API error');
        }
        return {
          text: `Success #${callCount}`,
          steps: [{ toolCalls: [], toolResults: [] }],
          usage: { inputTokens: 100, outputTokens: 50 },
          finishReason: 'stop',
        };
      });

      await initWithMockGenerate(mockGen);

      const r1 = await runtime.handleMessage('First');
      expect(r1.text).toBe('Success #1');

      await expect(runtime.handleMessage('Second (will fail)')).rejects.toThrow('Transient API error');

      const r3 = await runtime.handleMessage('Third (should recover)');
      expect(r3.text).toBe('Success #3');
    });

    it('should handle rapid consecutive messages after initialization', async () => {
      const mockGen = await initWithMockGenerate();

      // Send 3 messages as fast as possible (sequential but no delay)
      const results = await Promise.all([
        runtime.handleMessage('Rapid 1'),
        runtime.handleMessage('Rapid 2'),
        runtime.handleMessage('Rapid 3'),
      ]);

      // All should complete successfully (rate limiter may coalesce)
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.text).toBeDefined();
        expect(r.steps).toBeGreaterThan(0);
      }
    });

    it('should not accept messages after shutdown', async () => {
      await initWithMockGenerate();
      runtime.shutdown();

      await expect(runtime.handleMessage('After shutdown')).rejects.toThrow('not initialized');
    });
  });

  // =========================================================================
  // Test 5: Initialization edge cases
  // =========================================================================
  describe('initialization edge cases', () => {
    it('should clean up on initialization failure', async () => {
      // Make ModelManager.getModel() reject — this will cause AgentRunner.initialize() to throw
      const mockModelManager = jest.requireMock('./model-manager.js') as any;
      const originalImpl = mockModelManager.ModelManager;

      mockModelManager.ModelManager = jest.fn().mockImplementation(() => ({
        getModel: jest.fn<any>().mockRejectedValue(new Error('Model load failed')),
        getAvailableProviders: jest.fn<any>().mockResolvedValue({}),
        clearCache: jest.fn(),
      }));

      const failRuntime = new CrewlyAgentRuntimeService(mockSessionHelper, projectRoot);

      await expect(failRuntime.initializeInProcess('fail-session')).rejects.toThrow('Model load failed');

      // State should be clean after failure
      expect(failRuntime.isReady()).toBe(false);
      expect(failRuntime.getAgentRunner()).toBeNull();
      expect(failRuntime.getSessionName()).toBeNull();

      // Restore
      mockModelManager.ModelManager = originalImpl;
    });

    it('should support re-initialization after shutdown', async () => {
      await initWithMockGenerate();
      const r1 = await runtime.handleMessage('Before shutdown');
      expect(r1.text).toBeDefined();

      runtime.shutdown();
      expect(runtime.isReady()).toBe(false);

      // Re-initialize
      const mockGen2 = await initWithMockGenerate();
      const r2 = await runtime.handleMessage('After re-init');
      expect(r2.text).toBeDefined();
    });
  });

  // =========================================================================
  // Test 6: Token usage tracking across messages
  // =========================================================================
  describe('token usage accumulation', () => {
    it('should accumulate token usage across 3 messages', async () => {
      await initWithMockGenerate();

      await runtime.handleMessage('Msg 1');
      await runtime.handleMessage('Msg 2');
      await runtime.handleMessage('Msg 3');

      const runner = runtime.getAgentRunner()!;
      const state = runner.getState();

      // Mock returns 100*n input and 50*n output per call
      // Total: (100+200+300) input = 600, (50+100+150) output = 300
      expect(state.totalTokens.input).toBe(600);
      expect(state.totalTokens.output).toBe(300);
    });
  });
});
