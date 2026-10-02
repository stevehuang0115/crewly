/**
 * Who a team channel (huddle) message that @'s nobody goes to: the team lead
 * by the harness-wide rule (`utils/team.utils` isTeamLead — explicit
 * `leaderIds`, else a `team-leader` / `tech-lead` member), else the first
 * member of the team found in the huddle. Used by the chat-v2 dispatcher's
 * `huddleLeaderFor` (wired in `index.ts`).
 *
 * @module services/chat-v2/huddle-leader
 */

import type { Team } from '../../types/index.js';
import { isTeamLead } from '../../utils/team.utils.js';
import { resolveMemberSessionName } from '../../utils/member-session-name.utils.js';

/**
 * The session to hand an un-addressed huddle message to.
 *
 * An idle member has no stored sessionName (cleared on stop), so members are
 * matched on the derived name too — otherwise a stopped leader is invisible
 * and the message is silently dropped (#claude-login, 2026-09-19).
 *
 * @param teams - All teams
 * @param huddleMembers - Sessions in the huddle
 * @returns The leader's session, or null when no team matches the huddle
 */
export function resolveHuddleLeader(teams: readonly Team[], huddleMembers: ReadonlySet<string>): string | null {
  if (huddleMembers.size === 0) return null;
  for (const team of teams) {
    const roster = (team.members ?? [])
      .map((m) => ({ m, session: resolveMemberSessionName(team.name, m) }))
      .filter(({ session }) => session && huddleMembers.has(session));
    if (roster.length === 0) continue;
    const leader = roster.find(({ m }) => isTeamLead(team, m)) ?? roster[0];
    return leader?.session ?? null;
  }
  return null;
}
