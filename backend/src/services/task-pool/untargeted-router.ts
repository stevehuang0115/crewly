/**
 * Who decides an unassigned WorkItem (owner, 2026-09-24).
 *
 * Unassigned work used to be free for any idle agent: AutoClaim handed
 * Think Tank's Atlas and Sage the product team's "Design approach" and
 * "Implement" items, and they spent hours on another team's work while the
 * owner's own questions waited. Now an item with no target goes to someone
 * who decides — does it or hands it to the right person — and moves one level
 * up when that person does not take it: member → their lead → the
 * orchestrator.
 *
 * Pure functions over the team list; the pool wires them in.
 *
 * @module services/task-pool/untargeted-router
 */

import type { Team, TeamMember } from '../../types/index.js';
import { pickTeamLead } from '../../utils/team.utils.js';

/** What the first decider depends on. */
export interface RouteContext {
  teams: readonly Team[];
  /** The orchestrator session (last level) */
  orchestrator: string;
  /** The agent that created the item, when known */
  creatorSession?: string;
  /** Owner of the item's ticket, when it has one */
  ticketAssignee?: string;
  /** `metadata.teamId` of the item, when set */
  teamId?: string;
}

/**
 * Session of a member, preferring the permanent agent id.
 *
 * @param m - Member
 * @returns Session name, or undefined
 */
function sessionOf(m: TeamMember | undefined): string | undefined {
  return m?.agentId || m?.sessionName || undefined;
}

/**
 * The lead above a session: its parent member, else its team's lead — never
 * itself.
 *
 * @param session - Agent session
 * @param teams - Every team
 * @returns The lead's session, or null when there is none
 */
export function leadAbove(session: string, teams: readonly Team[]): string | null {
  for (const team of teams) {
    const members = team.members ?? [];
    const self = members.find((m) => sessionOf(m) === session || m.sessionName === session);
    if (!self) continue;
    const parent = self.parentMemberId ? members.find((m) => m.id === self.parentMemberId) : undefined;
    for (const c of [parent, pickTeamLead(team) ?? undefined]) {
      const s = sessionOf(c);
      if (s && s !== session) return s;
    }
    return null;
  }
  return null;
}

/**
 * Whether a session leads its team (is its own "lead").
 *
 * @param session - Agent session
 * @param teams - Every team
 * @returns True for a team's lead
 */
function isTeamLead(session: string, teams: readonly Team[]): boolean {
  for (const team of teams) {
    const members = team.members ?? [];
    if (!members.some((m) => sessionOf(m) === session)) continue;
    return sessionOf(pickTeamLead(team) ?? undefined) === session;
  }
  return false;
}

/**
 * First decider of an unassigned item, most specific first:
 * 1. the owner of its ticket;
 * 2. the lead of its team (`metadata.teamId`);
 * 3. the creator's lead — or the creator itself when it leads its team
 *    (a lead that leaves work unassigned is deciding for its own team);
 * 4. the orchestrator.
 *
 * @param ctx - Route context
 * @returns The session that decides
 */
export function initialDecider(ctx: RouteContext): string {
  if (ctx.ticketAssignee) return ctx.ticketAssignee;
  if (ctx.teamId) {
    const team = ctx.teams.find((t) => t.id === ctx.teamId);
    const lead = sessionOf(team ? pickTeamLead(team) ?? undefined : undefined);
    if (lead) return lead;
  }
  const creator = ctx.creatorSession;
  if (creator && creator !== ctx.orchestrator) {
    if (isTeamLead(creator, ctx.teams)) return creator;
    const lead = leadAbove(creator, ctx.teams);
    if (lead) return lead;
  }
  return ctx.orchestrator;
}

/**
 * One level up from the current decider: its lead, else the orchestrator;
 * null once the orchestrator has it.
 *
 * @param current - Current decider
 * @param teams - Every team
 * @param orchestrator - Orchestrator session
 * @returns Next decider, or null
 */
export function nextDecider(current: string, teams: readonly Team[], orchestrator: string): string | null {
  if (current === orchestrator) return null;
  const lead = leadAbove(current, teams);
  return lead && lead !== current ? lead : orchestrator;
}
