/**
 * The deterministic session name a team member runs under.
 *
 * `member.sessionName` in storage is transient: the team controller sets
 * it on start and clears it on stop/failure. Anything that needs a stable
 * agent id while the agent is idle (Slack agent identities, rosters)
 * derives it here with the same formula the controller uses.
 *
 * @module utils/member-session-name.utils
 */

/**
 * Derive a member's session name: `<team-slug>-<member-slug>-<id[0:8]>`.
 *
 * @param teamName - The team's display name
 * @param memberName - The member's display name
 * @param memberId - The member's uuid
 * @returns The session name the controller would assign on start
 *
 * @example
 * deriveMemberSessionName('Think Tank', 'Sage', 'c1d2e3f4-...') // 'think-tank-sage-c1d2e3f4'
 */
export function deriveMemberSessionName(teamName: string, memberName: string, memberId: string): string {
  const teamSlug = (teamName ?? '').toLowerCase().replace(/\s+/g, '-');
  const memberSlug = (memberName ?? '').toLowerCase().replace(/\s+/g, '-');
  return `${teamSlug}-${memberSlug}-${(memberId ?? '').substring(0, 8)}`;
}

/**
 * A member's stored session name when it has one, else the derived one.
 *
 * @param teamName - The team's display name
 * @param member - Member fields the derivation needs
 * @returns A non-empty session name whenever the member has an id
 */
export function resolveMemberSessionName(
  teamName: string,
  member: { sessionName?: string; name: string; id: string },
): string {
  return member.sessionName || deriveMemberSessionName(teamName, member.name, member.id);
}
