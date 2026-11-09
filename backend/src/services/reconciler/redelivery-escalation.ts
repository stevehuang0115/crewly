/**
 * Tell a team lead, once, that a queued WorkItem's brief keeps failing to
 * reach its target (CREW-577).
 *
 * The reconciler already backs a failing redelivery off (CREW-304), but
 * nothing said so to a person: CE-282 sat queued for 1h7m after six failed
 * redeliveries with only warning logs. After
 * {@link RECONCILER_WAKE_CONSTANTS.REDELIVERY_ESCALATE_AFTER} consecutive
 * failures this puts a review WorkItem on the target's lead (the
 * orchestrator when the target leads its own team or has none), naming the
 * item, the target and the reason. Waiting, memory-stop and offline-network
 * holds are never "failed" wakes, so they never reach this.
 *
 * @module services/reconciler/redelivery-escalation
 */

import { ORCHESTRATOR_SESSION_NAME, RECONCILER_WAKE_CONSTANTS } from '../../constants.js';
import type { Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { pickTeamLead } from '../../utils/team.utils.js';
import type { IdleHolderSurfacerDeps } from './idle-holder-surfacer.js';

const C = RECONCILER_WAKE_CONSTANTS;

/** Id suffix of the escalation review (one per source item). */
const REVIEW_ID_SUFFIX = ':review:redelivery_miss';

/** One redelivery that keeps failing. */
export interface RedeliveryMiss {
  /** The queued WorkItem */
  workItemId: string;
  /** Its target session (the agent the brief cannot reach) */
  session: string;
  /** Consecutive failed redeliveries so far */
  attempts: number;
  /** Why the last one failed, as the dispatcher reported it */
  reason?: string;
}

/**
 * The review WorkItem that reports one failing redelivery.
 *
 * @param miss - The failing redelivery
 * @param title - The source item's title, when known
 * @param team - The target's team, if known
 * @param now - Current time
 * @returns The review WorkItem (id is stable, so adding it twice is one item)
 */
export function buildRedeliveryEscalation(miss: RedeliveryMiss, title: string | undefined, team: Team | null, now: Date): WorkItem {
  const lead = team ? pickTeamLead(team) : null;
  const target = lead?.sessionName && lead.sessionName !== miss.session ? lead.sessionName : ORCHESTRATOR_SESSION_NAME;
  const id = `${miss.workItemId}${REVIEW_ID_SUFFIX}`;
  const name = (title ?? '').split('\n')[0].slice(0, 80);
  const reason = (miss.reason ?? 'no reason given').replace(/\s+/g, ' ').slice(0, C.REDELIVERY_REASON_MAX_CHARS);
  return {
    id,
    type: 'review',
    owner: 'team_lead',
    target,
    title: `Brief not reaching ${miss.session}${name ? `: ${name}` : ''}`,
    description: [
      `WorkItem \`${miss.workItemId}\` is still queued for \`${miss.session}\`. ${miss.attempts} redeliveries in a row did not reach it. Last reason: ${reason}.`,
      'Crewly keeps retrying with a growing wait, but nothing else will tell you. Check whether the agent is stopped, over its usage or budget cap, or paused; then restart it, lift the cap, or re-assign the item.',
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
      reviewReason: 'redelivery_miss',
      sourceWorkItemId: miss.workItemId,
    },
  } as WorkItem;
}

/**
 * Report one failing redelivery to its target's lead.
 *
 * @param miss - The failing redelivery
 * @param deps - Teams, pool and (optionally) a WorkItem reader
 * @returns The review WorkItem that was queued
 */
export async function surfaceRedeliveryMiss(miss: RedeliveryMiss, deps: IdleHolderSurfacerDeps): Promise<WorkItem> {
  const teams = await deps.loadTeams().catch(() => [] as Team[]);
  const team = teams.find((t) => (t.members ?? []).some((m) => m.sessionName === miss.session)) ?? null;
  const source = await deps.findWorkItem?.(miss.workItemId).catch(() => null);
  const review = buildRedeliveryEscalation(miss, source?.title, team, deps.now?.() ?? new Date());
  await deps.addToPool(review);
  return review;
}
