/**
 * Agent Stream Routes
 *
 * Routes for real-time SSE streaming of agent execution events.
 *
 * @module controllers/agent-stream/agent-stream.routes
 */

import { Router } from 'express';
import { streamAgentEvents, getStreamableSessions } from './agent-stream.controller.js';

/**
 * Creates the agent stream router.
 *
 * Routes:
 * - GET /agents/sessions — list streamable sessions
 * - GET /agents/:sessionName/stream — SSE stream for a specific agent
 *
 * @returns Express router
 */
export function createAgentStreamRouter(): Router {
  const router = Router();

  router.get('/sessions', getStreamableSessions);
  router.get('/:sessionName/stream', streamAgentEvents);

  return router;
}
