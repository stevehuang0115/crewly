/**
 * Project tickets API client (`/api/project-tickets`,
 * specs/2026-09-28-project-tickets.md §6).
 *
 * Uses `fetch` (the API-token guard installed in `main.tsx` adds the token
 * header to same-origin calls). Calls from the dashboard carry no agent
 * session, so the backend treats them as the owner. Every call unwraps
 * `{ success, data }` and throws a {@link ProjectTicketApiError}.
 *
 * @module services/project-tickets.service
 */

import { PROJECT_TICKETS_API_BASE } from '../constants/project-tickets.constants';
import {
  ProjectTicketApiError,
  type CreateProjectTicketInput,
  type ProjectTicket,
  type ProjectTicketListResponse,
  type ProjectTicketStatus,
  type UpdateProjectTicketInput,
} from '../types/project-ticket.types';

interface Envelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
}

/**
 * Run a request and unwrap the envelope.
 *
 * @param url - URL
 * @param init - fetch options
 * @returns `data`
 * @throws ProjectTicketApiError on a non-2xx status or `success: false`
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let body: Envelope<T> = {};
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    body = {};
  }
  if (!res.ok || body.success === false) throw new ProjectTicketApiError(body.error || `HTTP ${res.status}`, res.status);
  return body.data as T;
}

/**
 * POST a JSON body.
 *
 * @param body - Body
 * @returns fetch options
 */
function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * URL under a project (and optionally a ticket).
 *
 * @param project - Project id
 * @param ticketId - Ticket id
 * @param suffix - Path after the ticket
 * @returns URL
 */
function url(project: string, ticketId?: string, suffix = ''): string {
  const base = `${PROJECT_TICKETS_API_BASE}/${encodeURIComponent(project)}`;
  return ticketId ? `${base}/${encodeURIComponent(ticketId)}${suffix}` : base;
}

/**
 * List a project's tickets.
 *
 * @param project - Project id
 * @returns Tickets and invalid files
 */
export async function listProjectTickets(project: string): Promise<ProjectTicketListResponse> {
  const data = await request<ProjectTicketListResponse>(url(project));
  return { project: data.project, tickets: data.tickets ?? [], invalid: data.invalid ?? [] };
}

/** One project's tickets in the all-projects listing. */
export interface ProjectTicketGroup {
  project: { id: string; name: string; path: string };
  tickets: ProjectTicket[];
}

/**
 * List every project's tickets (`GET /api/project-tickets` without an agent
 * session), for the Tickets board.
 *
 * @returns One group per project
 */
export async function listAllProjectTickets(): Promise<ProjectTicketGroup[]> {
  const data = await request<ProjectTicketGroup[]>(PROJECT_TICKETS_API_BASE);
  return Array.isArray(data) ? data.map((g) => ({ project: g.project, tickets: g.tickets ?? [] })) : [];
}

/**
 * Read one ticket (with its body).
 *
 * @param project - Project id
 * @param id - Ticket id
 * @returns The ticket
 */
export function getProjectTicket(project: string, id: string): Promise<ProjectTicket> {
  return request<ProjectTicket>(url(project, id));
}

/**
 * Create a ticket.
 *
 * @param project - Project id
 * @param input - Content
 * @returns The new ticket
 * @throws ProjectTicketApiError (400) without calling the server when the title is blank
 */
export function createProjectTicket(project: string, input: CreateProjectTicketInput): Promise<ProjectTicket> {
  if (!input.title.trim()) return Promise.reject(new ProjectTicketApiError('A title is required', 400));
  return request<ProjectTicket>(url(project), post(input));
}

/**
 * Change fields / sections (and optionally the status).
 *
 * @param project - Project id
 * @param id - Ticket id
 * @param input - Changes
 * @returns The updated ticket
 */
export function updateProjectTicket(project: string, id: string, input: UpdateProjectTicketInput): Promise<ProjectTicket> {
  return request<ProjectTicket>(url(project, id, '/update'), post(input));
}

/**
 * Move a ticket to another status.
 *
 * @param project - Project id
 * @param id - Ticket id
 * @param status - New status
 * @param note - Optional reason
 * @returns The updated ticket
 */
export function transitionProjectTicket(project: string, id: string, status: ProjectTicketStatus, note?: string): Promise<ProjectTicket> {
  return request<ProjectTicket>(url(project, id, '/transition'), post(note ? { status, note } : { status }));
}

/**
 * Assign a ticket; an agent assignee starts work right away.
 *
 * @param project - Project id
 * @param id - Ticket id
 * @param assignee - Agent session or a person's name
 * @returns The ticket (and the WorkItem when work started)
 */
export function assignProjectTicket(project: string, id: string, assignee: string): Promise<{ ticket: ProjectTicket; workItem?: { id: string } }> {
  return request(url(project, id, '/assign'), post({ assignee }));
}
