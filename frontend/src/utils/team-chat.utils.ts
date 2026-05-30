/**
 * Derivation helpers feeding the consolidated `/team-chat` surface from the
 * live teams directory (`GET /api/teams`).
 *
 * `LiveTeamChatPage` intentionally does not fetch a team directory itself —
 * it asks the host to inject:
 *   - `teamLabels`:    team-id → human display name (rail labels)
 *   - `mentionables`:  the @-mention popover pool (teams + their agents)
 *
 * These pure functions build both from the `Team[]` already available via the
 * `useTeams` hook, so no new backend endpoint is required.
 *
 * @module utils/team-chat.utils
 */

import type { Team } from '../types';
import type { ChatPresenceStatus, MentionTarget } from '@crewly/chat-ui';

/**
 * Map every team to a `teamId → name` label entry for the WorkspaceRail.
 *
 * Teams missing a non-empty name are skipped so the rail falls back to the
 * raw teamId (never blank) rather than rendering an empty label.
 *
 * @param teams - Teams from `GET /api/teams`.
 * @returns A record keyed by team id whose values are the team display names.
 */
export function buildTeamLabels(teams: Team[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const team of teams) {
    if (team.name && team.name.length > 0) {
      labels[team.id] = team.name;
    }
  }
  return labels;
}

/**
 * Translate a member's agent status into the chat-ui presence vocabulary.
 *
 * The teams directory tracks a richer agent lifecycle than the chat presence
 * dot; this collapses it to the three presence states the popover renders.
 *
 * @param agentStatus - The member's `agentStatus` from the teams directory.
 * @returns The chat-ui presence status for the mention row.
 */
function toPresence(agentStatus: string): ChatPresenceStatus {
  switch (agentStatus) {
    case 'active':
    case 'started':
      return 'online';
    case 'starting':
    case 'activating':
      return 'idle';
    default:
      return 'offline';
  }
}

/**
 * Build the @-mention suggestion pool for the composer from the teams list.
 *
 * Emits one `team` target per team (routes to the team leader) followed by one
 * `agent` target per member (routes as a direct ping). Member targets carry
 * `agentSession` so the composer can hand the session id to the dispatcher,
 * and a presence dot derived from the member's agent status.
 *
 * @param teams - Teams (with members) from `GET /api/teams`.
 * @returns A de-duplicated, render-ready list of mention targets.
 */
export function buildMentionables(teams: Team[]): MentionTarget[] {
  const targets: MentionTarget[] = [];
  const seen = new Set<string>();

  for (const team of teams) {
    if (!seen.has(team.id)) {
      seen.add(team.id);
      targets.push({
        id: team.id,
        kind: 'team',
        label: team.name || team.id,
        routingHint: 'Routes to the team leader',
      });
    }

    for (const member of team.members ?? []) {
      const key = member.sessionName || member.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      targets.push({
        id: member.id,
        kind: 'agent',
        label: member.name,
        routingHint: member.role,
        presence: toPresence(member.agentStatus),
        agentSession: member.sessionName,
      });
    }
  }

  return targets;
}
