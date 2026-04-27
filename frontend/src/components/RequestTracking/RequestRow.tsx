/**
 * Request Row Component — V3
 *
 * Two-tier scan model per Ava's V3 design report (2026-04-05) and the
 * matching V3 UI PRD §3.1:
 *   Top line     — source icon, title, status pill (Dark/Calm palette)
 *   Bottom line  — priority, category, mission link, work item count, updated time
 *
 * Cost / tokens / source label live on the detail page or the expandable
 * context area, not on the baseline row scan line. The whole row never
 * animates; only the `active` status dot inside `<RequestStatusPill>` does.
 *
 * Clicking the row navigates to `/tasks/:id` (the consolidated V3 Request
 * surface). Expanding the chevron toggles the inline child WorkItem rail
 * for fast triage without leaving the list.
 *
 * @module components/RequestTracking/RequestRow
 */

import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MessageSquare,
  Mail,
  MessageCircle,
  Plug,
  PenLine,
  ChevronDown,
  ChevronRight,
  Inbox,
  Layers,
} from 'lucide-react';
import { Card } from '../UI/Card';
import { Badge } from '../UI/Badge';
import { StatusDot } from '../UI/StatusDot';
import { RequestStatusPill } from './RequestStatusPill';
import type { RequestItem, RequestChildItem, RequestSource } from './request-tracking.types';
import {
  getPriorityBadgeVariant,
  getRequestPriorityLabel,
  getSourceLabel,
  formatRequestTime,
} from './request-tracking.types';

// =============================================================================
// Source Icon Mapping
// =============================================================================

/** Maps request source to a lucide-react icon component */
const SOURCE_ICONS: Record<RequestSource, React.ComponentType<{ className?: string }>> = {
  slack: MessageSquare,
  email: Mail,
  chat: MessageCircle,
  api: Plug,
  manual: PenLine,
};

// =============================================================================
// Props
// =============================================================================

interface RequestRowProps {
  /** Request data to render */
  request: RequestItem;
}

// =============================================================================
// Sub-components
// =============================================================================

/**
 * Renders a single child work item row using StatusDot and Badge.
 *
 * @param props.item - Child item data
 * @returns Child item JSX
 */
const ChildItemRow: React.FC<{ item: RequestChildItem }> = ({ item }) => {
  /** Map child status to StatusDot DotStatus */
  const dotStatus = item.status === 'done' ? 'active' as const
    : item.status === 'in_progress' ? 'connecting' as const
    : 'inactive' as const;

  return (
    <div
      className="flex items-center gap-2.5 py-1.5 border-b border-border-dark last:border-b-0"
      data-testid={`request-child-${item.id}`}
    >
      <StatusDot status={dotStatus} size="sm" pulse={false} />
      <span className="flex-1 text-xs text-text-secondary-dark">{item.label}</span>
      {item.tag && (
        <Badge variant="error" size="sm">{item.tag}</Badge>
      )}
      {item.progress !== undefined && (
        <div className="w-20 h-1.5 bg-background-dark rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-300"
            style={{ width: `${item.progress}%` }}
          />
        </div>
      )}
      {item.assignee && (
        <span className="text-xs text-text-secondary-dark/60">{item.assignee}</span>
      )}
      {item.dueDate && (
        <span className="text-xs text-text-secondary-dark/60 whitespace-nowrap">{item.dueDate}</span>
      )}
    </div>
  );
};

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a Request row card with the V3 two-tier scan model.
 *
 * Top line keeps a single visual identity (icon + title + status pill);
 * the bottom line packs the meta-fields users filter by — priority,
 * category, mission link, work item count, updated time. Clicking the
 * row navigates to the canonical `/tasks/:id` detail; the chevron
 * toggles the inline children without navigating.
 *
 * @param props.request - Request data
 * @returns Request row JSX element
 */
export const RequestRow: React.FC<RequestRowProps> = ({ request }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const navigate = useNavigate();
  const hasChildren = !!(request.childItems && request.childItems.length > 0);

  /**
   * Navigate to the canonical V3 Request detail at `/tasks/:id`.
   * `/requests/:id` was the staging route during the design iteration
   * and is being consolidated onto `/tasks/:id` in the same change set.
   */
  const handleNavigate = useCallback(() => {
    navigate(`/tasks/${request.id}`);
  }, [navigate, request.id]);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasChildren) {
      setIsExpanded((prev) => !prev);
    }
  }, [hasChildren]);

  /**
   * Handles keyboard interaction for the clickable row.
   * Enter navigates to detail, Space toggles expand.
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleNavigate();
      } else if (e.key === ' ') {
        e.preventDefault();
        if (hasChildren) setIsExpanded((prev) => !prev);
      }
    },
    [handleNavigate, hasChildren],
  );

  const SourceIcon = SOURCE_ICONS[request.source] ?? Inbox;
  const priorityVariant = getPriorityBadgeVariant(request.priority);
  const sourceLabel = getSourceLabel(request.source);
  const updatedLabel = formatRequestTime(request.updatedAt);

  return (
    <li className="list-none">
      <Card
        variant="default"
        padding="none"
        className="overflow-hidden hover:border-border-light transition-colors"
        data-testid={`request-row-${request.id}`}
      >
        {/* Main row */}
        <div
          className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-background-dark/30 transition-colors"
          role="button"
          tabIndex={0}
          aria-label={`Open request: ${request.title}`}
          onClick={handleNavigate}
          onKeyDown={handleKeyDown}
        >
          {/* Source icon — provides at-a-glance channel context */}
          <SourceIcon
            className="h-5 w-5 text-text-secondary-dark flex-shrink-0"
            aria-label={sourceLabel}
          />

          {/* Two-tier content */}
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            {/* Top: title + status pill (no priority — it lives below) */}
            <div className="flex items-start gap-2" data-testid="request-tier-top">
              <span className="text-[15px] font-semibold leading-5 text-text-primary-dark line-clamp-2 flex-1 min-w-0">
                {request.title}
              </span>
              <RequestStatusPill status={request.status} className="flex-shrink-0" />
            </div>

            {/* Bottom: priority, category, mission link, work item count, updated time */}
            <div
              className="flex items-center gap-3 text-xs text-text-secondary-dark/70 flex-wrap"
              data-testid="request-tier-bottom"
            >
              <Badge variant={priorityVariant} size="sm">
                {getRequestPriorityLabel(request.priority)}
              </Badge>
              {request.category && (
                <span data-testid="request-meta-category" className="text-text-secondary-dark">
                  {request.category}
                </span>
              )}
              {request.missionLink && (
                <span data-testid="request-meta-mission" className="whitespace-nowrap">
                  Mission: <span className="text-primary">{request.missionLink}</span>
                </span>
              )}
              <span
                data-testid="request-meta-workitems"
                className="inline-flex items-center gap-1 whitespace-nowrap"
                title={`${request.workItemCount} work item${request.workItemCount === 1 ? '' : 's'}`}
              >
                <Layers className="h-3 w-3" aria-hidden="true" />
                {request.workItemCount}
                <span className="sr-only">
                  {' '}work item{request.workItemCount === 1 ? '' : 's'}
                </span>
              </span>
              <span
                data-testid="request-meta-updated"
                className="ml-auto whitespace-nowrap"
              >
                {updatedLabel}
              </span>
            </div>
          </div>

          {/* Expand indicator — clicking toggles children without navigating */}
          {hasChildren && (
            <button
              onClick={handleToggle}
              className="p-1 rounded hover:bg-surface-dark flex-shrink-0"
              aria-label={isExpanded ? 'Collapse work items' : 'Expand work items'}
            >
              {isExpanded
                ? <ChevronDown className="h-4 w-4 text-text-secondary-dark" />
                : <ChevronRight className="h-4 w-4 text-text-secondary-dark" />
              }
            </button>
          )}
        </div>

        {/* Expandable context area — children + secondary metadata that
            doesn't belong on the baseline scan line. */}
        {isExpanded && (
          <div className="border-t border-border-dark px-4 py-2 space-y-1.5" data-testid="request-children">
            {/* Source label kept here as expandable context (not on top line) */}
            <div className="flex items-center gap-2 text-xs text-text-secondary-dark/60">
              <span className="uppercase tracking-wide">Source</span>
              <Badge variant="default" size="sm">{sourceLabel}</Badge>
              {request.ownerAgent && (
                <span className="text-text-secondary-dark">via {request.ownerAgent}</span>
              )}
            </div>
            {hasChildren && (
              <div>
                {request.childItems!.map((child) => (
                  <ChildItemRow key={child.id} item={child} />
                ))}
              </div>
            )}
          </div>
        )}
      </Card>
    </li>
  );
};
