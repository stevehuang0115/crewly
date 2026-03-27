/**
 * StatusDot Component
 *
 * A small colored circle indicating entity status.
 * Consolidates the 4 competing status color maps
 * (StatusBadge, SecurityOverview, CloudTab, PtyIsolationMap)
 * into a single shared primitive.
 *
 * @module components/UI/StatusDot
 */

import React from 'react';

// =============================================================================
// Types
// =============================================================================

/** All recognized status values across the codebase */
export type DotStatus =
  | 'active'
  | 'inactive'
  | 'connecting'
  | 'paired'
  | 'waiting'
  | 'disconnected'
  | 'online'
  | 'offline'
  | 'error';

export type DotSize = 'sm' | 'md' | 'lg';

export interface StatusDotProps {
  /** Current status — determines the dot color */
  status: DotStatus;
  /** Dot diameter */
  size?: DotSize;
  /** Whether to animate-pulse (defaults to true for active-like states) */
  pulse?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Mappings
// =============================================================================

/**
 * Status → Tailwind color class.
 *
 * Groups:
 *  - green  (emerald-400): active, online, paired
 *  - yellow (yellow-400):  waiting, connecting
 *  - gray   (gray-500):    inactive, disconnected, offline
 *  - red    (rose-400):    error
 */
const STATUS_COLOR_MAP: Record<DotStatus, string> = {
  active: 'bg-emerald-400',
  online: 'bg-emerald-400',
  paired: 'bg-emerald-400',
  waiting: 'bg-yellow-400',
  connecting: 'bg-yellow-400',
  inactive: 'bg-gray-500',
  disconnected: 'bg-gray-500',
  offline: 'bg-gray-500',
  error: 'bg-rose-400',
};

/** Size → Tailwind dimension class */
const SIZE_CLASS_MAP: Record<DotSize, string> = {
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5',
  lg: 'h-3 w-3',
};

/** Statuses that pulse by default when pulse prop is omitted */
const DEFAULT_PULSE_STATUSES: ReadonlySet<DotStatus> = new Set([
  'active',
  'online',
  'connecting',
]);

// =============================================================================
// Component
// =============================================================================

/**
 * Small colored dot representing a status.
 *
 * @param props - {@link StatusDotProps}
 * @returns A `<span>` element styled as a rounded dot
 *
 * @example
 * ```tsx
 * <StatusDot status="active" />
 * <StatusDot status="error" size="lg" pulse={false} />
 * ```
 */
export const StatusDot: React.FC<StatusDotProps> = ({
  status,
  size = 'md',
  pulse,
  className = '',
}) => {
  const shouldPulse = pulse ?? DEFAULT_PULSE_STATUSES.has(status);
  const color = STATUS_COLOR_MAP[status] ?? 'bg-gray-500';

  const combinedClassName = [
    'inline-block rounded-full',
    SIZE_CLASS_MAP[size],
    color,
    shouldPulse ? 'animate-pulse' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={combinedClassName}
      role="status"
      aria-label={status}
      data-testid="status-dot"
    />
  );
};

StatusDot.displayName = 'StatusDot';
