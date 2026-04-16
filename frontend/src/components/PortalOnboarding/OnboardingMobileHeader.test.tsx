/**
 * OnboardingMobileHeader Tests
 *
 * @module components/PortalOnboarding/OnboardingMobileHeader.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { OnboardingMobileHeader } from './OnboardingMobileHeader';

describe('OnboardingMobileHeader', () => {
  it('renders step label', () => {
    render(<OnboardingMobileHeader activeLabel="Review draft" stepIndex={2} stepCount={5} />);
    expect(screen.getByTestId('mobile-header-label')).toHaveTextContent('Review draft');
  });

  it('renders step counter', () => {
    render(<OnboardingMobileHeader activeLabel="Connect" stepIndex={0} stepCount={5} />);
    expect(screen.getByTestId('mobile-header-counter')).toHaveTextContent('1 / 5');
  });

  it('renders status text when provided', () => {
    render(
      <OnboardingMobileHeader activeLabel="Analyze" stepIndex={1} stepCount={5} statusText="Analyzing..." />
    );
    expect(screen.getByTestId('mobile-header-status')).toHaveTextContent('Analyzing...');
  });

  it('does not render status text when omitted', () => {
    render(<OnboardingMobileHeader activeLabel="Connect" stepIndex={0} stepCount={5} />);
    expect(screen.queryByTestId('mobile-header-status')).not.toBeInTheDocument();
  });

  it('renders progress bar with correct percentage', () => {
    render(<OnboardingMobileHeader activeLabel="Review" stepIndex={2} stepCount={5} />);
    const bar = screen.getByTestId('mobile-header-progress');
    expect(bar).toHaveStyle({ width: '50%' });
  });

  it('renders progress bar at 0% for first step', () => {
    render(<OnboardingMobileHeader activeLabel="Connect" stepIndex={0} stepCount={5} />);
    const bar = screen.getByTestId('mobile-header-progress');
    expect(bar).toHaveStyle({ width: '0%' });
  });
});
