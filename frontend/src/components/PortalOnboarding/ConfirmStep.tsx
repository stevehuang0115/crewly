/**
 * ConfirmStep Component
 *
 * Step 3 of the onboarding flow: Confirm and Create.
 * Shows a summary panel with team name, template, workflow, and
 * integrations. Requires the user to acknowledge reviewed fields
 * before creating the workspace.
 *
 * @module components/PortalOnboarding/ConfirmStep
 */

import React, { useState } from 'react';
import {
  Rocket,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Sparkles,
  Users,
  Workflow,
  Plug,
} from 'lucide-react';
import { Button } from '../UI';
import type { OnboardingPrefill } from '../../types/onboarding.types';

/** Creation progress stage */
type CreationPhase = 'idle' | 'saving' | 'creating' | 'preparing' | 'done' | 'error';

export interface ConfirmStepProps {
  /** AI-extracted prefill data */
  prefill: OnboardingPrefill;
  /** Called when user confirms and creates workspace */
  onConfirm: () => Promise<void>;
  /** Called when user goes back to review */
  onBack: () => void;
  /** Whether there are unresolved required fields */
  hasBlockingFields: boolean;
}

/** Creation progress labels */
const CREATION_LABELS: Record<CreationPhase, string> = {
  idle: '',
  saving: 'Saving your onboarding profile',
  creating: 'Creating your workspace',
  preparing: 'Preparing your first next steps',
  done: 'Your workspace is ready!',
  error: 'Something went wrong',
};

/**
 * Renders the confirmation step with summary and create CTA.
 *
 * @param props - Confirm step configuration
 * @returns ConfirmStep element
 */
export const ConfirmStep: React.FC<ConfirmStepProps> = ({
  prefill,
  onConfirm,
  onBack,
  hasBlockingFields,
}) => {
  const [acknowledged, setAcknowledged] = useState(false);
  const [phase, setPhase] = useState<CreationPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  const teamName = (prefill.suggestedTeamName?.value as string) || 'My Crewly Team';
  const template = (prefill.recommendedTemplate?.value as string) || 'Default';
  const workflow = (prefill.suggestedFirstWorkflow?.value as string) || 'Not specified';
  const integration = (prefill.suggestedFirstIntegration?.value as string) || 'None';

  const canCreate = acknowledged && !hasBlockingFields && phase === 'idle';

  /** Handle workspace creation with staged progress */
  const handleCreate = async () => {
    if (!canCreate) return;

    try {
      setPhase('saving');
      // Small delay for each stage so user sees progress
      await new Promise((r) => setTimeout(r, 800));
      setPhase('creating');
      await onConfirm();
      await new Promise((r) => setTimeout(r, 600));
      setPhase('preparing');
      await new Promise((r) => setTimeout(r, 500));
      setPhase('done');
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    }
  };

  const isCreating = phase !== 'idle' && phase !== 'done' && phase !== 'error';

  // Creating/Done state
  if (phase !== 'idle') {
    return (
      <div
        className="mx-auto max-w-[720px] w-full text-center py-12"
        data-testid="creation-progress"
      >
        {phase === 'done' ? (
          <>
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-400 mb-4" />
            <h2 className="text-xl font-semibold text-text-primary-dark mb-2">
              {CREATION_LABELS.done}
            </h2>
            <p className="text-sm text-text-secondary-dark mb-6">
              Your personalized workspace &quot;{teamName}&quot; has been created.
            </p>
          </>
        ) : phase === 'error' ? (
          <>
            <div className="mx-auto h-12 w-12 rounded-full bg-red-500/10 flex items-center justify-center mb-4">
              <Rocket className="h-6 w-6 text-red-400" />
            </div>
            <h2 className="text-xl font-semibold text-text-primary-dark mb-2">
              {CREATION_LABELS.error}
            </h2>
            <p className="text-sm text-red-400 mb-6">{error}</p>
            <Button
              variant="secondary"
              onClick={() => {
                setPhase('idle');
                setError(null);
              }}
              data-testid="creation-retry-btn"
            >
              Try again
            </Button>
          </>
        ) : (
          <>
            <Loader2 className="mx-auto h-10 w-10 text-primary animate-spin mb-4" />
            <h2 className="text-lg font-semibold text-text-primary-dark mb-2">
              {CREATION_LABELS[phase]}
            </h2>
            <p className="text-sm text-text-secondary-dark">
              This will just take a moment...
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[720px] w-full" data-testid="confirm-step">
      {/* Header */}
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-text-primary-dark mb-2">
          Ready to create your workspace
        </h1>
        <p className="text-sm text-text-secondary-dark">
          We&apos;ll save this profile and open your personalized next steps.
        </p>
      </div>

      {/* Summary card */}
      <div className="rounded-xl border border-border-dark bg-surface-dark p-6 mb-6 space-y-4">
        <SummaryRow icon={Users} label="Team Name" value={teamName} />
        <SummaryRow icon={Sparkles} label="Template" value={template} />
        <SummaryRow icon={Workflow} label="First Workflow" value={workflow} />
        <SummaryRow icon={Plug} label="Integration" value={integration} />
      </div>

      {/* Acknowledgement checkbox */}
      <label
        className="flex items-start gap-3 rounded-lg border border-border-dark bg-surface-dark p-4 cursor-pointer mb-6"
        data-testid="acknowledge-checkbox"
      >
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border-dark bg-background-dark text-primary focus:ring-primary"
        />
        <span className="text-sm text-text-secondary-dark">
          I&apos;ve reviewed the highlighted fields and this looks correct
        </span>
      </label>

      {/* Actions */}
      <div className="flex items-center justify-between gap-4">
        <Button
          variant="ghost"
          onClick={onBack}
          icon={ArrowLeft}
          data-testid="back-to-review-btn"
        >
          Back to review
        </Button>

        <Button
          variant="primary"
          disabled={!canCreate}
          loading={isCreating}
          onClick={handleCreate}
          icon={Rocket}
          className="px-8"
          data-testid="create-workspace-btn"
        >
          Create my workspace
        </Button>
      </div>
    </div>
  );
};

ConfirmStep.displayName = 'ConfirmStep';

// ---------------------------------------------------------------------------
// Internal sub-component
// ---------------------------------------------------------------------------

interface SummaryRowProps {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
}

/** A single row in the confirmation summary panel */
const SummaryRow: React.FC<SummaryRowProps> = ({ icon: Icon, label, value }) => (
  <div className="flex items-start gap-3">
    <Icon className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
    <div>
      <p className="text-xs text-text-secondary-dark uppercase tracking-wide">
        {label}
      </p>
      <p className="text-sm text-text-primary-dark mt-0.5">{value}</p>
    </div>
  </div>
);
