/**
 * Tests for the Tickets board page.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { Tickets } from './Tickets';
import * as svc from '../services/tickets.service';
import type { TicketBoardResponse, TicketListItem } from '../types/ticket.types';
import { TICKETS_POLL_INTERVAL_MS, TICKETS_SEARCH_DEBOUNCE_MS } from '../constants/tickets.constants';

vi.mock('../services/tickets.service', () => ({
  fetchTickets: vi.fn(),
  fetchTicket: vi.fn(),
  verifyTicket: vi.fn(),
  rejectTicket: vi.fn(),
  dismissTicket: vi.fn(),
  setTicketAcceptance: vi.fn(),
  patchTicket: vi.fn(),
}));

const mocked = vi.mocked(svc);
const NOW = Date.parse('2026-09-24T00:00:00Z');

/**
 * Build a board row.
 *
 * @param over - Field overrides
 * @returns The row
 */
function row(over: Partial<TicketListItem>): TicketListItem {
  return {
    id: 'r', tkt: 'TKT-001', title: 't', kind: 'feature', column: 'todo', status: 'open',
    priority: 'normal', priorityLabel: 'P2', origin: null, assignee: null, workItemIds: [], tags: [],
    createdAt: '', updatedAt: '', acceptance: [], ...over,
  };
}

const BOARD: TicketBoardResponse = {
  tickets: [
    row({ id: 'a', tkt: 'TKT-001', title: '写周报', column: 'todo' }),
    row({
      id: 'b', tkt: 'TKT-002', title: '修登录按钮', kind: 'issue', column: 'to_review', status: 'waiting_confirmation',
      rejectCount: 1, reply: { at: '', by: 'crewly-atlas', messageId: 'm', excerpt: '已修复' },
      autoAcceptAt: '2026-09-27T00:00:00Z',
    }),
    row({ id: 'c', tkt: 'TKT-003', title: '做个新 logo', kind: 'idea', column: 'idea' }),
  ],
  columns: { idea: 1, todo: 1, in_progress: 0, blocked: 0, to_review: 1, done: 5 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocked.fetchTickets.mockResolvedValue(BOARD);
  mocked.fetchTicket.mockImplementation(async (id: string) => {
    const board = BOARD.tickets.find((t) => t.id === id) ?? BOARD.tickets[0];
    return { ticket: { id: board.id, title: board.title, discussion: [] }, board };
  });
  mocked.verifyTicket.mockResolvedValue({});
  mocked.rejectTicket.mockResolvedValue({});
  mocked.setTicketAcceptance.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Tickets page', () => {
  it('renders the six columns with counts and cards in the right column', async () => {
    render(<Tickets now={NOW} />);
    const review = await screen.findByTestId('tickets-column-to_review');
    const labels = ['想法', '待处理', '进行中', '阻塞', '待验收', '已完成'];
    for (const l of labels) expect(screen.getByRole('region', { name: l })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '已取消' })).toBeNull();

    expect(within(review).getByText('修登录按钮')).toBeInTheDocument();
    expect(within(review).getByText('已修复')).toBeInTheDocument();
    expect(within(review).getByText('3天后自动验收')).toBeInTheDocument();
    expect(within(review).getByText('打回 ×1')).toBeInTheDocument();
    expect(within(screen.getByTestId('tickets-column-todo')).getByText('写周报')).toBeInTheDocument();
    // Server count, not the number of rows on the page.
    expect(within(screen.getByTestId('tickets-column-done')).getByText('5')).toBeInTheDocument();
    expect(within(screen.getByTestId('tickets-column-blocked')).getByText('暂无')).toBeInTheDocument();
  });

  it('keeps horizontal scrolling inside the board container', async () => {
    render(<Tickets now={NOW} />);
    const board = await screen.findByTestId('tickets-board');
    expect(board.className).toContain('overflow-x-auto');
    expect(screen.getByTestId('tickets-column-todo').className).toContain('shrink-0');
  });

  it('shows an empty state when there are no tickets', async () => {
    mocked.fetchTickets.mockResolvedValue({ tickets: [], columns: {} });
    render(<Tickets />);
    expect(await screen.findByText('还没有工单')).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    mocked.fetchTickets.mockRejectedValue(new Error('network down'));
    render(<Tickets />);
    expect(await screen.findByText('network down')).toBeInTheDocument();
  });

  it('filters by kind', async () => {
    render(<Tickets />);
    await screen.findByTestId('tickets-board');
    fireEvent.click(screen.getByRole('radio', { name: '问题' }));
    await waitFor(() => expect(mocked.fetchTickets).toHaveBeenLastCalledWith({ kind: 'issue' }));
  });

  it('searches with q after a debounce', async () => {
    render(<Tickets />);
    await screen.findByTestId('tickets-board');
    fireEvent.change(screen.getByLabelText('搜索工单…'), { target: { value: '登录' } });
    await waitFor(() => expect(mocked.fetchTickets).toHaveBeenLastCalledWith({ q: '登录' }), {
      timeout: TICKETS_SEARCH_DEBOUNCE_MS * 5,
    });
  });

  it('polls the board', async () => {
    vi.useFakeTimers();
    render(<Tickets />);
    await act(async () => { await Promise.resolve(); });
    const before = mocked.fetchTickets.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(TICKETS_POLL_INTERVAL_MS); });
    expect(mocked.fetchTickets.mock.calls.length).toBeGreaterThan(before);
  });

  it('opens the detail drawer on a card and refreshes after 验过了', async () => {
    render(<Tickets now={NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: /TKT-002/ }));
    const drawer = await screen.findByTestId('ticket-detail-drawer');
    expect(mocked.fetchTicket).toHaveBeenCalledWith('b');
    expect(await within(drawer).findByDisplayValue('修登录按钮')).toBeInTheDocument();

    const callsBefore = mocked.fetchTickets.mock.calls.length;
    fireEvent.click(within(drawer).getByRole('button', { name: '验过了' }));
    await waitFor(() => expect(mocked.verifyTicket).toHaveBeenCalledWith('b'));
    await waitFor(() => expect(mocked.fetchTickets.mock.calls.length).toBeGreaterThan(callsBefore));
    await waitFor(() => expect(screen.queryByTestId('ticket-detail-drawer')).toBeNull());
  });

  it('打回 from the board requires a reason', async () => {
    render(<Tickets now={NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: /TKT-002/ }));
    const drawer = await screen.findByTestId('ticket-detail-drawer');
    fireEvent.click(await within(drawer).findByRole('button', { name: '打回' }));
    fireEvent.click(within(drawer).getByRole('button', { name: '确认打回' }));
    expect(await within(drawer).findByText('请填写打回原因')).toBeInTheDocument();
    expect(mocked.rejectTicket).not.toHaveBeenCalled();
  });
});
