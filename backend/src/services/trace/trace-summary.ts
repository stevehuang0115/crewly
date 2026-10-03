/**
 * The compact, context-sized summary of a run trace that the `trace-read`
 * skill prints (specs/2026-10-03-autonomy-metrics.md §trace-read): header,
 * time, owner touches, rework, interventions, cost, stalls with causes, key
 * events and links — never more than `maxChars`. Pure.
 *
 * @module services/trace/trace-summary
 */

import { TRACE_CONSTANTS } from '../../constants.js';
import { sortTraceEvents, type TraceMetrics, type UsageBreakdown } from './trace-metrics.js';
import { formatDuration, STALL_CAUSE_LABELS } from './trace-timeline.js';
import type { TraceEvent, TraceRoot } from './trace.types.js';

/** Where to look at a trace. */
export interface TraceLinks {
	/** Dashboard page with its Timeline tab (relative to the dashboard origin) */
	ui: string;
	/** API with the grouped timeline */
	api: string;
}

/** The summary `GET /api/traces/:id/summary` returns. */
export interface TraceSummary {
	traceId: string;
	text: string;
	links: TraceLinks;
}

/**
 * Links of a trace: the Request page or experiment card when it has one, else
 * the generic trace page.
 *
 * @param root - Trace root
 * @param events - Its events (a request / experiment ref may only be on them)
 * @returns UI and API paths
 */
export function traceLinks(root: TraceRoot, events: ReadonlyArray<TraceEvent> = []): TraceLinks {
	const requestId = root.refs.requestId ?? events.find((e) => e.type === 'request.created' && e.refs.requestId)?.refs.requestId;
	const experimentId = root.refs.experimentId ?? events.find((e) => e.type === 'experiment.event' && e.refs.experimentId)?.refs.experimentId;
	const id = encodeURIComponent(root.traceId);
	const ui = requestId
		? `/tickets/requests/${encodeURIComponent(requestId)}?tab=timeline`
		: experimentId
			? `/tickets/experiments/${encodeURIComponent(experimentId)}?tab=timeline`
			: `/tickets/traces/${id}`;
	return { ui, api: `/api/traces/${id}/timeline` };
}

/** Event types never listed as key events (counted or summed instead). */
const ROUTINE = new Set(['skill.call', 'usage', 'turn.ended', 'trace.root']);

/**
 * How much an event matters for the key-event list (0 = never listed).
 *
 * @param e - Event
 * @returns Score
 */
export function keyEventScore(e: TraceEvent): number {
	if (ROUTINE.has(e.type)) return 0;
	if (e.type === 'turn.delivered') {
		if (e.outcome === 'failed') return 3;
		const kind = String(e.data?.kind ?? '');
		return kind === 'owner_message' ? 3 : kind === 'dispatch' ? 1 : 0;
	}
	if (e.outcome === 'failed' || e.outcome === 'blocked' || e.actor.kind === 'owner') return 3;
	if (/^(request|ticket|decision|experiment|runtime|harness|owner)\./.test(e.type) || e.type === 'turn.error' || e.type === 'trace.truncated') return 2;
	if (e.type === 'workitem.created' || e.type === 'workitem.status') return 2;
	return 1;
}

/**
 * Clock time of an ISO timestamp, with the date when it differs from the start.
 *
 * @param iso - Timestamp
 * @param startDay - Start date (YYYY-MM-DD)
 * @returns "14:05" or "10-04 09:12" (UTC)
 */
function clock(iso: string, startDay: string): string {
	const day = iso.slice(0, 10);
	const time = iso.slice(11, 16);
	return day === startDay ? time : `${day.slice(5)} ${time}`;
}

/**
 * One-line usage breakdown.
 *
 * @param rows - Agents or models, most expensive first
 * @returns "ella 900k $2.50; orc 300k $0.91 (+2 more)"
 */
function breakdown(rows: ReadonlyArray<UsageBreakdown>): string {
	const shown = rows.slice(0, TRACE_CONSTANTS.SUMMARY_MAX_BREAKDOWN).map((r) => `${r.key} ${formatTokens(r.totalTokens)} ${formatUsd(r.costUsd)}`);
	const more = rows.length - shown.length;
	return `${shown.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

/**
 * Tokens in words.
 *
 * @param n - Tokens
 * @returns "1.2M", "900k", "512"
 */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(Math.round(n));
}

/**
 * Dollars in words.
 *
 * @param usd - Amount
 * @returns "$3.41", "<$0.01"
 */
export function formatUsd(usd: number): string {
	if (usd > 0 && usd < 0.01) return '<$0.01';
	return `$${usd.toFixed(2)}`;
}

/** English name of an outcome state. */
const STATE_LABELS: Record<TraceMetrics['outcome']['state'], string> = {
	done: 'done',
	cancelled: 'cancelled',
	failed: 'failed',
	waiting_on_owner: 'waiting on the owner',
	in_progress: 'in progress',
	no_open_work: 'nothing open',
};

/**
 * The fixed part of the summary (everything but the key events).
 *
 * @param root - Root
 * @param m - Metrics
 * @param links - Links
 * @returns Lines
 */
function headLines(root: TraceRoot, m: TraceMetrics, links: TraceLinks): { head: string[]; tail: string[] } {
	const startDay = m.window.start.slice(0, 10);
	const o = m.outcome;
	const outcomeBits = [
		STATE_LABELS[o.state],
		o.requestStatus ? `ticket ${o.requestStatus}` : '',
		o.workItems.total > 0 ? `work items ${o.workItems.done} done / ${o.workItems.failed} failed / ${o.workItems.open} open` : '',
		o.experiment ? `experiment ${o.experiment.id}${o.experiment.status ? ` ${o.experiment.status}` : ''}${o.experiment.verdict ? ` (${o.experiment.verdict})` : ''}` : '',
	].filter(Boolean);
	const t = m.time;
	const tt = m.ownerTouches;
	const r = m.rework;
	const iv = m.interventions;
	const u = m.usage;
	const head = [
		`Trace ${root.traceId} · ${root.kind} · ${root.summary}`,
		`${m.window.start.slice(0, 16).replace('T', ' ')} UTC → ${clock(m.window.end, startDay)} · ${m.eventCount} events · agents: ${m.agents.join(', ') || 'none'}`,
		`Outcome: ${outcomeBits.join(' · ')}`,
		`Time: wall ${formatDuration(t.wallMs)} · active ${formatDuration(t.activeMs)} · waiting on owner ${formatDuration(t.waitingOwnerMs)} · waiting on agent ${formatDuration(t.waitingAgentMs)} · idle ${formatDuration(t.idleMs)}${t.activeSource === 'inferred' ? ' (active time inferred)' : ''}`,
		`Owner touches ${tt.total} (answered ${tt.answered}, approved ${tt.approved}, sent back ${tt.sentBack}, corrected ${tt.corrected}, manual ${tt.manual})`,
		`Rework ${r.total} (send-backs ${r.sendBacks}, retries ${r.retries}, failed verifications ${r.failedVerifications}, subagent send-backs ${r.subagentSendBacks})`,
		`Harness interventions ${iv.total} (nudges ${iv.nudges}, redeliveries ${iv.redeliveries}, wakes ${iv.wakes}, corrections ${iv.corrections}, guard blocks ${iv.guardBlocks}, misroutes ${iv.misroutes})`,
		`Tokens ${formatTokens(u.totalTokens)} · ${formatUsd(u.costUsd)}${u.byAgent.length > 0 ? ` · by agent: ${breakdown(u.byAgent)}` : ''}${u.byModel.length > 0 ? ` · by model: ${breakdown(u.byModel)}` : ''}`,
	];
	const st = m.stalls;
	if (st.count === 0) head.push(`Stalls (> ${st.thresholdMinutes}m): none`);
	else {
		head.push(`Stalls (> ${st.thresholdMinutes}m): ${st.count}, ${formatDuration(st.totalMs)} in total`);
		const shown = [...st.items].sort((a, b) => b.ms - a.ms).slice(0, TRACE_CONSTANTS.SUMMARY_MAX_STALLS).sort((a, b) => a.start.localeCompare(b.start));
		for (const s of shown) {
			const detail = s.detail.length > TRACE_CONSTANTS.SUMMARY_EVENT_CHARS ? `${s.detail.slice(0, TRACE_CONSTANTS.SUMMARY_EVENT_CHARS - 1)}…` : s.detail;
			head.push(`- ${clock(s.start, startDay)}–${s.ongoing ? 'now' : clock(s.end, startDay)} (${formatDuration(s.ms)}) ${STALL_CAUSE_LABELS[s.cause]}: ${detail}`);
		}
		if (st.count > shown.length) head.push(`- … ${st.count - shown.length} shorter stalls`);
	}
	const tail = [`Links: UI ${links.ui} · API ${links.api}`];
	return { head, tail };
}

/**
 * Who did an event, in a few characters.
 *
 * @param e - Event
 * @returns "owner", "ella", "system"
 */
function who(e: TraceEvent): string {
	if (e.actor.kind === 'owner') return 'owner';
	if (e.actor.kind === 'agent') return e.actor.session ?? 'agent';
	return 'system';
}

/**
 * Build the summary text within `maxChars`.
 *
 * @param root - Trace root
 * @param events - All its events
 * @param metrics - Its metrics
 * @param maxChars - Size bound (clamped to READ_MIN_CHARS..READ_MAX_CHARS)
 * @returns Text and links
 *
 * @example
 * ```typescript
 * const { text } = buildTraceSummary(root, events, computeTraceMetrics(root, events), 4000);
 * text.length <= 4000 // always
 * ```
 */
export function buildTraceSummary(root: TraceRoot, events: ReadonlyArray<TraceEvent>, metrics: TraceMetrics, maxChars: number = TRACE_CONSTANTS.READ_DEFAULT_CHARS): TraceSummary {
	const limit = clampSummaryChars(maxChars);
	const links = traceLinks(root, events);
	const { head, tail } = headLines(root, metrics, links);
	const startDay = metrics.window.start.slice(0, 10);
	const timed = sortTraceEvents(events);
	const candidates = timed
		.map(({ e }, i) => ({ e, i, score: keyEventScore(e) }))
		.filter((c) => c.score > 0);
	const line = (e: TraceEvent): string => {
		const summary = e.summary.length > TRACE_CONSTANTS.SUMMARY_EVENT_CHARS ? `${e.summary.slice(0, TRACE_CONSTANTS.SUMMARY_EVENT_CHARS - 1)}…` : e.summary;
		return `${clock(e.ts, startDay)} ${who(e)} ${e.type}${e.outcome === 'failed' || e.outcome === 'blocked' ? ` [${e.outcome}]` : ''}: ${summary}`;
	};

	const fixed = [...head, '', ...tail].join('\n');
	// Room for the key events: what is left after the fixed part and the section header.
	const keyHeader = (n: number): string => `Key events (${n} of ${candidates.length} notable, ${timed.length} in all):`;
	const headerReserve = keyHeader(candidates.length).length + 3;
	let budget = limit - fixed.length - headerReserve;
	const chosen: Array<{ i: number; text: string }> = [];
	const byImportance = [...candidates].sort((a, b) => b.score - a.score || a.i - b.i);
	for (const c of byImportance) {
		const text = line(c.e);
		if (text.length + 1 > budget) continue;
		chosen.push({ i: c.i, text });
		budget -= text.length + 1;
	}
	chosen.sort((a, b) => a.i - b.i);

	const parts = [...head, ''];
	if (candidates.length > 0) {
		parts.push(keyHeader(chosen.length));
		parts.push(...chosen.map((c) => c.text));
		parts.push('');
	}
	parts.push(...tail);
	let text = parts.join('\n');
	if (text.length > limit) text = `${text.slice(0, limit - 1)}…`;
	return { traceId: root.traceId, text, links };
}

/**
 * A caller's summary size within bounds.
 *
 * @param chars - Requested size
 * @returns Size within READ_MIN_CHARS..READ_MAX_CHARS
 */
export function clampSummaryChars(chars: number): number {
	if (!Number.isFinite(chars)) return TRACE_CONSTANTS.READ_DEFAULT_CHARS;
	return Math.min(TRACE_CONSTANTS.READ_MAX_CHARS, Math.max(TRACE_CONSTANTS.READ_MIN_CHARS, Math.floor(chars)));
}
