/**
 * Resolve an agent session name that may have gone stale.
 *
 * Session names are built as `<team>-<name>-<first 8 of member id>`, so a
 * member that is renamed (or whose team is renamed) gets a new session name
 * while the member id stays. Anything that stored the old name — a cron
 * trigger, a queued WorkItem — then points at nobody: on 2026-09-24 the daily
 * metrics trigger still targeted `crewly-marketing-self-watch-scribe-45506487`
 * after that member had become `crewly-marketing-dana-45506487`, and the
 * orphan recovery asked the owner to re-assign it by hand every morning.
 *
 * @module utils/session-resolve.utils
 */

import type { Team, TeamMember } from '../types/index.js';

/** Trailing member-id fragment of a session name. */
const MEMBER_SUFFIX = /-([0-9a-f]{8})$/i;

/** Where a session name resolves to. */
export interface ResolvedSession {
  sessionName: string;
  teamId: string;
  memberId: string;
  /** True when the input was stale and was mapped by member id */
  renamed: boolean;
}

/**
 * The member-id fragment at the end of a session name.
 *
 * @param session - Session name
 * @returns The 8-hex fragment, or null when the name has none
 */
export function memberSuffixOf(session: string): string | null {
  const m = MEMBER_SUFFIX.exec(session ?? '');
  return m ? m[1].toLowerCase() : null;
}

/**
 * Find the current session of the member a (possibly stale) session name
 * belonged to.
 *
 * Exact name first; otherwise the one member whose id starts with the name's
 * trailing fragment. An ambiguous fragment (two members) resolves to nothing
 * rather than guessing.
 *
 * @param session - Session name as stored
 * @param teams - Every team
 * @returns Where it resolves, or null
 */
export function resolveCurrentSession(session: string, teams: readonly Team[]): ResolvedSession | null {
  if (!session) return null;
  for (const t of teams) {
    const m = (t.members ?? []).find((x) => x.sessionName === session);
    if (m?.sessionName) return { sessionName: m.sessionName, teamId: t.id, memberId: m.id, renamed: false };
  }
  const suffix = memberSuffixOf(session);
  if (!suffix) return null;
  const hits: Array<{ team: Team; member: TeamMember }> = [];
  for (const t of teams) {
    for (const m of t.members ?? []) {
      if (m.sessionName && m.id.toLowerCase().startsWith(suffix)) hits.push({ team: t, member: m });
    }
  }
  if (hits.length !== 1) return null;
  const { team, member } = hits[0];
  return { sessionName: member.sessionName as string, teamId: team.id, memberId: member.id, renamed: true };
}
