/**
 * SystemStatusBar Component
 *
 * One line at the top of the content column that appears only when
 * something is wrong (a runtime out of usage, a sign-in needed, the
 * orchestrator down, an update waiting). Replaces separate stacked banners:
 * the most severe item is shown; the others sit behind "+N more".
 *
 * Presentational: the host app turns its own status sources into
 * `SystemStatusItem`s. Each item keeps its own actions (links, buttons,
 * chips) and its own dismiss.
 *
 * @module components/UI/SystemStatusBar
 */

import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, X, type LucideIcon } from 'lucide-react';
import { cn } from './cn';

/** Severity, most severe first: danger > attention > primary (informational). */
export type SystemStatusTone = 'danger' | 'attention' | 'primary';

export interface SystemStatusItem {
  /** Stable id (also used for the test id `system-status-${id}`) */
  id: string;
  tone: SystemStatusTone;
  /** Leading icon (default: a warning triangle) */
  icon?: LucideIcon;
  /** Short bold lead ("Orchestrator not running") */
  title: React.ReactNode;
  /** The rest of the sentence; may contain links or chips */
  message?: React.ReactNode;
  /** Action buttons / links on the right */
  actions?: React.ReactNode;
  /** Hide this item; omit for items that cannot be dismissed */
  onDismiss?: () => void;
  /** Accessible name of the dismiss button (default "Dismiss") */
  dismissLabel?: string;
  /** Override the test id of the item element */
  testId?: string;
}

export interface SystemStatusBarProps {
  /** Current problems; the bar renders nothing when empty */
  items: SystemStatusItem[];
  /** Additional CSS classes on the bar */
  className?: string;
}

const RANK: Record<SystemStatusTone, number> = { danger: 0, attention: 1, primary: 2 };

const TONE: Record<SystemStatusTone, { bar: string; icon: string; title: string }> = {
  danger: { bar: 'bg-danger-soft border-danger/30', icon: 'text-danger', title: 'text-danger' },
  attention: { bar: 'bg-attention-soft border-attention/30', icon: 'text-attention', title: 'text-attention' },
  primary: { bar: 'bg-primary-soft border-primary/30', icon: 'text-primary-text', title: 'text-primary-text' },
};

/**
 * Order items most-severe first, keeping the given order within a tone.
 *
 * @param items - Items in source order
 * @returns A sorted copy
 */
export function sortStatusItems(items: SystemStatusItem[]): SystemStatusItem[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => RANK[a.item.tone] - RANK[b.item.tone] || a.i - b.i)
    .map(({ item }) => item);
}

/** One status line. */
const StatusLine: React.FC<{ item: SystemStatusItem; extra?: React.ReactNode }> = ({ item, extra }) => {
  const tone = TONE[item.tone];
  const Icon = item.icon ?? AlertTriangle;
  return (
    <div
      className="flex items-start justify-between gap-3 px-4 py-2 text-sm"
      data-testid={item.testId ?? `system-status-${item.id}`}
      data-tone={item.tone}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <Icon className={cn('h-4 w-4 shrink-0', tone.icon)} aria-hidden="true" />
        <span className={cn('font-semibold', tone.title)}>{item.title}</span>
        {item.message && <span className="min-w-0 text-text-2">{item.message}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {item.actions}
        {extra}
        {item.onDismiss && (
          <button
            type="button"
            onClick={item.onDismiss}
            aria-label={item.dismissLabel ?? 'Dismiss'}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[0.5rem] text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * Status bar for system problems.
 *
 * @param props - {@link SystemStatusBarProps}
 * @returns The bar, or null when nothing is wrong
 *
 * @example
 * ```tsx
 * <SystemStatusBar items={[
 *   { id: 'orc', tone: 'danger', title: 'Orchestrator not running', message: 'Check the logs.',
 *     actions: <IconButton icon={RefreshCw} aria-label="Refresh status" onClick={refresh} /> },
 * ]} />
 * ```
 */
export const SystemStatusBar: React.FC<SystemStatusBarProps> = ({ items, className }) => {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const sorted = sortStatusItems(items);
  const [first, ...rest] = sorted;

  const more =
    rest.length > 0 ? (
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex h-7 items-center gap-1 rounded-[0.5rem] px-2 text-[13px] font-semibold text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
        data-testid="system-status-more"
      >
        {expanded ? 'Show less' : `+${rest.length} more`}
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
      </button>
    ) : null;

  return (
    <div
      role="status"
      className={cn('relative z-20 border-b', TONE[first.tone].bar, className)}
      data-testid="system-status-bar"
    >
      <StatusLine item={first} extra={more} />
      {expanded && rest.map((item) => (
        <div key={item.id} className="border-t border-border-soft">
          <StatusLine item={item} />
        </div>
      ))}
    </div>
  );
};

SystemStatusBar.displayName = 'SystemStatusBar';
