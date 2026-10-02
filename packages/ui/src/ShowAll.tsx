/**
 * ShowAll Component
 *
 * Shows the first N children of a list and a "Show all N" control for the
 * rest (redesign rule: about 5 visible items per list). Nothing is dropped:
 * the control either expands in place or, with `onShowAll`, goes to the
 * page that lists everything.
 *
 * @module components/UI/ShowAll
 */

import React, { useState } from 'react';
import { cn } from './cn';

export interface ShowAllProps {
  /** The list items (rows). Each child counts as one item. */
  children: React.ReactNode;
  /** Items visible while collapsed (default 5) */
  limit?: number;
  /**
   * Total to announce when more exist than were rendered ("Show all 16"
   * when only the first page is loaded). Defaults to the child count.
   */
  total?: number;
  /** Instead of expanding in place, call this (e.g. navigate to the full list) */
  onShowAll?: () => void;
  /** Label of the expand control (default `Show all ${total}`) */
  showAllLabel?: (total: number) => string;
  /** Label of the collapse control (default "Show less") */
  showLessLabel?: string;
  /** Start expanded */
  defaultExpanded?: boolean;
  /** Wrapper element for the rows (e.g. 'ul' when children are <li>) */
  as?: 'div' | 'ul' | 'ol';
  /** Classes on the rows wrapper */
  className?: string;
  'data-testid'?: string;
}

/**
 * Collapse a list to its first `limit` items.
 *
 * @param props - {@link ShowAllProps}
 * @returns The (possibly truncated) list and its toggle
 *
 * @example
 * ```tsx
 * <ShowAll limit={6}>{decisions.map((d) => <CompactRow key={d.id} … />)}</ShowAll>
 * ```
 */
export const ShowAll: React.FC<ShowAllProps> = ({
  children,
  limit = 5,
  total,
  onShowAll,
  showAllLabel = (n) => `Show all ${n}`,
  showLessLabel = 'Show less',
  defaultExpanded = false,
  as: Wrapper = 'div',
  className,
  'data-testid': testId = 'show-all',
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const items = React.Children.toArray(children);
  const count = Math.max(total ?? 0, items.length);
  const hasMore = count > limit;
  const visible = expanded ? items : items.slice(0, limit);

  return (
    <div data-testid={testId}>
      <Wrapper className={className}>{visible}</Wrapper>
      {hasMore && (
        <button
          type="button"
          onClick={() => (onShowAll && !expanded ? onShowAll() : setExpanded((v) => !v))}
          aria-expanded={onShowAll ? undefined : expanded}
          className={cn('mt-2 px-4 py-1.5 text-[13px] font-semibold text-primary-text hover:underline underline-offset-2')}
          data-testid={`${testId}-toggle`}
        >
          {expanded ? showLessLabel : showAllLabel(count)}
        </button>
      )}
    </div>
  );
};

ShowAll.displayName = 'ShowAll';
