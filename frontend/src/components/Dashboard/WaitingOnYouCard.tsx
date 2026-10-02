/**
 * WaitingOnYouCard — the owner's open decisions on the Dashboard
 * (specs/2026-10-01-decision-cards.md §8, redesigned in
 * specs/2026-10-02-ui-redesign.md).
 *
 * One compact row per decision: the question, one quiet line (who asked,
 * team or ticket, when), the two most likely answers as buttons, and "⋯"
 * for everything else — any further answers (e.g. "Reply in thread"),
 * "Remind me tomorrow", "Skip" (not on sensitive / system cards, whose "No"
 * is the way out) and, as a note, what happens without an answer. The first
 * five rows show, then "Show all N". "Skip all from before today" clears
 * stale cards (specs/2026-10-01-decision-skip.md). Self-contained: fetches
 * its own data and polls. Renders nothing when no decision is waiting,
 * unless `showEmpty` asks for a one-line "nothing waiting" state.
 *
 * @module components/Dashboard/WaitingOnYouCard
 */

import React, { useCallback, useEffect, useState } from 'react';
import { BellRing, CornerUpLeft, SkipForward, MessageSquare } from 'lucide-react';
import { CompactRow } from '@crewly/ui/CompactRow';
import { ShowAll } from '@crewly/ui/ShowAll';
import type { OverflowMenuItem } from '@crewly/ui/OverflowMenu';
import { chooseDecision, listOpenDecisions, remindDecisionTomorrow, skipAllDecisions, skipDecision } from '../../services/decisions.service';
import type { OwnerDecision } from '../../types/decision.types';
import { formatRelativeTimeCompact } from '../../utils/time';
import { REPLY_OPTION_LABEL, resolveAgent, splitDecisionOptions, type AgentDirectory } from './dashboard.utils';

/** How often the list is refreshed (ms). */
export const WAITING_ON_YOU_POLL_MS = 30_000;

/** Rows visible before "Show all N". */
export const WAITING_ON_YOU_VISIBLE = 5;

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

/**
 * Whether a decision offers "Skip" (mirrors the Slack card).
 *
 * @param d - Decision
 * @returns True unless sensitive, system or a held browser action
 */
export function canSkip(d: Pick<OwnerDecision, 'sensitive' | 'system' | 'kind'>): boolean {
  return !d.sensitive && !d.system && d.kind !== 'browser_action';
}

/**
 * Local midnight today ("before today").
 *
 * @param now - Clock
 * @returns Start of today
 */
export function startOfToday(now: Date = new Date()): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

/** What a sensitive card needs the owner's OK for. */
export const SENSITIVE_LABELS: Readonly<Record<string, string>> = {
  email: 'send an email',
  publish: 'publish',
  deploy: 'deploy',
  spend: 'spend money',
  browser_action: 'act in the browser',
  runtime_terms: 'accept the terms',
};

/**
 * The quiet line under a question: who asked, the ticket (or team), when.
 *
 * @param d - Decision
 * @param directory - Session → name/team lookup
 * @returns e.g. "Atlas · Think Tank · 2h ago"
 */
export function decisionMeta(d: OwnerDecision, directory: AgentDirectory): string {
  const who = resolveAgent(d.asker, directory);
  const where = d.ticket?.title || who.team;
  return [who.name, where, formatRelativeTimeCompact(d.createdAt)].filter(Boolean).join(' · ');
}

/** Props of {@link DecisionRow}. */
interface DecisionRowProps {
  decision: OwnerDecision;
  directory: AgentDirectory;
  busy: boolean;
  onChoose: (id: string, option: string) => void;
  onRemind: (id: string) => void;
  onSkip: (id: string) => void;
}

/**
 * One decision: question, meta, two answers, "⋯".
 *
 * @param props - Decision and handlers
 * @returns Row
 */
const DecisionRow: React.FC<DecisionRowProps> = ({ decision: d, directory, busy, onChoose, onRemind, onSkip }) => {
  const { inline, more } = splitDecisionOptions(d);
  const overflow: OverflowMenuItem[] = [
    ...more.map((o) => ({
      label: o.detail && o.label !== REPLY_OPTION_LABEL ? `${o.label} — ${o.detail}` : o.label,
      icon: o.label === REPLY_OPTION_LABEL ? CornerUpLeft : MessageSquare,
      disabled: busy,
      onClick: () => onChoose(d.id, o.key),
    })),
    { label: 'Remind me tomorrow', icon: BellRing, disabled: busy, onClick: () => onRemind(d.id), separator: more.length > 0 },
    ...(canSkip(d) ? [{ label: 'Skip', icon: SkipForward, disabled: busy, onClick: () => onSkip(d.id) }] : []),
  ];
  const flag = d.status === 'parked' ? 'parked' : d.sensitive ? `needs your OK to ${SENSITIVE_LABELS[d.sensitive] ?? d.sensitive}` : null;
  const answer = (o: (typeof inline)[number]): React.ReactNode => (
    <button
      key={o.key}
      type="button"
      disabled={busy}
      onClick={() => onChoose(d.id, o.key)}
      title={o.detail}
      className="h-8 max-w-[168px] truncate rounded-[var(--crewly-radius-sm)] border border-border px-3.5 text-[13px] font-bold text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
    >
      {o.label}
    </button>
  );
  const actions = inline.length === 0 ? undefined : inline.length === 1 ? ([answer(inline[0])] as const) : ([answer(inline[0]), answer(inline[1])] as const);

  return (
    <li data-testid={`decision-${d.id}`} className="list-none">
      <CompactRow
        data-testid={`decision-row-${d.id}`}
        primary={<span title={d.question}>{d.question}</span>}
        meta={
          <span title={d.ticket ? `${d.ticket.id} · ${d.ticket.title}` : undefined}>
            {decisionMeta(d, directory)}
            {flag && <span className="font-semibold text-attention"> · {flag}</span>}
          </span>
        }
        actions={actions}
        overflow={overflow}
        overflowLabel={`More options for "${d.question.slice(0, 40)}"`}
        overflowFooter={fallbackLine(d)}
        overflowMenuClassName="w-60"
        className="border-b-0 border-t border-border-soft px-0 md:px-4"
      />
    </li>
  );
};

/** Props of {@link WaitingOnYouCard}. */
export interface WaitingOnYouCardProps {
  /** Session → name/team lookup for the "asked by" line */
  directory?: AgentDirectory;
  /** Render a one-line empty state instead of nothing */
  showEmpty?: boolean;
}

const EMPTY_DIRECTORY: AgentDirectory = new Map();

/**
 * The "Waiting on you" section.
 *
 * @param props - {@link WaitingOnYouCardProps}
 * @returns The section, or null when nothing waits on the owner
 */
export const WaitingOnYouCard: React.FC<WaitingOnYouCardProps> = ({ directory = EMPTY_DIRECTORY, showEmpty = false }) => {
  const [decisions, setDecisions] = useState<OwnerDecision[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDecisions(await listOpenDecisions());
    } catch {
      // Non-critical: keep what is shown; the next poll retries.
    } finally {
      setLoaded(true);
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

  const cutoff = startOfToday();
  const old = decisions.filter((d) => Date.parse(d.createdAt) < cutoff.getTime());

  const skipOld = async (): Promise<void> => {
    const n = old.length;
    if (typeof window !== 'undefined' && !window.confirm(`Skip ${n} card${n === 1 ? '' : 's'} from before today? Their agents will be told to drop them.`)) return;
    setBulkBusy(true);
    setError(null);
    try {
      await skipAllDecisions({ olderThan: cutoff.toISOString(), source: 'all' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
      await refresh();
    }
  };

  if (decisions.length === 0) {
    if (!showEmpty || !loaded) return null;
    return (
      <section aria-labelledby="waiting-on-you-title" data-testid="waiting-on-you">
        <h2 id="waiting-on-you-title" className="text-lg font-extrabold text-text md:px-4">Waiting on you</h2>
        <p className="mt-1 text-[13px] text-text-2 md:px-4">Nothing needs you right now.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="waiting-on-you-title" data-testid="waiting-on-you">
      <h2 id="waiting-on-you-title" className="text-lg font-extrabold text-text md:px-4">Waiting on you</h2>
      {old.length > 0 && (
        <button
          type="button"
          disabled={bulkBusy}
          onClick={() => void skipOld()}
          title={`Skip ${old.length} card${old.length === 1 ? '' : 's'} from before today`}
          className="mb-2 mt-0.5 text-[13px] md:ml-4 font-semibold text-text-2 underline decoration-border underline-offset-[3px] hover:text-text disabled:opacity-50"
        >
          Skip all from before today
        </button>
      )}
      {error && <p className="mb-2 text-[13px] text-danger md:px-4" role="alert">{error}</p>}
      <ShowAll as="ul" limit={WAITING_ON_YOU_VISIBLE} showLessLabel="Show fewer" className="m-0 p-0" data-testid="waiting-on-you-list">
        {decisions.map((d) => (
          <DecisionRow
            key={d.id}
            decision={d}
            directory={directory}
            busy={busyId === d.id}
            onChoose={(id, option) => void act(id, () => chooseDecision(id, option))}
            onRemind={(id) => void act(id, () => remindDecisionTomorrow(id))}
            onSkip={(id) => void act(id, () => skipDecision(id))}
          />
        ))}
      </ShowAll>
    </section>
  );
};

export default WaitingOnYouCard;
