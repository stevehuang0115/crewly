/**
 * Project ticket types (specs/2026-09-28-project-tickets.md).
 *
 * A project ticket is one markdown file under `<project>/.crewly/tickets/`
 * with YAML frontmatter. These types describe the parsed file, the state
 * machine, and the link a WorkItem carries back to its ticket.
 *
 * @module types/project-ticket.types
 */

import { PROJECT_TICKET_CONSTANTS } from '../constants.js';

/** Ticket status (board column). */
export type ProjectTicketStatus = (typeof PROJECT_TICKET_CONSTANTS.STATUSES)[number];

/** Ticket priority, P0 highest. */
export type ProjectTicketPriority = (typeof PROJECT_TICKET_CONSTANTS.PRIORITIES)[number];

/** One acceptance criterion (a `- [ ]` / `- [x]` line). */
export interface ProjectTicketCriterion {
  text: string;
  done: boolean;
}

/**
 * The frontmatter fields the service owns. Every other frontmatter key is
 * preserved untouched (see `extra` on {@link ProjectTicket}).
 */
export interface ProjectTicketFields {
  id: string;
  title: string;
  status: ProjectTicketStatus;
  priority: ProjectTicketPriority;
  /** Agent session name or a human's name; null when unassigned */
  assignee: string | null;
  /** Team id that owns the ticket; null = any team on the project */
  team: string | null;
  labels: string[];
  /** When true, a verified WorkItem lands the ticket in `review` instead of `done` */
  ownerReview: boolean;
  createdAt: string;
  updatedAt: string;
  /** The currently linked WorkItem */
  workItemId: string | null;
  /** Optional harness ticket (Request) this ticket came from */
  requestId: string | null;
  /** Who created it: `owner`, `agent:<session>`, `request:<TKT>`, `v1-migration` */
  source: string | null;
  /** Repo-relative path of the v1 task file this ticket was imported from */
  migratedFrom: string | null;
  /**
   * Date (`YYYY-MM-DD` or ISO time) until which the ticket stays out of the
   * autopilot's triage; it is offered again afterwards. Absent / null = not deferred.
   */
  deferUntil?: string | null;
}

/** Frontmatter keys the service writes, in the order new files list them. */
export const OWNED_TICKET_FIELDS: ReadonlyArray<keyof ProjectTicketFields> = [
  'id',
  'title',
  'status',
  'priority',
  'assignee',
  'team',
  'labels',
  'ownerReview',
  'createdAt',
  'updatedAt',
  'workItemId',
  'requestId',
  'source',
  'migratedFrom',
  'deferUntil',
];

/** A ticket as the API returns it. */
export interface ProjectTicket extends ProjectTicketFields {
  /** File name inside the tickets folder */
  fileName: string;
  /** Absolute file path */
  filePath: string;
  /** Absolute project root the ticket belongs to */
  projectPath: string;
  /** Text of the `## Description` section (trimmed) */
  description: string;
  /** Items of the `## Acceptance criteria` section */
  acceptance: ProjectTicketCriterion[];
  /** Lines of the `## Log` section (without the leading `- `) */
  log: string[];
  /** Frontmatter keys the service does not own, as parsed */
  extra: Record<string, unknown>;
  /** Everything after the frontmatter, verbatim (only on single-ticket reads) */
  body?: string;
}

/** A file in the tickets folder that could not be read as a ticket. */
export interface InvalidTicketFile {
  fileName: string;
  error: string;
}

/** Result of listing a project's tickets. */
export interface ProjectTicketList {
  tickets: ProjectTicket[];
  invalid: InvalidTicketFile[];
}

/** The link a WorkItem carries to its project ticket (`metadata.projectTicket`). */
export interface ProjectTicketLink {
  projectPath: string;
  id: string;
}

/**
 * Allowed status transitions (spec §3). Same-status is not a transition.
 */
export const PROJECT_TICKET_TRANSITIONS: Readonly<Record<ProjectTicketStatus, readonly ProjectTicketStatus[]>> = {
  backlog: ['ready', 'in_progress', 'cancelled'],
  ready: ['backlog', 'in_progress', 'cancelled'],
  in_progress: ['ready', 'backlog', 'review', 'done', 'cancelled'],
  review: ['done', 'ready', 'cancelled'],
  done: ['ready'],
  cancelled: ['backlog'],
};

/**
 * Whether a value is a ticket status.
 *
 * @param value - Anything
 * @returns True for one of {@link PROJECT_TICKET_CONSTANTS.STATUSES}
 */
export function isProjectTicketStatus(value: unknown): value is ProjectTicketStatus {
  return typeof value === 'string' && (PROJECT_TICKET_CONSTANTS.STATUSES as readonly string[]).includes(value);
}

/**
 * Whether `from → to` is an allowed transition.
 *
 * @param from - Current status
 * @param to - Wanted status
 * @returns True when the state machine allows it
 */
export function isValidProjectTicketTransition(from: ProjectTicketStatus, to: ProjectTicketStatus): boolean {
  return PROJECT_TICKET_TRANSITIONS[from].includes(to);
}

/**
 * Normalise a priority written by a human or an older tool.
 *
 * Accepts `P0`–`P3` in any case and the v1 words (critical/urgent → P0,
 * high → P1, medium/normal → P2, low → P3).
 *
 * @param value - Raw value
 * @returns The priority, or null when it cannot be read
 *
 * @example
 * ```typescript
 * normalizeProjectTicketPriority('high'); // 'P1'
 * normalizeProjectTicketPriority('p0');   // 'P0'
 * ```
 */
export function normalizeProjectTicketPriority(value: unknown): ProjectTicketPriority | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  switch (v) {
    case 'p0':
    case 'critical':
    case 'urgent':
      return 'P0';
    case 'p1':
    case 'high':
      return 'P1';
    case 'p2':
    case 'medium':
    case 'normal':
      return 'P2';
    case 'p3':
    case 'low':
      return 'P3';
    default:
      return null;
  }
}

/**
 * Rank of a priority for sorting (0 = P0 = first).
 *
 * @param p - Priority
 * @returns 0..3
 */
export function projectTicketPriorityRank(p: ProjectTicketPriority): number {
  return (PROJECT_TICKET_CONSTANTS.PRIORITIES as readonly string[]).indexOf(p);
}

/**
 * Read `metadata.projectTicket` from a WorkItem's metadata.
 *
 * @param metadata - WorkItem metadata (may be undefined)
 * @returns The link, or null when absent or malformed
 */
export function readProjectTicketLink(metadata: Record<string, unknown> | undefined): ProjectTicketLink | null {
  const raw = metadata?.[PROJECT_TICKET_CONSTANTS.WORK_ITEM_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null) return null;
  const { projectPath, id } = raw as Partial<ProjectTicketLink>;
  if (typeof projectPath !== 'string' || !projectPath || typeof id !== 'string' || !id) return null;
  return { projectPath, id };
}
