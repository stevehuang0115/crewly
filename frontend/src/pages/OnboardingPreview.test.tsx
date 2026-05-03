/**
 * Tests for the OnboardingPreview internal route.
 *
 * @module pages/OnboardingPreview.test
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OnboardingPreview } from './OnboardingPreview';

/**
 * Stub window.location.search so the URL-driven deep-link helpers can
 * be exercised without navigating the JSDOM frame. Restores the
 * original href in afterEach.
 */
function setSearch(qs: string): void {
  const url = new URL('http://localhost' + (qs ? `/onboarding-preview${qs.startsWith('?') ? qs : '?' + qs}` : '/onboarding-preview'));
  window.history.replaceState({}, '', url.pathname + url.search);
}

describe('OnboardingPreview', () => {
  beforeEach(() => {
    setSearch('');
  });
  afterEach(() => {
    setSearch('');
  });

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

  it('honors ?stage=S5 to deep-link directly to shell-all-populated', () => {
    setSearch('?stage=S5');
    render(<OnboardingPreview />);
    expect(screen.getByTestId('onboarding-shell')).toBeInTheDocument();
    expect(screen.getByTestId('blueprint-block-business-profile')).toHaveAttribute(
      'data-state',
      'populated'
    );
  });

  it('honors ?stage=s3 (case-insensitive) to deep-link to shell-business-profile', () => {
    setSearch('?stage=s3');
    render(<OnboardingPreview />);
    expect(screen.getByTestId('onboarding-shell')).toBeInTheDocument();
  });

  it('honors ?story=<id> direct deep-link', () => {
    setSearch('?story=shell-match-report');
    render(<OnboardingPreview />);
    expect(screen.getByTestId('onboarding-shell')).toBeInTheDocument();
    expect(screen.getByTestId('blueprint-block-match-report')).toHaveAttribute(
      'data-state',
      'populated'
    );
  });

  it('falls back to first story when ?stage value is unrecognised', () => {
    setSearch('?stage=S99');
    render(<OnboardingPreview />);
    // First story is BLUEPRINT_SIDEBAR_STORIES[0] = "all-empty".
    expect(screen.getByTestId('blueprint-sidebar')).toBeInTheDocument();
  });

  it('?w=narrow wraps the story in a fixed-width iframe (drawer-collapse preview)', () => {
    setSearch('?w=narrow');
    render(<OnboardingPreview />);
    expect(screen.getByTestId('onboarding-preview-narrow-frame')).toBeInTheDocument();
  });

  it('?bare=1 renders the story without the surrounding nav', () => {
    setSearch('?bare=1');
    render(<OnboardingPreview />);
    expect(screen.getByTestId('onboarding-preview-bare')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-preview-nav')).not.toBeInTheDocument();
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
