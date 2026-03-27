/**
 * Tests for useAgentStream hook
 *
 * @module hooks/useAgentStream.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentStream } from './useAgentStream';

/**
 * Mock EventSource implementation for testing
 */
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    // Simulate async open
    setTimeout(() => this.onopen?.(), 0);
  }

  close() {
    this.closed = true;
  }

  /** Helper to simulate receiving an SSE message */
  simulateMessage(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  /** Helper to simulate an error */
  simulateError() {
    this.onerror?.();
  }

  static reset() {
    MockEventSource.instances = [];
  }
}

// Install mock
const OriginalEventSource = globalThis.EventSource;

describe('useAgentStream', () => {
  beforeEach(() => {
    MockEventSource.reset();
    (globalThis as any).EventSource = MockEventSource;
  });

  afterEach(() => {
    (globalThis as any).EventSource = OriginalEventSource;
  });

  it('should not create EventSource when sessionName is null', () => {
    renderHook(() => useAgentStream(null));
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('should create EventSource with correct URL', () => {
    renderHook(() => useAgentStream('my-agent'));
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/agents/my-agent/stream');
  });

  it('should set connected=true after onopen', async () => {
    const { result } = renderHook(() => useAgentStream('my-agent'));

    // Initially not connected
    expect(result.current.connected).toBe(false);

    // Simulate open
    await act(async () => {
      MockEventSource.instances[0].onopen?.();
    });

    expect(result.current.connected).toBe(true);
  });

  it('should ignore heartbeat and connected events', () => {
    const { result } = renderHook(() => useAgentStream('my-agent'));
    const es = MockEventSource.instances[0];

    act(() => {
      es.simulateMessage({ type: 'connected', sessionName: 'my-agent', timestamp: new Date().toISOString() });
      es.simulateMessage({ type: 'heartbeat', sessionName: 'my-agent', timestamp: new Date().toISOString() });
    });

    expect(result.current.entries).toHaveLength(0);
  });

  it('should accumulate text_chunk into currentText', () => {
    const { result } = renderHook(() => useAgentStream('my-agent'));
    const es = MockEventSource.instances[0];

    act(() => {
      es.simulateMessage({ type: 'text_chunk', sessionName: 'my-agent', text: 'Hello ', timestamp: new Date().toISOString() });
      es.simulateMessage({ type: 'text_chunk', sessionName: 'my-agent', text: 'world', timestamp: new Date().toISOString() });
    });

    expect(result.current.currentText).toBe('Hello world');
    // text_chunk doesn't create entries (too noisy)
    expect(result.current.entries).toHaveLength(0);
  });

  it('should create entry for tool_call_start with inProgress=true', () => {
    const { result } = renderHook(() => useAgentStream('my-agent'));
    const es = MockEventSource.instances[0];

    act(() => {
      es.simulateMessage({
        type: 'tool_call_start',
        sessionName: 'my-agent',
        toolName: 'bash_exec',
        argsPreview: '{"command":"ls"}',
        timestamp: new Date().toISOString(),
      });
    });

    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].type).toBe('tool_call_start');
    expect(result.current.entries[0].toolName).toBe('bash_exec');
    expect(result.current.entries[0].inProgress).toBe(true);
  });

  it('should update tool_call_start entry on tool_call_finish', () => {
    const { result } = renderHook(() => useAgentStream('my-agent'));
    const es = MockEventSource.instances[0];

    act(() => {
      es.simulateMessage({
        type: 'tool_call_start',
        sessionName: 'my-agent',
        toolName: 'bash_exec',
        argsPreview: '{"command":"ls"}',
        timestamp: new Date().toISOString(),
      });
    });

    const startEntryId = result.current.entries[0].id;

    act(() => {
      es.simulateMessage({
        type: 'tool_call_finish',
        sessionName: 'my-agent',
        toolName: 'bash_exec',
        argsPreview: '{"command":"ls"}',
        resultPreview: '"file1\\nfile2"',
        durationMs: 42,
        timestamp: new Date().toISOString(),
      });
    });

    // Same entry should be updated (not a new one added)
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].id).toBe(startEntryId);
    expect(result.current.entries[0].inProgress).toBe(false);
    expect(result.current.entries[0].durationMs).toBe(42);
  });

  it('should create step_finish entry and flush text', () => {
    const { result } = renderHook(() => useAgentStream('my-agent'));
    const es = MockEventSource.instances[0];

    act(() => {
      es.simulateMessage({ type: 'text_chunk', sessionName: 'my-agent', text: 'Some thinking text', timestamp: new Date().toISOString() });
    });

    expect(result.current.currentText).toBe('Some thinking text');

    act(() => {
      es.simulateMessage({
        type: 'step_finish',
        sessionName: 'my-agent',
        stepIndex: 1,
        hasToolCalls: false,
        timestamp: new Date().toISOString(),
      });
    });

    // Text should be flushed to an entry
    expect(result.current.currentText).toBe('');
    // Should have text entry + step entry
    const textEntry = result.current.entries.find(e => e.type === 'text_chunk');
    const stepEntry = result.current.entries.find(e => e.type === 'step_finish');
    expect(textEntry).toBeDefined();
    expect(textEntry!.text).toBe('Some thinking text');
    expect(stepEntry).toBeDefined();
    expect(stepEntry!.text).toContain('Step 1');
  });

  it('should clear entries and text on clear()', () => {
    const { result } = renderHook(() => useAgentStream('my-agent'));
    const es = MockEventSource.instances[0];

    act(() => {
      es.simulateMessage({ type: 'text_chunk', sessionName: 'my-agent', text: 'hello', timestamp: new Date().toISOString() });
      es.simulateMessage({
        type: 'tool_call_start',
        sessionName: 'my-agent',
        toolName: 'test',
        argsPreview: '{}',
        timestamp: new Date().toISOString(),
      });
    });

    expect(result.current.entries.length).toBeGreaterThan(0);
    expect(result.current.currentText).not.toBe('');

    act(() => {
      result.current.clear();
    });

    expect(result.current.entries).toHaveLength(0);
    expect(result.current.currentText).toBe('');
  });

  it('should set error on connection failure', () => {
    const { result } = renderHook(() => useAgentStream('my-agent'));
    const es = MockEventSource.instances[0];

    act(() => {
      es.simulateError();
    });

    expect(result.current.connected).toBe(false);
    expect(result.current.error).toContain('Stream connection lost');
  });

  it('should close EventSource on unmount', () => {
    const { unmount } = renderHook(() => useAgentStream('my-agent'));
    const es = MockEventSource.instances[0];

    unmount();

    expect(es.closed).toBe(true);
  });

  it('should close EventSource when sessionName changes to null', () => {
    const { rerender } = renderHook(
      ({ name }) => useAgentStream(name),
      { initialProps: { name: 'my-agent' as string | null } },
    );

    const es = MockEventSource.instances[0];
    expect(es.closed).toBe(false);

    rerender({ name: null });

    expect(es.closed).toBe(true);
  });
});
