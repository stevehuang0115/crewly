/**
 * Tests for ReviewCard component.
 *
 * @module components/PortalOnboarding/ReviewCard.test
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReviewCard } from './ReviewCard';
import type { ReviewCardConfig, OnboardingPrefill } from '../../types/onboarding.types';

const mockConfig: ReviewCardConfig = {
  title: 'Business Snapshot',
  icon: 'Building2',
  fields: [
    { key: 'businessName', label: 'Business Name', required: true },
    { key: 'industryCategory', label: 'Industry', required: true },
  ],
};

const mockPrefill: OnboardingPrefill = {
  businessName: {
    value: 'Test Co',
    sourceUrls: ['https://test.com'],
    confidence: 'high',
    extractionMethod: 'rule',
    needsReview: false,
  },
  industryCategory: {
    value: 'SaaS',
    sourceUrls: ['https://test.com/about'],
    confidence: 'medium',
    extractionMethod: 'llm_text',
    needsReview: true,
  },
};

describe('ReviewCard', () => {
  it('renders card title', () => {
    render(
      <ReviewCard
        config={mockConfig}
        prefill={mockPrefill}
        editedFields={new Set()}
        onFieldEdit={vi.fn()}
        onFieldReset={vi.fn()}
      />
    );
    expect(screen.getByText('Business Snapshot')).toBeInTheDocument();
  });

  it('renders all configured fields', () => {
    render(
      <ReviewCard
        config={mockConfig}
        prefill={mockPrefill}
        editedFields={new Set()}
        onFieldEdit={vi.fn()}
        onFieldReset={vi.fn()}
      />
    );
    expect(screen.getByText('Business Name')).toBeInTheDocument();
    expect(screen.getByText('Industry')).toBeInTheDocument();
  });

  it('renders field values from prefill', () => {
    render(
      <ReviewCard
        config={mockConfig}
        prefill={mockPrefill}
        editedFields={new Set()}
        onFieldEdit={vi.fn()}
        onFieldReset={vi.fn()}
      />
    );
    expect(screen.getByText('Test Co')).toBeInTheDocument();
    expect(screen.getByText('SaaS')).toBeInTheDocument();
  });

  it('shows confidence pills for fields', () => {
    render(
      <ReviewCard
        config={mockConfig}
        prefill={mockPrefill}
        editedFields={new Set()}
        onFieldEdit={vi.fn()}
        onFieldReset={vi.fn()}
      />
    );
    expect(screen.getByText('High confidence')).toBeInTheDocument();
    expect(screen.getByText('Medium confidence')).toBeInTheDocument();
  });

  it('has correct test ID', () => {
    render(
      <ReviewCard
        config={mockConfig}
        prefill={mockPrefill}
        editedFields={new Set()}
        onFieldEdit={vi.fn()}
        onFieldReset={vi.fn()}
      />
    );
    expect(
      screen.getByTestId('review-card-business-snapshot')
    ).toBeInTheDocument();
  });

  it('handles missing prefill data gracefully', () => {
    render(
      <ReviewCard
        config={mockConfig}
        prefill={{}}
        editedFields={new Set()}
        onFieldEdit={vi.fn()}
        onFieldReset={vi.fn()}
      />
    );
    // Should render without crashing
    expect(screen.getByText('Business Snapshot')).toBeInTheDocument();
  });

  it('marks edited fields correctly', () => {
    render(
      <ReviewCard
        config={mockConfig}
        prefill={mockPrefill}
        editedFields={new Set(['businessName'])}
        onFieldEdit={vi.fn()}
        onFieldReset={vi.fn()}
      />
    );
    // Manual confidence should appear for edited field
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });
});
