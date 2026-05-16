/**
 * Resolves a cron task's `targetTeamId` to a `Team` row.
 *
 * Background: `targetTeamId` is user-supplied and historically expected a
 * UUID, but operators frequently pass a name-derived slug
 * (`"stock-ops-team"` instead of `team.id`). The old `teams.find(t =>
 * t.id === identifier)` lookup returned `undefined` for those, both
 * cron auto-start callbacks silently returned `false`, and `lastRunAt`
 * stayed `null` forever with no error surface (issue #307).
 *
 * Lookup order:
 *   1. Exact UUID match against `team.id` (canonical, fast-path).
 *   2. Slug match against `team.name` — lowercased, all whitespace runs
 *      collapsed to `-`.
 *
 * The slug derivation MUST mirror whatever the UI / docs tell operators
 * to type. The current operator-facing pattern is "lowercase + spaces→
 * hyphens"; if that ever diverges, update this function in lockstep.
 *
 * @module services/workflow/team-identifier-resolver
 */

import type { Team } from '../../types/index.js';

/**
 * Try UUID lookup, then slug lookup. Returns the matched team or
 * `undefined`. Callers MUST log a distinct warn on `undefined` so the
 * misconfiguration is visible (issue #307 root cause was the missing
 * warn-log, not the lookup itself).
 *
 * @param teams - All known teams (e.g. from `storage.getTeams()`)
 * @param identifier - The user-supplied `targetTeamId` (UUID or slug)
 * @returns The matched team, or `undefined` if neither lookup hits
 */
export function resolveTeamByIdOrSlug(
  teams: readonly Team[],
  identifier: string,
): Team | undefined {
  // Empty identifier matches an empty team name and accidentally resolves
  // to whichever team happens to have a falsy `name`. Reject up front.
  if (!identifier) return undefined;
  const byId = teams.find((t) => t.id === identifier);
  if (byId) return byId;
  const wanted = identifier.trim().toLowerCase();
  if (!wanted) return undefined;
  return teams.find(
    (t) => t.name.trim().toLowerCase().replace(/\s+/g, '-') === wanted,
  );
}

/**
 * Produce the canonical slug for a team name, matching the rule
 * `resolveTeamByIdOrSlug` uses on the lookup side. Exported so the
 * cron init can include the list of available slugs in its
 * "team not found" warn-log for operator debuggability.
 *
 * @param name - The team display name (`team.name`)
 * @returns The lowercase, hyphen-collapsed slug
 */
export function slugifyTeamName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}
