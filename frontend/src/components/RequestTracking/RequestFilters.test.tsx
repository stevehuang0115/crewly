// @vitest-environment jsdom
/**
 * Tests for RequestFilters component
 *
 * @module components/RequestTracking/RequestFilters.test
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RequestFilters } from './RequestFilters';
import type { RequestStatistics } from './request-tracking.types';

describe('RequestFilters', () => {
  const mockStats: RequestStatistics = {
    total: 10,
    active: 4,
    blocked: 3,
    waitingConfirmation: 3,
    completed: 0,
  };

  const defaultProps = {
    activeFilter: 'all' as const,
    onFilterChange: vi.fn(),
    activeSecondaryFilters: new Set<never>(),
    onSecondaryFilterToggle: vi.fn(),
    searchQuery: '',
    onSearchChange: vi.fn(),
    stats: mockStats,
  };

  it('renders search input without emoji', () => {
    render(<RequestFilters {...defaultProps} />);
    const input = screen.getByTestId('request-search-input');
    expect(input).toBeDefined();
    expect(input.getAttribute('placeholder')).toBe('Search requests...');
  });

  it('renders all filter chips', () => {
    render(<RequestFilters {...defaultProps} />);
    expect(screen.getByTestId('request-filter-all')).toBeDefined();
    expect(screen.getByTestId('request-filter-active')).toBeDefined();
    expect(screen.getByTestId('request-filter-blocked')).toBeDefined();
    expect(screen.getByTestId('request-filter-waiting_confirmation')).toBeDefined();
  });

  it('calls onFilterChange when chip is clicked', () => {
    render(<RequestFilters {...defaultProps} />);
    fireEvent.click(screen.getByTestId('request-filter-blocked'));
    expect(defaultProps.onFilterChange).toHaveBeenCalledWith('blocked');
  });

  it('calls onSearchChange when typing in search', () => {
    render(<RequestFilters {...defaultProps} />);
    fireEvent.change(screen.getByTestId('request-search-input'), { target: { value: 'auth' } });
    expect(defaultProps.onSearchChange).toHaveBeenCalledWith('auth');
  });

  it('applies active styling to current filter', () => {
    render(<RequestFilters {...defaultProps} activeFilter="blocked" />);
    const blockedChip = screen.getByTestId('request-filter-blocked');
    expect(blockedChip.className).toContain('text-primary');
  });

  it('renders secondary filter buttons', () => {
    render(<RequestFilters {...defaultProps} />);
    expect(screen.getByTestId('request-secondary-assigned-to-me')).toBeDefined();
    expect(screen.getByTestId('request-secondary-urgent')).toBeDefined();
  });

  it('calls onSecondaryFilterToggle when secondary button clicked', () => {
    const onToggle = vi.fn();
    render(<RequestFilters {...defaultProps} onSecondaryFilterToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('request-secondary-urgent'));
    expect(onToggle).toHaveBeenCalledWith('urgent');
  });

  it('applies active styling to active secondary filter', () => {
    render(
      <RequestFilters
        {...defaultProps}
        activeSecondaryFilters={new Set(['urgent'] as const)}
      />
    );
    const urgentBtn = screen.getByTestId('request-secondary-urgent');
    expect(urgentBtn.className).toContain('text-primary');
  });
});
