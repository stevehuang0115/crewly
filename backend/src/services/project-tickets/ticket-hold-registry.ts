/**
 * Ticket hold registry (crewly#1369 gap 1) — finds held tickets across every
 * project, for the places outside one ticket folder that must honour a hold:
 * decision cards ({@link checkDecisionHold}) and the worktree janitor's
 * unmerged-worktree notice ({@link findWorktreeHold}).
 *
 * Reads go through {@link ProjectTicketService.list} (mtime-cached), so a
 * lookup costs one `readdir` + `stat` per project. Never throws: a project
 * that cannot be read is skipped.
 *
 * @module services/project-tickets/ticket-hold-registry
 */

import type { ProjectTicket } from '../../types/project-ticket.types.js';
import {
  decisionHoldRefusal,
  extractWorkRefs,
  findHeldMatches,
  mergeWorkRefs,
  readTicketHold,
  worktreeRefs,
  type HeldTicketMatch,
  type WorkRefs,
} from './ticket-hold.js';

/** Collaborators (injectable for tests). */
export interface TicketHoldRegistryDeps {
  /** Project roots to look in (default: every project in storage) */
  listProjectPaths?: () => Promise<string[]>;
  /** Ticket listing (default: the ProjectTicketService singleton) */
  listTickets?: (projectPath: string) => Promise<ProjectTicket[]>;
}

/**
 * Default project roots: every project in storage.
 *
 * @returns Paths
 */
async function defaultProjectPaths(): Promise<string[]> {
  const { StorageService } = await import('../core/storage.service.js');
  const projects = await StorageService.getInstance().getProjects();
  return [...new Set(projects.map((p) => p?.path).filter((p): p is string => typeof p === 'string' && p.length > 0))];
}

/**
 * Default ticket listing.
 *
 * @param projectPath - Project root
 * @returns Its tickets
 */
async function defaultListTickets(projectPath: string): Promise<ProjectTicket[]> {
  const { ProjectTicketService } = await import('./project-ticket.service.js');
  return (await ProjectTicketService.getInstance().list(projectPath)).tickets;
}

/**
 * Every held ticket of every project.
 *
 * @param deps - Collaborators
 * @returns Held tickets
 */
export async function listHeldTickets(deps: TicketHoldRegistryDeps = {}): Promise<ProjectTicket[]> {
  const paths = await (deps.listProjectPaths ?? defaultProjectPaths)().catch(() => [] as string[]);
  const list = deps.listTickets ?? defaultListTickets;
  const out: ProjectTicket[] = [];
  for (const p of paths) {
    const tickets = await list(p).catch(() => [] as ProjectTicket[]);
    for (const t of tickets) if (readTicketHold(t)) out.push(t);
  }
  return out;
}

/**
 * Held tickets the refs point at, across projects.
 *
 * @param refs - What the work names
 * @param deps - Collaborators
 * @returns Matches (tickets held in their own right first)
 */
export async function findHolds(refs: WorkRefs, deps: TicketHoldRegistryDeps = {}): Promise<HeldTicketMatch[]> {
  if (refs.prs.length + refs.branches.length + refs.worktrees.length + refs.tickets.length === 0) return [];
  return findHeldMatches(refs, await listHeldTickets(deps));
}

/**
 * The hold on a worktree's work, if a held ticket names its branch or folder.
 *
 * @param branch - Branch, or null when HEAD is detached
 * @param worktreePath - Worktree path
 * @param deps - Collaborators
 * @returns The first match, or null
 */
export async function findWorktreeHold(branch: string | null, worktreePath: string, deps: TicketHoldRegistryDeps = {}): Promise<HeldTicketMatch | null> {
  return (await findHolds(worktreeRefs(branch, worktreePath), deps).catch(() => [] as HeldTicketMatch[]))[0] ?? null;
}

/** What a decision card is about, for the hold check. */
export interface DecisionHoldInput {
  /** Question, option labels and details */
  text: string;
  /** Other words that name the work but are not the ask (the ticket title) */
  context?: string;
  /** The ticket the card is asked on, if any */
  ticketId?: string;
}

/**
 * Why a decision card must not go up because it is about held work, or null.
 * A card that only asks whether to close the held work is allowed.
 *
 * @param input - The card's words and ticket
 * @param deps - Collaborators
 * @returns The refusal, quoting the hold, or null
 */
export async function checkDecisionHold(input: DecisionHoldInput, deps: TicketHoldRegistryDeps = {}): Promise<string | null> {
  const refs = mergeWorkRefs(extractWorkRefs(`${input.text}\n${input.context ?? ''}`), {
    prs: [],
    branches: [],
    worktrees: [],
    tickets: input.ticketId ? [input.ticketId.toUpperCase()] : [],
  });
  const matches = await findHolds(refs, deps).catch(() => [] as HeldTicketMatch[]);
  return decisionHoldRefusal(input.text, matches);
}
