/**
 * Tests for ConfirmStep component.
 *
 * @module components/PortalOnboarding/ConfirmStep.test
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmStep } from './ConfirmStep';
import type { OnboardingPrefill } from '../../types/onboarding.types';

const mockPrefill: OnboardingPrefill = {
  suggestedTeamName: {
    value: 'Acme Growth Team',
    sourceUrls: [],
    confidence: 'medium',
    extractionMethod: 'llm_text',
    needsReview: true,
  },
  recommendedTemplate: {
    value: 'Marketing Squad',
    sourceUrls: [],
    confidence: 'medium',
    extractionMethod: 'llm_text',
    needsReview: true,
  },
  suggestedFirstWorkflow: {
    value: 'Weekly campaign brief',
    sourceUrls: [],
    confidence: 'medium',
    extractionMethod: 'llm_text',
    needsReview: true,
  },
  suggestedFirstIntegration: {
    value: 'Slack',
    sourceUrls: [],
    confidence: 'low',
    extractionMethod: 'llm_text',
    needsReview: true,
  },
};

const defaultProps = {
  prefill: mockPrefill,
  onConfirm: vi.fn().mockResolvedValue(undefined),
  onBack: vi.fn(),
  hasBlockingFields: false,
};

describe('ConfirmStep', () => {
  it('renders the confirm step', () => {
    render(<ConfirmStep {...defaultProps} />);
    expect(screen.getByTestId('confirm-step')).toBeInTheDocument();
  });

  it('shows heading', () => {
    render(<ConfirmStep {...defaultProps} />);
    expect(
      screen.getByText(/ready to create your workspace/i)
    ).toBeInTheDocument();
  });

  it('shows team name in summary', () => {
    render(<ConfirmStep {...defaultProps} />);
    expect(screen.getByText('Acme Growth Team')).toBeInTheDocument();
  });

  it('shows template in summary', () => {
    render(<ConfirmStep {...defaultProps} />);
    expect(screen.getByText('Marketing Squad')).toBeInTheDocument();
  });

  it('shows workflow in summary', () => {
    render(<ConfirmStep {...defaultProps} />);
    expect(screen.getByText('Weekly campaign brief')).toBeInTheDocument();
  });

  it('shows integration in summary', () => {
    render(<ConfirmStep {...defaultProps} />);
    expect(screen.getByText('Slack')).toBeInTheDocument();
  });

  it('shows acknowledgement checkbox', () => {
    render(<ConfirmStep {...defaultProps} />);
    expect(screen.getByTestId('acknowledge-checkbox')).toBeInTheDocument();
  });

  it('disables create button when not acknowledged', () => {
    render(<ConfirmStep {...defaultProps} />);
    const btn = screen.getByTestId('create-workspace-btn');
    expect(btn).toBeDisabled();
  });

  it('enables create button when acknowledged', () => {
    render(<ConfirmStep {...defaultProps} />);
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    const btn = screen.getByTestId('create-workspace-btn');
    expect(btn).not.toBeDisabled();
  });

  it('disables create button when has blocking fields', () => {
    render(<ConfirmStep {...defaultProps} hasBlockingFields={true} />);
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    const btn = screen.getByTestId('create-workspace-btn');
    expect(btn).toBeDisabled();
  });

  it('calls onBack when back button clicked', () => {
    const onBack = vi.fn();
    render(<ConfirmStep {...defaultProps} onBack={onBack} />);
    fireEvent.click(screen.getByTestId('back-to-review-btn'));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('shows back to review button', () => {
    render(<ConfirmStep {...defaultProps} />);
    expect(screen.getByTestId('back-to-review-btn')).toBeInTheDocument();
  });

  it('uses default team name when not in prefill', () => {
    render(<ConfirmStep {...defaultProps} prefill={{}} />);
    expect(screen.getByText('My Crewly Team')).toBeInTheDocument();
  });
});
