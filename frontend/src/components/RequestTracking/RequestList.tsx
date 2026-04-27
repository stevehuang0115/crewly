/**
 * Request List Component
 *
 * Fetches and renders the list of requests from the V3 Request API.
 * Maps backend Request entities to the frontend RequestItem type.
 *
 * @module components/RequestTracking/RequestList
 */

import React, { useMemo, useEffect, useState, useCallback } from 'react';
import { Inbox } from 'lucide-react';
import type {
  RequestItem,
  RequestPrimaryFilter,
  RequestSecondaryFilter,
  RequestStatistics,
  RequestStatus,
  RequestPriority,
} from './request-tracking.types';
import { computeRequestStats } from './request-tracking.types';
import { RequestRow } from './RequestRow';
import { SkeletonRows } from '../UI/SkeletonRows';
import { apiService } from '../../services/api.service';

// =============================================================================
// Props
// =============================================================================

interface RequestListProps {
  /** Active primary status filter */
  activeFilter: RequestPrimaryFilter;
  /** Active secondary filters (toggle set) */
  secondaryFilters?: Set<RequestSecondaryFilter>;
  /** Current search query string */
  searchQuery: string;
  /** Callback to report computed stats to parent */
  onStatsLoaded: (stats: RequestStatistics) => void;
}

// =============================================================================
// Mapping helpers
// =============================================================================

/**
 * Maps a backend Request status to the frontend RequestStatus.
 *
 * @param backendStatus - Status string from the API
 * @returns Mapped RequestStatus
 */
function mapRequestStatus(backendStatus: string): RequestStatus {
  switch (backendStatus) {
    case 'open':
    case 'in_progress':
      return 'active';
    case 'blocked':
      return 'blocked';
    case 'waiting_confirmation':
      return 'waiting_confirmation';
    case 'done':
    case 'cancelled':
      return 'done';
    default:
      return 'active';
  }
}

/**
 * Maps a backend Request priority to the frontend RequestPriority.
 *
 * @param backendPriority - Priority string from the API
 * @returns Mapped RequestPriority
 */
function mapRequestPriority(backendPriority: string): RequestPriority {
  switch (backendPriority) {
    case 'high':
      return 'high';
    case 'low':
      return 'low';
    default:
      return 'medium';
  }
}

/**
 * Converts raw API response objects into typed RequestItem objects.
 *
 * @param rawRequests - Raw request objects from the API
 * @returns Array of RequestItem objects sorted newest first
 */
function apiToRequestItems(rawRequests: Record<string, unknown>[]): RequestItem[] {
  return rawRequests
    .map((r): RequestItem => {
      const workItemIds = Array.isArray(r.workItemIds) ? (r.workItemIds as string[]) : [];
      const rawCategory = r.intentCategory as string | undefined;
      return {
        id: (r.id as string) || '',
        title: (r.title as string) || 'Untitled Request',
        status: mapRequestStatus((r.status as string) || ''),
        priority: mapRequestPriority((r.priority as string) || ''),
        source: ((r.tags as string[]) || []).includes('slack') ? 'slack' : 'api',
        requester: 'user',
        category: rawCategory && rawCategory.length > 0 ? rawCategory : undefined,
        workItemCount: workItemIds.length,
        updatedAt: (r.updatedAt as string) || (r.createdAt as string) || new Date().toISOString(),
        missionLink: r.missionId ? `Mission: ${(r.missionId as string).slice(0, 8)}` : undefined,
        totalInputTokens: (r.totalInputTokens as number) || 0,
        totalOutputTokens: (r.totalOutputTokens as number) || 0,
        totalCost: (r.totalCost as number) || 0,
        ownerAgent: (r.ownerAgent as string) || undefined,
      };
    })
    .sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the filtered and searched list of request rows.
 * Fetches real data from GET /api/requests.
 *
 * @param props - Filter state and stats callback
 * @returns Request list JSX element
 */
/** Priority values considered "urgent" for the secondary filter */
const URGENT_PRIORITIES: Set<RequestPriority> = new Set(['critical', 'high']);

export const RequestList: React.FC<RequestListProps> = ({
  activeFilter,
  secondaryFilters,
  searchQuery,
  onStatsLoaded,
}) => {
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Fetch requests from the V3 Request API */
  const loadRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rawRequests = await apiService.getRequests();
      if (!Array.isArray(rawRequests)) {
        console.warn('[RequestList] getRequests returned non-array:', typeof rawRequests, rawRequests);
        setRequests([]);
        return;
      }
      const converted = apiToRequestItems(rawRequests as Record<string, unknown>[]);
      setRequests(converted);
    } catch (err) {
      console.warn('[RequestList] loadRequests error:', err);
      setError(err instanceof Error ? err.message : 'Failed to load requests');
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  // Compute stats from all requests
  const stats = useMemo(() => computeRequestStats(requests), [requests]);

  // Report stats to parent
  useEffect(() => {
    onStatsLoaded(stats);
  }, [stats, onStatsLoaded]);

  // Apply filters
  const filtered = useMemo(() => {
    let result = requests;

    // Status filter
    if (activeFilter !== 'all') {
      result = result.filter((r) => r.status === activeFilter);
    }

    // Secondary filters (additive — each enabled filter narrows results)
    if (secondaryFilters && secondaryFilters.size > 0) {
      if (secondaryFilters.has('urgent')) {
        result = result.filter((r) => URGENT_PRIORITIES.has(r.priority));
      }
      if (secondaryFilters.has('assigned_to_me')) {
        result = result.filter((r) => r.requester === 'user');
      }
    }

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.requester.toLowerCase().includes(q) ||
          r.missionLink?.toLowerCase().includes(q)
      );
    }

    return result;
  }, [requests, activeFilter, secondaryFilters, searchQuery]);

  if (loading) {
    return (
      <div data-testid="request-list-loading">
        <SkeletonRows count={4} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-text-secondary-dark" data-testid="request-list-error">
        <span className="text-sm text-red-400">{error}</span>
        <button
          onClick={loadRequests}
          className="text-sm text-primary hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-text-secondary-dark" data-testid="request-list-empty">
        <Inbox className="h-10 w-10 opacity-40" />
        <span className="text-sm">
          {requests.length === 0
            ? 'No requests found. Requests will appear here when user messages are processed.'
            : 'No requests match the current filters.'}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="request-list">
      {filtered.map((request) => (
        <RequestRow key={request.id} request={request} />
      ))}
    </div>
  );
};
