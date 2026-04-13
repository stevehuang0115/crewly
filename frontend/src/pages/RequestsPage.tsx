/**
 * Requests Page — V3
 *
 * Page shell for the /requests route. Contains page header, summary bar,
 * filter controls, and the request feed (RequestList).
 * Uses shared UI components and Tailwind for layout — no custom CSS file.
 *
 * @module pages/RequestsPage
 */

import React, { useState, useCallback, useMemo } from 'react';
import { RequestSummaryBar } from '../components/RequestTracking/RequestSummaryBar';
import { RequestList } from '../components/RequestTracking/RequestList';
import { PageToolbar } from '../components/UI/PageToolbar';
import type { FilterTab, SecondaryFilter } from '../components/UI/PageToolbar';
import type { RequestStatistics, RequestPrimaryFilter, RequestSecondaryFilter } from '../components/RequestTracking/request-tracking.types';

// =============================================================================
// Component
// =============================================================================

/**
 * Requests page with page shell, summary bar, filters, and request feed.
 *
 * Orchestrates state between RequestSummaryBar, RequestFilters, and RequestList:
 * - Stats from RequestList are propagated to RequestSummaryBar
 * - Filter/search state from RequestFilters is propagated to RequestList
 *
 * @returns Requests page JSX element
 */
export const RequestsPage: React.FC = () => {
  const [stats, setStats] = useState<RequestStatistics | null>(null);
  const [activeFilter, setActiveFilter] = useState<RequestPrimaryFilter>('active');
  const [secondaryFilters, setSecondaryFilters] = useState<Set<RequestSecondaryFilter>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  /** Receive stats from RequestList */
  const handleStatsLoaded = useCallback((loadedStats: RequestStatistics) => {
    setStats(loadedStats);
  }, []);

  /** Toggle a secondary filter on/off */
  const handleSecondaryToggle = useCallback((filter: RequestSecondaryFilter) => {
    setSecondaryFilters((prev) => {
      const next = new Set(prev);
      if (next.has(filter)) {
        next.delete(filter);
      } else {
        next.add(filter);
      }
      return next;
    });
  }, []);

  /** Build filter tabs from stats */
  const filterTabs: FilterTab[] = useMemo(() => [
    { value: 'all', label: 'All', count: stats?.total },
    { value: 'active', label: 'Active', count: stats?.active },
    { value: 'blocked', label: 'Blocked', count: stats?.blocked },
    { value: 'waiting_confirmation', label: 'Waiting', count: stats?.waitingConfirmation },
    { value: 'done', label: 'Done', count: stats?.done },
  ], [stats]);

  const secondaryDefs: SecondaryFilter[] = useMemo(() => [
    { value: 'assigned_to_me', label: 'Assigned to Me' },
    { value: 'urgent', label: 'Urgent' },
  ], []);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-[960px]" data-testid="requests-page">
      {/* Page header */}
      <div className="flex flex-col gap-1" data-testid="requests-page-header">
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-text-primary-dark">Requests</h1>
          <p className="text-sm text-text-secondary-dark">
            Monitor and triage incoming work from all channels.
          </p>
        </div>
      </div>

      {/* Summary bar */}
      <RequestSummaryBar stats={stats} />

      {/* Shared toolbar: tabs + search + secondary filters */}
      <PageToolbar
        tabs={filterTabs}
        activeTab={activeFilter}
        onTabChange={(v) => setActiveFilter(v as RequestPrimaryFilter)}
        searchPlaceholder="Search requests..."
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        secondaryFilters={secondaryDefs}
        activeSecondaryFilters={secondaryFilters}
        onSecondaryFilterToggle={(v) => handleSecondaryToggle(v as RequestSecondaryFilter)}
      />

      {/* Request feed */}
      <RequestList
        activeFilter={activeFilter}
        secondaryFilters={secondaryFilters}
        searchQuery={searchQuery}
        onStatsLoaded={handleStatsLoaded}
      />
    </div>
  );
};

export default RequestsPage;
