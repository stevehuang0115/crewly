/**
 * Run traces API (specs/2026-10-03-run-traces.md, issue #983).
 *
 * - `GET  /api/traces?since=<ISO>&type=<rootKind>&limit=&metrics=0|1&autopilotProject=&day=&label=` — traces, most
 *   recently active first, each with a metrics summary unless `metrics=0` (#984; then at most METRICS_LIST_MAX rows);
 *   the tag filters select autopilot runs and labelled tickets (specs/2026-10-03-autopilot-experiments.md)
 * - `GET  /api/traces/by-ref?workItemId=|ticketId=|requestId=|decisionId=|experimentId=` — the trace of an entity
 * - `GET  /api/traces/:id?offset=&limit=` — `{ root, events, total, offset, limit, truncated }`
 * - `GET  /api/traces/:id/metrics?stallMinutes=` — autonomy metrics (#984)
 * - `GET  /api/traces/:id/timeline?stallMinutes=` — events grouped by turn and agent, with stalls (#984)
 * - `GET  /api/traces/:id/summary?maxChars=&stallMinutes=` — the compact text `trace-read` prints (#984)
 * - `POST /api/traces` `{ kind: 'goal'|'experiment', summary, refs? }` — start a goal / experiment root
 *
 * @module controllers/trace/trace.controller
 */

import { Router, type Request, type Response } from 'express';
import { TRACE_CONSTANTS } from '../../constants.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { getTraceStore } from '../../services/trace/trace-store.js';
import { startGoalTrace } from '../../services/trace/trace-recorder.js';
import { getTraceAnalysis } from '../../services/trace/trace-analysis.service.js';
import { isOwnerCaller, ownerAuthRequiredBody } from '../../middleware/caller-identity.middleware.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { isTraceId, isTraceRootKind, TRACE_ROOT_KINDS, type TraceIndexEntry, type TraceRefKind, type TraceRefs } from '../../services/trace/trace.types.js';

/** Query parameter → index ref kind, in lookup order. */
const REF_PARAMS: ReadonlyArray<[string, TraceRefKind]> = [
	['workItemId', 'workItem'],
	['ticketId', 'ticket'],
	['requestId', 'request'],
	['decisionId', 'decision'],
	['experimentId', 'experiment'],
];

/**
 * A query value as a trimmed string.
 *
 * @param value - Raw query value
 * @returns String, or undefined
 */
function queryString(value: unknown): string | undefined {
	const v = Array.isArray(value) ? value[0] : value;
	return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * A query value as a non-negative integer.
 *
 * @param value - Raw query value
 * @param fallback - Default
 * @returns The integer
 */
function queryInt(value: unknown, fallback: number): number {
	const s = queryString(value);
	if (!s || !/^\d+$/.test(s)) return fallback;
	return Number(s);
}

/**
 * `?stallMinutes=` as a positive number.
 *
 * @param value - Raw query value
 * @returns Minutes, undefined when absent, or null when malformed
 */
function queryStallMinutes(value: unknown): number | undefined | null {
	const s = queryString(value);
	if (!s) return undefined;
	const n = Number(s);
	return /^\d+(\.\d+)?$/.test(s) && n > 0 ? n : null;
}

/** A caller of the traces API: `{}` = the owner, `{ session }` = an agent. */
type TraceCaller = { session?: string };

/**
 * Who is calling, without answering: `{}` for an owner credential,
 * `{ session }` for an agent, null for neither.
 *
 * @param req - Request
 * @returns Caller or null
 */
function callerOf(req: Request): TraceCaller | null {
	if (isOwnerCaller(req)) return {};
	const session = readAgentSessionHeader(req);
	return session ? { session } : null;
}

/**
 * Who is calling; answers 401 itself for neither an owner nor an agent.
 *
 * @param req - Request
 * @param res - Response
 * @returns Caller, or null when a 401 was sent
 */
function callerOrDeny(req: Request, res: Response): TraceCaller | null {
	const caller = callerOf(req);
	if (!caller) res.status(401).json(ownerAuthRequiredBody(req));
	return caller;
}

/**
 * Whether a caller may read a project's autopilot traces: the owner and the
 * orchestrator always (no project lookup, so a deleted or renamed project's
 * traces stay readable), else anyone on a team that works on the project —
 * the rule decision cards use for tickets (specs/2026-10-03-autopilot-experiments.md).
 *
 * @param caller - Caller
 * @param projectId - Tagged project
 * @param cache - Per-request results by project
 * @returns True when allowed
 */
async function mayReadProject(caller: TraceCaller, projectId: string, cache?: Map<string, boolean>): Promise<boolean> {
	if (!caller.session || caller.session === ORCHESTRATOR_SESSION_NAME) return true;
	const hit = cache?.get(projectId);
	if (hit !== undefined) return hit;
	let ok = false;
	try {
		const { ticketAutopilot } = await import('../project-tickets/project-tickets.controller.js');
		ok = await ticketAutopilot().canReadProjectTraces(projectId, caller);
	} catch {
		ok = false;
	}
	cache?.set(projectId, ok);
	return ok;
}

/**
 * Whether an agent took part in a trace (its actor, the session an event is
 * about, or the root's actor): the ticket's assignee, the agents of a reused
 * Request trace.
 *
 * @param session - Agent session
 * @param traceId - Trace
 * @returns True when it appears in the trace
 */
async function tookPart(session: string, traceId: string): Promise<boolean> {
	const full = await getTraceStore().readAll(traceId);
	if (!full) return false;
	if (full.root.actor.session === session) return true;
	return full.events.some((e) => e.actor.session === session || e.refs.session === session);
}

/**
 * Whether a caller may read one trace. Untagged traces: everyone, as before.
 * Autopilot-tagged traces: the owner, the orchestrator, members of the
 * project's teams, and any agent that took part in the trace.
 *
 * @param caller - Caller (null = no credential)
 * @param entry - Index entry
 * @param cache - Per-request project results
 * @returns True when allowed
 */
async function mayReadTrace(caller: TraceCaller | null, entry: TraceIndexEntry, cache?: Map<string, boolean>): Promise<boolean> {
	const projectId = entry.tags?.autopilot?.projectId;
	if (!projectId) return true;
	if (!caller) return false;
	if (await mayReadProject(caller, projectId, cache)) return true;
	return !!caller.session && (await tookPart(caller.session, entry.traceId));
}

/**
 * The gate of `/api/traces/:id…`: answers 401 / 403 itself.
 *
 * @param req - Request
 * @param res - Response
 * @param id - Trace id
 * @returns True when the caller may read it (or it is not an autopilot trace)
 */
async function allowTraceRead(req: Request, res: Response, id: string): Promise<boolean> {
	const entry = getTraceStore().getEntry(id);
	if (!entry?.tags?.autopilot) return true;
	const caller = callerOrDeny(req, res);
	if (!caller) return false;
	if (await mayReadTrace(caller, entry)) return true;
	res.status(403).json({ success: false, error: 'This autopilot trace belongs to a project you do not work on' });
	return false;
}

/**
 * GET /api/traces
 *
 * @param req - Query: since (ISO), type (root kind), limit, metrics (0 to leave them out), stallMinutes
 * @param res - `{ success, data: { traces, writeFailures } }`
 */
export async function listTraces(req: Request, res: Response): Promise<void> {
	const sinceRaw = queryString(req.query.since);
	const since = sinceRaw ? new Date(sinceRaw) : undefined;
	if (since && Number.isNaN(since.getTime())) {
		res.status(400).json({ success: false, error: 'since must be an ISO date' });
		return;
	}
	const type = queryString(req.query.type);
	if (type && !isTraceRootKind(type)) {
		res.status(400).json({ success: false, error: `type must be one of ${TRACE_ROOT_KINDS.join(', ')}` });
		return;
	}
	const day = queryString(req.query.day);
	if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
		res.status(400).json({ success: false, error: 'day must be a date YYYY-MM-DD' });
		return;
	}
	const autopilotProjectId = queryString(req.query.autopilotProject);
	const label = queryString(req.query.label);
	const caller = callerOf(req);
	const projects = new Map<string, boolean>();
	if (autopilotProjectId) {
		if (!callerOrDeny(req, res)) return;
		if (!(await mayReadProject(caller as TraceCaller, autopilotProjectId, projects))) {
			res.status(403).json({ success: false, error: 'Only the owner, the orchestrator or a member of the project can read its autopilot traces' });
			return;
		}
	} else if (label || day) {
		// Tag filters across projects: the owner or the orchestrator only.
		if (!callerOrDeny(req, res)) return;
		if (caller?.session && caller.session !== ORCHESTRATOR_SESSION_NAME) {
			res.status(403).json({ success: false, error: 'Filtering by label or day across projects is for the owner or the orchestrator; add autopilotProject' });
			return;
		}
	}
	const stallMinutes = queryStallMinutes(req.query.stallMinutes);
	if (stallMinutes === null) {
		res.status(400).json({ success: false, error: 'stallMinutes must be a positive number' });
		return;
	}
	const store = getTraceStore();
	const withMetrics = queryString(req.query.metrics) !== '0';
	const requested = queryInt(req.query.limit, TRACE_CONSTANTS.DEFAULT_LIST_LIMIT);
	const entries = store.list({
		...(since ? { since } : {}),
		...(type && isTraceRootKind(type) ? { rootKind: type } : {}),
		...(autopilotProjectId ? { autopilotProjectId } : {}),
		...(day ? { day } : {}),
		...(label ? { label } : {}),
		// Each row with metrics may read a whole trace file: cap those lists.
		limit: withMetrics ? Math.min(requested, TRACE_CONSTANTS.METRICS_LIST_MAX) : requested,
	});
	// Autopilot-tagged rows the caller may not read are left out; untagged rows are unchanged.
	const visible: typeof entries = [];
	for (const entry of entries) if (await mayReadTrace(caller, entry, projects)) visible.push(entry);
	const traces = withMetrics ? await getTraceAnalysis().withMetrics(visible, stallMinutes) : visible;
	// writeFailures: trace writes lost since the backend started (disk full, permissions).
	res.json({ success: true, data: { traces, writeFailures: store.writeFailures } });
}

/**
 * Validate `:id` and `?stallMinutes=`; answers 400 itself.
 *
 * @param req - Request
 * @param res - Response
 * @returns The id and minutes, or null when a 400 was sent
 */
function analysisParams(req: Request, res: Response): { id: string; stallMinutes?: number } | null {
	const id = req.params.id;
	if (!isTraceId(id)) {
		res.status(400).json({ success: false, error: 'Not a trace id (tr-YYYYMMDD-xxxxxxxx)' });
		return null;
	}
	const stallMinutes = queryStallMinutes(req.query.stallMinutes);
	if (stallMinutes === null) {
		res.status(400).json({ success: false, error: 'stallMinutes must be a positive number' });
		return null;
	}
	return { id, ...(stallMinutes !== undefined ? { stallMinutes } : {}) };
}

/**
 * GET /api/traces/:id/metrics
 *
 * @param req - Params: id; query: stallMinutes
 * @param res - `{ success, data: TraceMetrics }`
 */
export async function getTraceMetrics(req: Request, res: Response): Promise<void> {
	const p = analysisParams(req, res);
	if (!p) return;
	if (!(await allowTraceRead(req, res, p.id))) return;
	const metrics = await getTraceAnalysis().metrics(p.id, p.stallMinutes);
	if (!metrics) {
		res.status(404).json({ success: false, error: `Trace ${p.id} not found` });
		return;
	}
	res.json({ success: true, data: metrics });
}

/**
 * GET /api/traces/:id/timeline
 *
 * @param req - Params: id; query: stallMinutes
 * @param res - `{ success, data: { root, metrics, groups, truncated } }`
 */
export async function getTraceTimeline(req: Request, res: Response): Promise<void> {
	const p = analysisParams(req, res);
	if (!p) return;
	if (!(await allowTraceRead(req, res, p.id))) return;
	const timeline = await getTraceAnalysis().timeline(p.id, p.stallMinutes);
	if (!timeline) {
		res.status(404).json({ success: false, error: `Trace ${p.id} not found` });
		return;
	}
	res.json({ success: true, data: timeline });
}

/**
 * GET /api/traces/:id/summary
 *
 * @param req - Params: id; query: maxChars, stallMinutes
 * @param res - `{ success, data: { traceId, text, links, metrics } }`
 */
export async function getTraceSummary(req: Request, res: Response): Promise<void> {
	const p = analysisParams(req, res);
	if (!p) return;
	if (!(await allowTraceRead(req, res, p.id))) return;
	const maxChars = queryInt(req.query.maxChars, TRACE_CONSTANTS.READ_DEFAULT_CHARS);
	const summary = await getTraceAnalysis().summary(p.id, maxChars, p.stallMinutes);
	if (!summary) {
		res.status(404).json({ success: false, error: `Trace ${p.id} not found` });
		return;
	}
	res.json({ success: true, data: summary });
}

/**
 * GET /api/traces/by-ref
 *
 * @param req - Query: one of workItemId, ticketId, requestId, decisionId, experimentId
 * @param res - `{ success, data: { traceId, root } }`, 400 without a ref, 404 when unknown
 */
export async function traceByRef(req: Request, res: Response): Promise<void> {
	const store = getTraceStore();
	let asked = false;
	for (const [param, kind] of REF_PARAMS) {
		const id = queryString(req.query[param]);
		if (!id) continue;
		asked = true;
		const traceId = store.traceByRef(kind, id);
		const entry = traceId ? store.getEntry(traceId) : null;
		if (entry) {
			// An autopilot trace the caller may not read: the id only (reading it is gated), no summary.
			const root = (await mayReadTrace(callerOf(req), entry)) ? entry.root : { ...entry.root, summary: '' };
			res.json({ success: true, data: { traceId: entry.traceId, root } });
			return;
		}
	}
	if (!asked) {
		res.status(400).json({ success: false, error: 'Pass one of workItemId, ticketId, requestId, decisionId, experimentId' });
		return;
	}
	res.status(404).json({ success: false, error: 'No trace for that reference (only work started after traces were enabled has one)' });
}

/**
 * GET /api/traces/:id
 *
 * @param req - Params: id; query: offset, limit
 * @param res - `{ success, data: { root, events, total, offset, limit, truncated } }`
 */
export async function getTrace(req: Request, res: Response): Promise<void> {
	const id = req.params.id;
	if (!isTraceId(id)) {
		res.status(400).json({ success: false, error: 'Not a trace id (tr-YYYYMMDD-xxxxxxxx)' });
		return;
	}
	if (!(await allowTraceRead(req, res, id))) return;
	const page = await getTraceStore().read(
		id,
		queryInt(req.query.offset, 0),
		queryInt(req.query.limit, TRACE_CONSTANTS.DEFAULT_PAGE_SIZE),
	);
	if (!page) {
		res.status(404).json({ success: false, error: `Trace ${id} not found` });
		return;
	}
	res.json({ success: true, data: page });
}

/**
 * POST /api/traces — start a goal or experiment trace. An agent caller's turn
 * is bound to it.
 *
 * @param req - Body: kind ('goal' | 'experiment'), summary, refs?
 * @param res - 201 `{ success, data: { traceId } }`
 */
export function startTrace(req: Request, res: Response): void {
	const body = (req.body ?? {}) as { kind?: unknown; summary?: unknown; refs?: unknown };
	if (body.kind !== 'goal' && body.kind !== 'experiment') {
		res.status(400).json({ success: false, error: "kind must be 'goal' or 'experiment'" });
		return;
	}
	if (typeof body.summary !== 'string' || body.summary.trim().length === 0) {
		res.status(400).json({ success: false, error: 'summary is required' });
		return;
	}
	const refs: TraceRefs = {};
	if (body.refs && typeof body.refs === 'object') {
		for (const key of ['requestId', 'ticketId', 'workItemId', 'messageId', 'decisionId', 'experimentId'] as const) {
			const v = (body.refs as Record<string, unknown>)[key];
			if (typeof v === 'string' && v.length > 0) refs[key] = v;
		}
	}
	const session = readAgentSessionHeader(req);
	const traceId = startGoalTrace({ kind: body.kind, summary: body.summary, refs, ...(session ? { session } : {}) });
	if (!traceId) {
		res.status(500).json({ success: false, error: 'The trace could not be started' });
		return;
	}
	res.status(201).json({ success: true, data: { traceId } });
}

/**
 * Router for `/api/traces`.
 *
 * @returns Express router
 */
export function createTraceRouter(): Router {
	const router = Router();
	router.get('/', (req, res, next) => {
		listTraces(req, res).catch(next);
	});
	router.get('/by-ref', traceByRef);
	router.post('/', startTrace);
	router.get('/:id/metrics', (req, res, next) => {
		getTraceMetrics(req, res).catch(next);
	});
	router.get('/:id/timeline', (req, res, next) => {
		getTraceTimeline(req, res).catch(next);
	});
	router.get('/:id/summary', (req, res, next) => {
		getTraceSummary(req, res).catch(next);
	});
	router.get('/:id', (req, res, next) => {
		getTrace(req, res).catch(next);
	});
	return router;
}
