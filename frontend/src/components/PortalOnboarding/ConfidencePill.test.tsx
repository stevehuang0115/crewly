/**
 * Tests for ConfidencePill component.
 *
 * @module components/PortalOnboarding/ConfidencePill.test
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfidencePill } from './ConfidencePill';

describe('ConfidencePill', () => {
  it('renders high confidence with correct label', () => {
    render(<ConfidencePill confidence="high" />);
    expect(screen.getByText('High confidence')).toBeInTheDocument();
  });

  it('renders medium confidence with correct label', () => {
    render(<ConfidencePill confidence="medium" />);
    expect(screen.getByText('Medium confidence')).toBeInTheDocument();
  });

  it('renders low confidence with correct label', () => {
    render(<ConfidencePill confidence="low" />);
    expect(screen.getByText('Low confidence')).toBeInTheDocument();
  });

  it('renders manual variant with correct label', () => {
    render(<ConfidencePill confidence="manual" />);
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });

  it('has correct test ID based on confidence', () => {
    render(<ConfidencePill confidence="high" />);
    expect(screen.getByTestId('confidence-pill-high')).toBeInTheDocument();
  });

  it('has aria-label for accessibility', () => {
    render(<ConfidencePill confidence="low" />);
    const pill = screen.getByTestId('confidence-pill-low');
    expect(pill).toHaveAttribute('aria-label', 'Low confidence');
  });

  it('applies additional className', () => {
    render(<ConfidencePill confidence="high" className="extra-class" />);
    const pill = screen.getByTestId('confidence-pill-high');
    expect(pill.className).toContain('extra-class');
  });

  it('renders colored dot indicator', () => {
    render(<ConfidencePill confidence="high" />);
    const pill = screen.getByTestId('confidence-pill-high');
    const dot = pill.querySelector('[aria-hidden="true"]');
    expect(dot).toBeInTheDocument();
  });
});
