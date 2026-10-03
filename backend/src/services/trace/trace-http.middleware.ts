/**
 * Run trace HTTP middleware (mounted first in `createApiRoutes`).
 *
 * - **Skill calls.** Skills call the backend with `X-Agent-Session`. When that
 *   session's turn has a trace, the call is recorded on `finish`:
 *   `skill.call` (2xx/3xx), `guard.block` (403/409/423/429) or `error`
 *   (other 4xx/5xx), with `refs.skill = "<METHOD> <path>"` and the response's
 *   `error` text. No skill sends anything extra.
 * - **Agent → agent.** A message-mode write to `/terminal/:to/write|deliver`
 *   from an agent session gets the sender's `[TRACE:…]` appended, so the
 *   receiving turn joins the trace however the message is queued. The marker
 *   is skipped when it would push the text over the terminal input limit.
 * - **Activity.** Every agent call keeps the session's trace from ending on
 *   the idle gap.
 * - **Owner actions** (#984). A dashboard write (`X-Crewly-Caller: dashboard`,
 *   no agent session; POST/PUT/PATCH/DELETE that succeeded) whose path names
 *   an entity of a trace is recorded there as `owner.action` — a manual
 *   intervention in the autonomy metrics.
 *
 * Never fails a request: every step is wrapped.
 *
 * specs/2026-10-03-run-traces.md
 *
 * @module services/trace/trace-http.middleware
 */

import type { NextFunction, Request, Response } from 'express';
import { TRACE_CONSTANTS } from '../../constants.js';
import { isOwnerDashboardRequest, readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { getTraceContext } from './trace-context.service.js';
import { skillLabel } from './trace-markers.js';
import { carryAgentMessageTrace, traceOwnerAction } from './trace-recorder.js';
import type { TraceEventType, TraceOutcome } from './trace.types.js';

/** `/terminal/<session>/write|deliver` relative to /api. */
const TERMINAL_MESSAGE_PATH = /^\/terminal\/([^/]+)\/(write|deliver)\/?$/;

/**
 * Path of the request relative to `/api` (works mounted at `/api` or below).
 *
 * @param req - Request
 * @returns e.g. `/task-pool/add`
 */
function apiPath(req: Request): string {
	const full = (req.originalUrl || req.url || '').split('?')[0];
	const idx = full.indexOf('/api/');
	return idx >= 0 ? full.slice(idx + '/api'.length) : full;
}

/**
 * Append the sender's trace to an agent → agent message body.
 *
 * @param req - Request (body mutated)
 * @param sender - Calling agent session
 * @param path - Path relative to /api
 */
function carryAgentMessage(req: Request, sender: string, path: string): void {
	if (req.method !== 'POST') return;
	const m = TERMINAL_MESSAGE_PATH.exec(path);
	if (!m) return;
	const target = decodeURIComponent(m[1]);
	const body = req.body as Record<string, unknown> | undefined;
	if (!body || typeof body !== 'object') return;
	if (m[2] === 'write') {
		if (body.mode !== 'message' || typeof body.data !== 'string') return;
		body.data = carryAgentMessageTrace(sender, target, body.data);
	} else if (typeof body.message === 'string') {
		body.message = carryAgentMessageTrace(sender, target, body.message);
	}
}

/**
 * Event type and outcome for a response status.
 *
 * @param status - HTTP status
 * @returns Type and outcome
 */
export function classifySkillStatus(status: number): { type: TraceEventType; outcome: TraceOutcome } {
	if (status < 400) return { type: 'skill.call', outcome: status === 202 ? 'queued' : 'ok' };
	if ((TRACE_CONSTANTS.GUARD_BLOCK_STATUSES as readonly number[]).includes(status)) return { type: 'guard.block', outcome: 'blocked' };
	return { type: 'error', outcome: 'failed' };
}

/** Methods that change something. */
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Record a successful dashboard write on a traced entity as `owner.action`.
 *
 * @param req - Request (no agent session)
 * @param res - Response
 */
function watchOwnerAction(req: Request, res: Response): void {
	if (!WRITE_METHODS.has(req.method.toUpperCase()) || !isOwnerDashboardRequest(req)) return;
	const path = apiPath(req);
	if (TRACE_CONSTANTS.SKIPPED_SKILL_PATH_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return;
	res.once('finish', () => {
		try {
			if (res.statusCode >= 400) return;
			traceOwnerAction({ method: req.method, path, status: res.statusCode });
		} catch {
			// Recording is best-effort.
		}
	});
}

/**
 * Express middleware; see the module doc.
 *
 * @param req - Request
 * @param res - Response
 * @param next - Next handler
 */
export function traceHttpMiddleware(req: Request, res: Response, next: NextFunction): void {
	try {
		const session = readAgentSessionHeader(req);
		if (!session) {
			watchOwnerAction(req, res);
			next();
			return;
		}
		const path = apiPath(req);
		// Any agent API call (hooks included) shows the session is still working,
		// which keeps its current trace from ending on the idle gap.
		getTraceContext().touch(session);
		carryAgentMessage(req, session, path);
		if (TRACE_CONSTANTS.SKIPPED_SKILL_PATH_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
			next();
			return;
		}
		const ctx = getTraceContext();
		const skill = skillLabel(req.method, path);
		let errorText: string | undefined;
		const originalJson = res.json.bind(res);
		res.json = ((body: unknown) => {
			try {
				const err = (body as { error?: unknown } | null)?.error;
				if (typeof err === 'string') errorText = err;
			} catch {
				// Reading the body is best-effort.
			}
			return originalJson(body);
		}) as Response['json'];
		const startedAt = Date.now();
		res.once('finish', () => {
			try {
				// Looked up at the end: the call itself may have started the trace
				// (a delegation materialises a pending owner-message root).
				const traceId = ctx.currentTrace(session);
				if (!traceId) return;
				const { type, outcome } = classifySkillStatus(res.statusCode);
				ctx.record({
					traceId,
					type,
					actor: { kind: 'agent', session },
					summary: type === 'skill.call' ? `${session} called ${skill}` : `${session} ${type === 'guard.block' ? 'was refused' : 'failed'} ${skill}: ${errorText ?? `HTTP ${res.statusCode}`}`,
					outcome,
					refs: { skill, session },
					data: { status: res.statusCode, ms: Date.now() - startedAt },
				});
			} catch {
				// Recording is best-effort.
			}
		});
	} catch {
		// Tracing never fails a request.
	}
	next();
}
