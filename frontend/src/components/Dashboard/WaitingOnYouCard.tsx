/**
 * WaitingOnYouCard — the owner's open decisions on the Dashboard
 * (specs/2026-10-01-decision-cards.md §8).
 *
 * Same answers as the Slack card: one button per option plus "Remind me
 * tomorrow". Self-contained: fetches its own data and polls. Renders nothing
 * when no decision is waiting. Phone-first: rows stack, buttons wrap.
 *
 * @module components/Dashboard/WaitingOnYouCard
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Badge } from '@crewly/ui/Badge';
import { Button } from '@crewly/ui/Button';
import { chooseDecision, listOpenDecisions, remindDecisionTomorrow } from '../../services/decisions.service';
import type { OwnerDecision } from '../../types/decision.types';

/** How often the list is refreshed (ms). */
export const WAITING_ON_YOU_POLL_MS = 30_000;

/**
 * Short local time of a deadline ("Thu 12:00").
 *
 * @param iso - ISO time
 * @returns Readable deadline, or the raw string when unreadable
 */
export function formatDeadline(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * The line saying what happens without an answer.
 *
 * @param d - Decision
 * @returns One line
 */
export function fallbackLine(d: OwnerDecision): string {
  if (d.status === 'parked') return 'Parked — needs your answer';
  if (d.sensitive) return `Needs your OK — nothing happens without your answer (asked to answer by ${formatDeadline(d.deadline)}).`;
  const def = d.options.find((o) => o.key === d.defaultKey);
  return `If no answer by ${formatDeadline(d.deadline)}, I'll ${def ? def.label : 'wait'}.`;
}

/** Props of {@link DecisionRow}. */
interface DecisionRowProps {
  decision: OwnerDecision;
  busy: boolean;
  onChoose: (id: string, option: string) => void;
  onRemind: (id: string) => void;
}

/**
 * One decision.
 *
 * @param props - Decision and handlers
 * @returns Row
 */
const DecisionRow: React.FC<DecisionRowProps> = ({ decision: d, busy, onChoose, onRemind }) => (
  <li className="py-4 first:pt-0 last:pb-0" data-testid={`decision-${d.id}`}>
    {d.ticket && (
      <div className="text-xs font-semibold text-text-secondary-dark mb-1">
        {d.ticket.id} · {d.ticket.title}
      </div>
    )}
    <p className="text-sm font-medium text-text-primary-dark break-words">{d.question}</p>
    <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-text-secondary-dark">
      <span>asked by {d.asker}</span>
      {d.sensitive && <Badge variant="warning" size="sm">{d.sensitive}</Badge>}
      {d.status === 'parked' && <Badge variant="error" size="sm">parked</Badge>}
    </div>
    <div className="flex flex-wrap gap-2 mt-3">
      {d.options.map((o) => (
        <Button
          key={o.key}
          size="sm"
          variant={o.key === d.defaultKey ? 'primary' : 'secondary'}
          disabled={busy}
          onClick={() => onChoose(d.id, o.key)}
          title={o.detail}
          className="min-h-10 text-left"
        >
          <span className="flex flex-col items-start">
            <span>{o.label}</span>
            {o.detail && <span className="text-[11px] font-normal opacity-75">{o.detail}</span>}
          </span>
        </Button>
      ))}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRemind(d.id)} className="min-h-10">
        Remind me tomorrow
      </Button>
    </div>
    <p className="mt-2 text-xs text-text-secondary-dark">{fallbackLine(d)}</p>
  </li>
);

/**
 * The "Waiting on you" card.
 *
 * @returns The card, or null when nothing waits on the owner
 */
export const WaitingOnYouCard: React.FC = () => {
  const [decisions, setDecisions] = useState<OwnerDecision[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDecisions(await listOpenDecisions());
    } catch {
      // Non-critical: keep what is shown; the next poll retries.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), WAITING_ON_YOU_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (id: string, call: () => Promise<unknown>): Promise<void> => {
    setBusyId(id);
    setError(null);
    try {
      await call();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
      await refresh();
    }
  };

  if (decisions.length === 0) return null;

  return (
    <section className="bg-surface-dark border border-border-dark rounded-xl p-4 sm:p-5" aria-label="Waiting on you">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-text-primary-dark">Waiting on you</h3>
        <Badge variant="primary" size="sm">{decisions.length}</Badge>
      </div>
      {error && <p className="text-xs text-red-400 mb-2" role="alert">{error}</p>}
      <ul className="divide-y divide-border-dark">
        {decisions.map((d) => (
          <DecisionRow
            key={d.id}
            decision={d}
            busy={busyId === d.id}
            onChoose={(id, option) => void act(id, () => chooseDecision(id, option))}
            onRemind={(id) => void act(id, () => remindDecisionTomorrow(id))}
          />
        ))}
      </ul>
    </section>
  );
};

export default WaitingOnYouCard;
