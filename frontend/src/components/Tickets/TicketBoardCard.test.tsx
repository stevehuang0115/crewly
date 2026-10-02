/**
 * Tests for one board card.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TicketBoardCard } from './TicketBoardCard';
import type { BoardCard } from './board.utils';

const CARD: BoardCard = {
  key: 't:a', source: 'ticket', ref: 'TKT-001', title: 'Login', fullTitle: '[Fix] Login', column: 'to_review',
  assignee: 'x', priority: 'P1', flag: { text: 'Auto-accepts soon', tone: 'attention' }, projectId: null, projectName: null,
  updatedAt: '', searchText: '',
};

describe('TicketBoardCard', () => {
  it('shows title, P0/P1 priority, assignee and the status word, and opens on click', () => {
    const onOpen = vi.fn();
    render(<TicketBoardCard card={CARD} assigneeName="Atlas" onOpen={onOpen} />);
    expect(screen.getByText('Login')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-card-priority')).toHaveTextContent('P1');
    expect(screen.getByText('Atlas')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-card-flag')).toHaveTextContent('Auto-accepts soon');
    fireEvent.click(screen.getByRole('button', { name: 'TKT-001 [Fix] Login' }));
    expect(onOpen).toHaveBeenCalledWith(CARD);
  });

  it('hides P2/P3 and says Unassigned', () => {
    render(<TicketBoardCard card={{ ...CARD, priority: 'P2', flag: null }} assigneeName={null} onOpen={() => {}} />);
    expect(screen.queryByTestId('ticket-card-priority')).toBeNull();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });
});
