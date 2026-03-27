/**
 * BudgetStatusBar Component
 *
 * Full-width progress bar showing current spending against budget limits.
 * Color transitions through green, yellow, orange, and red based on usage percentage.
 *
 * @module components/Monitoring/BudgetStatusBar
 */

import React from 'react';
import type { BudgetConfig } from '../../types';

/**
 * Props for the BudgetStatusBar component.
 */
interface BudgetStatusBarProps {
  /** Current total cost in USD */
  currentCost: number;
  /** Budget configuration with limits */
  budgetConfig: BudgetConfig;
}

/**
 * Returns the appropriate color class based on usage percentage.
 *
 * @param percent - Usage percentage (0-100+)
 * @returns Tailwind background color class
 */
function getBarColor(percent: number): string {
  if (percent >= 100) return 'bg-red-500';
  if (percent >= 80) return 'bg-orange-500';
  if (percent >= 60) return 'bg-yellow-500';
  return 'bg-green-500';
}

/**
 * Returns a status label based on usage percentage.
 *
 * @param percent - Usage percentage (0-100+)
 * @returns Human-readable status text
 */
function getStatusLabel(percent: number): string {
  if (percent >= 100) return 'Over Budget';
  if (percent >= 80) return 'Near Limit';
  if (percent >= 60) return 'Moderate';
  return 'On Track';
}

/**
 * Formats a USD amount for display.
 *
 * @param value - Amount in USD
 * @returns Formatted string (e.g., "$12.34")
 */
function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Full-width progress bar with WCAG-compliant aria attributes.
 *
 * Shows daily spending progress against the daily budget limit,
 * with labeled amounts for daily, weekly, and monthly limits.
 * Color transitions through green (0-60%), yellow (60-80%),
 * orange (80-100%), and red (100%+).
 *
 * @param props - Current cost and budget configuration
 * @returns Accessible progress bar component
 */
export const BudgetStatusBar: React.FC<BudgetStatusBarProps> = ({
  currentCost,
  budgetConfig,
}) => {
  const dailyPercent = budgetConfig.dailyLimit > 0
    ? (currentCost / budgetConfig.dailyLimit) * 100
    : 0;
  const clampedPercent = Math.min(dailyPercent, 100);
  const barColor = getBarColor(dailyPercent);
  const statusLabel = getStatusLabel(dailyPercent);

  return (
    <div
      className="bg-surface-dark p-4 rounded-lg border border-border-dark"
      data-testid="budget-status-bar"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-text-primary-dark">
          Budget Status
        </span>
        <span className="text-xs font-medium text-text-secondary-dark">
          {statusLabel} &mdash; {formatCurrency(currentCost)} / {formatCurrency(budgetConfig.dailyLimit)} daily
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-background-dark rounded-full h-3 overflow-hidden">
        <div
          role="progressbar"
          aria-valuenow={Math.round(dailyPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Budget usage: ${Math.round(dailyPercent)}% of daily limit`}
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${clampedPercent}%` }}
        />
      </div>

      {/* Limit labels */}
      <div className="flex justify-between mt-2 text-xs text-text-secondary-dark">
        <span>Daily: {formatCurrency(budgetConfig.dailyLimit)}</span>
        <span>Weekly: {formatCurrency(budgetConfig.weeklyLimit)}</span>
        <span>Monthly: {formatCurrency(budgetConfig.monthlyLimit)}</span>
      </div>
    </div>
  );
};
