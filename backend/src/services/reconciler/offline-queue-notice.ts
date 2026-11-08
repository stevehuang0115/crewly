/**
 * Tell a team lead, once, that an agent's queued work is waiting behind an
 * offline machine (CREW-862).
 *
 * While the machine is offline the reconciler holds every wake ("network
 * offline" is skipped, never failed), so nothing traced it and nothing told a
 * person: a CE queue sat about 15 hours, 2026-10-24 13:04 to 10-25 04:02,
 * with only "waiting on agent" in the trace. After
 * {@link RECONCILER_WAKE_CONSTANTS.OFFLINE_QUEUE_NOTICE_AFTER_MS} this puts a
 * review WorkItem on the agent's lead (the orchestrator when the agent leads
 * its own team or has none), naming the agent, the count and how long the
 * oldest item and the outage have lasted.
 *
 * @module services/reconciler/offline-queue-notice
 */

import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import type { Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { pickTeamLead } from '../../utils/team.utils.js';
import type { IdleHolderSurfacerDeps } from './idle-holder-surfacer.js';

/** Id suffix of the notice (one per oldest queued item). */
const REVIEW_ID_SUFFIX = ':review:offline_queue';

/** One agent whose queue waits behind an offline machine. */
export interface OfflineQueue {
  /** The agent's session */
  session: string;
  /** Its oldest queued WorkItem */
  workItemId: string;
  /** Queued WorkItems waiting for it */
  queuedCount: number;
  /** How long the oldest has waited (ms) */
  queuedForMs: number;
  /** How long the machine has been offline (minutes), when known */
  offlineMinutes?: number;
}

/**
 * The review WorkItem that reports one waiting queue.
 *
 * @param q - The waiting queue
 * @param title - The oldest item's title, when known
 * @param team - The agent's team, if known
 * @param now - Current time
 * @returns The review WorkItem (id is stable, so adding it twice is one item)
 */
export function buildOfflineQueueNotice(q: OfflineQueue, title: string | undefined, team: Team | null, now: Date): WorkItem {
  const lead = team ? pickTeamLead(team) : null;
  const target = lead?.sessionName && lead.sessionName !== q.session ? lead.sessionName : ORCHESTRATOR_SESSION_NAME;
  const id = `${q.workItemId}${REVIEW_ID_SUFFIX}`;
  const name = (title ?? '').split('\n')[0].slice(0, 80);
  const hours = (ms: number): string => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);
  const outage = q.offlineMinutes !== undefined ? ` The machine has been offline for ${hours(q.offlineMinutes * 60_000)}.` : '';
  return {
    id,
    type: 'review',
    owner: 'team_lead',
    target,
    title: `Work waiting for ${q.session}: its machine is offline${name ? ` (${name})` : ''}`,
    description: [
      `${q.queuedCount} queued work item(s) are waiting for \`${q.session}\`; the oldest, \`${q.workItemId}\`, has waited ${hours(q.queuedForMs)}.${outage}`,
      'Crewly holds wakes while a machine is offline and delivers the work when it is back; nothing is lost. If this cannot wait, re-assign the item to an agent on a machine that is online.',
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
      reviewReason: 'offline_queue',
      sourceWorkItemId: q.workItemId,
    },
  } as WorkItem;
}

/**
 * Report one waiting queue to its agent's lead.
 *
 * @param q - The waiting queue
 * @param deps - Teams, pool and (optionally) a WorkItem reader
 * @returns The review WorkItem that was queued
 */
export async function surfaceOfflineQueue(q: OfflineQueue, deps: IdleHolderSurfacerDeps): Promise<WorkItem> {
  const teams = await deps.loadTeams().catch(() => [] as Team[]);
  const team = teams.find((t) => (t.members ?? []).some((m) => m.sessionName === q.session)) ?? null;
  const source = await deps.findWorkItem?.(q.workItemId).catch(() => null);
  const review = buildOfflineQueueNotice(q, source?.title, team, deps.now?.() ?? new Date());
  await deps.addToPool(review);
  return review;
}
