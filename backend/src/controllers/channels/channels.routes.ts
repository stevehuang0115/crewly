/**
 * Crewly channels API (specs/2026-10-07-crewly-channels.md).
 *
 * - `GET    /api/channels`                       — list `{ channels }`; `?member=<session>` = that agent's channels; `?archived=true`
 * - `GET    /api/channels/:ref`                  — one channel by id, `#name`, name or Slack channel id
 * - `POST   /api/channels`                       — create `{ name, purpose?, memberSessions[] }`
 * - `POST   /api/channels/refresh`               — read names/members from Slack now
 * - `PATCH  /api/channels/:ref`                  — rename `{ name }`
 * - `POST   /api/channels/:ref/members`          — add `{ sessionName }`
 * - `DELETE /api/channels/:ref/members/:session` — remove
 * - `POST   /api/channels/:ref/archive`          — archive
 *
 * Reading is open to agents (to find a channel to post in); every change is
 * the owner's alone.
 *
 * @module controllers/channels/channels.routes
 */

import { Router, type Request, type Response } from 'express';
import { rejectNonOwner } from '../../middleware/caller-identity.middleware.js';
import { CrewlyChannelError, type CrewlyChannelService } from '../../services/channels/crewly-channel.service.js';

const OWNER_ONLY_CHANNELS = Object.freeze({
  success: false,
  error: 'owner_only',
  message: 'Only the owner can create or change channels (Chat › Channels).',
});

/**
 * Send a service error with its status.
 *
 * @param res - Response
 * @param err - Error
 */
function sendError(res: Response, err: unknown): void {
  if (err instanceof CrewlyChannelError) {
    res.status(err.httpStatus).json({ success: false, error: err.code, message: err.message });
    return;
  }
  res.status(500).json({ success: false, error: 'internal_error', message: err instanceof Error ? err.message : String(err) });
}

/**
 * Build the router.
 *
 * @param getService - Resolves the channel service (null → 503)
 * @returns Router for `/api/channels`
 */
export function createChannelsRouter(getService: () => CrewlyChannelService | null): Router {
  const router = Router();

  /** Run a handler with the service, answering 503 when it is not wired. */
  const withService =
    (ownerOnly: boolean, fn: (service: CrewlyChannelService, req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      if (ownerOnly && rejectNonOwner(req, res, OWNER_ONLY_CHANNELS)) return;
      const service = getService();
      if (!service) {
        res.status(503).json({ success: false, error: 'unavailable', message: 'Channels are not ready yet' });
        return;
      }
      try {
        await fn(service, req, res);
      } catch (err) {
        sendError(res, err);
      }
    };

  router.get(
    '/',
    withService(false, async (service, req, res) => {
      const member = typeof req.query.member === 'string' && req.query.member.trim() ? req.query.member.trim() : undefined;
      const includeArchived = req.query.archived === 'true' || req.query.archived === '1';
      res.json({ success: true, data: { channels: await service.list({ member, includeArchived }) } });
    }),
  );

  router.post(
    '/refresh',
    withService(true, async (service, _req, res) => {
      res.json({ success: true, data: { channels: await service.refresh() } });
    }),
  );

  router.get(
    '/:ref',
    withService(false, async (service, req, res) => {
      res.json({ success: true, data: await service.get(req.params.ref) });
    }),
  );

  router.post(
    '/',
    withService(true, async (service, req, res) => {
      const body = req.body ?? {};
      const channel = await service.create({
        name: typeof body.name === 'string' ? body.name : '',
        purpose: typeof body.purpose === 'string' ? body.purpose : undefined,
        memberSessions: Array.isArray(body.memberSessions) ? body.memberSessions : [],
      });
      res.status(201).json({ success: true, data: channel });
    }),
  );

  router.patch(
    '/:ref',
    withService(true, async (service, req, res) => {
      const name = typeof req.body?.name === 'string' ? req.body.name : '';
      res.json({ success: true, data: await service.rename(req.params.ref, name) });
    }),
  );

  router.post(
    '/:ref/members',
    withService(true, async (service, req, res) => {
      const sessionName = typeof req.body?.sessionName === 'string' ? req.body.sessionName : '';
      res.json({ success: true, data: await service.addMember(req.params.ref, sessionName) });
    }),
  );

  router.delete(
    '/:ref/members/:session',
    withService(true, async (service, req, res) => {
      res.json({ success: true, data: await service.removeMember(req.params.ref, req.params.session) });
    }),
  );

  router.post(
    '/:ref/archive',
    withService(true, async (service, req, res) => {
      res.json({ success: true, data: await service.archive(req.params.ref) });
    }),
  );

  return router;
}
