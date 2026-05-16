/**
 * Agents page tests.
 *
 * Focus: the page mounts the shared chat-ui components, defaults to real
 * mode, and renders the header + AgentDirectory rail. Deep directory
 * behavior lives in `AgentDirectory.test.tsx`; deep chat behavior lives
 * in `@crewly/chat-ui`'s own test suite — duplicating either here would
 * be noise.
 *
 * @module pages/Agents.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chat-ui exports so we can assert wiring (mode/backendURL) without
// pulling in the real implementation (which would fire network/timer
// calls on every render).
vi.mock('@crewly/chat-ui', () => {
  return {
    ChatAPIProvider: ({
      children,
      mode,
      backendURL,
    }: {
      children: React.ReactNode;
      mode: string;
      backendURL?: string;
    }) => (
      <div
        data-testid="chat-provider"
        data-mode={mode}
        data-backend-url={backendURL ?? ''}
      >
        {children}
      </div>
    ),
    MessageThread: () => <div data-testid="message-thread" />,
    MessageInput: () => <div data-testid="message-input" />,
    AgentStatusBadge: () => <div data-testid="agent-status-badge" />,
  };
});

// Mock AgentDirectory so this suite is just about the page-level wiring.
vi.mock('../components/Chat/AgentDirectory', () => ({
  AgentDirectory: () => <div data-testid="agent-directory" />,
}));

import { Agents } from './Agents';

describe('Agents page', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders the page header and description', () => {
    render(<Agents />);
    expect(screen.getByRole('heading', { name: /agents/i })).toBeInTheDocument();
    expect(
      screen.getByText(/direct chat with your agents/i),
    ).toBeInTheDocument();
  });

  it('mounts AgentDirectory, MessageThread, and MessageInput', () => {
    render(<Agents />);
    expect(screen.getByTestId('agent-directory')).toBeInTheDocument();
    expect(screen.getByTestId('message-thread')).toBeInTheDocument();
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
  });

  it('defaults to real mode when VITE_CHAT_MODE is unset', () => {
    vi.stubEnv('VITE_CHAT_MODE', '');
    render(<Agents />);
    expect(screen.getByTestId('chat-provider')).toHaveAttribute(
      'data-mode',
      'real',
    );
  });

  it('falls back to mock mode when VITE_CHAT_MODE=mock', () => {
    vi.stubEnv('VITE_CHAT_MODE', 'mock');
    render(<Agents />);
    expect(screen.getByTestId('chat-provider')).toHaveAttribute(
      'data-mode',
      'mock',
    );
  });

  it('shows the "Mock mode" banner only in mock mode', () => {
    vi.stubEnv('VITE_CHAT_MODE', 'mock');
    const { unmount } = render(<Agents />);
    expect(screen.getByRole('note')).toHaveTextContent(/mock mode/i);
    unmount();

    vi.stubEnv('VITE_CHAT_MODE', 'real');
    render(<Agents />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('populates backendURL from window.location.origin in real mode', () => {
    vi.stubEnv('VITE_CHAT_MODE', 'real');
    render(<Agents />);
    expect(
      screen.getByTestId('chat-provider').getAttribute('data-backend-url'),
    ).toMatch(/^http/);
  });

  it('prefers VITE_CHAT_BACKEND_URL override over window origin', () => {
    vi.stubEnv('VITE_CHAT_MODE', 'real');
    vi.stubEnv('VITE_CHAT_BACKEND_URL', 'https://chat.example.com/');
    render(<Agents />);
    expect(screen.getByTestId('chat-provider')).toHaveAttribute(
      'data-backend-url',
      'https://chat.example.com',
    );
  });

  it('renders the empty placeholder when no agent is selected', () => {
    render(<Agents />);
    expect(
      screen.getByText(/select an agent to start chatting/i),
    ).toBeInTheDocument();
  });
});
