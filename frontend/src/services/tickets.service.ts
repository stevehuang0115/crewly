/**
 * Tickets API client (`/api/tickets`, specs/ticket-loop.md Phase 2).
 *
 * Uses `fetch` (the API-token guard installed in `main.tsx` adds the token
 * header to same-origin calls). Every call unwraps `{ success, data }` and
 * throws a {@link TicketApiError} carrying the HTTP status and refusal code.
 *
 * @module services/tickets.service
 */

import { TICKETS_API_BASE } from '../constants/tickets.constants';
import {
  TicketApiError,
  type TicketAcceptanceInput,
  type TicketBoardResponse,
  type TicketDetailResponse,
  type TicketListQuery,
  type TicketPatchInput,
} from '../types/ticket.types';

/** Server envelope. */
interface Envelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
  message?: string;
  code?: string;
}

/**
 * Run a request and unwrap the envelope.
 *
 * @param url - Request URL
 * @param init - fetch options
 * @returns The `data` field
 * @throws TicketApiError on a non-2xx status or `success: false`
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let body: Envelope<T> = {};
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    body = {};
  }
  if (!res.ok || body.success === false) {
    throw new TicketApiError(body.error || body.message || `HTTP ${res.status}`, res.status, body.code);
  }
  return body.data as T;
}

/**
 * Build a JSON request init.
 *
 * @param method - HTTP method
 * @param body - JSON body, if any
 * @returns fetch options
 */
function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

/**
 * URL of one ticket's sub-resource.
 *
 * @param id - Ticket id, `TKT-123` or number
 * @param suffix - Path after the id (e.g. `/verify`)
 * @returns The URL
 */
function ticketUrl(id: string, suffix = ''): string {
  return `${TICKETS_API_BASE}/${encodeURIComponent(id)}${suffix}`;
}

/**
 * Build the list query string. Empty values are left out.
 *
 * @param query - Filters
 * @returns `?a=b&…` or an empty string
 */
export function buildTicketListQuery(query: TicketListQuery = {}): string {
  const params = new URLSearchParams();
  if (query.column) params.set('column', query.column);
  if (query.kind) params.set('kind', query.kind);
  const q = query.q?.trim();
  if (q) params.set('q', q);
  if (query.includeLegacy) params.set('includeLegacy', 'true');
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * List tickets for the board.
 *
 * @param query - Filters (`column`, `kind`, `q`, `includeLegacy`)
 * @returns Tickets and per-column counts
 */
export async function fetchTickets(query: TicketListQuery = {}): Promise<TicketBoardResponse> {
  const data = await request<TicketBoardResponse>(`${TICKETS_API_BASE}${buildTicketListQuery(query)}`);
  return { tickets: data?.tickets ?? [], columns: data?.columns ?? {} };
}

/**
 * Read one ticket (full record plus its board row).
 *
 * @param id - Ticket id, `TKT-123` or number
 * @returns The ticket
 */
export function fetchTicket(id: string): Promise<TicketDetailResponse> {
  return request<TicketDetailResponse>(ticketUrl(id));
}

/**
 * 验过了 — accept the ticket.
 *
 * @param id - Ticket id
 * @returns The updated ticket
 */
export function verifyTicket(id: string): Promise<unknown> {
  return request(ticketUrl(id, '/verify'), jsonInit('POST'));
}

/**
 * 打回 — send the ticket back with a reason.
 *
 * @param id - Ticket id
 * @param reason - Why (required, non-blank)
 * @returns The updated ticket
 * @throws TicketApiError (400 `invalid`) without calling the server when the reason is blank
 */
export function rejectTicket(id: string, reason: string): Promise<unknown> {
  const trimmed = reason.trim();
  if (!trimmed) return Promise.reject(new TicketApiError('A reason is required', 400, 'invalid'));
  return request(ticketUrl(id, '/reject'), jsonInit('POST', { reason: trimmed }));
}

/**
 * 不用记 — cancel the ticket.
 *
 * @param id - Ticket id
 * @returns The updated ticket
 */
export function dismissTicket(id: string): Promise<unknown> {
  return request(ticketUrl(id, '/dismiss'), jsonInit('POST'));
}

/**
 * Replace the live acceptance list.
 *
 * @param id - Ticket id
 * @param items - The full new list
 * @returns The updated ticket
 */
export function setTicketAcceptance(id: string, items: TicketAcceptanceInput[]): Promise<unknown> {
  return request(ticketUrl(id, '/acceptance'), jsonInit('PUT', { items }));
}

/**
 * Edit title / priority / kind / assignee.
 *
 * @param id - Ticket id
 * @param patch - Fields to change
 * @returns The updated ticket
 */
export function patchTicket(id: string, patch: TicketPatchInput): Promise<unknown> {
  return request(ticketUrl(id), jsonInit('PATCH', patch));
}
