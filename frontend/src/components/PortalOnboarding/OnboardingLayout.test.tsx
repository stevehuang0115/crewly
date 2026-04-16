/**
 * OnboardingLayout Tests
 *
 * @module components/PortalOnboarding/OnboardingLayout.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { OnboardingLayout } from './OnboardingLayout';

describe('OnboardingLayout', () => {
  it('renders layout shell', () => {
    render(<OnboardingLayout step="url-input"><p>Content</p></OnboardingLayout>);
    expect(screen.getByTestId('onboarding-layout')).toBeInTheDocument();
  });

  it('renders main content', () => {
    render(<OnboardingLayout step="url-input"><p>Hello</p></OnboardingLayout>);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('renders 5-step desktop progress rail', () => {
    render(<OnboardingLayout step="review"><p>Content</p></OnboardingLayout>);
    expect(screen.getByTestId('onboarding-progress-rail')).toBeInTheDocument();
    expect(screen.getByTestId('rail-step-connect')).toBeInTheDocument();
    expect(screen.getByTestId('rail-step-analyze')).toBeInTheDocument();
    expect(screen.getByTestId('rail-step-review')).toBeInTheDocument();
    expect(screen.getByTestId('rail-step-create')).toBeInTheDocument();
    expect(screen.getByTestId('rail-step-start')).toBeInTheDocument();
  });

  it('marks current step as active', () => {
    render(<OnboardingLayout step="review"><p>Content</p></OnboardingLayout>);
    expect(screen.getByTestId('rail-step-review')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('rail-step-connect')).not.toHaveAttribute('aria-current');
  });

  it('renders right panel when provided', () => {
    render(
      <OnboardingLayout step="review" rightPanel={<div>Trust Panel</div>}>
        <p>Content</p>
      </OnboardingLayout>
    );
    expect(screen.getByTestId('onboarding-right-panel')).toBeInTheDocument();
    expect(screen.getByText('Trust Panel')).toBeInTheDocument();
  });

  it('does not render right panel when omitted', () => {
    render(<OnboardingLayout step="review"><p>Content</p></OnboardingLayout>);
    expect(screen.queryByTestId('onboarding-right-panel')).not.toBeInTheDocument();
  });

  it('renders mobile header', () => {
    render(<OnboardingLayout step="url-input"><p>Content</p></OnboardingLayout>);
    expect(screen.getByTestId('onboarding-mobile-header')).toBeInTheDocument();
  });

  it('maps auth step to connect rail step', () => {
    render(<OnboardingLayout step="auth"><p>Content</p></OnboardingLayout>);
    expect(screen.getByTestId('rail-step-connect')).toHaveAttribute('aria-current', 'step');
  });

  it('maps creating step to create rail step', () => {
    render(<OnboardingLayout step="creating"><p>Content</p></OnboardingLayout>);
    expect(screen.getByTestId('rail-step-create')).toHaveAttribute('aria-current', 'step');
  });

  it('maps success step to start rail step', () => {
    render(<OnboardingLayout step="success"><p>Content</p></OnboardingLayout>);
    expect(screen.getByTestId('rail-step-start')).toHaveAttribute('aria-current', 'step');
  });
});
