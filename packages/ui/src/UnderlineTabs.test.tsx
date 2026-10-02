import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UnderlineTabs } from './UnderlineTabs';

const tabs = [
  { value: 'board', label: 'Board' },
  { value: 'requests', label: 'Requests', count: 4 },
  { value: 'runs', label: 'Runs', count: 2, attention: true },
  { value: 'archived', label: 'Archived', disabled: true },
];

describe('UnderlineTabs', () => {
  it('marks the active tab and links tabs to panels', () => {
    render(<UnderlineTabs tabs={tabs} value="requests" onChange={() => {}} idPrefix="tickets" aria-label="Tickets views" />);
    expect(screen.getByRole('tablist', { name: 'Tickets views' })).toBeInTheDocument();
    const active = screen.getByRole('tab', { name: /Requests/ });
    expect(active).toHaveAttribute('aria-selected', 'true');
    expect(active).toHaveAttribute('id', 'tickets-tab-requests');
    expect(active).toHaveAttribute('aria-controls', 'tickets-panel-requests');
    expect(active.className).toContain('border-primary-text');
    expect(screen.getByRole('tab', { name: /Board/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('shows counts as pills, attention-coloured when flagged', () => {
    render(<UnderlineTabs tabs={tabs} value="board" onChange={() => {}} />);
    expect(screen.getByTestId('tab-count-requests')).toHaveTextContent('4');
    expect(screen.getByTestId('tab-count-runs').className).toContain('text-attention');
    expect(screen.queryByTestId('tab-count-board')).not.toBeInTheDocument();
  });

  it('calls onChange on click and with the arrow keys, skipping disabled tabs', () => {
    const onChange = vi.fn();
    render(<UnderlineTabs tabs={tabs} value="runs" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: /Board/ }));
    expect(onChange).toHaveBeenLastCalledWith('board');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('board');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('requests');
    expect(screen.getByRole('tab', { name: /Archived/ })).toBeDisabled();
  });

  it('does not re-fire for the active tab', () => {
    const onChange = vi.fn();
    render(<UnderlineTabs tabs={tabs} value="board" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: /Board/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
