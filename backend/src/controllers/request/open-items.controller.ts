/**
 * Open items HTTP handlers (specs/2026-10-01-reply-open-items.md).
 *
 * - GET  /api/requests/open-items           — active open items across requests
 * - POST /api/requests/open-items/backfill  — scan the last 7 days; dry-run
 *   unless the body says `{ "apply": true }`
 * - POST /api/requests/:id/open-items/:itemId/skip — the owner skips an open
 *   item (a promise's follow-up is cancelled; a question's card is skipped)
 *
 * @module controllers/request/open-items.controller
 */

import type { Request as ExpressRequest, Response } from 'express';
import { RequestService } from '../../services/v3/request.service.js';
import { TaskPoolService } from '../../services/task-pool/task-pool.service.js';
import { OpenItemsError, OpenItemsService } from '../../services/open-items/open-items.service.js';
import { rejectNonOwner } from '../../middleware/caller-identity.middleware.js';
import { backfillOpenItems, formatBackfillReport } from '../../services/open-items/open-items-backfill.js';
import { ACTIVE_OPEN_ITEM_STATUSES } from '../../types/v2/open-item.types.js';
import { formatTicketNumber } from '../../types/v2/ticket.types.js';

/**
 * Active open items, newest first, with their ticket.
 *
 * @param _req - Express request
 * @param res - Express response
 */
export async function listOpenItems(_req: ExpressRequest, res: Response): Promise<void> {
  try {
    const all = await RequestService.getInstance().listAll();
    const rows = all.flatMap((r) =>
      (r.openItems ?? [])
        .filter((i) => ACTIVE_OPEN_ITEM_STATUSES.has(i.status))
        .map((i) => ({
          ...i,
          requestId: r.id,
          ticket: typeof r.ticketNumber === 'number' ? formatTicketNumber(r.ticketNumber) : undefined,
          requestTitle: r.title,
          requestStatus: r.status,
        })),
    );
    rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    res.json({ success: true, data: rows, count: rows.length });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * Backfill: dry-run by default.
 *
 * @param req - Express request (`{ apply?: boolean }`)
 * @param res - Express response with the report (and its text form)
 */
export async function backfillOpenItemsHandler(req: ExpressRequest, res: Response): Promise<void> {
  try {
    const service = OpenItemsService.getInstance();
    if (!service) {
      res.status(503).json({ success: false, error: 'Open items are not running on this instance' });
      return;
    }
    const apply = (req.body as { apply?: unknown } | undefined)?.apply === true;
    const { getChatV2Service } = await import('../../services/chat-v2/chat-v2.singleton.js');
    const report = await backfillOpenItems(
      {
        service,
        listRequests: () => RequestService.getInstance().listAll(),
        listWorkItems: () => TaskPoolService.getInstance().getAllItems(),
        listThread: async (channelId, rootId) => getChatV2Service().listThreadForBridge(channelId, rootId),
      },
      { apply, caller: String(req.header('x-agent-session') ?? req.ip ?? 'unknown') },
    );
    res.json({ success: true, data: report, text: formatBackfillReport(report) });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * The owner skips an open item. Agents may not (403).
 *
 * @param req - Express request (`:id`, `:itemId`)
 * @param res - Express response with the closed item
 */
export async function skipOpenItemHandler(req: ExpressRequest, res: Response): Promise<void> {
  try {
    if (rejectNonOwner(req, res, { success: false, error: 'Only the owner skips open items.' })) return;
    const service = OpenItemsService.getInstance();
    if (!service) {
      res.status(503).json({ success: false, error: 'Open items are not running on this instance' });
      return;
    }
    const item = await service.skipItem(req.params.id, req.params.itemId);
    res.json({ success: true, data: item });
  } catch (error) {
    const status = error instanceof OpenItemsError ? error.status : 500;
    res.status(status).json({ success: false, error: (error as Error).message });
  }
}
