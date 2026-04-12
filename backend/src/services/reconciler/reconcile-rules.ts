/**
 * Reconcile Rules — Individual reconciliation checks
 *
 * Each rule inspects a specific aspect of system state and returns
 * corrections when discrepancies are found. Rules follow the CEO principle:
 * "All automation is explainable" — every correction records who, what, why.
 *
 * @module services/reconciler/reconcile-rules
 */

import type {
  WorkItem,
  WorkItemStatus,
  Request,
  RequestStatus,
  TaskClaim,
  ReconcileCorrection,
  WakeAction,
  WakeStrategy,
  AgentScoreBreakdown,
} from '../../types/v2/index.js';
import {
  isValidRequestTransition,
  isLeaseExpired,
  isGracePeriodExceeded,
  TERMINAL_WORK_ITEM_STATUSES,
  TERMINAL_REQUEST_STATUSES,
  createCorrection,
  DEFAULT_GRACE_PERIOD_MS,
} from '../../types/v2/index.js';

// ---------------------------------------------------------------------------
// Agent Health Types (abstraction over existing services)
// ---------------------------------------------------------------------------

/**
 * Minimal agent info needed by reconcile rules.
 * Abstraction over AgentRegistrationService / StorageService.
 */
export interface AgentHealth {
  sessionName: string;
  status: 'active' | 'started' | 'inactive' | 'suspended' | 'unknown';
  lastSeenAt?: string;
  /** Agent role (developer, qa, team-lead, etc.) — used for skill matching */
  role?: string;
  /** Tags describing agent capabilities (e.g. ['backend', 'typescript', 'rust']) */
  tags?: string[];
  /** Number of WorkItems currently assigned to this agent */
  activeWorkItemCount?: number;
  /** Team ID the agent belongs to */
  teamId?: string;
  /** Member ID within the team */
  memberId?: string;
}

// ---------------------------------------------------------------------------
// Rule: Detect Stuck WorkItems
// ---------------------------------------------------------------------------

/**
 * Detects WorkItems that are 'running' but whose assigned agent is not alive.
 * Returns corrections to transition them to 'blocked' or 'failed'.
 *
 * @param workItems - All running WorkItems
 * @param agentHealthMap - Map of agent session → health info
 * @param timeoutMs - Max duration a WorkItem can be running (default: 10 min)
 * @returns Array of corrections and affected WorkItem IDs
 */
export function detectStuckWorkItems(
  workItems: WorkItem[],
  agentHealthMap: Map<string, AgentHealth>,
  timeoutMs: number = 600_000,
): { corrections: ReconcileCorrection[]; stuckIds: string[] } {
  const corrections: ReconcileCorrection[] = [];
  const stuckIds: string[] = [];
  const now = Date.now();

  for (const wi of workItems) {
    if (wi.status !== 'running') continue;
    if (!wi.target) continue;

    const agent = agentHealthMap.get(wi.target);
    const isAgentDead = !agent || agent.status === 'inactive' || agent.status === 'unknown';
    const startedAt = wi.startedAt ? new Date(wi.startedAt).getTime() : new Date(wi.createdAt).getTime();
    const isTimedOut = (now - startedAt) > timeoutMs;

    if (isAgentDead) {
      const newStatus: WorkItemStatus = wi.retryCount < wi.maxRetries ? 'blocked' : 'failed';
      corrections.push(createCorrection({
        entityType: 'work_item',
        entityId: wi.id,
        previousState: 'running',
        newState: newStatus,
        reason: `Agent ${wi.target} is ${agent?.status ?? 'not found'}`,
        evidence: `Agent health check: status=${agent?.status ?? 'missing'}, lastSeen=${agent?.lastSeenAt ?? 'never'}`,
      }));
      stuckIds.push(wi.id);
    } else if (isTimedOut) {
      corrections.push(createCorrection({
        entityType: 'work_item',
        entityId: wi.id,
        previousState: 'running',
        newState: 'failed',
        reason: `WorkItem exceeded timeout of ${timeoutMs}ms`,
        evidence: `Started at ${wi.startedAt ?? wi.createdAt}, running for ${now - startedAt}ms`,
      }));
      stuckIds.push(wi.id);
    }
  }

  return { corrections, stuckIds };
}

// ---------------------------------------------------------------------------
// Rule: Detect Expired Claims
// ---------------------------------------------------------------------------

/**
 * Detects TaskClaims whose lease has expired and should be released or revoked.
 *
 * @param claims - All active claims
 * @param gracePeriodMs - Grace period duration in ms
 * @returns Claims to mark as expiring and claims to revoke
 */
export function detectExpiredClaims(
  claims: TaskClaim[],
  gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS,
): {
  corrections: ReconcileCorrection[];
  expiringIds: string[];
  revokedIds: string[];
} {
  const corrections: ReconcileCorrection[] = [];
  const expiringIds: string[] = [];
  const revokedIds: string[] = [];
  const now = Date.now();

  for (const claim of claims) {
    if (claim.status !== 'active' && claim.status !== 'expiring') continue;

    if (claim.status === 'active' && isLeaseExpired(claim, now)) {
      corrections.push(createCorrection({
        entityType: 'claim',
        entityId: claim.id,
        previousState: 'active',
        newState: 'expiring',
        reason: `Lease expired for claim ${claim.id} on WorkItem ${claim.workItemId}`,
        evidence: `leaseExpiresAt=${claim.leaseExpiresAt}, agentId=${claim.agentId}, now=${new Date(now).toISOString()}`,
      }));
      expiringIds.push(claim.id);
    }

    if (claim.status === 'expiring' && isGracePeriodExceeded(claim, gracePeriodMs, now)) {
      corrections.push(createCorrection({
        entityType: 'claim',
        entityId: claim.id,
        previousState: 'expiring',
        newState: 'revoked',
        reason: `Grace period exceeded for claim ${claim.id} on WorkItem ${claim.workItemId}`,
        evidence: `leaseExpiresAt=${claim.leaseExpiresAt}, gracePeriod=${gracePeriodMs}ms, agentId=${claim.agentId}, now=${new Date(now).toISOString()}`,
      }));
      revokedIds.push(claim.id);
    }
  }

  return { corrections, expiringIds, revokedIds };
}

// ---------------------------------------------------------------------------
// Rule: Reconcile Request Status
// ---------------------------------------------------------------------------

/**
 * Recomputes the correct status for a Request based on its WorkItems' statuses.
 * This is the core "truth recomputation" — events are hints, this is truth.
 *
 * @param request - The Request to reconcile
 * @param workItems - All WorkItems belonging to this Request
 * @returns Correction if status needs updating, null otherwise
 */
export function reconcileRequestStatus(
  request: Request,
  workItems: WorkItem[],
): ReconcileCorrection | null {
  if (TERMINAL_REQUEST_STATUSES.has(request.status)) return null;
  if (workItems.length === 0 && request.status === 'open') return null;

  const statuses = workItems.map(wi => wi.status);
  const allDone = statuses.length > 0 && statuses.every(s => s === 'done' || s === 'cancelled');
  const anyRunning = statuses.some(s => s === 'running');
  const allBlockedOrFailed = statuses.length > 0 && statuses.every(
    s => s === 'blocked' || s === 'failed' || s === 'cancelled'
  );
  const hasQueued = statuses.some(s => s === 'queued' || s === 'scheduled');

  let expectedStatus: RequestStatus = request.status;

  if (allDone) {
    expectedStatus = request.requiresConfirmation ? 'waiting_confirmation' : 'done';
  } else if (anyRunning) {
    expectedStatus = 'running'; // At least one task is actively running
  } else if (hasQueued) {
    expectedStatus = 'ready'; // Plan exists, tasks queued, none running yet
  } else if (allBlockedOrFailed) {
    expectedStatus = 'blocked';
  }

  if (expectedStatus === request.status) return null;
  if (!isValidRequestTransition(request.status, expectedStatus)) return null;

  return createCorrection({
    entityType: 'request',
    entityId: request.id,
    previousState: request.status,
    newState: expectedStatus,
    reason: `Recomputed from WorkItem statuses: ${JSON.stringify(countByStatus(statuses))}`,
    evidence: `${workItems.length} WorkItems: ${statuses.join(', ')}`,
  });
}

// ---------------------------------------------------------------------------
// Rule: Detect Orphan WorkItems
// ---------------------------------------------------------------------------

/**
 * Detects WorkItems whose parent has been cancelled/failed but are still active.
 * These should be cascade-cancelled.
 *
 * @param workItems - All WorkItems to check
 * @param workItemMap - Map of WorkItem ID → WorkItem for parent lookup
 * @returns Corrections for orphan WorkItems
 */
export function detectOrphanWorkItems(
  workItems: WorkItem[],
  workItemMap: Map<string, WorkItem>,
): { corrections: ReconcileCorrection[]; orphanIds: string[] } {
  const corrections: ReconcileCorrection[] = [];
  const orphanIds: string[] = [];

  for (const wi of workItems) {
    if (TERMINAL_WORK_ITEM_STATUSES.has(wi.status)) continue;
    if (!wi.parentWorkItemId) continue;

    const parent = workItemMap.get(wi.parentWorkItemId);
    if (!parent) continue;

    if (parent.status === 'cancelled' || parent.status === 'failed') {
      corrections.push(createCorrection({
        entityType: 'work_item',
        entityId: wi.id,
        previousState: wi.status,
        newState: 'cancelled',
        reason: `Parent WorkItem ${parent.id} is ${parent.status}`,
        evidence: `Cascade cancel: parent.status=${parent.status}, child.status=${wi.status}`,
      }));
      orphanIds.push(wi.id);
    }
  }

  return { corrections, orphanIds };
}

// ---------------------------------------------------------------------------
// Rule: Detect TTL-Expired WorkItems
// ---------------------------------------------------------------------------

/**
 * Detects WorkItems that have exceeded their time-to-live.
 * Default TTL is 24 hours.
 *
 * @param workItems - All non-terminal WorkItems to check
 * @param ttlMs - Maximum age before auto-cancel (default: 24h)
 * @returns Corrections for expired WorkItems
 */
export function detectTTLExpiredWorkItems(
  workItems: WorkItem[],
  ttlMs: number = 24 * 60 * 60 * 1000,
): { corrections: ReconcileCorrection[]; expiredIds: string[] } {
  const corrections: ReconcileCorrection[] = [];
  const expiredIds: string[] = [];
  const now = Date.now();

  for (const wi of workItems) {
    if (TERMINAL_WORK_ITEM_STATUSES.has(wi.status)) continue;

    const createdAt = new Date(wi.createdAt).getTime();
    const age = now - createdAt;

    if (age > ttlMs) {
      corrections.push(createCorrection({
        entityType: 'work_item',
        entityId: wi.id,
        previousState: wi.status,
        newState: 'cancelled',
        reason: `WorkItem exceeded TTL of ${Math.round(ttlMs / 3600000)}h`,
        evidence: `Created at ${wi.createdAt}, age=${Math.round(age / 3600000)}h`,
      }));
      expiredIds.push(wi.id);
    }
  }

  return { corrections, expiredIds };
}

// ---------------------------------------------------------------------------
// Rule: Recover Blocked WorkItems
// ---------------------------------------------------------------------------

/**
 * Detects blocked WorkItems whose assigned agent is now alive,
 * suggesting they can be re-queued for retry.
 *
 * @param workItems - All blocked WorkItems
 * @param agentHealthMap - Map of agent session → health info
 * @returns Corrections to re-queue recoverable WorkItems
 */
export function detectRecoverableWorkItems(
  workItems: WorkItem[],
  agentHealthMap: Map<string, AgentHealth>,
): { corrections: ReconcileCorrection[]; recoverableIds: string[] } {
  const corrections: ReconcileCorrection[] = [];
  const recoverableIds: string[] = [];

  for (const wi of workItems) {
    if (wi.status !== 'blocked') continue;
    if (wi.retryCount >= wi.maxRetries) continue;

    // If the agent is back online, re-queue
    if (wi.target) {
      const agent = agentHealthMap.get(wi.target);
      if (agent && agent.status === 'active') {
        corrections.push(createCorrection({
          entityType: 'work_item',
          entityId: wi.id,
          previousState: 'blocked',
          newState: 'queued',
          reason: `Agent ${wi.target} is back online, retry ${wi.retryCount + 1}/${wi.maxRetries}`,
          evidence: `Agent status: active, lastSeen=${agent.lastSeenAt ?? 'now'}`,
        }));
        recoverableIds.push(wi.id);
      }
    }
  }

  return { corrections, recoverableIds };
}

// ---------------------------------------------------------------------------
// Rule: Cascade Cancel Children (F4 enhancement)
// ---------------------------------------------------------------------------

/**
 * Performs deep cascade cancellation: when a WorkItem is cancelled/failed,
 * all descendants (children, grandchildren, etc.) should be cancelled too.
 * This is a recursive version of detectOrphanWorkItems.
 *
 * @param cancelledIds - Set of WorkItem IDs that have been cancelled/failed
 * @param allWorkItems - All WorkItems in the system
 * @returns Corrections for cascaded cancellations
 */
export function cascadeCancelChildren(
  cancelledIds: Set<string>,
  allWorkItems: WorkItem[],
): { corrections: ReconcileCorrection[]; cascadedIds: string[] } {
  const corrections: ReconcileCorrection[] = [];
  const cascadedIds: string[] = [];
  let changed = true;

  // Iterative approach: keep propagating until no new cancellations
  while (changed) {
    changed = false;
    for (const wi of allWorkItems) {
      if (TERMINAL_WORK_ITEM_STATUSES.has(wi.status)) continue;
      if (cascadedIds.includes(wi.id)) continue;
      if (!wi.parentWorkItemId) continue;

      if (cancelledIds.has(wi.parentWorkItemId) || cascadedIds.includes(wi.parentWorkItemId)) {
        corrections.push(createCorrection({
          entityType: 'work_item',
          entityId: wi.id,
          previousState: wi.status,
          newState: 'cancelled',
          reason: `Cascade cancel: ancestor WorkItem was cancelled/failed`,
          evidence: `parentWorkItemId=${wi.parentWorkItemId} is in cancelled set`,
        }));
        cascadedIds.push(wi.id);
        changed = true;
      }
    }
  }

  return { corrections, cascadedIds };
}

// ---------------------------------------------------------------------------
// Rule: Detect Stale Queued WorkItems (F4 enhancement)
// ---------------------------------------------------------------------------

/**
 * Detects WorkItems that have been in 'queued' status for too long
 * without being picked up. These may indicate assignment problems.
 *
 * @param workItems - All WorkItems to check
 * @param staleThresholdMs - How long in queued before considered stale (default: 1h)
 * @returns Corrections for stale queued WorkItems
 */
export function detectStaleQueuedWorkItems(
  workItems: WorkItem[],
  staleThresholdMs: number = 60 * 60 * 1000,
): { corrections: ReconcileCorrection[]; staleIds: string[] } {
  const corrections: ReconcileCorrection[] = [];
  const staleIds: string[] = [];
  const now = Date.now();

  for (const wi of workItems) {
    if (wi.status !== 'queued') continue;

    const createdAt = new Date(wi.createdAt).getTime();
    const waitTime = now - createdAt;

    if (waitTime > staleThresholdMs) {
      corrections.push(createCorrection({
        entityType: 'work_item',
        entityId: wi.id,
        previousState: 'queued',
        newState: 'queued', // Don't change status, just flag for audit
        reason: `WorkItem has been queued for ${Math.round(waitTime / 60000)} minutes without pickup`,
        evidence: `Created at ${wi.createdAt}, waiting for ${Math.round(waitTime / 60000)}m (threshold: ${Math.round(staleThresholdMs / 60000)}m)`,
      }));
      staleIds.push(wi.id);
    }
  }

  return { corrections, staleIds };
}

// ---------------------------------------------------------------------------
// Pruning Summary
// ---------------------------------------------------------------------------

/**
 * Result of a pruning pass, aggregating all pruning-related corrections.
 */
export interface PruningResult {
  /** WorkItems cancelled due to TTL expiry */
  ttlExpiredCount: number;
  /** WorkItems cancelled due to orphan cascade */
  orphanCancelledCount: number;
  /** WorkItems cancelled due to deep cascade */
  cascadeCancelledCount: number;
  /** WorkItems flagged as stale in queue */
  staleQueuedCount: number;
  /** Total corrections from pruning */
  totalCorrections: ReconcileCorrection[];
}

/**
 * Runs a complete pruning pass — combines TTL, orphan, cascade, and stale detection.
 * Called as part of the Reconciler's full loop every 5 minutes.
 *
 * @param allWorkItems - All WorkItems in the system
 * @param ttlMs - TTL threshold (default: 24h)
 * @param staleThresholdMs - Stale queue threshold (default: 1h)
 * @returns Aggregated pruning result
 */
export function runPruningPass(
  allWorkItems: WorkItem[],
  ttlMs: number = 24 * 60 * 60 * 1000,
  staleThresholdMs: number = 60 * 60 * 1000,
): PruningResult {
  const workItemMap = new Map(allWorkItems.map(wi => [wi.id, wi]));

  // 1. TTL expiry
  const ttl = detectTTLExpiredWorkItems(allWorkItems, ttlMs);

  // 2. Orphan detection
  const orphans = detectOrphanWorkItems(allWorkItems, workItemMap);

  // 3. Build cancelled set for cascade
  const cancelledIds = new Set<string>();
  for (const wi of allWorkItems) {
    if (wi.status === 'cancelled' || wi.status === 'failed') {
      cancelledIds.add(wi.id);
    }
  }
  // Include newly detected TTL + orphan IDs
  for (const id of ttl.expiredIds) cancelledIds.add(id);
  for (const id of orphans.orphanIds) cancelledIds.add(id);

  // 4. Deep cascade cancel
  const cascade = cascadeCancelChildren(cancelledIds, allWorkItems);

  // 5. Stale queue detection
  const stale = detectStaleQueuedWorkItems(allWorkItems, staleThresholdMs);

  return {
    ttlExpiredCount: ttl.expiredIds.length,
    orphanCancelledCount: orphans.orphanIds.length,
    cascadeCancelledCount: cascade.cascadedIds.length,
    staleQueuedCount: stale.staleIds.length,
    totalCorrections: [
      ...ttl.corrections,
      ...orphans.corrections,
      ...cascade.corrections,
      ...stale.corrections,
    ],
  };
}

// ---------------------------------------------------------------------------
// Rule: Detect Unclaimed Tasks (Hybrid Wake) — H3
// ---------------------------------------------------------------------------

/** Default threshold for unclaimed task detection (2 minutes). */
export const UNCLAIMED_THRESHOLD_MS = 2 * 60 * 1000;

/** Maximum number of wake actions per reconcile pass (rate limit). */
export const MAX_WAKE_ACTIONS_PER_PASS = 3;

/**
 * Result from the detectUnclaimedTasks rule.
 */
export interface UnclaimedTasksResult {
  /** Wake actions to execute */
  wakeActions: WakeAction[];
  /** WorkItem IDs that triggered wake actions */
  unclaimedWorkItemIds: string[];
}

/**
 * Detects WorkItems in 'queued' status that have gone unclaimed for longer
 * than the threshold, and selects the best dormant agent to wake.
 *
 * Selection algorithm scores agents by:
 *   skill_match (0–40) + urgency (0–30) + context_familiarity (0–20) - load_penalty (0–20)
 *
 * Wake strategy depends on agent status:
 *   - suspended → rehydrate (AgentSuspendService.rehydrateAgent())
 *   - inactive → start (start-agent API)
 *
 * @param workItems - All queued WorkItems in the pool
 * @param agentHealthMap - Map of agent session → health info
 * @param unclaimedThresholdMs - How long unclaimed before triggering wake (default: 2 min)
 * @returns Wake actions and affected WorkItem IDs
 */
export function detectUnclaimedTasks(
  workItems: WorkItem[],
  agentHealthMap: Map<string, AgentHealth>,
  unclaimedThresholdMs: number = UNCLAIMED_THRESHOLD_MS,
): UnclaimedTasksResult {
  const wakeActions: WakeAction[] = [];
  const unclaimedWorkItemIds: string[] = [];
  const now = Date.now();

  // Find agents that can be woken (suspended or inactive)
  const wakableAgents: AgentHealth[] = [];
  for (const agent of agentHealthMap.values()) {
    if (agent.status === 'suspended' || agent.status === 'inactive') {
      wakableAgents.push(agent);
    }
  }

  if (wakableAgents.length === 0) {
    return { wakeActions, unclaimedWorkItemIds };
  }

  // Check if there are ANY active agents — if yes, skip (they should claim work)
  let hasActiveAgent = false;
  for (const agent of agentHealthMap.values()) {
    if (agent.status === 'active') {
      hasActiveAgent = true;
      break;
    }
  }

  // Find unclaimed queued WorkItems past the threshold
  const unclaimedItems = workItems
    .filter(wi => {
      if (wi.status !== 'queued') return false;
      const createdAt = new Date(wi.createdAt).getTime();
      return (now - createdAt) > unclaimedThresholdMs;
    })
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (unclaimedItems.length === 0) {
    return { wakeActions, unclaimedWorkItemIds };
  }

  // If active agents exist but items are unclaimed, only wake if items have
  // been waiting significantly longer (5min) — active agents may be overloaded
  const effectiveThreshold = hasActiveAgent
    ? Math.max(unclaimedThresholdMs, 5 * 60 * 1000)
    : unclaimedThresholdMs;

  // Track which agents we've already decided to wake (avoid waking same agent twice)
  const agentsToWake = new Set<string>();

  for (const wi of unclaimedItems) {
    if (wakeActions.length >= MAX_WAKE_ACTIONS_PER_PASS) break;

    const createdAt = new Date(wi.createdAt).getTime();
    const waitTime = now - createdAt;

    if (hasActiveAgent && waitTime < effectiveThreshold) continue;

    // Score each wakable agent for this WorkItem
    const bestAgent = selectBestAgent(wi, wakableAgents, waitTime, agentsToWake);
    if (!bestAgent) continue;

    const strategy: WakeStrategy = bestAgent.agent.status === 'suspended'
      ? 'rehydrate'
      : 'start';

    wakeActions.push({
      workItemId: wi.id,
      agentSessionName: bestAgent.agent.sessionName,
      strategy,
      score: bestAgent.score,
      scoreBreakdown: bestAgent.breakdown,
      triggeredAt: new Date().toISOString(),
    });

    unclaimedWorkItemIds.push(wi.id);
    agentsToWake.add(bestAgent.agent.sessionName);
  }

  return { wakeActions, unclaimedWorkItemIds };
}

/**
 * Scores and selects the best agent to handle a WorkItem.
 *
 * Score = skill_match (0–40) + urgency (0–30) + context_familiarity (0–20) - load_penalty (0–20)
 *
 * @param workItem - The WorkItem needing an agent
 * @param agents - Candidate agents (suspended or inactive)
 * @param waitTimeMs - How long the WorkItem has been waiting
 * @param excludeAgents - Agents already scheduled for wake in this pass
 * @returns Best agent with score, or null if no suitable agent
 */
export function selectBestAgent(
  workItem: WorkItem,
  agents: AgentHealth[],
  waitTimeMs: number,
  excludeAgents: Set<string> = new Set(),
): { agent: AgentHealth; score: number; breakdown: AgentScoreBreakdown } | null {
  let bestResult: { agent: AgentHealth; score: number; breakdown: AgentScoreBreakdown } | null = null;

  for (const agent of agents) {
    if (excludeAgents.has(agent.sessionName)) continue;

    const breakdown = computeAgentScore(workItem, agent, waitTimeMs);
    const score = breakdown.skillMatch + breakdown.urgency + breakdown.contextFamiliarity - breakdown.loadPenalty;

    if (score <= 0) continue;

    if (!bestResult || score > bestResult.score) {
      bestResult = { agent, score, breakdown };
    }
  }

  return bestResult;
}

/**
 * Computes the score breakdown for a single agent–WorkItem pair.
 *
 * @param workItem - The WorkItem being matched
 * @param agent - The candidate agent
 * @param waitTimeMs - How long the WorkItem has been waiting
 * @returns Score breakdown
 */
export function computeAgentScore(
  workItem: WorkItem,
  agent: AgentHealth,
  waitTimeMs: number,
): AgentScoreBreakdown {
  // --- Skill Match (0–40) ---
  let skillMatch = 10; // Base score: any agent gets 10

  // If WorkItem has a specific target that matches this agent
  if (workItem.target && workItem.target === agent.sessionName) {
    skillMatch = 40; // Perfect match
  } else if (agent.tags && agent.tags.length > 0) {
    // Check tag overlap with WorkItem type and title
    const wiKeywords = extractKeywords(workItem);
    const matchCount = agent.tags.filter(tag =>
      wiKeywords.some(kw => kw.toLowerCase().includes(tag.toLowerCase()) || tag.toLowerCase().includes(kw.toLowerCase()))
    ).length;
    skillMatch = Math.min(40, 10 + matchCount * 10);
  } else if (agent.role === 'developer') {
    // Developers are generic workers — moderate match for delegate/project_task
    if (workItem.type === 'delegate' || workItem.type === 'project_task') {
      skillMatch = 25;
    }
  }

  // --- Urgency (0–30) ---
  // Scale linearly: 2min wait = 0, 10min+ = 30
  const urgencyMinutes = waitTimeMs / 60_000;
  const urgency = Math.min(30, Math.max(0, Math.round((urgencyMinutes - 2) * 3.75)));

  // --- Context Familiarity (0–20) ---
  let contextFamiliarity = 0;

  // If agent previously had this WorkItem assigned (target match = familiarity)
  if (workItem.target && workItem.target === agent.sessionName) {
    contextFamiliarity = 20;
  }
  // Same team = some familiarity
  else if (agent.teamId && workItem.owner === 'agent') {
    contextFamiliarity = 5;
  }

  // --- Load Penalty (0–20) ---
  const activeCount = agent.activeWorkItemCount ?? 0;
  const loadPenalty = Math.min(20, activeCount * 5);

  return { skillMatch, urgency, contextFamiliarity, loadPenalty };
}

/**
 * Extracts searchable keywords from a WorkItem for tag matching.
 *
 * @param workItem - WorkItem to extract keywords from
 * @returns Array of lowercase keywords
 */
function extractKeywords(workItem: WorkItem): string[] {
  const words: string[] = [workItem.type];
  if (workItem.title) {
    words.push(...workItem.title.toLowerCase().split(/[\s\-_/]+/).filter(w => w.length > 2));
  }
  if (workItem.owner) {
    words.push(workItem.owner);
  }
  return words;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Counts WorkItem statuses into a summary object.
 *
 * @param statuses - Array of status strings
 * @returns Object with status counts
 */
function countByStatus(statuses: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of statuses) {
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return counts;
}
