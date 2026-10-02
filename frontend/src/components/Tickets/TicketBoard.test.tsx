/**
 * Tests for the Tickets board (asks + project tickets).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TicketBoard, type TicketBoardProps } from './TicketBoard';
import * as svc from '../../services/tickets.service';
import * as projectSvc from '../../services/project-tickets.service';
import type { TicketBoardResponse, TicketListItem } from '../../types/ticket.types';
import type { ProjectTicket } from '../../types/project-ticket.types';
import type { Team } from '../../types';
import { TICKETS_SEARCH_DEBOUNCE_MS } from '../../constants/tickets.constants';

vi.mock('../../services/tickets.service', () => ({
  fetchTickets: vi.fn(),
  fetchTicket: vi.fn(),
  verifyTicket: vi.fn(),
  rejectTicket: vi.fn(),
  dismissTicket: vi.fn(),
  setTicketAcceptance: vi.fn(),
  patchTicket: vi.fn(),
}));

vi.mock('../../services/project-tickets.service', () => ({
  listAllProjectTickets: vi.fn(),
  listProjectTickets: vi.fn(),
  createProjectTicket: vi.fn(),
  updateProjectTicket: vi.fn(),
  assignProjectTicket: vi.fn(),
}));

const mocked = vi.mocked(svc);
const mockedProject = vi.mocked(projectSvc);
const NOW = Date.parse('2026-09-24T00:00:00Z');

const TEAMS = [
  {
    id: 'tt', name: 'Think Tank', projectIds: ['p1'],
    members: [{ sessionName: 'think-tank-atlas-b4', name: 'Atlas' }],
  },
] as unknown as Team[];

function row(over: Partial<TicketListItem>): TicketListItem {
  return {
    id: 'r', tkt: 'TKT-001', title: 't', kind: 'feature', column: 'todo', status: 'open',
    priority: 'normal', priorityLabel: 'P2', origin: null, assignee: null, workItemIds: [], tags: [],
    createdAt: '', updatedAt: '', acceptance: [], ...over,
  };
}

function pt(over: Partial<ProjectTicket>): ProjectTicket {
  return {
    id: 'CE-1', title: 'Project work', status: 'ready', priority: 'P2', assignee: null, team: null, labels: [],
    ownerReview: false, createdAt: '', updatedAt: '', workItemId: null, requestId: null, source: null, migratedFrom: null,
    fileName: 'CE-1.md', filePath: '', projectPath: '/ce', description: '', acceptance: [], log: [], ...over,
  };
}

const BOARD: TicketBoardResponse = {
  tickets: [
    row({ id: 'a', tkt: 'TKT-001', title: '写周报', column: 'todo', assignee: 'think-tank-atlas-b4' }),
    row({
      id: 'b', tkt: 'TKT-002', title: '[Fix] 修登录按钮', kind: 'issue', column: 'to_review', status: 'waiting_confirmation',
      rejectCount: 1, priorityLabel: 'P0', autoAcceptAt: '2026-09-27T00:00:00Z',
    }),
    row({ id: 'c', tkt: 'TKT-003', title: '做个新 logo', kind: 'idea', column: 'idea' }),
    row({ id: 'd', tkt: 'TKT-004', title: 'Shipped thing', column: 'done', acceptedBy: 'silence' }),
  ],
  columns: { idea: 1, todo: 1, in_progress: 0, blocked: 0, to_review: 1, done: 1, cancelled: 2 },
};

const PROJECTS = [
  { project: { id: 'p1', name: 'CE', path: '/ce' }, tickets: [pt({ id: 'CE-1', title: 'Project work' }), pt({ id: 'CE-2', title: 'Old idea', status: 'cancelled' })] },
  { project: { id: 'p2', name: 'Flopost', path: '/f' }, tickets: [pt({ id: 'FLO-1', title: 'Owner check', status: 'review' })] },
];

function renderBoard(props: Partial<TicketBoardProps> = {}) {
  return render(
    <MemoryRouter>
      <TicketBoard teams={TEAMS} now={NOW} pollIntervalMs={0} {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.fetchTickets.mockImplementation(async (q = {}) =>
    q.column === 'cancelled' ? { tickets: [row({ id: 'x', tkt: 'TKT-009', title: 'Dropped ask', column: 'cancelled' })], columns: {} } : BOARD,
  );
  mocked.fetchTicket.mockImplementation(async (id: string) => {
    const board = BOARD.tickets.find((t) => t.id === id) ?? BOARD.tickets[0];
    return { ticket: { id: board.id, title: board.title, discussion: [] }, board };
  });
  mocked.verifyTicket.mockResolvedValue({});
  mocked.rejectTicket.mockResolvedValue({});
  mockedProject.listAllProjectTickets.mockResolvedValue(PROJECTS);
  mockedProject.listProjectTickets.mockResolvedValue({ project: PROJECTS[0].project, tickets: PROJECTS[0].tickets, invalid: [] });
  mockedProject.createProjectTicket.mockResolvedValue(pt({}));
  mockedProject.updateProjectTicket.mockResolvedValue(pt({}));
  mockedProject.assignProjectTicket.mockResolvedValue({ ticket: pt({}) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TicketBoard', () => {
  it('puts To review first and highlighted, then In progress, To do, Blocked', async () => {
    renderBoard();
    const board = await screen.findByTestId('tickets-board');
    const sections = within(board).getAllByRole('region').map((s) => s.getAttribute('aria-label'));
    expect(sections).toEqual(['To review', 'In progress', 'To do', 'Blocked']);

    const review = screen.getByTestId('tickets-column-to_review');
    expect(review.className).toContain('bg-attention-soft');
    expect(within(review).getByText('Needs you')).toBeInTheDocument();
    // Asks and project tickets side by side; the [Fix] tag is dropped.
    expect(within(review).getByText('修登录按钮')).toBeInTheDocument();
    expect(within(review).getByText('Owner check')).toBeInTheDocument();
    expect(within(review).getByText('Auto-accepts in 3 days')).toBeInTheDocument();
    expect(within(review).getByText('P0')).toBeInTheDocument();

    const todo = screen.getByTestId('tickets-column-todo');
    expect(within(todo).getByText('写周报')).toBeInTheDocument();
    expect(within(todo).getByText('Atlas')).toBeInTheDocument();
    expect(within(todo).getByText('Project work')).toBeInTheDocument();
    // P2 is not shown.
    expect(within(todo).queryByText('P2')).toBeNull();
    expect(within(screen.getByTestId('tickets-column-blocked')).getByText('Nothing blocked')).toBeInTheDocument();
  });

  it('folds Ideas and Done into one quiet line with Show', async () => {
    renderBoard();
    const line = await screen.findByTestId('tickets-quiet-line');
    expect(line).toHaveTextContent('Ideas 1');
    expect(line).toHaveTextContent('Done 1');
    expect(screen.queryByRole('region', { name: 'Done' })).toBeNull();
    fireEvent.click(screen.getByTestId('tickets-quiet-toggle'));
    const done = screen.getByRole('region', { name: 'Done' });
    expect(within(done).getByText('Shipped thing')).toBeInTheDocument();
    expect(within(done).getByText('Auto-accepted · not reviewed')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Ideas' })).getByText('做个新 logo')).toBeInTheDocument();
  });

  it('shows five cards per column, then "Show all N"', async () => {
    mocked.fetchTickets.mockResolvedValue({
      tickets: Array.from({ length: 7 }, (_, i) => row({ id: `t${i}`, tkt: `TKT-1${i}`, title: `Todo ${i}` })),
      columns: {},
    });
    mockedProject.listAllProjectTickets.mockResolvedValue([]);
    renderBoard();
    const todo = await screen.findByTestId('tickets-column-todo');
    await waitFor(() => expect(within(todo).getAllByRole('button', { name: /TKT-1/ })).toHaveLength(5));
    fireEvent.click(within(todo).getByRole('button', { name: 'Show all 7' }));
    expect(within(todo).getAllByRole('button', { name: /TKT-1/ })).toHaveLength(7);
  });

  it('filters by project and by type behind the Filter button, with chips', async () => {
    renderBoard();
    await screen.findByTestId('tickets-board');
    fireEvent.click(screen.getByTestId('filter-button'));
    fireEvent.click(screen.getByRole('radio', { name: /Flopost/ }));
    expect(screen.getByTestId('filter-chip')).toHaveTextContent('Project: Flopost');
    expect(screen.queryByText('写周报')).toBeNull();
    expect(screen.queryByText('Project work')).toBeNull();
    expect(screen.getByText('Owner check')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Project: Flopost' }));
    // The popover is still open (the click did not leave it).
    fireEvent.click(screen.getByRole('radio', { name: 'Issue' }));
    await waitFor(() => expect(mocked.fetchTickets).toHaveBeenLastCalledWith({ kind: 'issue' }));
    // Type is an ask attribute: project tickets step aside.
    await waitFor(() => expect(screen.queryByText('Project work')).toBeNull());
  });

  it('shows cancelled tickets when asked to', async () => {
    renderBoard();
    await screen.findByTestId('tickets-board');
    fireEvent.click(screen.getByTestId('filter-button'));
    fireEvent.click(screen.getByRole('checkbox', { name: /Cancelled/ }));
    await waitFor(() => expect(mocked.fetchTickets).toHaveBeenCalledWith({ column: 'cancelled' }));
    expect(await screen.findByTestId('tickets-quiet-line')).toHaveTextContent('Cancelled 2');
    fireEvent.click(screen.getByTestId('tickets-quiet-toggle'));
    const cancelled = screen.getByRole('region', { name: 'Cancelled' });
    expect(within(cancelled).getByText('Dropped ask')).toBeInTheDocument();
    expect(within(cancelled).getByText('Old idea')).toBeInTheDocument();
  });

  it('searches asks on the server and project tickets locally', async () => {
    renderBoard();
    await screen.findByTestId('tickets-board');
    fireEvent.click(screen.getByRole('button', { name: 'Search tickets…' }));
    fireEvent.change(screen.getByTestId('tickets-search'), { target: { value: 'owner' } });
    await waitFor(() => expect(mocked.fetchTickets).toHaveBeenLastCalledWith({ q: 'owner' }), { timeout: TICKETS_SEARCH_DEBOUNCE_MS * 5 });
    await waitFor(() => expect(screen.queryByText('Project work')).toBeNull());
    expect(screen.getByText('Owner check')).toBeInTheDocument();
  });

  it('opens the ticket drawer for an ask and refreshes after Verified', async () => {
    renderBoard();
    fireEvent.click(await screen.findByRole('button', { name: /TKT-002/ }));
    const drawer = await screen.findByTestId('ticket-detail-drawer');
    expect(mocked.fetchTicket).toHaveBeenCalledWith('b');
    const before = mocked.fetchTickets.mock.calls.length;
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Verified' }));
    await waitFor(() => expect(mocked.verifyTicket).toHaveBeenCalledWith('b'));
    await waitFor(() => expect(mocked.fetchTickets.mock.calls.length).toBeGreaterThan(before));
  });

  it('Send back still requires a reason', async () => {
    renderBoard();
    fireEvent.click(await screen.findByRole('button', { name: /TKT-002/ }));
    const drawer = await screen.findByTestId('ticket-detail-drawer');
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Send back' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Confirm send back' }));
    expect(await within(drawer).findByText('Please give a reason for sending it back')).toBeInTheDocument();
    expect(mocked.rejectTicket).not.toHaveBeenCalled();
  });

  it('opens a project ticket in its editor and assigns it', async () => {
    renderBoard();
    fireEvent.click(await screen.findByRole('button', { name: /CE-1 Project work/ }));
    expect(await screen.findByText('CE-1: Project work')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: 'think-tank-atlas-b4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(mockedProject.assignProjectTicket).toHaveBeenCalledWith('p1', 'CE-1', 'think-tank-atlas-b4'));
    // Assign must not also submit (save) the form.
    expect(mockedProject.updateProjectTicket).not.toHaveBeenCalled();
  });

  it('creates a ticket from New ticket', async () => {
    renderBoard();
    await screen.findByTestId('tickets-board');
    fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Export to CSV' } });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() =>
      expect(mockedProject.createProjectTicket).toHaveBeenCalledWith('p2', expect.objectContaining({ title: 'Export to CSV', status: 'backlog' })),
    );
  });

  it('locks to one project: no asks, no project filter, its own list call', async () => {
    const onCounts = vi.fn();
    renderBoard({ projectId: 'p1', onCountsChange: onCounts });
    expect(await screen.findByText('Project work')).toBeInTheDocument();
    expect(mockedProject.listProjectTickets).toHaveBeenCalledWith('p1');
    expect(mocked.fetchTickets).not.toHaveBeenCalled();
    expect(screen.queryByText('写周报')).toBeNull();
    fireEvent.click(screen.getByTestId('filter-button'));
    expect(screen.queryByRole('radio', { name: /Flopost/ })).toBeNull();
    await waitFor(() => expect(onCounts).toHaveBeenLastCalledWith({ toReview: 0, total: 1, unfilteredTotal: 1 }));

    // Searching narrows `total`, never `unfilteredTotal` (the Tasks tab count)
    fireEvent.click(screen.getByRole('button', { name: 'Search tickets…' }));
    fireEvent.change(screen.getByTestId('tickets-search'), { target: { value: 'zzz-nothing' } });
    await waitFor(() => expect(onCounts).toHaveBeenLastCalledWith({ toReview: 0, total: 0, unfilteredTotal: 1 }));
  });

  it('shows the empty state and load errors', async () => {
    mocked.fetchTickets.mockResolvedValue({ tickets: [], columns: {} });
    mockedProject.listAllProjectTickets.mockResolvedValue([]);
    const { unmount } = renderBoard();
    expect(await screen.findByText('No tickets yet')).toBeInTheDocument();
    unmount();

    mocked.fetchTickets.mockRejectedValue(new Error('network down'));
    mockedProject.listAllProjectTickets.mockResolvedValue(PROJECTS);
    renderBoard();
    expect(await screen.findByText(/network down/)).toBeInTheDocument();
    // Project tickets still show.
    expect(screen.getByText('Project work')).toBeInTheDocument();
  });

  /**
   * Render a polling board with fake timers.
   *
   * @param props - Extra props
   */
  async function renderPolling(props: Partial<TicketBoardProps> = {}) {
    vi.useFakeTimers();
    render(
      <MemoryRouter>
        <TicketBoard teams={TEAMS} pollIntervalMs={1000} {...props} />
      </MemoryRouter>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }

  it('polls asks every tick and the all-projects listing every 4th tick', async () => {
    await renderPolling();
    expect(mocked.fetchTickets).toHaveBeenCalledTimes(1);
    expect(mockedProject.listAllProjectTickets).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(mocked.fetchTickets).toHaveBeenCalledTimes(4);
    expect(mockedProject.listAllProjectTickets).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mockedProject.listAllProjectTickets).toHaveBeenCalledTimes(2);
  });

  it('skips ticks while a slow load is in flight and still applies its reply', async () => {
    let resolveSlow: (v: TicketBoardResponse) => void = () => {};
    mocked.fetchTickets.mockImplementationOnce(() => new Promise((r) => { resolveSlow = r; }));
    await renderPolling();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    // Five ticks passed; none started a second request.
    expect(mocked.fetchTickets).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSlow({ tickets: [row({ id: 's', tkt: 'TKT-077', title: 'Slow but kept' })], columns: {} });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Slow but kept')).toBeInTheDocument();
  });

  it('drops a reply whose filters are stale', async () => {
    vi.useRealTimers();
    let resolveOld: (v: TicketBoardResponse) => void = () => {};
    mocked.fetchTickets.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    renderBoard();
    fireEvent.click(screen.getByTestId('filter-button'));
    fireEvent.click(screen.getByRole('radio', { name: 'Issue' }));
    await waitFor(() => expect(mocked.fetchTickets).toHaveBeenLastCalledWith({ kind: 'issue' }));
    expect(await screen.findByText('修登录按钮')).toBeInTheDocument();
    await act(async () => {
      resolveOld({ tickets: [row({ id: 'o', tkt: 'TKT-066', title: 'Unfiltered old reply' })], columns: {} });
    });
    expect(screen.queryByText('Unfiltered old reply')).toBeNull();
  });

  it('pauses polling while the tab is hidden and catches up when it shows', async () => {
    await renderPolling();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocked.fetchTickets).toHaveBeenCalledTimes(1);
    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocked.fetchTickets).toHaveBeenCalledTimes(2);
    hidden.mockRestore();
  });
});
