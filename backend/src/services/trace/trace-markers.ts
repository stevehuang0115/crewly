/**
 * Text helpers for run traces: the `[TRACE:<id>]` prompt marker, the ids a
 * delivered text refers to, safe summaries, and skill-call path labels.
 *
 * All pure; no I/O.
 *
 * @module services/trace/trace-markers
 */

import { TRACE_CONSTANTS } from '../../constants.js';
import { redactSensitive } from '../wiki/wiki-redaction.js';
import { parseTicketMarkers } from '../../types/v2/ticket.types.js';
import { isTraceId, type TraceData } from './trace.types.js';

/** `[TRACE:tr-…]` anywhere in a text. */
const TRACE_MARKER = /\[TRACE:(tr-\d{8}-[0-9a-f]+)\]/g;

/** A UUID (work item ids). */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** A decision id (`D-12`). */
const DECISION_ID = /\bD-\d+\b/g;

/** A project ticket id (`CE-7`, `APP-12`) or a Request label (`TKT-12`). */
const TICKET_ID = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

/** `…TOKEN=value`, `…_KEY=value`, `…SECRET=value`, `…PASSWORD=value` assignments. */
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY))=(\S+)/gi;

/** Routing prefixes the harness puts in front of a delivered message. */
const ROUTING_PREFIX = /^\s*(\[(?:G?CHAT|SLACK|SLACK-THREAD|TICKET|TRACE|REMOTE):[^\]]*\]\s*)+/;

/**
 * The marker for a trace.
 *
 * @param traceId - Trace id
 * @returns `[TRACE:<id>]`
 */
export function formatTraceMarker(traceId: string): string {
	return `[TRACE:${traceId}]`;
}

/**
 * Trace ids named by `[TRACE:…]` markers in a text, in order, de-duplicated.
 *
 * @param text - Delivered text
 * @returns Trace ids
 */
export function parseTraceMarkers(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(TRACE_MARKER)) {
		if (isTraceId(m[1]) && !out.includes(m[1])) out.push(m[1]);
	}
	return out;
}

/**
 * Append the trace marker as the last line, unless the text already names
 * this trace. Used where a prefix could disturb routing parsers (status
 * reports, agent-to-agent messages).
 *
 * @param text - Message text
 * @param traceId - Trace to carry (no-op when absent)
 * @returns The text with the marker
 */
export function appendTraceMarker(text: string, traceId: string | null | undefined): string {
	if (!traceId || !isTraceId(traceId) || parseTraceMarkers(text).includes(traceId)) return text;
	return `${text}\n${formatTraceMarker(traceId)}`;
}

/** Ids a delivered text refers to, by kind. */
export interface TextRefs {
	/** Request ids from `[TICKET:TKT-n <id>]` markers */
	requestIds: string[];
	/** UUIDs (candidate work item ids) */
	workItemIds: string[];
	/** `D-n` */
	decisionIds: string[];
	/** `CE-7`, `TKT-12`, … (not `D-n`) */
	ticketIds: string[];
}

/**
 * Every id in a text that the trace index might know.
 *
 * @param text - Delivered text
 * @returns Ids by kind, each de-duplicated
 */
export function extractTextRefs(text: string): TextRefs {
	const uniq = (values: Iterable<string>): string[] => [...new Set(values)];
	const requestIds = uniq(parseTicketMarkers(text).map((r) => r.id));
	const workItemIds = uniq([...text.matchAll(UUID)].map((m) => m[0].toLowerCase()));
	const decisionIds = uniq([...text.matchAll(DECISION_ID)].map((m) => m[0]));
	const ticketIds = uniq([...text.matchAll(TICKET_ID)].map((m) => m[0]).filter((id) => !/^D-\d+$/.test(id)));
	return { requestIds, workItemIds, decisionIds, ticketIds };
}

/**
 * A summary safe to store: one line, routing prefixes and trace markers
 * removed, secrets redacted, cut to {@link TRACE_CONSTANTS.SUMMARY_MAX_CHARS}.
 *
 * @param text - Raw text (a message body, an error, a title)
 * @param max - Character limit
 * @returns The summary
 */
export function safeSummary(text: string | null | undefined, max: number = TRACE_CONSTANTS.SUMMARY_MAX_CHARS): string {
	if (!text) return '';
	const flat = String(text).replace(ROUTING_PREFIX, '').replace(TRACE_MARKER, '').replace(/\s+/g, ' ').trim();
	// Pattern-only redaction (no constants read at import time, so modules
	// that stub the constants in tests can still load this one).
	const redacted = redactSensitive(flat.replace(SECRET_ASSIGNMENT, '$1=[REDACTED]'));
	return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

/**
 * Keep only small values in an event's data map: strings are summarised,
 * non-finite numbers and empty values are dropped.
 *
 * @param data - Raw data
 * @returns Cleaned data, or undefined when nothing is left
 */
export function cleanTraceData(data: Record<string, unknown> | undefined): TraceData | undefined {
	if (!data) return undefined;
	const out: TraceData = {};
	for (const [key, value] of Object.entries(data)) {
		if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
		else if (typeof value === 'boolean') out[key] = value;
		else if (typeof value === 'string' && value.length > 0) out[key] = safeSummary(value, TRACE_CONSTANTS.DATA_VALUE_MAX_CHARS);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The label of a skill call: method plus API path with ids replaced, so calls
 * group by endpoint.
 *
 * @param method - HTTP method
 * @param apiPath - Path relative to `/api` (query string ignored)
 * @returns e.g. `POST /task-pool/:id/complete`
 *
 * @example
 * skillLabel('post', '/terminal/crewly-orc/write?x=1') // 'POST /terminal/:session/write'
 */
export function skillLabel(method: string, apiPath: string): string {
	const pathOnly = apiPath.split('?')[0] || '/';
	const segments = pathOnly.split('/').map((seg, i, all) => {
		if (!seg) return seg;
		if (all[i - 1] === 'terminal') return ':session';
		if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) || /^\d+$/.test(seg) || /^[0-9a-f]{12,}$/i.test(seg)) return ':id';
		if (/^[A-Z][A-Z0-9]{0,9}-\d+$/.test(seg)) return ':id';
		if (isTraceId(seg)) return ':id';
		return seg;
	});
	return `${method.toUpperCase()} ${segments.join('/')}`;
}
