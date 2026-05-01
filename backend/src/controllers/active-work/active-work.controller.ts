/**
 * Active Work Controller — HTTP endpoint backing the
 * `core/get-my-active-work` agent skill.
 *
 * Exposes a single GET endpoint that returns a JSON briefing of the
 * authoritative Request + WorkItem state for the calling agent. This is the
 * "freshness escape hatch" referenced in the recovery protocol Step 1.5:
 * the briefing is also injected server-side at registration time, but a
 * long-running session can call this endpoint to refresh after restart-time
 * snapshot ages out.
 *
 * Mounted at `/api/v3/agents/:sessionName/active-work`.
 *
 * Design doc: `/tmp/agent-state-recovery-design.md`
 * GitHub issue: stevehuang0115/crewly#395
 *
 * @module controllers/active-work/active-work.controller
 */

import { Router, type Request as ExpressRequest, type Response } from 'express';
import { ActiveWorkBriefingService } from '../../services/agent/active-work-briefing.service.js';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * GET /api/v3/agents/:sessionName/active-work
 *
 * Returns the live active-work briefing for the given session. Optional query
 * parameters mirror the service's {@link GenerateOptions}:
 *
 * - `role` — agent role (default `'developer'`). Required for the orchestrator
 *   path because the orchestrator uses a 3× cap multiplier and a system-wide
 *   query.
 * - `recentlyResolvedWindowMs` — window for recently auto-resolved items.
 * - `format` — when set to `markdown`, returns `text/markdown` rendered
 *   output instead of JSON. Useful for the bash skill which can pipe straight
 *   into the agent prompt without extra jq processing.
 *
 * Soft-fail: any error is returned as a 500 with `success: false`. The
 * skill caller is expected to surface the error inline so the agent can
 * decide whether to retry or proceed without the section.
 *
 * @param req - Express request with `:sessionName` route param
 * @param res - Express response — JSON or markdown depending on `?format`
 */
export async function getActiveWorkBriefing(
  req: ExpressRequest,
  res: Response,
): Promise<void> {
  const { sessionName } = req.params;
  if (!sessionName) {
    res.status(400).json({ success: false, error: 'sessionName param is required' });
    return;
  }

  const role = typeof req.query.role === 'string' ? req.query.role : 'developer';
  const format = typeof req.query.format === 'string' ? req.query.format : 'json';

  // Parse the optional recentlyResolvedWindowMs query parameter. Missing or
  // non-numeric values fall back to the service default (30min).
  const windowMsRaw = req.query.recentlyResolvedWindowMs;
  const windowMs = typeof windowMsRaw === 'string' ? Number.parseInt(windowMsRaw, 10) : NaN;

  try {
    const service = ActiveWorkBriefingService.getInstance();
    const briefing = await service.generateActiveWorkBriefing(sessionName, role, {
      recentlyResolvedWindowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : undefined,
    });

    if (format === 'markdown') {
      const md = service.formatBriefingAsMarkdown(briefing);
      res.type('text/markdown').send(md);
      return;
    }

    res.json({ success: true, data: briefing });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: message });
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Creates the Active Work router.
 *
 * Routes:
 * - GET `/:sessionName/active-work` — return the briefing
 *
 * Mounted under `/api/v3/agents` from `routes/api.routes.ts`.
 *
 * @returns Express router
 */
export function createActiveWorkRouter(): Router {
  const router = Router();
  router.get('/:sessionName/active-work', getActiveWorkBriefing);
  return router;
}
