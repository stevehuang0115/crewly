import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Workspace } from '../types/team-chat.types';
import { WorkspaceRail } from './WorkspaceRail';

const fixture: Workspace[] = [
  { id: 'activity', name: 'All DMs', kind: 'activity', unreadCount: 2 },
  { id: 'org-crewly', name: 'Crewly' },
  { id: 'team-product', name: 'Crewly Product', parentId: 'org-crewly', presence: 'online' },
  { id: 'team-marketing', name: 'Crewly Marketing', parentId: 'org-crewly', unreadCount: 5, hasMentions: true },
];

describe('WorkspaceRail', () => {
  it('renders all workspaces with derived initials', () => {
    render(<WorkspaceRail workspaces={fixture} />);
    // Initials: "All DMs" → "AD", "Crewly" → "CR", "Crewly Product" → "CP".
    expect(screen.getByText('AD')).toBeInTheDocument();
    expect(screen.getByText('CR')).toBeInTheDocument();
    expect(screen.getByText('CP')).toBeInTheDocument();
  });

  it('honours an explicit initials override on a workspace', () => {
    render(
      <WorkspaceRail
        workspaces={[{ id: 'team-x', name: 'Crewly Product', initials: 'CX' }]}
      />,
    );
    expect(screen.getByText('CX')).toBeInTheDocument();
  });

  it('orders children directly after their parent', () => {
    render(<WorkspaceRail workspaces={fixture} />);
    const rows = screen.getAllByRole('button');
    // Order: activity, org-crewly, team-product (child), team-marketing (child).
    expect(rows[0]).toHaveAttribute('data-testid', 'workspace-row-activity');
    expect(rows[1]).toHaveAttribute('data-testid', 'workspace-row-org-crewly');
    expect(rows[2]).toHaveAttribute('data-testid', 'workspace-row-team-product');
    expect(rows[3]).toHaveAttribute('data-testid', 'workspace-row-team-marketing');
    // Children have data-nested=true so the renderer can indent them.
    expect(rows[2]).toHaveAttribute('data-nested', 'true');
    expect(rows[3]).toHaveAttribute('data-nested', 'true');
  });

  it('shows a mention dot when hasMentions=true', () => {
    render(<WorkspaceRail workspaces={fixture} />);
    expect(screen.getByTestId('workspace-mention-team-marketing')).toBeInTheDocument();
    // Marketing has both unreadCount AND mentions — mention dot wins, no unread dot.
    expect(screen.queryByTestId('workspace-unread-team-marketing')).not.toBeInTheDocument();
  });

  it('shows an unread dot when unreadCount>0 and no mentions', () => {
    render(<WorkspaceRail workspaces={fixture} />);
    expect(screen.getByTestId('workspace-unread-activity')).toBeInTheDocument();
  });

  it('shows a presence dot only when there is no unread', () => {
    render(<WorkspaceRail workspaces={fixture} />);
    // team-product has presence:online and no unread — presence dot wins.
    expect(screen.getByTestId('workspace-presence-team-product')).toBeInTheDocument();
  });

  it('marks the active workspace with data-active=true and aria-current', () => {
    render(<WorkspaceRail workspaces={fixture} activeWorkspaceId="team-product" />);
    const row = screen.getByTestId('workspace-row-team-product');
    expect(row).toHaveAttribute('data-active', 'true');
    expect(row).toHaveAttribute('aria-current', 'page');
  });

  it('invokes onSelectWorkspace with the full workspace on click', async () => {
    const onSelect = vi.fn();
    render(<WorkspaceRail workspaces={fixture} onSelectWorkspace={onSelect} />);
    await userEvent.click(screen.getByTestId('workspace-row-team-marketing'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: 'team-marketing', hasMentions: true });
  });

  it('renders the empty state when no workspaces are supplied', () => {
    render(<WorkspaceRail workspaces={[]} />);
    expect(screen.getByText(/No teams yet/)).toBeInTheDocument();
  });

  it('renders labels in expanded mode and only initials in collapsed mode', () => {
    const { rerender } = render(<WorkspaceRail workspaces={fixture} />);
    expect(screen.queryByText('Crewly Product')).not.toBeInTheDocument();
    rerender(<WorkspaceRail workspaces={fixture} expanded />);
    expect(screen.getByText('Crewly Product')).toBeInTheDocument();
  });

  it('places orphan children (unmatched parentId) at the end', () => {
    render(
      <WorkspaceRail
        workspaces={[
          { id: 'a', name: 'Alpha' },
          { id: 'orphan', name: 'Orphan', parentId: 'missing-parent' },
          { id: 'b', name: 'Beta' },
        ]}
      />,
    );
    const rows = screen.getAllByRole('button');
    expect(rows[0]).toHaveAttribute('data-testid', 'workspace-row-a');
    expect(rows[1]).toHaveAttribute('data-testid', 'workspace-row-b');
    expect(rows[2]).toHaveAttribute('data-testid', 'workspace-row-orphan');
  });

  it('renders a home workspace with its avatar glyph + tooltip override', () => {
    render(
      <WorkspaceRail
        workspaces={[
          { id: 'home', name: 'Home', kind: 'home', avatar: '\u{1F3E0}', tooltip: 'Home — orchestrator & pinned' },
          { id: 'orc', name: 'Orchestrator', kind: 'team', avatar: '\u{1F9ED}' },
        ]}
      />,
    );
    const home = screen.getByTestId('workspace-row-home');
    expect(home).toHaveAttribute('data-kind', 'home');
    expect(home).toHaveAttribute('title', 'Home — orchestrator & pinned');
    expect(home).toHaveTextContent('\u{1F3E0}');
    // Avatar replaces derived initials on the orchestrator too.
    expect(screen.getByTestId('workspace-row-orc')).toHaveTextContent('\u{1F9ED}');
  });


  it('renders icon-with-caption labels in showLabels mode', () => {
    render(
      <WorkspaceRail
        workspaces={[{ id: 'team-x', name: 'Customer Engineering', initials: 'CE' }]}
        showLabels
      />,
    );
    const rail = screen.getByTestId('workspace-rail');
    expect(rail).toHaveAttribute('data-labelled', 'true');
    expect(rail.className).toContain('w-24');
    // The full team name is visible (not just the initials).
    expect(screen.getByText('Customer Engineering')).toBeInTheDocument();
  });

  it('renders a host-injected icon node over avatar/initials', () => {
    render(
      <WorkspaceRail
        workspaces={[
          {
            id: 'home',
            name: 'Home',
            kind: 'home',
            icon: <svg data-testid="home-icon" />,
            avatar: '\u{1F3E0}',
          },
        ]}
        showLabels
      />,
    );
    // The vector icon renders; the emoji avatar is NOT used when icon is present.
    expect(screen.getByTestId('home-icon')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-row-home')).not.toHaveTextContent('\u{1F3E0}');
  });

});
