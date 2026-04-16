/**
 * BrandSummaryHero Tests
 *
 * @module components/PortalOnboarding/BrandSummaryHero.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { BrandSummaryHero } from './BrandSummaryHero';

describe('BrandSummaryHero', () => {
  const baseProps = {
    companyName: 'Northstar Studio',
    websiteUrl: 'https://northstarstudio.co',
    status: 'high' as const,
  };

  it('renders company name', () => {
    render(<BrandSummaryHero {...baseProps} />);
    expect(screen.getByTestId('brand-name')).toHaveTextContent('Northstar Studio');
  });

  it('renders website URL', () => {
    render(<BrandSummaryHero {...baseProps} />);
    expect(screen.getByTestId('brand-url')).toHaveTextContent('https://northstarstudio.co');
  });

  it('renders monogram when no favicon', () => {
    render(<BrandSummaryHero {...baseProps} />);
    expect(screen.getByTestId('brand-monogram')).toHaveTextContent('N');
  });

  it('renders custom monogram', () => {
    render(<BrandSummaryHero {...baseProps} monogram="NS" />);
    expect(screen.getByTestId('brand-monogram')).toHaveTextContent('NS');
  });

  it('renders favicon when provided', () => {
    render(<BrandSummaryHero {...baseProps} faviconUrl="https://example.com/favicon.png" />);
    expect(screen.getByTestId('brand-favicon')).toBeInTheDocument();
    expect(screen.queryByTestId('brand-monogram')).not.toBeInTheDocument();
  });

  it('renders industry when provided', () => {
    render(<BrandSummaryHero {...baseProps} industry="B2B design agency" />);
    expect(screen.getByTestId('brand-industry')).toHaveTextContent('B2B design agency');
  });

  it('renders description when provided', () => {
    render(<BrandSummaryHero {...baseProps} description="Premium design services" />);
    expect(screen.getByTestId('brand-description')).toHaveTextContent('Premium design services');
  });

  it('shows high confidence badge', () => {
    render(<BrandSummaryHero {...baseProps} status="high" />);
    expect(screen.getByText('High confidence draft')).toBeInTheDocument();
  });

  it('shows needs-review badge', () => {
    render(<BrandSummaryHero {...baseProps} status="needs-review" />);
    expect(screen.getByText('Review required')).toBeInTheDocument();
  });
});
