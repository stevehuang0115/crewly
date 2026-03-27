/**
 * Onboarding Wizard ("Genesis" Flow)
 *
 * A 4-step wizard shown to first-time users:
 *  1. Connect to Cloud (OAuth)
 *  2. Select Industry Template
 *  3. Review Team Members & Skills
 *  4. Launch First Project
 *
 * Uses the existing Modal component with a step indicator.
 * Persists completion in localStorage so it only shows once.
 *
 * @module components/Onboarding/OnboardingWizard
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Modal } from '../UI/Modal';
import { StepIndicator } from './StepIndicator';
import { StepCloudConnect } from './StepCloudConnect';
import { StepSelectTemplate } from './StepSelectTemplate';
import { StepReviewTeam } from './StepReviewTeam';
import { StepLaunchProject } from './StepLaunchProject';
import type { OnboardingState, TemplateInfo } from './onboarding.types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** localStorage key to track onboarding completion */
const ONBOARDING_COMPLETED_KEY = 'crewly_onboarding_completed';

/** localStorage key to check if user has existing teams */
const ONBOARDING_DISMISSED_KEY = 'crewly_onboarding_dismissed';

/** Step labels shown in the step indicator */
const STEP_LABELS = ['Cloud', 'Template', 'Team', 'Launch'] as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface OnboardingWizardProps {
  /** Whether the wizard is open */
  isOpen: boolean;
  /** Callback when wizard completes or is dismissed */
  onComplete: () => void;
  /** Whether the user already has teams (skip wizard prompt) */
  hasExistingTeams?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Onboarding wizard modal with 4 sequential steps.
 *
 * Step transitions use CSS transitions for smooth slide effects.
 * Each step can independently validate before allowing progression.
 *
 * @param props - {@link OnboardingWizardProps}
 * @returns OnboardingWizard component
 */
export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({
  isOpen,
  onComplete,
}) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
  const [state, setState] = useState<OnboardingState>({
    cloudConnected: false,
    selectedTemplate: null,
    teamName: '',
    projectPath: '',
    isCreating: false,
    error: null,
  });

  /** Reset state when wizard opens */
  useEffect(() => {
    if (isOpen) {
      setCurrentStep(0);
      setDirection('forward');
      setState({
        cloudConnected: false,
        selectedTemplate: null,
        teamName: '',
        projectPath: '',
        isCreating: false,
        error: null,
      });
    }
  }, [isOpen]);

  /**
   * Navigate to the next step.
   */
  const goNext = useCallback(() => {
    if (currentStep < STEP_LABELS.length - 1) {
      setDirection('forward');
      setCurrentStep(prev => prev + 1);
    }
  }, [currentStep]);

  /**
   * Navigate to the previous step.
   */
  const goBack = useCallback(() => {
    if (currentStep > 0) {
      setDirection('backward');
      setCurrentStep(prev => prev - 1);
    }
  }, [currentStep]);

  /**
   * Skip the Cloud connection step (optional).
   */
  const skipCloud = useCallback(() => {
    goNext();
  }, [goNext]);

  /**
   * Handle template selection from Step 2.
   *
   * @param template - The selected template info
   */
  const handleTemplateSelect = useCallback((template: TemplateInfo) => {
    setState(prev => ({
      ...prev,
      selectedTemplate: template,
      teamName: template.name,
    }));
  }, []);

  /**
   * Update team name override.
   *
   * @param name - Custom team name
   */
  const handleTeamNameChange = useCallback((name: string) => {
    setState(prev => ({ ...prev, teamName: name }));
  }, []);

  /**
   * Update project path.
   *
   * @param path - Project directory path
   */
  const handleProjectPathChange = useCallback((path: string) => {
    setState(prev => ({ ...prev, projectPath: path }));
  }, []);

  /**
   * Mark Cloud as connected (from Step 1).
   */
  const handleCloudConnected = useCallback(() => {
    setState(prev => ({ ...prev, cloudConnected: true }));
  }, []);

  /**
   * Finish the wizard: create team + project via API, then close.
   */
  const handleLaunch = useCallback(async () => {
    if (!state.selectedTemplate) return;

    setState(prev => ({ ...prev, isCreating: true, error: null }));

    try {
      // Step A: Create team from template
      const teamRes = await fetch(`/api/templates/${state.selectedTemplate.id}/create-team`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teamName: state.teamName || state.selectedTemplate.name,
        }),
      });

      if (!teamRes.ok) {
        const err = await teamRes.json().catch(() => ({ error: 'Failed to create team' }));
        throw new Error(err.error || 'Failed to create team');
      }

      const teamData = await teamRes.json();
      const teamId = teamData.data?.id || teamData.id;

      // Step B: Create project if path provided
      if (state.projectPath.trim()) {
        const projRes = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: state.projectPath,
            teamIds: teamId ? [teamId] : [],
          }),
        });

        if (!projRes.ok) {
          const err = await projRes.json().catch(() => ({ error: 'Failed to create project' }));
          throw new Error(err.error || 'Failed to create project');
        }
      }

      // Mark onboarding complete
      localStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true');
      onComplete();
    } catch (err) {
      setState(prev => ({
        ...prev,
        isCreating: false,
        error: err instanceof Error ? err.message : 'Something went wrong',
      }));
    }
  }, [state.selectedTemplate, state.teamName, state.projectPath, onComplete]);

  /**
   * Dismiss the wizard without completing.
   */
  const handleDismiss = useCallback(() => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true');
    onComplete();
  }, [onComplete]);

  /** Render the active step content */
  const renderStep = () => {
    switch (currentStep) {
      case 0:
        return (
          <StepCloudConnect
            connected={state.cloudConnected}
            onConnected={handleCloudConnected}
            onSkip={skipCloud}
            onNext={goNext}
          />
        );
      case 1:
        return (
          <StepSelectTemplate
            selected={state.selectedTemplate}
            onSelect={handleTemplateSelect}
            onNext={goNext}
            onBack={goBack}
          />
        );
      case 2:
        return (
          <StepReviewTeam
            template={state.selectedTemplate}
            teamName={state.teamName}
            onTeamNameChange={handleTeamNameChange}
            onNext={goNext}
            onBack={goBack}
          />
        );
      case 3:
        return (
          <StepLaunchProject
            projectPath={state.projectPath}
            onProjectPathChange={handleProjectPathChange}
            onLaunch={handleLaunch}
            onBack={goBack}
            isCreating={state.isCreating}
            error={state.error}
            teamName={state.teamName}
            templateName={state.selectedTemplate?.name ?? ''}
          />
        );
      default:
        return null;
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleDismiss}
      size="lg"
      closable
      className="onboarding-wizard-modal"
    >
      <div className="px-6 pt-2 pb-6" data-testid="onboarding-wizard">
        {/* Step Indicator */}
        <StepIndicator
          steps={STEP_LABELS as unknown as string[]}
          currentStep={currentStep}
        />

        {/* Step Content with CSS transition */}
        <div
          className="mt-6 min-h-[360px] transition-opacity duration-200 ease-in-out"
          data-testid={`onboarding-step-${currentStep}`}
          key={currentStep}
        >
          {renderStep()}
        </div>
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Utility: check if onboarding should show
// ---------------------------------------------------------------------------

/**
 * Check whether the onboarding wizard should be displayed.
 *
 * Returns true if the user has never completed or dismissed onboarding
 * AND has no existing teams.
 *
 * @param teamCount - Number of existing teams
 * @returns Whether to show the wizard
 */
export function shouldShowOnboarding(teamCount: number): boolean {
  if (typeof window === 'undefined') return false;
  if (localStorage.getItem(ONBOARDING_COMPLETED_KEY) === 'true') return false;
  if (localStorage.getItem(ONBOARDING_DISMISSED_KEY) === 'true') return false;
  return teamCount === 0;
}

export default OnboardingWizard;
