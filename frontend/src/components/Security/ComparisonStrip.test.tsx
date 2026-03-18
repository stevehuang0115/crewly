// @vitest-environment jsdom
/**
 * Tests for ComparisonStrip component
 *
 * Verifies the 3-column comparison strip renders all categories,
 * "Others" and "Crewly" entries, and meets accessibility requirements
 * per spec section 2.4.
 *
 * @module components/Security/ComparisonStrip.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ComparisonStrip } from './ComparisonStrip';

describe('ComparisonStrip', () => {
  it('should render with correct testid', () => {
    render(<ComparisonStrip />);
    expect(screen.getByTestId('comparison-strip')).toBeDefined();
  });

  it('should render all three category headings', () => {
    render(<ComparisonStrip />);
    expect(screen.getByText('Process Model')).toBeDefined();
    expect(screen.getByText('Data Location')).toBeDefined();
    expect(screen.getByText('Tool Control')).toBeDefined();
  });

  it('should show "Others" entries for each category', () => {
    render(<ComparisonStrip />);
    expect(screen.getByText('Shared runtime')).toBeDefined();
    expect(screen.getByText('Cloud storage')).toBeDefined();
    expect(screen.getByText('All or nothing')).toBeDefined();
  });

  it('should show "Crewly" entries for each category', () => {
    render(<ComparisonStrip />);
    expect(screen.getByText('Isolated PTY per agent')).toBeDefined();
    expect(screen.getByText('Local only')).toBeDefined();
    expect(screen.getByText('Per-tool granular approval')).toBeDefined();
  });

  it('should have accessible list role', () => {
    render(<ComparisonStrip />);
    expect(screen.getByRole('list', { name: /comparison/i })).toBeDefined();
  });

  it('should render three list items', () => {
    render(<ComparisonStrip />);
    const items = screen.getAllByRole('listitem');
    expect(items.length).toBe(3);
  });

  it('should label "Others" and "Crewly" for each comparison', () => {
    render(<ComparisonStrip />);
    const othersLabels = screen.getAllByText(/^Others:/);
    const crewlyLabels = screen.getAllByText(/^Crewly:/);
    expect(othersLabels.length).toBe(3);
    expect(crewlyLabels.length).toBe(3);
  });
});
