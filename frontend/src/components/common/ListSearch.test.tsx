import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ListSearch } from './ListSearch';

describe('ListSearch', () => {
  it('is a labelled search field that reports changes', () => {
    const onChange = vi.fn();
    render(<ListSearch label="Search teams" value="" onChange={onChange} />);
    const input = screen.getByLabelText('Search teams');
    expect(input).toHaveAttribute('type', 'search');
    expect(input).toHaveAttribute('placeholder', 'Search teams…');
    fireEvent.change(input, { target: { value: 'ce' } });
    expect(onChange).toHaveBeenCalledWith('ce');
  });

  it('uses a custom placeholder', () => {
    render(<ListSearch label="Search goals" value="x" onChange={() => {}} placeholder="Goal, team…" />);
    expect(screen.getByLabelText('Search goals')).toHaveValue('x');
    expect(screen.getByPlaceholderText('Goal, team…')).toBeInTheDocument();
  });
});
