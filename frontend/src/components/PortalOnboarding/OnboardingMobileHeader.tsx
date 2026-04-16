/**
 * OnboardingMobileHeader Component
 *
 * Compact sticky progress header for mobile viewports.
 * Hidden on desktop — the full ProgressRail is shown instead.
 *
 * @module components/PortalOnboarding/OnboardingMobileHeader
 */

import React from 'react';

// =============================================================================
// Types
// =============================================================================

export interface OnboardingMobileHeaderProps {
  /** Label for the current step (e.g. "Review draft") */
  activeLabel: string;
  /** Zero-based index of the current step */
  stepIndex: number;
  /** Total number of steps */
  stepCount: number;
  /** Optional status text (e.g. "Analyzing...") */
  statusText?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a compact sticky progress header on mobile.
 * Shows step counter, label, optional status, and a progress bar.
 *
 * @param props - Component props
 * @returns OnboardingMobileHeader element (hidden on md+ via CSS)
 */
export const OnboardingMobileHeader: React.FC<OnboardingMobileHeaderProps> = ({
  activeLabel,
  stepIndex,
  stepCount,
  statusText,
}) => {
  const progressPercent = stepCount > 1 ? (stepIndex / (stepCount - 1)) * 100 : 0;

  return (
    <div
      className="md:hidden sticky top-0 z-20 bg-surface-dark border-b border-border-dark px-4 py-3"
      data-testid="onboarding-mobile-header"
    >
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-text-primary-dark" data-testid="mobile-header-label">
          {activeLabel}
        </span>
        <span className="text-text-secondary-dark" data-testid="mobile-header-counter">
          {stepIndex + 1} / {stepCount}
        </span>
      </div>

      {statusText && (
        <p className="text-xs text-text-secondary-dark mt-1" data-testid="mobile-header-status">
          {statusText}
        </p>
      )}

      {/* Progress bar */}
      <div className="mt-2 h-1 w-full rounded-full bg-border-dark overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${progressPercent}%` }}
          role="progressbar"
          aria-valuenow={stepIndex + 1}
          aria-valuemin={1}
          aria-valuemax={stepCount}
          data-testid="mobile-header-progress"
        />
      </div>
    </div>
  );
};

OnboardingMobileHeader.displayName = 'OnboardingMobileHeader';
