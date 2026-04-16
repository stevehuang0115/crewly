/**
 * CreationProgressSequence Tests
 *
 * @module components/PortalOnboarding/CreationProgressSequence.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CreationProgressSequence } from './CreationProgressSequence';

describe('CreationProgressSequence', () => {
  const stages = ['Saving profile', 'Creating workspace', 'Preparing next steps'];

  it('renders all stages', () => {
    render(<CreationProgressSequence stages={stages} activeIndex={1} />);
    expect(screen.getByTestId('creation-stage-0')).toBeInTheDocument();
    expect(screen.getByTestId('creation-stage-1')).toBeInTheDocument();
    expect(screen.getByTestId('creation-stage-2')).toBeInTheDocument();
  });

  it('shows spinner when no error', () => {
    render(<CreationProgressSequence stages={stages} activeIndex={0} />);
    expect(screen.getByTestId('creation-spinner')).toBeInTheDocument();
  });

  it('shows error icon on failure', () => {
    render(<CreationProgressSequence stages={stages} activeIndex={1} error="Failed" />);
    expect(screen.getByTestId('creation-error-icon')).toBeInTheDocument();
  });

  it('shows error message and retry button', () => {
    const onRetry = vi.fn();
    render(
      <CreationProgressSequence stages={stages} activeIndex={1} error="Network error" onRetry={onRetry} />
    );
    expect(screen.getByText('Network error')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('creation-retry-btn'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows keep-open note when not errored', () => {
    render(<CreationProgressSequence stages={stages} activeIndex={0} />);
    expect(screen.getByTestId('creation-keep-open')).toBeInTheDocument();
  });

  it('hides keep-open note on error', () => {
    render(<CreationProgressSequence stages={stages} activeIndex={0} error="Fail" />);
    expect(screen.queryByTestId('creation-keep-open')).not.toBeInTheDocument();
  });
});
