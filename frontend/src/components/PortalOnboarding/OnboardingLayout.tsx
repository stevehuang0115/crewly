/**
 * OnboardingLayout Component
 *
 * Shared route shell for all onboarding screens.
 * 3-column layout on desktop: progress rail | main content | optional right panel.
 * Single-column on mobile with compact sticky header.
 *
 * @module components/PortalOnboarding/OnboardingLayout
 */

import React, { type ReactNode } from 'react';
import { CheckCircle2, Globe, FileSearch, Rocket, Sparkles, LogIn } from 'lucide-react';
import type { OnboardingStep, ProgressRailStep } from '../../types/onboarding.types';
import { OnboardingMobileHeader } from './OnboardingMobileHeader';

// =============================================================================
// Types
// =============================================================================

export interface OnboardingLayoutProps {
  /** Current onboarding step */
  step: OnboardingStep;
  /** Main content */
  children: ReactNode;
  /** Optional right panel (trust/context) */
  rightPanel?: ReactNode;
  /** Layout variant */
  variant?: 'default' | 'narrow' | 'full-review';
}

// =============================================================================
// Constants
// =============================================================================

/** Progress rail step configuration */
const RAIL_STEPS: { id: ProgressRailStep; label: string; icon: React.FC<{ className?: string }> }[] = [
  { id: 'connect', label: 'Connect', icon: LogIn },
  { id: 'analyze', label: 'Analyze website', icon: Globe },
  { id: 'review', label: 'Review draft', icon: FileSearch },
  { id: 'create', label: 'Create workspace', icon: Rocket },
  { id: 'start', label: 'Start', icon: Sparkles },
];

/** Map OnboardingStep to rail step for progress tracking */
const STEP_TO_RAIL: Record<OnboardingStep, ProgressRailStep> = {
  'auth': 'connect',
  'url-input': 'analyze',
  'analyzing': 'analyze',
  'review': 'review',
  'confirm': 'create',
  'creating': 'create',
  'success': 'start',
};

/** Map rail step to its index */
const RAIL_INDEX: Record<ProgressRailStep, number> = {
  connect: 0,
  analyze: 1,
  review: 2,
  create: 3,
  start: 4,
};

// =============================================================================
// Sub-components
// =============================================================================

/**
 * Desktop progress rail — 5-step vertical navigation
 */
const DesktopProgressRail: React.FC<{ activeRailStep: ProgressRailStep }> = ({ activeRailStep }) => {
  const activeIndex = RAIL_INDEX[activeRailStep];

  return (
    <nav
      className="hidden md:flex flex-col gap-1 w-52 flex-shrink-0 pt-4"
      aria-label="Onboarding progress"
      data-testid="onboarding-progress-rail"
    >
      {RAIL_STEPS.map((step, index) => {
        const isCompleted = index < activeIndex;
        const isCurrent = index === activeIndex;
        const Icon = isCompleted ? CheckCircle2 : step.icon;

        return (
          <div
            key={step.id}
            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
              isCurrent
                ? 'bg-primary/10 text-primary'
                : isCompleted
                ? 'text-emerald-400'
                : 'text-text-secondary-dark/50'
            }`}
            aria-current={isCurrent ? 'step' : undefined}
            data-testid={`rail-step-${step.id}`}
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            <span>{step.label}</span>
          </div>
        );
      })}
    </nav>
  );
};

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the shared layout shell for onboarding.
 * Desktop: 3-column with rail + content + optional context panel.
 * Mobile: compact header + stacked content.
 *
 * @param props - Component props
 * @returns OnboardingLayout element
 */
export const OnboardingLayout: React.FC<OnboardingLayoutProps> = ({
  step,
  children,
  rightPanel,
  variant = 'default',
}) => {
  const railStep = STEP_TO_RAIL[step];
  const railIndex = RAIL_INDEX[railStep];
  const railLabel = RAIL_STEPS[railIndex]?.label ?? '';

  const maxWidthClass =
    variant === 'narrow' ? 'max-w-2xl' :
    variant === 'full-review' ? 'max-w-5xl' :
    'max-w-4xl';

  return (
    <div className="min-h-screen bg-background-dark" data-testid="onboarding-layout">
      {/* Mobile header */}
      <OnboardingMobileHeader
        activeLabel={railLabel}
        stepIndex={railIndex}
        stepCount={RAIL_STEPS.length}
      />

      {/* Desktop layout */}
      <div className={`mx-auto ${maxWidthClass} px-4 md:px-6 py-6 md:py-10`}>
        <div className="flex gap-8">
          {/* Left: Progress rail (desktop only) */}
          <DesktopProgressRail activeRailStep={railStep} />

          {/* Center: Main content */}
          <main className="flex-1 min-w-0" data-testid="onboarding-main">
            {children}
          </main>

          {/* Right: Context panel (desktop only, when provided) */}
          {rightPanel && (
            <aside
              className="hidden lg:block w-64 flex-shrink-0"
              data-testid="onboarding-right-panel"
            >
              {rightPanel}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
};

OnboardingLayout.displayName = 'OnboardingLayout';
