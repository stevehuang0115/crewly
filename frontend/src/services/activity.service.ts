/**
 * Activity log API client (`GET /api/activity`, issue #881,
 * specs/2026-10-25-activity-log.md §Reader).
 *
 * The log answers "who changed this and when": every entry names an actor
 * (owner / agent / system), an action, a target and the changed fields.
 * Calls from the dashboard carry the owner's session, so the backend lets
 * them through; an agent is refused.
 *
 * @module services/activity.service
 */

/** Base path of the activity API. */
export const ACTIVITY_API_BASE = '/api/activity';

/** Who did it. */
export type ActivityActorType = 'owner' | 'agent' | 'system';

/** The actor of one entry. */
export interface ActivityActor {
  type: ActivityActorType;
  /** Agent session, Slack user id, scheduler name… */
  id?: string;
  /** How the actor was recognised (dashboard session, api-token, slack-button…) */
  via?: string;
}

/** What one entry acted on. */
export interface ActivityTarget {
  type: string;
  id: string;
  name?: string;
}

/** One line of the log. */
export interface ActivityEntry {
  id: string;
  /** ISO timestamp */
  ts: string;
  actor: ActivityActor;
  /** Dotted action name, e.g. `team.member.updated` */
  action: string;
  target: ActivityTarget;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  requestId?: string;
  workItemId?: string;
  note?: string;
}

/** Filters of a read; every field optional. */
export interface ActivityQuery {
  actorType?: ActivityActorType | '';
  actorId?: string;
  /** Exact action or dotted prefix (`team.`) */
  action?: string;
  targetType?: string;
  targetId?: string;
  /** ISO timestamp or `YYYY-MM-DD` */
  since?: string;
  /** ISO timestamp or `YYYY-MM-DD` (a bare date = end of that day) */
  until?: string;
  limit?: number;
}

/** A page of the log, newest first. */
export interface ActivityPage {
  count: number;
  limit: number;
  entries: ActivityEntry[];
}

/** The API refused or failed. */
export class ActivityApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ActivityApiError';
  }
}

interface Envelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * The query string of a read: set fields only, trimmed, in a stable order.
 *
 * @param query - Filters
 * @returns `?a=b…` or an empty string
 */
export function activityQueryString(query: ActivityQuery): string {
  const params = new URLSearchParams();
  const put = (key: string, value: string | number | undefined): void => {
    const v = typeof value === 'number' ? String(value) : (value ?? '').trim();
    if (v) params.set(key, v);
  };
  put('actorType', query.actorType);
  put('actorId', query.actorId);
  put('action', query.action);
  put('targetType', query.targetType);
  put('targetId', query.targetId);
  put('since', query.since);
  put('until', query.until);
  put('limit', query.limit);
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Read a page of the activity log, newest first.
 *
 * @param query - Filters
 * @returns The page (an empty one when the body carries no entries)
 * @throws ActivityApiError on a non-2xx status or `success: false`
 */
export async function listActivity(query: ActivityQuery = {}): Promise<ActivityPage> {
  const res = await fetch(`${ACTIVITY_API_BASE}${activityQueryString(query)}`);
  let body: Envelope<ActivityPage> = {};
  try {
    body = (await res.json()) as Envelope<ActivityPage>;
  } catch {
    body = {};
  }
  if (!res.ok || body.success === false) {
    throw new ActivityApiError(body.message || body.error || `HTTP ${res.status}`, res.status);
  }
  const data = body.data;
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  return { count: data?.count ?? entries.length, limit: data?.limit ?? query.limit ?? entries.length, entries };
}
