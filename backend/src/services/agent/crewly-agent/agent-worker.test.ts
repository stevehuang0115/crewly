/**
 * Tests for Agent Worker IPC protocol and CrewlyAgentRuntimeService worker mode.
 *
 * Tests the IPC message types and worker lifecycle without actually forking
 * a real child process (which would require full AI SDK setup).
 */

import { describe, it, expect } from '@jest/globals';
import type { ParentMessage, WorkerMessage } from './agent-worker.js';

describe('Agent Worker IPC Protocol', () => {
  describe('ParentMessage types', () => {
    it('should accept init message with config', () => {
      const msg: ParentMessage = {
        type: 'init',
        config: {
          model: { provider: 'google', modelId: 'gemini-3-flash-preview' },
          maxSteps: 500,
          sessionName: 'test-session',
          apiBaseUrl: 'http://localhost:8787',
          systemPrompt: 'You are a test agent.',
          maxHistoryMessages: 100,
          compactionThreshold: 0.8,
        },
      };
      expect(msg.type).toBe('init');
      expect(msg.config.sessionName).toBe('test-session');
      expect(msg.config.maxSteps).toBe(500);
    });

    it('should accept run message with optional fields', () => {
      const msg: ParentMessage = {
        type: 'run',
        message: 'Hello',
        conversationId: 'conv-123',
        metadata: { channelId: 'C123' },
      };
      expect(msg.type).toBe('run');
      expect(msg.message).toBe('Hello');
      expect(msg.conversationId).toBe('conv-123');
    });

    it('should accept run message without optional fields', () => {
      const msg: ParentMessage = {
        type: 'run',
        message: 'Hello',
      };
      expect(msg.type).toBe('run');
      expect(msg.conversationId).toBeUndefined();
    });

    it('should accept abort message', () => {
      const msg: ParentMessage = { type: 'abort' };
      expect(msg.type).toBe('abort');
    });

    it('should accept get-state message', () => {
      const msg: ParentMessage = { type: 'get-state' };
      expect(msg.type).toBe('get-state');
    });

    it('should accept shutdown message', () => {
      const msg: ParentMessage = { type: 'shutdown' };
      expect(msg.type).toBe('shutdown');
    });
  });

  describe('WorkerMessage types', () => {
    it('should accept ready message', () => {
      const msg: WorkerMessage = { type: 'ready' };
      expect(msg.type).toBe('ready');
    });

    it('should accept result message with AgentRunResult', () => {
      const msg: WorkerMessage = {
        type: 'result',
        data: {
          text: 'Done',
          steps: 3,
          usage: { input: 100, output: 50 },
          toolCalls: [{ toolName: 'bash_exec', args: { command: 'ls' }, result: 'files' }],
          finishReason: 'stop',
        },
      };
      expect(msg.type).toBe('result');
      expect(msg.data.steps).toBe(3);
      expect(msg.data.toolCalls).toHaveLength(1);
    });

    it('should accept error message with code', () => {
      const msg: WorkerMessage = {
        type: 'error',
        error: 'Init failed: bad API key',
        code: 'INIT_FAILED',
      };
      expect(msg.type).toBe('error');
      expect(msg.error).toContain('Init failed');
      expect(msg.code).toBe('INIT_FAILED');
    });

    it('should accept log message at all levels', () => {
      const levels: Array<'debug' | 'info' | 'warn' | 'error'> = ['debug', 'info', 'warn', 'error'];
      for (const level of levels) {
        const msg: WorkerMessage = { type: 'log', level, message: `Test ${level}` };
        expect(msg.level).toBe(level);
      }
    });

    it('should accept stream text event', () => {
      const msg: WorkerMessage = {
        type: 'stream',
        event: 'text',
        data: { chunk: 'Hello world' },
      };
      expect(msg.type).toBe('stream');
      expect(msg.event).toBe('text');
    });

    it('should accept stream toolStart event', () => {
      const msg: WorkerMessage = {
        type: 'stream',
        event: 'toolStart',
        data: { toolName: 'bash_exec', args: { command: 'npm test' } },
      };
      expect(msg.event).toBe('toolStart');
      expect(msg.data.toolName).toBe('bash_exec');
    });

    it('should accept stream toolFinish event', () => {
      const msg: WorkerMessage = {
        type: 'stream',
        event: 'toolFinish',
        data: {
          toolName: 'bash_exec',
          args: { command: 'npm test' },
          result: 'All tests passed',
          durationMs: 1234,
        },
      };
      expect(msg.event).toBe('toolFinish');
      expect(msg.data.durationMs).toBe(1234);
    });

    it('should accept stream stepFinish event', () => {
      const msg: WorkerMessage = {
        type: 'stream',
        event: 'stepFinish',
        data: { stepIndex: 2, hasToolCalls: true },
      };
      expect(msg.event).toBe('stepFinish');
      expect(msg.data.stepIndex).toBe(2);
    });

    it('should accept state message', () => {
      const msg: WorkerMessage = {
        type: 'state',
        data: {
          historyLength: 10,
          isProcessing: false,
          isInitialized: true,
        },
      };
      expect(msg.type).toBe('state');
      expect(msg.data.historyLength).toBe(10);
    });
  });
});

// Worker mode tests for CrewlyAgentRuntimeService are in
// crewly-agent-runtime.service.test.ts alongside the existing tests,
// since they share the same mock setup.
