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
    expect(screen.getByTestId('ticket-origin')).toHaveTextContent('Slack 私信 · Steve');
    expect(screen.getByText('按钮点了没反应')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-reply')).toHaveTextContent('已修复，原因是事件没绑定');
    expect(screen.getByTestId('ticket-reply')).toHaveTextContent('crewly-atlas');
    expect(screen.getByTestId('ticket-discussion')).toHaveTextContent('还有手机上也不行');
    expect(screen.getByText('按钮可点击')).toBeInTheDocument();
    expect(screen.getByText('3天后自动验收')).toBeInTheDocument();
    expect(screen.getByText('1次打回')).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    mocked.fetchTicket.mockRejectedValue(new TicketApiError('Ticket not found: req-1', 404));
    renderDrawer();
    expect(await screen.findByText('Ticket not found: req-1')).toBeInTheDocument();
  });

  it('验过了 calls verify, refreshes the board and closes', async () => {
    const { onClose, onChanged } = renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: '验过了' }));
    await waitFor(() => expect(mocked.verifyTicket).toHaveBeenCalledWith('req-1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('打回 requires a reason before calling the server', async () => {
    const { onChanged } = renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: '打回' }));
    fireEvent.click(screen.getByRole('button', { name: '确认打回' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写打回原因');
    fireEvent.change(screen.getByLabelText('打回原因'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '确认打回' }));
    expect(mocked.rejectTicket).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('打回原因'), { target: { value: '手机上还是不行' } });
    fireEvent.click(screen.getByRole('button', { name: '确认打回' }));
    await waitFor(() => expect(mocked.rejectTicket).toHaveBeenCalledWith('req-1', '手机上还是不行'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // Reloaded after the action, form closed.
    await waitFor(() => expect(mocked.fetchTicket).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('ticket-reject-form')).toBeNull());
  });

  it('shows 打回 only in 待验收', async () => {
    mocked.fetchTicket.mockResolvedValue(detail({ column: 'in_progress', status: 'running' }));
    renderDrawer();
    expect(await screen.findByRole('button', { name: '验过了' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打回' })).toBeNull();
  });

  it('shows no actions on a done ticket', async () => {
    mocked.fetchTicket.mockResolvedValue(detail({ column: 'done', status: 'done' }));
    renderDrawer();
    await screen.findByDisplayValue('修登录按钮');
    expect(screen.queryByRole('button', { name: '验过了' })).toBeNull();
    expect(screen.queryByRole('button', { name: '不用记' })).toBeNull();
  });

  it('shows server refusals inline', async () => {
    mocked.verifyTicket.mockRejectedValue(new TicketApiError('Ticket still has open work items', 409, 'open_work'));
    const { onClose } = renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: '验过了' }));
    expect(await screen.findByTestId('ticket-action-error')).toHaveTextContent('还有未完成的工作项，暂时不能验收');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('不用记 dismisses and closes', async () => {
    const { onClose, onChanged } = renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: '不用记' }));
    await waitFor(() => expect(mocked.dismissTicket).toHaveBeenCalledWith('req-1'));
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('adds an acceptance criterion via PUT', async () => {
    const { onChanged } = renderDrawer();
    fireEvent.change(await screen.findByLabelText('新增一条验收标准…'), { target: { value: '手机端可用' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(mocked.setTicketAcceptance).toHaveBeenCalledWith('req-1', [
      { text: '按钮可点击', check: 'auto' },
      { text: '手机端可用', check: 'judgment' },
    ]));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('removes an acceptance criterion via PUT', async () => {
    renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: '删除 按钮可点击' }));
    await waitFor(() => expect(mocked.setTicketAcceptance).toHaveBeenCalledWith('req-1', []));
  });

  it('edits title and priority via PATCH', async () => {
    renderDrawer();
    const title = await screen.findByLabelText('标题');
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
    fireEvent.change(title, { target: { value: '修登录按钮（手机）' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocked.patchTicket).toHaveBeenCalledWith('req-1', { title: '修登录按钮（手机）' }));

    await waitFor(() => expect(screen.getByLabelText('优先级')).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('优先级'), { target: { value: 'urgent' } });
    await waitFor(() => expect(mocked.patchTicket).toHaveBeenCalledWith('req-1', { priority: 'urgent' }));
  });
});
