/**
 * Tickets Controller — HTTP handlers for the ticket loop (specs/ticket-loop.md §5)
 *
 * Endpoints:
 * - GET  /api/tickets?column=&q=&kind=&includeLegacy=  — board-shaped list
 * - GET  /api/tickets/:tkt                             — one ticket by `TKT-123`, `123` or id
 * - POST /api/tickets/:id/dismiss                      — the "不用记" action
 *
 * @module controllers/tickets/tickets.controller
 */

import type { Request as ExpressRequest, Response } from 'express';
import {
  getTicketIntakeService,
  type TicketIntakeService,
} from '../../services/v3/ticket-intake.service.js';
import { isTicketBoardColumn, isTicketKind } from '../../types/v2/ticket.types.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';

/**
 * The wired intake service, or a 503 when boot has not wired it.
 *
 * @param res - Response to write the 503 to
 * @returns The service, or null after responding
 */
function serviceOr503(res: Response): TicketIntakeService | null {
  const svc = getTicketIntakeService();
  if (!svc) {
    res.status(503).json({ success: false, error: 'Ticket service is not ready' });
    return null;
  }
  return svc;
}

/**
 * First value of a query parameter as a string.
 *
 * @param value - Raw query value
 * @returns The string, or undefined
 */
function queryString(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * GET /api/tickets — board-shaped list.
 *
 * Query: `column` (idea|todo|in_progress|blocked|to_review|done|cancelled),
 * `kind` (issue|feature|idea), `q` (search), `includeLegacy` (`true` also
 * lists Requests from before the ticket loop). Cancelled tickets are left out
 * unless `column=cancelled`.
 *
 * @param req - Express request
 * @param res - `{ success, data: { tickets, columns }, count }`
 */
export async function listTickets(req: ExpressRequest, res: Response): Promise<void> {
  const svc = serviceOr503(res);
  if (!svc) return;
  try {
    const column = queryString(req.query.column);
    const kind = queryString(req.query.kind);
    if (column && !isTicketBoardColumn(column)) {
      res.status(400).json({ success: false, error: `Unknown column: ${column}` });
      return;
    }
    if (kind && !isTicketKind(kind)) {
      res.status(400).json({ success: false, error: `Unknown kind: ${kind}` });
      return;
    }
    const data = await svc.list({
      ...(column && isTicketBoardColumn(column) ? { column } : {}),
      ...(kind && isTicketKind(kind) ? { kind } : {}),
      ...(queryString(req.query.q) ? { q: queryString(req.query.q) } : {}),
      includeLegacy: queryString(req.query.includeLegacy) === 'true',
    });
    res.json({ success: true, data, count: data.tickets.length });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * GET /api/tickets/:tkt — one ticket (full Request plus its board row).
 *
 * @param req - Express request with `tkt` param (`TKT-123`, `123` or id)
 * @param res - `{ success, data: { ticket, board } }` or 404
 */
export async function getTicket(req: ExpressRequest, res: Response): Promise<void> {
  const svc = serviceOr503(res);
  if (!svc) return;
  try {
    const ticket = await svc.resolve(req.params.tkt ?? '');
    if (!ticket) {
      res.status(404).json({ success: false, error: `Ticket not found: ${req.params.tkt}` });
      return;
    }
    res.json({ success: true, data: { ticket, board: await svc.toListItem(ticket) } });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * POST /api/tickets/:id/dismiss — "不用记".
 *
 * The owner's action only: a call carrying `X-Agent-Session` is refused, so
 * an agent cannot quietly drop work it was given. Idempotent.
 *
 * @param req - Express request with `id` param (`TKT-123`, `123` or id)
 * @param res - `{ success, data: ticket, alreadyDismissed }`, 404, 403 or 409
 */
export async function dismissTicket(req: ExpressRequest, res: Response): Promise<void> {
  if (readAgentSessionHeader(req)) {
    res.status(403).json({ success: false, error: 'Only the owner can dismiss a ticket' });
    return;
  }
  const svc = serviceOr503(res);
  if (!svc) return;
  try {
    const result = await svc.dismiss(req.params.id ?? '');
    if (result.ok) {
      res.json({ success: true, data: result.ticket, alreadyDismissed: result.alreadyDismissed });
      return;
    }
    if (result.reason === 'not_found') {
      res.status(404).json({ success: false, error: `Ticket not found: ${req.params.id}` });
      return;
    }
    res.status(409).json({
      success: false,
      error: result.reason === 'already_done' ? 'Ticket is already done' : 'Ticket cannot be cancelled from its current status',
      code: result.reason,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}
