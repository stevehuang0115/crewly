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
import {
  createChatV2Controller,
  type ChatV2ControllerDeps,
} from './chat-v2.controller.js';

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
  router.post('/channels', requireAuth, handlers.createChannel);
  // `/channels/dm/ensure` and `/channels/team/ensure` must precede the
  // `/channels/:id` matchers so Express doesn't bind `:id = 'dm'`/`'team'`.
  router.post('/channels/dm/ensure', requireAuth, handlers.ensureDmChannel);
  router.post('/channels/team/ensure', requireAuth, handlers.ensureTeamChannel);
  router.post('/channels/huddle', requireAuth, handlers.createHuddle);
  router.get('/channels/:id', requireAuth, handlers.getChannel);
  router.delete('/channels/:id', requireAuth, handlers.archiveChannel);

  router.get('/channels/:id/messages', requireAuth, handlers.listMessages);
  router.post('/channels/:id/messages', requireAuth, handlers.sendMessage);

  router.get('/agents', requireAuth, handlers.listAgents);
  router.get('/presence/:agentId', requireAuth, handlers.getAgentPresence);

  return router;
}
