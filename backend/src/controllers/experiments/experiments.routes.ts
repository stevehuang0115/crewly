/**
 * Experiment card routes — mounted at `/api/experiments` (issue #986).
 *
 * - GET  /               — list (`?status=planned|running|done|cancelled&ticket=`)
 * - POST /               — create `{hypothesis, metric, title?, direction?, expected?, windowDays?, ticket?, confidence?}`
 * - GET  /:id            — one experiment with its timeline (the run's trace)
 * - POST /:id/ship       — the change is live `{shippedAt?}`: windows fixed, baseline captured
 * - POST /:id/measure    — measure a due experiment now
 * - POST /:id/cancel     — `{reason?}`
 *
 * The caller is the agent session header (or `owner` for the dashboard);
 * its prediction is recorded under that session.
 *
 * specs/experiment-cards.md
 *
 * @module controllers/experiments/experiments.routes
 */

import { Router, type Request, type Response } from 'express';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { ExperimentError, ExperimentService, statusFilter } from '../../services/experiments/experiment.service.js';

/**
 * Send an error.
 *
 * @param res - Response
 * @param err - Thrown value
 */
function fail(res: Response, err: unknown): void {
  if (err instanceof ExperimentError) {
    res.status(err.status).json({ success: false, error: err.message });
    return;
  }
  res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
}

/**
 * Who is calling.
 *
 * @param req - Request
 * @returns Agent session, or `owner`
 */
function callerOf(req: Request): string {
  return readAgentSessionHeader(req) ?? 'owner';
}

/**
 * Create the experiments router.
 *
 * @param getService - Service lookup (default: the installed one)
 * @returns Router
 */
export function createExperimentsRouter(getService: () => ExperimentService | null = () => ExperimentService.getInstance()): Router {
  const router = Router();

  /**
   * Run a handler with the service, 503 before boot installs it.
   *
   * @param res - Response
   * @param fn - Handler
   */
  const withService = async (res: Response, fn: (svc: ExperimentService) => Promise<unknown>): Promise<void> => {
    const svc = getService();
    if (!svc) {
      res.status(503).json({ success: false, error: 'Experiments are not running (starting up, or CREWLY_EXPERIMENTS=0)' });
      return;
    }
    try {
      res.json({ success: true, data: await fn(svc) });
    } catch (err) {
      fail(res, err);
    }
  };

  router.get('/', (req, res) =>
    withService(res, (svc) => {
      const status = typeof req.query.status === 'string' && req.query.status ? statusFilter(req.query.status) : undefined;
      if (typeof req.query.status === 'string' && req.query.status && !status) {
        throw new ExperimentError(400, 'status must be planned, running, done or cancelled');
      }
      const ticket = typeof req.query.ticket === 'string' && req.query.ticket ? req.query.ticket : undefined;
      return svc.list({ ...(status ? { status } : {}), ...(ticket ? { ticket } : {}) });
    }),
  );
  router.post('/', (req, res) => withService(res, (svc) => svc.create(req.body ?? {}, callerOf(req))));
  router.get('/:id', (req, res) =>
    withService(res, async (svc) => {
      const e = await svc.get(req.params.id);
      if (!e) throw new ExperimentError(404, `Experiment not found: ${req.params.id}`);
      return e;
    }),
  );
  router.post('/:id/ship', (req, res) =>
    withService(res, (svc) => {
      const at = (req.body ?? {}).shippedAt;
      return svc.ship(req.params.id, callerOf(req), typeof at === 'string' && at ? at : undefined);
    }),
  );
  router.post('/:id/measure', (req, res) => withService(res, (svc) => svc.measureNow(req.params.id)));
  router.post('/:id/cancel', (req, res) =>
    withService(res, (svc) => {
      const reason = (req.body ?? {}).reason;
      return svc.cancel(req.params.id, callerOf(req), typeof reason === 'string' ? reason : undefined);
    }),
  );
  return router;
}
