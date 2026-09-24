/**
 * Tickets Controller — HTTP handlers for the ticket loop (specs/ticket-loop.md §5)
 *
 * Endpoints:
 * - GET  /api/tickets?column=&q=&kind=&includeLegacy=  — board-shaped list
 * - GET  /api/tickets/:tkt                             — one ticket by `TKT-123`, `123` or id
 * - POST /api/tickets/:id/dismiss                      — the "不用记" action
 * - POST /api/tickets/:id/verify                       — 验过了 (Phase 2)
 * - POST /api/tickets/:id/reject     { reason }        — 打回 (Phase 2)
 * - PUT  /api/tickets/:id/acceptance { items }         — replace acceptance list (Phase 2)
 * - POST /api/tickets/:id/self-check { index, result, evidence } — agent self-check (Phase 2)
 * - PATCH /api/tickets/:id           { title, priority, kind, assignee } — board edits (Phase 2)
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
import {
  getTicketReviewService,
  type ReviewActionResult,
  type TicketReviewService,
  type TicketPatch,
} from '../../services/v3/ticket-review.service.js';
import type { TicketAcceptanceCheck } from '../../types/v2/ticket.types.js';

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

// ---------------------------------------------------------------------------
// Phase 2 — review
// ---------------------------------------------------------------------------

/** HTTP status for each refusal. */
const REVIEW_REFUSAL_STATUS: Record<Exclude<ReviewActionResult, { ok: true }>['reason'], number> = {
  not_found: 404,
  invalid: 400,
  not_in_review: 409,
  already_done: 409,
  cancelled: 409,
  open_work: 409,
};

/** Human text for each refusal. */
const REVIEW_REFUSAL_TEXT: Record<Exclude<ReviewActionResult, { ok: true }>['reason'], string> = {
  not_found: 'Ticket not found',
  invalid: 'Invalid input',
  not_in_review: 'Ticket is not waiting for review',
  already_done: 'Ticket is already done',
  cancelled: 'Ticket was cancelled',
  open_work: 'Ticket still has open work items',
};

/**
 * The wired review service, or a 503.
 *
 * @param res - Response to write the 503 to
 * @returns The service, or null after responding
 */
function reviewOr503(res: Response): TicketReviewService | null {
  const svc = getTicketReviewService();
  if (!svc) {
    res.status(503).json({ success: false, error: 'Ticket review is not ready' });
    return null;
  }
  return svc;
}

/**
 * Refuse a call made by an agent (owner-only actions).
 *
 * @param req - Express request
 * @param res - Response
 * @param what - What is owner-only (for the message)
 * @returns True when refused
 */
function refuseAgent(req: ExpressRequest, res: Response, what: string): boolean {
  if (!readAgentSessionHeader(req)) return false;
  res.status(403).json({ success: false, error: `Only the owner can ${what}` });
  return true;
}

/**
 * Write a review action's result.
 *
 * @param res - Response
 * @param result - The result
 */
function sendReviewResult(res: Response, result: ReviewActionResult): void {
  if (result.ok) {
    res.json({ success: true, data: result.ticket });
    return;
  }
  res.status(REVIEW_REFUSAL_STATUS[result.reason]).json({
    success: false,
    error: REVIEW_REFUSAL_TEXT[result.reason],
    code: result.reason,
  });
}

/**
 * Run a review handler with the shared 503 / 500 handling.
 *
 * @param res - Response
 * @param fn - The action
 */
async function runReview(res: Response, fn: (svc: TicketReviewService) => Promise<ReviewActionResult>): Promise<void> {
  const svc = reviewOr503(res);
  if (!svc) return;
  try {
    sendReviewResult(res, await fn(svc));
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * POST /api/tickets/:id/verify — 验过了. Owner only.
 *
 * @param req - Express request with `id` param
 * @param res - `{ success, data: ticket }`, 403, 404 or 409
 */
export async function verifyTicket(req: ExpressRequest, res: Response): Promise<void> {
  if (refuseAgent(req, res, 'accept a ticket')) return;
  await runReview(res, (svc) => svc.verify(req.params.id ?? ''));
}

/**
 * POST /api/tickets/:id/reject — 打回 with a required reason. Owner only.
 * The reason becomes an acceptance criterion and a rework WorkItem is queued.
 *
 * @param req - Express request with `id` param and body `{ reason }`
 * @param res - `{ success, data: ticket }`, 400, 403, 404 or 409
 */
export async function rejectTicket(req: ExpressRequest, res: Response): Promise<void> {
  if (refuseAgent(req, res, 'send a ticket back')) return;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) {
    res.status(400).json({ success: false, error: 'A reason is required', code: 'invalid' });
    return;
  }
  await runReview(res, (svc) => svc.reject(req.params.id ?? '', reason, 'board'));
}

/**
 * PUT /api/tickets/:id/acceptance — replace the live acceptance list. Owner only.
 *
 * @param req - Express request with body `{ items: [{ text, check? }] }`
 * @param res - `{ success, data: ticket }`, 400, 403 or 404
 */
export async function setTicketAcceptance(req: ExpressRequest, res: Response): Promise<void> {
  if (refuseAgent(req, res, 'edit acceptance criteria')) return;
  const raw: unknown = req.body?.items;
  if (!Array.isArray(raw)) {
    res.status(400).json({ success: false, error: '`items` must be an array', code: 'invalid' });
    return;
  }
  const items: Array<{ text: string; check?: TicketAcceptanceCheck }> = [];
  for (const entry of raw as unknown[]) {
    const text = typeof entry === 'string' ? entry : (entry as { text?: unknown })?.text;
    const check = typeof entry === 'object' && entry ? (entry as { check?: unknown }).check : undefined;
    if (typeof text !== 'string') {
      res.status(400).json({ success: false, error: 'Each item needs a `text`', code: 'invalid' });
      return;
    }
    items.push({ text, ...(check === 'auto' || check === 'judgment' ? { check } : {}) });
  }
  await runReview(res, (svc) => svc.setAcceptance(req.params.id ?? '', items));
}

/**
 * POST /api/tickets/:id/self-check — an agent records its check of one
 * criterion. Agents may call this.
 *
 * @param req - Express request with body `{ index, result: 'pass'|'fail', evidence? }`
 * @param res - `{ success, data: ticket }`, 400 or 404
 */
export async function selfCheckTicket(req: ExpressRequest, res: Response): Promise<void> {
  const index = Number(req.body?.index);
  const result = req.body?.result;
  const evidence = typeof req.body?.evidence === 'string' ? req.body.evidence : undefined;
  if (!Number.isInteger(index) || index < 0 || (result !== 'pass' && result !== 'fail')) {
    res.status(400).json({ success: false, error: '`index` (>= 0) and `result` (pass|fail) are required', code: 'invalid' });
    return;
  }
  await runReview(res, (svc) => svc.selfCheck(req.params.id ?? '', index, result, evidence));
}

/**
 * PATCH /api/tickets/:id — board edits (title, priority, kind, assignee). Owner only.
 *
 * @param req - Express request with a partial body
 * @param res - `{ success, data: ticket }`, 400, 403 or 404
 */
export async function patchTicket(req: ExpressRequest, res: Response): Promise<void> {
  if (refuseAgent(req, res, 'edit a ticket')) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: TicketPatch = {};
  if (typeof body.title === 'string') patch.title = body.title;
  if (typeof body.priority === 'string') patch.priority = body.priority as TicketPatch['priority'];
  if (typeof body.kind === 'string') patch.kind = body.kind as TicketPatch['kind'];
  if (typeof body.assignee === 'string' || body.assignee === null) patch.assignee = body.assignee as string | null;
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ success: false, error: 'Nothing to change', code: 'invalid' });
    return;
  }
  await runReview(res, (svc) => svc.patch(req.params.id ?? '', patch));
}
