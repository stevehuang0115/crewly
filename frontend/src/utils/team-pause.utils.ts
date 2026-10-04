/**
 * Team pause helpers for the dashboard (specs/2026-10-04-team-pause.md).
 *
 * @module utils/team-pause.utils
 */

import type { Team } from '../types';

/**
 * Whether a team is paused right now. Prefers the server's `pausedNow`; an
 * older payload falls back to `paused` with its `until` time.
 *
 * @param team - Team
 * @param now - Clock (ms)
 * @returns True while paused
 *
 * @example
 * isTeamPaused({ ...team, paused: { pausedAt: '…', by: 'owner' } }) // true
 */
export function isTeamPaused(team: Pick<Team, 'paused' | 'pausedNow'> | null | undefined, now: number = Date.now()): boolean {
  if (!team) return false;
  if (typeof team.pausedNow === 'boolean') return team.pausedNow;
  if (!team.paused?.pausedAt) return false;
  if (!team.paused.until) return true;
  const until = Date.parse(team.paused.until);
  return Number.isNaN(until) || until > now;
}

/**
 * One-line description of a pause for a tooltip / subtitle.
 *
 * @param team - Paused team
 * @returns e.g. `Paused by you until Oct 10, 9:00 AM — harness work moved`
 */
export function pauseSummary(team: Pick<Team, 'paused'>): string {
  const p = team.paused;
  if (!p) return 'Paused';
  const until = p.until ? ` until ${new Date(p.until).toLocaleString()}` : '';
  const reason = p.reason ? ` — ${p.reason}` : '';
  return `Paused by you${until}${reason}`;
}

/**
 * Turn a `datetime-local` value into an ISO time (empty → undefined).
 *
 * @param local - `YYYY-MM-DDTHH:mm` in the browser's time zone
 * @returns ISO string, or undefined
 */
export function localDateTimeToIso(local: string): string | undefined {
  if (!local) return undefined;
  const at = new Date(local);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}
