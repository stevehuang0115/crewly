/**
 * LoadingSpinner Component Tests
 *
 * @module components/UI/LoadingSpinner.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { LoadingSpinner } from './LoadingSpinner';

describe('LoadingSpinner', () => {
  it('renders the spinner element', () => {
    render(<LoadingSpinner />);
    expect(screen.getByTestId('loading-spinner')).toBeDefined();
  });

  it('has role="status" for accessibility', () => {
    render(<LoadingSpinner />);
    expect(screen.getByRole('status')).toBeDefined();
  });

  it('shows text when provided', () => {
    render(<LoadingSpinner text="Loading teams..." />);
    expect(screen.getByText('Loading teams...')).toBeDefined();
  });

  it('does not render text element when text is not provided', () => {
    const { container } = render(<LoadingSpinner />);
    expect(container.querySelector('p')).toBeNull();
  });

  it('uses default size "lg" when not specified', () => {
    render(<LoadingSpinner />);
    const spinner = screen.getByTestId('loading-spinner');
    expect(spinner.className).toContain('w-10');
    expect(spinner.className).toContain('h-10');
    expect(spinner.className).toContain('border-4');
  });

  it('applies xs size classes', () => {
    render(<LoadingSpinner size="xs" />);
    const spinner = screen.getByTestId('loading-spinner');
    expect(spinner.className).toContain('w-3');
    expect(spinner.className).toContain('h-3');
    expect(spinner.className).toContain('border-2');
  });

  it('applies sm size classes', () => {
    render(<LoadingSpinner size="sm" />);
    const spinner = screen.getByTestId('loading-spinner');
    expect(spinner.className).toContain('w-5');
    expect(spinner.className).toContain('h-5');
  });

  it('applies md size classes', () => {
    render(<LoadingSpinner size="md" />);
    const spinner = screen.getByTestId('loading-spinner');
    expect(spinner.className).toContain('w-8');
    expect(spinner.className).toContain('h-8');
  });

  it('applies xl size classes', () => {
    render(<LoadingSpinner size="xl" />);
    const spinner = screen.getByTestId('loading-spinner');
    expect(spinner.className).toContain('w-12');
    expect(spinner.className).toContain('h-12');
  });

  it('is centered by default', () => {
    const { container } = render(<LoadingSpinner />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('flex');
    expect(wrapper.className).toContain('items-center');
  });

  it('supports inline mode with centered=false', () => {
    const { container } = render(<LoadingSpinner centered={false} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('inline-flex');
  });

  it('applies custom className', () => {
    const { container } = render(<LoadingSpinner className="mb-4" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('mb-4');
  });

  it('uses text as aria-label when provided', () => {
    render(<LoadingSpinner text="Please wait" />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Please wait');
  });

  it('uses "Loading" as default aria-label', () => {
    render(<LoadingSpinner />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Loading');
  });

  it('always has animate-spin class on spinner', () => {
    render(<LoadingSpinner />);
    const spinner = screen.getByTestId('loading-spinner');
    expect(spinner.className).toContain('animate-spin');
    expect(spinner.className).toContain('rounded-full');
  });
});
