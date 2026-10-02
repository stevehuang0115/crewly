/**
 * Team utility helpers
 *
 * Shared, dependency-free helpers operating on the `Team` / `TeamMember`
 * shape. Every module that needs to know who leads a team asks here — the
 * one rule (specs/2026-09-30-team-lead-rule.md):
 *
 *   1. the team's explicit `leaderIds` (or the deprecated `leaderId`), when
 *      at least one of them is still a member;
 *   2. otherwise every member whose role is in
 *      {@link TEAM_LEAD_CONSTANTS.LEAD_ROLES} (`team-leader`, `tech-lead`).
 *
 * `canDelegate` is NOT part of the rule. It stays a separate "delegation
 * authority" flag for the hierarchy (sub-leads with subordinates) and is the
 * last-resort routing fallback of {@link pickTeamLead}. A rule lead always
 * counts as able to delegate (see {@link canMemberDelegate}).
 *
 * @module utils/team.utils
 */

import { TEAM_LEAD_CONSTANTS } from '../constants.js';
import type { Team, TeamMember } from '../types/index.js';
import { LoggerService } from '../services/core/logger.service.js';

/**
 * The component logger, created on first use: this module is imported by
 * storage and the Team model, and suites that mock LoggerService must be
 * able to load it without a working logger.
 *
 * @returns The logger, or null when none is available
 */
function teamLogger(): { warn: (msg: string, meta?: Record<string, unknown>) => void } | null {
  try {
    return LoggerService.getInstance()?.createComponentLogger('TeamUtils') ?? null;
  } catch {
    return null;
  }
}

/** The team fields the lead rule reads. */
export type TeamLeadSource = {
  members?: Array<Pick<TeamMember, 'id' | 'role'>>;
  leaderIds?: string[];
  leaderId?: string;
};

/** How {@link setTeamLead} changes the leads. */
export type SetTeamLeadMode = (typeof TEAM_LEAD_CONSTANTS.SET_LEAD_MODES)[number];

/**
 * Whether a role is a lead role (used only when the team names no lead).
 *
 * @param role - Member role
 * @returns True for `team-leader` / `tech-lead`
 */
export function isLeadRole(role: string | undefined | null): boolean {
  return (TEAM_LEAD_CONSTANTS.LEAD_ROLES as readonly string[]).includes(String(role ?? ''));
}

/**
 * The explicit lead ids a team stores (`leaderIds`, else the legacy
 * `leaderId`), limited to ids that are still members.
 *
 * @param team - Team
 * @returns Explicit lead ids, in stored order (may be empty)
 */
function explicitLeadIds(team: TeamLeadSource): string[] {
  const memberIds = new Set((team.members ?? []).map((m) => m.id));
  const stored = team.leaderIds && team.leaderIds.length > 0 ? team.leaderIds : team.leaderId ? [team.leaderId] : [];
  return [...new Set(stored)].filter((id) => memberIds.has(id));
}

/**
 * The ids of the members who lead a team — THE lead rule.
 *
 * @param team - Team
 * @returns Lead member ids (explicit ones, else lead-role members); empty when the team has no lead
 *
 * @example
 * ```typescript
 * getTeamLeadIds({ members: [{ id: 'o', role: 'tech-lead' }, { id: 'n', role: 'developer' }] }); // ['o']
 * getTeamLeadIds({ leaderIds: ['n'], members: [...] });                                          // ['n']
 * ```
 */
export function getTeamLeadIds(team: TeamLeadSource): string[] {
  const explicit = explicitLeadIds(team);
  if (explicit.length > 0) return explicit;
  return (team.members ?? []).filter((m) => isLeadRole(m.role)).map((m) => m.id);
}

/**
 * Whether a member leads its team (see {@link getTeamLeadIds}).
 *
 * @param team - The member's team
 * @param member - The member
 * @returns True for a team lead
 */
export function isTeamLead(team: TeamLeadSource, member: Pick<TeamMember, 'id'>): boolean {
  return getTeamLeadIds(team).includes(member.id);
}

/**
 * The lead members of a team, in rule order.
 *
 * @param team - Team
 * @returns Lead members (may be empty)
 */
export function getTeamLeads(team: Team): TeamMember[] {
  const ids = getTeamLeadIds(team);
  const members = team.members ?? [];
  return ids.map((id) => members.find((m) => m.id === id)).filter((m): m is TeamMember => !!m);
}

/**
 * Whether a member may delegate: a team lead by the rule, or a member the
 * hierarchy flagged with `canDelegate` (a sub-lead of its subordinates).
 * This is what lead-only prompt modules (TL addon, TL soul overlay, TL
 * skills) and delegation checks key on, so a lead set by the rule gets them
 * on its next wake without a separate flag.
 *
 * @param team - The member's team
 * @param member - The member
 * @returns True when the member may delegate
 */
export function canMemberDelegate(team: TeamLeadSource, member: Pick<TeamMember, 'id' | 'canDelegate'>): boolean {
  return member.canDelegate === true || isTeamLead(team, member);
}

/**
 * The members a delegating member directs: its `subordinateIds` (or the
 * members naming it as parent); for a rule lead with neither, every other
 * member that is not itself a lead and reports to nobody else.
 *
 * @param team - The member's team
 * @param member - The member
 * @returns Subordinate members (may be empty)
 */
export function getLeadSubordinates(team: Team, member: TeamMember): TeamMember[] {
  const members = team.members ?? [];
  const explicit = new Set<string>([
    ...(member.subordinateIds ?? []),
    ...members.filter((m) => m.parentMemberId === member.id).map((m) => m.id),
  ]);
  explicit.delete(member.id);
  if (explicit.size > 0) return members.filter((m) => explicit.has(m.id));
  if (!isTeamLead(team, member)) return [];
  const leadIds = new Set(getTeamLeadIds(team));
  const memberIds = new Set(members.map((m) => m.id));
  return members.filter(
    (m) =>
      m.id !== member.id &&
      !leadIds.has(m.id) &&
      m.role !== 'orchestrator' &&
      (!m.parentMemberId || m.parentMemberId === member.id || !memberIds.has(m.parentMemberId)),
  );
}

/**
 * Choose the ONE member to route "the team lead" traffic to.
 *
 * Resolution (first match wins):
 *   1. A lead by the rule ({@link getTeamLeadIds}); among several, the one
 *      the hierarchy marks as top (`hierarchyLevel === 1 && canDelegate`),
 *      else the first.
 *   2. Legacy routing fallback — a member flagged `canDelegate` (hierarchy
 *      data imported without `leaderIds` or a lead role). Not a lead by the
 *      rule; kept so escalations of such teams still reach someone.
 *   3. First member — better to dispatch to _someone_ than silently drop a
 *      `@team` ping. **Emits a warn-log (#332)**.
 *
 * Returns `null` only when the team has no members at all.
 *
 * @param team - The matched team.
 * @returns The member to dispatch to, or `null` when the team has no members.
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

  const leads = getTeamLeads(team);
  if (leads.length > 0) {
    return leads.find((m) => m.hierarchyLevel === 1 && m.canDelegate === true) ?? leads[0];
  }

  const hierarchyTl = members.find((m) => m.hierarchyLevel === 1 && m.canDelegate === true);
  if (hierarchyTl) return hierarchyTl;
  const anyDelegator = members.find((m) => m.canDelegate === true);
  if (anyDelegator) return anyDelegator;

  // Issue #332: rule-3 fallback — emit a warn so the missing lead surfaces
  // in observability instead of being invisible.
  teamLogger()?.warn('pickTeamLead falling back to first member — team has no lead (set one with set-team-lead)', {
    teamId: team.id,
    teamName: team.name,
    chosenMemberId: members[0].id,
    memberCount: members.length,
    reason: 'no leaderIds and no team-leader / tech-lead member',
  });
  return members[0];
}

/**
 * Store the lead rule's answer on the team (idempotent migration, run on
 * every load and save): a team with no usable explicit leads but with
 * lead-role members gets `leaderIds` = those members; `leaderId` always
 * mirrors `leaderIds[0]` for back-compat. The rule's answer never changes —
 * only where it is stored. Dangling explicit ids (members since removed)
 * are dropped when at least one explicit lead remains.
 *
 * @param team - Team (mutated)
 * @returns True when the team changed
 */
export function normalizeTeamLeaderIds(team: { members?: Array<Pick<TeamMember, 'id' | 'role'>>; leaderIds?: string[]; leaderId?: string }): boolean {
  const ids = getTeamLeadIds(team);
  if (ids.length === 0) {
    // Nothing the rule can use (no member matches). Keep what is stored and
    // only keep the two fields in sync, as before the rule existed.
    if (team.leaderIds && team.leaderIds.length > 0) {
      if (team.leaderId === team.leaderIds[0]) return false;
      team.leaderId = team.leaderIds[0];
      return true;
    }
    if (team.leaderId && !team.leaderIds) {
      team.leaderIds = [team.leaderId];
      return true;
    }
    return false;
  }
  const same = team.leaderIds?.length === ids.length && ids.every((id, i) => team.leaderIds?.[i] === id) && team.leaderId === ids[0];
  if (same) return false;
  team.leaderIds = ids;
  team.leaderId = ids[0];
  return true;
}

/**
 * Make a member a lead of its team (`POST /api/teams/:id/lead`, the
 * `set-team-lead` skill, the dashboard "Make lead" toggle).
 *
 * - `set` (default): the member becomes THE lead. Former leads lose the
 *   lead's delegation flag, and members that reported to a former lead now
 *   report to the new one.
 * - `add`: the member joins the existing leads.
 *
 * The lead gets `canDelegate = true` (so the in-process delegation guard and
 * hierarchy views agree) and `hierarchyLevel = 1` on hierarchical teams.
 *
 * @param team - Team (mutated)
 * @param memberId - Member to make lead
 * @param mode - `set` or `add`
 * @returns The lead ids before and after
 * @throws Error when the member is not on the team or is the orchestrator
 */
export function setTeamLead(team: Team, memberId: string, mode: SetTeamLeadMode = 'set'): { before: string[]; after: string[]; changed: boolean } {
  const members = team.members ?? [];
  const lead = members.find((m) => m.id === memberId);
  if (!lead) throw new Error(`Member ${memberId} is not on team ${team.name}`);
  if (lead.role === 'orchestrator') throw new Error('The orchestrator cannot lead a team');

  const before = getTeamLeadIds(team);
  const after = mode === 'add' ? [...new Set([...before, memberId])] : [memberId];
  const former = new Set(before.filter((id) => !after.includes(id)));

  team.leaderIds = after;
  team.leaderId = after[0];
  lead.canDelegate = true;
  if (team.hierarchical) lead.hierarchyLevel = 1;
  if (mode === 'set') lead.parentMemberId = undefined;

  for (const m of members) {
    if (m.id === memberId) continue;
    if (former.has(m.id)) {
      m.canDelegate = false;
      m.subordinateIds = [];
      if (team.hierarchical) {
        m.hierarchyLevel = 2;
        m.parentMemberId = memberId;
      }
    } else if (m.parentMemberId && former.has(m.parentMemberId)) {
      m.parentMemberId = memberId;
    }
  }
  const reports = members.filter((m) => m.parentMemberId === memberId && m.id !== memberId).map((m) => m.id);
  if (reports.length > 0 || lead.subordinateIds) lead.subordinateIds = reports;

  const changed = before.length !== after.length || before.some((id, i) => after[i] !== id);
  return { before, after, changed };
}
