/**
 * Agent Hooks Controller
 *
 * Receives Claude Code agent-status hook events from
 * `config/hooks/agent-status/report.sh` (#815). The hook sends only an event
 * name, a notification type and its session (X-Agent-Session); anything else
 * in the body is ignored and never stored or logged.
 *
 * @module controllers/agent-hooks/agent-hooks.controller
 */

import type { Request, Response } from 'express';
import { AGENT_STATUS_HOOK_CONSTANTS } from '../../constants.js';
import { recordHookEvent } from '../../services/monitoring/agent-hook-state.js';

/** Header the hook identifies its session with (same as the skills' lib.sh). */
const SESSION_HEADER = 'x-agent-session';

/**
 * POST /api/agent-hooks
 *
 * Validates the session header and the two identifier fields against fixed
 * allowlists, then records the signal.
 *
 * - 400 when the session header is missing or malformed, the event is not one
 *   the hook is registered for, or the notification type is unknown
 * - 202 with `{ recorded: boolean }` otherwise (false: the event says nothing
 *   about waiting, e.g. an idle prompt)
 *
 * @param req - Express request; body `{ event: string, notificationType?: string }`
 * @param res - Express response
 */
export function receiveAgentHook(req: Request, res: Response): void {
	const C = AGENT_STATUS_HOOK_CONSTANTS;
	const rawSession = req.headers[SESSION_HEADER];
	const sessionName = typeof rawSession === 'string' ? rawSession : '';
	if (!C.SESSION_NAME_PATTERN.test(sessionName)) {
		res.status(400).json({ success: false, error: 'missing or invalid X-Agent-Session' });
		return;
	}

	const body = (req.body ?? {}) as { event?: unknown; notificationType?: unknown };
	const event = typeof body.event === 'string' ? body.event : '';
	if (!(C.EVENTS as readonly string[]).includes(event)) {
		res.status(400).json({ success: false, error: 'unsupported event' });
		return;
	}

	let notificationType: string | undefined;
	if (body.notificationType !== undefined) {
		if (
			typeof body.notificationType !== 'string' ||
			!(C.KNOWN_NOTIFICATION_TYPES as readonly string[]).includes(body.notificationType)
		) {
			res.status(400).json({ success: false, error: 'unsupported notificationType' });
			return;
		}
		notificationType = body.notificationType;
	}

	const signal = recordHookEvent(sessionName, event, notificationType);
	res.status(202).json({ success: true, recorded: signal !== null });
}
