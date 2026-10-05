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
import { AGENT_STATUS_HOOK_CONSTANTS, CREDENTIAL_GUARD_CONSTANTS, TL_DELEGATION_CONSTANTS, TRACE_CONSTANTS, TURN_STATE_CONSTANTS } from '../../constants.js';
import { TlDelegationService } from '../../services/tl-delegation/tl-delegation.service.js';
import { CredentialGuardAlertService } from '../../services/monitoring/credential-guard-alerts.js';
import { recordHookEvent } from '../../services/monitoring/agent-hook-state.js';
import { AgentTurnStateService, type TurnHookIds } from '../../services/monitoring/agent-turn-state.js';
import { traceSubagentSendBack } from '../../services/trace/trace-recorder.js';
import { joinHookNotes, ownerHookNoteFor } from '../../services/messaging/owner-hook-message.js';
import { WindDownService } from '../../services/system/wind-down.service.js';

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
 * - `source` (SessionStart) must be startup / resume / clear / compact
 * - `SubagentSendBack` (from the subagent guard) is recorded in the session's
 *   run trace only; 202 with `recorded` = whether the session had a trace
 *
 * @param req - Express request; body `{ event: string, notificationType?: string, toolName?: string }`. A
 *   `PostToolUse` with `toolName` may answer `additionalContext`: the next owner message waiting in the
 *   agent's queue (main agent only — a PostToolUse with `agentId` is a subagent's tool call, whose
 *   context the agent never sees), then the team-lead nudge (crewly#1083); at most one owner message,
 *   total size capped
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

	const body = (req.body ?? {}) as { event?: unknown; notificationType?: unknown; toolUseId?: unknown; agentId?: unknown; source?: unknown; toolName?: unknown };
	const event = typeof body.event === 'string' ? body.event : '';
	// The subagent guard (#852) sent a no-op subagent back: a trace event only
	// (autonomy metrics, #984); it says nothing about waiting on a human.
	if (event === TRACE_CONSTANTS.SUBAGENT_SENDBACK_HOOK_EVENT) {
		res.status(202).json({ success: true, recorded: traceSubagentSendBack(sessionName) });
		return;
	}
	// The credential guard blocked this agent (specs/2026-10-04-agent-credential-
	// isolation.md, layer 4): a WARN, and the owner hears once per agent per day.
	// Only the rule id and runtime label are read; anything else is ignored.
	if (event === CREDENTIAL_GUARD_CONSTANTS.BLOCKED_EVENT) {
		const raw = req.body as { rule?: unknown; runtime?: unknown };
		const rule = typeof raw.rule === 'string' && CREDENTIAL_GUARD_CONSTANTS.RULE_PATTERN.test(raw.rule) ? raw.rule : null;
		if (!rule) {
			res.status(400).json({ success: false, error: 'invalid rule' });
			return;
		}
		const runtime = typeof raw.runtime === 'string' && CREDENTIAL_GUARD_CONSTANTS.RUNTIME_PATTERN.test(raw.runtime) ? raw.runtime : undefined;
		const outcome = CredentialGuardAlertService.getInstance().record({ sessionName, rule, runtime });
		res.status(202).json({ success: true, recorded: true, notified: outcome.notified });
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
	if (body.source !== undefined) {
		if (typeof body.source !== 'string' || !(TURN_STATE_CONSTANTS.SESSION_START_SOURCES as readonly string[]).includes(body.source)) {
			res.status(400).json({ success: false, error: 'invalid source' });
			return;
		}
		ids.source = body.source;
	}

	let toolName: string | undefined;
	if (body.toolName !== undefined) {
		if (typeof body.toolName !== 'string' || !TL_DELEGATION_CONSTANTS.TOOL_NAME_PATTERN.test(body.toolName)) {
			res.status(400).json({ success: false, error: 'invalid toolName' });
			return;
		}
		toolName = body.toolName;
	}

	const signal = recordHookEvent(sessionName, event, notificationType);
	const turnChanged = AgentTurnStateService.getInstance().recordHook(sessionName, event, ids);
	const recorded = signal !== null || turnChanged;
	// A PostToolUse with a tool name may come back with notes the hook hands
	// to Claude Code as additionalContext: an owner message waiting in the
	// queue (handed over at this tool boundary instead of at the end of the
	// turn) and the team-lead execution nudge (crewly#1083). Never blocks: no
	// note on any failure.
	if (event === 'PostToolUse' && toolName) {
		let ownerNote: string | null = null;
		if (!ids.agentId) {
			try {
				// A wind-down note (Crewly is shutting down / restarting) goes first.
				ownerNote = joinHookNotes([WindDownService.getInstance()?.noteForHook(sessionName), ownerHookNoteFor(sessionName)]);
			} catch {
				ownerNote = null;
			}
		}
		void TlDelegationService.getInstance()
			.observeToolUse(sessionName, toolName)
			.catch(() => null)
			.then((note) => {
				const additionalContext = joinHookNotes([ownerNote, note]);
				res.status(202).json({ success: true, recorded, ...(additionalContext ? { additionalContext } : {}) });
			});
		return;
	}
	res.status(202).json({ success: true, recorded });
}
