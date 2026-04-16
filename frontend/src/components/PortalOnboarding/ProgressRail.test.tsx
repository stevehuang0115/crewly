/**
 * Tests for ProgressRail component.
 *
 * @module components/PortalOnboarding/ProgressRail.test
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressRail } from './ProgressRail';

describe('ProgressRail', () => {
  it('renders all three steps', () => {
    render(<ProgressRail currentStep="url-input" />);
    expect(screen.getByTestId('progress-step-url-input')).toBeInTheDocument();
    expect(screen.getByTestId('progress-step-review')).toBeInTheDocument();
    expect(screen.getByTestId('progress-step-confirm')).toBeInTheDocument();
  });

  it('marks url-input as current on step 1', () => {
    render(<ProgressRail currentStep="url-input" />);
    const step = screen.getByTestId('progress-step-url-input');
    expect(step).toHaveAttribute('aria-current', 'step');
  });

  it('marks analyzing as step 1 (same as url-input)', () => {
    render(<ProgressRail currentStep="analyzing" />);
    const step = screen.getByTestId('progress-step-url-input');
    expect(step).toHaveAttribute('aria-current', 'step');
  });

  it('marks review as current on step 2', () => {
    render(<ProgressRail currentStep="review" />);
    const step = screen.getByTestId('progress-step-review');
    expect(step).toHaveAttribute('aria-current', 'step');
  });

  it('marks confirm as current on step 3', () => {
    render(<ProgressRail currentStep="confirm" />);
    const step = screen.getByTestId('progress-step-confirm');
    expect(step).toHaveAttribute('aria-current', 'step');
  });

  it('future steps are not marked as current', () => {
    render(<ProgressRail currentStep="url-input" />);
    const review = screen.getByTestId('progress-step-review');
    const confirm = screen.getByTestId('progress-step-confirm');
    expect(review).not.toHaveAttribute('aria-current');
    expect(confirm).not.toHaveAttribute('aria-current');
  });

  it('has navigation landmark role', () => {
    render(<ProgressRail currentStep="url-input" />);
    const nav = screen.getByLabelText('Onboarding progress');
    expect(nav).toBeInTheDocument();
    expect(nav.tagName).toBe('NAV');
  });

  it('applies additional className', () => {
    render(<ProgressRail currentStep="url-input" className="extra" />);
    const nav = screen.getByLabelText('Onboarding progress');
    expect(nav.className).toContain('extra');
  });
});
