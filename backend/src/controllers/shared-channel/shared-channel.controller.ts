/**
 * Shared-channel routes (`post-shared-channel` skill, crewly#1543 slice 5).
 *
 * - `GET  /api/shared-channels` — the account's links with their trial state.
 * - `POST /api/shared-channels/:linkId/messages` `{ message, replyTo? }` — send
 *   to another company's Crewly account. An agent caller sends as itself
 *   (caller identity, never the body) and only the orchestrator may; its
 *   message is classified and may be held for the owner or refused. An owner
 *   caller's message goes straight through.
 *
 * @module controllers/shared-channel/shared-channel.controller
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { isOwnerCaller, readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { getSharedChannelSendService } from '../../services/shared-channel/shared-channel.wiring.js';
import type { SharedSendCode } from '../../services/shared-channel/shared-channel-send.service.js';

/** HTTP status per failure code. */
export const SHARED_SEND_STATUS_BY_CODE: Readonly<Record<SharedSendCode, number>> = {
  invalid: 400,
  not_allowed: 403,
  not_found: 404,
  link_not_active: 409,
  too_long: 413,
  refused: 422,
  rate_limited: 429,
  send_failed: 502,
  cloud_unavailable: 503,
  cannot_hold: 503,
};

const NOT_RUNNING = { success: false, code: 'cloud_unavailable', error: 'Shared channels are not running on this machine yet.' } as const;

/** @returns The router mounted at `/api/shared-channels` */
export function createSharedChannelRouter(): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const service = getSharedChannelSendService();
      if (!service) {
        res.status(503).json(NOT_RUNNING);
        return;
      }
      const links = await service.listLinks();
      if (!links) {
        res.status(503).json({ success: false, code: 'cloud_unavailable', error: 'Crewly Cloud cannot be reached from this machine right now.' });
        return;
      }
      res.json({ success: true, links });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:linkId/messages', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = getSharedChannelSendService();
      if (!service) {
        res.status(503).json(NOT_RUNNING);
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = typeof body.message === 'string' ? body.message : '';
      const replyTo = typeof body.replyTo === 'string' && body.replyTo.trim() ? body.replyTo.trim() : undefined;
      const linkId = String(req.params.linkId ?? '');
      const fromSession = readAgentSessionHeader(req);
      let result;
      if (fromSession) {
        result = await service.sendFromAgent({ fromSession, linkId, text, ...(replyTo ? { replyTo } : {}) });
      } else if (isOwnerCaller(req)) {
        result = await service.sendFromOwner({ linkId, text, ...(replyTo ? { replyTo } : {}) });
      } else {
        res.status(403).json({ success: false, code: 'not_allowed', error: 'Only the owner or the orchestrator can write to an external team.' });
        return;
      }
      res.status(result.success ? 200 : SHARED_SEND_STATUS_BY_CODE[result.code ?? 'invalid']).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
