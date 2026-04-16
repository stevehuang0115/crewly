/**
 * AnalysisProgress Component
 *
 * Step 1.5: Staged loading experience during website analysis.
 * Shows an animated checklist of analysis stages rather than a
 * generic spinner. Includes a skeleton preview of the upcoming
 * review panel and timeout/failure handling.
 *
 * @module components/PortalOnboarding/AnalysisProgress
 */

import React, { useState, useEffect } from 'react';
import { CheckCircle2, Circle, Loader2, AlertCircle } from 'lucide-react';
import { ANALYSIS_STAGES } from '../../types/onboarding.types';
import { Button } from '../UI';

export interface AnalysisProgressProps {
  /** Whether analysis has failed */
  hasFailed?: boolean;
  /** Error message on failure */
  errorMessage?: string;
  /** Whether partial data is available on failure */
  hasPartialData?: boolean;
  /** Called when user wants to review partial draft */
  onReviewPartial?: () => void;
  /** Called when user wants to try another URL */
  onRetry?: () => void;
}

/** Timeout after which calm message appears (ms) */
const CALM_TIMEOUT = 12000;

/** Simulated stage interval (ms) — stages advance automatically for UX */
const STAGE_INTERVAL = 4000;

/**
 * Renders the staged analysis loading experience.
 *
 * @param props - Analysis progress configuration
 * @returns AnalysisProgress element
 */
export const AnalysisProgress: React.FC<AnalysisProgressProps> = ({
  hasFailed = false,
  errorMessage,
  hasPartialData = false,
  onReviewPartial,
  onRetry,
}) => {
  const [currentStage, setCurrentStage] = useState(0);
  const [showCalmMessage, setShowCalmMessage] = useState(false);

  // Advance stages on a timer for visual feedback
  useEffect(() => {
    if (hasFailed) return;

    const timer = setInterval(() => {
      setCurrentStage((prev) => {
        if (prev >= ANALYSIS_STAGES.length - 1) return prev;
        return prev + 1;
      });
    }, STAGE_INTERVAL);

    return () => clearInterval(timer);
  }, [hasFailed]);

  // Show calm message after timeout
  useEffect(() => {
    if (hasFailed) return;

    const timer = setTimeout(() => setShowCalmMessage(true), CALM_TIMEOUT);
    return () => clearTimeout(timer);
  }, [hasFailed]);

  // Failure state
  if (hasFailed) {
    return (
      <div
        className="mx-auto max-w-[720px] w-full text-center py-8"
        data-testid="analysis-failed"
      >
        <AlertCircle className="mx-auto h-12 w-12 text-red-400 mb-4" />
        <h2 className="text-xl font-semibold text-text-primary-dark mb-2">
          We couldn&apos;t build a full draft from this site
        </h2>
        <p className="text-sm text-text-secondary-dark mb-6 max-w-md mx-auto">
          {errorMessage ||
            'The site may be JavaScript-heavy or have limited public content.'}
        </p>
        <div className="flex items-center justify-center gap-3">
          {hasPartialData && onReviewPartial && (
            <Button
              variant="primary"
              onClick={onReviewPartial}
              data-testid="review-partial-btn"
            >
              Review partial draft
            </Button>
          )}
          {onRetry && (
            <Button
              variant="secondary"
              onClick={onRetry}
              data-testid="retry-url-btn"
            >
              Try another URL
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="mx-auto max-w-[720px] w-full"
      data-testid="analysis-progress"
    >
      <div className="rounded-xl border border-border-dark bg-surface-dark p-6 md:p-8">
        <div className="md:flex md:gap-8">
          {/* Left: Progress checklist */}
          <div className="flex-1 mb-6 md:mb-0">
            <h2 className="text-lg font-semibold text-text-primary-dark mb-4">
              Analyzing your website...
            </h2>
            <ul className="space-y-3" role="list" aria-label="Analysis stages">
              {ANALYSIS_STAGES.map((stage, index) => {
                const isComplete = index < currentStage;
                const isCurrent = index === currentStage;

                return (
                  <li
                    key={stage}
                    className="flex items-center gap-3"
                    data-testid={`analysis-stage-${index}`}
                    aria-current={isCurrent ? 'step' : undefined}
                  >
                    {isComplete ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-400 flex-shrink-0" />
                    ) : isCurrent ? (
                      <Loader2 className="h-5 w-5 text-primary animate-spin flex-shrink-0" />
                    ) : (
                      <Circle className="h-5 w-5 text-text-secondary-dark/30 flex-shrink-0" />
                    )}
                    <span
                      className={`text-sm ${
                        isComplete
                          ? 'text-emerald-400'
                          : isCurrent
                          ? 'text-text-primary-dark'
                          : 'text-text-secondary-dark/50'
                      }`}
                    >
                      {stage}
                    </span>
                  </li>
                );
              })}
            </ul>

            {showCalmMessage && (
              <p
                className="mt-4 text-xs text-text-secondary-dark italic"
                data-testid="calm-message"
              >
                This can take longer on JavaScript-heavy sites. We&apos;re still working.
              </p>
            )}
          </div>

          {/* Right: Skeleton preview */}
          <div className="flex-1">
            <div className="rounded-lg border border-border-dark/50 bg-background-dark p-4 space-y-4 opacity-60">
              {/* Company name skeleton */}
              <div className="space-y-2">
                <div className="h-3 w-16 bg-border-dark/50 rounded animate-pulse" />
                <div className="h-5 w-40 bg-border-dark/50 rounded animate-pulse" />
              </div>
              {/* Tone chips skeleton */}
              <div className="flex gap-2">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-6 w-16 bg-border-dark/50 rounded-full animate-pulse"
                  />
                ))}
              </div>
              {/* Customer summary skeleton */}
              <div className="space-y-2">
                <div className="h-3 w-24 bg-border-dark/50 rounded animate-pulse" />
                <div className="h-4 w-full bg-border-dark/50 rounded animate-pulse" />
                <div className="h-4 w-3/4 bg-border-dark/50 rounded animate-pulse" />
              </div>
              {/* Team recommendation skeleton */}
              <div className="space-y-2">
                <div className="h-3 w-28 bg-border-dark/50 rounded animate-pulse" />
                <div className="h-4 w-32 bg-border-dark/50 rounded animate-pulse" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

AnalysisProgress.displayName = 'AnalysisProgress';
