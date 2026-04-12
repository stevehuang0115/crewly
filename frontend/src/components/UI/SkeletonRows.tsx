/**
 * Skeleton Rows Component
 *
 * Displays animated placeholder rows during loading states.
 * Preserves page layout structure instead of showing a centered spinner.
 *
 * @module components/UI/SkeletonRows
 */

import React from 'react';

// =============================================================================
// Props
// =============================================================================

interface SkeletonRowsProps {
  /** Number of skeleton rows to render */
  count?: number;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders animated skeleton placeholder rows for loading states.
 *
 * @param props.count - Number of rows to display (default: 3)
 * @returns Skeleton rows JSX element
 */
export const SkeletonRows: React.FC<SkeletonRowsProps> = ({ count = 3 }) => {
  return (
    <div className="animate-pulse space-y-3" data-testid="skeleton-rows">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="bg-surface-dark border border-border-dark rounded-lg p-5 space-y-3">
          <div className="h-4 bg-background-dark/50 rounded w-3/4" />
          <div className="h-3 bg-background-dark/50 rounded w-1/2" />
          <div className="flex gap-2">
            <div className="h-6 bg-background-dark/50 rounded-full w-16" />
            <div className="h-6 bg-background-dark/50 rounded-full w-20" />
          </div>
        </div>
      ))}
    </div>
  );
};

SkeletonRows.displayName = 'SkeletonRows';
