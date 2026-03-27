/**
 * Step Indicator Component
 *
 * Horizontal progress indicator showing numbered steps with labels.
 * Active step is highlighted, completed steps show a checkmark.
 *
 * @module components/Onboarding/StepIndicator
 */

import React from 'react';
import { Check } from 'lucide-react';
import clsx from 'clsx';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StepIndicatorProps {
  /** Array of step label strings */
  steps: string[];
  /** Zero-based index of the current active step */
  currentStep: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Horizontal step indicator with numbered circles and connecting lines.
 *
 * @param props - {@link StepIndicatorProps}
 * @returns Step indicator bar
 */
export const StepIndicator: React.FC<StepIndicatorProps> = ({ steps, currentStep }) => (
  <div className="flex items-center justify-center gap-0" data-testid="step-indicator">
    {steps.map((label, index) => {
      const isCompleted = index < currentStep;
      const isActive = index === currentStep;
      const isLast = index === steps.length - 1;

      return (
        <React.Fragment key={label}>
          {/* Step circle + label */}
          <div className="flex flex-col items-center" data-testid={`step-${index}`}>
            <div
              className={clsx(
                'flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold transition-colors duration-200',
                isCompleted && 'bg-primary text-white',
                isActive && 'bg-primary/20 text-primary border-2 border-primary',
                !isCompleted && !isActive && 'bg-surface-dark text-text-secondary-dark border border-border-dark',
              )}
              aria-current={isActive ? 'step' : undefined}
            >
              {isCompleted ? <Check className="w-4 h-4" /> : index + 1}
            </div>
            <span
              className={clsx(
                'mt-1.5 text-[10px] font-medium uppercase tracking-wide',
                isActive ? 'text-primary' : 'text-text-secondary-dark',
              )}
            >
              {label}
            </span>
          </div>

          {/* Connecting line (skip after last step) */}
          {!isLast && (
            <div
              className={clsx(
                'h-0.5 w-12 mx-1 mt-[-12px] transition-colors duration-200',
                isCompleted ? 'bg-primary' : 'bg-border-dark',
              )}
            />
          )}
        </React.Fragment>
      );
    })}
  </div>
);

export default StepIndicator;
