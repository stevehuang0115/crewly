/**
 * Agent Hooks Routes
 *
 * @module controllers/agent-hooks/agent-hooks.routes
 */

import { Router } from 'express';
import { receiveAgentHook } from './agent-hooks.controller.js';

/**
 * Create the router for /api/agent-hooks (#815).
 *
 * @returns Express router with POST /
 */
export function createAgentHooksRouter(): Router {
	const router = Router();
	// POST /api/agent-hooks — an agent-status hook event (event + notification type only)
	router.post('/', receiveAgentHook);
	return router;
}
