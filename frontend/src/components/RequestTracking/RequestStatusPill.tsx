/**
 * Request Status Pill — V3 Dark/Calm palette
 *
 * Renders the status indicator for a Request, mapping each `RequestStatus`
 * to the exact color tokens in Ava's V3 design report (2026-04-05):
 *
 *   active (running)      → amber + subtle pulse on the dot only
 *   blocked               → red
 *   waiting_confirmation  → indigo / violet accent
 *   done                  → green
 *
 * The shared `<StatusBadge>` component does not expose a violet/indigo
 * variant or a pulse-only-on-the-dot affordance, so this component
 * encapsulates the Request-specific palette without forking shared UI.
 *
 * Per Ava's spec: "If running needs motion, keep it subtle pulse only
 * on the badge/icon, not the whole row."
 *
 * @module components/RequestTracking/RequestStatusPill
 */

import React from 'react';
import type { RequestStatus } from './request-tracking.types';
import { getRequestStatusLabel } from './request-tracking.types';

/**
 * Tailwind classes per status in the Dark/Calm palette.
 *
 * The pill uses the soft `/10` background + `/20` border + `*-400` text
 * pattern shared with the rest of the dark UI for visual cohesion.
 */
const STATUS_PILL_STYLES: Record<RequestStatus, string> = {
  active: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  blocked: 'bg-red-500/10 text-red-400 border-red-500/20',
  waiting_confirmation: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
  done: 'bg-green-500/10 text-green-400 border-green-500/20',
};

/**
 * Dot color used inside the pill (matches the pill's text color so the
 * dot reads as part of the same status mark).
 */
const STATUS_DOT_STYLES: Record<RequestStatus, string> = {
  active: 'bg-amber-400',
  blocked: 'bg-red-400',
  waiting_confirmation: 'bg-indigo-300',
  done: 'bg-green-400',
};

interface RequestStatusPillProps {
  /** Current status to render */
  status: RequestStatus;
  /** Optional override for the displayed label (defaults to the status' canonical label). */
  label?: string;
  /** Extra classes (rarely needed) */
  className?: string;
}

/**
 * Compact status pill for a Request.
 *
 * Renders a colored dot + label inside a rounded pill. The `active` status
 * adds a pulse animation to the dot only — the row body never animates.
 *
 * @param props.status - RequestStatus to render
 * @param props.label - Optional label override
 * @param props.className - Additional class names
 * @returns Pill JSX element
 *
 * @example
 * ```tsx
 * <RequestStatusPill status="active" />
 * // <span ... data-status="active">● Active</span>
 * ```
 */
export const RequestStatusPill: React.FC<RequestStatusPillProps> = ({
  status,
  label,
  className = '',
}) => {
  const pillStyles = STATUS_PILL_STYLES[status];
  const dotStyles = STATUS_DOT_STYLES[status];
  const displayLabel = label ?? getRequestStatusLabel(status);
  const shouldPulse = status === 'active';

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full border ${pillStyles} ${className}`.trim()}
      data-status={status}
      data-testid={`request-status-pill-${status}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${dotStyles} ${shouldPulse ? 'animate-pulse' : ''}`.trim()}
        aria-hidden="true"
      />
      {displayLabel}
    </span>
  );
};

export default RequestStatusPill;
