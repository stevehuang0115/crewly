/**
 * WorkItem Detail Page — V3
 *
 * Displays the full details of a single WorkItem including status,
 * activity timeline, metrics sidebar, and linked references.
 * Fetches real data from GET /api/task-pool/:id.
 *
 * @module pages/WorkItemDetail
 */

import { LINKS } from '../constants/routes.constants';
import React, { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, FileQuestion } from 'lucide-react';
import { CollapsibleSection, PageHeader, StatusLabel, statusTone, type StatusTone } from '@crewly/ui';
import { Card } from '@crewly/ui/Card';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { Button, IconButton } from '@crewly/ui/Button';
import { EmptyState } from '@crewly/ui/EmptyState';
import {
  WorkItemTimeline,
  WorkItemMetrics,
  getWorkItemOwnerLabel,
  getWorkItemStatusLabel,
  getWorkItemTypeLabel,
  formatRelativeTime,
  buildTimeline,
} from '../components/WorkItemDetail';
import { useTeams } from '../components/Tickets/useTeams';
import { agentDisplayName, runTicketRef } from '../components/Tickets/board.utils';
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
  const { names } = useTeams();

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
      const message = err instanceof Error ? err.message : 'Failed to load run';
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
    navigate(LINKS.runs());
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
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={handleBack} className="mb-6">
          Back to Runs
        </Button>
        <Card variant="default" padding="lg">
          <div className="flex flex-col items-center text-center py-8">
            <p className="text-danger text-lg font-medium mb-2">Failed to load WorkItem</p>
            <p className="text-text-2 text-sm mb-4">{error}</p>
            <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => loadWorkItem(true)}>
              Retry
            </Button>
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
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={handleBack} className="mb-6">
          Back to Runs
        </Button>
        <Card variant="default" padding="lg">
          <EmptyState icon={FileQuestion} title="WorkItem not found." compact />
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

  const agent = agentDisplayName(item.target, names, true);
  const ticketRef = runTicketRef(item.title);

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-6" data-testid="workitem-detail">
      <PageHeader
        className="mb-0"
        eyebrow={
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
            <Link to={LINKS.ticketsBoard()} className="text-text-2 hover:text-text">Tickets</Link>
            <span className="text-text-3">/</span>
            <Link to={LINKS.runs()} className="text-text-2 hover:text-text" data-testid="workitem-detail-back">Runs</Link>
          </nav>
        }
        title={item.title}
        subtitle={
          <>
            {agent ? `${getWorkItemOwnerLabel(item.owner)} · ${agent}` : getWorkItemOwnerLabel(item.owner)}
            {` · created ${formatRelativeTime(item.createdAt)} · `}
            <span className="font-mono text-text-3" title={item.id}>run {truncateId(item.id)}</span>
          </>
        }
        actions={
          <IconButton
            icon={RefreshCw}
            variant="ghost"
            aria-label="Refresh"
            onClick={handleRefresh}
            loading={refreshing}
            data-testid="workitem-detail-refresh"
          />
        }
        data-testid="workitem-detail-header"
      />

      <div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-text-2">
        <StatusLabel tone={runTone(item.status)}>{getWorkItemStatusLabel(item.status)}</StatusLabel>
        <span>{getWorkItemTypeLabel(item.type)}</span>
        <span>Retry {item.retryCount}/{item.maxRetries}</span>
        {ticketRef && <span>{ticketRef}</span>}
        {item.requestId && (
          <Link to={LINKS.request(item.requestId)} className="font-semibold text-primary-text hover:underline">
            Request {truncateId(item.requestId)}
          </Link>
        )}
        {item.missionId && (
          <Link to={LINKS.goal(item.missionId)} className="font-semibold text-primary-text hover:underline">
            Goal {truncateId(item.missionId)}
          </Link>
        )}
      </div>

      {item.description && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-2">{item.description}</p>
      )}

      <section aria-labelledby="workitem-timeline-heading" className="rounded-2xl bg-surface p-4">
        <h2 id="workitem-timeline-heading" className="mb-4 text-[15px] font-bold text-text">
          Activity timeline
        </h2>
        <WorkItemTimeline events={timelineEvents} />
      </section>

      <CollapsibleSection title="Details" summary="Tokens, cost, retries, duration, links and timestamps">
        <WorkItemMetrics item={item} />
      </CollapsibleSection>
    </div>
  );
};

/**
 * Status colour of a run.
 *
 * @param status - Run status
 * @returns Tone
 */
function runTone(status: string): StatusTone {
  return status === 'cancelled' || status === 'queued' || status === 'scheduled' ? 'neutral' : statusTone(status);
}

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
