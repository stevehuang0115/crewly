/**
 * Spend + per-agent daily spend caps (Settings → System → Spend).
 *
 * - `GET  /api/system/spend?days=7` — spend per agent / runtime / local day,
 *   the caps in force today and the suggested default cap
 * - `GET  /api/system/spend/caps` — the owner's caps
 * - `PUT  /api/system/spend/caps` — change caps (owner only)
 *   `{ defaultAgentCapUsd?: number|null, totalCapUsd?: number|null, agents?: { "<session>": number|null|"default" } }`
 * - `POST /api/system/spend/raise` — lift a cap for today (owner only)
 *   `{ session: "<session>" | "*", capUsd: number }`
 *
 * Owner only: a request from an agent session gets 403 — an agent never
 * raises its own budget.
 *
 * specs/2026-10-02-spend-cap.md
 *
 * @module controllers/system/spend.controller
 */

import type { Request, Response, Router } from 'express';
import { ensureOwnerCaller } from './system-control.controller.js';
import { getSpendCapService, SpendCapError, type SpendCapService } from '../../services/spend/spend-cap.service.js';
import { SPEND_CAP_CONSTANTS } from '../../constants.js';

/** Dependencies (tests inject fakes). */
export interface SpendControllerDeps {
  spend: () => Pick<SpendCapService, 'view' | 'getConfig' | 'setCaps' | 'raiseToday'> | null;
}

const NOT_READY = 'Spend tracking is not ready yet — Crewly is still starting.';

/**
 * Send an error.
 *
 * @param res - Response
 * @param err - Error
 */
function fail(res: Response, err: unknown): void {
  const status = err instanceof SpendCapError ? err.status : 500;
  res.status(status).json({ success: false, error: err instanceof Error ? err.message : String(err) });
}

/**
 * Register the routes.
 *
 * @param router - The /api router
 * @param deps - Dependencies (default: the backend's)
 */
export function registerSpendRoutes(router: Router, deps: SpendControllerDeps = { spend: getSpendCapService }): void {
  router.get('/system/spend', async (req: Request, res: Response) => {
    const spend = deps.spend();
    if (!spend) {
      res.status(503).json({ success: false, error: NOT_READY });
      return;
    }
    const raw = Number(req.query.days ?? SPEND_CAP_CONSTANTS.DEFAULT_DAYS);
    const days = Number.isFinite(raw) ? raw : SPEND_CAP_CONSTANTS.DEFAULT_DAYS;
    try {
      res.json({ success: true, data: await spend.view(days) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/system/spend/caps', (_req: Request, res: Response) => {
    const spend = deps.spend();
    if (!spend) {
      res.status(503).json({ success: false, error: NOT_READY });
      return;
    }
    res.json({ success: true, data: spend.getConfig() });
  });

  router.put('/system/spend/caps', async (req: Request, res: Response) => {
    if (!ensureOwnerCaller(req, res, 'spend cap change')) return;
    const spend = deps.spend();
    if (!spend) {
      res.status(503).json({ success: false, error: NOT_READY });
      return;
    }
    try {
      res.json({ success: true, data: await spend.setCaps(req.body ?? {}) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/system/spend/raise', async (req: Request, res: Response) => {
    if (!ensureOwnerCaller(req, res, 'spend cap raise')) return;
    const spend = deps.spend();
    if (!spend) {
      res.status(503).json({ success: false, error: NOT_READY });
      return;
    }
    const session = typeof req.body?.session === 'string' ? req.body.session.trim() : '';
    if (!session) {
      res.status(400).json({ success: false, error: 'session is required (an agent session, or "*" for the daily total cap)' });
      return;
    }
    try {
      const capUsd = await spend.raiseToday(session, req.body?.capUsd);
      res.json({ success: true, data: { session, capUsd } });
    } catch (err) {
      fail(res, err);
    }
  });
}
