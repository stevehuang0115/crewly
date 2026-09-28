/**
 * Project tickets board constants (specs/2026-09-28-project-tickets.md).
 *
 * Mirrors `PROJECT_TICKET_CONSTANTS` in `config/constants.ts` (the frontend
 * bundle does not import the shared config) plus the board's labels.
 *
 * @module constants/project-tickets.constants
 */

import type { ProjectTicketPriority, ProjectTicketStatus } from '../types/project-ticket.types';

/** Base path of the project tickets API. */
export const PROJECT_TICKETS_API_BASE = '/api/project-tickets';

/** Board columns in display order. */
export const PROJECT_TICKET_STATUS_ORDER: readonly ProjectTicketStatus[] = [
  'backlog',
  'ready',
  'in_progress',
  'review',
  'done',
  'cancelled',
];

/** Column titles. */
export const PROJECT_TICKET_STATUS_LABELS: Readonly<Record<ProjectTicketStatus, string>> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  review: 'Owner review',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** Allowed status moves (same table as the backend state machine). */
export const PROJECT_TICKET_TRANSITIONS: Readonly<Record<ProjectTicketStatus, readonly ProjectTicketStatus[]>> = {
  backlog: ['ready', 'cancelled'],
  ready: ['backlog', 'cancelled'],
  in_progress: ['ready', 'backlog', 'review', 'done', 'cancelled'],
  review: ['done', 'ready', 'cancelled'],
  done: ['ready'],
  cancelled: ['backlog'],
};

/** Priorities, highest first. */
export const PROJECT_TICKET_PRIORITIES: readonly ProjectTicketPriority[] = ['P0', 'P1', 'P2', 'P3'];

/** Priority of a new ticket. */
export const DEFAULT_PROJECT_TICKET_PRIORITY: ProjectTicketPriority = 'P2';

/** Badge classes per priority. */
export const PROJECT_TICKET_PRIORITY_CLASSES: Readonly<Record<ProjectTicketPriority, string>> = {
  P0: 'bg-red-500/20 text-red-400',
  P1: 'bg-orange-500/20 text-orange-400',
  P2: 'bg-yellow-500/20 text-yellow-400',
  P3: 'bg-green-500/20 text-green-400',
};

/** How often the board refreshes itself so agent claims and file edits show up (ms). */
export const PROJECT_TICKETS_POLL_INTERVAL_MS = 15_000;

/** Cards shown per column before "Show more". */
export const PROJECT_TICKETS_PAGE_SIZE = 30;
