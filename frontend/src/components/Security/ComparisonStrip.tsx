/**
 * Comparison Strip — Before/after security comparison
 *
 * A minimal horizontal strip showing 3 key security differentiators
 * between traditional platforms and Crewly. Per spec section 2.4.
 *
 * @module components/Security/ComparisonStrip
 */

import React from 'react';
import { Card } from '../UI/Card';

/** Single comparison item data */
interface ComparisonItem {
  /** Category label */
  category: string;
  /** What "others" (traditional platforms) do */
  others: string;
  /** What Crewly does */
  crewly: string;
}

/** Three key differentiators from spec section 2.4 */
const COMPARISONS: ComparisonItem[] = [
  {
    category: 'Process Model',
    others: 'Shared runtime',
    crewly: 'Isolated PTY per agent',
  },
  {
    category: 'Data Location',
    others: 'Cloud storage',
    crewly: 'Local only',
  },
  {
    category: 'Tool Control',
    others: 'All or nothing',
    crewly: 'Per-tool granular approval',
  },
];

/**
 * Renders a 3-column comparison strip highlighting Crewly's security
 * advantages over traditional platforms. Responsive: horizontal on
 * desktop, scrollable cards on mobile.
 *
 * @returns ComparisonStrip element
 */
export const ComparisonStrip: React.FC = () => {
  return (
    <div
      className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-0 md:divide-x md:divide-zinc-700"
      data-testid="comparison-strip"
      role="list"
      aria-label="Security comparison: Crewly vs traditional platforms"
    >
      {COMPARISONS.map((item) => (
        <div
          key={item.category}
          className="md:px-6 first:md:pl-0 last:md:pr-0"
          role="listitem"
        >
          <Card variant="outlined" padding="md" className="md:rounded-none md:border-0 md:bg-transparent md:p-0">
            {/* Category header */}
            <div className="text-sm font-semibold text-zinc-200 mb-3">
              {item.category}
            </div>

            {/* Others (traditional) */}
            <div className="flex items-start gap-2 mb-2">
              <span className="text-zinc-600 text-xs mt-0.5" aria-hidden="true">&#9679;</span>
              <div>
                <span className="text-xs text-zinc-500 uppercase tracking-wide">Others: </span>
                <span className="text-sm text-zinc-400">{item.others}</span>
              </div>
            </div>

            {/* Crewly */}
            <div className="flex items-start gap-2">
              <span className="text-emerald-400 text-xs mt-0.5" aria-hidden="true">&#9679;</span>
              <div>
                <span className="text-xs text-emerald-500 uppercase tracking-wide">Crewly: </span>
                <span className="text-sm text-emerald-300 font-medium">{item.crewly}</span>
              </div>
            </div>
          </Card>
        </div>
      ))}
    </div>
  );
};

ComparisonStrip.displayName = 'ComparisonStrip';
