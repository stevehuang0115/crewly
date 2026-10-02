/**
 * Request Detail Page — V3
 *
 * Displays the full details of a single Request including header with status,
 * description, stats sidebar, and a WorkItem execution timeline.
 * Mounted at `/tasks/:id` (canonical) and reachable via the
 * `/requests/:id` → `/tasks/:id` backward-compat redirect set up in
 * `App.tsx`. Fetches data from GET /api/requests/:id and
 * GET /api/task-pool/all (filtered).
 *
 * @module pages/RequestDetail
 */

import { LINKS } from '../constants/routes.constants';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Clock, DollarSign, Cpu, FileText, Layers, CheckCircle2 } from 'lucide-react';
import { CollapsibleSection, CompactRow, PageHeader, StatusLabel, statusTone, type StatusTone } from '@crewly/ui';
import { Card } from '@crewly/ui/Card';
import { Button, IconButton } from '@crewly/ui/Button';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { EmptyState } from '@crewly/ui/EmptyState';
import type { WorkItem } from '../components/WorkItemDetail';
import {
  getWorkItemStatusLabel,
  getWorkItemTypeLabel,
  formatRelativeTime,
  formatCost,
  formatTokens,
  buildTimeline,
} from '../components/WorkItemDetail';
import { WorkItemTimeline } from '../components/WorkItemDetail';
import { apiService } from '../services/api.service';
import { OpenItemsCard, type OpenItem } from '../components/RequestTracking/OpenItemsCard';
import { skipOpenItem } from '../services/decisions.service';
import { useTeams } from '../components/Tickets/useTeams';
import { agentDisplayName, type AgentName } from '../components/Tickets/board.utils';

// =============================================================================
// Types (mirrors backend Request shape)
// =============================================================================

/** Backend Request entity shape */
interface RequestData {
  id: string;
  sourceConversationItemId?: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  requiresConfirmation: boolean;
  workItemIds: string[];
  intentLevel?: string;
  intentCategory?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  /** Promises / questions in the agent's replies (specs/2026-10-01-reply-open-items.md) */
  openItems?: OpenItem[];
  /** Ticket number when the request is a ticket (`TKT-n`) */
  ticketNumber?: number;
}

// =============================================================================
// Helpers
// =============================================================================

/** Status color mapping for the progress rail */
const STATUS_COLORS: Record<string, string> = {
  open: 'text-primary-text',
  in_progress: 'text-primary-text',
  blocked: 'text-danger',
  waiting_confirmation: 'text-attention',
  awaiting_followup: 'text-attention',
  done: 'text-success',
  cancelled: 'text-text-2',
};

/**
 * Returns a human-readable label for a backend request status.
 *
 * @param status - Backend status string
 * @returns Display label
 */
function getRequestStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    open: 'Open',
    in_progress: 'In Progress',
    blocked: 'Blocked',
    waiting_confirmation: 'Waiting Confirmation',
    awaiting_followup: 'Awaiting Follow-up',
    done: 'Completed',
    cancelled: 'Cancelled',
  };
  return labels[status] ?? status;
}

// =============================================================================
// Progress Rail
// =============================================================================

/** Lifecycle steps for the progress rail */
const LIFECYCLE_STEPS = ['open', 'in_progress', 'done'] as const;

/**
 * Renders the request lifecycle progress rail.
 *
 * @param props.currentStatus - The current request status
 * @returns Progress rail JSX
 */
const ProgressRail: React.FC<{ currentStatus: string }> = ({ currentStatus }) => {
  const currentIndex = LIFECYCLE_STEPS.indexOf(currentStatus as typeof LIFECYCLE_STEPS[number]);
  const offPath = currentStatus === 'cancelled' || currentStatus === 'blocked';

  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-[13px]" aria-label="Progress" data-testid="request-progress-rail">
      {LIFECYCLE_STEPS.map((step, index) => {
        const isCurrent = step === currentStatus;
        const isCompleted = currentIndex >= 0 && index <= currentIndex;
        return (
          <React.Fragment key={step}>
            {index > 0 && <li aria-hidden="true" className={`h-px w-6 ${isCompleted ? 'bg-success' : 'bg-border'}`} />}
            <li
              aria-current={isCurrent ? 'step' : undefined}
              className={`inline-flex items-center gap-1 ${
                isCurrent ? `font-semibold ${STATUS_COLORS[step] ?? 'text-text'}` : isCompleted ? 'text-success' : 'text-text-3'
              }`}
            >
              {isCompleted && !isCurrent && <CheckCircle2 className="h-3 w-3" aria-hidden="true" />}
              {getRequestStatusLabel(step)}
            </li>
          </React.Fragment>
        );
      })}
      {offPath && (
        <>
          <li aria-hidden="true" className="h-px w-6 bg-border" />
          <li aria-current="step" className={`font-semibold ${STATUS_COLORS[currentStatus] ?? 'text-text-2'}`}>
            {getRequestStatusLabel(currentStatus)}
          </li>
        </>
      )}
    </ol>
  );
};

// =============================================================================
// WorkItem List for a Request
// =============================================================================

/**
 * Renders the WorkItem execution list for a request.
 * Each item is clickable and shows status, type, target, and timeline.
 *
 * @param props.workItems - WorkItems associated with this request
 * @param props.onItemClick - Callback when a work item is clicked
 * @returns WorkItem list JSX
 */
const RequestWorkItems: React.FC<{
  workItems: WorkItem[];
  onItemClick: (id: string) => void;
  names: Map<string, AgentName>;
}> = ({ workItems, onItemClick, names }) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (workItems.length === 0) {
    return (
      <p className="py-6 text-[13px] text-text-3" data-testid="request-workitems-empty">
        No runs for this request yet.
      </p>
    );
  }

  return (
    <ul className="overflow-hidden rounded-2xl bg-surface" data-testid="request-workitems-list">
      {workItems.map((wi) => {
        const isExpanded = expandedId === wi.id;
        const agent = agentDisplayName(wi.target, names, true);
        return (
          <li key={wi.id} className="list-none border-b border-border-soft last:border-b-0" data-testid={`request-workitem-${wi.id}`}>
            <CompactRow
              className="border-b-0"
              primary={wi.title}
              meta={[getWorkItemTypeLabel(wi.type), agent, formatRelativeTime(wi.createdAt)].filter(Boolean).join(' · ')}
              trailing={
                <StatusLabel tone={wi.status === 'cancelled' || wi.status === 'queued' || wi.status === 'scheduled' ? 'neutral' : statusTone(wi.status)}>
                  {getWorkItemStatusLabel(wi.status)}
                </StatusLabel>
              }
              onClick={() => setExpandedId(isExpanded ? null : wi.id)}
              actions={[
                <Button
                  key="details"
                  variant="link"
                  size="xs"
                  onClick={() => onItemClick(wi.id)}
                  data-testid={`request-workitem-detail-link-${wi.id}`}
                >
                  Details
                </Button>,
              ]}
              data-testid={`request-workitem-row-${wi.id}`}
            />
            {isExpanded && (
              <div className="border-t border-border-soft px-4 py-3" data-testid={`request-workitem-timeline-${wi.id}`}>
                <WorkItemTimeline events={buildTimeline(wi)} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
};

// =============================================================================
// Main Component
// =============================================================================

/**
 * Request Detail page — shows full request information with execution timeline.
 *
 * Features:
 * - Header with title, status badge, priority, category
 * - Progress rail showing lifecycle stage
 * - Left panel: description, source conversation ref
 * - Right panel: stats (tokens, cost, timing)
 * - WorkItem execution timeline with expandable sub-timelines
 *
 * @returns RequestDetail page JSX element
 */
export const RequestDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { names } = useTeams();

  const [request, setRequest] = useState<RequestData | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  /**
   * Loads the request and associated work items from the API.
   *
   * @param showSpinner - Whether to show the full loading spinner
   */
  const loadData = useCallback(async (showSpinner = true) => {
    if (!id) return;

    if (showSpinner) setLoading(true);
    else setRefreshing(true);

    setError(null);

    try {
      const [requestData, workItemsData] = await Promise.all([
        apiService.getRequest(id),
        apiService.getWorkItemsByRequest(id),
      ]);
      setRequest(requestData as RequestData);
      setWorkItems(
        (workItemsData as WorkItem[]).sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load request';
      setError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    loadData(true);
  }, [loadData]);

  // Auto-refresh for active requests (every 15s)
  useEffect(() => {
    if (!request || request.status === 'done' || request.status === 'cancelled') return;

    const interval = setInterval(() => {
      loadData(false);
    }, 15_000);

    return () => clearInterval(interval);
  }, [request?.status, loadData]);

  /** Navigate back to the canonical V3 Request list at `/tasks`. */
  const handleBack = useCallback(() => {
    navigate(LINKS.requests());
  }, [navigate]);

  /** Navigate to a specific WorkItem detail */
  const handleWorkItemClick = useCallback((workItemId: string) => {
    navigate(LINKS.run(workItemId));
  }, [navigate]);

  /** Manual refresh */
  const handleRefresh = useCallback(() => {
    loadData(false);
  }, [loadData]);

  /**
   * Handles confirm/reject actions for requests requiring confirmation.
   *
   * @param action - 'confirmed' to approve or 'rejected' to reject
   */
  const handleConfirmAction = useCallback(async (action: 'confirmed' | 'rejected') => {
    if (!id) return;
    try {
      const newStatus = action === 'confirmed' ? 'done' : 'cancelled';
      await apiService.updateRequest(id, { status: newStatus });
      loadData(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update request';
      setError(message);
    }
  }, [id, loadData]);

  /** Computed total tokens */
  const totalTokens = useMemo(() => {
    if (!request) return 0;
    return request.totalInputTokens + request.totalOutputTokens;
  }, [request]);

  /** Compute elapsed time */
  const elapsedTime = useMemo(() => {
    if (!request) return '';
    const start = new Date(request.createdAt).getTime();
    const end = request.completedAt ? new Date(request.completedAt).getTime() : Date.now();
    const diffMs = end - start;
    const diffMin = Math.floor(diffMs / 60_000);
    const diffHr = Math.floor(diffMin / 60);
    if (diffMin < 1) return '< 1m';
    if (diffHr < 1) return `${diffMin}m`;
    return `${diffHr}h ${diffMin % 60}m`;
  }, [request]);

  // ---------------------------------------------------------------------------
  // Render: Loading
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="request-detail-loading">
        <LoadingSpinner />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Error
  // ---------------------------------------------------------------------------

  if (error) {
    return (
      <div className="p-6" data-testid="request-detail-error">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={handleBack} className="mb-6">
          Back to Requests
        </Button>
        <Card variant="default" padding="lg">
          <div className="flex flex-col items-center text-center py-8">
            <p className="text-danger text-lg font-medium mb-2">Failed to load Request</p>
            <p className="text-text-2 text-sm mb-4">{error}</p>
            <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => loadData(true)}>
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

  if (!request) {
    return (
      <div className="p-6" data-testid="request-detail-not-found">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={handleBack} className="mb-6">
          Back to Requests
        </Button>
        <Card variant="default" padding="lg">
          <EmptyState icon={FileText} title="Request not found." compact />
        </Card>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Detail View
  // ---------------------------------------------------------------------------

  const subtitle = [
    `Created ${formatRelativeTime(request.createdAt)}`,
    request.intentCategory ? request.intentCategory.replace(/_/g, ' ') : null,
    request.intentLevel ? `Intent level ${request.intentLevel}` : null,
    request.priority && request.priority !== 'normal' ? `${request.priority.charAt(0).toUpperCase()}${request.priority.slice(1)} priority` : null,
  ].filter(Boolean);

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-6" data-testid="request-detail">
      <PageHeader
        className="mb-0"
        eyebrow={
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
            <Link to={LINKS.ticketsBoard()} className="text-text-2 hover:text-text">Tickets</Link>
            <span className="text-text-3">/</span>
            <Link to={LINKS.requests()} className="text-text-2 hover:text-text" data-testid="request-detail-back">Requests</Link>
          </nav>
        }
        title={request.title}
        subtitle={
          <>
            {subtitle.map((part, i) => (
              <React.Fragment key={i}>
                {i > 0 && ' · '}
                {part}
              </React.Fragment>
            ))}
          </>
        }
        actions={
          <IconButton
            icon={RefreshCw}
            variant="ghost"
            aria-label="Refresh"
            onClick={handleRefresh}
            loading={refreshing}
            data-testid="request-detail-refresh"
          />
        }
        data-testid="request-detail-header"
      />

      <div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-text-2">
        <StatusLabel tone={requestTone(request.status)}>{getRequestStatusLabel(request.status)}</StatusLabel>
        {request.requiresConfirmation && <span className="font-semibold text-attention">Requires confirmation</span>}
        {typeof request.ticketNumber === 'number' && <span>TKT-{String(request.ticketNumber).padStart(3, '0')}</span>}
        <ProgressRail currentStatus={request.status} />
      </div>

      {/* Approval / Rejection — only for requests awaiting confirmation */}
      {request.requiresConfirmation && request.status === 'waiting_confirmation' && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-attention-soft px-4 py-3" data-testid="request-action-area">
          <span className="mr-auto text-sm text-text">This request needs your confirmation before it completes</span>
          <Button variant="secondary" size="sm" onClick={() => handleConfirmAction('rejected')}>
            Reject
          </Button>
          <Button variant="primary" size="sm" onClick={() => handleConfirmAction('confirmed')}>
            Approve
          </Button>
        </div>
      )}

      {/* What the agent still owes: promises and questions from its replies */}
      {request.openItems && request.openItems.length > 0 && (
        <OpenItemsCard
          items={request.openItems}
          onSkip={async (itemId) => {
            await skipOpenItem(request.id, itemId);
            await loadData(false);
          }}
        />
      )}

      <section aria-labelledby="request-message-heading">
        <h2 id="request-message-heading" className="mb-2 text-[15px] font-bold text-text">
          Original message
        </h2>
        {request.description ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-text">{request.description}</p>
        ) : (
          <p className="text-sm italic text-text-3">No description provided.</p>
        )}
        {(request.sourceConversationItemId || request.tags.length > 0) && (
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text-3">
            {request.sourceConversationItemId && (
              <span>
                Source: <span className="font-mono">{request.sourceConversationItemId}</span>
              </span>
            )}
            {request.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-surface-2 px-2 py-0.5 text-text-2">
                {tag}
              </span>
            ))}
          </p>
        )}
      </section>

      <section data-testid="request-detail-workitems" aria-labelledby="request-runs-heading">
        <h2 id="request-runs-heading" className="mb-2 text-[15px] font-bold text-text">
          Runs <span className="text-[13px] font-normal text-text-2">{workItems.length}</span>
        </h2>
        <RequestWorkItems workItems={workItems} onItemClick={handleWorkItemClick} names={names} />
      </section>

      <CollapsibleSection title="Statistics" summary="Tokens, cost, elapsed time, runs">
        <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm" data-testid="request-detail-stats">
          <dt className="flex items-center gap-1.5 text-text-2"><Cpu className="h-3.5 w-3.5" aria-hidden="true" />Total tokens</dt>
          <dd className="text-right font-semibold text-text">{formatTokens(totalTokens)}</dd>
          <dt className="pl-5 text-text-3">Input</dt>
          <dd className="text-right text-text-2">{formatTokens(request.totalInputTokens)}</dd>
          <dt className="pl-5 text-text-3">Output</dt>
          <dd className="text-right text-text-2">{formatTokens(request.totalOutputTokens)}</dd>
          <dt className="flex items-center gap-1.5 text-text-2"><DollarSign className="h-3.5 w-3.5" aria-hidden="true" />Total cost</dt>
          <dd className="text-right font-semibold text-text">{formatCost(request.totalCost)}</dd>
          <dt className="flex items-center gap-1.5 text-text-2"><Clock className="h-3.5 w-3.5" aria-hidden="true" />Elapsed time</dt>
          <dd className="text-right font-semibold text-text">{elapsedTime}</dd>
          <dt className="flex items-center gap-1.5 text-text-2"><Layers className="h-3.5 w-3.5" aria-hidden="true" />Runs</dt>
          <dd className="text-right font-semibold text-text">{workItems.length}</dd>
        </dl>
      </CollapsibleSection>
    </div>
  );
};

/**
 * Status colour of a request.
 *
 * @param status - Backend status
 * @returns Tone
 */
function requestTone(status: string): StatusTone {
  if (status === 'open' || status === 'in_progress' || status === 'awaiting_followup') return 'primary';
  if (status === 'cancelled') return 'neutral';
  return statusTone(status);
}

RequestDetail.displayName = 'RequestDetail';

export default RequestDetail;
