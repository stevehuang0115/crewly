/**
 * Tests for PortalOnboarding page component.
 *
 * @module pages/PortalOnboarding.test
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PortalOnboarding } from './PortalOnboarding';

// Mock API service
vi.mock('../services/api.service', () => ({
  apiService: {
    createOnboardingSession: vi.fn().mockResolvedValue({ sessionId: 'test-session-1' }),
    getOnboardingSession: vi.fn().mockResolvedValue({
      sessionId: 'test-session-1',
      websiteUrl: 'https://acme.com',
      status: 'draft_ready',
      summary: {
        companyName: 'Acme Corp',
        industry: 'SaaS',
        oneLineDescription: 'A SaaS company',
        statusLabel: 'High confidence draft',
      },
      prefill: {
        businessName: {
          value: 'Acme Corp',
          sourceUrls: ['https://acme.com'],
          confidence: 'high',
          extractionMethod: 'rule',
          needsReview: false,
        },
        industryCategory: {
          value: 'SaaS',
          sourceUrls: ['https://acme.com'],
          confidence: 'high',
          extractionMethod: 'llm_text',
          needsReview: false,
        },
        oneLineDescription: {
          value: 'A SaaS company',
          sourceUrls: ['https://acme.com'],
          confidence: 'high',
          extractionMethod: 'llm_text',
          needsReview: false,
        },
        targetCustomerHypothesis: {
          value: 'B2B companies',
          sourceUrls: ['https://acme.com'],
          confidence: 'high',
          extractionMethod: 'llm_text',
          needsReview: false,
        },
      },
    }),
    approveOnboardingProfile: vi.fn().mockResolvedValue({}),
    completeOnboarding: vi.fn().mockResolvedValue({}),
  },
}));

const renderWithRouter = (initialPath = '/portal/onboarding') => {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <PortalOnboarding />
    </MemoryRouter>
  );
};

describe('PortalOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders URL input step on initial load', () => {
    renderWithRouter();
    expect(screen.getByTestId('url-input-step')).toBeInTheDocument();
  });

  it('renders progress rail', () => {
    renderWithRouter();
    expect(screen.getByLabelText('Onboarding progress')).toBeInTheDocument();
  });

  it('shows URL input as current step initially', () => {
    renderWithRouter();
    const step = screen.getByTestId('progress-step-url-input');
    expect(step).toHaveAttribute('aria-current', 'step');
  });

  it('transitions to analyzing state on URL submit', async () => {
    renderWithRouter();
    const input = screen.getByTestId('url-input');
    fireEvent.change(input, { target: { value: 'acme.com' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByTestId('analysis-progress')).toBeInTheDocument();
    });
  });

  it('transitions to review step when session is draft_ready', async () => {
    renderWithRouter();
    const input = screen.getByTestId('url-input');
    fireEvent.change(input, { target: { value: 'acme.com' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByTestId('review-step')).toBeInTheDocument();
    });
  });

  it('shows company name in review step', async () => {
    renderWithRouter();
    const input = screen.getByTestId('url-input');
    fireEvent.change(input, { target: { value: 'acme.com' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      const elements = screen.getAllByText('Acme Corp');
      expect(elements.length).toBeGreaterThan(0);
    });
  });

  it('shows manual setup link', () => {
    renderWithRouter();
    expect(screen.getByTestId('manual-setup-link')).toBeInTheDocument();
  });
});
