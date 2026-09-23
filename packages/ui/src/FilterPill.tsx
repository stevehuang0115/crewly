/**
 * FilterPill — primitive pill button used for filter chips across list pages.
 *
 * This replaces the inline Tailwind pill markup that was previously duplicated
 * inside PageToolbar.secondaryFilters and per-page FilterRow components.
 *
 * @module components/UI/FilterPill
 */

import React from 'react';

/** Props for the FilterPill primitive. */
export interface FilterPillProps {
  /** Visible label text. */
  children: React.ReactNode;
  /** Whether this pill is currently selected. */
  isActive: boolean;
  /** Click handler. */
  onClick: () => void;
  /** Optional count rendered after the label (e.g. filter match count). */
  count?: number;
  /** Disable interaction and dim the pill. */
  disabled?: boolean;
  /** Optional stable testid for assertions. */
  'data-testid'?: string;
  /** Accessible title/tooltip. */
  title?: string;
}

/**
 * A single rounded filter chip. Pure presentational — state is owned by the
 * caller so the same primitive works for both single- and multi-select groups.
 *
 * @example
 * ```tsx
 * <FilterPill isActive={v === 'high'} onClick={() => setV('high')}>High</FilterPill>
 * ```
 */
export const FilterPill: React.FC<FilterPillProps> = ({
  children,
  isActive,
  onClick,
  count,
  disabled = false,
  title,
  'data-testid': testId,
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={isActive}
      title={title}
      data-testid={testId}
      className={[
        'px-3 py-1 text-xs font-medium rounded-full border transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-background-dark',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        isActive
          ? 'bg-primary/10 text-primary border-primary/30'
          : 'bg-surface-dark text-text-secondary-dark border-border-dark hover:text-text-primary-dark',
      ].join(' ')}
    >
      {children}
      {count !== undefined && (
        <span className="ml-1 opacity-60">({count})</span>
      )}
    </button>
  );
};

FilterPill.displayName = 'FilterPill';
