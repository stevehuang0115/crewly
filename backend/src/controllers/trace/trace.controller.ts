/**
 * Run traces API (specs/2026-10-03-run-traces.md, issue #983).
 *
 * - `GET  /api/traces?since=<ISO>&type=<rootKind>&limit=` — traces, most recently active first
 * - `GET  /api/traces/by-ref?workItemId=|ticketId=|requestId=|decisionId=|experimentId=` — the trace of an entity
 * - `GET  /api/traces/:id?offset=&limit=` — `{ root, events, total, offset, limit, truncated }`
 * - `POST /api/traces` `{ kind: 'goal'|'experiment', summary, refs? }` — start a goal / experiment root
 *
 * @module controllers/trace/trace.controller
 */

import { Router, type Request, type Response } from 'express';
import { TRACE_CONSTANTS } from '../../constants.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { getTraceStore } from '../../services/trace/trace-store.js';
import { startGoalTrace } from '../../services/trace/trace-recorder.js';
import { isTraceId, isTraceRootKind, type TraceRefKind, type TraceRefs } from '../../services/trace/trace.types.js';

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
 * GET /api/traces
 *
 * @param req - Query: since (ISO), type (root kind), limit
 * @param res - `{ success, data: { traces, writeFailures } }`
 */
export function listTraces(req: Request, res: Response): void {
	const sinceRaw = queryString(req.query.since);
	const since = sinceRaw ? new Date(sinceRaw) : undefined;
	if (since && Number.isNaN(since.getTime())) {
		res.status(400).json({ success: false, error: 'since must be an ISO date' });
		return;
	}
	const type = queryString(req.query.type);
	if (type && !isTraceRootKind(type)) {
		res.status(400).json({ success: false, error: 'type must be one of request, goal, experiment, owner_message' });
		return;
	}
	const store = getTraceStore();
	const traces = store.list({
		...(since ? { since } : {}),
		...(type && isTraceRootKind(type) ? { rootKind: type } : {}),
		limit: queryInt(req.query.limit, TRACE_CONSTANTS.DEFAULT_LIST_LIMIT),
	});
	// writeFailures: trace writes lost since the backend started (disk full, permissions).
	res.json({ success: true, data: { traces, writeFailures: store.writeFailures } });
}

/**
 * GET /api/traces/by-ref
 *
 * @param req - Query: one of workItemId, ticketId, requestId, decisionId, experimentId
 * @param res - `{ success, data: { traceId, root } }`, 400 without a ref, 404 when unknown
 */
export function traceByRef(req: Request, res: Response): void {
	const store = getTraceStore();
	let asked = false;
	for (const [param, kind] of REF_PARAMS) {
		const id = queryString(req.query[param]);
		if (!id) continue;
		asked = true;
		const traceId = store.traceByRef(kind, id);
		const entry = traceId ? store.getEntry(traceId) : null;
		if (entry) {
			res.json({ success: true, data: { traceId: entry.traceId, root: entry.root } });
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
	router.get('/', listTraces);
	router.get('/by-ref', traceByRef);
	router.post('/', startTrace);
	router.get('/:id', (req, res, next) => {
		getTrace(req, res).catch(next);
	});
	return router;
}
