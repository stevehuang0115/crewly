/**
 * The "Team leads" block of the evening digest from the process singletons
 * (crewly#1083, specs/2026-10-04-tl-delegation.md §3).
 *
 * @module services/tl-delegation/lead-share.wiring
 */

import type { Team } from '../../types/index.js';
import { buildLeadShareDigest, computeLeadShares, startOfLocalDay, type LeadDigestExtras, type LedgerVisitor } from './lead-share.js';
import type { TlDelegationService } from './tl-delegation.service.js';

/** Collaborators of {@link leadShareDigestFor}. */
export interface LeadShareDigestDeps {
  teams: () => Promise<Team[]>;
  forEachEvent: LedgerVisitor;
  delegation: Pick<TlDelegationService, 'nudgeCounts' | 'keptWorkSince'>;
}

/**
 * The digest block for today: lead shares, today's nudges and kept work.
 *
 * @param now - Clock
 * @param deps - Collaborators
 * @returns Block text, or null when there is nothing to say
 */
export async function leadShareDigestFor(now: Date, deps: LeadShareDigestDeps): Promise<string | null> {
  const teams = await deps.teams();
  const rows = computeLeadShares(teams, deps.forEachEvent, now);
  const dayStart = startOfLocalDay(now).getTime();
  const extras = new Map<string, LeadDigestExtras>();
  for (const r of rows) {
    const nudges = deps.delegation.nudgeCounts(r.leadSessions, now.getTime()).day;
    const kept = deps.delegation.keptWorkSince(dayStart, { teamId: r.teamId, sessions: r.leadSessions }).map((k) => k.reason);
    extras.set(r.teamId, { nudges, keptReasons: kept });
  }
  return buildLeadShareDigest(rows, extras);
}

/**
 * {@link leadShareDigestFor} over the team store, the token ledger and the
 * delegation service.
 *
 * @param now - Clock
 * @returns Block text, or null
 */
export async function defaultLeadShareDigest(now: Date): Promise<string | null> {
  const [{ StorageService }, { TokenUsageService }, { TlDelegationService }] = await Promise.all([
    import('../core/storage.service.js'),
    import('../monitoring/token-usage.service.js'),
    import('./tl-delegation.service.js'),
  ]);
  const usage = TokenUsageService.getInstance();
  return leadShareDigestFor(now, {
    teams: () => StorageService.getInstance().getTeams(),
    forEachEvent: (visit, since) => usage.forEachEvent(visit, since),
    delegation: TlDelegationService.getInstance(),
  });
}
