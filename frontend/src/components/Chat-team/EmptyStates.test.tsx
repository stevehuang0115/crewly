import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AgentOfflineBanner,
  NoChannelsEmptyState,
  NoMessagesEmptyState,
  NoTeamsEmptyState,
} from './EmptyStates';

describe('Chat-team EmptyStates', () => {
  it('NoTeamsEmptyState surfaces the §9.1 copy + CTA', () => {
    render(<NoTeamsEmptyState />);
    expect(screen.getByTestId('empty-no-teams')).toBeInTheDocument();
    expect(screen.getByText(/No teams yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open team builder/i })).toBeInTheDocument();
  });

  it('NoChannelsEmptyState personalises by team name and exposes 3 quick actions', () => {
    render(<NoChannelsEmptyState teamName="Crewly Product" />);
    expect(screen.getByTestId('empty-no-channels')).toBeInTheDocument();
    expect(screen.getByText(/Crewly Product has no conversations/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Message team lead/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open project channel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start DM/i })).toBeInTheDocument();
  });

  it('NoMessagesEmptyState renders channel-specific copy when kind=channel', () => {
    render(<NoMessagesEmptyState kind="channel" />);
    expect(screen.getByTestId('empty-no-messages-channel')).toBeInTheDocument();
    expect(screen.getByText(/project coordination and handoffs/i)).toBeInTheDocument();
  });

  it('NoMessagesEmptyState renders DM-specific copy with the recipient name when kind=dm', () => {
    render(<NoMessagesEmptyState kind="dm" recipientName="Sam" />);
    expect(screen.getByTestId('empty-no-messages-dm')).toBeInTheDocument();
    expect(screen.getByText(/Start a private chat with Sam/i)).toBeInTheDocument();
    expect(screen.getByText(/notify Sam without broadcasting/i)).toBeInTheDocument();
  });

  it('NoMessagesEmptyState DM variant falls back gracefully without recipientName', () => {
    render(<NoMessagesEmptyState kind="dm" />);
    expect(screen.getByText(/Start a private chat$/i)).toBeInTheDocument();
    expect(screen.getByText(/notify this agent/i)).toBeInTheDocument();
  });

  it('AgentOfflineBanner explains activate-on-send without disabling the composer', () => {
    render(<AgentOfflineBanner agentName="Max" />);
    expect(screen.getByTestId('banner-agent-offline')).toBeInTheDocument();
    expect(screen.getByText(/Max is currently inactive/i)).toBeInTheDocument();
    expect(screen.getByText(/will activate/i)).toBeInTheDocument();
  });
});
