/**
 * BudgetStatusBar Component Tests
 *
 * @module components/Monitoring/BudgetStatusBar.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { BudgetStatusBar } from './BudgetStatusBar';
import type { BudgetConfig } from '../../types';

const defaultConfig: BudgetConfig = {
  dailyLimit: 50,
  weeklyLimit: 200,
  monthlyLimit: 500,
  maxTokensPerTask: 100000,
  warningThreshold: 80,
};

describe('BudgetStatusBar', () => {
  it('should render the progress bar', () => {
    render(<BudgetStatusBar currentCost={10} budgetConfig={defaultConfig} />);

    expect(screen.getByTestId('budget-status-bar')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('should set correct aria attributes', () => {
    render(<BudgetStatusBar currentCost={25} budgetConfig={defaultConfig} />);

    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuenow', '50');
    expect(progressbar).toHaveAttribute('aria-valuemin', '0');
    expect(progressbar).toHaveAttribute('aria-valuemax', '100');
  });

  it('should show "On Track" for low usage', () => {
    render(<BudgetStatusBar currentCost={10} budgetConfig={defaultConfig} />);
    expect(screen.getByText(/On Track/)).toBeInTheDocument();
  });

  it('should show "Moderate" for 60-80% usage', () => {
    render(<BudgetStatusBar currentCost={35} budgetConfig={defaultConfig} />);
    expect(screen.getByText(/Moderate/)).toBeInTheDocument();
  });

  it('should show "Near Limit" for 80-100% usage', () => {
    render(<BudgetStatusBar currentCost={45} budgetConfig={defaultConfig} />);
    expect(screen.getByText(/Near Limit/)).toBeInTheDocument();
  });

  it('should show "Over Budget" for 100%+ usage', () => {
    render(<BudgetStatusBar currentCost={60} budgetConfig={defaultConfig} />);
    expect(screen.getByText(/Over Budget/)).toBeInTheDocument();
  });

  it('should display daily, weekly, and monthly limits', () => {
    render(<BudgetStatusBar currentCost={10} budgetConfig={defaultConfig} />);

    expect(screen.getByText('Daily: $50.00')).toBeInTheDocument();
    expect(screen.getByText('Weekly: $200.00')).toBeInTheDocument();
    expect(screen.getByText('Monthly: $500.00')).toBeInTheDocument();
  });

  it('should display current cost and daily limit in header', () => {
    render(<BudgetStatusBar currentCost={25.50} budgetConfig={defaultConfig} />);
    expect(screen.getByText(/\$25\.50/)).toBeInTheDocument();
    expect(screen.getByText(/\$50\.00 daily/)).toBeInTheDocument();
  });

  it('should handle zero daily limit without errors', () => {
    const zeroConfig = { ...defaultConfig, dailyLimit: 0 };
    render(<BudgetStatusBar currentCost={10} budgetConfig={zeroConfig} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });
});
