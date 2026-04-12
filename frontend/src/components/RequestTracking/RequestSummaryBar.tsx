/**
 * Request Summary Bar Component
 *
 * Displays summary statistics for the request list using the shared
 * ScoreCard and ScoreCardGrid UI components.
 *
 * @module components/RequestTracking/RequestSummaryBar
 */

import React from 'react';
import { ScoreCard, ScoreCardGrid } from '../UI/ScoreCard';
import type { RequestStatistics } from './request-tracking.types';

// =============================================================================
// Props
// =============================================================================

interface RequestSummaryBarProps {
  /** Computed request statistics (null during loading) */
  stats: RequestStatistics | null;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a grid of stat cards for the request list using shared ScoreCard.
 *
 * @param props.stats - Statistics to display
 * @returns Summary bar JSX element
 */
export const RequestSummaryBar: React.FC<RequestSummaryBarProps> = ({ stats }) => {
  if (!stats) return null;

  return (
    <ScoreCardGrid variant="horizontal" className="grid-cols-2 md:grid-cols-6" data-testid="request-summary-bar">
      <ScoreCard label="Total Incoming" value={stats.total} />
      <ScoreCard label="Active" value={stats.active} />
      <ScoreCard label="Blocked"><span className="text-red-400">{stats.blocked}</span></ScoreCard>
      <ScoreCard label="Waiting"><span className="text-yellow-400">{stats.waitingConfirmation}</span></ScoreCard>
      <ScoreCard label="Done"><span className="text-blue-400">{stats.done}</span></ScoreCard>
      <ScoreCard label="Total Cost">
        <span className="text-emerald-400">{stats.totalCost > 0 ? `$${stats.totalCost.toFixed(2)}` : '$0.00'}</span>
      </ScoreCard>
    </ScoreCardGrid>
  );
};
