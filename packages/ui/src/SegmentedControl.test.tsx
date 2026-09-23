import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

const options = [
  { value: 'grid' as const, label: 'Grid' },
  { value: 'list' as const, label: 'List' },
  { value: 'table' as const, label: 'Table', disabled: true },
];

describe('SegmentedControl', () => {
  it('marks the selected option and reports changes', () => {
    const onChange = vi.fn();
    render(<SegmentedControl aria-label="View" options={options} value="grid" onChange={onChange} />);
    expect(screen.getByRole('radio', { name: 'Grid' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(onChange).toHaveBeenCalledWith('list');
  });

  it('disables options and stretches when fullWidth', () => {
    render(<SegmentedControl aria-label="View" options={options} value="grid" onChange={() => {}} fullWidth />);
    expect(screen.getByRole('radio', { name: 'Table' })).toBeDisabled();
    expect(screen.getByRole('radiogroup')).toHaveClass('w-full');
  });
});
