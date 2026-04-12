/**
 * Tests for AgentStreamService
 *
 * @module services/agent/crewly-agent/agent-stream.service.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  AgentStreamService,
  type AgentStreamEvent,
  type TextChunkEvent,
  type ToolCallStartEvent,
  type ToolCallFinishEvent,
  type StepFinishEvent,
} from './agent-stream.service.js';

describe('AgentStreamService', () => {
  beforeEach(() => {
    AgentStreamService.resetInstance();
  });

  it('should return the same singleton instance', () => {
    const a = AgentStreamService.getInstance();
    const b = AgentStreamService.getInstance();
    expect(a).toBe(b);
  });

  it('should return a new instance after reset', () => {
    const a = AgentStreamService.getInstance();
    AgentStreamService.resetInstance();
    const b = AgentStreamService.getInstance();
    expect(a).not.toBe(b);
  });

  describe('emitTextChunk', () => {
    it('should emit a text_chunk event with correct shape', () => {
      const service = AgentStreamService.getInstance();
      const handler = jest.fn();
      service.on('stream', handler);

      service.emitTextChunk('test-agent', 'Hello ');

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0] as TextChunkEvent;
      expect(event.type).toBe('text_chunk');
      expect(event.sessionName).toBe('test-agent');
      expect(event.text).toBe('Hello ');
      expect(event.timestamp).toBeDefined();
    });
  });

  describe('emitToolCallStart', () => {
    it('should emit a tool_call_start event with args preview', () => {
      const service = AgentStreamService.getInstance();
      const handler = jest.fn();
      service.on('stream', handler);

      service.emitToolCallStart('test-agent', 'bash_exec', { command: 'ls -la' });

      const event = handler.mock.calls[0][0] as ToolCallStartEvent;
      expect(event.type).toBe('tool_call_start');
      expect(event.toolName).toBe('bash_exec');
      expect(event.argsPreview).toContain('ls -la');
    });

    it('should truncate long args to 200 chars', () => {
      const service = AgentStreamService.getInstance();
      const handler = jest.fn();
      service.on('stream', handler);

      const longArg = 'x'.repeat(300);
      service.emitToolCallStart('test-agent', 'write_file', { content: longArg });

      const event = handler.mock.calls[0][0] as ToolCallStartEvent;
      expect(event.argsPreview.length).toBeLessThanOrEqual(200);
    });
  });

  describe('emitToolCallFinish', () => {
    it('should emit a tool_call_finish event with duration', () => {
      const service = AgentStreamService.getInstance();
      const handler = jest.fn();
      service.on('stream', handler);

      service.emitToolCallFinish('test-agent', 'bash_exec', { command: 'pwd' }, '/home/user', 42);

      const event = handler.mock.calls[0][0] as ToolCallFinishEvent;
      expect(event.type).toBe('tool_call_finish');
      expect(event.toolName).toBe('bash_exec');
      expect(event.resultPreview).toContain('/home/user');
      expect(event.durationMs).toBe(42);
    });

    it('should handle null result gracefully', () => {
      const service = AgentStreamService.getInstance();
      const handler = jest.fn();
      service.on('stream', handler);

      service.emitToolCallFinish('test-agent', 'send_message', {}, null, 10);

      const event = handler.mock.calls[0][0] as ToolCallFinishEvent;
      expect(event.resultPreview).toBe('void');
    });
  });

  describe('emitStepFinish', () => {
    it('should emit a step_finish event', () => {
      const service = AgentStreamService.getInstance();
      const handler = jest.fn();
      service.on('stream', handler);

      service.emitStepFinish('test-agent', 3, true);

      const event = handler.mock.calls[0][0] as StepFinishEvent;
      expect(event.type).toBe('step_finish');
      expect(event.stepIndex).toBe(3);
      expect(event.hasToolCalls).toBe(true);
    });
  });

  describe('multiple subscribers', () => {
    it('should deliver events to all subscribers', () => {
      const service = AgentStreamService.getInstance();
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      service.on('stream', handler1);
      service.on('stream', handler2);

      service.emitTextChunk('test-agent', 'hello');

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should filter by sessionName at subscriber level', () => {
      const service = AgentStreamService.getInstance();
      const agentAEvents: AgentStreamEvent[] = [];
      const agentBEvents: AgentStreamEvent[] = [];

      service.on('stream', (event: AgentStreamEvent) => {
        if (event.sessionName === 'agent-a') agentAEvents.push(event);
        if (event.sessionName === 'agent-b') agentBEvents.push(event);
      });

      service.emitTextChunk('agent-a', 'hello');
      service.emitTextChunk('agent-b', 'world');
      service.emitTextChunk('agent-a', '!');

      expect(agentAEvents).toHaveLength(2);
      expect(agentBEvents).toHaveLength(1);
    });
  });
});
