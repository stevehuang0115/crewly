/**
 * WorkItem Detail Page — V3
 *
 * Displays the full details of a single WorkItem including status,
 * activity timeline, metrics sidebar, and linked references.
 * Fetches real data from GET /api/task-pool/:id.
 *
 * @module pages/WorkItemDetail
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { Card } from '../components/UI/Card';
import { Badge } from '../components/UI/Badge';
import { StatusBadge } from '../components/UI/StatusBadge';
import { LoadingSpinner } from '../components/UI/LoadingSpinner';
import {
  WorkItemTimeline,
  WorkItemMetrics,
  getWorkItemStatusType,
  getWorkItemStatusLabel,
  getWorkItemTypeBadgeVariant,
  getWorkItemTypeLabel,
  formatRelativeTime,
  buildTimeline,
} from '../components/WorkItemDetail';
import type { WorkItem } from '../components/WorkItemDetail';
import { apiService } from '../services/api.service';

// =============================================================================
// Component
// =============================================================================

/**
 * WorkItem Detail page — execution-level view of a single WorkItem.
 *
 * Features:
 * - Header with status, type, and metadata badges
 * - Activity timeline (vertical, chronological)
 * - Metrics sidebar (tokens, cost, retries, links)
 * - Auto-refresh for running items
 *
 * @returns WorkItemDetail page JSX element
 */
export const WorkItemDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [item, setItem] = useState<WorkItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  /**
   * Fetches the WorkItem from the backend API.
   */
  const loadWorkItem = useCallback(async (showLoadingSpinner = true) => {
    if (!id) return;

    if (showLoadingSpinner) setLoading(true);
    else setRefreshing(true);

    setError(null);

    try {
      const data = await apiService.getWorkItem(id);
      setItem(data as WorkItem);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load WorkItem';
      setError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  // Initial load
  useEffect(() => {
    loadWorkItem(true);
  }, [loadWorkItem]);

  // Auto-refresh for running items (every 10s)
  useEffect(() => {
    if (!item || item.status !== 'running') return;

    const interval = setInterval(() => {
      loadWorkItem(false);
    }, 10_000);

    return () => clearInterval(interval);
  }, [item?.status, loadWorkItem]);

  /** Navigate back to the task pool / workitems list */
  const handleBack = () => {
    navigate('/workitems');
  };

  /** Manual refresh */
  const handleRefresh = () => {
    loadWorkItem(false);
  };

  // ---------------------------------------------------------------------------
  // Render: Loading
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="workitem-detail-loading">
        <LoadingSpinner />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Error
  // ---------------------------------------------------------------------------

  if (error) {
    return (
      <div className="p-6" data-testid="workitem-detail-error">
        <button
          onClick={handleBack}
          className="flex items-center gap-2 text-sm text-text-secondary-dark hover:text-text-primary-dark mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to WorkItems
        </button>
        <Card variant="default" padding="lg">
          <div className="text-center py-8">
            <p className="text-red-400 text-lg font-medium mb-2">Failed to load WorkItem</p>
            <p className="text-text-secondary-dark text-sm mb-4">{error}</p>
            <button
              onClick={() => loadWorkItem(true)}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            >
              Retry
            </button>
          </div>
        </Card>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Not Found
  // ---------------------------------------------------------------------------

  if (!item) {
    return (
      <div className="p-6" data-testid="workitem-detail-not-found">
        <button
          onClick={handleBack}
          className="flex items-center gap-2 text-sm text-text-secondary-dark hover:text-text-primary-dark mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to WorkItems
        </button>
        <Card variant="default" padding="lg">
          <p className="text-center text-text-secondary-dark py-8">
            WorkItem not found.
          </p>
        </Card>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Build timeline events
  // ---------------------------------------------------------------------------

  const timelineEvents = buildTimeline(item);

  // ---------------------------------------------------------------------------
  // Render: Detail View
  // ---------------------------------------------------------------------------

  return (
    <div className="p-6 max-w-[1400px] mx-auto" data-testid="workitem-detail">
      {/* Back button */}
      <button
        onClick={handleBack}
        className="flex items-center gap-2 text-sm text-text-secondary-dark hover:text-text-primary-dark mb-4 transition-colors"
        data-testid="workitem-detail-back"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to WorkItems
      </button>

      {/* Header */}
      <div className="mb-6" data-testid="workitem-detail-header">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-text-primary-dark truncate">
              WorkItem: {truncateId(item.id)} — {item.title}
            </h1>
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary-dark hover:text-text-primary-dark bg-surface-dark border border-border-dark rounded-lg transition-colors disabled:opacity-50"
            data-testid="workitem-detail-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Status & metadata badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={getWorkItemStatusType(item.status)}>
            {getWorkItemStatusLabel(item.status)}
          </StatusBadge>
          <Badge variant={getWorkItemTypeBadgeVariant(item.type)}>
            {getWorkItemTypeLabel(item.type)}
          </Badge>
          <Badge variant="default">
            Retry {item.retryCount}/{item.maxRetries}
          </Badge>
          {item.requestId && (
            <Badge variant="info">
              <span className="flex items-center gap-1">
                <ExternalLink className="h-3 w-3" />
                Request: {truncateId(item.requestId)}
              </span>
            </Badge>
          )}
          {item.missionId && (
            <Badge variant="info">
              <span className="flex items-center gap-1">
                <ExternalLink className="h-3 w-3" />
                Mission: {truncateId(item.missionId)}
              </span>
            </Badge>
          )}
          <span className="text-xs text-text-secondary-dark ml-2">
            Created {formatRelativeTime(item.createdAt)}
          </span>
          {item.target && (
            <Badge variant="primary">
              Agent: {item.target}
            </Badge>
          )}
        </div>

        {/* Description */}
        {item.description && (
          <p className="mt-3 text-sm text-text-secondary-dark leading-relaxed">
            {item.description}
          </p>
        )}
      </div>

      {/* Main content: Timeline + Metrics sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Timeline (2/3 width on large screens) */}
        <div className="lg:col-span-2">
          <Card variant="default" padding="md">
            <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wider mb-4">
              Activity Timeline
            </h2>
            <WorkItemTimeline events={timelineEvents} />
          </Card>
        </div>

        {/* Metrics sidebar (1/3 width on large screens) */}
        <div className="lg:col-span-1">
          <WorkItemMetrics item={item} />
        </div>
      </div>
    </div>
  );
};

WorkItemDetail.displayName = 'WorkItemDetail';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Truncates a UUID for the page title.
 *
 * @param id - The full ID string
 * @returns Truncated string (e.g., "abc12345")
 */
function truncateId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(0, 8);
}

export default WorkItemDetail;
