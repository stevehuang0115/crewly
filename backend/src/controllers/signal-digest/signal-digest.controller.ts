/**
 * Signal digest API (#987, specs/2026-10-03-signal-digest.md §4).
 *
 * - POST /api/signal-digests                  — propose `{ site, project?, items }` (team lead: X-Agent-Session)
 * - GET  /api/signal-digests?site=            — digests, newest first
 * - GET  /api/signal-digests/history?site=    — the site's blocked keys (Do 90 d, Skip 30 d) and open ones
 * - GET  /api/signal-digests/:id
 * - POST /api/signal-digests/:id/items/:n     — `{ choice: "do" | "skip" }` (owner only: no agent header)
 *
 * @module controllers/signal-digest/signal-digest.controller
 */

import { Router, type Request, type Response } from 'express';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { isSignalChoice } from '../../types/signal-digest.types.js';
import { SignalDigestError } from '../../services/signal-digest/signal-digest-contract.js';
import { SignalDigestService } from '../../services/signal-digest/signal-digest.service.js';

/** Collaborators (tests). */
export interface SignalDigestControllerDeps {
  service: () => SignalDigestService | null;
}

/**
 * Run a handler and map errors to `{ success:false, error }`.
 *
 * @param res - Response
 * @param status - Success status
 * @param body - Handler
 */
async function respond(res: Response, status: number, body: () => Promise<unknown>): Promise<void> {
  try {
    res.status(status).json({ success: true, data: await body() });
  } catch (err) {
    if (err instanceof SignalDigestError) {
      res.status(err.status).json({ success: false, error: err.message });
      return;
    }
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Require a running service.
 *
 * @param deps - Deps
 * @returns Service
 * @throws SignalDigestError(503)
 */
function svc(deps: SignalDigestControllerDeps): SignalDigestService {
  const s = deps.service();
  if (!s) throw new SignalDigestError(503, 'Signal digests are not ready yet — Crewly is still starting');
  return s;
}

/**
 * A required `site` query parameter.
 *
 * @param req - Request
 * @returns Site
 * @throws SignalDigestError(400)
 */
function siteParam(req: Request): string {
  const site = typeof req.query.site === 'string' ? req.query.site.trim() : '';
  if (!site) throw new SignalDigestError(400, 'site is required (?site=visa.careerengine.us)');
  return site;
}

/**
 * The `/api/signal-digests` router.
 *
 * @param deps - Collaborators (default: the running service)
 * @returns Router
 */
export function createSignalDigestRouter(deps: SignalDigestControllerDeps = { service: () => SignalDigestService.getInstance() }): Router {
  const router = Router();
  router.post('/', (req, res) =>
    respond(res, 201, () => svc(deps).propose(readAgentSessionHeader(req) ?? undefined, (req.body ?? {}) as Record<string, unknown>)),
  );
  router.get('/', (req, res) =>
    respond(res, 200, () => svc(deps).list(typeof req.query.site === 'string' && req.query.site.trim() ? req.query.site.trim() : undefined)),
  );
  router.get('/history', (req, res) =>
    respond(res, 200, async () => {
      const site = siteParam(req);
      return { site, entries: await svc(deps).history(site) };
    }),
  );
  router.get('/:id', (req, res) =>
    respond(res, 200, async () => {
      const d = await svc(deps).get(req.params.id);
      if (!d) throw new SignalDigestError(404, `Signal digest ${req.params.id} not found`);
      return d;
    }),
  );
  router.post('/:id/items/:n', (req, res) =>
    respond(res, 200, async () => {
      if (readAgentSessionHeader(req)) throw new SignalDigestError(403, 'Only the owner answers a signal digest. Agents propose it and wait for the [SIGNAL DIGEST] message.');
      const choice = (req.body ?? {}).choice;
      if (!isSignalChoice(choice)) throw new SignalDigestError(400, 'choice must be "do" or "skip"');
      const n = Number.parseInt(req.params.n, 10);
      if (!Number.isInteger(n) || n < 1) throw new SignalDigestError(400, 'item number must be 1 or more');
      return svc(deps).choose(req.params.id, n, choice);
    }),
  );
  return router;
}
