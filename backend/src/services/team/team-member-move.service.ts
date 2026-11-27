/**
 * Move an existing agent from one team to another
 * (specs/2026-11-27-move-team-member.md).
 *
 * The member keeps its identity: id, agent id / session name, name, role and
 * runtime/model settings. Memory and agent directories are keyed by session
 * name and are not touched. Records that belong to the member follow it;
 * records that belong to a team stay with that team.
 *
 * Not to be confused with `services/team-move`, which moves a whole team to
 * another machine.
 *
 * @module services/team/team-member-move
 */

import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import type { Team, TeamMember } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { isSpecManaged, type Trigger } from '../../types/v2/trigger.types.js';
import { memberAgentId, resolveMemberSessionName } from '../../utils/member-session-name.utils.js';
import { getTeamLeadIds, getTeamLeads } from '../../utils/team.utils.js';
import { isOpenWorkItem } from '../team-move/team-move-select.js';

/** Team id of the built-in orchestrator team, which nobody moves in or out of. */
const ORCHESTRATOR_TEAM_ID = 'orchestrator';

/** Times the two team configs are re-checked after the move. */
const SETTLE_ATTEMPTS = 3;

/** What the member's session is doing right now. */
export type MemberRunState = 'stopped' | 'idle' | 'busy' | 'starting';

/** Why a move was refused; nothing was changed. */
export type MoveRefusalCode =
  | 'source_not_found'
  | 'target_not_found'
  | 'member_not_found'
  | 'same_team'
  | 'already_in_target'
  | 'target_archived'
  | 'orchestrator'
  | 'member_is_lead'
  | 'member_is_temporary'
  | 'member_busy';

/** A move that must not happen. */
export class MoveRefusedError extends Error {
  /**
   * @param code - Machine-readable reason
   * @param message - What to tell the caller
   * @param status - HTTP status
   */
  constructor(readonly code: MoveRefusalCode, message: string, readonly status: number = 409) {
    super(message);
    this.name = 'MoveRefusedError';
  }
}

/** The stores a move reads and writes. */
export interface MoveMemberDeps {
  storage: {
    getTeams(): Promise<Team[]>;
    saveTeam(team: Team): Promise<void>;
    getMemberPrompt(teamId: string, memberId: string): Promise<string | null>;
    removeMemberPrompt(teamId: string, memberId: string): Promise<void>;
  };
  /** What the member's session is doing */
  runState(member: TeamMember, sessionName: string): Promise<MemberRunState>;
  workItems: {
    getAllItems(): Promise<WorkItem[]>;
    patchMetadata(workItemId: string, key: string, value: unknown): Promise<WorkItem | null>;
  };
  /** Make the member THE lead of a team that holds it (the set-team-lead path) */
  makeLead(team: Team, memberId: string): Promise<unknown>;
  /** Absent when the trigger engine is not running */
  triggers?: {
    list(): Trigger[];
    moveToTeam(id: string, teamId: string): Promise<boolean>;
  };
  cron: { moveMemberTasks(session: string, fromTeamId: string, toTeamId: string): Promise<string[]> };
  /** Absent when owner decisions are not set up */
  decisions?: { reassignTeam(sessions: ReadonlySet<string>, fromTeamId: string, toTeamId: string): Promise<string[]> };
  sessionState: { setTeamId(sessionName: string, teamId: string): boolean };
}

/** What to move. */
export interface MoveMemberInput {
  fromTeamId: string;
  memberId: string;
  toTeamId: string;
  /** Move the source team's lead anyway */
  allowLead?: boolean;
  /**
   * Make the member the lead of the target team after the move. A source lead
   * then needs no `allowLead` as long as the source keeps another lead.
   */
  asLead?: boolean;
}

/** What a move did. */
export interface MoveMemberResult {
  member: { id: string; name: string; role: string; sessionName: string };
  from: { id: string; name: string };
  to: { id: string; name: string };
  /** True when `asLead` was asked and the member now leads the target */
  leadOfTarget: boolean;
  /** The running session still has the old team's context until it restarts */
  restartRequired: boolean;
  updated: {
    workItems: string[];
    triggers: string[];
    cronTasks: string[];
    decisions: string[];
    sessionState: boolean;
  };
  /** Things the caller should look at */
  warnings: string[];
}

/** One move at a time: two interleaved moves could each undo the other. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Move a member to another team.
 *
 * The target config is written first, then the source; if the second write
 * fails, the first is undone, so the member is never lost and does not stay in
 * both. Record updates run after the move; one that fails becomes a warning.
 *
 * @param deps - Stores
 * @param input - Member, source and target
 * @returns What moved and what changed
 * @throws {MoveRefusedError} when the move must not happen (nothing changed)
 * @throws {Error} when a team config could not be written
 *
 * @example
 * ```typescript
 * await moveTeamMember(deps, { fromTeamId: 'a', memberId: 'm1', toTeamId: 'b' });
 * ```
 */
export function moveTeamMember(deps: MoveMemberDeps, input: MoveMemberInput): Promise<MoveMemberResult> {
  const run = queue.then(() => performMove(deps, input));
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Read one team fresh from storage.
 *
 * @param deps - Stores
 * @param teamId - Team id
 * @returns The team, or undefined
 */
async function readTeam(deps: MoveMemberDeps, teamId: string): Promise<Team | undefined> {
  return (await deps.storage.getTeams()).find((t) => t.id === teamId);
}

/**
 * The checks that need no I/O beyond the two teams.
 *
 * @param source - Source team
 * @param target - Target team
 * @param member - Member in the source
 * @param sessionName - Its permanent session name
 * @param intent - `allowLead` / `asLead` from the request
 * @throws {MoveRefusedError}
 */
function assertMovable(source: Team, target: Team, member: TeamMember, sessionName: string, intent: Pick<MoveMemberInput, 'allowLead' | 'asLead'>): void {
  if (sessionName === ORCHESTRATOR_SESSION_NAME) {
    throw new MoveRefusedError('orchestrator', 'The orchestrator cannot be moved.');
  }
  if (target.archived) {
    throw new MoveRefusedError('target_archived', `Team "${target.name}" is archived. Restore it first.`);
  }
  if (target.members.some((m) => m.id === member.id || resolveMemberSessionName(target.name, m) === sessionName)) {
    throw new MoveRefusedError('already_in_target', `${member.name} is already in "${target.name}" as well as "${source.name}". Remove the duplicate before moving.`);
  }
  if (member.temporary) {
    throw new MoveRefusedError('member_is_temporary', `${member.name} is a temporary member of "${source.name}". Remove it, or have the owner make it permanent first.`);
  }
  const targetNamesItLead = Boolean(target.leaderIds?.includes(member.id) || target.leaderId === member.id);
  const leads = getTeamLeadIds(source);
  // A co-lead leaving to lead the target: the source is not left without one.
  const leavesALead = intent.asLead === true && leads.some((id) => id !== member.id);
  if (leads.includes(member.id) && !targetNamesItLead && !leavesALead && intent.allowLead !== true) {
    throw new MoveRefusedError(
      'member_is_lead',
      `${member.name} leads "${source.name}". Give the team another lead first (set-team-lead), or pass allowLead to move the lead anyway.`,
    );
  }
}

/**
 * Take a member out of a team, including the references other members hold.
 *
 * @param team - Team (mutated)
 * @param memberId - Member id
 * @returns Names of members that reported to it
 */
function detach(team: Team, memberId: string): string[] {
  const orphaned: string[] = [];
  team.members = team.members.filter((m) => m.id !== memberId);
  for (const m of team.members) {
    if (m.subordinateIds?.includes(memberId)) m.subordinateIds = m.subordinateIds.filter((id) => id !== memberId);
    if (m.parentMemberId === memberId) {
      delete m.parentMemberId;
      orphaned.push(m.name);
    }
  }
  if (team.leaderIds) team.leaderIds = team.leaderIds.filter((id) => id !== memberId);
  if (team.leaderId === memberId) team.leaderId = team.leaderIds?.[0];
  team.updatedAt = new Date().toISOString();
  return orphaned;
}

/**
 * The member entry as the target stores it: the same entry, with the fields
 * that pointed into the source team replaced.
 *
 * @param member - Entry from the source
 * @param source - Source team
 * @param target - Target team
 * @param prompt - The member's stored prompt
 * @returns New entry
 */
function entryForTarget(member: TeamMember, source: Team, target: Team, prompt: string): TeamMember {
  const entry: TeamMember = {
    ...member,
    // Pin the permanent id from the SOURCE team's name. Saved without it, the
    // target would derive a new one from its own name and the agent would lose
    // its memory.
    agentId: memberAgentId(source.name, member),
    // Only the generated sentence names the team; a custom prompt is kept as written.
    systemPrompt: prompt.replace(
      `You are ${member.name}, a ${member.role} on the ${source.name} team.`,
      `You are ${member.name}, a ${member.role} on the ${target.name} team.`,
    ),
    updatedAt: new Date().toISOString(),
  };
  const hadHierarchy = entry.parentMemberId !== undefined || entry.hierarchyLevel !== undefined || entry.canDelegate !== undefined || entry.subordinateIds !== undefined;
  delete entry.parentMemberId;
  delete entry.subordinateIds;
  const namedLead = Boolean(target.leaderIds?.includes(entry.id) || target.leaderId === entry.id);
  if (!namedLead && hadHierarchy) {
    delete entry.hierarchyLevel;
    delete entry.canDelegate;
  }
  return entry;
}

/**
 * Put the member into the target and, on a hierarchical team, under its lead.
 *
 * @param target - Target team (mutated)
 * @param entry - Member entry (mutated)
 */
function attach(target: Team, entry: TeamMember): void {
  const namedLead = Boolean(target.leaderIds?.includes(entry.id) || target.leaderId === entry.id);
  const lead = target.hierarchical && !namedLead ? getTeamLeads(target)[0] : undefined;
  if (lead) {
    entry.parentMemberId = lead.id;
    entry.hierarchyLevel = (lead.hierarchyLevel ?? 1) + 1;
    entry.canDelegate = false;
    lead.subordinateIds = [...(lead.subordinateIds ?? []), entry.id];
  }
  target.members.push(entry);
  target.updatedAt = new Date().toISOString();
}

/**
 * Make sure the member is in the target and not in the source. A status write
 * that read a team before the move can save the old member list over it.
 *
 * @param deps - Stores
 * @param input - Move
 * @param entry - Entry as stored in the target
 * @returns True when both configs are right
 */
async function settle(deps: MoveMemberDeps, input: MoveMemberInput, entry: TeamMember): Promise<boolean> {
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    const source = await readTeam(deps, input.fromTeamId);
    const target = await readTeam(deps, input.toTeamId);
    const inSource = Boolean(source?.members.some((m) => m.id === entry.id));
    const inTarget = Boolean(target?.members.some((m) => m.id === entry.id));
    if (!inSource && inTarget) return true;
    if (target && !inTarget) {
      attach(target, { ...entry });
      await deps.storage.saveTeam(target);
    }
    if (source && inSource) {
      detach(source, entry.id);
      await deps.storage.saveTeam(source);
    }
  }
  return false;
}

/**
 * Write both team configs: target first, then source, undoing the first write
 * if the second fails.
 *
 * @param deps - Stores
 * @param input - Move
 * @param target - Target team, without the member
 * @param entry - Entry for the target
 * @returns Names of source members that reported to the moved one
 * @throws {Error} when a config could not be written
 */
async function writeTeams(deps: MoveMemberDeps, input: MoveMemberInput, target: Team, entry: TeamMember): Promise<string[]> {
  const targetName = target.name;
  attach(target, entry);
  await deps.storage.saveTeam(target);
  try {
    const source = await readTeam(deps, input.fromTeamId);
    if (!source) throw new Error('The source team disappeared during the move');
    const orphaned = detach(source, entry.id);
    await deps.storage.saveTeam(source);
    return orphaned;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      const written = await readTeam(deps, input.toTeamId);
      if (written) {
        detach(written, entry.id);
        await deps.storage.saveTeam(written);
      }
    } catch (undoError) {
      throw new Error(`Move failed (${reason}) and could not be undone (${undoError instanceof Error ? undoError.message : String(undoError)}): ${entry.name} may be listed in both teams. Remove it from "${targetName}".`);
    }
    throw new Error(`Move failed, nothing changed: ${reason}`);
  }
}

/**
 * The move itself (see {@link moveTeamMember}).
 *
 * @param deps - Stores
 * @param input - Move
 * @returns Result
 */
async function performMove(deps: MoveMemberDeps, input: MoveMemberInput): Promise<MoveMemberResult> {
  const { fromTeamId, memberId, toTeamId } = input;
  if (fromTeamId === ORCHESTRATOR_TEAM_ID || toTeamId === ORCHESTRATOR_TEAM_ID) {
    throw new MoveRefusedError('orchestrator', 'The orchestrator team cannot gain or lose members.');
  }
  const source = await readTeam(deps, fromTeamId);
  if (!source) throw new MoveRefusedError('source_not_found', `No team "${fromTeamId}".`, 404);
  if (fromTeamId === toTeamId) {
    throw new MoveRefusedError('same_team', `The member is already on "${source.name}"; nothing to move.`);
  }
  const target = await readTeam(deps, toTeamId);
  if (!target) throw new MoveRefusedError('target_not_found', `No team "${toTeamId}".`, 404);
  const member = source.members.find((m) => m.id === memberId);
  if (!member) {
    if (target.members.some((m) => m.id === memberId)) {
      throw new MoveRefusedError('same_team', `The member is already on "${target.name}"; nothing to move.`);
    }
    throw new MoveRefusedError('member_not_found', `Team "${source.name}" has no member "${memberId}".`, 404);
  }
  const sessionName = resolveMemberSessionName(source.name, member);
  assertMovable(source, target, member, sessionName, input);

  const state = await deps.runState(member, sessionName);
  if (state === 'busy' || state === 'starting') {
    throw new MoveRefusedError(
      'member_busy',
      `${member.name} is ${state === 'busy' ? 'working right now' : 'starting up'}. Move it when it is idle, or stop it first.`,
    );
  }

  const warnings: string[] = [];
  const wasLead = getTeamLeadIds(source).includes(member.id);
  const prompt = (await deps.storage.getMemberPrompt(fromTeamId, memberId)) ?? member.systemPrompt ?? '';
  const entry = entryForTarget(member, source, target, prompt);
  if (target.members.some((m) => m.name.trim().toLowerCase() === member.name.trim().toLowerCase())) {
    warnings.push(`"${target.name}" already has another member called ${member.name}.`);
  }

  const orphaned = await writeTeams(deps, input, target, entry);
  if (!(await settle(deps, input, entry))) {
    warnings.push('The team configs kept changing during the move; check both teams list the member once, in the target only.');
  }

  let leadOfTarget = false;
  if (input.asLead === true) {
    try {
      const current = await readTeam(deps, toTeamId);
      if (!current) throw new Error('the team disappeared');
      const replaced = getTeamLeads(current).filter((m) => m.id !== member.id).map((m) => m.name);
      await deps.makeLead(current, member.id);
      leadOfTarget = true;
      if (replaced.length > 0) warnings.push(`${member.name} replaced ${replaced.join(', ')} as lead of "${target.name}".`);
    } catch (error) {
      warnings.push(`${member.name} moved but was NOT made lead of "${target.name}" (${error instanceof Error ? error.message : String(error)}). Run set-team-lead.`);
    }
  }

  const ids: ReadonlySet<string> = new Set([sessionName, entry.agentId as string, member.id]);
  const updated: MoveMemberResult['updated'] = { workItems: [], triggers: [], cronTasks: [], decisions: [], sessionState: false };
  /** Run one record update; a failure must not hide that the member moved. */
  const step = async (what: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      warnings.push(`Could not update ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await step('saved prompt of the old team', () => deps.storage.removeMemberPrompt(fromTeamId, memberId));
  await step('work items', async () => {
    for (const wi of await deps.workItems.getAllItems()) {
      if (!isOpenWorkItem(wi) || !wi.target || !ids.has(wi.target) || wi.metadata?.['teamId'] !== fromTeamId) continue;
      if (await deps.workItems.patchMetadata(wi.id, 'teamId', toTeamId)) updated.workItems.push(wi.id);
    }
  });
  await step('followups and watchers', async () => {
    if (!deps.triggers) {
      warnings.push('The trigger engine is not running; followups were not checked.');
      return;
    }
    for (const trigger of deps.triggers.list()) {
      if (trigger.teamId !== fromTeamId) continue;
      const aimedAt = trigger.action.createWorkItem?.target ?? trigger.action.sendMessage?.target;
      const aimsAtMember = typeof aimedAt === 'string' && ids.has(aimedAt);
      if (isSpecManaged(trigger)) {
        // The team's own schedule: it stays, but it still names the agent that left.
        if (aimsAtMember) warnings.push(`"${source.name}" has a team schedule "${trigger.name ?? trigger.id}" aimed at ${member.name}; edit the team's triggers.`);
        continue;
      }
      const madeByMemberForItself = !aimedAt && trigger.createdBySession !== undefined && ids.has(trigger.createdBySession);
      const wakes = trigger.action.wakeWorkItemId;
      const wakesMemberWork = wakes !== undefined && updated.workItems.includes(wakes);
      if (!aimsAtMember && !madeByMemberForItself && !wakesMemberWork) continue;
      if (await deps.triggers.moveToTeam(trigger.id, toTeamId)) updated.triggers.push(trigger.id);
    }
  });
  await step('cron tasks', async () => {
    updated.cronTasks = await deps.cron.moveMemberTasks(sessionName, fromTeamId, toTeamId);
  });
  await step('open owner decisions', async () => {
    if (deps.decisions) updated.decisions = await deps.decisions.reassignTeam(ids, fromTeamId, toTeamId);
  });
  await step('session restore state', async () => {
    updated.sessionState = deps.sessionState.setTeamId(sessionName, toTeamId);
  });

  if (orphaned.length > 0) warnings.push(`In "${source.name}", ${orphaned.join(', ')} reported to ${member.name} and now have no manager.`);
  const after = await readTeam(deps, fromTeamId);
  if (wasLead) {
    const leads = after ? getTeamLeads(after).map((m) => m.name) : [];
    warnings.push(leads.length > 0 ? `"${source.name}" is now led by ${leads.join(', ')}.` : `"${source.name}" has no lead now; set one with set-team-lead.`);
  }
  if (after && after.members.length === 0) {
    warnings.push(`"${source.name}" has no members left; remove ${member.name} from its team channel by hand.`);
  }
  const sourceProject = source.projectIds?.[0];
  const targetProject = target.projectIds?.[0];
  if (targetProject && targetProject !== sourceProject) {
    warnings.push(`"${target.name}" works in another project: the next start uses that project's folder, so the previous conversation may not resume (memory is unaffected).`);
  }

  return {
    member: { id: member.id, name: member.name, role: member.role, sessionName },
    from: { id: source.id, name: source.name },
    to: { id: target.id, name: target.name },
    leadOfTarget,
    restartRequired: state === 'idle',
    updated,
    warnings,
  };
}
