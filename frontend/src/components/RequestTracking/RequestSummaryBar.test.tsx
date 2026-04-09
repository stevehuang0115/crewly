// @vitest-environment jsdom
/**
 * Tests for RequestSummaryBar component
 *
 * @module components/RequestTracking/RequestSummaryBar.test
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RequestSummaryBar } from './RequestSummaryBar';
import type { RequestStatistics } from './request-tracking.types';

describe('RequestSummaryBar', () => {
  const mockStats: RequestStatistics = {
    total: 45,
    active: 28,
    blocked: 5,
    waitingConfirmation: 12,
    completed: 0,
  };

  it('renders nothing when stats is null', () => {
    const { container } = render(<RequestSummaryBar stats={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders ScoreCards with correct values', () => {
    render(<RequestSummaryBar stats={mockStats} />);
    expect(screen.getByText('45')).toBeDefined();
    expect(screen.getByText('28')).toBeDefined();
    expect(screen.getByText('5')).toBeDefined();
    expect(screen.getByText('12')).toBeDefined();
  });

  it('renders correct labels', () => {
    render(<RequestSummaryBar stats={mockStats} />);
    expect(screen.getByText('Total Requests')).toBeDefined();
    expect(screen.getByText('Active')).toBeDefined();
    expect(screen.getByText('Blocked')).toBeDefined();
    expect(screen.getByText('Waiting Confirmation')).toBeDefined();
  });
});
