/**
 * FilterButton Component
 *
 * The redesign's single "Filter" control: a button that opens a popover of
 * filter groups (checkbox options), with the active filters shown next to
 * it as removable chips. Replaces rows of filter pills and dropdowns.
 *
 * Controlled: `value` maps group id → selected option values.
 *
 * @module components/UI/FilterButton
 */

import React, { useEffect, useRef, useState } from 'react';
import { ListFilter, X } from 'lucide-react';
import { cn } from './cn';

export interface FilterOption {
  value: string;
  label: string;
  /** Optional count shown after the label */
  count?: number;
}

export interface FilterGroup {
  /** Key in the `value` map */
  id: string;
  /** Group heading and chip prefix ("Status") */
  label: string;
  options: FilterOption[];
  /** Pick one option only (radio behaviour). Default: several. */
  single?: boolean;
}

/** Selected option values per group id. */
export type FilterValue = Record<string, string[]>;

export interface FilterButtonProps {
  groups: FilterGroup[];
  value: FilterValue;
  onChange: (next: FilterValue) => void;
  /** Button text (default "Filter") */
  label?: string;
  /** Show the active filters as removable chips after the button (default true) */
  showChips?: boolean;
  /** Open on first render (static previews) */
  defaultOpen?: boolean;
  /** Which edge the popover lines up with */
  align?: 'start' | 'end';
  /** Additional CSS classes on the wrapper */
  className?: string;
}

/**
 * Number of active filter values.
 *
 * @param value - Current selection
 * @returns Count of selected options across groups
 */
export function activeFilterCount(value: FilterValue): number {
  return Object.values(value).reduce((n, v) => n + (v?.length ?? 0), 0);
}

/**
 * Filter button + popover + active chips.
 *
 * @param props - {@link FilterButtonProps}
 * @returns The control
 *
 * @example
 * ```tsx
 * const [filters, setFilters] = useState<FilterValue>({ status: ['running'] });
 * <FilterButton value={filters} onChange={setFilters} groups={[
 *   { id: 'status', label: 'Status', options: [{ value: 'running', label: 'Running' }, { value: 'failed', label: 'Failed' }] },
 *   { id: 'team', label: 'Team', options: teams.map((t) => ({ value: t.id, label: t.name })) },
 * ]} />
 * ```
 */
export const FilterButton: React.FC<FilterButtonProps> = ({
  groups,
  value,
  onChange,
  label = 'Filter',
  showChips = true,
  defaultOpen = false,
  align = 'start',
  className,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement | null>(null);
  const count = activeFilterCount(value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggleOption = (group: FilterGroup, optionValue: string) => {
    const current = value[group.id] ?? [];
    const selected = current.includes(optionValue);
    const nextGroup = group.single
      ? selected
        ? []
        : [optionValue]
      : selected
        ? current.filter((v) => v !== optionValue)
        : [...current, optionValue];
    onChange({ ...value, [group.id]: nextGroup });
  };

  const removeChip = (groupId: string, optionValue: string) => {
    onChange({ ...value, [groupId]: (value[groupId] ?? []).filter((v) => v !== optionValue) });
  };

  const chips = groups.flatMap((g) =>
    (value[g.id] ?? []).map((v) => ({
      groupId: g.id,
      value: v,
      text: `${g.label}: ${g.options.find((o) => o.value === v)?.label ?? v}`,
    })),
  );

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            'inline-flex h-9 items-center gap-2 rounded-2xl border px-3 text-sm font-semibold transition-colors',
            count > 0 ? 'border-primary-text/40 text-primary-text' : 'border-border text-text-2 hover:text-text',
          )}
          data-testid="filter-button"
        >
          <ListFilter className="h-4 w-4" aria-hidden="true" />
          {label}
          {count > 0 && (
            <span className="min-w-[1.25rem] rounded-full bg-primary-soft px-1.5 py-0.5 text-center text-[11px] font-bold leading-none text-primary-text">
              {count}
            </span>
          )}
        </button>
        {open && (
          <div
            role="dialog"
            aria-label={label}
            className={cn(
              'absolute top-full z-50 mt-1 max-h-[70vh] w-64 overflow-y-auto rounded-2xl border border-border bg-surface p-2 shadow-lg',
              align === 'end' ? 'right-0' : 'left-0',
            )}
            data-testid="filter-popover"
          >
            {groups.map((g) => (
              <fieldset key={g.id} className="mb-2 last:mb-0">
                <legend className="px-2 pb-1 pt-1 text-[11px] font-bold uppercase tracking-wide text-text-3">{g.label}</legend>
                {g.options.map((o) => {
                  const checked = (value[g.id] ?? []).includes(o.value);
                  return (
                    <label
                      key={o.value}
                      className="flex cursor-pointer items-center gap-2 rounded-[0.5rem] px-2 py-1.5 text-sm text-text hover:bg-surface-hover"
                    >
                      <input
                        type={g.single ? 'radio' : 'checkbox'}
                        name={`filter-${g.id}`}
                        checked={checked}
                        onChange={() => toggleOption(g, o.value)}
                        onClick={g.single && checked ? () => toggleOption(g, o.value) : undefined}
                        className="accent-primary"
                      />
                      <span className="flex-1">{o.label}</span>
                      {o.count !== undefined && <span className="text-xs tabular-nums text-text-3">{o.count}</span>}
                    </label>
                  );
                })}
              </fieldset>
            ))}
            {count > 0 && (
              <button
                type="button"
                onClick={() => onChange(Object.fromEntries(groups.map((g) => [g.id, []])))}
                className="mt-1 w-full rounded-[0.5rem] px-2 py-1.5 text-left text-[13px] font-semibold text-primary-text hover:bg-surface-hover"
              >
                Clear all
              </button>
            )}
          </div>
        )}
      </div>
      {showChips &&
        chips.map((c) => (
          <span
            key={`${c.groupId}:${c.value}`}
            className="inline-flex h-7 items-center gap-1 rounded-full bg-primary-soft pl-3 pr-1 text-[13px] font-semibold text-primary-text"
            data-testid="filter-chip"
          >
            {c.text}
            <button
              type="button"
              onClick={() => removeChip(c.groupId, c.value)}
              aria-label={`Remove filter ${c.text}`}
              className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-primary-soft"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
    </div>
  );
};

FilterButton.displayName = 'FilterButton';
