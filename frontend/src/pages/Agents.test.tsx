/**
 * Agents page tests.
 *
 * Focus: the page mounts the shared chat-ui components, defaults to mock
 * mode, and renders the header + layout scaffold. Deep behavior lives in
 * `@crewly/chat-ui`'s own test suite — duplicating it here would be noise.
 *
 * @module pages/Agents.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The chat-ui package is imported by `./Agents`. We mock each named export
// so we can assert wiring (e.g. which mode/backendURL the provider gets)
// without pulling in the real implementation (which fetches channels via
// the mock client's timers and would slow every test file).
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
    ChannelList: () => <div data-testid="channel-list" />,
    MessageThread: () => <div data-testid="message-thread" />,
    MessageInput: () => <div data-testid="message-input" />,
    AgentStatusBadge: () => <div data-testid="agent-status-badge" />,
  };
});

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

  it('mounts ChannelList, MessageThread, and MessageInput', () => {
    render(<Agents />);
    expect(screen.getByTestId('channel-list')).toBeInTheDocument();
    expect(screen.getByTestId('message-thread')).toBeInTheDocument();
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
  });

  it('defaults to mock mode when VITE_CHAT_MODE is unset', () => {
    vi.stubEnv('VITE_CHAT_MODE', '');
    render(<Agents />);
    expect(screen.getByTestId('chat-provider')).toHaveAttribute(
      'data-mode',
      'mock',
    );
  });

  it('shows the "Mock mode" banner when running against the stub', () => {
    vi.stubEnv('VITE_CHAT_MODE', '');
    render(<Agents />);
    const banner = screen.getByRole('note');
    expect(banner).toHaveTextContent(/mock mode/i);
  });

  it('switches to real mode when VITE_CHAT_MODE=real', () => {
    vi.stubEnv('VITE_CHAT_MODE', 'real');
    render(<Agents />);
    const provider = screen.getByTestId('chat-provider');
    expect(provider).toHaveAttribute('data-mode', 'real');
    // `backendURL` should be populated — jsdom sets location.origin to
    // http://localhost by default.
    expect(provider.getAttribute('data-backend-url')).toMatch(/^http/);
  });

  it('does not render the mock banner in real mode', () => {
    vi.stubEnv('VITE_CHAT_MODE', 'real');
    render(<Agents />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
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

  it('renders without a selected channel (null channelId path)', () => {
    render(<Agents />);
    expect(screen.getByText(/no channel selected/i)).toBeInTheDocument();
  });
});
