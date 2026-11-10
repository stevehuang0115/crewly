/**
 * Shared-channel routes (`post-shared-channel` skill, crewly#1543 slice 5).
 *
 * - `GET  /api/shared-channels` — the account's links with their trial state.
 * - `POST /api/shared-channels/:linkId/messages` `{ message, replyTo? }` — send
 *   to another company's Crewly account. An agent caller sends as itself
 *   (caller identity, never the body) and only the orchestrator may; its
 *   message is classified and may be held for the owner or refused. An owner
 *   caller's message goes straight through.
 * - `GET  /api/shared-channels/:linkId/norms` — the owner's norm for a link
 *   and the allowance catalogue (owner only).
 * - `PUT  /api/shared-channels/:linkId/norms` `{ norm?, allow? }` — change it
 *   (owner only; agents get 403). Logged as `shared_channel.norm.updated`.
 *
 * @module controllers/shared-channel/shared-channel.controller
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { isOwnerCaller, readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { getSharedChannelSendService } from '../../services/shared-channel/shared-channel.wiring.js';
import type { SharedSendCode } from '../../services/shared-channel/shared-channel-send.service.js';
import { getSharedChannelNormsStore } from '../../services/shared-channel/shared-channel.wiring.js';
import { SHARED_NORM_ACTIONS, SHARED_NORM_ALLOWANCES, parseNormUpdate, type SharedChannelNorm } from '../../services/shared-channel/shared-channel-norms.js';
import type { SharedChannelNormsStore } from '../../services/shared-channel/shared-channel-norms.store.js';
import { rejectNonOwner } from '../../middleware/caller-identity.middleware.js';
import { actorFromRequest, recordActivity, summarizeChange } from '../../services/activity/activity-log.service.js';

/** A link id as Cloud issues them. */
const LINK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** 403 body for an agent on the norms routes. */
const NORMS_OWNER_ONLY = { success: false, code: 'not_allowed', error: "Only the owner sets what another company may be told. Ask the owner to change this link's norm." } as const;

/** Router options (tests inject a store in a temporary directory). */
export interface SharedChannelRouterOptions {
  /** The per-link norms store (default: the one under `~/.crewly`) */
  norms?: () => Pick<SharedChannelNormsStore, 'get' | 'set'>;
}

/**
 * The norms payload of a link.
 *
 * @param linkId - Link id
 * @param norm - Its norm
 * @returns Response data, with the allowance catalogue for the editor
 */
function normsPayload(linkId: string, norm: SharedChannelNorm): Record<string, unknown> {
  return {
    linkId,
    norm: norm.norm,
    allow: norm.allow,
    updatedAt: norm.updatedAt || null,
    allowances: SHARED_NORM_ALLOWANCES.map(({ key, label, detail }) => ({ key, label, detail })),
  };
}

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

/**
 * @param options - Injected collaborators (tests)
 * @returns The router mounted at `/api/shared-channels`
 */
export function createSharedChannelRouter(options: SharedChannelRouterOptions = {}): Router {
  const router = Router();
  const norms = options.norms ?? (() => getSharedChannelNormsStore());

  router.get('/:linkId/norms', (req: Request, res: Response, next: NextFunction) => {
    try {
      if (rejectNonOwner(req, res, NORMS_OWNER_ONLY)) return;
      const linkId = String(req.params.linkId ?? '');
      if (!LINK_ID_RE.test(linkId)) {
        res.status(400).json({ success: false, code: 'invalid', error: `Invalid link id: ${linkId}` });
        return;
      }
      res.json({ success: true, data: normsPayload(linkId, norms().get(linkId)) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/:linkId/norms', (req: Request, res: Response, next: NextFunction) => {
    try {
      if (rejectNonOwner(req, res, NORMS_OWNER_ONLY)) return;
      const linkId = String(req.params.linkId ?? '');
      if (!LINK_ID_RE.test(linkId)) {
        res.status(400).json({ success: false, code: 'invalid', error: `Invalid link id: ${linkId}` });
        return;
      }
      const parsed = parseNormUpdate(req.body);
      if (!parsed.ok) {
        res.status(400).json({ success: false, code: 'invalid', error: parsed.error });
        return;
      }
      let change: { before: SharedChannelNorm; after: SharedChannelNorm };
      try {
        change = norms().set(linkId, parsed.update);
      } catch {
        res.status(500).json({ success: false, code: 'save_failed', error: 'The norm could not be saved on this machine. Nothing changed.' });
        return;
      }
      const diff = summarizeChange({ norm: change.before.norm, allow: change.before.allow }, { norm: change.after.norm, allow: change.after.allow });
      if (diff.before || diff.after) {
        recordActivity({
          actor: actorFromRequest(req),
          action: SHARED_NORM_ACTIONS.UPDATED,
          target: { type: 'shared_channel', id: linkId },
          ...diff,
          note: 'the owner changed what this external team may be told',
        });
      }
      res.json({ success: true, data: normsPayload(linkId, change.after) });
    } catch (error) {
      next(error);
    }
  });

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
