/**
 * Crewly channels API (specs/2026-10-07-crewly-channels.md).
 *
 * - `GET    /api/channels`                       — list `{ channels }`; `?member=<session>` = that agent's channels; `?archived=true`
 * - `GET    /api/channels/:ref`                  — one channel by id, `#name`, name or Slack channel id
 * - `POST   /api/channels`                       — create `{ name, purpose?, memberSessions[] }`
 * - `POST   /api/channels/compose`               — orchestrator: create/extend with named agents, any machine `{ name | channel, members[], purpose? }`
 * - `POST   /api/channels/refresh`               — read names/members from Slack now
 * - `PATCH  /api/channels/:ref`                  — rename `{ name }`
 * - `POST   /api/channels/:ref/members`          — add `{ sessionName }`
 * - `DELETE /api/channels/:ref/members/:session` — remove
 * - `POST   /api/channels/:ref/archive`          — archive
 *
 * Reading is open to agents (to find a channel to post in); every change is
 * the owner's alone — except create / rename / add-member / compose, which the
 * orchestrator may also do (it acts for an owner who asks from the phone).
 *
 * @module controllers/channels/channels.routes
 */

import { Router, type Request, type Response } from 'express';
import { rejectNonOwner, rejectNonOwnerOrOrchestrator } from '../../middleware/caller-identity.middleware.js';
import { CrewlyChannelError, type CrewlyChannelService } from '../../services/channels/crewly-channel.service.js';
import type { ChannelComposeService } from '../../services/channels/crewly-channel-compose.service.js';

const OWNER_ONLY_CHANNELS = Object.freeze({
  success: false,
  error: 'owner_only',
  message: 'Only the owner can create or change channels (Chat › Channels).',
});

/** What any other agent hears when it tries to open, rename or extend a channel. */
const OWNER_OR_ORC_CHANNELS = Object.freeze({
  success: false,
  error: 'owner_only',
  message: 'Only the owner (or the orchestrator on the owner\'s behalf) can create or rename channels or add members.',
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
 * @param getCompose - Resolves the compose service (null → 503)
 * @returns Router for `/api/channels`
 */
export function createChannelsRouter(
  getService: () => CrewlyChannelService | null,
  getCompose: () => ChannelComposeService | null = () => null,
): Router {
  const router = Router();

  /** Run a handler with the service, answering 503 when it is not wired. */
  const withService =
    (ownerOnly: boolean | 'owner-or-orc', fn: (service: CrewlyChannelService, req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      // 2026-10-13: the owner asks the orchestrator (from the phone) to open a
      // channel; the orc must be able to, so create / add-member admit it, and
      // rename (2026-11-27, to add the channel prefix when the owner asks).
      // Every other change stays the owner's alone.
      if (ownerOnly === 'owner-or-orc') {
        if (rejectNonOwnerOrOrchestrator(req, res, OWNER_OR_ORC_CHANNELS)) return;
      } else if (ownerOnly && rejectNonOwner(req, res, OWNER_ONLY_CHANNELS)) return;
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
    '/compose',
    withService('owner-or-orc', async (_service, req, res) => {
      const compose = getCompose();
      if (!compose) {
        res.status(503).json({ success: false, error: 'unavailable', message: 'Channels are not ready yet' });
        return;
      }
      const body = req.body ?? {};
      const result = await compose.compose({
        name: typeof body.name === 'string' ? body.name : undefined,
        channel: typeof body.channel === 'string' ? body.channel : undefined,
        purpose: typeof body.purpose === 'string' ? body.purpose : undefined,
        members: Array.isArray(body.members) ? body.members.filter((m: unknown): m is string => typeof m === 'string') : [],
      });
      res.status(result.channel.created ? 201 : 200).json({ success: true, data: result });
    }),
  );

  router.post(
    '/',
    withService('owner-or-orc', async (service, req, res) => {
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
    withService('owner-or-orc', async (service, req, res) => {
      const name = typeof req.body?.name === 'string' ? req.body.name : '';
      res.json({ success: true, data: await service.rename(req.params.ref, name) });
    }),
  );

  router.post(
    '/:ref/members',
    withService('owner-or-orc', async (service, req, res) => {
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
