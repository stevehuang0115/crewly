/**
 * Tickets Routes — mounted at `/api/tickets` (specs/ticket-loop.md §5).
 *
 * @module controllers/tickets/tickets.routes
 */

import { Router } from 'express';
import {
  listTickets,
  getTicket,
  dismissTicket,
  verifyTicket,
  rejectTicket,
  setTicketAcceptance,
  selfCheckTicket,
  patchTicket,
} from './tickets.controller.js';

/**
 * Create the tickets router.
 *
 * Routes:
 * - GET  /             — board-shaped list
 * - GET  /:tkt         — one ticket
 * - POST /:id/dismiss  — "不用记"
 * - POST /:id/verify   — 验过了
 * - POST /:id/reject   — 打回 { reason }
 * - PUT  /:id/acceptance — replace acceptance list
 * - POST /:id/self-check — agent self-check of one criterion
 * - PATCH /:id         — title / priority / kind / assignee
 * - POST /:id/acceptance, POST /:id/update — the same two, for the relay
 *   (portal / phone), which only carries GET and POST
 *
 * @returns Express router for /api/tickets
 */
export function createTicketsRouter(): Router {
  const router = Router();
  router.get('/', listTickets);
  router.get('/:tkt', getTicket);
  router.post('/:id/dismiss', dismissTicket);
  router.post('/:id/verify', verifyTicket);
  router.post('/:id/reject', rejectTicket);
  router.put('/:id/acceptance', setTicketAcceptance);
  router.post('/:id/self-check', selfCheckTicket);
  router.patch('/:id', patchTicket);
  // POST twins: the relay (portal / phone) only carries GET and POST.
  router.post('/:id/acceptance', setTicketAcceptance);
  router.post('/:id/update', patchTicket);
  return router;
}
