/**
 * Tests for the search icon / box.
 */
import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchToggle } from './SearchToggle';

const Harness: React.FC<{ initial?: string }> = ({ initial = '' }) => {
  const [v, setV] = useState(initial);
  return (
    <>
      <SearchToggle value={v} onChange={setV} placeholder="Search tickets…" data-testid="box" />
      <span data-testid="value">{v}</span>
    </>
  );
};

describe('SearchToggle', () => {
  it('is an icon until opened, then a focused box', () => {
    render(<Harness />);
    expect(screen.queryByTestId('box')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Search tickets…' }));
    const box = screen.getByTestId('box');
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'login' } });
    expect(screen.getByTestId('value')).toHaveTextContent('login');
  });

  it('stays open while it holds a query; Clear and Escape empty and close it', () => {
    render(<Harness initial="abc" />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByTestId('value')).toHaveTextContent('');
    expect(screen.queryByTestId('box')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Search tickets…' }));
    fireEvent.change(screen.getByTestId('box'), { target: { value: 'x' } });
    fireEvent.keyDown(screen.getByTestId('box'), { key: 'Escape' });
    expect(screen.queryByTestId('box')).toBeNull();
  });
});
