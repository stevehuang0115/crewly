/**
 * OwnerPullsCard — how often agents pulled the owner in this week, on the
 * Dashboard under "Waiting on you" (crewly#1387). Read-only: the count, the
 * change from last week, the kinds, the agents that caused the most pulls and
 * how long the owner was active. Fetches once (`GET /api/owner-receipt/pulls`,
 * owner only); renders nothing while loading, when the call fails, or when
 * there were no pulls in either week.
 *
 * @module components/Dashboard/OwnerPullsCard
 */

import React, { useEffect, useState } from 'react';

/** Where the weekly numbers come from. */
export const OWNER_PULLS_URL = '/api/owner-receipt/pulls';

/** Agents named in "Top sources". */
export const OWNER_PULLS_MAX_SOURCES = 3;

/** Kinds of pull, in the order they are named, with their words. */
const KIND_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['decision', 'decision needed'],
  ['review', 'review or approval'],
  ['stuck', 'agent stuck or error'],
  ['fyi', 'FYI that did not need an answer'],
];

/** One week of the weekly rollup (the fields the card reads). */
export interface OwnerPullsWeek {
  total: number;
  byKind: Record<string, number>;
  bySource?: Array<{ agent: string; team: string; count: number }>;
}

/** The weekly rollup (the fields the card reads). */
export interface OwnerPullsData {
  thisWeek: OwnerPullsWeek;
  lastWeek: OwnerPullsWeek;
  change: number;
  ownerActiveMinutes?: { thisWeek: number; lastWeek: number };
}

/**
 * Words for the change from last week.
 *
 * @param change - This week minus last week
 * @returns "same as last week", "up 2 from last week" or "down 3 from last week"
 */
export function changeWords(change: number): string {
  if (change === 0) return 'same as last week';
  return `${change > 0 ? 'up' : 'down'} ${Math.abs(change)} from last week`;
}

/**
 * Render the card.
 *
 * @returns The section, or null when there is nothing to show
 */
export const OwnerPullsCard: React.FC = () => {
  const [data, setData] = useState<OwnerPullsData | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(OWNER_PULLS_URL);
        if (!res.ok) return;
        const body = (await res.json()) as { success?: boolean; data?: { pulls?: OwnerPullsData } };
        if (!cancelled && body.success !== false && body.data?.pulls) setData(body.data.pulls);
      } catch {
        // Non-critical: the card stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data || (data.thisWeek.total === 0 && data.lastWeek.total === 0)) return null;
  const { thisWeek, ownerActiveMinutes } = data;
  const kinds = KIND_LABELS.filter(([k]) => (thisWeek.byKind[k] ?? 0) > 0).map(([k, label]) => `${thisWeek.byKind[k]} ${label}`);
  const sources = (thisWeek.bySource ?? []).slice(0, OWNER_PULLS_MAX_SOURCES).map((s) => `${s.agent} (${s.team}) ${s.count}`);

  return (
    <section aria-labelledby="owner-pulls-title" data-testid="owner-pulls" className="cw-glass rounded-2xl px-4 py-4 md:px-0">
      <h2 id="owner-pulls-title" className="text-lg font-extrabold text-text md:px-4">Pulled you in this week</h2>
      <p className="mt-1 text-[13px] text-text-2 md:px-4" data-testid="owner-pulls-count">
        {thisWeek.total} time{thisWeek.total === 1 ? '' : 's'} ({changeWords(data.change)})
        {ownerActiveMinutes ? ` · you were active about ${ownerActiveMinutes.thisWeek} min (last week ${ownerActiveMinutes.lastWeek})` : ''}
      </p>
      {kinds.length > 0 && (
        <p className="mt-1 text-[13px] text-text-2 md:px-4" data-testid="owner-pulls-kinds">
          By kind: {kinds.join(', ')}
        </p>
      )}
      {sources.length > 0 && (
        <p className="mt-1 text-[13px] text-text-2 md:px-4" data-testid="owner-pulls-sources">
          Top sources: {sources.join(', ')}
        </p>
      )}
    </section>
  );
};

export default OwnerPullsCard;
