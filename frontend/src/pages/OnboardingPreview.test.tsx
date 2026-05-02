/**
 * Tests for the OnboardingPreview internal route.
 *
 * @module pages/OnboardingPreview.test
 */

import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OnboardingPreview } from './OnboardingPreview';

describe('OnboardingPreview', () => {
  it('renders the nav + stage shell', () => {
    render(<OnboardingPreview />);
    expect(screen.getByTestId('onboarding-preview')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-preview-nav')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-preview-stage')).toBeInTheDocument();
  });

  it('lists all sidebar stories + shell stories + reveal demo in the picker', () => {
    render(<OnboardingPreview />);
    [
      'all-empty',
      'business-profile-populated',
      'match-report-populated',
      'all-populated',
      'shell-all-empty',
      'shell-business-profile',
      'shell-match-report',
      'shell-all-populated',
      'progressive-reveal-demo',
    ].forEach((id) => {
      expect(
        screen.getByTestId(`onboarding-preview-pick-${id}`)
      ).toBeInTheDocument();
    });
  });

  it('renders the first story by default', () => {
    render(<OnboardingPreview />);
    // First story is BLUEPRINT_SIDEBAR_STORIES[0] = "all-empty".
    expect(screen.getByTestId('blueprint-sidebar')).toBeInTheDocument();
  });

  it('switches stories when a picker button is clicked', () => {
    render(<OnboardingPreview />);
    fireEvent.click(screen.getByTestId('onboarding-preview-pick-shell-all-populated'));
    expect(screen.getByTestId('onboarding-shell')).toBeInTheDocument();
    expect(screen.getByTestId('blueprint-block-business-profile')).toHaveAttribute(
      'data-state',
      'populated'
    );
  });

  it('progressive-reveal-demo walks through all 4 stages', () => {
    render(<OnboardingPreview />);
    fireEvent.click(
      screen.getByTestId('onboarding-preview-pick-progressive-reveal-demo')
    );
    // Starts at S2 — all empty
    expect(screen.getByTestId('blueprint-block-business-profile')).toHaveAttribute(
      'data-state',
      'empty'
    );
    // Click "Next →" three times to reach S5 fully populated.
    const nextBtn = screen.getByTestId('reveal-demo-next');
    fireEvent.click(nextBtn);
    fireEvent.click(nextBtn);
    fireEvent.click(nextBtn);
    expect(screen.getByTestId('blueprint-block-brand')).toHaveAttribute(
      'data-state',
      'populated'
    );
    // Next button is disabled at the last stage.
    expect(nextBtn).toBeDisabled();
  });
});
