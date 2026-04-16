/**
 * OnboardingStepHeader Tests
 *
 * @module components/PortalOnboarding/OnboardingStepHeader.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { OnboardingStepHeader } from './OnboardingStepHeader';

describe('OnboardingStepHeader', () => {
  it('renders title', () => {
    render(<OnboardingStepHeader title="Test Title" />);
    expect(screen.getByTestId('step-header-title')).toHaveTextContent('Test Title');
  });

  it('renders subtitle when provided', () => {
    render(<OnboardingStepHeader title="Title" subtitle="Sub text" />);
    expect(screen.getByTestId('step-header-subtitle')).toHaveTextContent('Sub text');
  });

  it('does not render subtitle when omitted', () => {
    render(<OnboardingStepHeader title="Title" />);
    expect(screen.queryByTestId('step-header-subtitle')).not.toBeInTheDocument();
  });

  it('renders status slot', () => {
    render(
      <OnboardingStepHeader title="Title" statusSlot={<span>Status</span>} />
    );
    expect(screen.getByTestId('step-header-status')).toHaveTextContent('Status');
  });

  it('applies center alignment class', () => {
    render(<OnboardingStepHeader title="Title" align="center" />);
    expect(screen.getByTestId('onboarding-step-header')).toHaveClass('text-center');
  });

  it('applies left alignment by default', () => {
    render(<OnboardingStepHeader title="Title" />);
    expect(screen.getByTestId('onboarding-step-header')).toHaveClass('text-left');
  });
});
