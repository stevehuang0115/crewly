/**
 * Tests for StepIndicator component.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { StepIndicator } from './StepIndicator';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const STEPS = ['Cloud', 'Template', 'Team', 'Launch'];

describe('StepIndicator', () => {
  it('renders all step labels', () => {
    render(<StepIndicator steps={STEPS} currentStep={0} />);
    STEPS.forEach(label => {
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  });

  it('marks the current step with aria-current="step"', () => {
    render(<StepIndicator steps={STEPS} currentStep={1} />);
    const step1 = screen.getByTestId('step-1');
    const circle = step1.querySelector('[aria-current="step"]');
    expect(circle).toBeInTheDocument();
  });

  it('shows checkmarks for completed steps', () => {
    render(<StepIndicator steps={STEPS} currentStep={2} />);
    // Steps 0 and 1 are completed, should not show numbers
    const step0 = screen.getByTestId('step-0');
    expect(step0.textContent).not.toContain('1');
  });

  it('shows numbers for future steps', () => {
    render(<StepIndicator steps={STEPS} currentStep={0} />);
    const step3 = screen.getByTestId('step-3');
    expect(step3.textContent).toContain('4');
  });

  it('renders the step indicator container', () => {
    render(<StepIndicator steps={STEPS} currentStep={0} />);
    expect(screen.getByTestId('step-indicator')).toBeInTheDocument();
  });
});
