/**
 * Tests for AgentStreamPanel component
 *
 * @module components/ExecutionFeed/AgentStreamPanel.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentStreamPanel } from './AgentStreamPanel';
import type { UseAgentStreamResult } from '../../hooks/useAgentStream';

// Mock the useAgentStream hook
const mockUseAgentStream = vi.fn<(name: string | null) => UseAgentStreamResult>();

vi.mock('../../hooks/useAgentStream', () => ({
  useAgentStream: (name: string | null) => mockUseAgentStream(name),
}));

describe('AgentStreamPanel', () => {
  const defaultHookResult: UseAgentStreamResult = {
    entries: [],
    connected: false,
    error: null,
    currentText: '',
    clear: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAgentStream.mockReturnValue({ ...defaultHookResult });
  });

  it('should render empty state when sessionName is null', () => {
    render(<AgentStreamPanel sessionName={null} />);

    expect(screen.getByText('Select an agent to see streaming output')).toBeDefined();
    expect(screen.getByTestId('agent-stream-panel')).toBeDefined();
  });

  it('should render waiting state when connected but no entries', () => {
    mockUseAgentStream.mockReturnValue({
      ...defaultHookResult,
      connected: true,
    });

    render(<AgentStreamPanel sessionName="test-agent" />);

    expect(screen.getByText('Waiting for agent activity...')).toBeDefined();
  });

  it('should display session name in header', () => {
    mockUseAgentStream.mockReturnValue({
      ...defaultHookResult,
      connected: true,
    });

    render(<AgentStreamPanel sessionName="my-agent" />);

    expect(screen.getByText('my-agent')).toBeDefined();
  });

  it('should display stream entries', () => {
    mockUseAgentStream.mockReturnValue({
      ...defaultHookResult,
      connected: true,
      entries: [
        {
          id: 'e1',
          type: 'tool_call_finish',
          text: 'bash_exec completed (42ms)',
          detail: '"hello"',
          timestamp: new Date().toISOString(),
          toolName: 'bash_exec',
          durationMs: 42,
          inProgress: false,
        },
        {
          id: 'e2',
          type: 'text_chunk',
          text: 'Agent is thinking about the task...',
          timestamp: new Date().toISOString(),
        },
      ],
    });

    render(<AgentStreamPanel sessionName="test-agent" />);

    const entries = screen.getAllByTestId('stream-entry');
    expect(entries).toHaveLength(2);
    expect(screen.getByText('bash_exec completed (42ms)')).toBeDefined();
    expect(screen.getByText('42ms')).toBeDefined();
  });

  it('should show current streaming text', () => {
    mockUseAgentStream.mockReturnValue({
      ...defaultHookResult,
      connected: true,
      currentText: 'The agent is currently thinking...',
    });

    render(<AgentStreamPanel sessionName="test-agent" />);

    expect(screen.getByTestId('stream-current-text')).toBeDefined();
    expect(screen.getByText('The agent is currently thinking...')).toBeDefined();
    expect(screen.getByText('Thinking...')).toBeDefined();
  });

  it('should show entry count in header', () => {
    mockUseAgentStream.mockReturnValue({
      ...defaultHookResult,
      connected: true,
      entries: [
        { id: 'e1', type: 'step_finish', text: 'Step 1', timestamp: new Date().toISOString() },
        { id: 'e2', type: 'step_finish', text: 'Step 2', timestamp: new Date().toISOString() },
      ],
    });

    render(<AgentStreamPanel sessionName="test-agent" />);

    expect(screen.getByText('(2)')).toBeDefined();
  });

  it('should show clear button when entries exist', () => {
    const clearFn = vi.fn();
    mockUseAgentStream.mockReturnValue({
      ...defaultHookResult,
      connected: true,
      entries: [
        { id: 'e1', type: 'step_finish', text: 'Step 1', timestamp: new Date().toISOString() },
      ],
      clear: clearFn,
    });

    render(<AgentStreamPanel sessionName="test-agent" />);

    const clearBtn = screen.getByTestId('stream-clear');
    fireEvent.click(clearBtn);
    expect(clearFn).toHaveBeenCalledOnce();
  });

  it('should show error message', () => {
    mockUseAgentStream.mockReturnValue({
      ...defaultHookResult,
      error: 'Stream connection lost',
    });

    render(<AgentStreamPanel sessionName="test-agent" />);

    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText('Stream connection lost')).toBeDefined();
  });

  it('should show in-progress indicator for running tool calls', () => {
    mockUseAgentStream.mockReturnValue({
      ...defaultHookResult,
      connected: true,
      entries: [
        {
          id: 'e1',
          type: 'tool_call_start',
          text: 'Calling bash_exec...',
          detail: '{"command":"npm test"}',
          timestamp: new Date().toISOString(),
          toolName: 'bash_exec',
          inProgress: true,
        },
      ],
    });

    render(<AgentStreamPanel sessionName="test-agent" />);

    expect(screen.getByText('Running...')).toBeDefined();
  });

  it('should have proper ARIA attributes', () => {
    mockUseAgentStream.mockReturnValue({
      ...defaultHookResult,
      connected: true,
    });

    render(<AgentStreamPanel sessionName="test-agent" />);

    const panel = screen.getByTestId('agent-stream-panel');
    expect(panel.getAttribute('role')).toBe('log');
    expect(panel.getAttribute('aria-live')).toBe('polite');
    expect(panel.getAttribute('aria-label')).toContain('test-agent');
  });
});
