/**
 * Tests for TicketAcceptanceEditor.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TicketAcceptanceEditor } from './TicketAcceptanceEditor';
import type { TicketAcceptance } from '../../types/ticket.types';

const LIST: TicketAcceptance[] = [
  { text: '按钮可点击', source: 'decompose', check: 'auto', selfCheck: 'pass', evidence: 'e2e 通过' },
  { text: '颜色要和设计稿一致', source: 'reject', check: 'judgment' },
  { text: '移动端也要能用' },
];

describe('TicketAcceptanceEditor', () => {
  it('renders each criterion with source, check and self-check', () => {
    render(<TicketAcceptanceEditor acceptance={LIST} onSave={vi.fn()} />);
    const items = screen.getAllByTestId('ticket-acceptance-item');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('拆解');
    expect(items[0]).toHaveTextContent('自动');
    expect(items[0]).toHaveTextContent('自检通过');
    expect(items[0]).toHaveTextContent('e2e 通过');
    expect(items[1]).toHaveTextContent('打回');
    expect(items[1]).toHaveTextContent('人工');
    // No source/check → owner / judgment.
    expect(items[2]).toHaveTextContent('我');
    expect(items[2]).toHaveTextContent('人工');
  });

  it('shows an empty message', () => {
    render(<TicketAcceptanceEditor acceptance={[]} onSave={vi.fn()} />);
    expect(screen.getByText('还没有验收标准')).toBeInTheDocument();
  });

  it('removes a criterion by saving the rest', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TicketAcceptanceEditor acceptance={LIST} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: '删除 颜色要和设计稿一致' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([
      { text: '按钮可点击', check: 'auto' },
      { text: '移动端也要能用' },
    ]));
  });

  it('adds a criterion with the chosen check and clears the draft', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TicketAcceptanceEditor acceptance={LIST.slice(0, 1)} onSave={onSave} />);
    const input = screen.getByLabelText('新增一条验收标准…');
    const add = screen.getByRole('button', { name: '添加' });
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: '  单测覆盖  ' } });
    fireEvent.change(screen.getByLabelText('检查方式'), { target: { value: 'auto' } });
    fireEvent.click(add);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([
      { text: '按钮可点击', check: 'auto' },
      { text: '单测覆盖', check: 'auto' },
    ]));
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('keeps the draft when saving fails', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('nope'));
    render(<TicketAcceptanceEditor acceptance={[]} onSave={onSave} />);
    const input = screen.getByLabelText('新增一条验收标准…');
    fireEvent.change(input, { target: { value: '新标准' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: '添加' })).not.toBeDisabled());
    expect(input).toHaveValue('新标准');
  });

  it('disables editing when disabled', () => {
    render(<TicketAcceptanceEditor acceptance={LIST} onSave={vi.fn()} disabled />);
    expect(screen.getByLabelText('新增一条验收标准…')).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除 按钮可点击' })).toBeDisabled();
  });
});
