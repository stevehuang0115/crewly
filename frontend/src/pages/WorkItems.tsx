/**
 * Tickets › Runs (former Work Items, `/workitems`;
 * specs/2026-10-02-ui-redesign.md §Tickets).
 *
 * One compact row per run (work item from `GET /api/task-pool/items`): the
 * title; a quiet meta line with type, the agent's name, the ticket it
 * belongs to and when it was created; and its status as colour + word.
 * Status sits behind one Filter button (the counts the old summary cards
 * showed are its option counts); search (title, id, agent, type) is an icon
 * that opens a box. Running, blocked and failed runs come first.
 *
 * @module pages/WorkItems
 */

import { LINKS } from '../constants/routes.constants';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Inbox } from 'lucide-react';
import { CompactRow, FilterButton, ShowAll, StatusLabel, statusTone, type FilterGroup, type FilterValue } from '@crewly/ui';
import { Alert } from '@crewly/ui/Alert';
import { Button, IconButton } from '@crewly/ui/Button';
import { SkeletonRows } from '@crewly/ui/SkeletonRows';
import type { WorkItem, WorkItemStatus } from '../components/WorkItemDetail';
import { getWorkItemStatusLabel, getWorkItemTypeLabel, formatRelativeTime } from '../components/WorkItemDetail';
import { SearchToggle } from '../components/Tickets/SearchToggle';
import { useTeams } from '../components/Tickets/useTeams';
import { agentDisplayName, runTicketRef } from '../components/Tickets/board.utils';
import { apiService } from '../services/api.service';

/** Rows shown before "Show all N". */
const RUNS_ROW_LIMIT = 25;

/** Delay between the last keystroke and filtering (ms). */
const SEARCH_DEBOUNCE_MS = 300;

/** Status filter options, in order. */
const STATUS_OPTIONS: { value: WorkItemStatus; label: string }[] = [
  { value: 'running', label: 'Running' },
  { value: 'queued', label: 'Queued' },
  { value: 'done', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'cancelled', label: 'Cancelled' },
];

/** Sort rank: what needs attention first. */
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

/**
 * Render the Runs tab.
 *
 * @returns The page
 */
export const WorkItems: React.FC = () => {
  const navigate = useNavigate();
  const { names } = useTeams();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterValue>({ status: [] });
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  /**
   * Search with a debounce.
   *
   * @param value - New text
   */
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearchQuery(value), SEARCH_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  /** Fetch every run. */
  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiService.getWorkItems();
      setItems(Array.isArray(data) ? (data as WorkItem[]) : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load runs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const wi of items) {
      const key = wi.status === 'scheduled' ? 'queued' : wi.status;
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [items]);

  const groups: FilterGroup[] = useMemo(
    () => [{ id: 'status', label: 'Status', single: true, options: STATUS_OPTIONS.map((o) => ({ ...o, count: statusCounts[o.value] ?? 0 })) }],
    [statusCounts],
  );

  const filteredItems = useMemo(() => {
    const status = filter.status?.[0];
    const q = searchQuery.trim().toLowerCase();
    return items
      .filter((wi) => {
        if (status && wi.status !== status && !(status === 'queued' && wi.status === 'scheduled')) return false;
        if (
          q &&
          !(
            wi.title.toLowerCase().includes(q) ||
            wi.id.toLowerCase().includes(q) ||
            (wi.target ?? '').toLowerCase().includes(q) ||
            (agentDisplayName(wi.target, names) ?? '').toLowerCase().includes(q) ||
            wi.type.toLowerCase().includes(q)
          )
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const pa = STATUS_PRIORITY[a.status] ?? 5;
        const pb = STATUS_PRIORITY[b.status] ?? 5;
        if (pa !== pb) return pa - pb;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [items, filter, searchQuery, names]);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="workitems-page">
      <div className="flex flex-wrap items-center gap-2">
        <FilterButton groups={groups} value={filter} onChange={setFilter} />
        <SearchToggle value={searchInput} onChange={handleSearchChange} placeholder="Search by title, ID, agent…" data-testid="workitems-search" />
        <IconButton
          icon={RefreshCw}
          variant="ghost"
          aria-label="Refresh"
          onClick={() => void loadItems()}
          className="ml-auto"
          data-testid="workitems-refresh"
        />
      </div>

      {loading && (
        <div data-testid="workitems-loading">
          <SkeletonRows count={4} />
        </div>
      )}

      {error && !loading && (
        <Alert variant="error" title="Failed to load runs" onClose={() => setError(null)} data-testid="workitems-error">
          {error}
          <Button variant="ghost" size="sm" onClick={() => void loadItems()} className="mt-2">
            Retry
          </Button>
        </Alert>
      )}

      {!loading && !error && filteredItems.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-16 text-text-2" data-testid="workitems-empty">
          <Inbox className="h-10 w-10 opacity-40" aria-hidden="true" />
          <span className="text-sm">{items.length === 0 ? 'No runs yet.' : 'No runs match the current filters.'}</span>
        </div>
      )}

      {!loading && !error && filteredItems.length > 0 && (
        <div className="overflow-hidden rounded-2xl bg-surface" data-testid="workitems-list">
          <ShowAll limit={RUNS_ROW_LIMIT} as="ul">
            {filteredItems.map((wi) => {
              const ref = runTicketRef(wi.title);
              const agent = agentDisplayName(wi.target, names, true);
              const meta = [getWorkItemTypeLabel(wi.type), agent, ref, formatRelativeTime(wi.createdAt)].filter(Boolean).join(' · ');
              return (
                <li key={wi.id} className="list-none border-b border-border-soft last:border-b-0">
                  <CompactRow
                    primary={<span title={`${wi.title} (${wi.id.slice(0, 8)})`}>{wi.title}</span>}
                    meta={meta}
                    trailing={<StatusLabel tone={statusTone(wi.status === 'cancelled' || wi.status === 'queued' || wi.status === 'scheduled' ? 'neutral' : wi.status)}>{getWorkItemStatusLabel(wi.status)}</StatusLabel>}
                    onClick={() => navigate(LINKS.run(wi.id))}
                    className="border-b-0"
                    data-testid={`workitem-row-${wi.id}`}
                  />
                </li>
              );
            })}
          </ShowAll>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <p className="text-[13px] text-text-3" data-testid="workitems-total">
          {items.length} run{items.length === 1 ? '' : 's'} in the pool
        </p>
      )}
    </div>
  );
};

WorkItems.displayName = 'WorkItems';

export default WorkItems;
