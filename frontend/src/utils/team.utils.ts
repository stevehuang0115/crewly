/**
 * Team Utilities
 *
 * Shared helper functions and constants for team-related operations,
 * such as assigning default avatars to team members during migration.
 *
 * @module utils/team.utils
 */

/** Default avatar choices for team members (migration/backward-compat). */
export const AVATAR_CHOICES = [
  'https://picsum.photos/seed/1/64',
  'https://picsum.photos/seed/2/64',
  'https://picsum.photos/seed/3/64',
  'https://picsum.photos/seed/4/64',
  'https://picsum.photos/seed/5/64',
  'https://picsum.photos/seed/6/64',
];

/**
 * Assign default avatars to members that don't already have one.
 *
 * Cycles through AVATAR_CHOICES by index for deterministic assignment.
 *
 * @param members - Array of objects that may include an optional `avatar` field
 * @returns A new array with avatars filled in where missing
 */
export function assignDefaultAvatars<T extends { avatar?: string }>(members: T[]): T[] {
  return members.map((member, index) => ({
    ...member,
    avatar: member.avatar || AVATAR_CHOICES[index % AVATAR_CHOICES.length],
  }));
}

/**
 * Roles that make a member a team lead when the team names no lead
 * explicitly. Mirrors the backend's `TEAM_LEAD_CONSTANTS.LEAD_ROLES`.
 */
export const TEAM_LEAD_ROLES: readonly string[] = ['team-leader', 'tech-lead'];

/** The team fields the lead rule reads. */
interface TeamLeadSource {
  members?: Array<{ id: string; role?: string }>;
  leaderIds?: string[];
  leaderId?: string;
}

/**
 * The ids of the members who lead a team — the same rule as the backend
 * (`backend/src/utils/team.utils.ts`, specs/2026-09-30-team-lead-rule.md):
 * the team's explicit `leaderIds` (or the deprecated `leaderId`) that are
 * still members, otherwise the members with a lead role.
 *
 * @param team - Team
 * @returns Lead member ids (may be empty)
 */
export function getTeamLeadIds(team: TeamLeadSource): string[] {
  const members = team.members ?? [];
  const memberIds = new Set(members.map((m) => m.id));
  const stored = team.leaderIds && team.leaderIds.length > 0 ? team.leaderIds : team.leaderId ? [team.leaderId] : [];
  const explicit = stored.filter((id) => memberIds.has(id));
  if (explicit.length > 0) return [...new Set(explicit)];
  return members.filter((m) => TEAM_LEAD_ROLES.includes(String(m.role ?? ''))).map((m) => m.id);
}
