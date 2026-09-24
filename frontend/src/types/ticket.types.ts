/**
 * Ticket board types (specs/ticket-loop.md, Phase 2).
 *
 * Mirrors the shapes returned by `GET /api/tickets` and
 * `GET /api/tickets/:tkt`. A ticket IS a backend `Request` with extra fields;
 * the board works on the derived list row ({@link TicketListItem}).
 *
 * @module types/ticket.types
 */

/** What kind of ask a ticket is. */
export type TicketKind = 'issue' | 'feature' | 'idea';

/** Board column (derived server-side, never stored). */
export type TicketBoardColumn = 'idea' | 'todo' | 'in_progress' | 'blocked' | 'to_review' | 'done' | 'cancelled';

/** Stored priority. */
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

/** Display priority. */
export type TicketPriorityLabel = 'P0' | 'P1' | 'P2' | 'P3';

/** Where an acceptance criterion came from. */
export type TicketAcceptanceSource = 'owner' | 'decompose' | 'reject' | 'agent';

/** How a criterion is checked: `auto` = a build/test/scan can show it; `judgment` = needs a person. */
export type TicketAcceptanceCheck = 'auto' | 'judgment';

/** One acceptance criterion (live list; removed ones are filtered server-side). */
export interface TicketAcceptance {
  text: string;
  source?: TicketAcceptanceSource;
  check?: TicketAcceptanceCheck;
  selfCheck?: 'pass' | 'fail';
  evidence?: string;
  addedAt?: string;
}

/** Where the ticket was said and by whom. */
export interface TicketOrigin {
  channel: string;
  author: string;
  authorName?: string;
  ref?: string;
  threadRef?: string;
}

/** The agent's latest answer. */
export interface TicketReply {
  at: string;
  by: string;
  messageId: string;
  excerpt: string;
}

/** A follow-up appended to the ticket. */
export interface TicketDiscussionEntry {
  at: string;
  author: string;
  text: string;
  ref: string;
}

/** A board row (`GET /api/tickets` → `tickets[]`). */
export interface TicketListItem {
  id: string;
  tkt: string | null;
  ticketNumber?: number | null;
  title: string;
  description?: string;
  kind: TicketKind;
  column: TicketBoardColumn;
  status: string;
  priority: TicketPriority;
  priorityLabel: TicketPriorityLabel;
  origin: TicketOrigin | null;
  assignee: string | null;
  workItemIds: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  acceptance?: TicketAcceptance[];
  reply?: TicketReply | null;
  rejectCount?: number;
  submitCount?: number;
  submittedAt?: string | null;
  completedAt?: string | null;
  autoAcceptAt?: string | null;
}

/** `GET /api/tickets` payload. */
export interface TicketBoardResponse {
  tickets: TicketListItem[];
  columns: Partial<Record<TicketBoardColumn, number>>;
}

/** The full ticket (a backend Request); only the fields the board reads. */
export interface TicketFull {
  id: string;
  title: string;
  description?: string;
  discussion?: TicketDiscussionEntry[];
  [key: string]: unknown;
}

/** `GET /api/tickets/:tkt` payload. */
export interface TicketDetailResponse {
  ticket: TicketFull;
  board: TicketListItem;
}

/** Filters for the board list. */
export interface TicketListQuery {
  column?: TicketBoardColumn;
  kind?: TicketKind;
  q?: string;
  includeLegacy?: boolean;
}

/** A criterion as sent to `PUT /api/tickets/:id/acceptance`. */
export interface TicketAcceptanceInput {
  text: string;
  check?: TicketAcceptanceCheck;
}

/** Body of `PATCH /api/tickets/:id`. */
export interface TicketPatchInput {
  title?: string;
  priority?: TicketPriority;
  kind?: TicketKind;
  assignee?: string | null;
}

/** Error codes the ticket API returns on refusal. */
export type TicketApiErrorCode = 'not_in_review' | 'already_done' | 'open_work' | 'cancelled' | 'invalid';

/**
 * Error thrown by the tickets service, carrying the HTTP status and the
 * server's refusal code so the UI can show a precise message.
 */
export class TicketApiError extends Error {
  readonly status: number;
  readonly code?: string;

  /**
   * @param message - Server error text (or a fallback)
   * @param status - HTTP status
   * @param code - Refusal code, when the server sent one
   */
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'TicketApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Type guard for {@link TicketApiError}.
 *
 * @param err - Anything thrown
 * @returns True when it is a TicketApiError
 */
export function isTicketApiError(err: unknown): err is TicketApiError {
  return err instanceof TicketApiError;
}
