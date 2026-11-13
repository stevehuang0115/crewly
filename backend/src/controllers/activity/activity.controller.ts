/**
 * Activity log API (crewly#881).
 *
 * - `GET /api/activity?actorType=&actorId=&action=&targetType=&targetId=&since=&until=&limit=`
 *   — owner only, read-only: entries of the append-only activity log, newest
 *   first. `action` is exact or a dotted prefix (`team.`); `since` / `until`
 *   are ISO timestamps or `YYYY-MM-DD` (until a bare date = end of that day).
 * - `POST /api/activity/external` — owner credential only (the local API
 *   token): the Crewly ops sidecar on this machine reports one read it served
 *   to a Crewly admin, so the read shows in Settings › Activity. Nothing else
 *   can be written through it: the actor is always `support` via
 *   `ops-sidecar`, the action `ops.read` or `ops.refused`.
 *   `specs/2026-11-12-ops-sidecar-activity.md`.
 *
 * @module controllers/activity/activity.controller
 */
import type { Request, Response, Router } from 'express';
import { ACTIVITY_LOG_CONSTANTS, OPS_SIDECAR_CONSTANTS } from '../../constants.js';
import { requireOwner } from '../../middleware/caller-identity.middleware.js';
import { getActivityLog, isActivityActorType, type ActivityEntryInput, type ActivityLogService, type ActivityQuery } from '../../services/activity/activity-log.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse the query string of GET /api/activity.
 *
 * @param q - `req.query`
 * @returns The query, or an error message for a bad value
 */
export function parseActivityQuery(q: Record<string, unknown>): ActivityQuery | { error: string } {
	const Q = ACTIVITY_LOG_CONSTANTS.QUERY;
	const str = (key: string): string | undefined => {
		const v = q[key];
		return typeof v === 'string' && v.trim() ? v.trim() : undefined;
	};
	const date = (key: string, endOfDay: boolean): string | undefined | { error: string } => {
		const v = str(key);
		if (!v) return undefined;
		const ms = Date.parse(v);
		if (Number.isNaN(ms)) return { error: `${key} must be an ISO timestamp or YYYY-MM-DD` };
		return new Date(BARE_DATE.test(v) && endOfDay ? ms + DAY_MS - 1 : ms).toISOString();
	};
	const actorType = str(Q.ACTOR_TYPE);
	if (actorType !== undefined && !isActivityActorType(actorType)) return { error: `${Q.ACTOR_TYPE} must be owner, agent, system or support` };
	const since = date(Q.SINCE, false);
	if (since && typeof since === 'object') return since;
	const until = date(Q.UNTIL, true);
	if (until && typeof until === 'object') return until;
	let limit: number | undefined;
	const rawLimit = str(Q.LIMIT);
	if (rawLimit !== undefined) {
		limit = Number(rawLimit);
		if (!Number.isInteger(limit) || limit < 1) return { error: `${Q.LIMIT} must be a positive integer` };
		limit = Math.min(limit, ACTIVITY_LOG_CONSTANTS.MAX_LIMIT);
	}
	return {
		...(actorType ? { actorType } : {}),
		...(str(Q.ACTOR_ID) ? { actorId: str(Q.ACTOR_ID) } : {}),
		...(str(Q.ACTION) ? { action: str(Q.ACTION) } : {}),
		...(str(Q.TARGET_TYPE) ? { targetType: str(Q.TARGET_TYPE) } : {}),
		...(str(Q.TARGET_ID) ? { targetId: str(Q.TARGET_ID) } : {}),
		...(since ? { since } : {}),
		...(until ? { until } : {}),
		...(limit !== undefined ? { limit } : {}),
	};
}

/**
 * Read the body of POST /api/activity/external into a log entry.
 *
 * Only the fixed shape of a sidecar read is accepted; the actor type, `via`
 * and target type are set here, not taken from the body, so the route cannot
 * write an entry that reads as the owner's, an agent's or Crewly's own.
 *
 * @param body - `req.body`
 * @returns The entry to record, or an error message for a bad value
 *
 * @example
 * ```typescript
 * parseExternalActivity({ actor: { id: 'ops@crewlyai.com' }, action: 'ops.read', target: { id: '/agents' } });
 * ```
 */
export function parseExternalActivity(body: unknown): ActivityEntryInput | { error: string } {
	const O = OPS_SIDECAR_CONSTANTS;
	const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
	const text = (v: unknown, max: number): string | undefined => {
		if (typeof v !== 'string') return undefined;
		const t = v.trim();
		return t && t.length <= max ? t : undefined;
	};
	const b = rec(body);
	const actor = rec(b.actor);
	const target = rec(b.target);
	const after = rec(b.after);

	if (actor.type !== undefined && actor.type !== 'support') return { error: 'actor.type must be support' };
	if (actor.via !== undefined && actor.via !== O.ACTOR_VIA) return { error: `actor.via must be ${O.ACTOR_VIA}` };
	const actorId = text(actor.id, O.MAX_ACTOR_ID_CHARS);
	if (!actorId) return { error: `actor.id must be a non-empty string of at most ${O.MAX_ACTOR_ID_CHARS} characters` };
	if (typeof b.action !== 'string' || !O.ACTIONS.includes(b.action)) return { error: `action must be one of ${O.ACTIONS.join(', ')}` };
	if (target.type !== undefined && target.type !== O.TARGET_TYPE) return { error: `target.type must be ${O.TARGET_TYPE}` };
	const targetId = text(target.id, O.MAX_TARGET_ID_CHARS);
	if (!targetId) return { error: `target.id must be a non-empty string of at most ${O.MAX_TARGET_ID_CHARS} characters` };
	if (b.note !== undefined && typeof b.note !== 'string') return { error: 'note must be a string' };

	const agent = text(after.agent, O.MAX_AGENT_CHARS);
	const status = typeof after.status === 'number' && Number.isInteger(after.status) && after.status >= 100 && after.status <= 599 ? after.status : undefined;
	const note = typeof b.note === 'string' ? b.note.trim().slice(0, O.MAX_NOTE_CHARS) : '';
	return {
		actor: { type: 'support', id: actorId, via: O.ACTOR_VIA },
		action: b.action,
		target: { type: O.TARGET_TYPE, id: targetId },
		...(agent !== undefined || status !== undefined ? { after: { ...(agent !== undefined ? { agent } : {}), ...(status !== undefined ? { status } : {}) } } : {}),
		...(note ? { note } : {}),
	};
}

/**
 * Register the routes.
 *
 * @param router - API router (mounted at `/api`)
 * @param log - The log to read (tests inject one)
 */
export function registerActivityRoutes(router: Router, log: () => ActivityLogService = getActivityLog): void {
	router.get('/activity', requireOwner, async (req: Request, res: Response) => {
		const query = parseActivityQuery(req.query as Record<string, unknown>);
		if ('error' in query) {
			res.status(400).json({ success: false, error: query.error });
			return;
		}
		try {
			const entries = await log().list(query);
			res.json({ success: true, data: { count: entries.length, limit: query.limit ?? ACTIVITY_LOG_CONSTANTS.DEFAULT_LIMIT, entries } });
		} catch (err) {
			res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
		}
	});

	router.post(OPS_SIDECAR_CONSTANTS.ACTIVITY_ROUTE, requireOwner, (req: Request, res: Response) => {
		const input = parseExternalActivity(req.body);
		if ('error' in input) {
			res.status(400).json({ success: false, error: input.error });
			return;
		}
		const entry = log().record(input);
		res.status(201).json({ success: true, data: { id: entry.id } });
	});
}
