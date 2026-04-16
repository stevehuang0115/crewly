/**
 * OnboardingStepHeader Component
 *
 * Reusable title/subtitle block for each onboarding screen.
 * Supports centered (URL input, auth) and left-aligned (review, confirm) layouts.
 *
 * @module components/PortalOnboarding/OnboardingStepHeader
 */

import React, { type ReactNode } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface OnboardingStepHeaderProps {
  /** Page title text */
  title: string;
  /** Optional subtitle / description */
  subtitle?: string;
  /** Text alignment */
  align?: 'left' | 'center';
  /** Optional status or badge slot rendered beside the title */
  statusSlot?: ReactNode;
  /** Visual variant */
  variant?: 'hero' | 'section' | 'compact';
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a consistent title/subtitle block for onboarding steps.
 *
 * @param props - Component props
 * @returns OnboardingStepHeader element
 */
export const OnboardingStepHeader: React.FC<OnboardingStepHeaderProps> = ({
  title,
  subtitle,
  align = 'left',
  statusSlot,
  variant = 'hero',
}) => {
  const alignClass = align === 'center' ? 'text-center' : 'text-left';

  const titleClass =
    variant === 'hero'
      ? 'text-2xl md:text-3xl font-bold text-text-primary-dark'
      : variant === 'section'
      ? 'text-lg font-semibold text-text-primary-dark'
      : 'text-base font-semibold text-text-primary-dark';

  return (
    <header className={`mb-6 ${alignClass}`} data-testid="onboarding-step-header">
      <div className="flex items-center gap-3 justify-between flex-wrap">
        <h1 className={titleClass} data-testid="step-header-title">
          {title}
        </h1>
        {statusSlot && (
          <div data-testid="step-header-status">{statusSlot}</div>
        )}
      </div>
      {subtitle && (
        <p
          className="mt-2 text-sm text-text-secondary-dark max-w-xl"
          data-testid="step-header-subtitle"
          style={align === 'center' ? { marginInline: 'auto' } : undefined}
        >
          {subtitle}
        </p>
      )}
    </header>
  );
};

OnboardingStepHeader.displayName = 'OnboardingStepHeader';
