/**
 * Project Tickets Routes — mounted at `/api/project-tickets` and
 * `/api/project-tickets-migrate` (specs/2026-09-28-project-tickets.md §6).
 *
 * @module controllers/project-tickets/project-tickets.routes
 */

import { Router } from 'express';
import {
  askOwnerProjectTicket,
  assignProjectTicket,
  claimProjectTicket,
  createProjectTicket,
  getProjectTicket,
  getTicketAutopilot,
  getTicketAutopilotRuns,
  getTicketAutopilotStats,
  linkProjectTicket,
  listMyProjectTickets,
  listProjectTickets,
  logProjectTicket,
  migrateProjectTickets,
  setTicketAutopilot,
  submitTicketAutopilotRetro,
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
 * - POST /:project/:id/link       — `{ workItemId }` (link work already in flight)
 * - POST /:project/:id/ask-owner  — `{ question }` / `{ clear: true }` (needs-owner mark)
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
  router.post('/:project/:id/link', linkProjectTicket);
  router.post('/:project/:id/ask-owner', askOwnerProjectTicket);
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

/**
 * Router for the ticket autopilot switch (specs/2026-09-30-ticket-autopilot.md),
 * outside the `/project-tickets/` prefix: it is an owner / orchestrator
 * setting, and project settings are not writable over the mobile relay.
 *
 * - GET  /:project — settings + status
 * - POST /:project — `{ enabled?, driver?, dailyBudgetTokens?, maxInFlightPerMember?, retro?, replansPerDay? }`
 * - GET  /:project/stats?days=&label= — autopilot stats; GET /:project/runs — run + ticket traces per day
 * - POST /:project/retro — the driver's daily retro (specs/2026-10-03-autopilot-experiments.md)
 *
 * @returns Express router for /api/project-ticket-autopilot
 */
export function createTicketAutopilotRouter(): Router {
  const router = Router();
  router.get('/:project', getTicketAutopilot);
  router.post('/:project', setTicketAutopilot);
  // specs/2026-10-03-autopilot-experiments.md: stats, runs, daily retro
  router.get('/:project/stats', getTicketAutopilotStats);
  router.get('/:project/runs', getTicketAutopilotRuns);
  router.post('/:project/retro', submitTicketAutopilotRetro);
  return router;
}
