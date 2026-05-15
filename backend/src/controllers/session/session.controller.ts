/**
 * Session Controller
 *
 * Handles HTTP API endpoints for session management operations.
 * Provides REST API interface for the MCP server to interact with sessions
 * managed by the backend's session backend.
 *
 * @module session.controller
 */

import type { Request, Response } from 'express';
import { getSessionBackendSync, getSessionBackend, getSessionStatePersistence, createSessionCommandHelper } from '../../services/session/index.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { OAuthReloginMonitorService } from '../../services/agent/oauth-relogin-monitor.service.js';
import { RUNTIME_TYPES } from '../../constants.js';
import { TaskPoolService } from '../../services/task-pool/task-pool.service.js';

const logger = LoggerService.getInstance().createComponentLogger('SessionController');

/**
 * List all active sessions
 *
 * @route GET /api/sessions
 * @returns {object} JSON response with sessions array
 */
export async function listSessions(
	this: unknown,
	req: Request,
	res: Response
): Promise<void> {
	try {
		// Use async getSessionBackend to ensure backend is initialized
		// This prevents race conditions when sessions are queried before orchestrator setup completes
		const backend = await getSessionBackend();

		const sessionNames = backend.listSessions();
		const sessions = sessionNames.map((name) => {
			const session = backend.getSession(name);
			return {
				sessionName: name,
				pid: session?.pid,
				cwd: session?.cwd,
				status: 'active',
			};
		});

		res.json({ sessions });
	} catch (error) {
		logger.error('Failed to list sessions', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			error: 'Failed to list sessions',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
}

/**
 * Get a specific session by name
 *
 * @route GET /api/sessions/:name
 * @param name - Session name
 * @returns {object} JSON response with session info or 404
 */
export async function getSession(
	this: unknown,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { name } = req.params;
		const backend = getSessionBackendSync();

		if (!backend || !backend.sessionExists(name)) {
			res.status(404).json({ error: `Session '${name}' not found` });
			return;
		}

		const session = backend.getSession(name);
		res.json({
			sessionName: name,
			pid: session?.pid,
			cwd: session?.cwd,
			status: 'active',
		});
	} catch (error) {
		logger.error('Failed to get session', { name: req.params.name, error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			error: 'Failed to get session',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
}

/**
 * Create a new session
 *
 * @route POST /api/sessions
 * @body {name, cwd, command, args, env} - Session configuration
 * @returns {object} JSON response with created session info
 */
export async function createSession(
	this: unknown,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { name, cwd, command, args, env } = req.body;

		if (!name) {
			res.status(400).json({ error: 'Session name is required' });
			return;
		}

		const backend = await getSessionBackend();

		if (backend.sessionExists(name)) {
			res.status(409).json({ error: `Session '${name}' already exists` });
			return;
		}

		const session = await backend.createSession(name, {
			cwd: cwd || process.cwd(),
			command: command || process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
			args: args || [],
			env: env || {},
		});

		logger.info(`Created session '${name}'`);
		res.status(201).json({
			sessionName: name,
			pid: session.pid,
			cwd: session.cwd,
			status: 'active',
		});
	} catch (error) {
		logger.error('Failed to create session', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			error: 'Failed to create session',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
}

/**
 * Write data to a session
 *
 * @route POST /api/sessions/:name/write
 * @param name - Session name
 * @body {data} - Data to write to the session
 * @returns {object} JSON response confirming write
 */
export async function writeToSession(
	this: unknown,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { name } = req.params;
		const { data, mode } = req.body;

		if (!data) {
			res.status(400).json({ error: 'Data is required' });
			return;
		}

		const backend = getSessionBackendSync();

		if (!backend || !backend.sessionExists(name)) {
			res.status(404).json({ error: `Session '${name}' not found` });
			return;
		}

		if (mode === 'message') {
			// Use SessionCommandHelper.sendMessage() which writes text then sends Enter key
			const helper = createSessionCommandHelper(backend);
			await helper.sendMessage(name, data);
			res.json({ success: true, message: `Message sent to session '${name}'` });
		} else {
			// Raw write preserved for control sequences and backwards compatibility
			const session = backend.getSession(name);
			if (session) {
				session.write(data);
				res.json({ success: true, message: `Data written to session '${name}'` });
			} else {
				res.status(404).json({ error: `Session '${name}' not found` });
			}
		}
	} catch (error) {
		logger.error('Failed to write to session', { name: req.params.name, error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			error: 'Failed to write to session',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
}

/**
 * Get output from a session
 *
 * @route GET /api/sessions/:name/output
 * @param name - Session name
 * @query lines - Number of lines to retrieve (default: 100)
 * @returns {object} JSON response with session output
 */
export async function getSessionOutput(
	this: unknown,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { name } = req.params;
		const lines = parseInt(req.query.lines as string) || 100;

		const backend = getSessionBackendSync();

		if (!backend || !backend.sessionExists(name)) {
			res.status(404).json({ error: `Session '${name}' not found` });
			return;
		}

		const output = backend.captureOutput(name, lines);
		res.json({ output });
	} catch (error) {
		logger.error('Failed to get session output', { name: req.params.name, error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			error: 'Failed to get session output',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
}

/**
 * Kill a session
 *
 * @route DELETE /api/sessions/:name
 * @param name - Session name
 * @returns {object} JSON response confirming deletion
 */
export async function killSession(
	this: unknown,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { name } = req.params;
		const backend = getSessionBackendSync();

		if (!backend || !backend.sessionExists(name)) {
			res.status(404).json({ error: `Session '${name}' not found` });
			return;
		}

		await backend.killSession(name);
		logger.info(`Killed session '${name}'`);
		res.json({ success: true, message: `Session '${name}' killed` });
	} catch (error) {
		logger.error('Failed to kill session', { name: req.params.name, error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			error: 'Failed to kill session',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
}

/**
 * Get previously running sessions that can be resumed.
 *
 * Returns sessions that have persisted metadata but no active PTY session.
 * Used by the frontend to show a resume popup on app restart.
 *
 * @route GET /api/sessions/previous
 * @returns {object} JSON response with previous sessions
 */
export async function getPreviousSessions(
	this: unknown,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const persistence = getSessionStatePersistence();
		const sessions = persistence.getRegisteredSessionsMap();
		const backend = getSessionBackendSync();

		// Steve 2026-05-15 dogfood: the Resume Sessions dialog was
		// listing every previously-running agent (12+ rows on a typical
		// restart) including marketing/think-tank members with zero
		// queued WorkItems. The wake-gate at startTeamMember rejects
		// those wakes with "pool has no queued/blocked WorkItem with
		// target=<session>" — so resuming them via the dialog burns
		// compute and produces failed wake warnings. Filter the resume
		// list to sessions that have a non-terminal WI in the pool
		// targeting them; idle agents stay dismissed and the user can
		// manually start them from the Teams page if they want.
		let targetsWithWork: Set<string> | null = null;
		try {
			const items = await TaskPoolService.getInstance().getAllItems();
			targetsWithWork = new Set(
				items
					.filter(
						(w) =>
							typeof w.target === 'string' &&
							w.target.length > 0 &&
							w.status !== 'done' &&
							w.status !== 'verified' &&
							w.status !== 'cancelled' &&
							w.status !== 'failed' &&
							w.status !== 'rejected',
					)
					.map((w) => w.target as string),
			);
		} catch (err) {
			// Pool unavailable — fall back to the legacy include-all
			// behavior so the dialog still helps the user resume after a
			// crash where the pool can't be loaded.
			logger.warn('getPreviousSessions: pool read failed, skipping pool-filter', {
				error: err instanceof Error ? err.message : String(err),
			});
			targetsWithWork = null;
		}

		const previousSessions: Array<{
			name: string;
			role?: string;
			teamId?: string;
			runtimeType: string;
			hasResumeId: boolean;
		}> = [];

		for (const [name, info] of sessions) {
			// Only include sessions that don't have an active PTY
			if (backend?.sessionExists(name)) continue;
			// Pool-filter: skip sessions with no active WI targeting them.
			// Orchestrator is excluded from the filter — it auto-starts
			// independently of pool state and the frontend already filters
			// it out of the dialog separately.
			if (
				targetsWithWork &&
				info.role !== 'orchestrator' &&
				!targetsWithWork.has(name)
			) {
				continue;
			}
			previousSessions.push({
				name: info.name,
				role: info.role,
				teamId: info.teamId,
				runtimeType: info.runtimeType,
				hasResumeId: info.runtimeType === RUNTIME_TYPES.CLAUDE_CODE,
			});
		}

		res.json({ success: true, data: { sessions: previousSessions } });
	} catch (error) {
		logger.error('Failed to get previous sessions', {
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).json({
			success: false,
			error: 'Failed to get previous sessions',
		});
	}
}

/**
 * Dismiss previous sessions by clearing persisted state.
 *
 * Clears both in-memory metadata and the state file so the resume
 * popup won't appear again until new sessions are created and stopped.
 *
 * @route POST /api/sessions/previous/dismiss
 * @returns {object} JSON response confirming dismissal
 */
export async function dismissPreviousSessions(
	this: unknown,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const persistence = getSessionStatePersistence();
		await persistence.clearStateAndMetadata();

		logger.info('Dismissed previous sessions');
		res.json({ success: true });
	} catch (error) {
		logger.error('Failed to dismiss previous sessions', {
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).json({
			success: false,
			error: 'Failed to dismiss previous sessions',
		});
	}
}

/**
 * Submit an OAuth authorization code to a session.
 *
 * After an agent's OAuth token expires and /login is sent, the CLI outputs an
 * OAuth URL. The user visits the URL, gets an auth code, and sends it back via
 * this endpoint. The code is written to the agent's PTY session to complete
 * the re-authentication flow.
 *
 * @route POST /api/sessions/:name/oauth-callback
 * @param name - Session name
 * @body {code} - OAuth authorization code from the user
 * @returns {object} JSON response confirming code was submitted
 */
export async function submitOAuthCallback(
	this: unknown,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { name } = req.params;
		const { code } = req.body;

		if (!code || typeof code !== 'string') {
			res.status(400).json({ error: 'OAuth code is required and must be a string' });
			return;
		}

		// Validate session exists
		const backend = getSessionBackendSync();
		if (!backend || !backend.sessionExists(name)) {
			res.status(404).json({ error: `Session '${name}' not found` });
			return;
		}

		// Submit the code to the PTY session
		const success = OAuthReloginMonitorService.submitOAuthCode(name, code);

		if (!success) {
			res.status(500).json({ error: 'Failed to write OAuth code to session' });
			return;
		}

		logger.info('OAuth code submitted to session', { sessionName: name });
		res.json({ success: true, message: `OAuth code submitted to session '${name}'` });
	} catch (error) {
		logger.error('Failed to submit OAuth code', {
			name: req.params.name,
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).json({
			error: 'Failed to submit OAuth code',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
}
