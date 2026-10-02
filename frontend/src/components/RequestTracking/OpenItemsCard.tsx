/**
 * Open items on a Request: promises the agent made the owner and questions
 * it asked (specs/2026-10-01-reply-open-items.md). Active ones first.
 *
 * @module components/RequestTracking/OpenItemsCard
 */

import React from 'react';
import { Card } from '@crewly/ui/Card';
import { Badge } from '@crewly/ui/Badge';
import { Button } from '@crewly/ui/Button';

/** One open item (mirrors backend `RequestOpenItem`). */
export interface OpenItem {
  id: string;
  type: 'commitment' | 'question';
  text: string;
  agent: string;
  status: string;
  createdAt: string;
  due?: string;
  readyAt?: string;
  decisionId?: string;
  answer?: string;
  closedReason?: string;
  childWorkItemIds?: string[];
}

/** Statuses that still hold the request open. */
const ACTIVE = new Set(['open', 'ready', 'overdue']);

/** Label + badge variant per status. */
const STATUS_VIEW: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'error' | 'info' }> = {
  open: { label: 'Open', variant: 'info' },
  ready: { label: 'Ready to deliver', variant: 'warning' },
  overdue: { label: 'Overdue', variant: 'error' },
  delivered: { label: 'Delivered', variant: 'success' },
  resolved: { label: 'Answered', variant: 'success' },
  superseded: { label: 'Superseded', variant: 'default' },
  expired: { label: 'Expired', variant: 'default' },
  cancelled: { label: 'Cancelled', variant: 'default' },
  skipped: { label: 'Skipped', variant: 'default' },
};

/**
 * Short local date-time.
 *
 * @param iso - ISO time
 * @returns e.g. "Oct 2, 12:00"
 */
function when(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Props. */
export interface OpenItemsCardProps {
  items: OpenItem[];
  /**
   * The owner skips an open item ("I don't care about this anymore"): a
   * promise's follow-up is cancelled, a question's card is skipped. No
   * Skip buttons without it.
   */
  onSkip?: (itemId: string) => Promise<void>;
}

/**
 * Card listing a request's open items.
 *
 * @param props - Items
 * @returns The card
 */
export const OpenItemsCard: React.FC<OpenItemsCardProps> = ({ items, onSkip }) => {
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const skip = async (itemId: string): Promise<void> => {
    if (!onSkip) return;
    setBusyId(itemId);
    setError(null);
    try {
      await onSkip(itemId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };
  const sorted = [...items].sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const active = sorted.filter((i) => ACTIVE.has(i.status)).length;
  return (
    <Card variant="default" padding="md" data-testid="request-open-items">
      <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wider mb-3">
        Open items {active > 0 ? `(${active} open)` : ''}
      </h2>
      {error && (
        <p className="text-xs text-red-400 mb-2" role="alert">
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {sorted.map((item) => {
          const view = STATUS_VIEW[item.status] ?? { label: item.status, variant: 'default' as const };
          return (
            <li key={item.id} className="flex flex-col gap-1" data-testid="request-open-item">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={item.type === 'commitment' ? 'info' : 'warning'} size="sm">
                  {item.type === 'commitment' ? 'Promise' : 'Question'}
                </Badge>
                <Badge variant={view.variant} size="sm">
                  {view.label}
                </Badge>
                <span className="text-xs text-text-secondary-dark">{item.agent}</span>
                {item.type === 'commitment' && item.due && ACTIVE.has(item.status) && (
                  <span className="text-xs text-text-secondary-dark">due {when(item.due)}</span>
                )}
                {item.decisionId && <span className="text-xs text-text-secondary-dark font-mono">{item.decisionId}</span>}
                {onSkip && ACTIVE.has(item.status) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto min-h-8"
                    disabled={busyId === item.id}
                    onClick={() => void skip(item.id)}
                    title={item.type === 'commitment' ? 'Drop this promise and cancel its follow-up' : "Skip this question — the agent won't ask again"}
                  >
                    Skip
                  </Button>
                )}
              </div>
              <p className="text-sm text-text-primary-dark break-words">{item.text}</p>
              {item.answer && <p className="text-xs text-text-secondary-dark">Answer: {item.answer}</p>}
              {item.status === 'ready' && item.readyAt && (
                <p className="text-xs text-amber-400">The work was ready at {when(item.readyAt)}; the agent was asked to deliver it.</p>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
};
