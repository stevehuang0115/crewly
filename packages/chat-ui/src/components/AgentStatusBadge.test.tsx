import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatAPIProvider } from '../context/ChatAPIProvider';
import { MockChatApiClient } from '../api/mock-client';
import { AgentStatusBadge } from './AgentStatusBadge';

describe('AgentStatusBadge', () => {
  it('renders the given explicit status with label text', () => {
    render(
      <ChatAPIProvider mode="mock">
        <AgentStatusBadge status="online" />
      </ChatAPIProvider>,
    );
    expect(screen.getByTestId('agent-status-badge')).toHaveAttribute('data-status', 'online');
    expect(screen.getAllByText(/online/i).length).toBeGreaterThan(0);
  });

  it('respects `compact` by hiding the visible label (keeping sr-only)', () => {
    render(
      <ChatAPIProvider mode="mock">
        <AgentStatusBadge status="busy" compact />
      </ChatAPIProvider>,
    );
    // sr-only copy is still in the DOM for a11y.
    expect(screen.getByText('Busy')).toHaveClass('sr-only');
  });

  it('falls back to `offline` when no status and no agent are supplied', () => {
    const client = new MockChatApiClient();
    render(
      <ChatAPIProvider mode="mock" client={client}>
        <AgentStatusBadge />
      </ChatAPIProvider>,
    );
    expect(screen.getByTestId('agent-status-badge')).toHaveAttribute('data-status', 'offline');
  });

  // ---------------------------------------------------------------------------
  // Slack-like vocabulary additions (design §8.1, sealed 2026-04-25).
  // Additive: existing wire-status callers keep working; new callers may pass
  // `idle` / `inactive` directly.
  // ---------------------------------------------------------------------------

  it('accepts `idle` from the team-chat vocabulary and labels it Idle', () => {
    render(
      <ChatAPIProvider mode="mock">
        <AgentStatusBadge status="idle" />
      </ChatAPIProvider>,
    );
    expect(screen.getByTestId('agent-status-badge')).toHaveAttribute('data-status', 'idle');
    // Label appears twice: visible + sr-only — both should read "Idle".
    const labels = screen.getAllByText('Idle');
    expect(labels.length).toBeGreaterThanOrEqual(1);
  });

  it('accepts `inactive` from the team-chat vocabulary and labels it Inactive', () => {
    render(
      <ChatAPIProvider mode="mock">
        <AgentStatusBadge status="inactive" />
      </ChatAPIProvider>,
    );
    expect(screen.getByTestId('agent-status-badge')).toHaveAttribute('data-status', 'inactive');
    const labels = screen.getAllByText('Inactive');
    expect(labels.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps `busy` distinct from `idle` so wire-vocabulary callers are not lost', () => {
    const { rerender } = render(
      <ChatAPIProvider mode="mock">
        <AgentStatusBadge status="busy" />
      </ChatAPIProvider>,
    );
    expect(screen.getByTestId('agent-status-badge')).toHaveAttribute('data-status', 'busy');
    rerender(
      <ChatAPIProvider mode="mock">
        <AgentStatusBadge status="idle" />
      </ChatAPIProvider>,
    );
    expect(screen.getByTestId('agent-status-badge')).toHaveAttribute('data-status', 'idle');
  });
});
