/**
 * TeamTempHeadcount — the team's temporary agent headcount and the temporary
 * members using it.
 *
 * When a team has more work than hands, its lead may add temporary members
 * by itself, up to this number at the same time; they are removed
 * automatically when their work is accepted or they sit unused. Beyond it
 * the lead asks the owner for a permanent seat (a card). Only the owner
 * changes the number here; 0 turns temporary members off.
 *
 * @module components/TeamDetail/TeamTempHeadcount
 */

import { useCallback, useEffect, useState } from 'react';
import { FormSelect } from '@crewly/ui';
import { apiService } from '../../services/api.service';
import type { TeamTempMembers } from '../../types';

export interface TeamTempHeadcountProps {
  /** Team id */
  teamId: string;
}

/** Largest headcount the backend accepts (`TEMP_MEMBER_CONSTANTS.MAX_HEADCOUNT`). */
export const MAX_TEMP_HEADCOUNT = 10;

/**
 * Temporary headcount panel for the team page.
 *
 * @param props.teamId - Team id
 * @returns The panel, or null while loading / unavailable
 */
export function TeamTempHeadcount({ teamId }: TeamTempHeadcountProps): JSX.Element | null {
  const [data, setData] = useState<TeamTempMembers | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await apiService.getTeamTempMembers(teamId);
        if (!cancelled) setData(d);
      } catch {
        // Non-fatal (older backend, or not started yet): the panel stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const save = useCallback(
    async (limit: number) => {
      setSaving(true);
      setMessage(null);
      try {
        await apiService.setTeamTempHeadcount(teamId, limit);
        setData(await apiService.getTeamTempMembers(teamId));
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Could not save');
      } finally {
        setSaving(false);
      }
    },
    [teamId],
  );

  if (!data) return null;
  const { used, limit } = data.headcount;
  return (
    <section aria-labelledby="team-temp-headcount-h" data-testid="team-temp-headcount">
      <h3 id="team-temp-headcount-h" className="mb-2 text-[13px] font-semibold text-text-2">
        Temporary members
      </h3>
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <span className="text-text-2">Temporary agent headcount</span>
        <div className="w-24">
          <FormSelect aria-label="Temporary agent headcount" value={String(limit)} disabled={saving} onChange={(e) => void save(Number(e.target.value))} data-testid="temp-headcount-select">
            {Array.from({ length: MAX_TEMP_HEADCOUNT + 1 }, (_, n) => (
              <option key={n} value={n}>
                {n === 0 ? '0 (off)' : n}
              </option>
            ))}
          </FormSelect>
        </div>
        <span className="text-text-3" data-testid="temp-headcount-used">
          {limit === 0 ? 'The lead cannot add temporary members.' : `${used} of ${limit} in use.`}
        </span>
      </div>
      <p className="mt-2 text-[13px] text-text-3">
        When every member is busy, the team lead can add this many temporary members by itself. They are removed when their work is accepted or they sit unused. For a permanent member the lead
        asks you on a card.
      </p>
      {data.members.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {data.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 text-[13px]" data-testid={`temp-member-${m.id}`}>
              <span className="w-40 truncate text-text">{m.name}</span>
              <span className="text-text-2">{m.role}</span>
              <span className="text-text-3">{m.temporary.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p className="mt-2 text-[13px] text-text-2" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
