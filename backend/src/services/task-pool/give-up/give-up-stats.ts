/**
 * Give-up metrics per team (#841): how often workers give up, how many
 * retries were queued, and how many of those retries succeeded.
 *
 * Computed on demand from the pool (`metadata.stop` on stopped items,
 * `metadata.giveUp` on retries and escalations). Nothing extra is stored.
 *
 * @module services/task-pool/give-up/give-up-stats
 */

import { GIVE_UP_RECOVERY_CONSTANTS } from '../../../constants.js';
import type { Team } from '../../../types/index.js';
import type { WorkItem } from '../../../types/v2/work-item.types.js';
import type { RecordedStop } from './give-up-recovery.service.js';
import { giveUpMetaOf, teamOf } from './give-up-recovery.service.js';

const C = GIVE_UP_RECOVERY_CONSTANTS;

/** Counts for one team (or `unassigned`). */
export interface TeamGiveUpStats {
  teamId: string;
  teamName: string;
  /** Stops classified as a feasibility give-up (retry verdict). */
  giveUps: number;
  /** Retry WorkItems created. */
  retries: number;
  /** Retries that reached done or verified. */
  retriesSucceeded: number;
  /** Retries that ended any other terminal way (failed, rejected, cancelled). */
  retriesFailed: number;
  /** Retries not finished yet. */
  retriesPending: number;
  /** retriesSucceeded / (retriesSucceeded + retriesFailed); null when none finished. */
  retrySuccessRate: number | null;
  /** One-per-root escalations to the lead after the retries ran out. */
  escalations: number;
  /** Stops sent to a human (never retried), by category. */
  escalatedByCategory: Record<string, number>;
}

/** Whole-pool result. */
export interface GiveUpStats {
  /** WorkItems examined (so an empty result is distinguishable from an empty pool). */
  examined: number;
  teams: TeamGiveUpStats[];
}

const SUCCESS = new Set(['done', 'verified']);
const FAILURE = new Set(['failed', 'rejected', 'cancelled']);
const UNASSIGNED = { id: 'unassigned', name: '(no team)' };

/**
 * Compute give-up metrics.
 *
 * @param items - Pool WorkItems
 * @param teams - Teams (to map a worker session to its team)
 * @param teamId - Only this team, when given
 * @returns Counts per team and how many items were examined
 *
 * @example
 * ```typescript
 * computeGiveUpStats(await pool.getAllItems(), await storage.getTeams(), 'team-a');
 * ```
 */
export function computeGiveUpStats(items: WorkItem[], teams: Team[], teamId?: string): GiveUpStats {
  const byTeam = new Map<string, TeamGiveUpStats>();
  const bucket = (wi: WorkItem, sessionOverride?: string): TeamGiveUpStats => {
    const metaTeam = typeof wi.metadata?.['teamId'] === 'string' ? (wi.metadata['teamId'] as string) : undefined;
    const team = (metaTeam ? teams.find((t) => t.id === metaTeam) : undefined) ?? teamOf(teams, sessionOverride ?? wi.target);
    const key = team?.id ?? UNASSIGNED.id;
    let s = byTeam.get(key);
    if (!s) {
      s = {
        teamId: key, teamName: team?.name ?? UNASSIGNED.name,
        giveUps: 0, retries: 0, retriesSucceeded: 0, retriesFailed: 0, retriesPending: 0,
        retrySuccessRate: null, escalations: 0, escalatedByCategory: {},
      };
      byTeam.set(key, s);
    }
    return s;
  };

  for (const wi of items) {
    const stop = wi.metadata?.[C.STOP_METADATA_KEY] as RecordedStop | undefined;
    if (stop && typeof stop.decision === 'string') {
      const s = bucket(wi);
      if (stop.decision === 'retry') s.giveUps += 1;
      else if (stop.decision === 'escalate') s.escalatedByCategory[stop.category] = (s.escalatedByCategory[stop.category] ?? 0) + 1;
    }
    const meta = giveUpMetaOf(wi);
    if (!meta) continue;
    if (wi.id.includes(C.RETRY_ID_INFIX)) {
      const s = bucket(wi);
      s.retries += 1;
      if (SUCCESS.has(wi.status)) s.retriesSucceeded += 1;
      else if (FAILURE.has(wi.status)) s.retriesFailed += 1;
      else s.retriesPending += 1;
    } else if (wi.id.endsWith(C.REVIEW_ID_SUFFIX)) {
      // The review targets the lead; count it on the worker's team.
      const worker = items.find((x) => x.id === meta.rootWorkItemId)?.target;
      bucket(wi, worker).escalations += 1;
    }
  }

  const teamsOut = [...byTeam.values()]
    .map((s) => {
      const finished = s.retriesSucceeded + s.retriesFailed;
      return { ...s, retrySuccessRate: finished > 0 ? s.retriesSucceeded / finished : null };
    })
    .filter((s) => !teamId || s.teamId === teamId)
    .sort((a, b) => a.teamId.localeCompare(b.teamId));
  return { examined: items.length, teams: teamsOut };
}
