/**
 * LiveTeamHealthDataProvider — Production data adapter for THW
 *
 * Connects the THW pure detector to live state by reusing existing
 * services rather than introducing new caches (per §A.6 reuse-don't-
 * reinvent):
 *
 *   - WorkItem snapshot   → ReconcilerDataProvider.getActiveWorkItems()
 *   - Request snapshot    → ReconcilerDataProvider.getActiveRequests()
 *   - Agent health        → ReconcilerDataProvider.getAgentHealthMap()
 *   - Trigger snapshot    → TriggerEngine.list() (best-effort)
 *   - Team config         → StorageService.getTeams()
 *
 * Layer-4 invariant (§A.1): READS only. NEVER mutates lower-layer state.
 *
 * @module services/team-health/live-team-health-data-provider
 */

import type {
  AgentWorkingStatus,
  TeamHealthSnapshot,
  TeamSummary,
} from './team-health-types.js';
import type { TeamHealthDataProvider } from './team-health-watchdog.service.js';
import type { ReconcilerDataProvider } from '../reconciler/reconciler.service.js';
import type { AgentHealth } from '../reconciler/reconcile-rules.js';
import type { Trigger } from '../../types/v2/index.js';
import type { Team, TeamMember } from '../../types/index.js';

/**
 * Optional read accessors. Production wiring supplies live impls; tests
 * inject fakes. None are mandatory — when omitted, the provider degrades
 * gracefully (e.g. trigger-silence axis defaults to "silent" with no
 * triggers list).
 */
export interface LiveDataAccessors {
  /** Reuse the same reconciler data provider already wired for Layer 2. */
  reconcilerProvider: ReconcilerDataProvider;
  /** Returns all teams from StorageService.getTeams() */
  getTeams: () => Promise<Team[]>;
  /** Optional — returns Trigger.list() snapshot. Defaults to []. */
  getTriggers?: () => Promise<Trigger[]>;
  /** Backend boot timestamp (Date). */
  bootedAt: Date;
}

/**
 * Production implementation of TeamHealthDataProvider.
 */
export class LiveTeamHealthDataProvider implements TeamHealthDataProvider {
  constructor(private accessors: LiveDataAccessors) {}

  /**
   * Collect one snapshot for a sweep. Best-effort — partial failures in
   * any single accessor degrade gracefully (the watchdog wraps this in
   * its own try/catch; here we just return what we can).
   */
  async collectSnapshot(now: Date): Promise<TeamHealthSnapshot> {
    const { reconcilerProvider, getTeams, getTriggers, bootedAt } = this.accessors;

    const [workItems, requests, baseAgentHealth, teamsRaw, triggers] = await Promise.all([
      safeCall(() => reconcilerProvider.getActiveWorkItems(), [] as never[]),
      safeCall(() => reconcilerProvider.getActiveRequests(), [] as never[]),
      safeCall(() => reconcilerProvider.getAgentHealthMap(), new Map<string, AgentHealth>()),
      safeCall(() => getTeams(), [] as Team[]),
      getTriggers ? safeCall(() => getTriggers(), [] as Trigger[]) : Promise.resolve([]),
    ]);

    const teams = teamsRaw
      .filter((t) => !t.archived)
      .map(toTeamSummary);

    const agentHealth = enrichAgentHealth(baseAgentHealth, teamsRaw);

    return {
      now,
      bootedAt,
      teams,
      agentHealth,
      workItems,
      requests,
      triggers,
      // Stale-trigger probes & prior-done counts are not yet wired —
      // the data provider keeps these undefined so the stale-trigger
      // detector falls back to "no probes" (safe default).
      priorDoneCounts: undefined,
      artifactProbes: undefined,
      thinkingOverrides: undefined,
    };
  }
}

/**
 * Run a side-effecting accessor with a fallback. We never throw out of
 * snapshot collection — the watchdog tolerates partial degradation.
 */
async function safeCall<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * Project a `Team` into the smaller `TeamSummary` shape the detector
 * uses. We pull TL session name from the first leaderId/leaderIds entry.
 */
function toTeamSummary(team: Team): TeamSummary {
  const memberSessions = team.members
    .map((m) => m.sessionName)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);

  let tlSession: string | undefined;
  const leaderIds = team.leaderIds ?? (team.leaderId ? [team.leaderId] : []);
  for (const leaderId of leaderIds) {
    const member = team.members.find((m) => m.id === leaderId);
    if (member?.sessionName) {
      tlSession = member.sessionName;
      break;
    }
  }

  return {
    id: team.id,
    name: team.name,
    memberSessions,
    tlSession,
    parentTeamId: team.parentTeamId ?? undefined,
    // The Slack thread mapping lives outside Team in production; the
    // alert router falls back to TL DM when slackThreadId is undefined.
    slackThreadId: undefined,
  };
}

/**
 * Augment the reconciler's AgentHealth with `workingStatus` looked up
 * per-session from the Team config. Reconciler doesn't carry working-
 * status; THW needs it for the team_idle axis.
 */
function enrichAgentHealth(
  base: Map<string, AgentHealth>,
  teams: Team[],
): Map<string, AgentHealth & { workingStatus?: AgentWorkingStatus }> {
  const sessionToWorkingStatus = new Map<string, AgentWorkingStatus>();
  for (const team of teams) {
    for (const member of team.members) {
      if (!member.sessionName) continue;
      sessionToWorkingStatus.set(member.sessionName, mapWorkingStatus(member));
    }
  }
  const out = new Map<string, AgentHealth & { workingStatus?: AgentWorkingStatus }>();
  for (const [session, health] of base) {
    out.set(session, {
      ...health,
      workingStatus: sessionToWorkingStatus.get(session),
    });
  }
  // Surface members that exist in team config but aren't in the base
  // map (e.g. never registered) — treat as 'inactive'.
  for (const [session, ws] of sessionToWorkingStatus) {
    if (out.has(session)) continue;
    out.set(session, {
      sessionName: session,
      status: 'inactive',
      workingStatus: ws,
    });
  }
  return out;
}

function mapWorkingStatus(member: TeamMember): AgentWorkingStatus {
  // Member's working status is one of: 'idle' | 'in_progress'. Combine
  // with agentStatus to map to the wider AgentWorkingStatus enum.
  if (member.agentStatus === 'inactive') return 'inactive';
  if (member.agentStatus === 'suspended') return 'suspended';
  if (member.workingStatus === 'in_progress') return 'in_progress';
  return 'idle';
}
