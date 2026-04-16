/**
 * OnboardingSuccessHero Component
 *
 * Top success surface for Screen 6 — the guided first step.
 * Announces workspace readiness with contextual summary.
 *
 * @module components/PortalOnboarding/OnboardingSuccessHero
 */

import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Badge } from '../UI/Badge';

// =============================================================================
// Types
// =============================================================================

export interface OnboardingSuccessHeroProps {
  /** Team name that was created */
  teamName: string;
  /** Primary workflow set up */
  workflow?: string;
  /** Short summary text */
  summary?: string;
  /** Whether an integration is recommended */
  status?: 'ready' | 'integration-recommended';
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the success hero at the top of the guided first step screen.
 *
 * @param props - Component props
 * @returns OnboardingSuccessHero element
 */
export const OnboardingSuccessHero: React.FC<OnboardingSuccessHeroProps> = ({
  teamName,
  workflow,
  summary,
  status = 'ready',
}) => {
  const subtitle = summary
    ?? (workflow
      ? `${teamName} is set up for ${workflow}.`
      : `${teamName} is ready to go.`);

  return (
    <div
      className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 p-6 mb-6"
      data-testid="onboarding-success-hero"
    >
      <div className="flex items-start gap-4">
        <CheckCircle2 className="h-8 w-8 text-emerald-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-text-primary-dark" data-testid="success-title">
              Your workspace is ready
            </h1>
            {status === 'integration-recommended' && (
              <Badge variant="primary" size="sm" data-testid="success-integration-badge">
                Integration recommended
              </Badge>
            )}
          </div>
          <p className="mt-2 text-sm text-text-secondary-dark" data-testid="success-subtitle">
            {subtitle}
          </p>
        </div>
      </div>
    </div>
  );
};

OnboardingSuccessHero.displayName = 'OnboardingSuccessHero';
