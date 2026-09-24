/**
 * Pure helpers for the ticket board.
 *
 * @module utils/ticket.utils
 */

import {
  MS_PER_DAY,
  TICKET_BOARD_COLUMN_ORDER,
  TICKET_ERROR_TEXT,
  TICKET_ORIGIN_CHANNEL_LABEL,
  TICKET_TEXT,
} from '../constants/tickets.constants';
import {
  isTicketApiError,
  type TicketAcceptance,
  type TicketAcceptanceInput,
  type TicketBoardColumn,
  type TicketListItem,
  type TicketOrigin,
} from '../types/ticket.types';

/**
 * Group board rows by column, keeping server order within a column.
 *
 * @param tickets - Board rows
 * @returns One (possibly empty) array per visible column
 */
export function groupTicketsByColumn(tickets: TicketListItem[]): Record<TicketBoardColumn, TicketListItem[]> {
  const groups = {} as Record<TicketBoardColumn, TicketListItem[]>;
  for (const col of TICKET_BOARD_COLUMN_ORDER) groups[col] = [];
  groups.cancelled = [];
  for (const t of tickets) {
    (groups[t.column] ?? (groups[t.column] = [])).push(t);
  }
  return groups;
}

/**
 * Whole days until a ticket auto-accepts (rounded up).
 *
 * @param autoAcceptAt - ISO time, or null
 * @param now - Current time in ms (injectable for tests)
 * @returns Days left (0 when due or past), or null when there is no deadline
 */
export function daysUntilAutoAccept(autoAcceptAt: string | null | undefined, now: number = Date.now()): number | null {
  if (!autoAcceptAt) return null;
  const at = Date.parse(autoAcceptAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / MS_PER_DAY));
}

/**
 * The "N天后自动验收" label.
 *
 * @param autoAcceptAt - ISO time, or null
 * @param now - Current time in ms
 * @returns Label, or null when there is no deadline
 *
 * @example
 * autoAcceptLabel('2026-09-27T00:00:00Z', Date.parse('2026-09-24T00:00:00Z')) // '3天后自动验收'
 */
export function autoAcceptLabel(autoAcceptAt: string | null | undefined, now: number = Date.now()): string | null {
  const days = daysUntilAutoAccept(autoAcceptAt, now);
  if (days === null) return null;
  return days <= 0 ? TICKET_TEXT.AUTO_ACCEPT_SOON : `${days}${TICKET_TEXT.AUTO_ACCEPT_IN_DAYS}`;
}

/**
 * Describe where a ticket came from.
 *
 * @param origin - Ticket origin, or null
 * @returns e.g. `Slack 私信 · Steve`, or null
 */
export function formatOrigin(origin: TicketOrigin | null | undefined): string | null {
  if (!origin) return null;
  const channel = TICKET_ORIGIN_CHANNEL_LABEL[origin.channel] ?? origin.channel;
  const who = origin.authorName || origin.author;
  return who ? `${channel} · ${who}` : channel;
}

/**
 * Format an ISO time for display in the user's locale.
 *
 * @param iso - ISO time
 * @returns Localised date-time, or the input when it does not parse
 */
export function formatTicketTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
}

/**
 * Map the live acceptance list to the `PUT /acceptance` body shape.
 *
 * @param acceptance - Live criteria
 * @returns `{ text, check }` items
 */
export function toAcceptanceInputs(acceptance: TicketAcceptance[] | undefined): TicketAcceptanceInput[] {
  return (acceptance ?? []).map((a) => ({ text: a.text, ...(a.check ? { check: a.check } : {}) }));
}

/**
 * Turn anything thrown by the tickets service into a message for the user.
 *
 * @param err - Thrown value
 * @returns Chinese text for known refusal codes, else the server's message
 */
export function ticketErrorMessage(err: unknown): string {
  if (isTicketApiError(err) && err.code && TICKET_ERROR_TEXT[err.code]) {
    return TICKET_ERROR_TEXT[err.code];
  }
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
