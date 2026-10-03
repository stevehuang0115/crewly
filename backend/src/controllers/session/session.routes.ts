/**
 * Session Routes
 *
 * Defines HTTP routes for session management operations.
 * These endpoints are used by the MCP server to interact with
 * sessions managed by the backend.
 *
 * @module session.routes
 */

import { Router } from 'express';
import type { ApiContext } from '../types.js';
import { ownerOnly } from '../../middleware/caller-identity.middleware.js';
import { OWNER_AUTH_CONSTANTS } from '../../constants.js';
import {
	listSessions,
	getSession,
	createSession,
	writeToSession,
	getSessionOutput,
	killSession,
	getPreviousSessions,
	dismissPreviousSessions,
	submitOAuthCallback,
} from './session.controller.js';

/**
 * Creates session router with all session-related endpoints
 *
 * @param context - API context with services
 * @returns Express router configured with session routes
 */
export function createSessionRouter(context: ApiContext): Router {
	const router = Router();

	// Opening a terminal, typing into one, killing one and answering its
	// OAuth prompt are the owner's (#1012). The harness spawns agents in
	// process, and agents message each other through /terminal/:s/*, so no
	// agent or anonymous caller needs these. Reads stay open.
	const ownerGate = ownerOnly({
		success: false,
		error: OWNER_AUTH_CONSTANTS.ERRORS.OWNER_ONLY,
		message: 'Only the owner can open, write to or close a terminal session here. Agents message each other through the send-message skill.',
	});

	// Previous sessions endpoints (must come before /:name to avoid route conflicts)
	router.get('/previous', getPreviousSessions.bind(context));
	router.post('/previous/dismiss', dismissPreviousSessions.bind(context));

	// Session management endpoints
	router.get('/', listSessions.bind(context));
	router.post('/', ownerGate, createSession.bind(context));
	router.get('/:name', getSession.bind(context));
	router.delete('/:name', ownerGate, killSession.bind(context));

	// Session I/O endpoints
	router.post('/:name/write', ownerGate, writeToSession.bind(context));
	router.get('/:name/output', getSessionOutput.bind(context));

	// OAuth callback endpoint
	router.post('/:name/oauth-callback', ownerGate, submitOAuthCallback.bind(context));

	return router;
}
