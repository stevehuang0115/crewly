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

  it('gives the active tile a strong accent in caption mode — including Home', () => {
    // Home active used to keep its neutral chip (isHome branch won over
    // isActive), so the selected state was barely visible. Active must win.
    render(
      <WorkspaceRail
        workspaces={[{ id: 'home', name: 'Home', kind: 'home' }, { id: 't1', name: 'Team One' }]}
        showLabels
        activeWorkspaceId="home"
      />,
    );
    const home = screen.getByTestId('workspace-row-home');
    // Active glyph gets the brand glow + a primary border (vs the neutral chip).
    expect(home.querySelector('.active-glow')).not.toBeNull();
    expect(home.innerHTML).toContain('border-primary');
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
    // Prototype caption rail is the narrow 84px column.
    expect(rail.className).toContain('w-[84px]');
    // The full team name is visible (not just the initials).
    expect(screen.getByText('Customer Engineering')).toBeInTheDocument();
  });

  it('renders a parent collapse chevron only in caption mode with onToggleCollapse', () => {
    // No chevron in the default (icon) layout / without the collapse handler.
    const { rerender } = render(<WorkspaceRail workspaces={fixture} showLabels />);
    expect(screen.queryByTestId('workspace-collapse-org-crewly')).not.toBeInTheDocument();
    // With showLabels (caption) AND a toggle handler, the parent gets a chevron.
    rerender(<WorkspaceRail workspaces={fixture} showLabels onToggleCollapse={() => {}} />);
    expect(screen.getByTestId('workspace-collapse-org-crewly')).toBeInTheDocument();
    // A leaf child does not get a chevron.
    expect(screen.queryByTestId('workspace-collapse-team-product')).not.toBeInTheDocument();
  });

  it('renders nested sub-teams as centred caption tiles in caption mode', () => {
    render(<WorkspaceRail workspaces={fixture} showLabels onToggleCollapse={() => {}} />);
    // Children render beneath their parent, marked data-nested=true and laid out
    // as centred caption tiles (avatar over label) so they fit the narrow rail.
    const product = screen.getByTestId('workspace-row-team-product');
    const marketing = screen.getByTestId('workspace-row-team-marketing');
    expect(product).toHaveAttribute('data-nested', 'true');
    expect(marketing).toHaveAttribute('data-nested', 'true');
    expect(product.className).toContain('flex-col');
    expect(product.className).toContain('items-center');
    // Roots/parents are not nested.
    expect(screen.getByTestId('workspace-row-org-crewly')).toHaveAttribute('data-nested', 'false');
  });

  it('hides children of a collapsed parent but keeps the parent visible', () => {
    render(
      <WorkspaceRail
        workspaces={fixture}
        showLabels
        onToggleCollapse={() => {}}
        collapsedParentIds={['org-crewly']}
      />,
    );
    expect(screen.getByTestId('workspace-row-org-crewly')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-row-team-product')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-row-team-marketing')).not.toBeInTheDocument();
  });

  it('invokes onToggleCollapse with the parent id when the chevron is clicked', async () => {
    const onToggle = vi.fn();
    render(<WorkspaceRail workspaces={fixture} showLabels onToggleCollapse={onToggle} />);
    await userEvent.click(screen.getByTestId('workspace-collapse-org-crewly'));
    expect(onToggle).toHaveBeenCalledWith('org-crewly');
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
