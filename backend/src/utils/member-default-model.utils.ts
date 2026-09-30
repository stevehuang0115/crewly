/**
 * Default model for Claude Code team members.
 *
 * A member that has someone above it reviewing its work (its parent member,
 * else the team lead — the same rule the bridge uses to pick a reviewer)
 * runs on Sonnet unless a model was chosen for it. Leads, and members with no
 * separate reviewer, keep Claude Code's own default (Opus). An explicit
 * `modelId` always wins, and the orchestrator is never touched.
 *
 * `CREWLY_MEMBER_DEFAULT_MODEL` replaces `sonnet`; `''` or `off` turns the
 * default off entirely.
 *
 * @module utils/member-default-model
 */

import { MEMBER_MODEL_DEFAULT_CONSTANTS, ORCHESTRATOR_SESSION_NAME, RUNTIME_TYPES } from '../constants.js';
import type { Team, TeamMember } from '../types/index.js';
import { isTeamLead, pickTeamLead } from './team.utils.js';

/** The fields of a member this decision reads. */
type MemberLike = Pick<TeamMember, 'id' | 'sessionName' | 'role' | 'modelId' | 'parentMemberId'> & { runtimeType?: string } &
  Partial<Pick<TeamMember, 'canDelegate'>>;

/**
 * The model reviewed members get when they have none, after the env override.
 *
 * @param env - Environment (tests)
 * @returns The model name, or null when the default is disabled
 */
export function reviewedMemberDefaultModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[MEMBER_MODEL_DEFAULT_CONSTANTS.ENV_OVERRIDE];
  if (raw === undefined) return MEMBER_MODEL_DEFAULT_CONSTANTS.DEFAULT_REVIEWED_MEMBER_MODEL;
  const value = raw.trim();
  if (!value || value.toLowerCase() === 'off') return null;
  return value;
}

/**
 * Whether someone other than the member reviews its work: a parent member
 * that exists in the team, or a team lead who is not the member itself.
 * Members that lead (a lead by the team-lead rule in `utils/team.utils`, or a
 * delegating member with no parent) never count as reviewed.
 *
 * @param team - The member's team
 * @param member - The member
 * @returns True when the member has a reviewer above it
 */
export function memberHasReviewer(team: Pick<Team, 'id' | 'name' | 'members' | 'leaderIds' | 'leaderId'>, member: MemberLike): boolean {
  if (isTeamLead(team, member)) return false;
  const members = team.members ?? [];
  const parent = member.parentMemberId ? members.find((m) => m.id === member.parentMemberId) : undefined;
  if (parent && parent.id !== member.id) return true;
  if (member.canDelegate === true && !member.parentMemberId) return false;
  const lead = pickTeamLead(team as Team);
  return !!lead && lead.id !== member.id;
}

/**
 * The model a member should launch with when it has no `modelId` of its
 * own. Returns null when no default applies (explicit model set, not Claude
 * Code, orchestrator, a lead / unreviewed member, or the default disabled).
 *
 * @param team - The member's team
 * @param member - The member
 * @param env - Environment (tests)
 * @returns The default model name, or null
 *
 * @example
 * ```typescript
 * defaultModelForMember(team, worker); // 'sonnet'
 * defaultModelForMember(team, lead);   // null → Claude Code's own default (Opus)
 * ```
 */
export function defaultModelForMember(
  team: Pick<Team, 'id' | 'name' | 'members' | 'leaderIds' | 'leaderId'>,
  member: MemberLike,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (member.modelId) return null;
  if ((member.runtimeType ?? RUNTIME_TYPES.CLAUDE_CODE) !== RUNTIME_TYPES.CLAUDE_CODE) return null;
  if (member.role === 'orchestrator' || member.sessionName === ORCHESTRATOR_SESSION_NAME) return null;
  if (!memberHasReviewer(team, member)) return null;
  return reviewedMemberDefaultModel(env);
}

/**
 * The model id a member launches with: its own `modelId` when set, else the
 * reviewed-member default from {@link defaultModelForMember}.
 *
 * @param team - The member's team
 * @param member - The member
 * @param env - Environment (tests)
 * @returns Model id to pass to the runtime, or undefined for the runtime's own default
 */
export function effectiveMemberModelId(
  team: Pick<Team, 'id' | 'name' | 'members' | 'leaderIds' | 'leaderId'>,
  member: MemberLike,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (member.modelId) return member.modelId;
  return defaultModelForMember(team, member, env) ?? undefined;
}
