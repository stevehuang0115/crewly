/**
 * Tests for OnboardingWizard component and shouldShowOnboarding utility.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OnboardingWizard, shouldShowOnboarding } from './OnboardingWizard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child step components to isolate wizard logic
vi.mock('./StepCloudConnect', () => ({
  StepCloudConnect: ({ onNext, onSkip }: any) => (
    <div data-testid="mock-step-cloud">
      <button data-testid="mock-skip" onClick={onSkip}>Skip</button>
      <button data-testid="mock-next" onClick={onNext}>Next</button>
    </div>
  ),
}));

vi.mock('./StepSelectTemplate', () => ({
  StepSelectTemplate: ({ onNext, onBack, onSelect }: any) => (
    <div data-testid="mock-step-template">
      <button data-testid="mock-select" onClick={() => onSelect({ id: 'dev', name: 'Dev Team', description: '', category: 'dev', icon: 'laptop', roles: [] })}>Select</button>
      <button data-testid="mock-back-template" onClick={onBack}>Back</button>
      <button data-testid="mock-next-template" onClick={onNext}>Next</button>
    </div>
  ),
}));

vi.mock('./StepReviewTeam', () => ({
  StepReviewTeam: ({ onNext, onBack }: any) => (
    <div data-testid="mock-step-review">
      <button data-testid="mock-back-review" onClick={onBack}>Back</button>
      <button data-testid="mock-next-review" onClick={onNext}>Next</button>
    </div>
  ),
}));

vi.mock('./StepLaunchProject', () => ({
  StepLaunchProject: ({ onLaunch, onBack }: any) => (
    <div data-testid="mock-step-launch">
      <button data-testid="mock-back-launch" onClick={onBack}>Back</button>
      <button data-testid="mock-launch" onClick={onLaunch}>Launch</button>
    </div>
  ),
}));

// Mock Modal to render children directly
vi.mock('../UI/Modal', () => ({
  Modal: ({ isOpen, children }: any) => isOpen ? <div data-testid="mock-modal">{children}</div> : null,
}));

describe('OnboardingWizard', () => {
  const defaultProps = {
    isOpen: true,
    onComplete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders step indicator and first step when open', () => {
    render(<OnboardingWizard {...defaultProps} />);
    expect(screen.getByTestId('onboarding-wizard')).toBeInTheDocument();
    expect(screen.getByTestId('step-indicator')).toBeInTheDocument();
    expect(screen.getByTestId('mock-step-cloud')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<OnboardingWizard {...defaultProps} isOpen={false} />);
    expect(screen.queryByTestId('onboarding-wizard')).not.toBeInTheDocument();
  });

  it('advances to template step on skip', () => {
    render(<OnboardingWizard {...defaultProps} />);
    fireEvent.click(screen.getByTestId('mock-skip'));
    expect(screen.getByTestId('mock-step-template')).toBeInTheDocument();
  });

  it('advances to template step on next', () => {
    render(<OnboardingWizard {...defaultProps} />);
    fireEvent.click(screen.getByTestId('mock-next'));
    expect(screen.getByTestId('mock-step-template')).toBeInTheDocument();
  });

  it('navigates back from template to cloud', () => {
    render(<OnboardingWizard {...defaultProps} />);
    fireEvent.click(screen.getByTestId('mock-next')); // -> template
    fireEvent.click(screen.getByTestId('mock-back-template')); // -> cloud
    expect(screen.getByTestId('mock-step-cloud')).toBeInTheDocument();
  });

  it('navigates through all 4 steps', () => {
    render(<OnboardingWizard {...defaultProps} />);
    fireEvent.click(screen.getByTestId('mock-skip')); // -> template
    expect(screen.getByTestId('mock-step-template')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mock-next-template')); // -> review
    expect(screen.getByTestId('mock-step-review')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mock-next-review')); // -> launch
    expect(screen.getByTestId('mock-step-launch')).toBeInTheDocument();
  });

  it('shows correct step testid for each step', () => {
    render(<OnboardingWizard {...defaultProps} />);
    expect(screen.getByTestId('onboarding-step-0')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mock-skip'));
    expect(screen.getByTestId('onboarding-step-1')).toBeInTheDocument();
  });
});

describe('shouldShowOnboarding', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns true when teamCount is 0 and no flags set', () => {
    expect(shouldShowOnboarding(0)).toBe(true);
  });

  it('returns false when teamCount > 0', () => {
    expect(shouldShowOnboarding(5)).toBe(false);
  });

  it('returns false when onboarding completed', () => {
    localStorage.setItem('crewly_onboarding_completed', 'true');
    expect(shouldShowOnboarding(0)).toBe(false);
  });

  it('returns false when onboarding dismissed', () => {
    localStorage.setItem('crewly_onboarding_dismissed', 'true');
    expect(shouldShowOnboarding(0)).toBe(false);
  });
});
