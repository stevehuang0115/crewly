/**
 * Colleague message routes (`message-colleague` skill).
 *
 * - `POST /api/colleagues/message` `{ to, message, replyTo?, team? }` — the
 *   sender is the calling agent (caller identity, never the body).
 *
 * @module controllers/colleague/colleague.controller
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { getColleagueMessageService } from '../../services/colleague/colleague.wiring.js';
import type { ColleagueSendResult } from '../../services/colleague/colleague-message.types.js';

const STATUS_BY_CODE: Record<NonNullable<ColleagueSendResult['code']>, number> = {
  invalid: 400,
  not_found: 404,
  ambiguous: 409,
  self: 400,
  loop_cap: 429,
  cloud_unavailable: 503,
  machine_unknown: 404,
  send_failed: 502,
  delivery_failed: 502,
};

/** @returns The router mounted at `/api/colleagues` */
export function createColleagueRouter(): Router {
  const router = Router();

  router.post('/message', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = getColleagueMessageService();
      if (!service) {
        res.status(503).json({ success: false, code: 'cloud_unavailable', error: 'Colleague messaging is not running on this machine yet.' });
        return;
      }
      const fromSession = readAgentSessionHeader(req);
      if (!fromSession) {
        res.status(403).json({ success: false, code: 'invalid', error: 'Only an agent can send a colleague message.' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      const result = await service.send({
        fromSession,
        to: str(body.to) ?? '',
        text: typeof body.message === 'string' ? body.message : '',
        ...(str(body.replyTo) ? { replyTo: str(body.replyTo) } : {}),
        ...(str(body.team) ? { team: str(body.team) } : {}),
      });
      res.status(result.success ? 200 : STATUS_BY_CODE[result.code ?? 'invalid']).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
