/**
 * Router factory for Phase 1 Chat endpoints.
 *
 * Wires `requireAuth` + controller handlers onto Express routes under
 * `/channels/*`. The parent `/api/chat/*` prefix is mounted by
 * `routes/api.routes.ts`, so paths defined here are relative.
 *
 * @module controllers/chat-v2/chat-v2.routes
 */

import { Router } from 'express';
import { requireAuth } from '../../middleware/require-auth.middleware.js';
import type { ChatV2Service } from '../../services/chat-v2/chat-v2.service.js';
import type { NextFunction, Request, Response } from 'express';
import {
  createChatV2Controller,
  rejectUnidentifiedChatWriter,
  type ChatV2ControllerDeps,
} from './chat-v2.controller.js';

/**
 * Every chat write needs an owner credential or an identified agent
 * (#1012): an anonymous post used to be stored as the owner's own words.
 *
 * @param req - Request
 * @param res - Response
 * @param next - Next
 */
function requireChatWriter(req: Request, res: Response, next: NextFunction): void {
  if (rejectUnidentifiedChatWriter(req, res)) return;
  next();
}

/**
 * Build the router for chat-v2 endpoints.
 *
 * Routes (mounted under `/api/chat`):
 * - `GET    /channels`
 * - `POST   /channels`
 * - `POST   /channels/dm/ensure` — find-or-create DM channel for an agent
 * - `POST   /channels/team/ensure` — find-or-create the canonical team channel
 * - `POST   /channels/huddle` — create an ad-hoc multi-agent group chat
 * - `GET    /channels/:id`
 * - `DELETE /channels/:id`
 * - `GET    /channels/:id/messages`
 * - `POST   /channels/:id/messages`
 * - `GET    /agents` — directory of agents across all teams
 * - `GET    /presence/:agentId` — live presence for one agent
 * - `GET    /agents/:session/timeline` — one agent's messages across every surface
 *
 * @param service - Configured ChatV2Service
 * @param deps    - Optional gateway + dispatcher for realtime wiring
 * @returns Express router
 */
export function createChatV2Router(
  service: ChatV2Service,
  deps: ChatV2ControllerDeps = {},
): Router {
  const router = Router();
  const handlers = createChatV2Controller(service, deps);

  router.get('/channels', requireAuth, handlers.listChannels);
  router.post('/channels', requireAuth, requireChatWriter, handlers.createChannel);
  // `/channels/dm/ensure` and `/channels/team/ensure` must precede the
  // `/channels/:id` matchers so Express doesn't bind `:id = 'dm'`/`'team'`.
  router.post('/channels/dm/ensure', requireAuth, requireChatWriter, handlers.ensureDmChannel);
  router.post('/channels/team/ensure', requireAuth, requireChatWriter, handlers.ensureTeamChannel);
  router.post('/channels/huddle', requireAuth, requireChatWriter, handlers.createHuddle);
  router.get('/channels/:id', requireAuth, handlers.getChannel);
  router.delete('/channels/:id', requireAuth, requireChatWriter, handlers.archiveChannel);

  router.get('/channels/:id/messages', requireAuth, handlers.listMessages);
  router.post('/channels/:id/messages', requireAuth, requireChatWriter, handlers.sendMessage);

  router.get('/agents', requireAuth, handlers.listAgents);
  router.get('/agents/:session/timeline', requireAuth, handlers.getAgentTimeline);
  router.get('/presence/:agentId', requireAuth, handlers.getAgentPresence);

  return router;
}
