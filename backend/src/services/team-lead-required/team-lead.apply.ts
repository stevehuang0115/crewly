/**
 * Making a member the lead of its team — the one code path behind
 * `POST /api/teams/:id/lead` and the owner's answer to a "team has no lead"
 * card (specs/2026-09-30-team-lead-rule.md §3,
 * specs/2026-10-04-tl-delegation.md §6).
 *
 * @module services/team-lead-required/team-lead.apply
 */

import type { Team } from '../../types/index.js';
import { setTeamLead, type SetTeamLeadMode } from '../../utils/team.utils.js';
import { recordActivity, type ActivityActor } from '../activity/activity-log.service.js';

/** What {@link applyTeamLead} needs. */
export interface ApplyTeamLeadInput {
  /** Where the team is saved */
  storage: { saveTeam(team: Team): Promise<unknown> };
  /** The team (mutated) */
  team: Team;
  /** Member to make lead */
  memberId: string;
  /** `set` (default: THE lead) or `add` (one more lead) */
  mode?: SetTeamLeadMode;
  /** Who changed it, for the activity log */
  actor: ActivityActor;
}

/**
 * Make a member a lead of its team, save the team and log the change. The
 * lead-only prompt modules and skills key on the lead rule, so the member
 * gets them on its next wake. The caller invalidates the cached team list.
 *
 * @param input - Storage, team, member, mode, actor
 * @returns The lead ids before and after, and whether they changed
 * @throws Error when the member is not on the team or is the orchestrator, or the save fails
 */
export async function applyTeamLead(input: ApplyTeamLeadInput): Promise<{ before: string[]; after: string[]; changed: boolean }> {
  const { team, memberId } = input;
  const mode = input.mode ?? 'set';
  const result = setTeamLead(team, memberId, mode);
  (team as { updatedAt: string }).updatedAt = new Date().toISOString();
  await input.storage.saveTeam(team);
  const member = (team.members ?? []).find((m) => m.id === memberId);
  recordActivity({
    actor: input.actor,
    action: 'team.lead.changed',
    target: { type: 'team', id: team.id, name: team.name },
    after: { lead: member?.name ?? memberId, memberId, mode },
  });
  return result;
}
