/**
 * Agent Hooks Controller
 *
 * Receives Claude Code agent-status hook events from
 * `config/hooks/agent-status/report.sh` (#815). The hook sends only an event
 * name, a notification type, a tool-use id, a subagent id and its session
 * (X-Agent-Session); anything else in the body is ignored and never stored
 * or logged. Events feed both the waiting-on-human signal and the runtime
 * turn state (specs/2026-10-02-restart-busy-and-resume.md).
 *
 * @module controllers/agent-hooks/agent-hooks.controller
 */

import type { Request, Response } from 'express';
import { AGENT_STATUS_HOOK_CONSTANTS, TRACE_CONSTANTS, TURN_STATE_CONSTANTS } from '../../constants.js';
import { recordHookEvent } from '../../services/monitoring/agent-hook-state.js';
import { AgentTurnStateService, type TurnHookIds } from '../../services/monitoring/agent-turn-state.js';
import { traceSubagentSendBack } from '../../services/trace/trace-recorder.js';

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
 *   about waiting or turns, e.g. an idle prompt)
 * - `toolUseId` / `agentId` are optional; anything but a plain identifier is a 400
 * - `SubagentSendBack` (from the subagent guard) is recorded in the session's
 *   run trace only; 202 with `recorded` = whether the session had a trace
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

	const body = (req.body ?? {}) as { event?: unknown; notificationType?: unknown; toolUseId?: unknown; agentId?: unknown };
	const event = typeof body.event === 'string' ? body.event : '';
	// The subagent guard (#852) sent a no-op subagent back: a trace event only
	// (autonomy metrics, #984); it says nothing about waiting on a human.
	if (event === TRACE_CONSTANTS.SUBAGENT_SENDBACK_HOOK_EVENT) {
		res.status(202).json({ success: true, recorded: traceSubagentSendBack(sessionName) });
		return;
	}
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

	const ids: TurnHookIds = {};
	for (const key of ['toolUseId', 'agentId'] as const) {
		const value = body[key];
		if (value === undefined) continue;
		if (typeof value !== 'string' || !TURN_STATE_CONSTANTS.ID_PATTERN.test(value)) {
			res.status(400).json({ success: false, error: `invalid ${key}` });
			return;
		}
		ids[key] = value;
	}

	const signal = recordHookEvent(sessionName, event, notificationType);
	const turnChanged = AgentTurnStateService.getInstance().recordHook(sessionName, event, ids);
	res.status(202).json({ success: true, recorded: signal !== null || turnChanged });
}
