/**
 * Stalled-agent detection (CREW-303).
 *
 * A team member with queued work that nobody progresses must be recovered
 * by the harness, not by the owner noticing. On 2026-10-06 the CE lead's
 * session was down from 12:29 to 17:50Z with verify work queued for it, and
 * a developer stopped mid-ticket twice; nothing restarted either until the
 * owner happened to approve something unrelated.
 *
 * It also covers work a STOPPED agent still HOLDS (running / accepted /
 * proposed, or blocked by its outage): on 2026-10-07 Nova's start for ticket
 * CE-206 failed while the ticket's WorkItem was already claimed for her, so
 * nothing was queued, and this recovery — which only looked at queued work —
 * never fired. The owner noticed an hour later.
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
import { hasUnresolvedDependencies, isHousekeepingWorkItem } from './reconcile-rules.js';
import { isExplicitlyBlocked, isWaitingOnHumanBlocked } from '../../types/v2/work-item.types.js';
import { isSessionPaused, isTeamIdPaused } from '../team/team-pause.registry.js';
import { isOwnerStopped } from '../agent/owner-stopped.registry.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

/**
 * How an agent is stalled:
 * - `stopped` — no session (inactive / suspended) while work waits for it or
 *   it still holds work
 * - `hung`    — the session claims work but never heartbeats (ClaimService)
 * - `idle`    — the session is up, holds nothing, and shows no activity
 */
export type StallKind = 'stopped' | 'hung' | 'idle';

/** One stalled agent and the work it is sitting on. */
export interface StalledAgent {
  sessionName: string;
  kind: StallKind;
  /** The oldest queued WorkItem waiting for it, else the oldest work it holds */
  workItem: WorkItem;
  /** How long that WorkItem has waited: queued, or held by the stopped agent (ms) */
  queuedForMs: number;
  /** Number of queued WorkItems waiting for it */
  queuedCount: number;
  /** Number of WorkItems a stopped agent still holds (0 for other kinds) */
  heldCount: number;
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
  /**
   * A stopped agent still holding work is stalled once both the work and the
   * agent's stop are at least this old (ms). Omitted = held work is ignored.
   */
  heldStoppedMs?: number;
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

/** WorkItem statuses in which the target agent holds the work. */
const HELD_STATUSES: ReadonlySet<WorkItem['status']> = new Set<WorkItem['status']>(['running', 'accepted', 'proposed']);

/**
 * Whether a WorkItem is held by its target: in progress, or blocked only
 * because that agent dropped out (not an explicit block, not waiting on a
 * human, not waiting on a dependency).
 *
 * @param wi - WorkItem
 * @param byId - Active WorkItems by id (dependency check)
 * @returns True when its target holds it
 */
function isHeldWork(wi: WorkItem, byId: ReadonlyMap<string, WorkItem>): boolean {
  if (HELD_STATUSES.has(wi.status)) return true;
  if (wi.status !== 'blocked') return false;
  return !isExplicitlyBlocked(wi) && !isWaitingOnHumanBlocked(wi) && !hasUnresolvedDependencies(wi, byId);
}

/** Oldest-first tally of one agent's WorkItems. */
interface WorkTally {
  oldest: WorkItem;
  since: number;
  count: number;
}

/** Add a WorkItem to a per-target tally, keeping the oldest. */
function tally(map: Map<string, WorkTally>, target: string, wi: WorkItem, since: number): void {
  const entry = map.get(target);
  if (!entry) {
    map.set(target, { oldest: wi, since, count: 1 });
    return;
  }
  entry.count += 1;
  if (since < entry.since) {
    entry.oldest = wi;
    entry.since = since;
  }
}

/**
 * Find agents whose queued work has waited past the threshold while their
 * session is stopped, hung, or idle without progressing it — and stopped
 * agents still holding work past `heldStoppedMs`.
 *
 * Not stalled (left alone): the orchestrator (it has its own heartbeat
 * monitor), paused teams, agents someone stopped on purpose, agents still
 * starting, an agent sitting on a prompt for the owner, an agent holding a
 * claim or mid-turn (it is working on something), an awake agent with no
 * recorded activity, and housekeeping work (never a reason to start an agent).
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
  const byId = new Map(workItems.map((w) => [w.id, w]));
  const waiting = new Map<string, WorkTally>();
  const held = new Map<string, WorkTally>();
  for (const wi of workItems) {
    if (!wi.target || isHousekeepingWorkItem(wi)) continue;
    const since = queuedSince(wi);
    if (!Number.isFinite(since)) continue;
    if (wi.status === 'queued') {
      if (opts.now - since >= opts.queuedAgeMs) tally(waiting, wi.target, wi, since);
    } else if (opts.heldStoppedMs !== undefined && isHeldWork(wi, byId)) {
      tally(held, wi.target, wi, since);
    }
  }

  const stalled: StalledAgent[] = [];
  for (const sessionName of new Set([...waiting.keys(), ...held.keys()])) {
    if (sessionName === ORCHESTRATOR_SESSION_NAME) continue;
    const agent = agentHealthMap.get(sessionName);
    if (!agent) continue;
    if (isTeamIdPaused(agent.teamId) || isSessionPaused(sessionName)) continue;
    const queued = waiting.get(sessionName);

    let kind: StallKind | null = null;
    let holding: WorkTally | undefined;
    if (agent.status === 'inactive' || agent.status === 'suspended') {
      // A stop is a decision: an agent stopped on purpose is not restarted.
      if (isOwnerStopped(sessionName)) continue;
      holding = heldPastThreshold(held.get(sessionName), agent, opts);
      if (queued || holding) kind = 'stopped';
    } else if (agent.status === 'active' && queued) {
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

    const first = queued ?? holding!;
    stalled.push({
      sessionName,
      kind,
      workItem: first.oldest,
      queuedForMs: opts.now - first.since,
      queuedCount: queued?.count ?? 0,
      heldCount: holding?.count ?? 0,
      ...(agent.role ? { role: agent.role } : {}),
      ...(agent.teamId ? { teamId: agent.teamId } : {}),
      ...(agent.memberId ? { memberId: agent.memberId } : {}),
    });
  }
  return stalled.sort((a, b) => b.queuedForMs - a.queuedForMs);
}

/**
 * The work a stopped agent holds, when both the work and the stop are older
 * than the threshold. The stop is dated by the agent's last-seen time (its
 * member record's last update); unknown counts as old.
 *
 * @param entry - The agent's held work, if any
 * @param agent - Agent health
 * @param opts - Thresholds
 * @returns The tally when past the threshold, else undefined
 */
function heldPastThreshold(entry: WorkTally | undefined, agent: AgentHealth, opts: StallDetectionOptions): WorkTally | undefined {
  if (!entry || opts.heldStoppedMs === undefined) return undefined;
  if (opts.now - entry.since < opts.heldStoppedMs) return undefined;
  const lastSeen = Date.parse(agent.lastSeenAt ?? '');
  if (Number.isFinite(lastSeen) && opts.now - lastSeen < opts.heldStoppedMs) return undefined;
  return entry;
}
