/**
 * PageToolbar — shared filter tabs + search + view toggle for list pages.
 *
 * Replaces 7 different inline filter implementations with a single
 * consistent compound component. Supports:
 * - Filter tabs with optional counts
 * - Debounced search input
 * - View mode toggle (grid/list/tree)
 * - Secondary filter toggles
 *
 * @module components/UI/PageToolbar
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export interface FilterTab {
  /** Unique value used as the filter key */
  value: string;
  /** Display label */
  label: string;
  /** Optional count badge */
  count?: number;
}

export interface ViewMode {
  /** Unique value for this view mode */
  value: string;
  /** Label (used as tooltip) */
  label: string;
  /** Lucide icon component */
  icon: React.ReactNode;
}

export interface SecondaryFilter {
  /** Unique value */
  value: string;
  /** Display label */
  label: string;
  /** Optional count */
  count?: number;
}

export interface PageToolbarProps {
  /** Filter tab definitions */
  tabs: FilterTab[];
  /** Currently active tab value */
  activeTab: string;
  /** Called when a tab is clicked */
  onTabChange: (value: string) => void;

  /** Search placeholder text (omit to hide search) */
  searchPlaceholder?: string;
  /** Current search value */
  searchValue?: string;
  /** Called when search changes (already debounced internally) */
  onSearchChange?: (value: string) => void;
  /** Search debounce delay in ms (default: 300) */
  searchDebounceMs?: number;

  /** View mode definitions (omit to hide view toggle) */
  viewModes?: ViewMode[];
  /** Currently active view mode */
  activeViewMode?: string;
  /** Called when a view mode is clicked */
  onViewModeChange?: (value: string) => void;

  /** Secondary toggle filters (omit to hide) */
  secondaryFilters?: SecondaryFilter[];
  /** Currently active secondary filter values */
  activeSecondaryFilters?: Set<string>;
  /** Called when a secondary filter is toggled */
  onSecondaryFilterToggle?: (value: string) => void;

  /** Extra content to render on the right side (e.g. sort dropdown, action buttons) */
  trailing?: React.ReactNode;

  /** Additional CSS classes for the outer container */
  className?: string;
}

// =============================================================================
// Internal: Debounced Search
// =============================================================================

const DebouncedSearch: React.FC<{
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  debounceMs: number;
}> = ({ placeholder, value, onChange, debounceMs }) => {
  const [local, setLocal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  // Sync external → local when parent resets
  useEffect(() => { setLocal(value); }, [value]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setLocal(v);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onChange(v), debounceMs);
  }, [onChange, debounceMs]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div className="relative flex-1 min-w-[180px] max-w-[400px]">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary-dark pointer-events-none" />
      <input
        type="text"
        className="w-full bg-background-dark border border-border-dark rounded-lg pl-9 pr-3 py-2 text-sm text-text-primary-dark placeholder-text-secondary-dark focus:outline-none focus:border-accent-blue/50"
        placeholder={placeholder}
        value={local}
        onChange={handleChange}
      />
    </div>
  );
};

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a consistent filter toolbar used across list pages.
 *
 * @example
 * ```tsx
 * <PageToolbar
 *   tabs={[
 *     { value: 'all', label: 'All', count: 42 },
 *     { value: 'active', label: 'Active', count: 12 },
 *     { value: 'done', label: 'Done', count: 30 },
 *   ]}
 *   activeTab={filter}
 *   onTabChange={setFilter}
 *   searchPlaceholder="Search requests..."
 *   searchValue={search}
 *   onSearchChange={setSearch}
 * />
 * ```
 */
export const PageToolbar: React.FC<PageToolbarProps> = ({
  tabs,
  activeTab,
  onTabChange,
  searchPlaceholder,
  searchValue = '',
  onSearchChange,
  searchDebounceMs = 300,
  viewModes,
  activeViewMode,
  onViewModeChange,
  secondaryFilters,
  activeSecondaryFilters,
  onSecondaryFilterToggle,
  trailing,
  className = '',
}) => {
  return (
    <div className={`flex flex-col gap-3 mb-4 ${className}`}>
      {/* Row 1: Tabs + View toggle + Trailing */}
      <div className="flex items-center justify-between border-b border-border-dark">
        {/* Tabs */}
        <div className="flex gap-1" role="tablist">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onTabChange(tab.value)}
                className={[
                  'flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors',
                  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-background-dark',
                  isActive
                    ? 'text-primary border-primary'
                    : 'text-text-secondary-dark border-transparent hover:text-text-primary-dark hover:bg-background-dark/50',
                ].join(' ')}
              >
                {tab.label}
                {tab.count !== undefined && (
                  <span className="ml-0.5 text-xs opacity-60">({tab.count})</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Right side: view toggle + trailing */}
        <div className="flex items-center gap-2 mb-px">
          {viewModes && viewModes.length > 0 && (
            <div className="flex items-center gap-1">
              {viewModes.map((mode) => {
                const isActive = activeViewMode === mode.value;
                return (
                  <button
                    key={mode.value}
                    type="button"
                    title={mode.label}
                    onClick={() => onViewModeChange?.(mode.value)}
                    className={[
                      'p-1.5 rounded transition-colors',
                      isActive
                        ? 'text-primary bg-primary/10'
                        : 'text-text-secondary-dark hover:text-text-primary-dark',
                    ].join(' ')}
                  >
                    {mode.icon}
                  </button>
                );
              })}
            </div>
          )}
          {trailing}
        </div>
      </div>

      {/* Row 2: Search + Secondary filters */}
      {(searchPlaceholder || (secondaryFilters && secondaryFilters.length > 0)) && (
        <div className="flex flex-wrap items-center gap-3">
          {searchPlaceholder && onSearchChange && (
            <DebouncedSearch
              placeholder={searchPlaceholder}
              value={searchValue}
              onChange={onSearchChange}
              debounceMs={searchDebounceMs}
            />
          )}

          {secondaryFilters && secondaryFilters.length > 0 && (
            <div className="flex items-center gap-1.5">
              {secondaryFilters.map((sf) => {
                const isActive = activeSecondaryFilters?.has(sf.value) ?? false;
                return (
                  <button
                    key={sf.value}
                    type="button"
                    onClick={() => onSecondaryFilterToggle?.(sf.value)}
                    className={[
                      'px-3 py-1.5 text-xs font-medium rounded-full border transition-colors',
                      isActive
                        ? 'bg-primary/10 text-primary border-primary/30'
                        : 'bg-surface-dark text-text-secondary-dark border-border-dark hover:text-text-primary-dark',
                    ].join(' ')}
                  >
                    {sf.label}
                    {sf.count !== undefined && (
                      <span className="ml-1 opacity-60">({sf.count})</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

PageToolbar.displayName = 'PageToolbar';
