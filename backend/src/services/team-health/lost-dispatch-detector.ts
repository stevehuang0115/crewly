/**
 * Lost-Dispatch Detector — Cases #5/#6/#7 (post-SEALED amendment 2026-04-25)
 *
 * Sam (TL) identified three additional silent-failure data points on
 * 2026-04-25: agent restarts that dropped a freshly-dispatched WorkItem
 * with no follow-up. Common signature: dispatch sent → target agent
 * restarted → no acknowledgement reply → WorkItem stuck at `proposed`/
 * `accepted` indefinitely.
 *
 * This detector flags those WorkItems using ONLY existing snapshot
 * fields (no new data sources, no schema cost):
 *
 *   lost_dispatch(wi) :=
 *     wi.status ∈ {proposed, accepted}
 *     ∧ now - wi.createdAt > LOST_DISPATCH_T1_MS  (no follow-up window)
 *     ∧ target agent.lastSeenAt > wi.createdAt    (agent alive since dispatch)
 *     ∧ wi.startedAt is undefined                 (never moved to running)
 *
 * Strictly speaking this is a scope amendment to the SEALED design (which
 * specified rules in §B.2/§B.4/§B.5 only). The amendment is gated behind
 * `lostDispatchDetection.enabled` so v0 can be reverted to the literal
 * sealed scope by setting the flag false. Default is `true` because the
 * three real cases occurred in the same operating window the design
 * was sealed in.
 *
 * @module services/team-health/lost-dispatch-detector
 */

import type { WorkItem } from '../../types/v2/index.js';
import type {
  AgentWorkingStatus,
  LostDispatchConfig,
} from './team-health-types.js';
import type { AgentHealth } from '../reconciler/reconcile-rules.js';

/**
 * Identify the set of WorkItem IDs that look like lost dispatches.
 *
 * @param workItems - All active WorkItems being evaluated
 * @param agentHealth - Per-session health (provides lastSeenAt)
 * @param now - Current wall-clock time
 * @param config - Detector config (enabled flag + thresholds)
 * @returns Set of WorkItem IDs flagged as lost dispatches
 */
export function detectLostDispatches(
  workItems: WorkItem[],
  agentHealth: ReadonlyMap<string, AgentHealth & { workingStatus?: AgentWorkingStatus }>,
  now: Date,
  config: LostDispatchConfig,
): Set<string> {
  const out = new Set<string>();
  if (!config.enabled) return out;

  const nowMs = now.getTime();

  for (const wi of workItems) {
    if (wi.status !== 'proposed' && wi.status !== 'accepted') continue;
    // If the WorkItem ever transitioned to running, it's not a lost dispatch.
    if (wi.startedAt) continue;
    const target = wi.target;
    if (!target) continue;

    const createdMs = new Date(wi.createdAt).getTime();
    const ageMs = nowMs - createdMs;
    if (ageMs < config.T1Ms) continue; // Too fresh — give it normal latency.

    const agent = agentHealth.get(target);
    if (!agent || !agent.lastSeenAt) continue;

    const lastSeenMs = new Date(agent.lastSeenAt).getTime();
    // Agent has been seen since dispatch ⇒ they should have acted on it.
    // We require lastSeen to be after the dispatch by at least
    // postRestartGraceMs to avoid double-counting fresh dispatches the
    // agent simply hasn't gotten to yet.
    if (lastSeenMs <= createdMs) continue;
    const postSeenMs = lastSeenMs - createdMs;
    if (postSeenMs < config.postRestartGraceMs) continue;

    out.add(wi.id);
  }
  return out;
}

/**
 * Build a human-readable evidence string for one lost-dispatch WorkItem.
 *
 * @param wi - WorkItem flagged as lost dispatch
 * @param agentHealth - Agent health map (for the target's lastSeenAt)
 * @returns Multi-line evidence string
 */
export function describeLostDispatchEvidence(
  wi: WorkItem,
  agentHealth: ReadonlyMap<string, AgentHealth & { workingStatus?: AgentWorkingStatus }>,
): string {
  const lines: string[] = [];
  lines.push(`• WorkItem dispatched at ${wi.createdAt} (status=${wi.status})`);
  const agent = wi.target ? agentHealth.get(wi.target) : undefined;
  if (agent?.lastSeenAt) {
    lines.push(
      `• Target ${wi.target} was alive at ${agent.lastSeenAt} but never moved the WorkItem to running`,
    );
  }
  return lines.join('\n');
}
