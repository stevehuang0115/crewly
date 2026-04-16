/**
 * Tests for ReviewStep component.
 *
 * @module components/PortalOnboarding/ReviewStep.test
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReviewStep } from './ReviewStep';
import type { OnboardingPrefill, OnboardingSummary } from '../../types/onboarding.types';

const mockSummary: OnboardingSummary = {
  companyName: 'Acme Corp',
  industry: 'SaaS',
  oneLineDescription: 'Leading provider of SaaS solutions',
  statusLabel: 'Draft needs review',
};

const mockPrefill: OnboardingPrefill = {
  businessName: {
    value: 'Acme Corp',
    sourceUrls: ['https://acme.com'],
    confidence: 'high',
    extractionMethod: 'rule',
    needsReview: false,
  },
  industryCategory: {
    value: 'SaaS',
    sourceUrls: ['https://acme.com/about'],
    confidence: 'high',
    extractionMethod: 'llm_text',
    needsReview: false,
  },
  targetCustomerHypothesis: {
    value: 'B2B companies',
    sourceUrls: ['https://acme.com'],
    confidence: 'medium',
    extractionMethod: 'llm_text',
    needsReview: true,
  },
};

const defaultProps = {
  websiteUrl: 'https://acme.com',
  summary: mockSummary,
  prefill: mockPrefill,
  editedFields: new Set<string>(),
  onFieldEdit: vi.fn(),
  onFieldReset: vi.fn(),
  onConfirm: vi.fn(),
  hasBlockingFields: false,
};

describe('ReviewStep', () => {
  it('renders the review step container', () => {
    render(<ReviewStep {...defaultProps} />);
    expect(screen.getByTestId('review-step')).toBeInTheDocument();
  });

  it('shows company name in hero', () => {
    render(<ReviewStep {...defaultProps} />);
    // Company name appears in hero and possibly in cards; check it exists
    const elements = screen.getAllByText('Acme Corp');
    expect(elements.length).toBeGreaterThan(0);
  });

  it('shows website domain', () => {
    render(<ReviewStep {...defaultProps} />);
    expect(screen.getByText(/acme\.com/)).toBeInTheDocument();
  });

  it('shows industry tag', () => {
    render(<ReviewStep {...defaultProps} />);
    // Industry appears in hero and card fields; check it exists
    const elements = screen.getAllByText(/SaaS/);
    expect(elements.length).toBeGreaterThan(0);
  });

  it('shows status badge', () => {
    render(<ReviewStep {...defaultProps} />);
    // Should show a badge based on confidence levels
    const badge = screen.getByText(/confidence draft|needs review/i);
    expect(badge).toBeInTheDocument();
  });

  it('renders all review cards', () => {
    render(<ReviewStep {...defaultProps} />);
    expect(
      screen.getByTestId('review-card-business-snapshot')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('review-card-audience-&-positioning')
    ).toBeInTheDocument();
  });

  it('shows "Ready to confirm" when no blocking fields', () => {
    render(<ReviewStep {...defaultProps} hasBlockingFields={false} />);
    expect(screen.getByText('Ready to confirm')).toBeInTheDocument();
  });

  it('shows blocking message when has blocking fields', () => {
    render(<ReviewStep {...defaultProps} hasBlockingFields={true} />);
    expect(
      screen.getByText(/required fields need review/i)
    ).toBeInTheDocument();
  });

  it('disables continue button when has blocking fields', () => {
    render(<ReviewStep {...defaultProps} hasBlockingFields={true} />);
    const btn = screen.getByTestId('continue-to-confirm-btn');
    expect(btn).toBeDisabled();
  });

  it('enables continue button when no blocking fields', () => {
    render(<ReviewStep {...defaultProps} hasBlockingFields={false} />);
    const btn = screen.getByTestId('continue-to-confirm-btn');
    expect(btn).not.toBeDisabled();
  });

  it('calls onConfirm when continue clicked', () => {
    const onConfirm = vi.fn();
    render(
      <ReviewStep {...defaultProps} onConfirm={onConfirm} hasBlockingFields={false} />
    );
    fireEvent.click(screen.getByTestId('continue-to-confirm-btn'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('shows warning when draft needs review', () => {
    const prefillWithLow: OnboardingPrefill = {
      ...mockPrefill,
      competitorCandidates: {
        value: ['Competitor A'],
        sourceUrls: [],
        confidence: 'low',
        extractionMethod: 'llm_text',
        needsReview: true,
      },
    };
    render(<ReviewStep {...defaultProps} prefill={prefillWithLow} />);
    expect(
      screen.getByText(/review anything highlighted/i)
    ).toBeInTheDocument();
  });
});
