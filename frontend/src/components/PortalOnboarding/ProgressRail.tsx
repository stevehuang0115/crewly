/**
 * ProgressRail Component
 *
 * Displays the 3-step onboarding progress indicator.
 * Shows current step with aria-current, completed steps with checkmarks,
 * and future steps as disabled.
 *
 * @module components/PortalOnboarding/ProgressRail
 */

import React from 'react';
import { CheckCircle2, Globe, FileSearch, Rocket } from 'lucide-react';
import type { OnboardingStep } from '../../types/onboarding.types';

export interface ProgressRailProps {
  /** Current active step */
  currentStep: OnboardingStep;
  /** Additional CSS classes */
  className?: string;
}

/** Step definitions with labels and icons */
const STEPS = [
  { id: 'url-input' as const, label: 'Analyze website', icon: Globe },
  { id: 'review' as const, label: 'Review AI draft', icon: FileSearch },
  { id: 'confirm' as const, label: 'Confirm and create', icon: Rocket },
];

/** Map step to numerical index for comparison */
const STEP_ORDER: Record<OnboardingStep, number> = {
  'auth': 0,
  'url-input': 0,
  'analyzing': 0,
  'review': 1,
  'confirm': 2,
  'creating': 2,
  'success': 2,
};

/**
 * Renders the 3-step progress rail for the onboarding flow.
 *
 * @param currentStep - The currently active step
 * @param className - Additional CSS classes
 * @returns ProgressRail element
 */
export const ProgressRail: React.FC<ProgressRailProps> = ({
  currentStep,
  className = '',
}) => {
  const currentIndex = STEP_ORDER[currentStep];

  return (
    <nav
      className={`flex items-center gap-2 md:gap-4 ${className}`}
      aria-label="Onboarding progress"
    >
      {STEPS.map((step, index) => {
        const isCompleted = index < currentIndex;
        const isCurrent = index === currentIndex;
        const Icon = isCompleted ? CheckCircle2 : step.icon;

        return (
          <React.Fragment key={step.id}>
            {index > 0 && (
              <div
                className={`hidden md:block h-px flex-1 max-w-[60px] ${
                  isCompleted ? 'bg-emerald-500' : 'bg-border-dark'
                }`}
                aria-hidden="true"
              />
            )}
            <div
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isCurrent
                  ? 'bg-primary/10 text-primary'
                  : isCompleted
                  ? 'text-emerald-400'
                  : 'text-text-secondary-dark'
              }`}
              aria-current={isCurrent ? 'step' : undefined}
              data-testid={`progress-step-${step.id}`}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              <span className="hidden md:inline">{step.label}</span>
              <span className="md:hidden">{index + 1}</span>
            </div>
          </React.Fragment>
        );
      })}
    </nav>
  );
};

ProgressRail.displayName = 'ProgressRail';
