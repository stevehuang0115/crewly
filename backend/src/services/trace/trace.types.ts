/**
 * Run trace types: ids, events, roots and index entries
 * (specs/2026-10-03-run-traces.md).
 *
 * @module services/trace/trace.types
 */

import { randomBytes } from 'crypto';
import { TRACE_CONSTANTS } from '../../constants.js';

/** What started a trace. */
export const TRACE_ROOT_KINDS = [
	'request',
	'goal',
	'experiment',
	'owner_message',
	// Ticket autopilot (specs/2026-10-03-autopilot-experiments.md): the run of
	// one project for one day, and a ticket the autopilot started with no trace.
	'autopilot',
	'ticket',
	// One autopilot triage turn (kept out of the run trace's event budget)
	'triage',
	// A turn the harness did not start (turn-origin.ts, crewly#1014)
	'unsolicited',
] as const;
/** What started a trace. */
export type TraceRootKind = (typeof TRACE_ROOT_KINDS)[number];

/** Every event type a trace file can hold (see the spec's table). */
export const TRACE_EVENT_TYPES = [
	'trace.root',
	'trace.truncated',
	'request.created',
	'request.status',
	'ticket.created',
	'workitem.created',
	'workitem.status',
	'turn.delivered',
	'turn.error',
	// A prompt the harness did not type was submitted (turn-origin.ts, 2026-10-03)
	'turn.unsolicited',
	'message.agent',
	'skill.call',
	'guard.block',
	'error',
	'message.outbound',
	'status.routed',
	'decision.created',
	'decision.status',
	'harness.redelivery',
	'harness.wake',
	'harness.correction',
	'harness.nudge',
	// Stalled-agent recovery (CREW-303): queued work, session stopped / hung / idle
	'harness.recover',
	'experiment.event',
	'usage',
	// Autonomy metrics (#984, specs/2026-10-03-autonomy-metrics.md)
	'turn.ended',
	'runtime.blocked',
	'harness.subagent_sendback',
	'owner.action',
	// Ticket autopilot (specs/2026-10-03-autopilot-experiments.md)
	'autopilot.action',
	'ticket.status',
] as const;
/** Every event type a trace file can hold. */
export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

/** How an event ended. `info` = nothing to judge. */
export type TraceOutcome = 'ok' | 'failed' | 'blocked' | 'queued' | 'skipped' | 'info';

/** Who did it. */
export interface TraceActor {
	kind: 'owner' | 'agent' | 'system';
	/** Agent session, for `agent` (and a system actor acting on one) */
	session?: string;
}

/** What an event is about. */
export interface TraceRefs {
	/** Request (TKT ticket) id */
	requestId?: string;
	/** Project ticket id (`CE-7`) or Request label (`TKT-12`) */
	ticketId?: string;
	workItemId?: string;
	/** Chat / Slack / queue message id */
	messageId?: string;
	/** Decision id (`D-12`) */
	decisionId?: string;
	/** Skill call: `<METHOD> <api path>` */
	skill?: string;
	/** Agent session the event concerns */
	session?: string;
	/** Experiment card id (`EXP-3`) */
	experimentId?: string;
}

/** Small flat details (status codes, token counts, the delivery kind). */
export type TraceData = Record<string, string | number | boolean>;

/** One line of `<traceId>.jsonl`. */
export interface TraceEvent {
	ts: string;
	traceId: string;
	type: TraceEventType;
	actor: TraceActor;
	refs: TraceRefs;
	/** Short English text, secrets redacted, bodies cut */
	summary: string;
	outcome: TraceOutcome;
	data?: TraceData;
}

/** What started a trace. */
export interface TraceRoot {
	traceId: string;
	kind: TraceRootKind;
	summary: string;
	createdAt: string;
	actor: TraceActor;
	refs: TraceRefs;
}

/** Autopilot tag of a trace: the project and local day of the run it belongs to. */
export interface TraceAutopilotTag {
	projectId: string;
	/** Local date (YYYY-MM-DD): the run's day, or the day a ticket's work started */
	day: string;
}

/** Tags of a trace (index only; the trace file is not rewritten). */
export interface TraceTags {
	/** Set once: the first tag wins */
	autopilot?: TraceAutopilotTag;
	/** Ticket labels, merged (at most TRACE_CONSTANTS.MAX_TAG_LABELS) */
	labels?: string[];
}

/** One trace in the index. */
export interface TraceIndexEntry {
	traceId: string;
	root: TraceRoot;
	/** Time of the last event */
	updatedAt: string;
	eventCount: number;
	bytes: number;
	/** True once the size cap was hit */
	truncated: boolean;
	/** Autopilot / label tags (specs/2026-10-03-autopilot-experiments.md) */
	tags?: TraceTags;
	/**
	 * Last status seen for the entities this trace carries (`<kind>:<id>` →
	 * status), from its `ticket.status`, `workitem.status` and `request.status`
	 * events. A delivery that only names an entity whose last status is final
	 * does not move a session onto the trace (CREW-1258).
	 */
	refStatus?: Record<string, string>;
}

/** Entity kinds the index can resolve a trace from. */
export type TraceRefKind =
	| 'request'
	| 'ticket'
	| 'workItem'
	| 'decision'
	| 'experiment'
	/** `<projectId>:<YYYY-MM-DD>` → the project's autopilot run trace of that day */
	| 'autopilotRun'
	/** `<projectId>:<ticketId>` → the trace a ticket's autopilot work runs in */
	| 'autopilotTicket';

/** Shape of `traces/index.json`. */
export interface TraceIndexFile {
	version: number;
	lastSweepAt?: string;
	traces: Record<string, TraceIndexEntry>;
	/** `<kind>:<id>` → traceId */
	refs: Record<string, string>;
}

/** `tr-YYYYMMDD-xxxxxxxx`, built on first use (tests may stub the constants module). */
let traceIdPattern: RegExp | null = null;

/**
 * Whether a value is a well-formed trace id. Checked before any file path is
 * built from an id, so a caller cannot reach outside the traces folder.
 *
 * @param value - Candidate
 * @returns True for `tr-YYYYMMDD-xxxxxxxx`
 */
export function isTraceId(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	traceIdPattern ??= new RegExp(`^${TRACE_CONSTANTS.ID_PREFIX}\\d{8}-[0-9a-f]{${TRACE_CONSTANTS.ID_RANDOM_HEX}}$`);
	return traceIdPattern.test(value);
}

/**
 * A new trace id for the given time.
 *
 * @param now - Creation time (its UTC date is in the id)
 * @returns `tr-YYYYMMDD-xxxxxxxx`
 *
 * @example
 * newTraceId(new Date('2026-10-03T10:00:00Z')) // 'tr-20261003-9f1c2ab4'
 */
export function newTraceId(now: Date = new Date()): string {
	const date = now.toISOString().slice(0, 10).replace(/-/g, '');
	const hex = randomBytes(Math.ceil(TRACE_CONSTANTS.ID_RANDOM_HEX / 2)).toString('hex').slice(0, TRACE_CONSTANTS.ID_RANDOM_HEX);
	return `${TRACE_CONSTANTS.ID_PREFIX}${date}-${hex}`;
}

/**
 * Whether a value is a root kind.
 *
 * @param value - Candidate
 * @returns True for one of {@link TRACE_ROOT_KINDS}
 */
export function isTraceRootKind(value: unknown): value is TraceRootKind {
	return typeof value === 'string' && (TRACE_ROOT_KINDS as readonly string[]).includes(value);
}

/**
 * The index key of an entity.
 *
 * @param kind - Entity kind
 * @param id - Entity id
 * @returns `<kind>:<id>`
 */
export function traceRefKey(kind: TraceRefKind, id: string): string {
	return `${kind}:${id}`;
}

/**
 * Work item statuses after which nothing more happens in its run. Not
 * `done_by_worker` (waits for its verdict), `rejected` (rework: back to
 * `queued`) or `failed` (retry: back to `queued`): the review, rework and retry
 * turns belong to the run (work-item.types.ts transitions).
 */
const ENDED_WORK_ITEM_STATUSES: ReadonlySet<string> = new Set(['done', 'verified', 'cancelled']);

/** Ticket / Request statuses that are final. */
const ENDED_TICKET_STATUSES: ReadonlySet<string> = new Set(['done', 'cancelled']);

/**
 * Whether a status is final for an entity kind (nobody is working on it
 * any more). Decisions, experiments and run keys have no such status.
 *
 * @param kind - Entity kind
 * @param status - Its status
 * @returns True when final
 */
export function isEndedRefStatus(kind: TraceRefKind, status: string | null | undefined): boolean {
	if (!status) return false;
	if (kind === 'workItem') return ENDED_WORK_ITEM_STATUSES.has(status);
	if (kind === 'ticket' || kind === 'request') return ENDED_TICKET_STATUSES.has(status);
	return false;
}

/**
 * The index key a status event updates: `ticket.status` → the ticket,
 * `workitem.status` → the work item, `request.status` → the Request.
 *
 * @param event - A trace event
 * @returns Kind, id and the new status, or null when the event carries none
 */
export function refStatusOfEvent(event: Pick<TraceEvent, 'type' | 'refs' | 'data'>): { kind: TraceRefKind; id: string; status: string } | null {
	const to = event.data?.to;
	if (typeof to !== 'string' || !to) return null;
	if (event.type === 'ticket.status' && event.refs.ticketId) return { kind: 'ticket', id: event.refs.ticketId, status: to };
	if (event.type === 'workitem.status' && event.refs.workItemId) return { kind: 'workItem', id: event.refs.workItemId, status: to };
	if (event.type === 'request.status' && event.refs.requestId) return { kind: 'request', id: event.refs.requestId, status: to };
	return null;
}
