/**
 * ReviewStep Component
 *
 * Step 2 of the onboarding flow: AI Prefill Preview.
 * Shows a brand summary hero and stacked review cards with
 * confidence pills, editable fields, and source disclosure.
 * This is the key "magic moment" screen.
 *
 * @module components/PortalOnboarding/ReviewStep
 */

import React, { useMemo } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type {
  OnboardingPrefill,
  OnboardingSummary,
  PrefillField,
} from '../../types/onboarding.types';
import { REVIEW_CARDS } from '../../types/onboarding.types';
import { Badge } from '../UI';
import { ReviewCard } from './ReviewCard';

export interface ReviewStepProps {
  /** Website URL that was analyzed */
  websiteUrl: string;
  /** Brand summary from the API */
  summary: OnboardingSummary | null;
  /** AI-extracted prefill data */
  prefill: OnboardingPrefill;
  /** Set of field keys that have been manually edited */
  editedFields: Set<string>;
  /** Called when a field value is edited */
  onFieldEdit: (key: keyof OnboardingPrefill, value: string | string[]) => void;
  /** Called when a field is reset to AI draft */
  onFieldReset: (key: keyof OnboardingPrefill) => void;
  /** Called when user confirms and moves to step 3 */
  onConfirm: () => void;
  /** Whether any required low-confidence fields remain unresolved */
  hasBlockingFields: boolean;
}

/**
 * Renders the AI prefill review screen with brand hero and review cards.
 *
 * @param props - Review step configuration
 * @returns ReviewStep element
 */
export const ReviewStep: React.FC<ReviewStepProps> = ({
  websiteUrl,
  summary,
  prefill,
  editedFields,
  onFieldEdit,
  onFieldReset,
  onConfirm,
  hasBlockingFields,
}) => {
  /** Determine overall draft quality */
  const draftStatus = useMemo(() => {
    const allFields = Object.values(prefill).filter(Boolean) as PrefillField[];
    const lowCount = allFields.filter((f) => f.confidence === 'low').length;
    const mediumCount = allFields.filter((f) => f.confidence === 'medium').length;

    if (lowCount === 0 && mediumCount === 0) return 'high';
    if (lowCount > 0) return 'needs-review';
    return 'mixed';
  }, [prefill]);

  const statusBadge = draftStatus === 'high'
    ? { variant: 'success' as const, label: 'High confidence draft' }
    : { variant: 'warning' as const, label: 'Draft needs review' };

  /** Extract domain from URL for display */
  const displayDomain = useMemo(() => {
    try {
      return new URL(websiteUrl).hostname;
    } catch {
      return websiteUrl;
    }
  }, [websiteUrl]);

  return (
    <div className="mx-auto max-w-[960px] w-full" data-testid="review-step">
      {/* Brand Summary Hero */}
      <div className="rounded-xl border border-border-dark bg-surface-dark p-6 mb-6">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div>
            {/* Company info */}
            <div className="flex items-center gap-3 mb-2">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary font-bold text-lg">
                {(summary?.companyName || 'C')[0].toUpperCase()}
              </div>
              <div>
                <h2 className="text-xl font-bold text-text-primary-dark">
                  {summary?.companyName || 'Your Company'}
                </h2>
                <p className="text-xs text-text-secondary-dark">
                  {displayDomain}
                  {summary?.industry && (
                    <span className="ml-2 text-primary">
                      &middot; {summary.industry}
                    </span>
                  )}
                </p>
              </div>
            </div>

            {/* AI summary */}
            <p className="text-sm text-text-secondary-dark mt-2 max-w-xl">
              {summary?.oneLineDescription ||
                `We analyzed ${displayDomain} and drafted your onboarding profile.`}
            </p>
          </div>

          {/* Status badge */}
          <Badge variant={statusBadge.variant} size="md">
            {statusBadge.label}
          </Badge>
        </div>

        {/* Review instruction */}
        {draftStatus === 'needs-review' && (
          <div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-500/5 border border-amber-500/20 p-3">
            <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-300">
              Review anything highlighted in amber or red before continuing.
              Click &quot;Why we think this&quot; for source details.
            </p>
          </div>
        )}
      </div>

      {/* Review Cards */}
      <div className="space-y-4 mb-6">
        {REVIEW_CARDS.map((cardConfig, index) => (
          <ReviewCard
            key={cardConfig.title}
            config={cardConfig}
            prefill={prefill}
            editedFields={editedFields}
            onFieldEdit={onFieldEdit}
            onFieldReset={onFieldReset}
            index={index}
          />
        ))}
      </div>

      {/* Confirm footer */}
      <div className="sticky bottom-0 bg-background-dark/95 backdrop-blur-sm border-t border-border-dark p-4 -mx-6 px-6 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          {hasBlockingFields ? (
            <>
              <AlertTriangle className="h-4 w-4 text-red-400" />
              <span className="text-red-400">
                Required fields need review before continuing
              </span>
            </>
          ) : (
            <>
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span className="text-emerald-400">
                Ready to confirm
              </span>
            </>
          )}
        </div>
        <button
          onClick={onConfirm}
          disabled={hasBlockingFields}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          data-testid="continue-to-confirm-btn"
        >
          Continue to confirm
        </button>
      </div>
    </div>
  );
};

ReviewStep.displayName = 'ReviewStep';
