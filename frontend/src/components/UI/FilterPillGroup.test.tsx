/**
 * Tests for FilterPillGroup UI component.
 *
 * @module components/UI/FilterPillGroup.test
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilterPillGroup } from './FilterPillGroup';

type TestKey = 'all' | 'a' | 'b';

const OPTIONS: { key: TestKey; label: string; count?: number }[] = [
  { key: 'all', label: 'All' },
  { key: 'a', label: 'Alpha', count: 2 },
  { key: 'b', label: 'Beta' },
];

describe('FilterPillGroup', () => {
  it('renders every option as a pill', () => {
    render(
      <FilterPillGroup<TestKey>
        label="Category"
        options={OPTIONS}
        value="all"
        onChange={() => {}}
        testIdPrefix="cat"
      />,
    );
    expect(screen.getByTestId('cat-all')).toBeTruthy();
    expect(screen.getByTestId('cat-a')).toBeTruthy();
    expect(screen.getByTestId('cat-b')).toBeTruthy();
  });

  it('renders the row label', () => {
    render(
      <FilterPillGroup<TestKey>
        label="Category"
        options={OPTIONS}
        value="all"
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('Category')).toBeTruthy();
  });

  it('marks exactly one pill as pressed (single-select)', () => {
    render(
      <FilterPillGroup<TestKey>
        label="Category"
        options={OPTIONS}
        value="a"
        onChange={() => {}}
        testIdPrefix="cat"
      />,
    );
    expect(screen.getByTestId('cat-a').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('cat-all').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('cat-b').getAttribute('aria-pressed')).toBe('false');
  });

  it('invokes onChange with the option key when a pill is clicked', () => {
    const onChange = vi.fn();
    render(
      <FilterPillGroup<TestKey>
        label="Category"
        options={OPTIONS}
        value="all"
        onChange={onChange}
        testIdPrefix="cat"
      />,
    );
    fireEvent.click(screen.getByTestId('cat-a'));
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('renders count badges when provided in options', () => {
    render(
      <FilterPillGroup<TestKey>
        label="Category"
        options={OPTIONS}
        value="all"
        onChange={() => {}}
        testIdPrefix="cat"
      />,
    );
    // Alpha has count=2 → "(2)" suffix
    expect(screen.getByTestId('cat-a').textContent).toMatch(/\(2\)/);
    // Beta has no count → no parens
    expect(screen.getByTestId('cat-b').textContent).not.toMatch(/\(\d+\)/);
  });

  it('omits the label element when no label is provided', () => {
    const { container } = render(
      <FilterPillGroup<TestKey>
        options={OPTIONS}
        value="all"
        onChange={() => {}}
      />,
    );
    // No element with uppercase "CATEGORY" label
    expect(container.querySelector('span.uppercase')).toBeNull();
  });
});
