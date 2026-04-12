/**
 * Tests for TaskFilters component.
 *
 * @module components/TaskTracking/TaskFilters.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { TaskFilters } from './TaskFilters';
import type { TaskStatistics, PrimaryFilter } from './task-tracking.types';

const mockStats: TaskStatistics = {
  totalTasks: 10,
  byStatus: {
    classified: 2,
    in_progress: 3,
    paused: 1,
    completed: 3,
    failed: 1,
    cancelled: 0,
  },
  byLevel: { L0: 2, L1: 5, L2: 3 },
  totalTokens: 10000,
  totalCost: 0.5,
  totalMessages: 3,
};

const defaultProps = {
  activeFilter: 'all' as PrimaryFilter,
  onFilterChange: vi.fn(),
  searchQuery: '',
  onSearchChange: vi.fn(),
  advancedFilter: '',
  onAdvancedFilterChange: vi.fn(),
  stats: mockStats,
};

describe('TaskFilters', () => {
  it('renders the search input', () => {
    render(<TaskFilters {...defaultProps} />);
    expect(screen.getByTestId('task-search')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search tasks or source messages...')).toBeInTheDocument();
  });

  it('renders all primary filter chips', () => {
    render(<TaskFilters {...defaultProps} />);
    expect(screen.getByTestId('filter-all')).toBeInTheDocument();
    expect(screen.getByTestId('filter-active')).toBeInTheDocument();
    expect(screen.getByTestId('filter-needs_attention')).toBeInTheDocument();
    expect(screen.getByTestId('filter-completed')).toBeInTheDocument();
  });

  it('marks active filter chip with active class', () => {
    render(<TaskFilters {...defaultProps} activeFilter="active" />);
    const chip = screen.getByTestId('filter-active');
    expect(chip.classList.contains('task-filter-chip--active')).toBe(true);
  });

  it('calls onFilterChange when a filter chip is clicked', () => {
    const onFilterChange = vi.fn();
    render(<TaskFilters {...defaultProps} onFilterChange={onFilterChange} />);
    fireEvent.click(screen.getByTestId('filter-active'));
    expect(onFilterChange).toHaveBeenCalledWith('active');
  });

  it('clears advanced filter when primary filter is clicked', () => {
    const onAdvancedFilterChange = vi.fn();
    render(<TaskFilters {...defaultProps} advancedFilter="paused" onAdvancedFilterChange={onAdvancedFilterChange} />);
    fireEvent.click(screen.getByTestId('filter-all'));
    expect(onAdvancedFilterChange).toHaveBeenCalledWith('');
  });

  it('calls onSearchChange when typing in search input', () => {
    const onSearchChange = vi.fn();
    render(<TaskFilters {...defaultProps} onSearchChange={onSearchChange} />);
    fireEvent.change(screen.getByTestId('task-search'), { target: { value: 'login' } });
    expect(onSearchChange).toHaveBeenCalledWith('login');
  });

  it('shows filter counts when stats are available', () => {
    render(<TaskFilters {...defaultProps} />);
    const activeChip = screen.getByTestId('filter-active');
    expect(activeChip).toHaveTextContent('6'); // 2+3+1
    const attentionChip = screen.getByTestId('filter-needs_attention');
    expect(attentionChip).toHaveTextContent('1');
    const completedChip = screen.getByTestId('filter-completed');
    expect(completedChip).toHaveTextContent('3');
  });

  it('does not show filter counts when stats are null', () => {
    render(<TaskFilters {...defaultProps} stats={null} />);
    const activeChip = screen.getByTestId('filter-active');
    expect(activeChip.querySelector('.task-filter-chip-count')).toBeNull();
  });

  it('shows advanced filter panel when More filters is clicked', () => {
    render(<TaskFilters {...defaultProps} />);
    expect(screen.queryByTestId('filter-advanced-panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('filter-advanced-toggle'));
    expect(screen.getByTestId('filter-advanced-panel')).toBeInTheDocument();
  });

  it('renders advanced filter chips', () => {
    render(<TaskFilters {...defaultProps} />);
    fireEvent.click(screen.getByTestId('filter-advanced-toggle'));
    expect(screen.getByTestId('filter-adv-classified')).toBeInTheDocument();
    expect(screen.getByTestId('filter-adv-paused')).toBeInTheDocument();
    expect(screen.getByTestId('filter-adv-cancelled')).toBeInTheDocument();
    expect(screen.getByTestId('filter-adv-L0')).toBeInTheDocument();
    expect(screen.getByTestId('filter-adv-L1')).toBeInTheDocument();
    expect(screen.getByTestId('filter-adv-L2')).toBeInTheDocument();
  });

  it('calls onAdvancedFilterChange when advanced chip is clicked', () => {
    const onAdvancedFilterChange = vi.fn();
    render(<TaskFilters {...defaultProps} onAdvancedFilterChange={onAdvancedFilterChange} />);
    fireEvent.click(screen.getByTestId('filter-advanced-toggle'));
    fireEvent.click(screen.getByTestId('filter-adv-paused'));
    expect(onAdvancedFilterChange).toHaveBeenCalledWith('paused');
  });

  it('toggles advanced filter off when same chip is clicked again', () => {
    const onAdvancedFilterChange = vi.fn();
    render(<TaskFilters {...defaultProps} advancedFilter="paused" onAdvancedFilterChange={onAdvancedFilterChange} />);
    fireEvent.click(screen.getByTestId('filter-advanced-toggle'));
    fireEvent.click(screen.getByTestId('filter-adv-paused'));
    expect(onAdvancedFilterChange).toHaveBeenCalledWith('');
  });

  it('has proper aria-label on search input', () => {
    render(<TaskFilters {...defaultProps} />);
    expect(screen.getByLabelText('Search tasks')).toBeInTheDocument();
  });

  it('has proper aria-pressed on active filter chip', () => {
    render(<TaskFilters {...defaultProps} activeFilter="all" />);
    expect(screen.getByTestId('filter-all')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('filter-active')).toHaveAttribute('aria-pressed', 'false');
  });
});
