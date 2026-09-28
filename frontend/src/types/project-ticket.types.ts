/**
 * Project ticket types — mirrors of the `/api/project-tickets` payloads
 * (specs/2026-09-28-project-tickets.md). A project ticket is one markdown
 * file in `<project>/.crewly/tickets/`; this is its API shape.
 *
 * @module types/project-ticket.types
 */

/** Ticket status (board column). */
export type ProjectTicketStatus = 'backlog' | 'ready' | 'in_progress' | 'review' | 'done' | 'cancelled';

/** Ticket priority, P0 highest. */
export type ProjectTicketPriority = 'P0' | 'P1' | 'P2' | 'P3';

/** One acceptance criterion. */
export interface ProjectTicketCriterion {
  text: string;
  done: boolean;
}

/** A project ticket. */
export interface ProjectTicket {
  id: string;
  title: string;
  status: ProjectTicketStatus;
  priority: ProjectTicketPriority;
  assignee: string | null;
  team: string | null;
  labels: string[];
  ownerReview: boolean;
  createdAt: string;
  updatedAt: string;
  workItemId: string | null;
  requestId: string | null;
  source: string | null;
  migratedFrom: string | null;
  fileName: string;
  filePath: string;
  projectPath: string;
  description: string;
  acceptance: ProjectTicketCriterion[];
  log: string[];
  body?: string;
}

/** A file in the tickets folder that is not a valid ticket. */
export interface InvalidProjectTicketFile {
  fileName: string;
  error: string;
}

/** `GET /api/project-tickets/:project` payload. */
export interface ProjectTicketListResponse {
  project: { id: string; name: string; path: string };
  tickets: ProjectTicket[];
  invalid: InvalidProjectTicketFile[];
}

/** Body of a create call. */
export interface CreateProjectTicketInput {
  title: string;
  description?: string;
  acceptance?: string[];
  priority?: ProjectTicketPriority;
  labels?: string[];
  status?: ProjectTicketStatus;
  ownerReview?: boolean;
}

/** Body of an update call. */
export interface UpdateProjectTicketInput {
  title?: string;
  priority?: ProjectTicketPriority;
  labels?: string[];
  description?: string;
  acceptance?: ProjectTicketCriterion[];
  ownerReview?: boolean;
  status?: ProjectTicketStatus;
  note?: string;
}

/** An error from the project tickets API, with the HTTP status. */
export class ProjectTicketApiError extends Error {
  /**
   * @param message - Server message
   * @param status - HTTP status
   */
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ProjectTicketApiError';
  }
}

/**
 * Whether a string is a project ticket status.
 *
 * @param value - Anything
 * @returns True for a known status
 */
export function isProjectTicketStatus(value: unknown): value is ProjectTicketStatus {
  return typeof value === 'string' && ['backlog', 'ready', 'in_progress', 'review', 'done', 'cancelled'].includes(value);
}
