/**
 * TeamLeadShare — how much of the team's tokens its lead uses (today, this
 * week), flagged above half; how often the lead was nudged to delegate; and
 * the work it kept because no member fits (crewly#1083).
 *
 * Read-only; one network call (GET /api/teams/:id/lead-share).
 *
 * @module components/TeamDetail/TeamLeadShare
 */

import { useEffect, useState } from 'react';
import { apiService, type LeadSharePeriod, type TeamLeadShare as LeadShareData } from '../../services/api.service';

export interface TeamLeadShareProps {
  /** Team id */
  teamId: string;
}

/**
 * A share as a whole percentage.
 *
 * @param share - 0..1 or null
 * @returns "63%" or "–"
 */
export function formatShare(share: number | null): string {
  return share === null ? '–' : `${Math.round(share * 100)}%`;
}

/**
 * Token count, short.
 *
 * @param n - Tokens
 * @returns "306M", "4.2M", "12k"
 */
export function formatTokens(n: number): string {
  if (n >= 100_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/** One period line. */
function PeriodLine({ label, p }: { label: string; p: LeadSharePeriod }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2 text-[13px]" data-testid={`lead-share-${label}`}>
      <span className="w-20 text-text-3">{label}</span>
      <span className={p.flagged ? 'font-semibold text-attention' : 'text-text'}>{formatShare(p.share)}</span>
      <span className="text-text-3">of {formatTokens(p.team)} tokens</span>
      {p.flagged && <span className="text-attention">· over half: the lead is doing the work</span>}
    </div>
  );
}

/**
 * Lead share panel for the team detail page. Renders nothing for a team
 * without a lead and other members.
 *
 * @param props.teamId - Team id
 * @returns The panel, or null
 */
export function TeamLeadShare({ teamId }: TeamLeadShareProps): JSX.Element | null {
  const [data, setData] = useState<LeadShareData | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await apiService.getTeamLeadShare(teamId);
        if (!cancelled) setData(d);
      } catch {
        // Non-fatal (also a client without this call): the panel stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  if (!data?.row) return null;
  const { row, nudges, keptWork } = data;
  return (
    <section aria-labelledby="team-lead-share-h" data-testid="team-lead-share">
      <h3 id="team-lead-share-h" className="mb-2 text-[13px] font-semibold text-text-2">
        Lead share ({row.leads.join(', ')})
      </h3>
      <PeriodLine label="Today" p={row.today} />
      <PeriodLine label="This week" p={row.week} />
      {nudges.total.count > 0 && (
        <p className="mt-1 text-[13px] text-text-3">
          Nudged to delegate {nudges.total.count}×, delegated after {nudges.total.followed}
        </p>
      )}
      {keptWork.length > 0 && (
        <div className="mt-2">
          <p className="text-[13px] text-text-2">Kept work — no member fits:</p>
          <ul className="ml-4 list-disc text-[13px] text-text-3">
            {keptWork.map((k) => (
              <li key={`${k.at}-${k.work}`}>
                {k.work} — <span className="text-text-2">{k.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
