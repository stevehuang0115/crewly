/**
 * BudgetConfigPanel Component Tests
 *
 * @module components/Monitoring/BudgetConfigPanel.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { BudgetConfigPanel } from './BudgetConfigPanel';
import type { BudgetConfig } from '../../types';

const defaultConfig: BudgetConfig = {
  dailyLimit: 50,
  weeklyLimit: 200,
  monthlyLimit: 500,
  maxTokensPerTask: 100000,
  warningThreshold: 80,
};

describe('BudgetConfigPanel', () => {
  it('should render collapsed by default', () => {
    render(
      <BudgetConfigPanel config={defaultConfig} onSave={vi.fn()} onReset={vi.fn()} />
    );

    expect(screen.getByTestId('budget-config-panel')).toBeInTheDocument();
    expect(screen.getByText('Budget Configuration')).toBeInTheDocument();
    // Content should not be visible
    expect(screen.queryByTestId('budget-edit-btn')).not.toBeInTheDocument();
  });

  it('should expand when header is clicked', () => {
    render(
      <BudgetConfigPanel config={defaultConfig} onSave={vi.fn()} onReset={vi.fn()} />
    );

    fireEvent.click(screen.getByText('Budget Configuration'));

    // Should now show edit button and values
    expect(screen.getByTestId('budget-edit-btn')).toBeInTheDocument();
    expect(screen.getByTestId('budget-value-dailyLimit')).toHaveTextContent('$50');
  });

  it('should toggle aria-expanded', () => {
    render(
      <BudgetConfigPanel config={defaultConfig} onSave={vi.fn()} onReset={vi.fn()} />
    );

    const toggle = screen.getByRole('button', { name: /Budget Configuration/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('should display read-only values when expanded', () => {
    render(
      <BudgetConfigPanel config={defaultConfig} onSave={vi.fn()} onReset={vi.fn()} />
    );

    fireEvent.click(screen.getByText('Budget Configuration'));

    expect(screen.getByTestId('budget-value-dailyLimit')).toHaveTextContent('$50');
    expect(screen.getByTestId('budget-value-weeklyLimit')).toHaveTextContent('$200');
    expect(screen.getByTestId('budget-value-monthlyLimit')).toHaveTextContent('$500');
    expect(screen.getByTestId('budget-value-warningThreshold')).toHaveTextContent('80%');
  });

  it('should switch to edit mode on Edit click', () => {
    render(
      <BudgetConfigPanel config={defaultConfig} onSave={vi.fn()} onReset={vi.fn()} />
    );

    fireEvent.click(screen.getByText('Budget Configuration'));
    fireEvent.click(screen.getByTestId('budget-edit-btn'));

    expect(screen.getByTestId('budget-input-dailyLimit')).toBeInTheDocument();
    expect(screen.getByTestId('budget-save-btn')).toBeInTheDocument();
    expect(screen.getByTestId('budget-cancel-btn')).toBeInTheDocument();
  });

  it('should revert to read-only on Cancel', () => {
    render(
      <BudgetConfigPanel config={defaultConfig} onSave={vi.fn()} onReset={vi.fn()} />
    );

    fireEvent.click(screen.getByText('Budget Configuration'));
    fireEvent.click(screen.getByTestId('budget-edit-btn'));
    fireEvent.click(screen.getByTestId('budget-cancel-btn'));

    expect(screen.queryByTestId('budget-input-dailyLimit')).not.toBeInTheDocument();
    expect(screen.getByTestId('budget-edit-btn')).toBeInTheDocument();
  });

  it('should call onSave with updated values', () => {
    const onSave = vi.fn().mockReturnValue(null);

    render(
      <BudgetConfigPanel config={defaultConfig} onSave={onSave} onReset={vi.fn()} />
    );

    fireEvent.click(screen.getByText('Budget Configuration'));
    fireEvent.click(screen.getByTestId('budget-edit-btn'));

    const dailyInput = screen.getByTestId('budget-input-dailyLimit');
    fireEvent.change(dailyInput, { target: { value: '100' } });

    fireEvent.click(screen.getByTestId('budget-save-btn'));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ dailyLimit: 100 }));
  });

  it('should show validation errors when save fails', () => {
    const onSave = vi.fn().mockReturnValue({ dailyLimit: 'Must be positive' });

    render(
      <BudgetConfigPanel config={defaultConfig} onSave={onSave} onReset={vi.fn()} />
    );

    fireEvent.click(screen.getByText('Budget Configuration'));
    fireEvent.click(screen.getByTestId('budget-edit-btn'));
    fireEvent.click(screen.getByTestId('budget-save-btn'));

    expect(screen.getByRole('alert')).toHaveTextContent('Must be positive');
    // Should stay in edit mode
    expect(screen.getByTestId('budget-save-btn')).toBeInTheDocument();
  });

  it('should call onReset when reset button is clicked', () => {
    const onReset = vi.fn();

    render(
      <BudgetConfigPanel config={defaultConfig} onSave={vi.fn()} onReset={onReset} />
    );

    fireEvent.click(screen.getByText('Budget Configuration'));
    fireEvent.click(screen.getByTestId('budget-reset-btn'));

    expect(onReset).toHaveBeenCalledOnce();
  });
});
