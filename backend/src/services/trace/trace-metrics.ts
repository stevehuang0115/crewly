/**
 * Autonomy metrics of one run trace, computed from its events only: where the
 * time went (agents working, waiting on the owner, waiting on an agent, idle),
 * owner touches, rework, stalls with a cause, harness interventions, tokens
 * and cost, and the outcome.
 *
 * Pure: no I/O, no clock unless none is given. The definitions are in
 * specs/2026-10-03-autonomy-metrics.md; keep the two in step.
 *
 * @module services/trace/trace-metrics
 */

import { TRACE_CONSTANTS } from '../../constants.js';
import { eventCostUsd, eventTokens } from '../monitoring/token-usage.service.js';
import type { TraceEvent, TraceRoot } from './trace.types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why nothing moved during a stall. */
export type StallCause = 'runtime_quota' | 'delivery_failure' | 'waiting_on_owner' | 'waiting_on_agent' | 'nobody_pushing';

/** Every stall cause, in the order they are checked. */
export const STALL_CAUSES: readonly StallCause[] = ['runtime_quota', 'delivery_failure', 'waiting_on_owner', 'waiting_on_agent', 'nobody_pushing'];

/** One gap with no progress longer than the threshold. */
export interface TraceStall {
	/** ISO start (the last progress before it) */
	start: string;
	/** ISO end (the next progress, or now for an ongoing stall) */
	end: string;
	ms: number;
	cause: StallCause;
	/** One English line: what it waited on */
	detail: string;
	/** Agent sessions it waited on, when known */
	sessions?: string[];
	/** Still going: the trace is open and nothing happened since `start` */
	ongoing?: boolean;
}

/** Overall state of the run. */
export type TraceOutcomeState = 'done' | 'cancelled' | 'failed' | 'waiting_on_owner' | 'in_progress' | 'no_open_work';

/** Tokens and cost of one agent or model. */
export interface UsageBreakdown {
	/** Agent session or model id */
	key: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	/** input (cached included) + output */
	totalTokens: number;
	costUsd: number;
}

/** Everything computed for one trace. */
export interface TraceMetrics {
	traceId: string;
	/** The window: root → last event */
	window: { start: string; end: string };
	/** Events looked at (the root excluded) */
	eventCount: number;
	/** Agent sessions that appear in the trace */
	agents: string[];
	time: {
		wallMs: number;
		activeMs: number;
		waitingOwnerMs: number;
		waitingAgentMs: number;
		idleMs: number;
		/** Where busy periods came from */
		activeSource: 'turn_events' | 'inferred' | 'mixed' | 'none';
	};
	/**
	 * `manual` (dashboard writes, `owner.action`) is NOT COLLECTED YET: the
	 * dashboard marker is not authenticated (an agent could send it), so it is
	 * left out of `total` and not shown until owner sessions (#999) land.
	 */
	ownerTouches: { answered: number; approved: number; sentBack: number; corrected: number; manual: number; total: number };
	rework: { sendBacks: number; retries: number; failedVerifications: number; subagentSendBacks: number; total: number };
	stalls: {
		thresholdMinutes: number;
		count: number;
		/** Ongoing stall included */
		totalMs: number;
		byCause: Record<StallCause, number>;
		/** Chronological; at most METRICS_MAX_STALL_ITEMS (the longest) */
		items: TraceStall[];
	};
	interventions: { nudges: number; redeliveries: number; wakes: number; corrections: number; guardBlocks: number; misroutes: number; total: number };
	usage: {
		inputTokens: number;
		cachedInputTokens: number;
		outputTokens: number;
		totalTokens: number;
		costUsd: number;
		/** Most expensive first */
		byAgent: UsageBreakdown[];
		byModel: UsageBreakdown[];
	};
	outcome: {
		state: TraceOutcomeState;
		/** Last status of the trace's (first) Request */
		requestStatus?: string;
		workItems: { total: number; done: number; failed: number; open: number };
		experiment?: { id: string; status?: string; verdict?: string };
	};
	/** Each owner touch with its time (only with `detail`) */
	ownerTouchEvents?: OwnerTouchEvent[];
}

/** The few numbers embedded in `GET /api/traces` rows. */
export interface TraceMetricsSummary {
	wallMs: number;
	activeMs: number;
	waitingOwnerMs: number;
	waitingAgentMs: number;
	idleMs: number;
	ownerTouches: number;
	rework: number;
	stalls: number;
	stallMs: number;
	ongoingStall: boolean;
	interventions: number;
	totalTokens: number;
	costUsd: number;
	state: TraceOutcomeState;
}

/** Options of {@link computeTraceMetrics}. */
export interface TraceMetricsOptions {
	/** Stall threshold (default {@link defaultStallMinutes}) */
	stallMinutes?: number;
	/** Clock for the ongoing stall (default: now) */
	now?: Date;
	/**
	 * Keep every stall item (no METRICS_MAX_STALL_ITEMS cap) and list each
	 * owner touch with its time in `ownerTouchEvents` — for callers that
	 * split a run by day (the autopilot stats).
	 */
	detail?: boolean;
}

/** One owner touch and when it happened (`detail` only). */
export interface OwnerTouchEvent {
	kind: 'answered' | 'approved' | 'sentBack' | 'corrected';
	at: string;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Stall threshold: `CREWLY_TRACE_STALL_MINUTES`, else
 * {@link TRACE_CONSTANTS.STALL_MINUTES}.
 *
 * @returns Minutes
 */
export function defaultStallMinutes(): number {
	const env = Number(process.env.CREWLY_TRACE_STALL_MINUTES);
	return Number.isFinite(env) && env > 0 ? clampStallMinutes(env) : TRACE_CONSTANTS.STALL_MINUTES;
}

/**
 * A caller's stall threshold within bounds.
 *
 * @param minutes - Requested minutes
 * @returns Minutes within STALL_MINUTES_MIN..STALL_MINUTES_MAX
 */
export function clampStallMinutes(minutes: number): number {
	return Math.min(TRACE_CONSTANTS.STALL_MINUTES_MAX, Math.max(TRACE_CONSTANTS.STALL_MINUTES_MIN, minutes));
}

// ---------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------

/** `[start, end]` in ms. */
type Interval = [number, number];

/** An interval something was held in, with what held it. */
interface Hold {
	start: number;
	end: number;
	label: string;
	session?: string;
	/** Still open when the window ended */
	stillOpen?: boolean;
}

/**
 * Sort and merge overlapping intervals; empty ones are dropped.
 *
 * @param list - Intervals
 * @returns Disjoint, sorted intervals
 */
export function mergeIntervals(list: ReadonlyArray<Interval>): Interval[] {
	const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
	const out: Interval[] = [];
	for (const [a, b] of sorted) {
		const last = out[out.length - 1];
		if (last && a <= last[1]) last[1] = Math.max(last[1], b);
		else out.push([a, b]);
	}
	return out;
}

/**
 * Clip intervals to a window.
 *
 * @param list - Intervals
 * @param lo - Window start
 * @param hi - Window end
 * @returns Clipped intervals (merged)
 */
function clip(list: ReadonlyArray<Interval>, lo: number, hi: number): Interval[] {
	return mergeIntervals(list.map(([a, b]): Interval => [Math.max(a, lo), Math.min(b, hi)]));
}

/**
 * `a` minus `b`; both merged.
 *
 * @param a - Intervals
 * @param b - Intervals to remove
 * @returns What is in `a` and not in `b`
 */
export function subtractIntervals(a: ReadonlyArray<Interval>, b: ReadonlyArray<Interval>): Interval[] {
	const out: Interval[] = [];
	for (const [start, end] of a) {
		let cursor = start;
		for (const [bs, be] of b) {
			if (be <= cursor || bs >= end) continue;
			if (bs > cursor) out.push([cursor, bs]);
			cursor = Math.max(cursor, be);
			if (cursor >= end) break;
		}
		if (cursor < end) out.push([cursor, end]);
	}
	return out;
}

/**
 * Total length.
 *
 * @param list - Disjoint intervals
 * @returns ms
 */
function lengthOf(list: ReadonlyArray<Interval>): number {
	return list.reduce((sum, [a, b]) => sum + (b - a), 0);
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

/** An event with its parsed time and file order. */
interface Timed {
	e: TraceEvent;
	t: number;
}

/** Work item statuses after which nobody works on it. */
const WORK_ITEM_CLOSED = new Set(['done', 'done_by_worker', 'verified', 'failed', 'rejected', 'cancelled']);
/** Work item statuses that hold nobody (waiting for a time). */
const WORK_ITEM_WAITING_ON_TIME = new Set(['scheduled']);
/** Statuses a work item is re-queued from (a retry). */
const RETRY_FROM = new Set(['running', 'blocked', 'failed', 'rejected', 'done_by_worker', 'escalated', 'cancelled', 'verified', 'done']);
/** Work item types that are a verification. */
const VERIFY_TYPES = new Set(['check', 'review']);
/** Decision statuses that close it (`parked` still waits on the owner). */
const DECISION_CLOSED = new Set(['resolved', 'defaulted', 'cancelled', 'expired', 'skipped']);
/** Decision kinds that are approvals. */
const APPROVAL_DECISION_KINDS = new Set(['spend_cap', 'runtime_terms', 'browser_action']);
/** Request statuses an agent holds. */
const REQUEST_AGENT_HOLD = new Set(['open', 'ready', 'running', 'awaiting_followup', 'blocked']);
/** Request statuses work goes back to on a send-back. */
const REQUEST_BACK_TO_WORK = new Set(['open', 'ready', 'running', 'blocked']);
/** Events that are not progress (pushing, refusals, failures). */
const NOT_PROGRESS = new Set(['harness.nudge', 'harness.redelivery', 'harness.wake', 'harness.correction', 'harness.subagent_sendback', 'guard.block', 'error', 'runtime.blocked', 'trace.truncated', 'trace.root']);
/** turn.error text that means the runtime is out of usage or signed out. */
const QUOTA_TEXT = /usage limit|rate limit|quota|credit|billing|sign.?in|log.?in|logged out|unauthori[sz]ed|\b401\b/i;

/**
 * A string field of `data`.
 *
 * @param e - Event
 * @param key - Field
 * @returns The value, or undefined
 */
function dataStr(e: TraceEvent, key: string): string | undefined {
	const v = e.data?.[key];
	return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
}

/**
 * A number field of `data`.
 *
 * @param e - Event
 * @param key - Field
 * @returns The value (0 when absent)
 */
function dataNum(e: TraceEvent, key: string): number {
	const v = Number(e.data?.[key]);
	return Number.isFinite(v) ? v : 0;
}

/**
 * The agent session an event is about: its agent actor, else `refs.session`.
 *
 * @param e - Event
 * @returns Session, or undefined
 */
export function sessionOfEvent(e: TraceEvent): string | undefined {
	if (e.actor.kind === 'agent' && e.actor.session) return e.actor.session;
	return e.refs.session || undefined;
}

/**
 * Whether an event moved the run forward (see the spec's Stalls section).
 *
 * @param e - Event
 * @returns True for progress
 */
export function isProgressEvent(e: TraceEvent): boolean {
	if (NOT_PROGRESS.has(e.type)) return false;
	if (e.type === 'message.outbound' && e.outcome === 'failed') return false;
	if (e.type === 'turn.delivered' && (dataStr(e, 'kind') === 'redelivery' || e.outcome === 'failed')) return false;
	return true;
}

/**
 * The text of an owner message delivery without its "delivered to X" prefix
 * (one message delivered to two agents is one touch).
 *
 * @param e - turn.delivered event
 * @returns Message text
 */
function ownerMessageText(e: TraceEvent): string {
	return e.summary.replace(/^Owner message delivered to \S+: /, '');
}

/**
 * Tokens and cost of a `usage` event (the Usage page's unit and prices).
 *
 * @param e - Event
 * @returns Tokens (input incl. cached + output) and USD, or null for other events
 */
export function usageOfEvent(e: TraceEvent): { input: number; cachedInput: number; output: number; total: number; costUsd: number } | null {
	if (e.type !== 'usage') return null;
	const runtime = dataStr(e, 'runtime');
	const usage = {
		model: dataStr(e, 'model') ?? 'unknown',
		input: dataNum(e, 'input'),
		output: dataNum(e, 'output'),
		cachedInput: dataNum(e, 'cachedInput'),
		cacheWrite: dataNum(e, 'cacheWrite'),
		...(runtime ? { runtime } : {}),
	};
	const tokens = eventTokens(usage);
	return { ...tokens, costUsd: eventCostUsd(usage) };
}

/**
 * Sorted events with a valid time (the root excluded).
 *
 * @param events - Raw events
 * @returns Events with times, in time order (file order breaks ties)
 */
export function sortTraceEvents(events: ReadonlyArray<TraceEvent>): Timed[] {
	return events
		.map((e, i) => ({ e, t: Date.parse(e.ts), i }))
		.filter((x) => x.e.type !== 'trace.root' && Number.isFinite(x.t))
		.sort((a, b) => a.t - b.t || a.i - b.i)
		.map(({ e, t }) => ({ e, t }));
}

// ---------------------------------------------------------------------------
// Busy periods
// ---------------------------------------------------------------------------

/**
 * Busy periods per session: from `turn.ended` events when the session has
 * any, else inferred from its deliveries and own activity.
 *
 * @param timed - Sorted events
 * @returns Intervals and how they were found
 */
function busyPeriods(timed: ReadonlyArray<Timed>): { intervals: Interval[]; explicit: number; inferred: number } {
	const explicit = new Map<string, Interval[]>();
	const points = new Map<string, number[]>();
	const add = (map: Map<string, number[]>, s: string, t: number): void => {
		const list = map.get(s) ?? [];
		list.push(t);
		map.set(s, list);
	};
	for (const { e, t } of timed) {
		if (e.type === 'turn.ended' && e.actor.session) {
			const busyMs = Math.max(0, dataNum(e, 'busyMs'));
			const list = explicit.get(e.actor.session) ?? [];
			list.push([t - busyMs, t]);
			explicit.set(e.actor.session, list);
			continue;
		}
		if (e.type === 'turn.delivered' && e.refs.session && isProgressEvent(e)) add(points, e.refs.session, t);
		else if (e.actor.kind === 'agent' && e.actor.session) add(points, e.actor.session, t);
	}
	const intervals: Interval[] = [];
	let inferred = 0;
	for (const list of explicit.values()) intervals.push(...list);
	for (const [session, pts] of points) {
		if (explicit.has(session)) continue;
		inferred += 1;
		let cur: Interval | null = null;
		for (const p of pts) {
			if (cur && p - cur[1] <= TRACE_CONSTANTS.INFERRED_TURN_GAP_MS) cur[1] = p;
			else {
				if (cur) intervals.push(cur);
				cur = [p, p];
			}
		}
		if (cur) intervals.push(cur);
	}
	return { intervals, explicit: explicit.size, inferred };
}

// ---------------------------------------------------------------------------
// Holds (who the run is waiting on)
// ---------------------------------------------------------------------------

/** Who held the run, and when. */
interface Holds {
	owner: Hold[];
	agent: Hold[];
	/** Work item id → last status */
	workItemStatus: Map<string, string>;
	/** Request id → last status, in order of appearance */
	requestStatus: Map<string, string>;
}

/**
 * Owner and agent holds from decisions, Requests, work items and agent →
 * agent messages.
 *
 * @param timed - Sorted events
 * @param end - Window end (open holds end here)
 * @returns Holds and last statuses
 */
function collectHolds(timed: ReadonlyArray<Timed>, end: number): Holds {
	const owner: Hold[] = [];
	const agent: Hold[] = [];
	const openDecisions = new Map<string, number>();
	const requestState = new Map<string, { status: string; since: number }>();
	const workItems = new Map<string, { status: string; since: number; target?: string; open: boolean }>();
	const pendingMessages: Array<{ target: string; from?: string; since: number }> = [];

	const closeRequest = (id: string, t: number, stillOpen = false): void => {
		const st = requestState.get(id);
		if (!st) return;
		const flag = stillOpen ? { stillOpen } : {};
		if (st.status === 'waiting_confirmation') owner.push({ start: st.since, end: t, label: `Ticket ${id} waits for the owner's review`, ...flag });
		else if (REQUEST_AGENT_HOLD.has(st.status)) agent.push({ start: st.since, end: t, label: `Ticket ${id} is ${st.status.replace(/_/g, ' ')}`, ...flag });
	};
	const closeWorkItem = (id: string, t: number, stillOpen = false): void => {
		const wi = workItems.get(id);
		if (!wi || !wi.open) return;
		agent.push({
			start: wi.since,
			end: t,
			label: `Work item${wi.target ? ` for ${wi.target}` : ''} is ${wi.status}`,
			...(wi.target ? { session: wi.target } : {}),
			...(stillOpen ? { stillOpen } : {}),
		});
		wi.open = false;
	};

	for (const { e, t } of timed) {
		// Any activity of an agent answers messages sent to it.
		const actorSession = e.actor.kind === 'agent' ? e.actor.session : undefined;
		if (actorSession) {
			for (let i = pendingMessages.length - 1; i >= 0; i--) {
				const m = pendingMessages[i];
				if (m.target === actorSession && t >= m.since) {
					agent.push({ start: m.since, end: t, label: `Message to ${m.target}${m.from ? ` from ${m.from}` : ''} not picked up`, session: m.target });
					pendingMessages.splice(i, 1);
				}
			}
		}
		switch (e.type) {
			case 'decision.created': {
				const id = e.refs.decisionId ?? `decision@${t}`;
				if (!openDecisions.has(id)) openDecisions.set(id, t);
				break;
			}
			case 'decision.status': {
				const id = e.refs.decisionId ?? '';
				const to = dataStr(e, 'to') ?? '';
				const since = openDecisions.get(id);
				if (since !== undefined && DECISION_CLOSED.has(to)) {
					owner.push({ start: since, end: t, label: `Decision ${id} open` });
					openDecisions.delete(id);
				} else if (since === undefined && !DECISION_CLOSED.has(to) && id) {
					openDecisions.set(id, t);
				}
				break;
			}
			case 'request.created':
			case 'request.status': {
				const id = e.refs.requestId ?? 'request';
				const status = e.type === 'request.created' ? (dataStr(e, 'status') ?? 'open') : (dataStr(e, 'to') ?? '');
				if (!status) break;
				closeRequest(id, t);
				requestState.set(id, { status, since: t });
				break;
			}
			case 'workitem.created': {
				const id = e.refs.workItemId;
				if (!id) break;
				const status = dataStr(e, 'status') ?? 'queued';
				const open = !WORK_ITEM_CLOSED.has(status) && !WORK_ITEM_WAITING_ON_TIME.has(status);
				workItems.set(id, { status, since: t, open, ...(e.refs.session ? { target: e.refs.session } : {}) });
				break;
			}
			case 'workitem.status': {
				const id = e.refs.workItemId;
				if (!id) break;
				const to = dataStr(e, 'to') ?? '';
				const wi = workItems.get(id) ?? { status: dataStr(e, 'from') ?? 'queued', since: t, open: false, ...(e.refs.session ? { target: e.refs.session } : {}) };
				if (!workItems.has(id)) workItems.set(id, wi);
				closeWorkItem(id, t);
				wi.status = to;
				wi.since = t;
				if (e.refs.session) wi.target = e.refs.session;
				wi.open = !WORK_ITEM_CLOSED.has(to) && !WORK_ITEM_WAITING_ON_TIME.has(to);
				break;
			}
			case 'message.agent': {
				if (e.refs.session && e.refs.session !== actorSession) pendingMessages.push({ target: e.refs.session, ...(actorSession ? { from: actorSession } : {}), since: t });
				break;
			}
			default:
				break;
		}
	}
	// Still open at the end of the window.
	for (const [id, since] of openDecisions) owner.push({ start: since, end, label: `Decision ${id} open`, stillOpen: true });
	for (const id of requestState.keys()) closeRequest(id, end, true);
	for (const id of workItems.keys()) closeWorkItem(id, end, true);
	for (const m of pendingMessages) {
		agent.push({ start: m.since, end, label: `Message to ${m.target}${m.from ? ` from ${m.from}` : ''} not picked up`, session: m.target, stillOpen: true });
	}

	const workItemStatus = new Map<string, string>();
	for (const [id, wi] of workItems) workItemStatus.set(id, wi.status);
	const requestStatus = new Map<string, string>();
	for (const [id, st] of requestState) requestStatus.set(id, st.status);
	return { owner, agent, workItemStatus, requestStatus };
}

/**
 * Holds covering a moment.
 *
 * @param holds - Holds
 * @param at - Time (ms)
 * @returns Holds open at `at` (a hold still open at the window's end covers every later moment)
 */
function holdsAt(holds: ReadonlyArray<Hold>, at: number): Hold[] {
	return holds.filter((h) => h.start <= at && (h.end > at || h.stillOpen === true));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Compute the autonomy metrics of a trace.
 *
 * @param root - The trace root
 * @param events - Its events, in any order (the root event is ignored)
 * @param options - Stall threshold, clock
 * @returns The metrics
 *
 * @example
 * ```typescript
 * const page = await store.read(id, 0, TRACE_CONSTANTS.MAX_PAGE_SIZE);
 * const m = computeTraceMetrics(page.root, page.events, { stallMinutes: 30 });
 * m.time.waitingOwnerMs; // time the run sat on the owner
 * ```
 */
export function computeTraceMetrics(root: TraceRoot, events: ReadonlyArray<TraceEvent>, options: TraceMetricsOptions = {}): TraceMetrics {
	const stallMinutes = clampStallMinutes(options.stallMinutes ?? defaultStallMinutes());
	const thresholdMs = stallMinutes * 60_000;
	const now = (options.now ?? new Date()).getTime();
	const timed = sortTraceEvents(events);
	const rootAt = Date.parse(root.createdAt);
	const firstAt = timed.length > 0 ? timed[0].t : Number.NaN;
	const start = Number.isFinite(rootAt) ? (Number.isFinite(firstAt) ? Math.min(rootAt, firstAt) : rootAt) : Number.isFinite(firstAt) ? firstAt : now;
	const end = Math.max(start, timed.length > 0 ? timed[timed.length - 1].t : start);

	// --- Time ---------------------------------------------------------------
	const busy = busyPeriods(timed);
	const active = clip(busy.intervals, start, end);
	const holds = collectHolds(timed, end);
	const ownerHeld = clip(holds.owner.map((h): Interval => [h.start, h.end]), start, end);
	const agentHeld = clip(holds.agent.map((h): Interval => [h.start, h.end]), start, end);
	const activeMs = lengthOf(active);
	const ownerOnly = subtractIntervals(ownerHeld, active);
	const waitingOwnerMs = lengthOf(ownerOnly);
	const waitingAgentMs = lengthOf(subtractIntervals(subtractIntervals(agentHeld, active), ownerHeld));
	const wallMs = end - start;
	const idleMs = Math.max(0, wallMs - activeMs - waitingOwnerMs - waitingAgentMs);
	const activeSource: TraceMetrics['time']['activeSource'] =
		busy.explicit === 0 && busy.inferred === 0 ? 'none' : busy.explicit === 0 ? 'inferred' : busy.inferred === 0 ? 'turn_events' : 'mixed';

	// --- Owner touches, rework, interventions, usage --------------------------
	const touches = { answered: 0, approved: 0, sentBack: 0, corrected: 0, manual: 0 };
	const rework = { sendBacks: 0, retries: 0, failedVerifications: 0, subagentSendBacks: 0 };
	const interventions = { nudges: 0, redeliveries: 0, wakes: 0, corrections: 0, guardBlocks: 0, misroutes: 0 };
	const touchTimes: number[] = [];
	const touchEvents: OwnerTouchEvent[] = [];
	const ownerActions: number[] = [];
	const approvalDecisions = new Set<string>();
	const rejectCounts = new Map<string, number>();
	const workItemType = new Map<string, string>();
	const retryCounts = new Map<string, number>();
	const recentOwnerMessages: Array<{ text: string; t: number }> = [];
	let agentSpoke = false;
	const byAgent = new Map<string, UsageBreakdown>();
	const byModel = new Map<string, UsageBreakdown>();
	const agents = new Set<string>();
	let experiment: TraceMetrics['outcome']['experiment'];

	const touch = (kind: OwnerTouchEvent['kind'], t: number): void => {
		touches[kind] += 1;
		touchTimes.push(t);
		if (options.detail) touchEvents.push({ kind, at: new Date(t).toISOString() });
		agentSpoke = false;
	};
	const addUsage = (map: Map<string, UsageBreakdown>, key: string, tokens: { input: number; cachedInput: number; output: number; total: number }, cost: number): void => {
		const row = map.get(key) ?? { key, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
		row.inputTokens += tokens.input;
		row.cachedInputTokens += tokens.cachedInput;
		row.outputTokens += tokens.output;
		row.totalTokens += tokens.total;
		row.costUsd += cost;
		map.set(key, row);
	};

	for (const { e, t } of timed) {
		if (e.actor.kind === 'agent' && e.actor.session) agents.add(e.actor.session);
		switch (e.type) {
			case 'message.outbound':
				if (e.outcome === 'failed') interventions.misroutes += 1;
				else if (e.actor.kind === 'agent') agentSpoke = true;
				break;
			case 'turn.delivered': {
				if (e.refs.session && e.actor.kind !== 'owner') agents.add(e.refs.session);
				if (dataStr(e, 'kind') !== 'owner_message' || e.actor.kind !== 'owner') break;
				if (e.refs.session) agents.add(e.refs.session);
				const text = ownerMessageText(e);
				const dup = recentOwnerMessages.some((m) => m.text === text && t - m.t <= TRACE_CONSTANTS.OWNER_MESSAGE_DEDUPE_MS);
				recentOwnerMessages.push({ text, t });
				if (dup || t - start <= TRACE_CONSTANTS.ROOT_GRACE_MS) break;
				touch(agentSpoke ? 'answered' : 'corrected', t);
				break;
			}
			case 'decision.created': {
				const kind = dataStr(e, 'kind');
				if (e.refs.decisionId && (dataStr(e, 'sensitive') || (kind && APPROVAL_DECISION_KINDS.has(kind)))) approvalDecisions.add(e.refs.decisionId);
				if (e.actor.kind === 'agent') agentSpoke = true;
				break;
			}
			case 'decision.status': {
				const to = dataStr(e, 'to');
				if (e.actor.kind === 'owner' && (to === 'resolved' || to === 'skipped')) {
					touch(e.refs.decisionId && approvalDecisions.has(e.refs.decisionId) ? 'approved' : 'answered', t);
				}
				break;
			}
			case 'request.created': {
				if (e.refs.requestId) rejectCounts.set(e.refs.requestId, 0);
				break;
			}
			case 'request.status': {
				const id = e.refs.requestId ?? 'request';
				const from = dataStr(e, 'from');
				const to = dataStr(e, 'to');
				const accepted = dataStr(e, 'acceptedBy');
				const prevRc = rejectCounts.get(id) ?? 0;
				const rc = e.data && 'rejectCount' in e.data ? dataNum(e, 'rejectCount') : prevRc;
				rejectCounts.set(id, Math.max(prevRc, rc));
				if (to === 'done' && (accepted === 'owner' || (from === 'waiting_confirmation' && !accepted))) touch('approved', t);
				else if (rc > prevRc || (from === 'waiting_confirmation' && to && REQUEST_BACK_TO_WORK.has(to))) {
					touch('sentBack', t);
					rework.sendBacks += 1;
				}
				break;
			}
			case 'workitem.created': {
				if (e.refs.workItemId) {
					workItemType.set(e.refs.workItemId, dataStr(e, 'type') ?? '');
					retryCounts.set(e.refs.workItemId, 0);
				}
				break;
			}
			case 'workitem.status': {
				const id = e.refs.workItemId ?? '';
				const from = dataStr(e, 'from') ?? '';
				const to = dataStr(e, 'to') ?? '';
				const prevRetry = retryCounts.get(id) ?? 0;
				const retry = e.data && 'retryCount' in e.data ? dataNum(e, 'retryCount') : prevRetry;
				retryCounts.set(id, Math.max(prevRetry, retry));
				if ((to === 'queued' && RETRY_FROM.has(from)) || retry > prevRetry) rework.retries += 1;
				if ((from === 'done_by_worker' && to === 'rejected') || (VERIFY_TYPES.has(workItemType.get(id) ?? '') && (to === 'failed' || to === 'rejected'))) {
					rework.failedVerifications += 1;
				}
				break;
			}
			case 'harness.subagent_sendback':
				rework.subagentSendBacks += 1;
				break;
			case 'harness.nudge':
				interventions.nudges += 1;
				break;
			case 'harness.redelivery':
				interventions.redeliveries += 1;
				break;
			case 'harness.wake':
				interventions.wakes += 1;
				break;
			case 'harness.correction':
				interventions.corrections += 1;
				break;
			case 'guard.block':
				interventions.guardBlocks += 1;
				break;
			case 'owner.action':
				ownerActions.push(t);
				break;
			case 'usage': {
				const u = usageOfEvent(e);
				if (!u) break;
				addUsage(byAgent, sessionOfEvent(e) ?? 'unknown', u, u.costUsd);
				addUsage(byModel, dataStr(e, 'model') ?? 'unknown', u, u.costUsd);
				break;
			}
			case 'experiment.event': {
				const id = e.refs.experimentId ?? experiment?.id ?? '';
				const ev = dataStr(e, 'event') ?? '';
				experiment = { ...(experiment ?? {}), id };
				if (ev === 'created' && !experiment.status) experiment.status = 'planned';
				if (ev === 'shipped' || ev === 'baseline_captured') experiment.status = 'running';
				if (ev === 'cancelled') experiment.status = 'cancelled';
				if (ev === 'measured') {
					experiment.status = 'done';
					const m = /measured: (worked|didnt|inconclusive)/.exec(e.summary);
					if (m) experiment.verdict = m[1];
				}
				break;
			}
			default:
				break;
		}
	}
	// A dashboard write next to an owner touch is that touch.
	touches.manual = ownerActions.filter((t) => !touchTimes.some((x) => Math.abs(x - t) <= TRACE_CONSTANTS.OWNER_ACTION_DEDUPE_MS)).length;

	// --- Stalls --------------------------------------------------------------
	const progress = timed.filter(({ e }) => isProgressEvent(e));
	// Busy periods and progress instants, in order (overlaps are fine: the cursor only moves forward).
	const covered: Interval[] = [...active, ...progress.map(({ t }): Interval => [t, t])].sort((x, y) => x[0] - y[0]);
	const gaps: Interval[] = [];
	let cursor = start;
	for (const [a, b] of covered) {
		if (a - cursor > thresholdMs) gaps.push([cursor, a]);
		cursor = Math.max(cursor, b);
	}
	// A gap that runs to the window's end (no progress after it) can still be going on.
	const trailing = end - cursor > thresholdMs;
	if (trailing) gaps.push([cursor, end]);

	const openAtEnd = holdsAt(holds.owner, end).length > 0 || holdsAt(holds.agent, end).length > 0;
	const stalls: TraceStall[] = gaps.map(([a, b]) => classifyStall(a, b, timed, progress, holds));
	if (openAtEnd && now - end > 0) {
		const last = stalls[stalls.length - 1];
		if (trailing && last) {
			last.end = new Date(now).toISOString();
			last.ms = now - Date.parse(last.start);
			last.ongoing = true;
		} else if (now - Math.max(cursor, end) > thresholdMs) {
			const s = classifyStall(Math.max(cursor, end), now, timed, progress, holds);
			s.ongoing = true;
			stalls.push(s);
		}
	}
	const byCause = Object.fromEntries(STALL_CAUSES.map((c) => [c, 0])) as Record<StallCause, number>;
	for (const s of stalls) byCause[s.cause] += 1;
	const kept =
		!options.detail && stalls.length > TRACE_CONSTANTS.METRICS_MAX_STALL_ITEMS
			? [...stalls].sort((x, y) => y.ms - x.ms).slice(0, TRACE_CONSTANTS.METRICS_MAX_STALL_ITEMS).sort((x, y) => x.start.localeCompare(y.start))
			: stalls;

	// --- Outcome -------------------------------------------------------------
	const wiStatuses = [...holds.workItemStatus.values()];
	const workItems = {
		total: wiStatuses.length,
		done: wiStatuses.filter((s) => s === 'done' || s === 'verified' || s === 'done_by_worker').length,
		failed: wiStatuses.filter((s) => s === 'failed' || s === 'rejected').length,
		open: wiStatuses.filter((s) => !WORK_ITEM_CLOSED.has(s)).length,
	};
	const primaryRequest = root.refs.requestId && holds.requestStatus.has(root.refs.requestId) ? root.refs.requestId : [...holds.requestStatus.keys()][0];
	const requestStatus = primaryRequest ? holds.requestStatus.get(primaryRequest) : undefined;
	const state = outcomeState({ requestStatus, experiment, workItems, ownerOpen: holdsAt(holds.owner, end).length > 0, agentOpen: holdsAt(holds.agent, end).length > 0 });

	const sortUsage = (map: Map<string, UsageBreakdown>): UsageBreakdown[] =>
		[...map.values()].map((r) => ({ ...r, costUsd: roundUsd(r.costUsd) })).sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
	const agentRows = sortUsage(byAgent);
	const sum = (k: keyof UsageBreakdown): number => agentRows.reduce((s, r) => s + (r[k] as number), 0);

	const total = (o: Record<string, number>): number => Object.values(o).reduce((s, n) => s + n, 0);
	return {
		traceId: root.traceId,
		window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
		eventCount: timed.length,
		agents: [...agents].sort(),
		time: { wallMs, activeMs, waitingOwnerMs, waitingAgentMs, idleMs, activeSource },
		// `manual` is not collected yet (see TraceMetrics.ownerTouches): not in the total.
		ownerTouches: { ...touches, total: touches.answered + touches.approved + touches.sentBack + touches.corrected },
		rework: { ...rework, total: total(rework) },
		stalls: { thresholdMinutes: stallMinutes, count: stalls.length, totalMs: stalls.reduce((s, x) => s + x.ms, 0), byCause, items: kept },
		interventions: { ...interventions, total: total(interventions) },
		usage: {
			inputTokens: sum('inputTokens'),
			cachedInputTokens: sum('cachedInputTokens'),
			outputTokens: sum('outputTokens'),
			totalTokens: sum('totalTokens'),
			costUsd: roundUsd([...byAgent.values()].reduce((s, r) => s + r.costUsd, 0)),
			byAgent: agentRows,
			byModel: sortUsage(byModel),
		},
		outcome: {
			state,
			...(requestStatus ? { requestStatus } : {}),
			workItems,
			...(experiment ? { experiment } : {}),
		},
		...(options.detail ? { ownerTouchEvents: touchEvents } : {}),
	};
}

/**
 * Round a dollar amount to 1/10 000 (sums of tiny per-turn costs).
 *
 * @param usd - Amount
 * @returns Rounded amount
 */
function roundUsd(usd: number): number {
	return Math.round(usd * 10_000) / 10_000;
}

/**
 * The run's overall state.
 *
 * @param input - Request status, experiment, work items, open holds at the end
 * @returns State
 */
function outcomeState(input: {
	requestStatus?: string;
	experiment?: { status?: string };
	workItems: { total: number; done: number; failed: number; open: number };
	ownerOpen: boolean;
	agentOpen: boolean;
}): TraceOutcomeState {
	const { requestStatus, experiment, workItems } = input;
	if (requestStatus === 'done') return 'done';
	if (requestStatus === 'cancelled') return 'cancelled';
	if (input.ownerOpen || requestStatus === 'waiting_confirmation') return 'waiting_on_owner';
	if (experiment?.status === 'done') return 'done';
	if (experiment?.status === 'cancelled') return 'cancelled';
	if (input.agentOpen || workItems.open > 0 || experiment?.status === 'running' || experiment?.status === 'planned') return 'in_progress';
	if (workItems.total > 0 && workItems.done > 0) return 'done';
	if (workItems.total > 0 && workItems.failed > 0) return 'failed';
	if (workItems.total > 0) return 'cancelled';
	return 'no_open_work';
}

/**
 * Give a stall its cause (the spec's table; first match wins).
 *
 * @param a - Stall start (ms)
 * @param b - Stall end (ms)
 * @param timed - All events, sorted
 * @param progress - Progress events, sorted
 * @param holds - Owner / agent holds
 * @returns The stall
 */
function classifyStall(a: number, b: number, timed: ReadonlyArray<Timed>, progress: ReadonlyArray<Timed>, holds: Holds): TraceStall {
	const base = { start: new Date(a).toISOString(), end: new Date(b).toISOString(), ms: b - a };
	const around = timed.filter(({ t }) => t >= a - TRACE_CONSTANTS.STALL_CAUSE_LOOKBACK_MS && t <= b).map(({ e }) => e);

	const quota = around.find(
		(e) =>
			e.type === 'runtime.blocked' ||
			(e.type === 'harness.nudge' && ['login', 'spend_cap'].includes(dataStr(e, 'reason') ?? '')) ||
			(e.type === 'turn.error' && QUOTA_TEXT.test(e.summary)),
	);
	if (quota) {
		const session = sessionOfEvent(quota);
		return { ...base, cause: 'runtime_quota', detail: quota.summary, ...(session ? { sessions: [session] } : {}) };
	}

	const failed = around.find((e) => (e.type === 'message.outbound' || e.type === 'turn.delivered') && e.outcome === 'failed');
	if (failed) {
		const session = sessionOfEvent(failed);
		return { ...base, cause: 'delivery_failure', detail: failed.summary, ...(session ? { sessions: [session] } : {}) };
	}

	const ownerHolds = holdsAt(holds.owner, a);
	if (ownerHolds.length > 0) return { ...base, cause: 'waiting_on_owner', detail: holdDetail(ownerHolds) };
	const before = [...progress].reverse().find(({ t }) => t <= a);
	const after = progress.find(({ t }) => t >= b);
	if (before?.e.type === 'message.outbound' && before.e.actor.kind === 'agent' && after?.e.actor.kind === 'owner') {
		return { ...base, cause: 'waiting_on_owner', detail: `${before.e.actor.session ?? 'An agent'} spoke to the owner; the owner answered after the gap` };
	}

	const agentHolds = holdsAt(holds.agent, a);
	if (agentHolds.length > 0) {
		const sessions = [...new Set(agentHolds.map((h) => h.session).filter((s): s is string => !!s))];
		return { ...base, cause: 'waiting_on_agent', detail: holdDetail(agentHolds), ...(sessions.length > 0 ? { sessions } : {}) };
	}
	return { ...base, cause: 'nobody_pushing', detail: 'Nothing was open and nobody was working' };
}

/**
 * What held a stall, each distinct reason once ("×3" when repeated).
 *
 * @param holds - Holds open at the stall's start
 * @returns One line
 */
function holdDetail(holds: ReadonlyArray<Hold>): string {
	const counts = new Map<string, number>();
	for (const h of holds) counts.set(h.label, (counts.get(h.label) ?? 0) + 1);
	return [...counts].map(([label, n]) => (n > 1 ? `${label} (×${n})` : label)).join('; ');
}

/**
 * The numbers embedded in list rows.
 *
 * @param m - Full metrics
 * @returns Summary
 */
export function summarizeTraceMetrics(m: TraceMetrics): TraceMetricsSummary {
	return {
		wallMs: m.time.wallMs,
		activeMs: m.time.activeMs,
		waitingOwnerMs: m.time.waitingOwnerMs,
		waitingAgentMs: m.time.waitingAgentMs,
		idleMs: m.time.idleMs,
		ownerTouches: m.ownerTouches.total,
		rework: m.rework.total,
		stalls: m.stalls.count,
		stallMs: m.stalls.totalMs,
		ongoingStall: m.stalls.items.some((s) => s.ongoing === true),
		interventions: m.interventions.total,
		totalTokens: m.usage.totalTokens,
		costUsd: m.usage.costUsd,
		state: m.outcome.state,
	};
}
