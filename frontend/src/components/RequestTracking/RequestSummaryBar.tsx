/**
 * Request Summary Bar Component
 *
 * Displays summary statistics for the request list as a horizontal grid
 * of stat cards. Uses the same pattern as Dashboard's StatCard
 * (bg-surface-dark, border-border-dark, Tailwind utility classes).
 *
 * @module components/RequestTracking/RequestSummaryBar
 */

import React from 'react';
import type { RequestStatistics } from './request-tracking.types';

// =============================================================================
// Props
// =============================================================================

interface RequestSummaryBarProps {
  /** Computed request statistics (null during loading) */
  stats: RequestStatistics | null;
}

// =============================================================================
// Sub-component
// =============================================================================

/**
 * A single stat card matching the Dashboard StatCard pattern.
 *
 * @param props.title - Stat label
 * @param props.value - Stat value (number or string)
 * @param props.accent - Optional text color class for the value (e.g. 'text-red-400')
 */
const StatCard: React.FC<{ title: string; value: number | string; accent?: string }> = ({
  title,
  value,
  accent,
}) => (
  <div className="bg-surface-dark p-6 rounded-lg border border-border-dark transition-all hover:shadow-lg hover:border-primary/50">
    <p className="text-sm font-medium text-text-secondary-dark">{title}</p>
    <p className={`text-3xl font-bold mt-1 ${accent ?? ''}`}>{value}</p>
  </div>
);

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a 4-column grid of stat cards for the request list.
 * Matches the Dashboard page's StatCard layout.
 *
 * @param props.stats - Statistics to display
 * @returns Summary bar JSX element
 */
export const RequestSummaryBar: React.FC<RequestSummaryBarProps> = ({ stats }) => {
  if (!stats) return null;

  return (
    <div
      className="grid grid-cols-2 md:grid-cols-6 gap-4"
      data-testid="request-summary-bar"
    >
      <StatCard title="Total Incoming" value={stats.total} />
      <StatCard title="Active" value={stats.active} />
      <StatCard title="Blocked" value={stats.blocked} accent="text-red-400" />
      <StatCard title="Waiting" value={stats.waitingConfirmation} accent="text-yellow-400" />
      <StatCard title="Done" value={stats.done} accent="text-blue-400" />
      <StatCard title="Total Cost" value={stats.totalCost > 0 ? `$${stats.totalCost.toFixed(2)}` : '$0.00'} accent="text-emerald-400" />
    </div>
  );
};
