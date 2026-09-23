/**
 * Tests for FilterPill UI primitive.
 *
 * @module components/UI/FilterPill.test
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilterPill } from './FilterPill';

describe('FilterPill', () => {
  it('renders the label', () => {
    render(
      <FilterPill isActive={false} onClick={() => {}}>
        High
      </FilterPill>,
    );
    expect(screen.getByRole('button', { name: /high/i })).toBeTruthy();
  });

  it('reports its pressed state via aria-pressed', () => {
    render(
      <FilterPill isActive onClick={() => {}} data-testid="pill">
        Active
      </FilterPill>,
    );
    expect(screen.getByTestId('pill').getAttribute('aria-pressed')).toBe('true');
  });

  it('does NOT mark itself pressed when inactive', () => {
    render(
      <FilterPill isActive={false} onClick={() => {}} data-testid="pill">
        Idle
      </FilterPill>,
    );
    expect(screen.getByTestId('pill').getAttribute('aria-pressed')).toBe('false');
  });

  it('invokes onClick when clicked', () => {
    const handler = vi.fn();
    render(
      <FilterPill isActive={false} onClick={handler} data-testid="pill">
        Click
      </FilterPill>,
    );
    fireEvent.click(screen.getByTestId('pill'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('renders an optional count badge', () => {
    render(
      <FilterPill isActive={false} onClick={() => {}} count={3}>
        Alpha
      </FilterPill>,
    );
    // Label + the "(3)" suffix share the same button
    expect(screen.getByRole('button').textContent).toMatch(/Alpha\s*\(3\)/);
  });

  it('disabled buttons do not fire onClick', () => {
    const handler = vi.fn();
    render(
      <FilterPill isActive={false} onClick={handler} disabled data-testid="pill">
        Nope
      </FilterPill>,
    );
    fireEvent.click(screen.getByTestId('pill'));
    expect(handler).not.toHaveBeenCalled();
  });
});
