/**
 * Terminal Routes Module
 *
 * Registers API routes for terminal session management.
 * Uses ISessionBackend for PTY-based session operations.
 *
 * @module terminal-routes
 */

import { Router } from 'express';
import { ApiController } from '../../controllers/api.controller.js';
import * as terminalHandlers from '../../controllers/monitoring/terminal.controller.js';
import { ownerOrVerifiedAgent } from '../../middleware/caller-identity.middleware.js';

/**
 * Writes into an agent's terminal (and killing it) need the owner or an agent
 * identified by its badge (#1024). Before, any local process could type into
 * the orchestrator's Claude Code — which runs with skip-permissions — with a
 * bare `curl`. Agents keep messaging each other (send-message, delegate-task,
 * broadcast, send-key, terminate-agent …): `api_call` sends the badge.
 * Backend services deliver in process or with `internalAgentHeaders`.
 */
const terminalWriter = ownerOrVerifiedAgent("Writing into an agent's terminal");

/**
 * Register terminal routes on the router.
 *
 * Routes:
 * - GET /terminal/sessions - List all sessions
 * - GET /terminal/:sessionName/exists - Check if session exists
 * - GET /terminal/:sessionName/output - Get session output (alias for capture)
 * - GET /terminal/:sessionName/capture - Capture terminal output (legacy)
 * - POST /terminal/:sessionName/write - Write data to session
 * - POST /terminal/:sessionName/deliver - Reliable message delivery with retry (requires ApiController)
 * - POST /terminal/:sessionName/input - Send input to session (legacy)
 * - POST /terminal/:sessionName/key - Send key to session
 * - DELETE /terminal/:sessionName - Kill session
 *
 * The writes (write, deliver, input, key, DELETE) need the owner or a
 * badge-identified agent: anonymous callers get 401, an agent with only the
 * legacy `X-Agent-Session` header 403 `agent_badge_required`. Reads stay open.
 *
 * @param router - Express router to register routes on
 * @param apiController - Optional ApiController for endpoints that need AgentRegistrationService
 */
export function registerTerminalRoutes(router: Router, apiController?: ApiController): void {
	// List all sessions
	router.get('/terminal/sessions', terminalHandlers.listTerminalSessions);

	// Check if session exists
	router.get('/terminal/:sessionName/exists', terminalHandlers.sessionExists);

	// Get session output (new PTY-based endpoint)
	router.get('/terminal/:sessionName/output', terminalHandlers.captureTerminal);

	// Capture terminal output (legacy endpoint, same as output)
	router.get('/terminal/:sessionName/capture', terminalHandlers.captureTerminal);

	// Write data to session (new PTY-based endpoint)
	router.post('/terminal/:sessionName/write', terminalWriter, terminalHandlers.writeToSession);

	// Reliable message delivery with retry and verification (requires ApiController)
	if (apiController) {
		router.post('/terminal/:sessionName/deliver', terminalWriter, (req, res) =>
			terminalHandlers.deliverMessage.call(apiController, req, res)
		);
	}

	// Send input to session (legacy endpoint)
	router.post('/terminal/:sessionName/input', terminalWriter, terminalHandlers.sendTerminalInput);

	// Send key to session
	router.post('/terminal/:sessionName/key', terminalWriter, terminalHandlers.sendTerminalKey);

	// Kill session
	router.delete('/terminal/:sessionName', terminalWriter, terminalHandlers.killSession);

	// Get persistent session log file (ANSI-stripped, includes pre-restart output)
	router.get('/sessions/:sessionName/logs', terminalHandlers.getSessionLogs);

	// Adaptive heartbeat: pending work check (#172)
	if (apiController) {
		router.get('/agents/:sessionName/pending-work', (req, res) =>
			terminalHandlers.getPendingWork.call(apiController, req, res)
		);
	}
}
