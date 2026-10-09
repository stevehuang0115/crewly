/**
 * Gather what the Drive mode status snapshot is built from
 * (specs/2026-10-09-drive-mode-v3.md §1): teams and agents from storage,
 * every project's tickets, the task pool, the briefing queue's live owner
 * items and the agents' recent messages to the owner. Each source is read
 * on its own; one that fails is left empty, never the whole snapshot.
 *
 * @module services/drive/drive-briefing.wiring
 */

import { DRIVE_BRIEFING_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import type { Team } from '../../types/index.js';
import { resolveMemberSessionName } from '../../utils/member-session-name.utils.js';
import { getTeamLeads } from '../../utils/team.utils.js';
import type { OwnerTurnMark } from '../briefing/briefing-cards.js';
import type { RecallFeedMessage } from './drive-recall.js';
import { agentStateOf, type SnapshotSources, type SnapshotTicketSource, type SnapshotWaitingSource, type SnapshotWorkItemSource } from './drive-briefing-snapshot.js';

const C = DRIVE_BRIEFING_CONSTANTS;

/** Where the sources come from. */
export interface BriefingWiringDeps {
  getTeams: () => Promise<Team[]>;
  getProjects: () => Promise<Array<{ name: string; path: string }>>;
  listTickets: (projectPath: string) => Promise<Array<Omit<SnapshotTicketSource, 'project'>>>;
  listWorkItems: () => Promise<SnapshotWorkItemSource[]>;
  /** Live owner items (the briefing queue) */
  waiting: () => Promise<SnapshotWaitingSource[]>;
  ownerFeed: (sinceMs: number, limit: number) => { messages: RecallFeedMessage[]; ownerTurns: OwnerTurnMark[] };
  /** Whether the orchestrator's session runs */
  orchestratorRunning: () => boolean;
  /** The orchestrator's display name */
  orchestratorName: string;
  now?: () => Date;
}

/** Read a source; a failure gives the fallback. */
async function read<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * Gather the snapshot sources.
 *
 * @param deps - Where they come from
 * @returns Sources for `buildBriefingSnapshot`
 */
export async function collectSnapshotSources(deps: BriefingWiringDeps): Promise<SnapshotSources> {
  const now = deps.now?.() ?? new Date();
  const [teams, projects, workItems, waiting] = await Promise.all([
    read(deps.getTeams, [] as Team[]),
    read(deps.getProjects, [] as Array<{ name: string; path: string }>),
    read(deps.listWorkItems, [] as SnapshotWorkItemSource[]),
    read(deps.waiting, [] as SnapshotWaitingSource[]),
  ]);
  const tickets = (
    await Promise.all(
      projects.map(async (p) => (await read(() => deps.listTickets(p.path), [] as Array<Omit<SnapshotTicketSource, 'project'>>)).map((t) => ({ ...t, project: p.name }))),
    )
  ).flat();

  const agents: SnapshotSources['agents'] = [
    { agentSession: ORCHESTRATOR_SESSION_NAME, name: deps.orchestratorName, role: 'orchestrator', state: safeBool(deps.orchestratorRunning) ? 'idle' : 'stopped' },
  ];
  const seen = new Set<string>([ORCHESTRATOR_SESSION_NAME]);
  const teamRows: SnapshotSources['teams'] = [];
  for (const team of teams) {
    const members = (team.members ?? []).filter((m) => m?.id && String(m.role) !== 'orchestrator');
    const sessions: string[] = [];
    for (const m of members) {
      const session = resolveMemberSessionName(team.name, m);
      if (!session) continue;
      sessions.push(session);
      if (seen.has(session)) continue;
      seen.add(session);
      agents.push({ agentSession: session, name: m.name || session, team: team.name, ...(m.role ? { role: String(m.role) } : {}), state: agentStateOf(m.agentStatus, m.workingStatus) });
    }
    if (sessions.length === 0) continue;
    const lead = getTeamLeads(team)[0];
    teamRows.push({ id: team.id, name: team.name, ...(lead ? { lead: resolveMemberSessionName(team.name, lead) } : { lead: sessions[0] }), members: sessions });
  }

  const feed = await read(() => deps.ownerFeed(now.getTime() - C.OWNER_FEED_WINDOW_MS, C.OWNER_FEED_SCAN_LIMIT), { messages: [], ownerTurns: [] });
  return { now, agents, teams: teamRows, tickets, workItems, waiting, ownerFeed: feed };
}

function safeBool(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

/**
 * Cached reads of the expensive sources (every project's tickets, the task
 * pool), so a busy machine does not re-read them on each rebuild. A
 * project's tickets are re-read after a change event for that project (or
 * after {@link DRIVE_BRIEFING_CONSTANTS.TICKET_CACHE_MS}); the pool after a
 * work-item event (or after {@link DRIVE_BRIEFING_CONSTANTS.POOL_CACHE_MS}).
 */
export class SnapshotSourceCache {
  private readonly tickets = new Map<string, { at: number; value: Array<Omit<SnapshotTicketSource, 'project'>> }>();
  private pool: { at: number; value: SnapshotWorkItemSource[] } | null = null;

  /**
   * @param now - Clock (ms)
   */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Wrap ticket and pool readers with the cache.
   *
   * @param readers - The uncached readers
   * @returns Cached readers for {@link BriefingWiringDeps}
   */
  wrap(readers: Pick<BriefingWiringDeps, 'listTickets' | 'listWorkItems'>): Pick<BriefingWiringDeps, 'listTickets' | 'listWorkItems'> {
    return {
      listTickets: async (projectPath) => {
        const hit = this.tickets.get(projectPath);
        if (hit && this.now() - hit.at < C.TICKET_CACHE_MS) return hit.value;
        const value = await readers.listTickets(projectPath);
        this.tickets.set(projectPath, { at: this.now(), value });
        return value;
      },
      listWorkItems: async () => {
        if (this.pool && this.now() - this.pool.at < C.POOL_CACHE_MS) return this.pool.value;
        const value = await readers.listWorkItems();
        this.pool = { at: this.now(), value };
        return value;
      },
    };
  }

  /**
   * A ticket of this project changed (or, without a path, any project).
   *
   * @param projectPath - Absolute project root
   */
  invalidateTickets(projectPath?: string): void {
    if (projectPath) this.tickets.delete(projectPath);
    else this.tickets.clear();
  }

  /** A work item moved. */
  invalidatePool(): void {
    this.pool = null;
  }
}
