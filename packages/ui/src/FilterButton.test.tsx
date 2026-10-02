import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FilterButton, activeFilterCount, type FilterGroup, type FilterValue } from './FilterButton';

const groups: FilterGroup[] = [
  { id: 'status', label: 'Status', options: [{ value: 'running', label: 'Running', count: 3 }, { value: 'failed', label: 'Failed' }] },
  { id: 'team', label: 'Team', single: true, options: [{ value: 'growth', label: 'Growth' }, { value: 'ops', label: 'Ops' }] },
];

function Harness({ initial = {} }: { initial?: FilterValue }) {
  const [value, setValue] = useState<FilterValue>(initial);
  return (
    <>
      <FilterButton groups={groups} value={value} onChange={setValue} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

describe('FilterButton', () => {
  it('opens a popover with the groups and toggles options', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('filter-button'));
    expect(screen.getByTestId('filter-popover')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Running/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Failed/ }));
    expect(JSON.parse(screen.getByTestId('value').textContent || '{}')).toEqual({ status: ['running', 'failed'] });
    fireEvent.click(screen.getByRole('checkbox', { name: /Running/ }));
    expect(JSON.parse(screen.getByTestId('value').textContent || '{}')).toEqual({ status: ['failed'] });
  });

  it('single groups behave like radios and can be cleared by clicking again', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('filter-button'));
    fireEvent.click(screen.getByLabelText('Growth'));
    fireEvent.click(screen.getByLabelText('Ops'));
    expect(JSON.parse(screen.getByTestId('value').textContent || '{}').team).toEqual(['ops']);
    fireEvent.click(screen.getByLabelText('Ops'));
    expect(JSON.parse(screen.getByTestId('value').textContent || '{}').team).toEqual([]);
  });

  it('shows active filters as removable chips and a count on the button', () => {
    render(<Harness initial={{ status: ['running'], team: ['ops'] }} />);
    expect(screen.getByTestId('filter-button')).toHaveTextContent('2');
    const chips = screen.getAllByTestId('filter-chip');
    expect(chips.map((c) => c.textContent)).toEqual(['Status: Running', 'Team: Ops']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Status: Running' }));
    expect(screen.getAllByTestId('filter-chip')).toHaveLength(1);
  });

  it('clears everything and closes on Escape', () => {
    render(<Harness initial={{ status: ['running'] }} />);
    fireEvent.click(screen.getByTestId('filter-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.queryAllByTestId('filter-chip')).toHaveLength(0);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('filter-popover')).not.toBeInTheDocument();
  });

  it('counts active values', () => {
    expect(activeFilterCount({ a: ['x', 'y'], b: [] })).toBe(2);
  });
});
