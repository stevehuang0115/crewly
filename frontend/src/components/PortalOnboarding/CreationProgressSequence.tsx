/**
 * CreationProgressSequence Component
 *
 * Shows animated progress during workspace creation (Screen 5).
 * Absorbs the 30-60s wait with explicit stage-by-stage status.
 *
 * @module components/PortalOnboarding/CreationProgressSequence
 */

import React from 'react';
import { CheckCircle2, Circle, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '../UI/Button';

// =============================================================================
// Types
// =============================================================================

export interface CreationProgressSequenceProps {
  /** Progress stage labels */
  stages: string[];
  /** Index of the currently active stage (0-based) */
  activeIndex: number;
  /** Error message if creation failed */
  error?: string;
  /** Retry handler for recoverable errors */
  onRetry?: () => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders staged creation progress with animated indicators.
 *
 * @param props - Component props
 * @returns CreationProgressSequence element
 */
export const CreationProgressSequence: React.FC<CreationProgressSequenceProps> = ({
  stages,
  activeIndex,
  error,
  onRetry,
}) => {
  const hasError = Boolean(error);

  return (
    <div className="text-center py-12" data-testid="creation-progress">
      {/* Spinner or error icon */}
      <div className="flex justify-center mb-8">
        {hasError ? (
          <AlertCircle className="h-12 w-12 text-red-400" data-testid="creation-error-icon" />
        ) : (
          <Loader2
            className="h-12 w-12 text-primary animate-spin"
            data-testid="creation-spinner"
          />
        )}
      </div>

      {/* Stage list */}
      <div className="space-y-3 max-w-sm mx-auto text-left mb-8" data-testid="creation-stages">
        {stages.map((stage, index) => {
          const isComplete = index < activeIndex;
          const isCurrent = index === activeIndex && !hasError;
          const isFailed = index === activeIndex && hasError;

          let Icon = Circle;
          let colorClass = 'text-text-secondary-dark/40';

          if (isComplete) {
            Icon = CheckCircle2;
            colorClass = 'text-emerald-400';
          } else if (isCurrent) {
            Icon = Loader2;
            colorClass = 'text-primary';
          } else if (isFailed) {
            Icon = AlertCircle;
            colorClass = 'text-red-400';
          }

          return (
            <div
              key={index}
              className={`flex items-center gap-3 text-sm ${colorClass}`}
              data-testid={`creation-stage-${index}`}
            >
              <Icon className={`h-4 w-4 flex-shrink-0 ${isCurrent ? 'animate-spin' : ''}`} />
              <span className={isComplete || isCurrent ? 'text-text-primary-dark' : ''}>
                {stage}
              </span>
            </div>
          );
        })}
      </div>

      {/* Error state */}
      {hasError && (
        <div data-testid="creation-error">
          <p className="text-sm text-red-400 mb-4">{error}</p>
          {onRetry && (
            <Button variant="primary" size="sm" onClick={onRetry} data-testid="creation-retry-btn">
              Try again
            </Button>
          )}
        </div>
      )}

      {/* Keep-open note */}
      {!hasError && (
        <p className="text-xs text-text-secondary-dark/60" data-testid="creation-keep-open">
          Please keep this tab open.
        </p>
      )}
    </div>
  );
};

CreationProgressSequence.displayName = 'CreationProgressSequence';
