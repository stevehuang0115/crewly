/**
 * UsageProgressBar Component
 *
 * Mini horizontal progress bar showing current/max resource usage.
 * Fills in primary blue when under the limit and yellow when at 100%.
 *
 * @module components/PaymentWall/UsageProgressBar
 */

import React from 'react';

/**
 * Props for the UsageProgressBar component
 */
export interface UsageProgressBarProps {
  /** Current usage count */
  current: number;
  /** Maximum allowed by plan */
  max: number;
  /** Additional CSS classes for the outer wrapper */
  className?: string;
}

/**
 * Mini progress bar showing current/max usage with color feedback.
 *
 * The fill transitions smoothly and changes from primary blue to
 * yellow-500 when the user reaches 100% of their limit.
 *
 * @param current - Current usage count
 * @param max - Maximum allowed by the plan
 * @param className - Optional additional CSS classes
 * @returns A progress bar element with usage text
 *
 * @example
 * ```tsx
 * <UsageProgressBar current={2} max={3} />
 * <UsageProgressBar current={5} max={5} className="mt-2" />
 * ```
 */
export const UsageProgressBar: React.FC<UsageProgressBarProps> = ({
  current,
  max,
  className = '',
}) => {
  const percent = max > 0 ? Math.min((current / max) * 100, 100) : 0;
  const isAtLimit = current >= max;

  return (
    <div className={`w-full ${className}`}>
      <div
        className="h-2 w-full rounded-full bg-background-dark overflow-hidden"
        role="progressbar"
        aria-valuenow={current}
        aria-valuemax={max}
        aria-label={`Usage: ${current} of ${max}`}
      >
        <div
          className={`h-full rounded-full transition-all duration-400 ease-out ${
            isAtLimit ? 'bg-yellow-500' : 'bg-primary'
          }`}
          style={{ width: `${percent}%` }}
          data-testid="usage-bar-fill"
        />
      </div>
      <p className="text-xs text-text-secondary-dark mt-1">
        {current}/{max}
      </p>
    </div>
  );
};

UsageProgressBar.displayName = 'UsageProgressBar';
