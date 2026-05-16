/**
 * Team utility helpers
 *
 * Shared, dependency-free helpers operating on the `Team` / `TeamMember`
 * shape. These are extracted here so multiple call sites (chat-v2 mention
 * resolver, mission OKR reminder service, …) can share a single canonical
 * implementation instead of drifting over time.
 *
 * @module utils/team.utils
 */

import type { Team, TeamMember } from '../types/index.js';
import { LoggerService } from '../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('TeamUtils');

/**
 * Choose the TL (Team Lead) responder for a team.
 *
 * Resolution rules (ordered, first match wins):
 *   1. Hierarchy TL: `hierarchyLevel === 1 && canDelegate === true`.
 *   2. Any delegator: `canDelegate === true` regardless of level. Covers
 *      teams that were imported before hierarchy fields were added but
 *      already have a flagged TL.
 *   3. Role-tagged TL: `role === 'team-leader'` so role-based teams that
 *      didn't fill in `canDelegate` still resolve correctly.
 *   4. First member: deterministic last resort — better to dispatch to
 *      _someone_ than silently drop a `@team` ping. Tests cover this
 *      case. **Emits a warn-log (#332)** so operators see when team
 *      hierarchy data is incomplete — silent rule-4 hits were
 *      previously invisible.
 *
 * Returns `null` only when the team has no members at all.
 *
 * @param team - The matched team.
 * @returns The TL to dispatch to, or `null` when the team has no members.
 *
 * @example
 * ```typescript
 * const tl = pickTeamLead(team);
 * if (tl) await sendNotification({ to: tl.sessionName });
 * ```
 */
export function pickTeamLead(team: Team): TeamMember | null {
  const members = team.members ?? [];
  if (members.length === 0) return null;

  const hierarchyTl = members.find((m) => m.hierarchyLevel === 1 && m.canDelegate === true);
  if (hierarchyTl) return hierarchyTl;

  const anyDelegator = members.find((m) => m.canDelegate === true);
  if (anyDelegator) return anyDelegator;

  const roleTl = members.find((m) => m.role === 'team-leader');
  if (roleTl) return roleTl;

  // Issue #332: rule-4 fallback — emit a warn so the missing hierarchy
  // data surfaces in observability instead of being invisible. The
  // resolver still returns a member so `@team` pings don't silently
  // drop, but the team owner should fix the underlying hierarchy gap.
  logger.warn('pickTeamLead falling back to first member — team has no canDelegate / team-leader marker', {
    teamId: team.id,
    teamName: team.name,
    chosenMemberId: members[0].id,
    memberCount: members.length,
    reason: 'no TL markers — falling back to first member',
  });
  return members[0];
}
