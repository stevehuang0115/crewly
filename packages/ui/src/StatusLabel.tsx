/**
 * StatusLabel Component
 *
 * Status as colour + word: a small dot followed by a short label
 * ("Running", "Needs you", "Failed"). Colour is never the only signal.
 * Part of the redesign kit (specs/2026-10-02-ui-redesign.md §Components).
 *
 * @module components/UI/StatusLabel
 */

import React from 'react';
import { cn } from './cn';

/** The five status tones of the redesign. */
export type StatusTone = 'success' | 'attention' | 'danger' | 'neutral' | 'primary';

export interface StatusLabelProps {
  /** Colour family: success (healthy/done), attention (needs you/waiting), danger (failed), neutral (idle/queued), primary (in progress) */
  tone: StatusTone;
  /** The word(s) shown next to the dot */
  children: React.ReactNode;
  /** Pulse the dot (live / in progress) */
  pulse?: boolean;
  /** Text size: sm = 12px, md = 13px (default) */
  size?: 'sm' | 'md';
  /** Additional CSS classes */
  className?: string;
  /** Tooltip / longer explanation */
  title?: string;
  'data-testid'?: string;
}

const DOT: Record<StatusTone, string> = {
  success: 'bg-success',
  attention: 'bg-attention',
  danger: 'bg-danger',
  neutral: 'bg-muted-dot',
  primary: 'bg-primary',
};

const TEXT: Record<StatusTone, string> = {
  success: 'text-success',
  attention: 'text-attention',
  danger: 'text-danger',
  neutral: 'text-text-2',
  primary: 'text-primary-text',
};

/**
 * Pick a tone for a common status word, so pages colour the same states the
 * same way. Unknown words are neutral.
 *
 * @param status - A status string from the API ("running", "blocked", "failed", …)
 * @returns The tone to render it with
 *
 * @example
 * ```ts
 * statusTone('in_progress') // 'primary'
 * statusTone('waiting')     // 'attention'
 * ```
 */
export function statusTone(status: string | null | undefined): StatusTone {
  const s = (status ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  if (['failed', 'error', 'errored', 'crashed', 'rejected', 'down', 'offline_error'].includes(s)) return 'danger';
  if (['waiting', 'blocked', 'needs_you', 'needs_review', 'pending_approval', 'awaiting_approval', 'to_review', 'parked', 'warning', 'login_required', 'paused'].includes(s)) return 'attention';
  if (['running', 'in_progress', 'working', 'activating', 'starting', 'started', 'busy'].includes(s)) return 'primary';
  if (['done', 'completed', 'complete', 'succeeded', 'success', 'active', 'online', 'healthy', 'connected', 'ok', 'approved'].includes(s)) return 'success';
  return 'neutral';
}

/**
 * Dot + word status label.
 *
 * @param props - {@link StatusLabelProps}
 * @returns An inline label
 *
 * @example
 * ```tsx
 * <StatusLabel tone="attention">Needs you</StatusLabel>
 * <StatusLabel tone={statusTone(run.status)}>{run.statusLabel}</StatusLabel>
 * ```
 */
export const StatusLabel: React.FC<StatusLabelProps> = ({
  tone,
  children,
  pulse = false,
  size = 'md',
  className,
  title,
  'data-testid': testId = 'status-label',
}) => (
  <span
    className={cn(
      'inline-flex items-center gap-1.5 font-semibold whitespace-nowrap',
      size === 'sm' ? 'text-xs' : 'text-[13px]',
      TEXT[tone],
      className,
    )}
    title={title}
    data-tone={tone}
    data-testid={testId}
  >
    <span aria-hidden="true" className={cn('inline-block h-2 w-2 shrink-0 rounded-full', DOT[tone], pulse && 'animate-pulse')} />
    {children}
  </span>
);

StatusLabel.displayName = 'StatusLabel';
