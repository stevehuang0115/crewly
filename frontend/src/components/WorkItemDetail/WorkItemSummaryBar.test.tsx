// Layout + ScoreCard consistency
/**
 * WorkItem Summary Bar Tests
 *
 * Tests for the WorkItemSummaryBar component and computeWorkItemStats helper.
 *
 * @module components/WorkItemDetail/WorkItemSummaryBar.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkItemSummaryBar, computeWorkItemStats } from './WorkItemSummaryBar';
import type { WorkItemStatistics } from './WorkItemSummaryBar';

// =============================================================================
// computeWorkItemStats
// =============================================================================

describe('computeWorkItemStats', () => {
  it('should return zeroed stats for empty array', () => {
    const result = computeWorkItemStats([]);
    expect(result).toEqual({
      total: 0,
      running: 0,
      queued: 0,
      done: 0,
      failed: 0,
      blocked: 0,
    });
  });

  it('should count each status correctly', () => {
    const items = [
      { status: 'running' },
      { status: 'running' },
      { status: 'queued' },
      { status: 'scheduled' },
      { status: 'done' },
      { status: 'done' },
      { status: 'done' },
      { status: 'failed' },
      { status: 'blocked' },
      { status: 'cancelled' },
    ];
    const result = computeWorkItemStats(items);
    expect(result.total).toBe(10);
    expect(result.running).toBe(2);
    expect(result.queued).toBe(2); // queued + scheduled
    expect(result.done).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.blocked).toBe(1);
  });

  it('should treat scheduled as queued', () => {
    const items = [{ status: 'scheduled' }, { status: 'scheduled' }];
    const result = computeWorkItemStats(items);
    expect(result.queued).toBe(2);
  });
});

// =============================================================================
// WorkItemSummaryBar component
// =============================================================================

describe('WorkItemSummaryBar', () => {
  it('should render nothing when stats is null', () => {
    const { container } = render(<WorkItemSummaryBar stats={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('should render all stat cards with correct values', () => {
    const stats: WorkItemStatistics = {
      total: 25,
      running: 5,
      queued: 8,
      done: 10,
      failed: 1,
      blocked: 1,
    };
    render(<WorkItemSummaryBar stats={stats} />);

    expect(screen.getByTestId('workitem-summary-bar')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });

  it('should render zero values correctly', () => {
    const stats: WorkItemStatistics = {
      total: 0,
      running: 0,
      queued: 0,
      done: 0,
      failed: 0,
      blocked: 0,
    };
    render(<WorkItemSummaryBar stats={stats} />);
    expect(screen.getByTestId('workitem-summary-bar')).toBeInTheDocument();
    // All six "0" values should be present
    const zeros = screen.getAllByText('0');
    expect(zeros.length).toBe(6);
  });
});
