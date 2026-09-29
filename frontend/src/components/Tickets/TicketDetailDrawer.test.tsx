/**
 * Tests for TicketDetailDrawer.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TicketDetailDrawer } from './TicketDetailDrawer';
import * as svc from '../../services/tickets.service';
import { TicketApiError, type TicketDetailResponse, type TicketListItem } from '../../types/ticket.types';

vi.mock('../../services/tickets.service', () => ({
  fetchTicket: vi.fn(),
  verifyTicket: vi.fn(),
  rejectTicket: vi.fn(),
  dismissTicket: vi.fn(),
  setTicketAcceptance: vi.fn(),
  patchTicket: vi.fn(),
}));

const NOW = Date.parse('2026-09-24T00:00:00Z');

/**
 * Build a detail response.
 *
 * @param over - Board row overrides
 * @returns The response
 */
function detail(over: Partial<TicketListItem> = {}): TicketDetailResponse {
  const board: TicketListItem = {
    id: 'req-1', tkt: 'TKT-007', title: '修登录按钮', description: '按钮点了没反应', kind: 'issue',
    column: 'to_review', status: 'waiting_confirmation', priority: 'high', priorityLabel: 'P1',
    origin: { channel: 'slack-dm', author: 'U1', authorName: 'Steve' }, assignee: 'crewly-atlas',
    workItemIds: [], tags: [], createdAt: '', updatedAt: '',
    acceptance: [{ text: '按钮可点击', source: 'decompose', check: 'auto' }],
    reply: { at: '2026-09-23T10:00:00Z', by: 'crewly-atlas', messageId: 'm1', excerpt: '已修复，原因是事件没绑定' },
    rejectCount: 1, submitCount: 2, autoAcceptAt: '2026-09-27T00:00:00Z',
    ...over,
  };
  return {
    ticket: { id: board.id, title: board.title, discussion: [{ at: '2026-09-23T09:00:00Z', author: 'Steve', text: '还有手机上也不行', ref: 'r' }] },
    board,
  };
}

const mocked = vi.mocked(svc);

/**
 * Render the drawer open on `req-1`.
 *
 * @returns Callbacks
 */
function renderDrawer(): { onClose: ReturnType<typeof vi.fn>; onChanged: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(<TicketDetailDrawer ticketId="req-1" onClose={onClose} onChanged={onChanged} now={NOW} />);
  return { onClose, onChanged };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.fetchTicket.mockResolvedValue(detail());
  mocked.verifyTicket.mockResolvedValue({});
  mocked.rejectTicket.mockResolvedValue({});
  mocked.dismissTicket.mockResolvedValue({});
  mocked.setTicketAcceptance.mockResolvedValue({});
  mocked.patchTicket.mockResolvedValue({});
});

describe('TicketDetailDrawer', () => {
  it('renders nothing when closed', () => {
    render(<TicketDetailDrawer ticketId={null} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.queryByTestId('ticket-detail-drawer')).toBeNull();
    expect(mocked.fetchTicket).not.toHaveBeenCalled();
  });

  it('loads and shows the ticket detail', async () => {
    renderDrawer();
    expect(await screen.findByDisplayValue('修登录按钮')).toBeInTheDocument();
    expect(mocked.fetchTicket).toHaveBeenCalledWith('req-1');
    expect(screen.getByText('TKT-007')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-origin')).toHaveTextContent('Slack DM · Steve');
    expect(screen.getByText('按钮点了没反应')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-reply')).toHaveTextContent('已修复，原因是事件没绑定');
    expect(screen.getByTestId('ticket-reply')).toHaveTextContent('crewly-atlas');
    expect(screen.getByTestId('ticket-discussion')).toHaveTextContent('还有手机上也不行');
    expect(screen.getByText('按钮可点击')).toBeInTheDocument();
    expect(screen.getByText('Auto-accepts in 3 days')).toBeInTheDocument();
    expect(screen.getByText('Sent back ×1')).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    mocked.fetchTicket.mockRejectedValue(new TicketApiError('Ticket not found: req-1', 404));
    renderDrawer();
    expect(await screen.findByText('Ticket not found: req-1')).toBeInTheDocument();
  });

  it('Verified calls verify, refreshes the board and closes', async () => {
    const { onClose, onChanged } = renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: 'Verified' }));
    await waitFor(() => expect(mocked.verifyTicket).toHaveBeenCalledWith('req-1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('Send back requires a reason before calling the server', async () => {
    const { onChanged } = renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: 'Send back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm send back' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Please give a reason for sending it back');
    fireEvent.change(screen.getByLabelText('Reason for sending back'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm send back' }));
    expect(mocked.rejectTicket).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Reason for sending back'), { target: { value: '手机上还是不行' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm send back' }));
    await waitFor(() => expect(mocked.rejectTicket).toHaveBeenCalledWith('req-1', '手机上还是不行'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // Reloaded after the action, form closed.
    await waitFor(() => expect(mocked.fetchTicket).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('ticket-reject-form')).toBeNull());
  });

  it('shows Send back only in To review', async () => {
    mocked.fetchTicket.mockResolvedValue(detail({ column: 'in_progress', status: 'running' }));
    renderDrawer();
    expect(await screen.findByRole('button', { name: 'Verified' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send back' })).toBeNull();
  });

  it('shows no actions on a done ticket', async () => {
    mocked.fetchTicket.mockResolvedValue(detail({ column: 'done', status: 'done' }));
    renderDrawer();
    await screen.findByDisplayValue('修登录按钮');
    expect(screen.queryByRole('button', { name: 'Verified' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('shows server refusals inline', async () => {
    mocked.verifyTicket.mockRejectedValue(new TicketApiError('Ticket still has open work items', 409, 'open_work'));
    const { onClose } = renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: 'Verified' }));
    expect(await screen.findByTestId('ticket-action-error')).toHaveTextContent('Some work items are still open, so it cannot be accepted yet');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Dismiss dismisses and closes', async () => {
    const { onClose, onChanged } = renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(mocked.dismissTicket).toHaveBeenCalledWith('req-1'));
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('adds an acceptance criterion via PUT', async () => {
    const { onChanged } = renderDrawer();
    fireEvent.change(await screen.findByLabelText('Add an acceptance criterion…'), { target: { value: '手机端可用' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mocked.setTicketAcceptance).toHaveBeenCalledWith('req-1', [
      { text: '按钮可点击', check: 'auto' },
      { text: '手机端可用', check: 'judgment' },
    ]));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('removes an acceptance criterion via PUT', async () => {
    renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove 按钮可点击' }));
    await waitFor(() => expect(mocked.setTicketAcceptance).toHaveBeenCalledWith('req-1', []));
  });

  it('edits title and priority via PATCH', async () => {
    renderDrawer();
    const title = await screen.findByLabelText('Title');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.change(title, { target: { value: '修登录按钮（手机）' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocked.patchTicket).toHaveBeenCalledWith('req-1', { title: '修登录按钮（手机）' }));

    await waitFor(() => expect(screen.getByLabelText('Priority')).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'urgent' } });
    await waitFor(() => expect(mocked.patchTicket).toHaveBeenCalledWith('req-1', { priority: 'urgent' }));
  });
});
