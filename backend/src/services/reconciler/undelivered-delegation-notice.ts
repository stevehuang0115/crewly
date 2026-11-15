/**
 * Tell a delegator, once, that the work it handed to a teammate has not
 * reached that teammate.
 *
 * A delegation to an agent that is not running answers "queued": the brief
 * waits on the agent's message queue and the agent is started. Nothing told
 * the delegator when that start did not happen or the brief never landed.
 * On 2026-11-14 a lead told the owner "handed to Juno" while Juno was
 * stopped; the pool item stayed `queued`, and the owner found out 68 minutes
 * later by asking.
 *
 * A delegated WorkItem carries
 * {@link DIRECT_DELIVERY_CONSTANTS.DELIVERED_AT_KEY} once its brief reached
 * the target's running session. One that is still `queued` without it after
 * {@link RECONCILER_WAKE_CONSTANTS.UNDELIVERED_DELEGATION_NOTICE_AFTER_MS}
 * puts a review WorkItem on the delegator, naming the item and the target.
 * The reconciler's wake keeps trying to start the target meanwhile.
 *
 * @module services/reconciler/undelivered-delegation-notice
 */

import { DIRECT_DELIVERY_CONSTANTS, PROJECT_TICKET_CONSTANTS, RECONCILER_WAKE_CONSTANTS } from '../../constants.js';
import type { Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { IdleHolderSurfacerDeps } from './idle-holder-surfacer.js';

const C = RECONCILER_WAKE_CONSTANTS;

/** Id suffix of the notice (one per delegated item). */
const REVIEW_ID_SUFFIX = ':review:undelivered_delegation';

/** One delegation whose brief has not reached its target. */
export interface UndeliveredDelegation {
  /** The queued, delegated WorkItem */
  workItem: WorkItem;
  /** The session that delegated it */
  delegator: string;
  /** The session it was delegated to */
  target: string;
  /** How long it has waited since it was created (ms) */
  waitedMs: number;
}

/**
 * The session that delegated a WorkItem, as the delegating skill stamped it.
 *
 * @param wi - WorkItem
 * @returns Session name, or null when nobody is named
 */
function delegatorOf(wi: WorkItem): string | null {
  const raw = wi.metadata?.[PROJECT_TICKET_CONSTANTS.DELEGATION_CALLER_METADATA_KEY];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * Delegated WorkItems that are still queued and whose brief has not reached
 * the target's running session, old enough to report and not reported yet.
 *
 * @param workItems - Pool items (any status)
 * @param now - Current time (epoch ms)
 * @param afterMs - Age at which an undelivered delegation is reported
 * @param maxAgeMs - Age past which it is no longer reported
 * @returns The delegations to report, oldest first
 */
export function findUndeliveredDelegations(
  workItems: ReadonlyArray<WorkItem>,
  now: number,
  afterMs: number = C.UNDELIVERED_DELEGATION_NOTICE_AFTER_MS,
  maxAgeMs: number = C.UNDELIVERED_DELEGATION_NOTICE_MAX_AGE_MS,
): UndeliveredDelegation[] {
  const out: UndeliveredDelegation[] = [];
  for (const wi of workItems) {
    if (wi.status !== 'queued' || !wi.target) continue;
    const delegator = delegatorOf(wi);
    if (!delegator || delegator === wi.target) continue;
    if (wi.metadata?.[DIRECT_DELIVERY_CONSTANTS.DELIVERED_AT_KEY]) continue;
    if (wi.metadata?.[C.UNDELIVERED_DELEGATION_NOTICED_AT_KEY]) continue;
    const createdAt = Date.parse(wi.createdAt);
    if (!Number.isFinite(createdAt)) continue;
    const waitedMs = now - createdAt;
    if (waitedMs < afterMs || waitedMs > maxAgeMs) continue;
    out.push({ workItem: wi, delegator, target: wi.target, waitedMs });
  }
  return out.sort((a, b) => b.waitedMs - a.waitedMs);
}

/**
 * The review WorkItem that reports one undelivered delegation.
 *
 * @param d - The undelivered delegation
 * @param targetState - What is known about the target ("not running", "running"), if anything
 * @param team - The target's team, if known
 * @param now - Current time
 * @returns The review WorkItem (id is stable, so adding it twice is one item)
 */
export function buildUndeliveredDelegationNotice(
  d: UndeliveredDelegation,
  targetState: string | undefined,
  team: Team | null,
  now: Date,
): WorkItem {
  const id = `${d.workItem.id}${REVIEW_ID_SUFFIX}`;
  const name = (d.workItem.title ?? '').split('\n')[0].slice(0, 80);
  const minutes = Math.max(1, Math.round(d.waitedMs / 60_000));
  const state = targetState ? ` \`${d.target}\` is ${targetState}.` : '';
  return {
    id,
    type: 'review',
    owner: 'team_lead',
    target: d.delegator,
    title: `Not delivered to ${d.target}${name ? `: ${name}` : ''}`,
    description: [
      `WorkItem \`${d.workItem.id}\` that you delegated to \`${d.target}\` ${minutes} min ago has not been delivered: its brief has not reached a running session of \`${d.target}\`.${state}`,
      `Crewly keeps trying to start \`${d.target}\` and deliver it. Nobody is working on it yet, so do not report it as handed over or in progress. If someone is waiting on this work, tell them it is queued for \`${d.target}\` and not picked up yet; then check why \`${d.target}\` is not running, or delegate it to someone who is.`,
    ].join('\n'),
    status: 'queued',
    createdAt: now.toISOString(),
    retryCount: 0,
    maxRetries: 1,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    metadata: {
      ...(team ? { teamId: team.id } : {}),
      idempotencyKey: id,
      reviewReason: 'undelivered_delegation',
      sourceWorkItemId: d.workItem.id,
    },
  } as WorkItem;
}

/**
 * Report one undelivered delegation to its delegator and mark the delegated
 * item as reported, so it is said once.
 *
 * @param d - The undelivered delegation
 * @param targetState - What is known about the target, if anything
 * @param deps - Teams, pool and metadata stamp
 * @returns The review WorkItem that was queued
 */
export async function surfaceUndeliveredDelegation(
  d: UndeliveredDelegation,
  targetState: string | undefined,
  deps: IdleHolderSurfacerDeps,
): Promise<WorkItem> {
  const now = deps.now?.() ?? new Date();
  const teams = await deps.loadTeams().catch(() => [] as Team[]);
  const team = teams.find((t) => (t.members ?? []).some((m) => m.sessionName === d.target)) ?? null;
  const review = buildUndeliveredDelegationNotice(d, targetState, team, now);
  await deps.addToPool(review);
  await deps.stamp(d.workItem.id, { [C.UNDELIVERED_DELEGATION_NOTICED_AT_KEY]: now.toISOString() });
  return review;
}
