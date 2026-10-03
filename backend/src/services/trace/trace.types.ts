/**
 * Run trace types: ids, events, roots and index entries
 * (specs/2026-10-03-run-traces.md).
 *
 * @module services/trace/trace.types
 */

import { randomBytes } from 'crypto';
import { TRACE_CONSTANTS } from '../../constants.js';

/** What started a trace. */
export const TRACE_ROOT_KINDS = ['request', 'goal', 'experiment', 'owner_message'] as const;
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
	'usage',
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
}

/** Entity kinds the index can resolve a trace from. */
export type TraceRefKind = 'request' | 'ticket' | 'workItem' | 'decision';

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
