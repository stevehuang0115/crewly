/**
 * TrustChipsRow Component
 *
 * Displays reassurance chips below the URL input or in context panels.
 * Signals privacy, editability, and timing to build user trust.
 *
 * @module components/PortalOnboarding/TrustChipsRow
 */

import React, { type ReactNode } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface TrustChip {
  /** Optional icon rendered before the label */
  icon?: ReactNode;
  /** Chip text */
  label: string;
}

export interface TrustChipsRowProps {
  /** Chips to display */
  chips: TrustChip[];
  /** Alignment */
  align?: 'center' | 'left';
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a horizontal row of small trust signal chips.
 *
 * @param props - Component props
 * @returns TrustChipsRow element
 */
export const TrustChipsRow: React.FC<TrustChipsRowProps> = ({
  chips,
  align = 'center',
}) => {
  if (chips.length === 0) return null;

  const alignClass = align === 'center' ? 'justify-center' : 'justify-start';

  return (
    <div
      className={`flex flex-wrap gap-2 ${alignClass}`}
      data-testid="trust-chips-row"
    >
      {chips.map((chip, index) => (
        <span
          key={index}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-dark border border-border-dark text-xs text-text-secondary-dark"
          data-testid="trust-chip"
        >
          {chip.icon && <span className="flex-shrink-0">{chip.icon}</span>}
          {chip.label}
        </span>
      ))}
    </div>
  );
};

TrustChipsRow.displayName = 'TrustChipsRow';
