/**
 * Agent Stream Service
 *
 * Singleton EventEmitter that broadcasts structured streaming events from
 * in-process Crewly Agent runtimes. SSE endpoints subscribe to this service
 * to forward real-time agent output to the frontend Dashboard.
 *
 * Event types:
 * - text_chunk: Incremental text from the model
 * - tool_call_start: A tool call has started executing
 * - tool_call_finish: A tool call completed (with result and duration)
 * - step_finish: A reasoning step completed
 *
 * @module services/agent/crewly-agent/agent-stream
 */

import { EventEmitter } from 'events';

/**
 * Streaming event types emitted to SSE clients
 */
export type StreamEventType =
  | 'text_chunk'
  | 'tool_call_start'
  | 'tool_call_finish'
  | 'step_finish'
  | 'connected'
  | 'heartbeat';

/**
 * Base shape for all stream events
 */
export interface StreamEvent {
  /** Event type */
  type: StreamEventType;
  /** Agent session name */
  sessionName: string;
  /** ISO timestamp */
  timestamp: string;
}

/**
 * Text chunk event — incremental model output
 */
export interface TextChunkEvent extends StreamEvent {
  type: 'text_chunk';
  /** Text content */
  text: string;
}

/**
 * Tool call start event
 */
export interface ToolCallStartEvent extends StreamEvent {
  type: 'tool_call_start';
  /** Name of the tool being called */
  toolName: string;
  /** Arguments passed to the tool (serialized preview) */
  argsPreview: string;
}

/**
 * Tool call finish event
 */
export interface ToolCallFinishEvent extends StreamEvent {
  type: 'tool_call_finish';
  /** Name of the tool that completed */
  toolName: string;
  /** Arguments passed to the tool (serialized preview) */
  argsPreview: string;
  /** Result preview (truncated) */
  resultPreview: string;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Step finish event — a reasoning step completed
 */
export interface StepFinishEvent extends StreamEvent {
  type: 'step_finish';
  /** Step index (1-based) */
  stepIndex: number;
  /** Whether this step included tool calls */
  hasToolCalls: boolean;
}

/**
 * Union of all stream event types
 */
export type AgentStreamEvent =
  | TextChunkEvent
  | ToolCallStartEvent
  | ToolCallFinishEvent
  | StepFinishEvent;

/** Maximum preview length for serialized args/results */
const MAX_PREVIEW_LENGTH = 200;

/**
 * Singleton service that broadcasts agent streaming events.
 *
 * Runtime services call emit methods when streaming callbacks fire.
 * SSE endpoints subscribe via the EventEmitter 'stream' event.
 *
 * @example
 * ```typescript
 * const streamService = AgentStreamService.getInstance();
 *
 * // Publish events (from runtime)
 * streamService.emitTextChunk('my-agent', 'Hello ');
 *
 * // Subscribe (from SSE endpoint)
 * streamService.on('stream', (event: AgentStreamEvent) => {
 *   if (event.sessionName === targetSession) {
 *     res.write(`data: ${JSON.stringify(event)}\n\n`);
 *   }
 * });
 * ```
 */
export class AgentStreamService extends EventEmitter {
  private static instance: AgentStreamService | null = null;

  /**
   * Get the singleton instance.
   *
   * @returns Shared AgentStreamService instance
   */
  static getInstance(): AgentStreamService {
    if (!AgentStreamService.instance) {
      AgentStreamService.instance = new AgentStreamService();
    }
    return AgentStreamService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    if (AgentStreamService.instance) {
      AgentStreamService.instance.removeAllListeners();
    }
    AgentStreamService.instance = null;
  }

  /**
   * Emit a text chunk event.
   *
   * @param sessionName - Agent session name
   * @param text - Text content
   */
  emitTextChunk(sessionName: string, text: string): void {
    const event: TextChunkEvent = {
      type: 'text_chunk',
      sessionName,
      timestamp: new Date().toISOString(),
      text,
    };
    this.emit('stream', event);
  }

  /**
   * Emit a tool call start event.
   *
   * @param sessionName - Agent session name
   * @param toolName - Name of the tool
   * @param args - Tool arguments
   */
  emitToolCallStart(sessionName: string, toolName: string, args: Record<string, unknown>): void {
    const event: ToolCallStartEvent = {
      type: 'tool_call_start',
      sessionName,
      timestamp: new Date().toISOString(),
      toolName,
      argsPreview: JSON.stringify(args).substring(0, MAX_PREVIEW_LENGTH),
    };
    this.emit('stream', event);
  }

  /**
   * Emit a tool call finish event.
   *
   * @param sessionName - Agent session name
   * @param toolName - Name of the tool
   * @param args - Tool arguments
   * @param result - Tool execution result
   * @param durationMs - Execution time in milliseconds
   */
  emitToolCallFinish(
    sessionName: string,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    durationMs: number,
  ): void {
    const event: ToolCallFinishEvent = {
      type: 'tool_call_finish',
      sessionName,
      timestamp: new Date().toISOString(),
      toolName,
      argsPreview: JSON.stringify(args).substring(0, MAX_PREVIEW_LENGTH),
      resultPreview: result ? JSON.stringify(result).substring(0, MAX_PREVIEW_LENGTH) : 'void',
      durationMs,
    };
    this.emit('stream', event);
  }

  /**
   * Emit a step finish event.
   *
   * @param sessionName - Agent session name
   * @param stepIndex - Step number (1-based)
   * @param hasToolCalls - Whether the step included tool calls
   */
  emitStepFinish(sessionName: string, stepIndex: number, hasToolCalls: boolean): void {
    const event: StepFinishEvent = {
      type: 'step_finish',
      sessionName,
      timestamp: new Date().toISOString(),
      stepIndex,
      hasToolCalls,
    };
    this.emit('stream', event);
  }
}
