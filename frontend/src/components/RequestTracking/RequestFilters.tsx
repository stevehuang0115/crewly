/**
 * Request Filters Component
 *
 * Search input and status filter chips for the request list.
 * Uses the shared Input and Badge UI components.
 * Search input is debounced by 300ms to avoid excessive re-filtering.
 *
 * @module components/RequestTracking/RequestFilters
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search } from 'lucide-react';
import { Input } from '../UI';
import { Badge } from '../UI';
import type { RequestStatistics, RequestPrimaryFilter, RequestSecondaryFilter } from './request-tracking.types';
import { getRequestStatusLabel } from './request-tracking.types';

// =============================================================================
// Props
// =============================================================================

interface RequestFiltersProps {
  /** Currently active primary filter */
  activeFilter: RequestPrimaryFilter;
  /** Callback when the primary filter changes */
  onFilterChange: (filter: RequestPrimaryFilter) => void;
  /** Currently active secondary filters (toggle set) */
  activeSecondaryFilters: Set<RequestSecondaryFilter>;
  /** Callback when a secondary filter is toggled */
  onSecondaryFilterToggle: (filter: RequestSecondaryFilter) => void;
  /** Current search query */
  searchQuery: string;
  /** Callback when the search query changes */
  onSearchChange: (query: string) => void;
  /** Statistics for chip counts */
  stats: RequestStatistics | null;
}

// =============================================================================
// Constants
// =============================================================================

/** Filter chip definitions */
const FILTER_CHIPS: Array<{ filter: RequestPrimaryFilter; statKey?: keyof RequestStatistics }> = [
  { filter: 'all' },
  { filter: 'active', statKey: 'active' },
  { filter: 'blocked', statKey: 'blocked' },
  { filter: 'waiting_confirmation', statKey: 'waitingConfirmation' },
];

/** Secondary filter button definitions */
const SECONDARY_FILTER_BUTTONS: Array<{ label: string; filter: RequestSecondaryFilter }> = [
  { label: 'Assigned to Me', filter: 'assigned_to_me' },
  { label: 'Urgent', filter: 'urgent' },
];

/** Debounce delay in milliseconds for search input */
const SEARCH_DEBOUNCE_MS = 300;

// =============================================================================
// Component
// =============================================================================

/**
 * Renders search input, primary status chips, and secondary filter buttons.
 * Uses the shared Input component for the search bar and Badge for filter chips.
 * Search input is debounced to avoid excessive filtering on every keystroke.
 *
 * @param props - Filter state and callbacks
 * @returns Filters JSX element
 */
export const RequestFilters: React.FC<RequestFiltersProps> = ({
  activeFilter,
  onFilterChange,
  activeSecondaryFilters,
  onSecondaryFilterToggle,
  searchQuery,
  onSearchChange,
  stats,
}) => {
  const [localSearch, setLocalSearch] = useState(searchQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const prevQueryRef = useRef(searchQuery);

  // Sync local state if parent resets searchQuery externally (avoids loop)
  useEffect(() => {
    if (searchQuery !== prevQueryRef.current) {
      setLocalSearch(searchQuery);
      prevQueryRef.current = searchQuery;
    }
  }, [searchQuery]);

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  /**
   * Handles search input changes with debounce.
   * Updates local display value immediately, delays parent callback.
   *
   * @param value - New search input value
   */
  const handleSearchInput = useCallback((value: string) => {
    setLocalSearch(value);
    prevQueryRef.current = value;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onSearchChange(value);
    }, SEARCH_DEBOUNCE_MS);
  }, [onSearchChange]);

  return (
    <div className="flex flex-col gap-3" data-testid="request-filters">
      {/* Search row */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-secondary-dark/50" />
        <Input
          type="text"
          placeholder="Search requests..."
          value={localSearch}
          onChange={(e) => handleSearchInput(e.target.value)}
          className="pl-9"
          fullWidth
          data-testid="request-search-input"
        />
      </div>

      {/* Primary status chips */}
      <div className="flex gap-2 flex-wrap items-center">
        {FILTER_CHIPS.map(({ filter, statKey }) => {
          const isActive = activeFilter === filter;
          const count = statKey && stats ? stats[statKey] : filter === 'all' && stats ? stats.total : undefined;
          const label = filter === 'all' ? 'All' : getRequestStatusLabel(filter);

          return (
            <button
              key={filter}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-full text-xs font-medium border transition-colors cursor-pointer ${
                isActive
                  ? 'bg-primary/10 border-primary/20 text-primary'
                  : 'border-border-dark text-text-secondary-dark hover:border-primary/50 hover:text-text-primary-dark'
              }`}
              onClick={() => onFilterChange(filter)}
              data-testid={`request-filter-${filter}`}
            >
              {label}
              {count !== undefined && (
                <Badge variant={isActive ? 'primary' : 'default'} size="sm">
                  {count}
                </Badge>
              )}
            </button>
          );
        })}
      </div>

      {/* Secondary filter buttons */}
      <div className="flex gap-2 flex-wrap">
        {SECONDARY_FILTER_BUTTONS.map(({ label, filter }) => {
          const isActive = activeSecondaryFilters.has(filter);
          return (
            <button
              key={filter}
              onClick={() => onSecondaryFilterToggle(filter)}
              className={`inline-flex items-center gap-1.5 px-3 py-2.5 rounded-full text-xs font-medium border transition-colors cursor-pointer ${
                isActive
                  ? 'bg-primary/10 border-primary/20 text-primary'
                  : 'border-border-dark text-text-secondary-dark/60 hover:border-primary/50 hover:text-text-secondary-dark'
              }`}
              data-testid={`request-secondary-${label.toLowerCase().replace(/\s+/g, '-')}`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
};
