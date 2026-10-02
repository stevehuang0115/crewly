/**
 * CompactRow Component
 *
 * One row of a list of similar things (decisions, tickets, runs, requests):
 * a primary line (15px/600), at most one quiet meta line (13px, --text-2),
 * at most two visible actions, everything else in a "⋯" OverflowMenu.
 * Rows are separated by a hairline, not boxed.
 *
 * The two-action limit is enforced by the `actions` type (a tuple of at
 * most two). Never drop an action to fit: put it in `overflow`.
 *
 * @module components/UI/CompactRow
 */

import React from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from './cn';
import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu';

/** Up to two visible actions (primary first). */
export type CompactRowActions = readonly [React.ReactNode] | readonly [React.ReactNode, React.ReactNode];

export interface CompactRowProps {
  /** Main line: what it is (human names, never raw ids) */
  primary: React.ReactNode;
  /** One quiet line: who / when / where ("Atlas · Think Tank · 2h ago") */
  meta?: React.ReactNode;
  /** Before the text: a StatusLabel dot, Avatar or icon */
  leading?: React.ReactNode;
  /** After the text, before the actions: a StatusLabel, time, count */
  trailing?: React.ReactNode;
  /** At most two visible actions; the first is the primary one */
  actions?: CompactRowActions;
  /** Everything else, behind "⋯" */
  overflow?: OverflowMenuItem[];
  /** Accessible name of the "⋯" button (default "More actions") */
  overflowLabel?: string;
  /** Makes the text area a button (open the detail / drawer) */
  onClick?: () => void;
  /** Highlight as the selected row */
  selected?: boolean;
  /** Additional CSS classes on the row */
  className?: string;
  'data-testid'?: string;
}

/**
 * Compact list row.
 *
 * @param props - {@link CompactRowProps}
 * @returns A row element (use inside a list; rows draw their own divider)
 *
 * @example
 * ```tsx
 * <CompactRow
 *   primary="Ship the pricing page?"
 *   meta="Ella · Growth · 2h ago"
 *   actions={[<Button size="xs">Yes</Button>, <Button size="xs" variant="secondary">No</Button>]}
 *   overflow={[{ label: 'Reply in thread', onClick: reply }, { label: 'Remind me tomorrow', onClick: remind }]}
 * />
 * ```
 */
export const CompactRow: React.FC<CompactRowProps> = ({
  primary,
  meta,
  leading,
  trailing,
  actions,
  overflow,
  overflowLabel = 'More actions',
  onClick,
  selected = false,
  className,
  'data-testid': testId = 'compact-row',
}) => {
  const body = (
    <>
      {leading && <span className="flex shrink-0 items-center">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold leading-snug text-text">{primary}</span>
        {meta && <span className="mt-0.5 block truncate text-[13px] leading-snug text-text-2">{meta}</span>}
      </span>
    </>
  );

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-soft px-4 py-3 last:border-b-0 sm:flex-nowrap',
        selected && 'bg-primary-soft',
        onClick && 'transition-colors hover:bg-surface-hover',
        className,
      )}
      data-testid={testId}
      aria-current={selected || undefined}
    >
      {onClick ? (
        <button type="button" onClick={onClick} className="flex min-w-0 flex-1 basis-48 items-center gap-3 text-left">
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">{body}</div>
      )}
      {trailing && <div className="flex shrink-0 items-center text-[13px] text-text-2">{trailing}</div>}
      {(actions?.length || overflow?.length) ? (
        <div className="flex shrink-0 items-center gap-2" data-testid={`${testId}-actions`}>
          {actions?.map((a, i) => <React.Fragment key={i}>{a}</React.Fragment>)}
          {overflow && overflow.length > 0 && (
            <OverflowMenu
              items={overflow}
              icon={MoreHorizontal}
              label={overflowLabel}
              buttonClassName="inline-flex h-8 w-8 items-center justify-center rounded-[0.5rem] text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
            />
          )}
        </div>
      ) : null}
    </div>
  );
};

CompactRow.displayName = 'CompactRow';
