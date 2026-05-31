/**
 * Tests for TeamListItem — the list-view team row and its overflow actions.
 *
 * @module components/Teams/TeamListItem.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { TeamListItem } from './TeamListItem';
import type { Team } from '@/types';

// Render the overflow menu items as buttons so item wiring is testable.
vi.mock('@/components/UI/OverflowMenu', () => ({
  OverflowMenu: ({ items = [] }: { items?: Array<{ label: string; onClick?: () => void }> }) => (
    <div data-testid="overflow-menu">
      {items.map((item) => (
        <button key={item.label} onClick={item.onClick}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('@/components/common/MemberAvatar', () => ({
  MemberAvatar: ({ name }: { name: string }) => <div data-testid={`avatar-${name}`}>{name}</div>,
}));

function createTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-1',
    name: 'Test Team',
    members: [],
    projectIds: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('TeamListItem', () => {
  it('renders the team name', () => {
    render(<TeamListItem team={createTeam()} />);
    expect(screen.getByText('Test Team')).toBeInTheDocument();
  });

  it('calls onClick when the row body is clicked', () => {
    const onClick = vi.fn();
    render(<TeamListItem team={createTeam()} onClick={onClick} />);
    fireEvent.click(screen.getByText('Test Team'));
    expect(onClick).toHaveBeenCalled();
  });

  it('renders Open Chat / Open Wiki items and fires their callbacks with the team id', () => {
    const onOpenChat = vi.fn();
    const onOpenWiki = vi.fn();
    render(
      <TeamListItem team={createTeam({ id: 'abc' })} onOpenChat={onOpenChat} onOpenWiki={onOpenWiki} />,
    );

    fireEvent.click(screen.getByText('Open Chat'));
    expect(onOpenChat).toHaveBeenCalledWith('abc');

    fireEvent.click(screen.getByText('Open Wiki'));
    expect(onOpenWiki).toHaveBeenCalledWith('abc');
  });

  it('omits the Chat/Wiki items when no callbacks are provided', () => {
    render(<TeamListItem team={createTeam()} />);
    expect(screen.queryByText('Open Chat')).not.toBeInTheDocument();
    expect(screen.queryByText('Open Wiki')).not.toBeInTheDocument();
  });
});
