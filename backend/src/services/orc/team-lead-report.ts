/**
 * Team work the orchestrator delegated on the owner's behalf is reported to
 * the owner by the team's lead, in the team's Slack channel, as the lead
 * (crewly#1371).
 *
 * Incident 2026-10-17: the orc opened one DM thread with four items across
 * two teams; the owner replied 「按建议」. Marketing re-worded a tutorial and
 * the orc posted "[Orc] 第 2 条已上线 …" in that DM thread, under an
 * unrelated email draft. The owner could not tell who did the work or why
 * the orc was telling him. Owner decision: 「团队做完的事由负责人汇报」.
 *
 * A work item the orchestrator delegates with an owner origin (`delegate-task
 * --thread/--conversation`) to a member of a team that has a Slack channel is
 * stamped with a {@link LeadReport} (`metadata.leadReport`): who reports it
 * (the team lead; the worker when the team has no lead) and where (the team
 * channel). Verify items and re-delegations of that work carry the same
 * stamp. Everything downstream reads the stamp:
 *
 * | Where | What changes |
 * |---|---|
 * | owner completion report | the chain is the lead's: nudge the lead, fallback posts in the team channel as the lead |
 * | orc `[EVENT:task:verified]` / `[DONE]` | informational, "no owner post needed — <lead> reports it in #<channel>" |
 * | OrcDeliveryEnforcer | no `[DELIVER_REQUIRED]` for it |
 * | `reply --work-item` | a new top-level post in the team channel |
 *
 * Work that was never delegated to a team (the orc's own work, a member of
 * no team, a team with no Slack channel) is not stamped and keeps the
 * existing behaviour. Pure functions only.
 *
 * @module services/orc/team-lead-report
 */

import type { Team, TeamMember } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { getTeamLeads } from '../../utils/team.utils.js';
import { slackArchiveLink } from '../decisions/ticket-thread-store.js';
import { leadReportOf, originOfWorkItem, type LeadReport, type WorkItemOrigin } from './work-item-destination.js';

export { isLeadReport, leadReportOf, type LeadReport } from './work-item-destination.js';

/** An owner origin. */
type OwnerOrigin = Extract<WorkItemOrigin, { kind: 'owner' }>;

/**
 * Session of a team member (permanent agent id first, like the pool).
 *
 * @param m - Member
 * @returns Session name
 */
function sessionOf(m: Pick<TeamMember, 'agentId' | 'sessionName'> | null | undefined): string | undefined {
  return m?.agentId || m?.sessionName || undefined;
}

/**
 * The team's lead by the lead rule (no "first member" fallback): among
 * several, the one the hierarchy marks as top.
 *
 * @param team - Team
 * @returns The lead, or null when the team has none
 */
export function leadOfTeam(team: Team): TeamMember | null {
  const leads = getTeamLeads(team);
  if (leads.length === 0) return null;
  return leads.find((m) => m.hierarchyLevel === 1 && m.canDelegate === true) ?? leads[0];
}

/** Inputs of {@link planTeamLeadReport}. */
export interface PlanTeamLeadReportInput {
  /** The item being created, its origin already stamped */
  workItem: WorkItem;
  /** The agent creating (delegating) it */
  creator?: string;
  /** Every team */
  teams: readonly Team[];
  /** Orchestrator check */
  isOrchestrator: (name: string) => boolean;
  /** A team's Slack channel, or null when it has none */
  channelOf: (teamId: string) => { slackChannelId: string; channelName: string } | null;
  /** Pool items (for a re-delegation of work already stamped) */
  items?: readonly WorkItem[];
}

/**
 * Whether two owner origins name the same place.
 *
 * @param a - Owner origin
 * @param b - Owner origin
 * @returns True for the same Slack thread / DM, or the same chat conversation thread
 */
export function sameOwnerPlace(a: OwnerOrigin, b: OwnerOrigin): boolean {
  if (a.slackChannelId && b.slackChannelId) return a.slackChannelId === b.slackChannelId && (a.threadTs ?? '') === (b.threadTs ?? '');
  if (a.conversationId && b.conversationId) return a.conversationId === b.conversationId && (a.chatThreadId ?? '') === (b.chatThreadId ?? '');
  return false;
}

/**
 * Who reports a new work item to the owner, and where — or null when it is
 * not team work the orchestrator delegated on the owner's behalf.
 *
 * - the orchestrator delegated it with an owner origin to a member of a team
 *   that has a Slack channel → that team's lead (the worker when the team has
 *   no lead), in that channel;
 * - a member re-delegates work it holds that is already stamped, for the same
 *   owner place → the same lead and channel, with the new worker;
 * - anything else → null (existing behaviour).
 *
 * @param input - New item, creator, teams, channels
 * @returns The stamp, or null
 */
export function planTeamLeadReport(input: PlanTeamLeadReportInput): LeadReport | null {
  const { workItem, creator, teams, isOrchestrator } = input;
  const origin = originOfWorkItem(workItem);
  const worker = workItem.target;
  if (origin?.kind !== 'owner' || !worker || !creator || isOrchestrator(worker)) return null;

  if (!isOrchestrator(creator)) {
    // A re-delegation of stamped work (the lead hands it to a member).
    for (const held of input.items ?? []) {
      if (held.target !== creator) continue;
      const stamp = leadReportOf(held);
      const heldOrigin = originOfWorkItem(held);
      if (!stamp || heldOrigin?.kind !== 'owner' || !sameOwnerPlace(heldOrigin, origin)) continue;
      const member = findMember(teams, worker);
      return { ...stamp, worker, ...(member?.name ? { workerName: member.name } : {}) };
    }
    return null;
  }

  const found = findMemberAndTeam(teams, worker);
  if (!found) return null;
  const channel = input.channelOf(found.team.id);
  if (!channel) return null;
  const lead = leadOfTeam(found.team);
  const leadSession = sessionOf(lead) ?? worker;
  return {
    lead: leadSession,
    ...(lead?.name ? { leadName: lead.name } : leadSession === worker && found.member.name ? { leadName: found.member.name } : {}),
    worker,
    ...(found.member.name ? { workerName: found.member.name } : {}),
    teamId: found.team.id,
    teamName: found.team.name,
    slackChannelId: channel.slackChannelId,
    channelName: channel.channelName.replace(/^#/, ''),
  };
}

/**
 * The (non-archived) team a session is a member of, with the member.
 *
 * @param teams - Every team
 * @param session - Agent session
 * @returns Team + member, or null
 */
function findMemberAndTeam(teams: readonly Team[], session: string): { team: Team; member: TeamMember } | null {
  for (const team of teams) {
    if (team.archived) continue;
    const member = (team.members ?? []).find((m) => sessionOf(m) === session || m.sessionName === session);
    if (member) return { team, member };
  }
  return null;
}

/**
 * The member a session is, in any team.
 *
 * @param teams - Every team
 * @param session - Agent session
 * @returns Member, or null
 */
function findMember(teams: readonly Team[], session: string): TeamMember | null {
  return findMemberAndTeam(teams, session)?.member ?? null;
}

/**
 * A link to the owner's thread the approval came from.
 *
 * @param origin - Owner origin
 * @returns Slack link, or null when the origin is not a Slack thread
 */
export function approvalLink(origin: WorkItemOrigin | null | undefined): string | null {
  if (origin?.kind !== 'owner' || !origin.slackChannelId || !origin.threadTs) return null;
  return slackArchiveLink(origin.slackChannelId, origin.threadTs);
}

/**
 * The reporter's display name.
 *
 * @param report - Stamp
 * @returns Name (session when unknown)
 */
export function leadNameOf(report: LeadReport): string {
  return report.leadName ?? report.lead;
}

/**
 * The line the orchestrator's notice about this work carries: it is
 * informational, the lead reports it.
 *
 * @param report - Stamp
 * @returns English harness text
 */
export function orchestratorNote(report: LeadReport): string {
  return `No owner post needed — ${leadNameOf(report)} reports it in #${report.channelName}; do not post it in your thread with the owner.`;
}

/**
 * The note a delegated member gets for stamped work: the lead tells the
 * owner, in the team channel; the member reports its result as usual.
 *
 * @param wi - The stored work item
 * @param report - Its stamp
 * @returns English harness text
 */
export function memberLeadReportNote(wi: Pick<WorkItem, 'id' | 'target'>, report: LeadReport): string {
  if (wi.target === report.lead) {
    return (
      `The owner approved this in the orchestrator's thread. When it is finished you report it to the owner yourself, in #${report.channelName}: ` +
      `reply --work-item ${wi.id} "<one or two plain lines>". The orchestrator does not relay it.`
    );
  }
  return (
    `The owner approved this in the orchestrator's thread. When it is finished, ${leadNameOf(report)} reports it to the owner in #${report.channelName}; ` +
    `do not post it to the owner yourself. Report your result as usual (report-status).`
  );
}
