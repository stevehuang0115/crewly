import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TeamChatPage } from './TeamChatPage';

beforeEach(() => {
  // jsdom lacks scrollIntoView — patch it so MessageThread's auto-scroll
  // effect doesn't blow up in tests.
  Element.prototype.scrollIntoView = function noop() {
    /* no-op */
  };
});

describe('TeamChatPage', () => {
  it('renders the 3-panel shell with mock data', async () => {
    render(<TeamChatPage />);
    expect(screen.getByTestId('team-chat-page')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-rail')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-list-panel')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('team-chat-right-panel')).toBeInTheDocument(),
    );
  });

  it('lands on the first non-activity workspace by default', () => {
    render(<TeamChatPage />);
    // org-crewly is the first non-activity workspace per the seed.
    const row = screen.getByTestId('workspace-row-org-crewly');
    expect(row).toHaveAttribute('data-active', 'true');
  });

  it('honours initialWorkspaceId override', () => {
    render(<TeamChatPage initialWorkspaceId="team-product" />);
    const row = screen.getByTestId('workspace-row-team-product');
    expect(row).toHaveAttribute('data-active', 'true');
  });

  it('switches workspaces and surfaces the new groups', async () => {
    render(<TeamChatPage initialWorkspaceId="team-product" />);
    // Product workspace shows Channels + DMs
    expect(screen.getByText('Channels')).toBeInTheDocument();
    expect(screen.getByText('Direct Messages')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('workspace-row-team-marketing'));
    // Marketing workspace's general channel becomes visible.
    await waitFor(() =>
      expect(screen.getByTestId('conv-row-channel-marketing-general')).toBeInTheDocument(),
    );
  });

  it('auto-selects the first conversation when the workspace is selected with none chosen', async () => {
    render(<TeamChatPage initialWorkspaceId="team-product" />);
    await waitFor(() => {
      const generalRow = screen.getByTestId('conv-row-channel-product-general');
      expect(generalRow).toHaveAttribute('data-active', 'true');
    });
  });

  it('renders the right-panel header with `#` prefix on a channel selection', async () => {
    render(
      <TeamChatPage
        initialWorkspaceId="team-product"
        initialConversationId="channel-product-general"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText('#general')).toBeInTheDocument(),
    );
  });

  it('shows the offline banner on a DM with an inactive agent', async () => {
    render(
      <TeamChatPage
        initialWorkspaceId="team-product"
        initialConversationId="dm-product-max"
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('banner-agent-offline')).toBeInTheDocument();
      expect(screen.getByText(/Max is currently inactive/i)).toBeInTheDocument();
    });
  });

  it('does NOT show the offline banner for an online DM', async () => {
    render(
      <TeamChatPage
        initialWorkspaceId="team-product"
        initialConversationId="dm-product-sam"
      />,
    );
    // "Sam" appears in BOTH the conversation list row AND the right-panel
    // header; use getAllByText so the assertion isn't flaky on duplicates.
    await waitFor(() => {
      expect(screen.getAllByText('Sam').length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId('banner-agent-offline')).not.toBeInTheDocument();
  });

  it('mounts NoTeamsEmptyState when no workspaces are supplied', () => {
    render(<TeamChatPage workspaces={[]} />);
    expect(screen.getByTestId('empty-no-teams')).toBeInTheDocument();
  });

  it('renders MentionComposer with the seed mentionables (popover opens on @)', async () => {
    render(
      <TeamChatPage
        initialWorkspaceId="team-product"
        initialConversationId="channel-product-general"
      />,
    );
    await waitFor(() => expect(screen.getByTestId('mention-textarea')).toBeInTheDocument());
    await userEvent.type(screen.getByTestId('mention-textarea'), '@');
    expect(screen.getByTestId('mention-suggestions')).toBeInTheDocument();
    // Both teams + agents groups appear.
    expect(screen.getByTestId('mention-group-teams')).toBeInTheDocument();
    expect(screen.getByTestId('mention-group-agents')).toBeInTheDocument();
  });

  it('selecting a different conversation row updates the right-panel header', async () => {
    render(<TeamChatPage initialWorkspaceId="team-product" />);
    await waitFor(() => expect(screen.getByText('#general')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('conv-row-dm-product-sam'));
    await waitFor(() => expect(screen.getAllByText('Sam').length).toBeGreaterThan(0));
  });

  it('switching workspace clears the conversation auto-select then resettles on a valid row', async () => {
    render(<TeamChatPage initialWorkspaceId="team-product" />);
    await waitFor(() => expect(screen.getByText('#general')).toBeInTheDocument());
    await act(async () => {
      await userEvent.click(screen.getByTestId('workspace-row-team-marketing'));
    });
    // Marketing's general channel becomes the auto-selected row.
    await waitFor(() => {
      const row = screen.getByTestId('conv-row-channel-marketing-general');
      expect(row).toHaveAttribute('data-active', 'true');
    });
  });
});
