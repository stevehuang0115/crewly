/**
 * WorkItem Timeline Component
 *
 * Renders a vertical timeline of WorkItem events: status changes,
 * agent reasoning, tool actions, errors, and progress updates.
 *
 * @module components/WorkItemDetail/WorkItemTimeline
 */

import React from 'react';
import {
  Clock,
  Play,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  BarChart3,
  Ban,
} from 'lucide-react';
import type { TimelineEvent, TimelineEventKind, WorkItemStatus } from './workitem-detail.types';
import { formatTimestamp } from './workitem-detail.types';

// =============================================================================
// Icon & Color Mapping
// =============================================================================

/**
 * Returns the lucide-react icon component for a timeline event kind.
 *
 * @param kind - The event kind
 * @param status - Optional associated status
 * @returns React icon component
 */
function getEventIcon(
  kind: TimelineEventKind,
  status?: WorkItemStatus
): React.ComponentType<{ className?: string }> {
  if (kind === 'error') return XCircle;
  if (kind === 'progress_update') return BarChart3;
  if (kind === 'agent_reasoning') return Play;
  if (kind === 'tool_action') return Play;

  // status_change — pick by status
  switch (status) {
    case 'queued':
      return Clock;
    case 'running':
      return Play;
    case 'done':
      return CheckCircle2;
    case 'failed':
      return XCircle;
    case 'cancelled':
      return Ban;
    case 'blocked':
      return AlertTriangle;
    default:
      return Clock;
  }
}

/**
 * Returns the Tailwind color class for a timeline event.
 *
 * @param kind - The event kind
 * @param status - Optional associated status
 * @returns Tailwind color class string
 */
function getEventColor(kind: TimelineEventKind, status?: WorkItemStatus): string {
  if (kind === 'error') return 'text-red-400';
  if (kind === 'progress_update') return 'text-blue-400';

  switch (status) {
    case 'queued':
      return 'text-gray-400';
    case 'running':
      return 'text-green-400';
    case 'done':
      return 'text-blue-400';
    case 'failed':
      return 'text-red-400';
    case 'cancelled':
      return 'text-gray-500';
    case 'blocked':
      return 'text-yellow-400';
    default:
      return 'text-gray-400';
  }
}

/**
 * Returns the border/line color for a timeline connector.
 *
 * @param kind - The event kind
 * @param status - Optional associated status
 * @returns Tailwind border color class
 */
function getLineColor(kind: TimelineEventKind, status?: WorkItemStatus): string {
  if (kind === 'error') return 'border-red-500/30';
  if (status === 'done') return 'border-blue-500/30';
  if (status === 'running') return 'border-green-500/30';
  return 'border-border-dark';
}

// =============================================================================
// Props
// =============================================================================

interface WorkItemTimelineProps {
  /** Timeline events to render */
  events: TimelineEvent[];
}

// =============================================================================
// Component
// =============================================================================

/**
 * Vertical timeline displaying WorkItem activity events.
 *
 * @param props - Timeline events
 * @returns Timeline JSX element
 */
export const WorkItemTimeline: React.FC<WorkItemTimelineProps> = ({ events }) => {
  if (events.length === 0) {
    return (
      <div
        className="flex items-center justify-center py-8 text-text-secondary-dark text-sm"
        data-testid="timeline-empty"
      >
        No activity recorded yet.
      </div>
    );
  }

  return (
    <div className="relative" data-testid="workitem-timeline">
      {events.map((event, index) => {
        const Icon = getEventIcon(event.kind, event.status);
        const iconColor = getEventColor(event.kind, event.status);
        const lineColor = getLineColor(event.kind, event.status);
        const isLast = index === events.length - 1;

        return (
          <div key={event.id} className="relative flex gap-4 pb-6" data-testid={`timeline-event-${event.id}`}>
            {/* Vertical line */}
            {!isLast && (
              <div
                className={`absolute left-[15px] top-8 bottom-0 w-px border-l ${lineColor}`}
              />
            )}

            {/* Icon */}
            <div className="relative z-10 flex-shrink-0 mt-0.5">
              <div className={`p-1 rounded-full bg-surface-dark ${iconColor}`}>
                <Icon className="h-5 w-5" />
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-sm font-semibold ${iconColor}`}>
                  {event.label}
                </span>
                <span className="text-xs text-text-secondary-dark">
                  {formatTimestamp(event.timestamp)}
                </span>
              </div>

              {event.detail && (
                <div
                  className={`mt-1 text-sm ${
                    event.kind === 'error'
                      ? 'bg-red-500/10 border border-red-500/20 rounded-md p-2 text-red-300'
                      : event.kind === 'progress_update'
                        ? 'bg-surface-dark border border-border-dark rounded-md p-2 text-text-secondary-dark font-mono text-xs whitespace-pre-wrap overflow-x-auto max-h-40 overflow-y-auto'
                        : 'text-text-secondary-dark'
                  }`}
                >
                  {event.detail}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

WorkItemTimeline.displayName = 'WorkItemTimeline';
