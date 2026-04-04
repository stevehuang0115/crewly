/**
 * Tests for TaskSummaryBar component.
 *
 * @module components/TaskTracking/TaskSummaryBar.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TaskSummaryBar } from './TaskSummaryBar';
import type { TaskStatistics } from './task-tracking.types';

const mockStats: TaskStatistics = {
  totalTasks: 10,
  byStatus: {
    classified: 2,
    in_progress: 3,
    paused: 1,
    completed: 3,
    failed: 1,
  },
  byLevel: { L0: 2, L1: 5, L2: 3 },
  totalTokens: 48200,
  totalCost: 1.25,
  totalMessages: 5,
};

describe('TaskSummaryBar', () => {
  it('renders nothing when stats is null', () => {
    const { container } = render(<TaskSummaryBar stats={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders primary stat cards', () => {
    render(<TaskSummaryBar stats={mockStats} />);
    expect(screen.getByTestId('task-summary-bar')).toBeInTheDocument();
    expect(screen.getByTestId('task-summary-primary')).toBeInTheDocument();
  });

  it('shows correct Active count (classified + in_progress + paused)', () => {
    render(<TaskSummaryBar stats={mockStats} />);
    const active = screen.getByTestId('summary-active');
    expect(active).toHaveTextContent('6');
    expect(active).toHaveTextContent('Active');
  });

  it('shows correct Needs attention count (failed)', () => {
    render(<TaskSummaryBar stats={mockStats} />);
    const attention = screen.getByTestId('summary-attention');
    expect(attention).toHaveTextContent('1');
    expect(attention).toHaveTextContent('Needs attention');
  });

  it('shows correct Done count (completed)', () => {
    render(<TaskSummaryBar stats={mockStats} />);
    const done = screen.getByTestId('summary-done');
    expect(done).toHaveTextContent('3');
    expect(done).toHaveTextContent('Done');
  });

  it('shows correct Messages count', () => {
    render(<TaskSummaryBar stats={mockStats} />);
    const messages = screen.getByTestId('summary-messages');
    expect(messages).toHaveTextContent('5');
    expect(messages).toHaveTextContent('Messages');
  });

  it('shows secondary metrics (tokens and cost)', () => {
    render(<TaskSummaryBar stats={mockStats} />);
    expect(screen.getByTestId('task-summary-secondary')).toBeInTheDocument();
    expect(screen.getByTestId('summary-tokens')).toHaveTextContent('48.2K');
    expect(screen.getByTestId('summary-cost')).toHaveTextContent('$1.25');
  });

  it('applies attention accent when failed count > 0', () => {
    render(<TaskSummaryBar stats={mockStats} />);
    const card = screen.getByTestId('summary-attention');
    expect(card.classList.contains('task-summary-card--attention')).toBe(true);
  });

  it('does not apply attention accent when failed count is 0', () => {
    const noFailStats = { ...mockStats, byStatus: { ...mockStats.byStatus, failed: 0 } };
    render(<TaskSummaryBar stats={noFailStats} />);
    const card = screen.getByTestId('summary-attention');
    expect(card.classList.contains('task-summary-card--attention')).toBe(false);
  });

  it('handles missing byStatus keys gracefully', () => {
    const minStats: TaskStatistics = {
      totalTasks: 0,
      byStatus: {},
      byLevel: {},
      totalTokens: 0,
      totalCost: 0,
      totalMessages: 0,
    };
    render(<TaskSummaryBar stats={minStats} />);
    expect(screen.getByTestId('summary-active')).toHaveTextContent('0');
    expect(screen.getByTestId('summary-attention')).toHaveTextContent('0');
    expect(screen.getByTestId('summary-done')).toHaveTextContent('0');
  });
});
