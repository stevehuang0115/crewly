/**
 * Trace context: which trace each agent session's turn is working on.
 *
 * Every message written into an agent turn passes through
 * {@link TraceContext.noteTurnDelivery}. The trace of the text (a
 * `[TRACE:…]` marker, a ticket marker, or a work item / decision / ticket id
 * the index knows) becomes the session's current trace, and later events of
 * that session (skill calls, replies, usage) are attributed to it.
 *
 * An owner message that names no trace is kept as a *pending root*: the trace
 * is only created when the turn starts work ({@link TraceContext.ensureTraceForSession}),
 * so chit-chat makes no trace.
 *
 * The current trace ends (so nothing later is billed to a finished run) when:
 * - a delivery names no trace (cron / scheduled prompts, system notices,
 *   digests, an untraced owner message);
 * - the session's work item in that trace reaches a terminal status
 *   ({@link TraceContext.clearIfCurrent});
 * - the session shows no activity (deliveries, API calls) for the idle gap
 *   ({@link defaultIdleClearMs}).
 *
 * All state is in memory; a restart starts clean (new deliveries set it again).
 *
 * specs/2026-10-03-run-traces.md
 *
 * @module services/trace/trace-context.service
 */

import { PTY_CONSTANTS, TRACE_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { getTraceStore, type TraceStore } from './trace-store.js';
import { cleanTraceData, extractTextRefs, parseTraceMarkers, safeSummary } from './trace-markers.js';
import {
	isTraceId,
	newTraceId,
	type TraceActor,
	type TraceEvent,
	type TraceEventType,
	type TraceOutcome,
	type TraceRefs,
	type TraceRootKind,
} from './trace.types.js';

/** How a delivered message reached the turn. */
export type DeliveryKind =
	| 'owner_message'
	| 'dispatch'
	| 'redelivery'
	| 'status'
	| 'decision'
	| 'follow_up'
	| 'system';

/** Input of {@link TraceContext.startTrace}. */
export interface StartTraceInput {
	kind: TraceRootKind;
	summary: string;
	actor: TraceActor;
	refs?: TraceRefs;
	/** Make it the current trace of this session */
	session?: string;
	now?: Date;
}

/** Input of {@link TraceContext.record}. */
export interface RecordInput {
	traceId: string;
	type: TraceEventType;
	actor: TraceActor;
	summary: string;
	outcome?: TraceOutcome;
	refs?: TraceRefs;
	data?: Record<string, unknown>;
	at?: Date;
}

/** An owner message waiting to become a trace root. */
interface PendingRoot {
	summary: string;
	at: number;
}

/** One `(since, traceId)` span of a session. */
interface Span {
	since: number;
	traceId: string | null;
	/** Last sign of the session working in this span (delivery, API call) */
	lastActive: number;
}

/**
 * Idle gap after which a session's current trace is dropped: the
 * `CREWLY_TRACE_IDLE_CLEAR_MINUTES` env var, else
 * {@link TRACE_CONSTANTS.IDLE_CLEAR_MS}.
 *
 * @returns Milliseconds
 */
export function defaultIdleClearMs(): number {
	const minutes = Number(process.env.CREWLY_TRACE_IDLE_CLEAR_MINUTES);
	return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : TRACE_CONSTANTS.IDLE_CLEAR_MS;
}

/** A `[CHAT:…]` / `[GCHAT:…]` routing prefix (owner or chat-routed message). */
const CHAT_PREFIX = /^\s*\[G?CHAT:[^\]]*\]/;

/**
 * Classify a delivered text.
 *
 * @param text - Exactly what was written into the turn
 * @returns The delivery kind
 */
export function classifyDelivery(text: string): DeliveryKind {
	if (/\[TASK RE-DELIVERY\]|\[CREWLY-DISPATCH\] \d+ WorkItems are still queued/.test(text)) return 'redelivery';
	if (/\[CREWLY-DISPATCH\]|\[TASK ASSIGNMENT\]|^\s*\[TASK\]/.test(text)) return 'dispatch';
	if (/Agent status:|Status from \S+ \(reports to you\)|\[STATUS DIGEST\]|\[STATUS REPORT\]/.test(text)) return 'status';
	if (/\[DECISION\b/.test(text)) return 'decision';
	if (/\[FOLLOW-UP\b/.test(text)) return 'follow_up';
	if (/^\s*\[SYSTEM\b|\[EVENT:/.test(text)) return 'system';
	if (CHAT_PREFIX.test(text)) return 'owner_message';
	return 'system';
}

/**
 * Per-session trace context. Singleton (see {@link getTraceContext}).
 */
export class TraceContext {
	private readonly logger: ComponentLogger;
	private readonly spans = new Map<string, Span[]>();
	private readonly pending = new Map<string, PendingRoot>();
	/** Sessions whose turn is busy: since when, and the trace it started on */
	private readonly busy = new Map<string, { since: number; traceId: string | null }>();
	private readonly now: () => number;
	private readonly idleClearMs: number;

	/**
	 * @param storeOf - Store accessor (default: the process-wide store)
	 * @param now - Clock (ms)
	 * @param idleClearMs - Idle gap that ends a session's current trace (default {@link defaultIdleClearMs})
	 */
	constructor(
		private readonly storeOf: () => TraceStore = getTraceStore,
		now?: () => number,
		idleClearMs?: number,
	) {
		this.logger = LoggerService.getInstance().createComponentLogger('TraceContext');
		this.now = now ?? (() => Date.now());
		this.idleClearMs = idleClearMs ?? defaultIdleClearMs();
	}

	/** The store. */
	get store(): TraceStore {
		return this.storeOf();
	}

	/**
	 * Start a trace and write its root event.
	 *
	 * @param input - Root kind, summary, actor, refs, optional session to bind
	 * @returns The new trace id, or null when the store refused it
	 */
	startTrace(input: StartTraceInput): string | null {
		try {
			const at = input.now ?? new Date(this.now());
			const traceId = newTraceId(at);
			const ok = this.store.createRoot({
				traceId,
				kind: input.kind,
				summary: safeSummary(input.summary) || input.kind,
				createdAt: at.toISOString(),
				actor: input.actor,
				refs: input.refs ?? {},
			});
			if (!ok) return null;
			if (input.session) this.setCurrent(input.session, traceId, at.getTime());
			this.logger.debug('Trace started', { traceId, kind: input.kind, session: input.session });
			return traceId;
		} catch (err) {
			this.logger.debug('Trace could not be started', { error: errText(err) });
			return null;
		}
	}

	/**
	 * Append an event (summary cleaned, data trimmed). Never throws.
	 *
	 * @param input - The event
	 * @returns True when queued
	 */
	record(input: RecordInput): boolean {
		try {
			if (!isTraceId(input.traceId)) return false;
			const refs: TraceRefs = {};
			for (const [k, v] of Object.entries(input.refs ?? {})) {
				if (typeof v === 'string' && v.length > 0) (refs as Record<string, string>)[k] = v;
			}
			const data = cleanTraceData(input.data);
			const event: TraceEvent = {
				ts: (input.at ?? new Date(this.now())).toISOString(),
				traceId: input.traceId,
				type: input.type,
				actor: input.actor,
				refs,
				summary: safeSummary(input.summary),
				outcome: input.outcome ?? 'info',
				...(data ? { data } : {}),
			};
			return this.store.append(event);
		} catch (err) {
			this.logger.debug('Trace event dropped', { type: input.type, error: errText(err) });
			return false;
		}
	}

	/**
	 * The trace the session's turn is working on now.
	 *
	 * @param session - Agent session
	 * @returns Trace id, or null
	 */
	currentTrace(session: string | null | undefined): string | null {
		if (!session) return null;
		const last = this.expireIfIdle(session);
		if (!last?.traceId) return null;
		return this.store.has(last.traceId) ? last.traceId : null;
	}

	/**
	 * The session did something (an API call, a delivery): keep its current
	 * trace alive. A trace already past the idle gap is ended first, so a
	 * session coming back after a long pause does not revive it.
	 *
	 * @param session - Agent session
	 * @param at - When (ms)
	 */
	touch(session: string | null | undefined, at: number = this.now()): void {
		if (!session) return;
		const last = this.expireIfIdle(session, at);
		if (last?.traceId && at > last.lastActive) last.lastActive = at;
	}

	/**
	 * End the session's current trace if it is this one (its work item
	 * reached a terminal status).
	 *
	 * @param session - Agent session
	 * @param traceId - The trace that finished for it
	 * @returns True when it was cleared
	 */
	clearIfCurrent(session: string | null | undefined, traceId: string | null | undefined): boolean {
		if (!session || !traceId) return false;
		const spans = this.spans.get(session);
		const last = spans?.[spans.length - 1];
		if (last?.traceId !== traceId) return false;
		this.setCurrent(session, null);
		return true;
	}

	/**
	 * The session's last span, after ending it when the session has been idle
	 * longer than the idle gap (a null span then starts where the gap ended).
	 *
	 * @param session - Agent session
	 * @param at - Now (ms)
	 * @returns The last span after the check, or undefined
	 */
	private expireIfIdle(session: string, at: number = this.now()): Span | undefined {
		const spans = this.spans.get(session);
		const last = spans?.[spans.length - 1];
		if (!spans || !last?.traceId || at - last.lastActive <= this.idleClearMs) return last;
		const since = last.lastActive + this.idleClearMs;
		spans.push({ since, traceId: null, lastActive: since });
		while (spans.length > TRACE_CONSTANTS.SESSION_HISTORY_SPANS) spans.shift();
		return spans[spans.length - 1];
	}

	/**
	 * The trace the session was working on at a given time (usage entries are
	 * often recorded after the turn, e.g. by the Claude transcript sync).
	 *
	 * @param session - Agent session
	 * @param at - Time of the entry (ms); default now
	 * @returns Trace id, or null
	 */
	traceAt(session: string | null | undefined, at?: number): string | null {
		if (!session) return null;
		const spans = this.spans.get(session);
		if (!spans || spans.length === 0) return null;
		const t = at ?? this.now();
		for (let i = spans.length - 1; i >= 0; i--) {
			if (spans[i].since <= t) {
				const id = spans[i].traceId;
				// Past the idle gap of that span: the session had stopped working on it.
				if (id && t - spans[i].lastActive > this.idleClearMs) return null;
				return id && this.store.has(id) ? id : null;
			}
		}
		return null;
	}

	/**
	 * Set (or clear) the session's current trace.
	 *
	 * @param session - Agent session
	 * @param traceId - Trace, or null for none
	 * @param at - Since when (ms)
	 */
	setCurrent(session: string, traceId: string | null, at: number = this.now()): void {
		const spans = this.spans.get(session) ?? [];
		const last = spans[spans.length - 1];
		if (last && last.traceId === traceId) {
			if (at > last.lastActive) last.lastActive = at;
			return;
		}
		spans.push({ since: at, traceId, lastActive: at });
		while (spans.length > TRACE_CONSTANTS.SESSION_HISTORY_SPANS) spans.shift();
		this.spans.set(session, spans);
	}

	/**
	 * The session's current trace; when it has none but an owner message is
	 * waiting, that message becomes the root of a new trace now (the turn is
	 * starting work).
	 *
	 * @param session - Agent session
	 * @returns Trace id, or null
	 */
	ensureTraceForSession(session: string | null | undefined): string | null {
		if (!session) return null;
		const current = this.currentTrace(session);
		if (current) return current;
		const pending = this.pending.get(session);
		if (!pending) return null;
		this.pending.delete(session);
		if (this.now() - pending.at > TRACE_CONSTANTS.PENDING_ROOT_TTL_MS) return null;
		const traceId = this.startTrace({
			kind: 'owner_message',
			summary: pending.summary,
			actor: { kind: 'owner' },
			refs: { session },
			now: new Date(pending.at),
		});
		if (!traceId) return null;
		this.record({
			traceId,
			type: 'turn.delivered',
			actor: { kind: 'owner' },
			summary: `Owner message delivered to ${session}: ${pending.summary}`,
			refs: { session },
			data: { kind: 'owner_message' },
			at: new Date(pending.at),
		});
		this.setCurrent(session, traceId);
		return traceId;
	}

	/**
	 * Traces a text refers to: `[TRACE:…]` markers win; otherwise ticket
	 * markers, then work item / decision / ticket ids the index knows.
	 *
	 * @param text - Any text
	 * @returns Trace ids, in order, de-duplicated
	 */
	resolveTracesFromText(text: string): string[] {
		const store = this.store;
		const markers = parseTraceMarkers(text).filter((id) => store.has(id));
		if (markers.length > 0) return markers;
		const refs = extractTextRefs(text);
		const out: string[] = [];
		const add = (id: string | null): void => {
			if (id && !out.includes(id)) out.push(id);
		};
		for (const id of refs.requestIds) add(store.traceByRef('request', id));
		for (const id of refs.workItemIds) add(store.traceByRef('workItem', id));
		for (const id of refs.decisionIds) add(store.traceByRef('decision', id));
		for (const id of refs.ticketIds) add(store.traceByRef('ticket', id));
		return out;
	}

	/**
	 * A message was written into an agent's turn. Sets the session's current
	 * trace and records `turn.delivered` (see the module doc). Never throws.
	 *
	 * @param session - Agent session written to
	 * @param text - Exactly what was delivered
	 * @param runtime - `pty` or `in-process`
	 * @returns The trace the turn is now on, or null
	 */
	noteTurnDelivery(session: string, text: string, runtime: string = 'pty'): string | null {
		try {
			if (!session || typeof text !== 'string' || text.length === 0) return null;
			const kind = classifyDelivery(text);
			const traces = this.resolveTracesFromText(text);
			const now = this.now();
			if (traces.length === 0) {
				// Nothing in the text names a run. An owner message may start one
				// (pending root); anything else — a cron / scheduled prompt, a system
				// notice, a digest — is not part of the run the session was on, so
				// later calls and usage must not be billed to it.
				this.setCurrent(session, null, now);
				if (kind === 'owner_message') this.pending.set(session, { summary: safeSummary(text), at: now });
				return null;
			}
			const current = this.currentTrace(session);
			const next = current && traces.includes(current) ? current : traces[0];
			this.setCurrent(session, next, now);
			this.pending.delete(session);
			const actor: TraceActor = kind === 'owner_message' ? { kind: 'owner' } : { kind: 'system' };
			for (const traceId of traces) {
				this.record({
					traceId,
					type: 'turn.delivered',
					actor,
					summary: `${DELIVERY_LABELS[kind]} delivered to ${session}: ${text}`,
					refs: { session },
					data: { kind, runtime },
				});
			}
			return next;
		} catch (err) {
			this.logger.debug('Turn delivery not traced', { session, error: errText(err) });
			return null;
		}
	}

	/**
	 * An agent's turn became busy or idle (PTY activity monitor, in-process
	 * turn start / end). When a busy period ends, one `turn.ended` event with
	 * `data.busyMs` is recorded in the trace the turn started on, and in the
	 * session's current trace when a delivery moved it to another one meanwhile.
	 * Periods shorter than {@link PTY_CONSTANTS.MIN_BUSY_DURATION_MS} are not
	 * recorded (activity-monitor flapping). Repeated busy / idle calls are
	 * ignored, so two sources can report the same turn. Never throws.
	 *
	 * @param session - Agent session
	 * @param busy - True when the turn started, false when it ended
	 * @param runtime - `pty` or `in-process`
	 * @returns True when a `turn.ended` event was recorded
	 */
	noteTurnActivity(session: string, busy: boolean, runtime: string = 'pty'): boolean {
		try {
			if (!session) return false;
			const now = this.now();
			if (busy) {
				if (!this.busy.has(session)) this.busy.set(session, { since: now, traceId: this.currentTrace(session) });
				else this.touch(session, now);
				return false;
			}
			const started = this.busy.get(session);
			if (!started) return false;
			this.busy.delete(session);
			const busyMs = now - started.since;
			if (busyMs < PTY_CONSTANTS.MIN_BUSY_DURATION_MS) return false;
			const targets = [started.traceId, this.currentTrace(session)].filter(
				(id, i, all): id is string => !!id && all.indexOf(id) === i && this.store.has(id),
			);
			let recorded = false;
			for (const traceId of targets) {
				recorded =
					this.record({
						traceId,
						type: 'turn.ended',
						actor: { kind: 'agent', session },
						summary: `${session} finished a turn (${Math.round(busyMs / 1000)}s busy)`,
						refs: { session },
						data: { busyMs, runtime },
						at: new Date(now),
					}) || recorded;
			}
			return recorded;
		} catch (err) {
			this.logger.debug('Turn activity not traced', { session, error: errText(err) });
			return false;
		}
	}

	/**
	 * Forget everything (tests).
	 */
	reset(): void {
		this.spans.clear();
		this.pending.clear();
		this.busy.clear();
	}
}

/** Human labels of delivery kinds (summaries). */
const DELIVERY_LABELS: Record<DeliveryKind, string> = {
	owner_message: 'Owner message',
	dispatch: 'Work item brief',
	redelivery: 'Work item redelivery',
	status: 'Status report',
	decision: 'Decision answer',
	follow_up: 'Follow-up',
	system: 'System message',
};

/**
 * Error text.
 *
 * @param err - Anything thrown
 * @returns Message
 */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

let instance: TraceContext | null = null;

/**
 * The process-wide trace context.
 *
 * @returns The context (created on first use)
 */
export function getTraceContext(): TraceContext {
	if (!instance) instance = new TraceContext();
	return instance;
}

/**
 * Replace the process-wide context (tests).
 *
 * @param context - Context, or null to rebuild the default lazily
 */
export function setTraceContextForTesting(context: TraceContext | null): void {
	instance = context;
}
