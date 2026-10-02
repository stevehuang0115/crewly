/**
 * Tests for UsageBarList.
 *
 * @module components/Usage/UsageBarList.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { UsageBarList } from './UsageBarList';

const rows = Array.from({ length: 7 }, (_, i) => ({ key: `a${i}`, name: `Agent ${i}`, sub: 'CE', total: (7 - i) * 1_000_000 }));

describe('UsageBarList', () => {
  it('shows five bars, then "Show all N"', () => {
    render(<UsageBarList title="Top agents" rows={rows} testIdPrefix="bars" />);
    expect(screen.getByRole('heading', { name: 'Top agents' })).toBeInTheDocument();
    expect(screen.getByTestId('bars-a4')).toBeInTheDocument();
    expect(screen.queryByTestId('bars-a5')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 7' }));
    expect(screen.getByTestId('bars-a6')).toHaveTextContent('1M');
  });

  it('scales bars to the largest row and flags an alert', () => {
    render(<UsageBarList title="Teams" rows={[{ key: 'x', name: 'X', total: 10 }, { key: 'y', name: 'Y', total: 5, alert: 'Stopped until midnight' }]} testIdPrefix="t" />);
    expect(screen.getByTestId('t-y')).toHaveTextContent('Stopped until midnight');
    const bar = screen.getByTestId('t-y').querySelector('[aria-hidden="true"] > div') as HTMLElement;
    expect(bar.style.width).toBe('50%');
  });

  it('says so when empty', () => {
    render(<UsageBarList title="Teams" rows={[]} testIdPrefix="t" />);
    expect(screen.getByText('No usage in this period.')).toBeInTheDocument();
  });
});
