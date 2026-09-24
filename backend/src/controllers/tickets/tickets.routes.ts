/**
 * Tickets Routes — mounted at `/api/tickets` (specs/ticket-loop.md §5).
 *
 * @module controllers/tickets/tickets.routes
 */

import { Router } from 'express';
import { listTickets, getTicket, dismissTicket } from './tickets.controller.js';

/**
 * Create the tickets router.
 *
 * Routes:
 * - GET  /             — board-shaped list
 * - GET  /:tkt         — one ticket
 * - POST /:id/dismiss  — "不用记"
 *
 * @returns Express router for /api/tickets
 */
export function createTicketsRouter(): Router {
  const router = Router();
  router.get('/', listTickets);
  router.get('/:tkt', getTicket);
  router.post('/:id/dismiss', dismissTicket);
  return router;
}
