/**
 * Activity log API (crewly#881).
 *
 * - `GET /api/activity?actorType=&actorId=&action=&targetType=&targetId=&since=&until=&limit=`
 *   — owner only, read-only: entries of the append-only activity log, newest
 *   first. `action` is exact or a dotted prefix (`team.`); `since` / `until`
 *   are ISO timestamps or `YYYY-MM-DD` (until a bare date = end of that day).
 *
 * @module controllers/activity/activity.controller
 */
import type { Request, Response, Router } from 'express';
import { ACTIVITY_LOG_CONSTANTS } from '../../constants.js';
import { requireOwner } from '../../middleware/caller-identity.middleware.js';
import { getActivityLog, isActivityActorType, type ActivityLogService, type ActivityQuery } from '../../services/activity/activity-log.service.js';

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
	if (actorType !== undefined && !isActivityActorType(actorType)) return { error: `${Q.ACTOR_TYPE} must be owner, agent or system` };
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
 * Register the route.
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
}
