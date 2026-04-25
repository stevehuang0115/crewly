/**
 * Team-Health-Watchdog (THW) — Pure Detection Rules (Layer 4)
 *
 * Pure functions: given a `TeamHealthSnapshot`, return per-team
 * `TeamHealthDetection` records. NO I/O. Mirrors the
 * `reconcile-rules.ts` ↔ `reconciler.service.ts` split.
 *
 * Rules:
 *   §B.2 — team_idle, team_pending, team_silent gates + verdict ladder
 *   §B.3 — false-positive guards (boot-grace, off-hours, thinking, stale)
 *   §B.4 — stale-trigger short-circuit (delegates to stale-trigger-detector)
 *   §B.5 — orphan-Request detection
 *   §B.6 (post-SEALED amendment) — lost-dispatch detection
 *
 * Layer-4 invariant (§A.1): READS the snapshot, EMITS detections.
 * NEVER mutates lower-layer state.
 *
 * @module services/team-health/team-health-detector
 */

import type { WorkItem, Request } from '../../types/v2/index.js';
import type {
  AgentWorkingStatus,
  TeamHealthConfig,
  TeamHealthDetection,
  TeamHealthGates,
  TeamHealthSnapshot,
  TeamSummary,
  VerdictCode,
} from './team-health-types.js';
import { DEFAULT_CONFIG, maxVerdict } from './team-health-types.js';
import { detectStaleWorkItems } from './stale-trigger-detector.js';
import { detectLostDispatches } from './lost-dispatch-detector.js';

const PENDING_WORKITEM_STATUSES = new Set<WorkItem['status']>([
  'queued',
  'accepted',
  'blocked',
  'proposed',
  'escalated',
  'scheduled',
]);

const IDLE_WORKING_STATUSES = new Set<AgentWorkingStatus>([
  'idle',
  'inactive',
  'suspended',
]);

const ACTIVE_WORKING_STATUSES = new Set<AgentWorkingStatus>([
  'in_progress',
  'working',
  'thinking',
]);

/**
 * Compute one TeamHealthDetection per team in the snapshot.
 *
 * Order:
 *   1. Boot-grace (FP-1) — early return all-healthy.
 *   2. Stale-fire WorkItem set (§B.4).
 *   3. Lost-dispatch WorkItem set (§B.6 amendment).
 *   4. Orphan-Request set (§B.5).
 *   5. Per team: gates → tentative verdict.
 *   6. Cascade resolution (≥ 2 sibling teams stuck-eligible).
 *
 * @param snapshot - All inputs (now, teams, agents, work items, etc.)
 * @param config - Threshold + behavior config; defaults if omitted
 * @returns One detection per team in `snapshot.teams`, in input order
 */
export function detectTeamHealth(
  snapshot: TeamHealthSnapshot,
  config: TeamHealthConfig = DEFAULT_CONFIG,
): TeamHealthDetection[] {
  const nowMs = snapshot.now.getTime();

  const bootGraceUntilMs = snapshot.bootedAt.getTime() + config.bootGraceMs;
  if (nowMs < bootGraceUntilMs) {
    return snapshot.teams.map((t) =>
      buildHealthyDetection(t, snapshot.now, 'Boot-grace silence (FP-1).'),
    );
  }

  const staleByWorkItemId = detectStaleWorkItems(
    snapshot.workItems,
    {
      priorDoneCounts: snapshot.priorDoneCounts,
      artifactProbes: snapshot.artifactProbes,
    },
    config.staleTriggerDetection,
  );

  const lostDispatchByWorkItemId = detectLostDispatches(
    snapshot.workItems,
    snapshot.agentHealth,
    snapshot.now,
    config.lostDispatchDetection,
  );

  const orphans = detectOrphanRequests(
    snapshot.requests,
    snapshot.workItems,
    snapshot.now,
    config.thresholds.ORPHAN_REQUEST_T1_MS,
  );

  const teamsWithStuckEligibility = new Set<string>();
  const perTeamGates = new Map<string, TeamHealthGates>();
  const perTeamPending = new Map<string, string[]>();
  const perTeamIdle = new Map<string, string[]>();

  for (const team of snapshot.teams) {
    const t = computeTeamThresholds(team.id, config);
    const idleAgents = computeIdleAgents(team, snapshot, t.TEAM_IDLE_T1_MS);
    const pendingItems = computePendingWorkItems(
      team, snapshot.workItems, staleByWorkItemId, snapshot.now, t.PENDING_T1_MS,
    );
    const triggerSilent = computeTriggerSilent(
      team, snapshot.triggers, snapshot.now, t.TRIGGER_SILENCE_T1_MS,
    );
    const team_idle = idleAgents.allIdle;
    const team_pending = pendingItems.length > 0;
    const team_silent = triggerSilent;
    perTeamGates.set(team.id, {
      team_idle, team_pending, team_silent, cascade_with_siblings: false,
    });
    perTeamPending.set(team.id, pendingItems.map((wi) => wi.id));
    perTeamIdle.set(team.id, idleAgents.idleSessions);
    if (team_idle && team_pending) teamsWithStuckEligibility.add(team.id);
  }

  // Cascade resolution
  const siblingsByParent = new Map<string, string[]>();
  for (const team of snapshot.teams) {
    if (!team.parentTeamId) continue;
    if (!teamsWithStuckEligibility.has(team.id)) continue;
    const arr = siblingsByParent.get(team.parentTeamId) ?? [];
    arr.push(team.id);
    siblingsByParent.set(team.parentTeamId, arr);
  }
  const cascadingTeamIds = new Set<string>();
  const cascadeSiblingsByTeam = new Map<string, string[]>();
  for (const [, siblingIds] of siblingsByParent) {
    if (siblingIds.length >= 2) {
      for (const id of siblingIds) {
        cascadingTeamIds.add(id);
        cascadeSiblingsByTeam.set(id, siblingIds.filter((s) => s !== id));
      }
    }
  }

  const detections: TeamHealthDetection[] = [];
  for (const team of snapshot.teams) {
    const gates = perTeamGates.get(team.id);
    if (!gates) continue;
    const t = computeTeamThresholds(team.id, config);
    const pendingIds = perTeamPending.get(team.id) ?? [];
    const idleSessions = perTeamIdle.get(team.id) ?? [];
    const teamStaleIds = collectTeamWorkItems(team, snapshot.workItems, staleByWorkItemId);
    const teamLostIds = collectTeamWorkItems(team, snapshot.workItems, lostDispatchByWorkItemId);
    const teamOrphanIds = orphans.perTeamOrphans.get(team.id) ?? [];

    let verdict: VerdictCode = computeVerdict(gates, t, cascadingTeamIds.has(team.id));

    if (teamStaleIds.length > 0 && (verdict === 'healthy' || verdict === 'stalling')) {
      verdict = 'stale';
    }
    if (teamOrphanIds.length > 0) {
      verdict = maxVerdict(verdict, orphans.systemTotal >= 3 ? 'cascade' : 'stalling');
    }
    if (teamLostIds.length > 0) {
      // Conservative: lost dispatch raises to at least 'stalling'
      verdict = maxVerdict(verdict, 'stalling');
    }

    if (cascadingTeamIds.has(team.id)) gates.cascade_with_siblings = true;

    detections.push({
      teamId: team.id,
      verdict,
      gates,
      cascadeWith: cascadingTeamIds.has(team.id) ? cascadeSiblingsByTeam.get(team.id) ?? [] : undefined,
      staleWorkItemIds: teamStaleIds.length > 0 ? teamStaleIds : undefined,
      lostDispatchWorkItemIds: teamLostIds.length > 0 ? teamLostIds : undefined,
      orphanRequestIds: teamOrphanIds.length > 0 ? teamOrphanIds : undefined,
      pendingWorkItemIds: pendingIds,
      idleAgentSessions: idleSessions,
      detectedAt: snapshot.now.toISOString(),
      rationale: composeRationale(verdict, gates, {
        pendingCount: pendingIds.length,
        idleCount: idleSessions.length,
        staleCount: teamStaleIds.length,
        lostCount: teamLostIds.length,
        orphanCount: teamOrphanIds.length,
        siblings: cascadeSiblingsByTeam.get(team.id) ?? [],
      }),
    });
  }
  return detections;
}

/**
 * Resolve per-team thresholds, applying any per-team config overrides.
 */
function computeTeamThresholds(teamId: string, config: TeamHealthConfig) {
  const override = config.byTeam[teamId] ?? {};
  return {
    TEAM_IDLE_T1_MS: override.TEAM_IDLE_T1_MS ?? config.thresholds.TEAM_IDLE_T1_MS,
    PENDING_T1_MS: override.PENDING_T1_MS ?? config.thresholds.PENDING_T1_MS,
    TRIGGER_SILENCE_T1_MS: override.TRIGGER_SILENCE_T1_MS ?? config.thresholds.TRIGGER_SILENCE_T1_MS,
    STUCK_T2_MS: override.STUCK_T2_MS ?? config.thresholds.STUCK_T2_MS,
    ORPHAN_REQUEST_T1_MS: override.ORPHAN_REQUEST_T1_MS ?? config.thresholds.ORPHAN_REQUEST_T1_MS,
  };
}

/**
 * Compute the team_idle axis. A team is idle iff every member's working
 * status is in IDLE_WORKING_STATUSES AND lastSeenAt is older than T1,
 * AND no member is currently inside a thinking-override TTL (§FP-3).
 *
 * Edge cases:
 *  - Zero-member team: NOT considered idle (returns false).
 *  - Unknown status: treat as idle (worst-case detection).
 */
function computeIdleAgents(
  team: TeamSummary,
  snapshot: TeamHealthSnapshot,
  teamIdleT1Ms: number,
): { allIdle: boolean; idleSessions: string[] } {
  if (team.memberSessions.length === 0) return { allIdle: false, idleSessions: [] };
  const nowMs = snapshot.now.getTime();
  const idleSessions: string[] = [];
  let everyoneIdle = true;
  for (const session of team.memberSessions) {
    const health = snapshot.agentHealth.get(session);
    const thinkingExpiry = snapshot.thinkingOverrides?.get(session);
    if (thinkingExpiry && thinkingExpiry.getTime() > nowMs) {
      everyoneIdle = false;
      continue;
    }
    const ws = health?.workingStatus ?? mapAgentStatusToWorking(health?.status);
    if (ACTIVE_WORKING_STATUSES.has(ws)) {
      everyoneIdle = false;
      continue;
    }
    if (!IDLE_WORKING_STATUSES.has(ws)) {
      idleSessions.push(session);
      continue;
    }
    const lastSeenAt = health?.lastSeenAt ? new Date(health.lastSeenAt).getTime() : 0;
    if (nowMs - lastSeenAt >= teamIdleT1Ms) {
      idleSessions.push(session);
    } else {
      everyoneIdle = false;
    }
  }
  return { allIdle: everyoneIdle, idleSessions };
}

function mapAgentStatusToWorking(status: string | undefined): AgentWorkingStatus {
  switch (status) {
    case 'active': return 'idle';
    case 'started': return 'idle';
    case 'inactive': return 'inactive';
    case 'suspended': return 'suspended';
    case 'unknown':
    default: return 'inactive';
  }
}

/**
 * Compute pending WorkItems for a team. Excludes stale-fire items (§FP-4).
 */
function computePendingWorkItems(
  team: TeamSummary,
  workItems: WorkItem[],
  staleSet: ReadonlySet<string>,
  now: Date,
  pendingT1Ms: number,
): WorkItem[] {
  const nowMs = now.getTime();
  const memberSet = new Set(team.memberSessions);
  const pending: WorkItem[] = [];
  for (const wi of workItems) {
    if (!PENDING_WORKITEM_STATUSES.has(wi.status)) continue;
    if (staleSet.has(wi.id)) continue;
    const target = wi.target ?? '';
    if (!(memberSet.has(target) || target === team.id)) continue;
    const referenceMs = wi.startedAt
      ? new Date(wi.startedAt).getTime()
      : new Date(wi.createdAt).getTime();
    if (nowMs - referenceMs >= pendingT1Ms) pending.push(wi);
  }
  return pending;
}

function computeTriggerSilent(
  team: TeamSummary,
  triggers: import('../../types/v2/index.js').Trigger[],
  now: Date,
  silenceT1Ms: number,
): boolean {
  const cutoff = now.getTime() - silenceT1Ms;
  const teamTriggers = triggers.filter(
    (t) =>
      t.teamId === team.id ||
      (t.action.sendMessage?.target && team.memberSessions.includes(t.action.sendMessage.target)),
  );
  if (teamTriggers.length === 0) return true;
  for (const trig of teamTriggers) {
    if (!trig.lastFiredAt) continue;
    if (new Date(trig.lastFiredAt).getTime() > cutoff) return false;
  }
  return true;
}

function computeVerdict(
  gates: TeamHealthGates,
  t: ReturnType<typeof computeTeamThresholds>,
  inCascade: boolean,
): VerdictCode {
  if (inCascade && gates.team_idle && gates.team_pending) return 'cascade';
  if (!gates.team_idle || !gates.team_pending) return 'healthy';
  if (gates.team_silent) return 'stuck';
  void t;
  return 'stalling';
}

function buildHealthyDetection(
  team: TeamSummary,
  now: Date,
  rationale: string,
): TeamHealthDetection {
  return {
    teamId: team.id,
    verdict: 'healthy',
    gates: {
      team_idle: false, team_pending: false, team_silent: false, cascade_with_siblings: false,
    },
    pendingWorkItemIds: [],
    idleAgentSessions: [],
    detectedAt: now.toISOString(),
    rationale,
  };
}

function collectTeamWorkItems(
  team: TeamSummary,
  workItems: WorkItem[],
  selected: ReadonlySet<string>,
): string[] {
  const memberSet = new Set(team.memberSessions);
  const out: string[] = [];
  for (const wi of workItems) {
    if (!selected.has(wi.id)) continue;
    const target = wi.target ?? '';
    if (memberSet.has(target) || target === team.id) out.push(wi.id);
  }
  return out;
}

function composeRationale(
  verdict: VerdictCode,
  gates: TeamHealthGates,
  counts: {
    pendingCount: number;
    idleCount: number;
    staleCount: number;
    lostCount: number;
    orphanCount: number;
    siblings: string[];
  },
): string {
  switch (verdict) {
    case 'healthy':
      return 'No concerning signals.';
    case 'stalling':
      if (counts.lostCount > 0) {
        return `${counts.lostCount} dispatch(es) likely lost after agent restart — assignee was alive but never moved the WorkItem to running.`;
      }
      if (counts.orphanCount > 0) {
        return `${counts.orphanCount} orphan Request(s) — decomposition may have silently failed.`;
      }
      return `${counts.idleCount} member(s) idle with ${counts.pendingCount} pending WorkItem(s); a recent trigger keeps verdict at 🟡.`;
    case 'stuck':
      return `Team has ${counts.pendingCount} pending WorkItem(s); ${counts.idleCount} member(s) idle and no trigger has fired recently.`;
    case 'cascade':
      return `Sibling cascade with [${counts.siblings.join(', ')}]: each team is idle with pending work, indicating a parent-level fault.`;
    case 'stale':
      return `${counts.staleCount} WorkItem(s) reference artifacts already in target state — likely stale-trigger refire (§B.4 suspicion).`;
    default:
      return `Verdict=${verdict}; gates=${JSON.stringify(gates)}.`;
  }
}

/**
 * Identify Requests with status open/in_progress, age > T1, zero matching
 * WorkItems (§B.5).
 */
export function detectOrphanRequests(
  requests: Request[],
  workItems: WorkItem[],
  now: Date,
  orphanT1Ms: number,
): { perTeamOrphans: Map<string, string[]>; systemTotal: number } {
  const nowMs = now.getTime();
  const perTeamOrphans = new Map<string, string[]>();
  let total = 0;
  const wiByRequest = new Map<string, WorkItem[]>();
  for (const wi of workItems) {
    if (!wi.requestId) continue;
    const arr = wiByRequest.get(wi.requestId) ?? [];
    arr.push(wi);
    wiByRequest.set(wi.requestId, arr);
  }
  for (const req of requests) {
    if (req.status !== 'open' && req.status !== 'running') continue;
    const childWorkItems = wiByRequest.get(req.id) ?? [];
    if (childWorkItems.length > 0) continue;
    const ageMs = nowMs - new Date(req.createdAt).getTime();
    if (ageMs <= orphanT1Ms) continue;
    total++;
    const teamKey = req.ownerAgent ?? '__unrouted__';
    const arr = perTeamOrphans.get(teamKey) ?? [];
    arr.push(req.id);
    perTeamOrphans.set(teamKey, arr);
  }
  return { perTeamOrphans, systemTotal: total };
}
