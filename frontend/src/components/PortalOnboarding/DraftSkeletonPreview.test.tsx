/**
 * DraftSkeletonPreview Tests
 *
 * @module components/PortalOnboarding/DraftSkeletonPreview.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DraftSkeletonPreview } from './DraftSkeletonPreview';

describe('DraftSkeletonPreview', () => {
  it('renders skeleton preview container', () => {
    render(<DraftSkeletonPreview />);
    expect(screen.getByTestId('draft-skeleton-preview')).toBeInTheDocument();
  });

  it('shows preview title', () => {
    render(<DraftSkeletonPreview />);
    expect(screen.getByText('Upcoming draft preview')).toBeInTheDocument();
  });

  it('shows setup card skeleton by default', () => {
    render(<DraftSkeletonPreview />);
    expect(screen.getByText('Recommended Setup')).toBeInTheDocument();
  });

  it('hides setup card when showSetupCard is false', () => {
    render(<DraftSkeletonPreview showSetupCard={false} />);
    expect(screen.queryByText('Recommended Setup')).not.toBeInTheDocument();
  });

  it('shows business snapshot and audience sections', () => {
    render(<DraftSkeletonPreview />);
    expect(screen.getByText('Business Snapshot')).toBeInTheDocument();
    expect(screen.getByText('Audience & Positioning')).toBeInTheDocument();
  });
});
