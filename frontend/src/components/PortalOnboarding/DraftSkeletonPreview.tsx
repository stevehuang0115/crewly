/**
 * DraftSkeletonPreview Component
 *
 * Loading preview skeleton shown alongside the analysis progress list.
 * Previews the shape of the review screen while analysis runs.
 *
 * @module components/PortalOnboarding/DraftSkeletonPreview
 */

import React from 'react';

// =============================================================================
// Types
// =============================================================================

export interface DraftSkeletonPreviewProps {
  /** Whether to show the setup card skeleton */
  showSetupCard?: boolean;
  /** Density of skeleton lines */
  density?: 'compact' | 'default';
}

// =============================================================================
// Sub-components
// =============================================================================

/** Skeleton line with animated pulse */
const SkeletonLine: React.FC<{ width: string; className?: string }> = ({ width, className = '' }) => (
  <div
    className={`h-3 rounded bg-border-dark/50 animate-pulse ${className}`}
    style={{ width }}
  />
);

/** Skeleton card block */
const SkeletonCard: React.FC<{ title: string; lines: number }> = ({ title, lines }) => (
  <div className="rounded-lg border border-border-dark/50 p-4">
    <div className="text-xs text-text-secondary-dark/40 mb-3">{title}</div>
    <div className="space-y-2.5">
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine key={i} width={`${60 + Math.random() * 30}%`} />
      ))}
    </div>
  </div>
);

// =============================================================================
// Component
// =============================================================================

/**
 * Renders skeleton preview of the upcoming review draft.
 *
 * @param props - Component props
 * @returns DraftSkeletonPreview element
 */
export const DraftSkeletonPreview: React.FC<DraftSkeletonPreviewProps> = ({
  showSetupCard = true,
  density = 'default',
}) => {
  const lineCount = density === 'compact' ? 2 : 3;

  return (
    <div className="space-y-3" data-testid="draft-skeleton-preview">
      <div className="text-xs text-text-secondary-dark/50 font-medium">
        Upcoming draft preview
      </div>

      {/* Brand hero skeleton */}
      <div className="rounded-lg border border-border-dark/50 p-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-border-dark/50 animate-pulse" />
          <div className="space-y-2 flex-1">
            <SkeletonLine width="45%" />
            <SkeletonLine width="30%" className="h-2" />
          </div>
        </div>
      </div>

      {/* Business snapshot skeleton */}
      <SkeletonCard title="Business Snapshot" lines={lineCount} />

      {/* Audience skeleton */}
      <SkeletonCard title="Audience & Positioning" lines={lineCount} />

      {/* Setup card skeleton */}
      {showSetupCard && (
        <SkeletonCard title="Recommended Setup" lines={2} />
      )}
    </div>
  );
};

DraftSkeletonPreview.displayName = 'DraftSkeletonPreview';
