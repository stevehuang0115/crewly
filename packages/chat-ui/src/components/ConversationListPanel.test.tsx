import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationGroup } from '../types/team-chat.types';
import { ChatAPIProvider } from '../context/ChatAPIProvider';
import { ConversationListPanel } from './ConversationListPanel';

const baseGroups: ConversationGroup[] = [
  {
    id: 'channels',
    label: 'Channels',
    rows: [
      {
        id: 'c-general',
        kind: 'channel',
        title: 'general',
        lastMessagePreview: 'kicking off Phase A',
        lastMessageAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        unreadCount: 0,
      },
      {
        id: 'c-proj-onboarding',
        kind: 'channel',
        title: 'proj-onboarding',
        unreadCount: 3,
      },
    ],
  },
  {
    id: 'dms',
    label: 'Direct Messages',
    rows: [
      {
        id: 'dm-sam',
        kind: 'dm',
        title: 'Sam',
        presence: 'online',
        agentSession: 'crewly-product-sam-dd2b46f7',
        unreadCount: 1,
        mentionCount: 1,
      },
      {
        id: 'dm-max',
        kind: 'dm',
        title: 'Max',
        presence: 'inactive',
      },
    ],
  },
];

function renderPanel(props: Partial<React.ComponentProps<typeof ConversationListPanel>> = {}) {
  return render(
    <ChatAPIProvider mode="mock">
      <ConversationListPanel groups={baseGroups} {...props} />
    </ChatAPIProvider>,
  );
}

describe('ConversationListPanel', () => {
  it('renders the workspace header when supplied', () => {
    renderPanel({ workspaceName: 'Crewly Product' });
    expect(screen.getByText('Crewly Product')).toBeInTheDocument();
  });

  it('renders group section headings', () => {
    renderPanel();
    expect(screen.getByText('Channels')).toBeInTheDocument();
    expect(screen.getByText('Direct Messages')).toBeInTheDocument();
  });

  it('renders channel rows with a `#` icon', () => {
    renderPanel();
    expect(screen.getByTestId('conv-icon-c-general')).toHaveTextContent('#');
    expect(screen.getByTestId('conv-icon-c-proj-onboarding')).toHaveTextContent('#');
  });

  it('renders DM rows with derived initials and a presence dot', () => {
    renderPanel();
    expect(screen.getByTestId('conv-icon-dm-sam')).toHaveTextContent('SA');
    // Presence dot uses AgentStatusBadge under the hood; data-status comes through.
    const samRow = screen.getByTestId('conv-row-dm-sam');
    expect(samRow.querySelector('[data-status="online"]')).not.toBeNull();
  });

  it('shows a mention pill when mentionCount>0 (overrides unread pill)', () => {
    renderPanel();
    // Sam has unreadCount=1 AND mentionCount=1 — mention wins.
    expect(screen.getByTestId('conv-mention-pill-dm-sam')).toBeInTheDocument();
    expect(screen.queryByTestId('conv-unread-pill-dm-sam')).not.toBeInTheDocument();
  });

  it('shows an unread pill when only unreadCount>0', () => {
    renderPanel();
    expect(screen.getByTestId('conv-unread-pill-c-proj-onboarding')).toHaveTextContent('3');
  });

  it('marks the active row with data-active=true and aria-current', () => {
    renderPanel({ activeConversationId: 'c-general' });
    const row = screen.getByTestId('conv-row-c-general');
    expect(row).toHaveAttribute('data-active', 'true');
    expect(row).toHaveAttribute('aria-current', 'page');
  });

  it('invokes onSelectConversation with the row on click', async () => {
    const onSelect = vi.fn();
    renderPanel({ onSelectConversation: onSelect });
    await userEvent.click(screen.getByTestId('conv-row-dm-max'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: 'dm-max', kind: 'dm' });
  });

  it('uses bold title styling on rows with unread', () => {
    renderPanel();
    // Title span carries either font-semibold (unread) or no font weight (read).
    const titleNode = screen.getByText('proj-onboarding');
    expect(titleNode.className).toMatch(/font-semibold/);
    const readTitleNode = screen.getByText('general');
    expect(readTitleNode.className).not.toMatch(/font-semibold/);
  });

  it('renders the empty state when every group has zero rows', () => {
    renderPanel({
      groups: [
        { id: 'channels', label: 'Channels', rows: [] },
        { id: 'dms', label: 'Direct Messages', rows: [] },
      ],
    });
    expect(screen.getByText(/No conversations in this workspace/)).toBeInTheDocument();
  });

  it('honours a custom emptyState node', () => {
    renderPanel({
      groups: [{ id: 'channels', label: 'Channels', rows: [] }],
      emptyState: <span data-testid="custom-empty">Custom CTA here</span>,
    });
    expect(screen.getByTestId('custom-empty')).toBeInTheDocument();
  });

  it('hides empty groups so the panel does not render dead headings', () => {
    renderPanel({
      groups: [
        { id: 'channels', label: 'Channels', rows: baseGroups[0].rows },
        { id: 'dms', label: 'Direct Messages', rows: [] },
      ],
    });
    expect(screen.getByText('Channels')).toBeInTheDocument();
    expect(screen.queryByText('Direct Messages')).not.toBeInTheDocument();
  });
});
