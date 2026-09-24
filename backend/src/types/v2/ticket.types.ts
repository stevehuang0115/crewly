/**
 * Ticket type definitions (specs/ticket-loop.md).
 *
 * A ticket IS a {@link Request} with a few extra fields — no new store. This
 * module holds those fields' types plus the pure helpers every surface needs:
 * number formatting / parsing, the delivered-message marker, priority labels
 * and the derived board column.
 *
 * @module types/v2/ticket.types
 */

import { TICKET_CONSTANTS } from '../../constants.js';
import type { Request } from './request.types.js';

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

/** What kind of ask a ticket is. */
export type TicketKind = 'issue' | 'feature' | 'idea';

/** All valid {@link TicketKind} values. */
export const TICKET_KINDS: readonly TicketKind[] = ['issue', 'feature', 'idea'] as const;

/** Where a ticket was said. */
export type TicketOriginChannel =
  | 'slack-channel'
  | 'slack-dm'
  | 'chat'
  | 'portal'
  | 'mobile'
  | 'bug-button'
  | 'agent'
  | 'cron'
  | 'mission'
  | 'legacy';

/** Where it was said and by whom; replies go back to `threadRef`. */
export interface TicketOrigin {
  channel: TicketOriginChannel;
  /** Unique id of the message that opened the ticket (also its sourceConversationItemId) */
  ref: string;
  /** Conversation thread the ticket lives in — follow-ups there append to it */
  threadRef?: string;
  /** Who said it (Slack user id, principal id, …) */
  author: string;
  authorName?: string;
}

/**
 * Where an acceptance criterion came from. Criteria grow from real review
 * (#763): a 打回 reason becomes a criterion, so the next attempt is judged
 * against what the owner actually objected to.
 */
export type TicketAcceptanceSource = 'owner' | 'decompose' | 'reject' | 'agent';

/**
 * How a criterion is checked (#763): `auto` = something a build, test or
 * scan can show; `judgment` = needs a person (tone, fit, "is this what I
 * meant"). A ticket's self-check can only speak for the `auto` ones.
 */
export type TicketAcceptanceCheck = 'auto' | 'judgment';

/** One acceptance criterion. */
export interface TicketAcceptance {
  text: string;
  selfCheck?: 'pass' | 'fail';
  evidence?: string;
  /** Who added it (absent on Phase 1 data = owner) */
  source?: TicketAcceptanceSource;
  /** How it is checked (absent = judgment) */
  check?: TicketAcceptanceCheck;
  /** ISO-8601 */
  addedAt?: string;
  /** Set when the owner removed it; kept so the history stays readable */
  removedAt?: string;
}

/** The chat-v2 turn a ticket was opened by — how agent answers are matched to it. */
export interface TicketChatRef {
  /** chat-v2 channel the owner's message was recorded in */
  channelId: string;
  /** The owner's message */
  messageId: string;
  /** Root of the thread it sits in (the message itself when top-level) */
  threadRootId: string;
}

/** The latest agent answer seen in a ticket's thread. */
export interface TicketReply {
  /** ISO-8601 */
  at: string;
  /** Agent session */
  by: string;
  /** chat-v2 message id */
  messageId: string;
  /** Start of the answer (shown on the board as the result) */
  excerpt: string;
}

/**
 * Where the receipt for a ticket was posted, so dismissing can edit it.
 *
 * Never holds a token: a Slack receipt posted by an agent's bot records the
 * agent session, and the token is looked up again when it is edited.
 */
export type TicketReceipt =
  | {
      kind: 'slack';
      slackChannelId: string;
      /** The receipt message's own ts */
      ts: string;
      /** Thread the receipt sits in */
      threadTs?: string;
      /** Agent whose bot posted it; absent = the workspace (master) bot */
      postedAs?: string;
      /** Set when the receipt is a reaction on the owner's message (`ts` = that message) */
      reaction?: string;
    }
  | {
      kind: 'chat-v2';
      chatChannelId: string;
      /** The receipt row's message id */
      messageId: string;
    };

/** A follow-up that was appended to a ticket instead of opening a new one. */
export interface TicketDiscussionEntry {
  /** ISO-8601 */
  at: string;
  author: string;
  text: string;
  /** Message ref of the follow-up */
  ref: string;
}

/** Board columns (derived, never stored). */
export type TicketBoardColumn = 'idea' | 'todo' | 'in_progress' | 'blocked' | 'to_review' | 'done' | 'cancelled';

/** All board columns in display order. */
export const TICKET_BOARD_COLUMNS: readonly TicketBoardColumn[] = [
  'idea',
  'todo',
  'in_progress',
  'blocked',
  'to_review',
  'done',
  'cancelled',
] as const;

/** Display priority. */
export type TicketPriorityLabel = 'P0' | 'P1' | 'P2' | 'P3';

// ---------------------------------------------------------------------------
// Ticket number helpers
// ---------------------------------------------------------------------------

/** `TKT-12`, `tkt 12`, `TKT-012` → 12. */
const TICKET_NUMBER_REF = /^\s*tkt[-\s_]?(\d+)\s*$/i;

/** Bare digits → ticket number. */
const BARE_NUMBER_REF = /^\s*(\d+)\s*$/;

/**
 * Render a ticket number for display.
 *
 * @param n - Ticket number
 * @returns `TKT-` + the number zero-padded to three digits
 *
 * @example
 * formatTicketNumber(7)    // 'TKT-007'
 * formatTicketNumber(1234) // 'TKT-1234'
 */
export function formatTicketNumber(n: number): string {
  return `${TICKET_CONSTANTS.NUMBER_PREFIX}${String(Math.max(0, Math.floor(n))).padStart(TICKET_CONSTANTS.NUMBER_PAD, '0')}`;
}

/**
 * Parse a ticket reference into a number, when it is one.
 *
 * @param ref - `TKT-123`, `tkt-123` or `123`
 * @returns The number, or null when `ref` is not a number-style reference
 */
export function parseTicketNumber(ref: string): number | null {
  const m = TICKET_NUMBER_REF.exec(ref) ?? BARE_NUMBER_REF.exec(ref);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Whether a string is a `TKT-123` style reference (not a bare number).
 *
 * @param ref - Candidate reference
 * @returns True for `TKT-…` references
 */
export function isTicketNumberRef(ref: string): boolean {
  return TICKET_NUMBER_REF.test(ref);
}

// ---------------------------------------------------------------------------
// Delivered-message marker
// ---------------------------------------------------------------------------

/** `[TICKET:TKT-123 <uuid>]` */
const TICKET_MARKER = /\[TICKET:(TKT-\d+) ([A-Za-z0-9-]+)\]/g;

/** A ticket referenced by a delivered message. */
export interface TicketMarkerRef {
  /** `TKT-123` */
  tkt: string;
  /** Request id */
  id: string;
}

/**
 * Build the marker added to a message delivered to an agent, so the agent
 * (and `addToPool`) know which ticket the message belongs to.
 *
 * @param ticket - The ticket (needs id + ticketNumber)
 * @returns `[TICKET:TKT-123 <id>]`, or '' when the ticket has no number
 */
export function formatTicketMarker(ticket: Pick<Request, 'id' | 'ticketNumber'>): string {
  if (typeof ticket.ticketNumber !== 'number') return '';
  return `[TICKET:${formatTicketNumber(ticket.ticketNumber)} ${ticket.id}]`;
}

/**
 * Every ticket marker in a delivered text, in order, de-duplicated by id.
 *
 * @param text - Delivered text
 * @returns Referenced tickets
 */
export function parseTicketMarkers(text: string): TicketMarkerRef[] {
  const out: TicketMarkerRef[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TICKET_MARKER)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ tkt: m[1], id: m[2] });
  }
  return out;
}

/**
 * The one ticket a set of delivered texts refers to.
 *
 * Used to link a WorkItem to the ticket of the turn that created it. When the
 * turn holds messages from two different tickets there is no way to tell which
 * one the WorkItem is for, so nothing is linked (the agent can still pass
 * `--request-id`).
 *
 * @param texts - Texts delivered in the current turn
 * @returns The ticket id, or null when none or more than one ticket is referenced
 */
export function uniqueTicketIdFromTexts(texts: readonly string[]): string | null {
  const ids = new Set<string>();
  for (const t of texts) {
    for (const ref of parseTicketMarkers(t)) ids.add(ref.id);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

// ---------------------------------------------------------------------------
// Priority + board
// ---------------------------------------------------------------------------

/**
 * Map the internal priority to the displayed P-label.
 *
 * @param priority - Request priority
 * @returns P0 (urgent) … P3 (low)
 */
export function ticketPriorityLabel(priority: Request['priority']): TicketPriorityLabel {
  switch (priority) {
    case 'urgent':
      return 'P0';
    case 'high':
      return 'P1';
    case 'low':
      return 'P3';
    default:
      return 'P2';
  }
}

/** Minimal WorkItem view needed to derive the board column. */
export interface BoardWorkItemView {
  status: string;
}

/** WorkItem statuses that count as terminal success for "to review". */
const WORK_ITEM_SUCCESS = new Set(['done', 'verified']);

/**
 * Derive the board column of a ticket (never stored).
 *
 * @param request - The ticket
 * @param workItems - Its WorkItems, when known (missing ones are ignored)
 * @returns Board column
 */
export function deriveBoardColumn(
  request: Pick<Request, 'status' | 'kind' | 'requiresConfirmation'>,
  workItems: readonly BoardWorkItemView[] = [],
): TicketBoardColumn {
  if (request.status === 'done') return 'done';
  if (request.status === 'cancelled') return 'cancelled';
  // Work finished and the owner has to look at it — ahead of "blocked", which
  // `waiting_confirmation` otherwise maps to.
  if (
    request.requiresConfirmation &&
    workItems.length > 0 &&
    workItems.every((w) => WORK_ITEM_SUCCESS.has(w.status))
  ) {
    return 'to_review';
  }
  // Answered directly (no WorkItems) and handed to the owner.
  if (request.status === 'waiting_confirmation' && request.requiresConfirmation && workItems.length === 0) {
    return 'to_review';
  }
  switch (request.status) {
    case 'blocked':
    case 'waiting_confirmation':
      return 'blocked';
    case 'running':
      return 'in_progress';
    case 'open':
      return request.kind === 'idea' ? 'idea' : 'todo';
    default:
      return 'todo';
  }
}

/**
 * Whether a ticket waits for the owner before it is done. Tickets from cron
 * and missions close on their own; so does anything filed before Phase 2
 * (`requiresConfirmation` was false then).
 *
 * @param request - The Request
 * @returns True when `done` needs the owner's accept (or the auto-accept)
 */
export function ticketNeedsReview(request: Pick<Request, 'ticketNumber' | 'requiresConfirmation' | 'origin'>): boolean {
  if (typeof request.ticketNumber !== 'number' || !request.requiresConfirmation) return false;
  return !TICKET_CONSTANTS.REVIEW.NO_REVIEW_ORIGINS.includes(request.origin?.channel ?? '');
}

/**
 * Criteria still in force (not removed).
 *
 * @param acceptance - All criteria, removed ones included
 * @returns The live ones, in order
 */
export function activeAcceptance(acceptance: readonly TicketAcceptance[] | undefined): TicketAcceptance[] {
  return (acceptance ?? []).filter((a) => !a.removedAt);
}

/** What an owner message in a 待验收 ticket's thread means. */
export type ReviewReply = { action: 'verify' } | { action: 'reject'; reason: string } | null;

/**
 * Read a 验过了 / 打回 reply.
 *
 * @param text - The owner's message
 * @returns The action, or null for anything else
 */
export function parseReviewReply(text: string): ReviewReply {
  if (TICKET_CONSTANTS.REVIEW.VERIFY_PATTERN.test(text)) return { action: 'verify' };
  const m = TICKET_CONSTANTS.REVIEW.REJECT_PATTERN.exec(text);
  if (m) return { action: 'reject', reason: (m[3] ?? '').trim() || TICKET_CONSTANTS.REVIEW.REJECT_NO_REASON };
  return null;
}

/**
 * Whether a string is a valid board column.
 *
 * @param value - Candidate
 * @returns True when it is a {@link TicketBoardColumn}
 */
export function isTicketBoardColumn(value: string): value is TicketBoardColumn {
  return (TICKET_BOARD_COLUMNS as readonly string[]).includes(value);
}

/**
 * Whether a string is a valid ticket kind.
 *
 * @param value - Candidate
 * @returns True when it is a {@link TicketKind}
 */
export function isTicketKind(value: string): value is TicketKind {
  return (TICKET_KINDS as readonly string[]).includes(value);
}

/**
 * Pick the kind of a new ticket from its text.
 *
 * Default `feature`; a 🐛 makes it an `issue` (the Phase 4 bug button sends
 * one). `idea` is only set explicitly (the Phase 4 `ticket-idea` skill).
 *
 * @param text - Message text
 * @returns The kind
 */
export function inferTicketKind(text: string): TicketKind {
  return text.includes('🐛') ? 'issue' : 'feature';
}
