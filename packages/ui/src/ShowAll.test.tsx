import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ShowAll } from './ShowAll';

const rows = (n: number) => Array.from({ length: n }, (_, i) => <div key={i}>Row {i + 1}</div>);

describe('ShowAll', () => {
  it('shows the first N and expands / collapses in place', () => {
    render(<ShowAll limit={3}>{rows(8)}</ShowAll>);
    expect(screen.getAllByText(/^Row /)).toHaveLength(3);
    const toggle = screen.getByRole('button', { name: 'Show all 8' });
    fireEvent.click(toggle);
    expect(screen.getAllByText(/^Row /)).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getAllByText(/^Row /)).toHaveLength(3);
  });

  it('has no control when everything fits', () => {
    render(<ShowAll limit={5}>{rows(5)}</ShowAll>);
    expect(screen.queryByTestId('show-all-toggle')).not.toBeInTheDocument();
  });

  it('announces a server total and can hand off to a full list', () => {
    const go = vi.fn();
    render(<ShowAll limit={2} total={16} onShowAll={go} showAllLabel={(n) => `See all ${n}`}>{rows(4)}</ShowAll>);
    fireEvent.click(screen.getByRole('button', { name: 'See all 16' }));
    expect(go).toHaveBeenCalled();
    expect(screen.getAllByText(/^Row /)).toHaveLength(2);
  });

  it('can render the rows in a list element', () => {
    const { container } = render(<ShowAll as="ul" limit={1}>{[<li key="a">A</li>, <li key="b">B</li>]}</ShowAll>);
    expect(container.querySelector('ul')?.children).toHaveLength(1);
  });
});
