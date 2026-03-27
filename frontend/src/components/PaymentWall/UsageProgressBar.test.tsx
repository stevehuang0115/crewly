/**
 * UsageProgressBar Test Suite
 *
 * Tests rendering, width calculation, color transitions,
 * and accessibility attributes.
 *
 * @module components/PaymentWall/UsageProgressBar.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { UsageProgressBar } from './UsageProgressBar';

describe('UsageProgressBar', () => {
  it('renders with correct text showing current/max', () => {
    render(<UsageProgressBar current={2} max={5} />);

    expect(screen.getByText('2/5')).toBeInTheDocument();
  });

  it('sets correct width style based on current/max ratio', () => {
    render(<UsageProgressBar current={3} max={6} />);

    const fill = screen.getByTestId('usage-bar-fill');
    expect(fill).toHaveStyle({ width: '50%' });
  });

  it('caps width at 100% when current exceeds max', () => {
    render(<UsageProgressBar current={10} max={5} />);

    const fill = screen.getByTestId('usage-bar-fill');
    expect(fill).toHaveStyle({ width: '100%' });
  });

  it('shows 0% width when max is 0', () => {
    render(<UsageProgressBar current={0} max={0} />);

    const fill = screen.getByTestId('usage-bar-fill');
    expect(fill).toHaveStyle({ width: '0%' });
  });

  it('uses yellow fill color when at 100%', () => {
    render(<UsageProgressBar current={5} max={5} />);

    const fill = screen.getByTestId('usage-bar-fill');
    expect(fill.className).toContain('bg-yellow-500');
    expect(fill.className).not.toContain('bg-primary');
  });

  it('uses primary blue fill color when below limit', () => {
    render(<UsageProgressBar current={2} max={5} />);

    const fill = screen.getByTestId('usage-bar-fill');
    expect(fill.className).toContain('bg-primary');
    expect(fill.className).not.toContain('bg-yellow-500');
  });

  it('uses yellow fill color when current exceeds max', () => {
    render(<UsageProgressBar current={7} max={5} />);

    const fill = screen.getByTestId('usage-bar-fill');
    expect(fill.className).toContain('bg-yellow-500');
  });

  it('has correct aria attributes on the progressbar', () => {
    render(<UsageProgressBar current={3} max={10} />);

    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuenow', '3');
    expect(progressbar).toHaveAttribute('aria-valuemax', '10');
    expect(progressbar).toHaveAttribute('aria-label', 'Usage: 3 of 10');
  });

  it('applies additional className when provided', () => {
    const { container } = render(
      <UsageProgressBar current={1} max={5} className="mt-4" />,
    );

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('mt-4');
  });

  it('has transition classes on the fill element', () => {
    render(<UsageProgressBar current={2} max={5} />);

    const fill = screen.getByTestId('usage-bar-fill');
    expect(fill.className).toContain('transition-all');
    expect(fill.className).toContain('duration-400');
    expect(fill.className).toContain('ease-out');
  });

  it('has rounded-full on both track and fill', () => {
    render(<UsageProgressBar current={2} max={5} />);

    const progressbar = screen.getByRole('progressbar');
    const fill = screen.getByTestId('usage-bar-fill');
    expect(progressbar.className).toContain('rounded-full');
    expect(fill.className).toContain('rounded-full');
  });
});
