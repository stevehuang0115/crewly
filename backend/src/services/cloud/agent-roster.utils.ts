/**
 * The agent roster this machine reports to Crewly Cloud — on the Slack
 * registry heartbeat and on the conversation uploader's periodic probe — so
 * the portal lists every agent (spec §C.3 `roster[]`), including agents that
 * have no messages yet and machines that do not use Slack.
 *
 * Session names are the machine's own (`crewly-orc` for the orchestrator,
 * never the per-machine Slack spelling), the same names the uploaded
 * conversation log and Cloud Talk use.
 *
 * @module services/cloud/agent-roster.utils
 */

import type { Team } from '../../types/index.js';
import { CLOUD_TALK_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { resolveMemberSessionName } from '../../utils/member-session-name.utils.js';
import type { AgentRosterEntry } from './conversation-ingest.contract.js';

/**
 * Build the roster: the orchestrator first, then every team member with a
 * session (orchestrator-role members are the orchestrator itself and are
 * skipped). A session listed twice keeps its first entry.
 *
 * @param teams - Stored teams
 * @returns Roster entries
 *
 * @example
 * ```typescript
 * buildAgentRoster(await storage.getTeams());
 * // [{ agentSession: 'crewly-orc', displayName: 'Crewly Orc', role: 'orchestrator' },
 * //  { agentSession: 'dev-ella', displayName: 'Ella', role: 'developer', teamName: 'Web' }]
 * ```
 */
export function buildAgentRoster(teams: readonly Team[]): AgentRosterEntry[] {
  const out: AgentRosterEntry[] = [
    { agentSession: ORCHESTRATOR_SESSION_NAME, displayName: CLOUD_TALK_CONSTANTS.ORCHESTRATOR_DISPLAY_NAME, role: 'orchestrator' },
  ];
  const seen = new Set<string>([ORCHESTRATOR_SESSION_NAME]);
  for (const team of teams) {
    for (const member of team.members ?? []) {
      if (!member?.id || String(member.role) === 'orchestrator') continue;
      const agentSession = resolveMemberSessionName(team.name, member);
      if (!agentSession || seen.has(agentSession)) continue;
      seen.add(agentSession);
      out.push({
        agentSession,
        displayName: member.name || agentSession,
        ...(member.role ? { role: String(member.role) } : {}),
        ...(team.name ? { teamName: team.name } : {}),
      });
    }
  }
  return out;
}
