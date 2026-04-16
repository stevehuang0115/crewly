/**
 * Tests for AnalysisProgress component.
 *
 * @module components/PortalOnboarding/AnalysisProgress.test
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnalysisProgress } from './AnalysisProgress';

describe('AnalysisProgress', () => {
  it('renders progress checklist', () => {
    render(<AnalysisProgress />);
    expect(screen.getByTestId('analysis-progress')).toBeInTheDocument();
  });

  it('shows "Analyzing your website" heading', () => {
    render(<AnalysisProgress />);
    expect(
      screen.getByText(/analyzing your website/i)
    ).toBeInTheDocument();
  });

  it('renders all 4 analysis stages', () => {
    render(<AnalysisProgress />);
    expect(screen.getByTestId('analysis-stage-0')).toBeInTheDocument();
    expect(screen.getByTestId('analysis-stage-1')).toBeInTheDocument();
    expect(screen.getByTestId('analysis-stage-2')).toBeInTheDocument();
    expect(screen.getByTestId('analysis-stage-3')).toBeInTheDocument();
  });

  it('first stage is current on mount', () => {
    render(<AnalysisProgress />);
    const first = screen.getByTestId('analysis-stage-0');
    expect(first).toHaveAttribute('aria-current', 'step');
  });

  it('shows skeleton preview', () => {
    render(<AnalysisProgress />);
    // Skeleton should have pulse animations
    const pulseElements = document.querySelectorAll('.animate-pulse');
    expect(pulseElements.length).toBeGreaterThan(0);
  });

  it('renders failure state when hasFailed is true', () => {
    render(
      <AnalysisProgress
        hasFailed={true}
        errorMessage="Site unreachable"
      />
    );
    expect(screen.getByTestId('analysis-failed')).toBeInTheDocument();
    expect(screen.getByText('Site unreachable')).toBeInTheDocument();
  });

  it('shows review partial button when partial data available', () => {
    render(
      <AnalysisProgress
        hasFailed={true}
        hasPartialData={true}
        onReviewPartial={vi.fn()}
      />
    );
    expect(screen.getByTestId('review-partial-btn')).toBeInTheDocument();
  });

  it('shows retry button on failure', () => {
    render(
      <AnalysisProgress
        hasFailed={true}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByTestId('retry-url-btn')).toBeInTheDocument();
  });

  it('does not show retry button when no handler', () => {
    render(<AnalysisProgress hasFailed={true} />);
    expect(screen.queryByTestId('retry-url-btn')).not.toBeInTheDocument();
  });

  it('has accessible stage list', () => {
    render(<AnalysisProgress />);
    const list = screen.getByRole('list', { name: /analysis stages/i });
    expect(list).toBeInTheDocument();
  });
});
