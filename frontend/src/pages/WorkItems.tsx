/**
 * WorkItems Page — V3
 *
 * Lists all WorkItems from the task pool with filtering and search.
 * Fetches real data from GET /api/task-pool/all.
 *
 * @module pages/WorkItems
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw,
  Inbox,
  Search,
} from 'lucide-react';
import { Card } from '../components/UI/Card';
import { Badge } from '../components/UI/Badge';
import { StatusBadge } from '../components/UI/StatusBadge';
import { Tabs, TabList, TabTrigger } from '../components/UI/Tabs';
import { Alert } from '../components/UI/Alert';
import { Button } from '../components/UI/Button';
import { SkeletonRows } from '../components/UI/SkeletonRows';
import type { WorkItem, WorkItemStatus } from '../components/WorkItemDetail';
import {
  getWorkItemStatusType,
  getWorkItemStatusLabel,
  getWorkItemTypeBadgeVariant,
  getWorkItemTypeLabel,
  formatRelativeTime,
} from '../components/WorkItemDetail';
import { WorkItemSummaryBar, computeWorkItemStats } from '../components/WorkItemDetail/WorkItemSummaryBar';
import { apiService } from '../services/api.service';

// =============================================================================
// Types
// =============================================================================

/** Filter options for the WorkItems list */
type StatusFilter = 'all' | WorkItemStatus;

// =============================================================================
// Component
// =============================================================================

/**
 * WorkItems list page — displays all WorkItems with status filters and search.
 *
 * @returns WorkItems page JSX element
 */
export const WorkItems: React.FC = () => {
  const navigate = useNavigate();

  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  /**
   * Handles search input changes with 300ms debounce.
   * Updates the display value immediately but delays the filter query.
   *
   * @param value - The new search input value
   */
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearchQuery(value);
    }, 300);
  }, []);

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  /**
   * Fetches all WorkItems from the backend.
   */
  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiService.getWorkItems();
      if (!Array.isArray(data)) {
        console.warn('[WorkItems] getWorkItems returned non-array:', typeof data, data);
        setItems([]);
        return;
      }
      setItems(data as WorkItem[]);
    } catch (err) {
      console.warn('[WorkItems] loadItems error:', err);
      setError(err instanceof Error ? err.message : 'Failed to load work items');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  /** Filtered items based on status and search */
  const filteredItems = useMemo(() => {
    let result = items;

    if (statusFilter !== 'all') {
      result = result.filter((wi) => wi.status === statusFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (wi) =>
          wi.title.toLowerCase().includes(q) ||
          wi.id.toLowerCase().includes(q) ||
          wi.target?.toLowerCase().includes(q) ||
          wi.type.toLowerCase().includes(q)
      );
    }

    // Sort: active statuses first, then by date descending
    const STATUS_PRIORITY: Record<string, number> = {
      running: 0,
      blocked: 1,
      failed: 2,
      done: 3,
      completed: 3,
      cancelled: 4,
      queued: 5,
      scheduled: 5,
    };

    return result.sort((a, b) => {
      const pa = STATUS_PRIORITY[a.status] ?? 5;
      const pb = STATUS_PRIORITY[b.status] ?? 5;
      if (pa !== pb) return pa - pb;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [items, statusFilter, searchQuery]);

  /** Status counts for filter badges */
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: items.length };
    for (const wi of items) {
      counts[wi.status] = (counts[wi.status] || 0) + 1;
    }
    return counts;
  }, [items]);

  /** Summary statistics for the stat cards */
  const summaryStats = useMemo(() => (items.length > 0 ? computeWorkItemStats(items) : null), [items]);

  const filterButtons: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'running', label: 'Running' },
    { key: 'queued', label: 'Queued' },
    { key: 'done', label: 'Completed' },
    { key: 'failed', label: 'Failed' },
    { key: 'blocked', label: 'Blocked' },
    { key: 'cancelled', label: 'Cancelled' },
  ];

  /**
   * Handles keyboard interaction for work item card rows.
   * Triggers navigation on Enter or Space key press.
   *
   * @param e - Keyboard event
   * @param id - WorkItem ID to navigate to
   */
  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, id: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigate(`/workitems/${id}`);
      }
    },
    [navigate],
  );

  return (
    <div className="p-6 max-w-[1400px] mx-auto" data-testid="workitems-page">
      {/* Page header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-2xl font-bold text-text-primary-dark">Work Items</h1>
          <button
            onClick={loadItems}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary-dark hover:text-text-primary-dark bg-surface-dark border border-border-dark rounded-lg transition-colors disabled:opacity-50"
            data-testid="workitems-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
        <p className="text-sm text-text-secondary-dark">
          Execution-level view of all system tasks in the task pool.
        </p>
      </div>

      {/* Summary stats */}
      {!loading && <WorkItemSummaryBar stats={summaryStats} />}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Tabs defaultValue="all" onValueChange={(v) => setStatusFilter(v)}>
          <TabList>
            {filterButtons.map((fb) => (
              <TabTrigger key={fb.key} value={fb.key}>
                {fb.label}
                {statusCounts[fb.key] !== undefined && (
                  <span className="ml-1 opacity-60">({statusCounts[fb.key]})</span>
                )}
              </TabTrigger>
            ))}
          </TabList>
        </Tabs>

        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-[400px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-secondary-dark" />
          <input
            type="text"
            placeholder="Search by title, ID, agent..."
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm bg-surface-dark border border-border-dark rounded-lg text-text-primary-dark placeholder:text-text-secondary-dark focus:outline-none focus:border-primary/50"
            data-testid="workitems-search"
          />
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div data-testid="workitems-loading">
          <SkeletonRows count={4} />
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <Alert variant="error" title="Failed to load work items" onClose={() => setError(null)} data-testid="workitems-error">
          {error}
          <Button variant="ghost" size="sm" onClick={loadItems} className="mt-2">
            Retry
          </Button>
        </Alert>
      )}

      {/* Empty state */}
      {!loading && !error && filteredItems.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-text-secondary-dark" data-testid="workitems-empty">
          <Inbox className="h-10 w-10 opacity-40" />
          <span className="text-sm">
            {items.length === 0
              ? 'No work items in the pool yet.'
              : 'No work items match the current filters.'}
          </span>
        </div>
      )}

      {/* Items list */}
      {!loading && !error && filteredItems.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="workitems-list">
          {filteredItems.map((wi) => (
            <Card
              key={wi.id}
              variant="default"
              padding="md"
              interactive
              className="hover:border-primary/40"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/workitems/${wi.id}`)}
              onKeyDown={(e) => handleRowKeyDown(e, wi.id)}
              data-testid={`workitem-row-${wi.id}`}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-base font-medium text-text-primary-dark truncate">
                      {wi.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusBadge status={getWorkItemStatusType(wi.status)}>
                      {getWorkItemStatusLabel(wi.status)}
                    </StatusBadge>
                    <Badge variant={getWorkItemTypeBadgeVariant(wi.type)} size="sm">
                      {getWorkItemTypeLabel(wi.type)}
                    </Badge>
                    {wi.target && (
                      <Badge variant="default" size="sm">
                        {wi.target}
                      </Badge>
                    )}
                    <span className="text-xs text-text-secondary-dark">
                      {formatRelativeTime(wi.createdAt)}
                    </span>
                  </div>
                </div>
                <span className="text-xs text-text-secondary-dark font-mono flex-shrink-0">
                  {wi.id.slice(0, 8)}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

WorkItems.displayName = 'WorkItems';

export default WorkItems;
