/**
 * FilterPillGroup — labeled row of FilterPill buttons with single-select semantics.
 *
 * The caller owns the selected value; the group only renders.
 *
 * @module components/UI/FilterPillGroup
 */

import React from 'react';
import { FilterPill } from './FilterPill';

/** One option inside a FilterPillGroup. */
export interface FilterPillOption<T extends string> {
  /** The value passed back to `onChange` when the pill is clicked. */
  key: T;
  /** Visible label. */
  label: string;
  /** Optional count shown after the label. */
  count?: number;
}

/** Props for FilterPillGroup. Generic over the key type to preserve unions. */
export interface FilterPillGroupProps<T extends string> {
  /** Optional row label rendered on the left. */
  label?: string;
  /** Available options. */
  options: FilterPillOption<T>[];
  /** Currently selected option key. */
  value: T;
  /** Called with the newly selected option's key. */
  onChange: (value: T) => void;
  /** Prefix applied to each pill's `data-testid` (`{prefix}-{key}`). */
  testIdPrefix?: string;
  /** Extra class applied to the outer container. */
  className?: string;
}

/**
 * Renders a labeled row of single-select filter pills.
 *
 * @example
 * ```tsx
 * <FilterPillGroup
 *   label="Priority"
 *   options={[{ key: 'all', label: 'All' }, { key: 'high', label: 'High' }]}
 *   value={priority}
 *   onChange={setPriority}
 *   testIdPrefix="priority-filter"
 * />
 * ```
 */
export function FilterPillGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  testIdPrefix,
  className = '',
}: FilterPillGroupProps<T>): React.ReactElement {
  return (
    <div className={`flex items-center gap-2 flex-wrap ${className}`} role="group" aria-label={label}>
      {label && (
        <span className="text-xs uppercase tracking-wide text-text-secondary-dark font-medium min-w-[72px]">
          {label}
        </span>
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        {options.map((opt) => (
          <FilterPill
            key={opt.key}
            isActive={opt.key === value}
            onClick={() => onChange(opt.key)}
            count={opt.count}
            data-testid={testIdPrefix ? `${testIdPrefix}-${opt.key}` : undefined}
          >
            {opt.label}
          </FilterPill>
        ))}
      </div>
    </div>
  );
}

FilterPillGroup.displayName = 'FilterPillGroup';
