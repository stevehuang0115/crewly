/**
 * ConfidencePill Component
 *
 * Compact indicator showing AI confidence level for an extracted field.
 * Uses color-coded dots and labels: high (green), medium (amber), low (red).
 * Also supports a "Manual" variant for user-edited fields.
 *
 * @module components/PortalOnboarding/ConfidencePill
 */

import React from 'react';
import type { PrefillConfidence } from '../../types/onboarding.types';

export type ConfidencePillVariant = PrefillConfidence | 'manual';

export interface ConfidencePillProps {
  /** Confidence level or 'manual' for user-edited fields */
  confidence: ConfidencePillVariant;
  /** Additional CSS classes */
  className?: string;
}

/** Style map for each confidence variant */
const VARIANT_STYLES: Record<ConfidencePillVariant, { dot: string; text: string; label: string }> = {
  high: {
    dot: 'bg-emerald-500',
    text: 'text-emerald-400',
    label: 'High confidence',
  },
  medium: {
    dot: 'bg-amber-500',
    text: 'text-amber-400',
    label: 'Medium confidence',
  },
  low: {
    dot: 'bg-red-500',
    text: 'text-red-400',
    label: 'Low confidence',
  },
  manual: {
    dot: 'bg-blue-500',
    text: 'text-blue-400',
    label: 'Manual',
  },
};

/**
 * Renders a compact confidence pill with colored dot and label.
 *
 * @param confidence - The confidence level to display
 * @param className - Additional CSS classes
 * @returns ConfidencePill element
 *
 * @example
 * ```tsx
 * <ConfidencePill confidence="high" />
 * <ConfidencePill confidence="low" />
 * ```
 */
export const ConfidencePill: React.FC<ConfidencePillProps> = ({
  confidence,
  className = '',
}) => {
  const styles = VARIANT_STYLES[confidence];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${styles.text} ${className}`}
      data-testid={`confidence-pill-${confidence}`}
      aria-label={styles.label}
    >
      <span
        className={`h-2 w-2 rounded-full ${styles.dot}`}
        aria-hidden="true"
      />
      {styles.label}
    </span>
  );
};

ConfidencePill.displayName = 'ConfidencePill';
