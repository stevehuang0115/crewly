/**
 * Which records of the global stores belong to a team. Pure functions: the
 * exporter (source) selects with them, the archiver removes with them.
 *
 * @module services/team-move/team-move-select
 */

import { SLACK_TEAM_CHANNEL_CONSTANTS } from '../../constants.js';
import type { Team } from '../../types/index.js';
import type { ScheduledMessage } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TaskClaim } from '../../types/v2/claim.types.js';
import { TERMINAL_WORK_ITEM_STATUSES } from '../../types/v2/work-item.types.js';

/** What identifies a team's records in the global stores. */
export interface TeamIdentity {
  teamId: string;
  teamName: string;
  /** Member session names. */
  sessions: ReadonlySet<string>;
  /** Member ids. */
  memberIds: ReadonlySet<string>;
}

/**
 * Identity of a team.
 *
 * @param team - The team
 * @returns Ids and session names to match records by
 */
export function identityOf(team: Pick<Team, 'id' | 'name' | 'members'>): TeamIdentity {
  return {
    teamId: team.id,
    teamName: team.name,
    sessions: new Set(team.members.map((m) => m.sessionName).filter((s): s is string => typeof s === 'string' && s.length > 0)),
    memberIds: new Set(team.members.map((m) => m.id)),
  };
}

/**
 * Whether a free-form target string names the team or one of its members.
 *
 * @param target - A `target`/`targetTeam`/session field value
 * @param id - Team identity
 * @returns True on a match
 */
export function targetsTeam(target: unknown, id: TeamIdentity): boolean {
  if (typeof target !== 'string' || target.length === 0) return false;
  return target === id.teamId || target === id.teamName || id.sessions.has(target) || id.memberIds.has(target);
}

/** Work-item statuses that are still open (not finished, cancelled or verified). */
const OPEN_EXCLUDED = new Set<string>([...TERMINAL_WORK_ITEM_STATUSES, 'failed', 'rejected']);

/**
 * Whether a work item is still open.
 *
 * @param wi - Work item
 * @returns True when it is neither terminal nor failed/rejected
 */
export function isOpenWorkItem(wi: Pick<WorkItem, 'status'>): boolean {
  return !OPEN_EXCLUDED.has(wi.status);
}

/** The slice of the pool a team owns. */
export interface TeamPoolSlice {
  workItems: WorkItem[];
  /** Active claims by team members on selected items (not moved; counted for the report). */
  activeClaims: number;
}

/**
 * Open task-pool items of a team: those aimed at the team or a member, those
 * a member is working on, and their open children.
 *
 * @param pool - The pool file content
 * @param pool.workItems - All work items
 * @param pool.claims - All claims
 * @param id - Team identity
 * @returns Selected items
 */
export function selectPoolItems(pool: { workItems?: WorkItem[]; claims?: TaskClaim[] }, id: TeamIdentity): TeamPoolSlice {
  const items = Array.isArray(pool.workItems) ? pool.workItems : [];
  const claims = Array.isArray(pool.claims) ? pool.claims : [];
  const activeByItem = new Map<string, TaskClaim>();
  for (const c of claims) if (c.status === 'active' && id.sessions.has(c.agentId)) activeByItem.set(c.workItemId, c);
  const picked = new Map<string, WorkItem>();
  for (const wi of items) {
    if (!isOpenWorkItem(wi)) continue;
    if (targetsTeam(wi.target, id) || activeByItem.has(wi.id)) picked.set(wi.id, wi);
  }
  // Open children of picked items follow their parent.
  let grew = true;
  while (grew) {
    grew = false;
    for (const wi of items) {
      if (picked.has(wi.id) || !isOpenWorkItem(wi)) continue;
      if (wi.parentWorkItemId && picked.has(wi.parentWorkItemId)) {
        picked.set(wi.id, wi);
        grew = true;
      }
    }
  }
  const activeClaims = [...picked.keys()].filter((k) => activeByItem.has(k)).length;
  return { workItems: [...picked.values()], activeClaims };
}

/**
 * Make a work item safe to start over on the target: nothing is running there
 * yet, so an item that was being worked on goes back to the queue.
 *
 * @param wi - Work item as exported
 * @returns Copy for the target
 */
export function resetWorkItemForTarget(wi: WorkItem): WorkItem {
  const next: WorkItem = { ...wi };
  if (next.status === 'running' || next.status === 'accepted') {
    next.status = 'queued';
    delete next.startedAt;
    next.metadata = { ...(next.metadata ?? {}), movedFromRunning: true };
  }
  return next;
}

/**
 * Scheduled messages (legacy owner-created reminders) that address a team.
 *
 * @param messages - All scheduled messages
 * @param id - Team identity
 * @returns Those whose `targetTeam` names the team or one of its members
 */
export function selectScheduledMessages(messages: readonly ScheduledMessage[], id: TeamIdentity): ScheduledMessage[] {
  return messages.filter((m) => targetsTeam(m.targetTeam, id));
}

/** The decision fields the selector reads. */
export interface DecisionLike {
  id: string;
  status: string;
  teamId?: string;
  asker?: string;
  requestedBy?: string;
}

/** Decision statuses that still wait for the owner. */
const PENDING_DECISION_STATUSES = new Set(['open', 'parked']);

/**
 * Open decisions/requests to the owner that belong to a team.
 *
 * @param decisions - All decisions
 * @param id - Team identity
 * @returns Pending ones asked by the team or one of its members
 */
export function selectDecisions<T extends DecisionLike>(decisions: readonly T[], id: TeamIdentity): T[] {
  return decisions.filter(
    (d) =>
      PENDING_DECISION_STATUSES.has(d.status) &&
      (d.teamId === id.teamId || (typeof d.asker === 'string' && id.sessions.has(d.asker)) || (typeof d.requestedBy === 'string' && id.sessions.has(d.requestedBy))),
  );
}

/**
 * The Crewly channels (ad-hoc Slack mappings, shared by agents of several
 * teams) that have at least one of the team's agents as a member. Each comes
 * back with `members` and `excluded` cut to the team's own agents: the other
 * teams' agents are not on the target machine and stay in the channel on the
 * source.
 *
 * @param mappings - Every mapping in `slack-team-channels.json`
 * @param id - Identity of the team that moves
 * @returns Mapping copies for the package (empty when the team is in none)
 */
export function selectAdhocMappings(mappings: ReadonlyArray<Record<string, unknown>>, id: TeamIdentity): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of mappings) {
    const teamId = m['teamId'];
    if (typeof teamId !== 'string' || !teamId.startsWith(SLACK_TEAM_CHANNEL_CONSTANTS.ADHOC_TEAM_PREFIX)) continue;
    const mine = (Array.isArray(m['members']) ? (m['members'] as unknown[]) : []).filter((x): x is string => typeof x === 'string' && id.sessions.has(x));
    if (mine.length === 0) continue;
    const excluded = (Array.isArray(m['excluded']) ? (m['excluded'] as unknown[]) : []).filter((x): x is string => typeof x === 'string' && id.sessions.has(x));
    out.push({ ...m, members: mine, ...(excluded.length > 0 ? { excluded } : { excluded: undefined }) });
  }
  return out;
}
