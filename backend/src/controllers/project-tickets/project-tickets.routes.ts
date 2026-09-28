/**
 * Project Tickets Routes — mounted at `/api/project-tickets` and
 * `/api/project-tickets-migrate` (specs/2026-09-28-project-tickets.md §6).
 *
 * @module controllers/project-tickets/project-tickets.routes
 */

import { Router } from 'express';
import {
  assignProjectTicket,
  claimProjectTicket,
  createProjectTicket,
  getProjectTicket,
  listMyProjectTickets,
  listProjectTickets,
  logProjectTicket,
  migrateProjectTickets,
  transitionProjectTicket,
  updateProjectTicket,
} from './project-tickets.controller.js';

/**
 * Create the project tickets router.
 *
 * Routes:
 * - GET  /                        — tickets of the caller's (or `?session=`) projects
 * - GET  /:project                — list (`?status=&assignee=&label=`)
 * - POST /:project                — create
 * - GET  /:project/:id            — one ticket with its body
 * - POST /:project/:id/update     — fields / sections / status
 * - POST /:project/:id/transition — `{ status, note }`
 * - POST /:project/:id/claim      — the calling agent claims it
 * - POST /:project/:id/assign     — `{ assignee, start? }`
 * - POST /:project/:id/log        — `{ note }`
 *
 * @returns Express router for /api/project-tickets
 */
export function createProjectTicketsRouter(): Router {
  const router = Router();
  router.get('/', listMyProjectTickets);
  router.get('/:project', listProjectTickets);
  router.post('/:project', createProjectTicket);
  router.get('/:project/:id', getProjectTicket);
  router.post('/:project/:id/update', updateProjectTicket);
  router.post('/:project/:id/transition', transitionProjectTicket);
  router.post('/:project/:id/claim', claimProjectTicket);
  router.post('/:project/:id/assign', assignProjectTicket);
  router.post('/:project/:id/log', logProjectTicket);
  return router;
}

/**
 * Router for the v1 migration, deliberately outside the `/project-tickets/`
 * prefix so the relay allowlist entry for that prefix does not cover it.
 *
 * - POST /:project — `{ apply?, milestones? }`
 *
 * @returns Express router for /api/project-tickets-migrate
 */
export function createProjectTicketsMigrationRouter(): Router {
  const router = Router();
  router.post('/:project', migrateProjectTickets);
  return router;
}
