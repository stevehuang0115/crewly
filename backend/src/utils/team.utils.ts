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
 *      case.
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

  return (
    members.find((m) => m.hierarchyLevel === 1 && m.canDelegate === true) ??
    members.find((m) => m.canDelegate === true) ??
    members.find((m) => m.role === 'team-leader') ??
    members[0]
  );
}
