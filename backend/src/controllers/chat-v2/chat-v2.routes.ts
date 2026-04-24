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
import { createChatV2Controller } from './chat-v2.controller.js';

/**
 * Build the router for chat-v2 endpoints.
 *
 * Routes (mounted under `/api/chat`):
 * - `GET    /channels`
 * - `POST   /channels`
 * - `GET    /channels/:id`
 * - `DELETE /channels/:id`
 * - `GET    /channels/:id/messages`
 * - `POST   /channels/:id/messages`
 *
 * @param service - Configured ChatV2Service
 * @returns Express router
 */
export function createChatV2Router(service: ChatV2Service): Router {
  const router = Router();
  const handlers = createChatV2Controller(service);

  router.get('/channels', requireAuth, handlers.listChannels);
  router.post('/channels', requireAuth, handlers.createChannel);
  router.get('/channels/:id', requireAuth, handlers.getChannel);
  router.delete('/channels/:id', requireAuth, handlers.archiveChannel);

  router.get('/channels/:id/messages', requireAuth, handlers.listMessages);
  router.post('/channels/:id/messages', requireAuth, handlers.sendMessage);

  return router;
}
