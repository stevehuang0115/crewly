/**
 * Request Row Component
 *
 * Renders a single request as a Card with:
 * - Source icon (lucide-react), title, StatusBadge, priority Badge
 * - Requester, updated time, mission link
 * - Expandable child work items with StatusDot
 *
 * Uses shared UI components: Card, StatusBadge, Badge, StatusDot.
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
} from 'lucide-react';
import { Card } from '../UI/Card';
import { StatusBadge } from '../UI/StatusBadge';
import { Badge } from '../UI/Badge';
import { StatusDot } from '../UI/StatusDot';
import type { RequestItem, RequestChildItem, RequestSource } from './request-tracking.types';
import {
  getStatusBadgeType,
  getRequestStatusLabel,
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
 * Renders a request row card with expandable child items.
 * Uses Card for the container, StatusBadge for status, Badge for priority,
 * and lucide-react icons for the source channel.
 *
 * @param props.request - Request data
 * @returns Request row JSX element
 */
export const RequestRow: React.FC<RequestRowProps> = ({ request }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const navigate = useNavigate();
  const hasChildren = request.childItems && request.childItems.length > 0;

  /** Navigate to the request detail page */
  const handleNavigate = useCallback(() => {
    navigate(`/requests/${request.id}`);
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
  const statusType = getStatusBadgeType(request.status);
  const priorityVariant = getPriorityBadgeVariant(request.priority);

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
          onClick={handleNavigate}
          onKeyDown={handleKeyDown}
        >
          {/* Source icon */}
          <SourceIcon
            className="h-5 w-5 text-text-secondary-dark flex-shrink-0"
            aria-label={getSourceLabel(request.source)}
          />

          {/* Content */}
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div className="flex items-start gap-2">
              <span className="text-[15px] font-semibold leading-5 text-text-primary-dark line-clamp-2 flex-1 min-w-0">
                {request.title}
              </span>
              <StatusBadge status={statusType}>
                {getRequestStatusLabel(request.status)}
              </StatusBadge>
              <Badge variant={priorityVariant} size="sm">
                {getRequestPriorityLabel(request.priority)}
              </Badge>
            </div>
            <div className="flex items-center gap-3 text-xs text-text-secondary-dark/60">
              <Badge variant="default" size="sm">{getSourceLabel(request.source)}</Badge>
              <span className="text-text-secondary-dark">
                Requester: {request.requester}
              </span>
              <span className="ml-auto whitespace-nowrap">
                Updated: {formatRequestTime(request.updatedAt)}
              </span>
              {request.missionLink && (
                <span className="whitespace-nowrap">
                  Mission: <span className="text-primary">{request.missionLink}</span>
                </span>
              )}
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

        {/* Expandable children */}
        {isExpanded && hasChildren && (
          <div className="border-t border-border-dark px-4 py-2" data-testid="request-children">
            {request.childItems!.map((child) => (
              <ChildItemRow key={child.id} item={child} />
            ))}
          </div>
        )}
      </Card>
    </li>
  );
};
