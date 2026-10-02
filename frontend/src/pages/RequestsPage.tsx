/**
 * Tickets › Requests (former `/tasks`, specs/2026-10-02-ui-redesign.md
 * §Tickets).
 *
 * One compact row per request: the title; a quiet meta line with category,
 * the agent that handled it, runs, what the agent still owes, priority (only
 * when urgent) and when it changed; and its status as colour + word. Status
 * and "Assigned to me" / "Urgent" sit behind one Filter button (Active by
 * default); search is an icon that opens a box. The counts the old summary
 * cards showed live in the Status options; the total cost is one quiet line
 * under the list.
 *
 * @module pages/RequestsPage
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Inbox, Mail, MessageCircle, MessageSquare, PenLine, Plug, RefreshCw } from 'lucide-react';
import { CompactRow, FilterButton, ShowAll, StatusLabel, type FilterGroup, type FilterValue, type StatusTone } from '@crewly/ui';
import { Button, IconButton } from '@crewly/ui/Button';
import { SkeletonRows } from '@crewly/ui/SkeletonRows';
import { apiToRequestItems } from '../components/RequestTracking/RequestList';
import {
  computeRequestStats,
  formatCost,
  formatRequestTime,
  getRequestStatusLabel,
  getSourceLabel,
  type RequestItem,
  type RequestSource,
  type RequestStatus,
} from '../components/RequestTracking/request-tracking.types';
import { SearchToggle } from '../components/Tickets/SearchToggle';
import { useTeams } from '../components/Tickets/useTeams';
import { agentDisplayName, displayTitle } from '../components/Tickets/board.utils';
import { LINKS } from '../constants/routes.constants';
import { apiService } from '../services/api.service';

/** Rows shown before "Show all N". */
const REQUESTS_ROW_LIMIT = 25;

/** Delay between the last keystroke and filtering (ms). */
const SEARCH_DEBOUNCE_MS = 300;

/** Source icons (the source's name is the icon's tooltip). */
const SOURCE_ICONS: Record<RequestSource, React.ComponentType<{ className?: string }>> = {
  slack: MessageSquare,
  email: Mail,
  chat: MessageCircle,
  api: Plug,
  manual: PenLine,
};

/** Status colour. */
const STATUS_TONE: Record<RequestStatus, StatusTone> = {
  active: 'primary',
  blocked: 'danger',
  waiting_confirmation: 'attention',
  done: 'success',
};

/** Short status words for rows and the filter. */
const STATUS_WORD: Record<RequestStatus, string> = {
  active: 'Active',
  blocked: 'Blocked',
  waiting_confirmation: 'Waiting',
  done: 'Done',
};

/** Filter shown when the page opens: active requests. */
const DEFAULT_FILTER: FilterValue = { status: ['active'], only: [] };

/**
 * Render the Requests tab.
 *
 * @returns The page
 */
export const RequestsPage: React.FC = () => {
  const navigate = useNavigate();
  const { names } = useTeams();
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterValue>(DEFAULT_FILTER);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setQuery(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  /** Fetch every request. */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const raw = await apiService.getRequests();
      setRequests(Array.isArray(raw) ? apiToRequestItems(raw as Record<string, unknown>[]) : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load requests');
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => computeRequestStats(requests), [requests]);

  const groups: FilterGroup[] = useMemo(
    () => [
      {
        id: 'status',
        label: 'Status',
        single: true,
        options: [
          { value: 'active', label: STATUS_WORD.active, count: stats.active },
          { value: 'blocked', label: STATUS_WORD.blocked, count: stats.blocked },
          { value: 'waiting_confirmation', label: STATUS_WORD.waiting_confirmation, count: stats.waitingConfirmation },
          { value: 'done', label: STATUS_WORD.done, count: stats.done },
        ],
      },
      {
        id: 'only',
        label: 'Only',
        options: [
          { value: 'assigned_to_me', label: 'Assigned to me' },
          { value: 'urgent', label: 'Urgent' },
        ],
      },
    ],
    [stats],
  );

  const visible = useMemo(() => {
    const status = filter.status?.[0];
    const only = filter.only ?? [];
    const q = query.trim().toLowerCase();
    return requests.filter((r) => {
      if (status && r.status !== status) return false;
      if (only.includes('urgent') && r.priority !== 'critical' && r.priority !== 'high') return false;
      if (only.includes('assigned_to_me') && r.requester !== 'user') return false;
      if (q && !(r.title.toLowerCase().includes(q) || r.requester.toLowerCase().includes(q) || (r.missionLink ?? '').toLowerCase().includes(q))) {
        return false;
      }
      return true;
    });
  }, [requests, filter, query]);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="requests-page">
      <div className="flex flex-wrap items-center gap-2">
        <FilterButton groups={groups} value={filter} onChange={setFilter} />
        <SearchToggle value={search} onChange={setSearch} placeholder="Search requests…" data-testid="request-search-input" />
        <IconButton icon={RefreshCw} variant="ghost" aria-label="Refresh" onClick={() => void load()} className="ml-auto" />
      </div>

      {loading ? (
        <div data-testid="request-list-loading">
          <SkeletonRows count={4} />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 py-16 text-text-2" data-testid="request-list-error">
          <span className="text-sm text-danger">{error}</span>
          <Button variant="link" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-text-2" data-testid="request-list-empty">
          <Inbox className="h-10 w-10 opacity-40" aria-hidden="true" />
          <span className="text-sm">
            {requests.length === 0
              ? 'No requests yet. They appear here when you ask for something in Slack or chat.'
              : 'No requests match the current filters.'}
          </span>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-surface" data-testid="request-list">
          <ShowAll limit={REQUESTS_ROW_LIMIT} as="ul" data-testid="request-list-rows">
            {visible.map((r) => {
              const SourceIcon = SOURCE_ICONS[r.source] ?? Inbox;
              const owner = agentDisplayName(r.ownerAgent, names);
              const meta = [
                r.category ? r.category.replace(/_/g, ' ') : null,
                owner ? `via ${owner}` : null,
                r.priority === 'high' || r.priority === 'critical' ? 'Urgent' : null,
                r.workItemCount > 0 ? `${r.workItemCount} run${r.workItemCount === 1 ? '' : 's'}` : null,
                r.missionLink ? r.missionLink.replace(/^Mission:/, 'Goal:') : null,
                formatRequestTime(r.updatedAt),
              ].filter(Boolean);
              const open = r.openItemCount ?? 0;
              return (
                <li key={r.id} className="list-none border-b border-border-soft last:border-b-0" data-testid={`request-row-${r.id}`}>
                  <CompactRow
                    leading={
                      <span title={getSourceLabel(r.source)}>
                        <SourceIcon className="h-4 w-4 text-text-3" aria-label={getSourceLabel(r.source)} />
                      </span>
                    }
                    primary={<span title={r.title}>{displayTitle(r.title)}</span>}
                    meta={
                      <>
                        {open > 0 && (
                          <span className="font-semibold text-attention" title="Promises or questions the agent still owes you">
                            {open} open item{open === 1 ? '' : 's'}
                            {meta.length > 0 ? ' · ' : ''}
                          </span>
                        )}
                        {meta.join(' · ')}
                      </>
                    }
                    trailing={
                      <StatusLabel tone={STATUS_TONE[r.status]} title={getRequestStatusLabel(r.status)}>
                        {STATUS_WORD[r.status]}
                      </StatusLabel>
                    }
                    onClick={() => navigate(LINKS.request(r.id))}
                    className="border-b-0"
                    data-testid={`request-row-${r.id}-row`}
                  />
                </li>
              );
            })}
          </ShowAll>
        </div>
      )}

      {!loading && !error && requests.length > 0 && (
        <p className="text-[13px] text-text-3" data-testid="requests-total">
          {stats.total} request{stats.total === 1 ? '' : 's'} · total cost {formatCost(stats.totalCost)}
        </p>
      )}
    </div>
  );
};

export default RequestsPage;
