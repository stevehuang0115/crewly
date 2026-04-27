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

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  RefreshCw,
  Inbox,
  Clock,
  DollarSign,
  Cpu,
  Tag,
  FileText,
  Layers,
  CheckCircle2,
} from 'lucide-react';
import { Card } from '../components/UI/Card';
import { Button } from '../components/UI/Button';
import { Badge } from '../components/UI/Badge';
import { StatusBadge } from '../components/UI/StatusBadge';
import { LoadingSpinner } from '../components/UI/LoadingSpinner';
import type { WorkItem } from '../components/WorkItemDetail';
import {
  getWorkItemStatusType,
  getWorkItemStatusLabel,
  getWorkItemTypeBadgeVariant,
  getWorkItemTypeLabel,
  formatRelativeTime,
  formatCost,
  formatTokens,
  buildTimeline,
} from '../components/WorkItemDetail';
import { WorkItemTimeline } from '../components/WorkItemDetail';
import { apiService } from '../services/api.service';

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
}

// =============================================================================
// Helpers
// =============================================================================

/** Status color mapping for the progress rail */
const STATUS_COLORS: Record<string, string> = {
  open: 'text-blue-400',
  in_progress: 'text-amber-400',
  blocked: 'text-red-400',
  waiting_confirmation: 'text-violet-400',
  done: 'text-green-400',
  cancelled: 'text-gray-400',
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
    done: 'Completed',
    cancelled: 'Cancelled',
  };
  return labels[status] ?? status;
}

/**
 * Maps backend request status to StatusBadge type.
 *
 * @param status - Backend status string
 * @returns StatusType
 */
function getRequestStatusBadgeType(status: string): 'active' | 'running' | 'blocked' | 'paused' | 'completed' | 'inactive' | 'pending' {
  const mapping: Record<string, 'active' | 'running' | 'blocked' | 'paused' | 'completed' | 'inactive' | 'pending'> = {
    open: 'active',
    in_progress: 'running',
    blocked: 'blocked',
    waiting_confirmation: 'paused',
    done: 'completed',
    cancelled: 'inactive',
  };
  return mapping[status] ?? 'pending';
}

/**
 * Truncates a UUID to first 8 characters for display.
 *
 * @param id - UUID string
 * @returns Truncated ID
 */
function truncateId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
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
  const isCancelled = currentStatus === 'cancelled';
  const isBlocked = currentStatus === 'blocked';

  return (
    <div className="flex items-center gap-1" data-testid="request-progress-rail">
      {LIFECYCLE_STEPS.map((step, index) => {
        const isCompleted = currentIndex >= 0 && index <= currentIndex;
        const isCurrent = step === currentStatus;

        return (
          <React.Fragment key={step}>
            {index > 0 && (
              <div
                className={`flex-1 h-0.5 ${isCompleted ? 'bg-green-500' : 'bg-border-dark'}`}
              />
            )}
            <div
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium ${
                isCurrent
                  ? `${STATUS_COLORS[step] || 'text-blue-400'} bg-surface-dark border border-primary/30`
                  : isCompleted
                    ? 'text-green-400 bg-green-500/10'
                    : 'text-text-secondary-dark bg-surface-dark'
              }`}
            >
              {isCompleted && !isCurrent && <CheckCircle2 className="h-3 w-3" />}
              {getRequestStatusLabel(step)}
            </div>
          </React.Fragment>
        );
      })}
      {(isCancelled || isBlocked) && (
        <>
          <div className="flex-1 h-0.5 bg-border-dark" />
          <div
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium ${
              STATUS_COLORS[currentStatus] || 'text-gray-400'
            } bg-surface-dark border border-red-500/30`}
          >
            {getRequestStatusLabel(currentStatus)}
          </div>
        </>
      )}
    </div>
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
}> = ({ workItems, onItemClick }) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (workItems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-text-secondary-dark" data-testid="request-workitems-empty">
        <Inbox className="h-8 w-8 opacity-40" />
        <span className="text-sm">No work items associated with this request yet.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="request-workitems-list">
      {workItems.map((wi) => {
        const isExpanded = expandedId === wi.id;
        const timelineEvents = isExpanded ? buildTimeline(wi) : [];

        return (
          <Card
            key={wi.id}
            variant="default"
            padding="none"
            className="overflow-hidden hover:border-primary/40 transition-colors"
            data-testid={`request-workitem-${wi.id}`}
          >
            {/* WorkItem row header */}
            <div
              className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-background-dark/30 transition-colors"
              role="button"
              tabIndex={0}
              onClick={() => setExpandedId(isExpanded ? null : wi.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setExpandedId(isExpanded ? null : wi.id);
                }
              }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-text-primary-dark truncate">
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
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onItemClick(wi.id);
                }}
                className="px-2 py-1 text-xs text-primary hover:text-primary/80 hover:underline flex-shrink-0"
                data-testid={`request-workitem-detail-link-${wi.id}`}
              >
                Details
              </button>
            </div>

            {/* Expanded timeline */}
            {isExpanded && (
              <div className="border-t border-border-dark px-4 py-3" data-testid={`request-workitem-timeline-${wi.id}`}>
                <WorkItemTimeline events={timelineEvents} />
              </div>
            )}
          </Card>
        );
      })}
    </div>
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
    navigate('/tasks');
  }, [navigate]);

  /** Navigate to a specific WorkItem detail */
  const handleWorkItemClick = useCallback((workItemId: string) => {
    navigate(`/workitems/${workItemId}`);
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
        <button
          onClick={handleBack}
          className="flex items-center gap-2 text-sm text-text-secondary-dark hover:text-text-primary-dark mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Requests
        </button>
        <Card variant="default" padding="lg">
          <div className="text-center py-8">
            <p className="text-red-400 text-lg font-medium mb-2">Failed to load Request</p>
            <p className="text-text-secondary-dark text-sm mb-4">{error}</p>
            <button
              onClick={() => loadData(true)}
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

  if (!request) {
    return (
      <div className="p-6" data-testid="request-detail-not-found">
        <button
          onClick={handleBack}
          className="flex items-center gap-2 text-sm text-text-secondary-dark hover:text-text-primary-dark mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Requests
        </button>
        <Card variant="default" padding="lg">
          <p className="text-center text-text-secondary-dark py-8">
            Request not found.
          </p>
        </Card>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Detail View
  // ---------------------------------------------------------------------------

  return (
    <div className="p-6 max-w-[1200px] mx-auto" data-testid="request-detail">
      {/* Back button */}
      <button
        onClick={handleBack}
        className="flex items-center gap-2 text-sm text-text-secondary-dark hover:text-text-primary-dark mb-4 transition-colors"
        data-testid="request-detail-back"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Requests
      </button>

      {/* Header */}
      <div className="mb-6" data-testid="request-detail-header">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-text-primary-dark">
              {request.title}
            </h1>
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary-dark hover:text-text-primary-dark bg-surface-dark border border-border-dark rounded-lg transition-colors disabled:opacity-50"
            data-testid="request-detail-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Status & metadata badges */}
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <StatusBadge status={getRequestStatusBadgeType(request.status)}>
            {getRequestStatusLabel(request.status)}
          </StatusBadge>
          {request.priority && request.priority !== 'normal' && (
            <Badge variant={request.priority === 'high' ? 'warning' : 'default'} size="sm">
              {request.priority.charAt(0).toUpperCase() + request.priority.slice(1)}
            </Badge>
          )}
          {request.intentCategory && (
            <Badge variant="info" size="sm">
              <span className="flex items-center gap-1">
                <Tag className="h-3 w-3" />
                {request.intentCategory.replace(/_/g, ' ')}
              </span>
            </Badge>
          )}
          {request.intentLevel && (
            <Badge variant="default" size="sm">
              {request.intentLevel}
            </Badge>
          )}
          {request.requiresConfirmation && (
            <Badge variant="warning" size="sm">
              Requires Confirmation
            </Badge>
          )}
          <span className="text-xs text-text-secondary-dark ml-2">
            Created {formatRelativeTime(request.createdAt)}
          </span>
        </div>

        {/* Progress rail */}
        <ProgressRail currentStatus={request.status} />
      </div>

        {/* Approval / Rejection action area — only for requests awaiting confirmation */}
        {request.requiresConfirmation && request.status === 'waiting_confirmation' && (
          <div className="flex gap-3 mt-4 p-4 bg-surface-dark rounded-lg border border-border-dark" data-testid="request-action-area">
            <span className="text-sm text-text-secondary-dark mr-auto flex items-center">
              This request requires your confirmation before completing
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleConfirmAction('rejected')}
            >
              Reject
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => handleConfirmAction('confirmed')}
            >
              Approve
            </Button>
          </div>
        )}

      {/* Main content: Description + Stats sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Left panel: Description & Context (2/3 width) */}
        <div className="lg:col-span-2">
          <Card variant="default" padding="md">
            <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wider mb-3">
              <span className="flex items-center gap-1.5">
                <FileText className="h-4 w-4" />
                Original Message
              </span>
            </h2>
            {request.description ? (
              <p className="text-sm text-text-primary-dark leading-relaxed whitespace-pre-wrap">
                {request.description}
              </p>
            ) : (
              <p className="text-sm text-text-secondary-dark italic">No description provided.</p>
            )}

            {request.sourceConversationItemId && (
              <div className="mt-4 pt-4 border-t border-border-dark">
                <span className="text-xs text-text-secondary-dark">
                  Source: <span className="font-mono">{request.sourceConversationItemId}</span>
                </span>
              </div>
            )}

            {request.tags.length > 0 && (
              <div className="mt-4 pt-4 border-t border-border-dark flex items-center gap-2 flex-wrap">
                {request.tags.map((tag) => (
                  <Badge key={tag} variant="default" size="sm">{tag}</Badge>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* Right panel: Stats (1/3 width) */}
        <div className="lg:col-span-1">
          <Card variant="default" padding="md">
            <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wider mb-3">
              Statistics
            </h2>
            <div className="flex flex-col gap-3">
              {/* Tokens */}
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs text-text-secondary-dark">
                  <Cpu className="h-3.5 w-3.5" />
                  Total Tokens
                </span>
                <span className="text-sm font-medium text-text-primary-dark">
                  {formatTokens(totalTokens)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs text-text-secondary-dark pl-5">
                  Input
                </span>
                <span className="text-xs text-text-secondary-dark">
                  {formatTokens(request.totalInputTokens)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs text-text-secondary-dark pl-5">
                  Output
                </span>
                <span className="text-xs text-text-secondary-dark">
                  {formatTokens(request.totalOutputTokens)}
                </span>
              </div>

              <div className="border-t border-border-dark" />

              {/* Cost */}
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs text-text-secondary-dark">
                  <DollarSign className="h-3.5 w-3.5" />
                  Total Cost
                </span>
                <span className="text-sm font-medium text-text-primary-dark">
                  {formatCost(request.totalCost)}
                </span>
              </div>

              <div className="border-t border-border-dark" />

              {/* Time */}
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs text-text-secondary-dark">
                  <Clock className="h-3.5 w-3.5" />
                  Elapsed Time
                </span>
                <span className="text-sm font-medium text-text-primary-dark">
                  {elapsedTime}
                </span>
              </div>

              <div className="border-t border-border-dark" />

              {/* WorkItem Count */}
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs text-text-secondary-dark">
                  <Layers className="h-3.5 w-3.5" />
                  Work Items
                </span>
                <span className="text-sm font-medium text-text-primary-dark">
                  {workItems.length}
                </span>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* WorkItem Execution Section */}
      <div data-testid="request-detail-workitems">
        <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wider mb-3">
          <span className="flex items-center gap-1.5">
            <Layers className="h-4 w-4" />
            Execution Timeline ({workItems.length} work items)
          </span>
        </h2>
        <RequestWorkItems
          workItems={workItems}
          onItemClick={handleWorkItemClick}
        />
      </div>
    </div>
  );
};

RequestDetail.displayName = 'RequestDetail';

export default RequestDetail;
