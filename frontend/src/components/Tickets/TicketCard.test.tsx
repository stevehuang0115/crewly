/**
 * Tests for TicketCard.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TicketCard } from './TicketCard';
import type { TicketListItem } from '../../types/ticket.types';

const NOW = Date.parse('2026-09-24T00:00:00Z');

/**
 * Build a board row.
 *
 * @param over - Field overrides
 * @returns The row
 */
function row(over: Partial<TicketListItem> = {}): TicketListItem {
  return {
    id: 'r1', tkt: 'TKT-007', title: '修登录按钮', kind: 'issue', column: 'todo', status: 'open',
    priority: 'high', priorityLabel: 'P1', origin: null, assignee: 'crewly-atlas', workItemIds: [], tags: [],
    createdAt: '', updatedAt: '', ...over,
  };
}

describe('TicketCard', () => {
  it('shows TKT, title, P-label, kind and assignee', () => {
    render(<TicketCard ticket={row()} onOpen={vi.fn()} now={NOW} />);
    expect(screen.getByText('TKT-007')).toBeInTheDocument();
    expect(screen.getByText('修登录按钮')).toBeInTheDocument();
    expect(screen.getByText('P1')).toBeInTheDocument();
    expect(screen.getByText('问题')).toBeInTheDocument();
    expect(screen.getByText('crewly-atlas')).toBeInTheDocument();
  });

  it('shows 未分配 without an assignee', () => {
    render(<TicketCard ticket={row({ assignee: null })} onOpen={vi.fn()} />);
    expect(screen.getByText('未分配')).toBeInTheDocument();
  });

  it('in 待验收 shows the answer excerpt and the auto-accept countdown', () => {
    render(
      <TicketCard
        ticket={row({
          column: 'to_review',
          reply: { at: '', by: 'crewly-atlas', messageId: 'm', excerpt: '已经修好了' },
          autoAcceptAt: '2026-09-26T00:00:00Z',
        })}
        onOpen={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('ticket-reply-excerpt')).toHaveTextContent('已经修好了');
    expect(screen.getByTestId('ticket-auto-accept')).toHaveTextContent('2天后自动验收');
  });

  it('does not show the excerpt or countdown outside 待验收', () => {
    render(
      <TicketCard
        ticket={row({ reply: { at: '', by: 'a', messageId: 'm', excerpt: 'x' }, autoAcceptAt: '2026-09-26T00:00:00Z' })}
        onOpen={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.queryByTestId('ticket-reply-excerpt')).toBeNull();
    expect(screen.queryByTestId('ticket-auto-accept')).toBeNull();
  });

  it('shows 打回 ×N only when rejected', () => {
    const { rerender } = render(<TicketCard ticket={row({ rejectCount: 0 })} onOpen={vi.fn()} />);
    expect(screen.queryByTestId('ticket-reject-badge')).toBeNull();
    rerender(<TicketCard ticket={row({ rejectCount: 2 })} onOpen={vi.fn()} />);
    expect(screen.getByTestId('ticket-reject-badge')).toHaveTextContent('打回 ×2');
  });

  it('opens on click and on Enter', () => {
    const onOpen = vi.fn();
    const ticket = row();
    render(<TicketCard ticket={ticket} onOpen={onOpen} />);
    const card = screen.getByRole('button', { name: /TKT-007/ });
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: 'a' });
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledWith(ticket);
  });
});
