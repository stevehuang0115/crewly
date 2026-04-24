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
});
