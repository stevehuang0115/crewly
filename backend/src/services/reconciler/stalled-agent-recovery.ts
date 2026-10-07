/**
 * Stalled-agent detection (CREW-303).
 *
 * A team member with queued work that nobody progresses must be recovered
 * by the harness, not by the owner noticing. On 2026-10-06 the CE lead's
 * session was down from 12:29 to 17:50Z with verify work queued for it, and
 * a developer stopped mid-ticket twice; nothing restarted either until the
 * owner happened to approve something unrelated.
 *
 * This module is pure: it decides WHO is stalled and HOW. The reconciler
 * acts on the result (one recovery per session per cooldown, one
 * `harness.recover` trace each) and every start still goes through the
 * normal start path, so the running-agent cap and the team gates apply.
 *
 * @module services/reconciler/stalled-agent-recovery
 */

import type { WorkItem } from '../../types/v2/index.js';
import type { AgentHealth } from './reconcile-rules.js';
import { isHousekeepingWorkItem } from './reconcile-rules.js';
import { isSessionPaused, isTeamIdPaused } from '../team/team-pause.registry.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

/**
 * How an agent is stalled:
 * - `stopped` — no session (inactive / suspended) while work waits for it
 * - `hung`    — the session claims work but never heartbeats (ClaimService)
 * - `idle`    — the session is up, holds nothing, and shows no activity
 */
export type StallKind = 'stopped' | 'hung' | 'idle';

/** One stalled agent and the work it is sitting on. */
export interface StalledAgent {
  sessionName: string;
  kind: StallKind;
  /** The oldest queued WorkItem waiting for it */
  workItem: WorkItem;
  /** How long that WorkItem has been queued (ms) */
  queuedForMs: number;
  /** Number of queued WorkItems waiting for it */
  queuedCount: number;
  role?: string;
  teamId?: string;
  memberId?: string;
}

/** Thresholds and live signals for {@link detectStalledAgents}. */
export interface StallDetectionOptions {
  /** Clock (epoch ms) */
  now: number;
  /** Queued work at least this old marks its target as stalled (ms) */
  queuedAgeMs: number;
  /** An awake agent counts as idle-not-progressing after this long without activity (ms) */
  idleNoProgressMs: number;
  /** Sessions the claim service reports as hung */
  hungSessions?: ReadonlySet<string>;
}

/**
 * When a WorkItem started waiting in the queue (its last status change, or
 * its creation).
 *
 * @param wi - WorkItem
 * @returns Epoch ms, or NaN when unknown
 */
function queuedSince(wi: WorkItem): number {
  return Date.parse(wi.statusChangedAt ?? wi.createdAt);
}

/**
 * Find agents whose queued work has waited past the threshold while their
 * session is stopped, hung, or idle without progressing it.
 *
 * Not stalled (left alone): the orchestrator (it has its own heartbeat
 * monitor), paused teams, agents still starting, an agent sitting on a
 * prompt for the owner, an agent holding a claim or mid-turn (it is working
 * on something), an awake agent with no recorded activity, and housekeeping work (never a reason to start an agent).
 *
 * @param workItems - Active WorkItems
 * @param agentHealthMap - Agent health by session
 * @param opts - Thresholds and the hung-session signal
 * @returns Stalled agents, oldest wait first
 */
export function detectStalledAgents(
  workItems: ReadonlyArray<WorkItem>,
  agentHealthMap: ReadonlyMap<string, AgentHealth>,
  opts: StallDetectionOptions,
): StalledAgent[] {
  const waiting = new Map<string, { oldest: WorkItem; since: number; count: number }>();
  for (const wi of workItems) {
    if (wi.status !== 'queued' || !wi.target) continue;
    if (isHousekeepingWorkItem(wi)) continue;
    const since = queuedSince(wi);
    if (!Number.isFinite(since) || opts.now - since < opts.queuedAgeMs) continue;
    const entry = waiting.get(wi.target);
    if (!entry) waiting.set(wi.target, { oldest: wi, since, count: 1 });
    else {
      entry.count += 1;
      if (since < entry.since) {
        entry.oldest = wi;
        entry.since = since;
      }
    }
  }

  const stalled: StalledAgent[] = [];
  for (const [sessionName, entry] of waiting) {
    if (sessionName === ORCHESTRATOR_SESSION_NAME) continue;
    const agent = agentHealthMap.get(sessionName);
    if (!agent) continue;
    if (isTeamIdPaused(agent.teamId) || isSessionPaused(sessionName)) continue;

    let kind: StallKind | null = null;
    if (agent.status === 'inactive' || agent.status === 'suspended') {
      kind = 'stopped';
    } else if (agent.status === 'active') {
      if (agent.waitingOnHumanSince) continue;
      if (opts.hungSessions?.has(sessionName)) {
        kind = 'hung';
      } else if ((agent.activeWorkItemCount ?? 0) === 0 && !agent.midTurn) {
        // Only on seen inactivity: with no activity recorded (e.g. right after
        // a backend restart) an awake agent is never restarted on a guess.
        const lastActive = Date.parse(agent.lastActivityAt ?? '');
        if (Number.isFinite(lastActive) && opts.now - lastActive >= opts.idleNoProgressMs) kind = 'idle';
      }
    }
    if (!kind) continue;

    stalled.push({
      sessionName,
      kind,
      workItem: entry.oldest,
      queuedForMs: opts.now - entry.since,
      queuedCount: entry.count,
      ...(agent.role ? { role: agent.role } : {}),
      ...(agent.teamId ? { teamId: agent.teamId } : {}),
      ...(agent.memberId ? { memberId: agent.memberId } : {}),
    });
  }
  return stalled.sort((a, b) => b.queuedForMs - a.queuedForMs);
}
