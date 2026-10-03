/**
 * Formatting for the run timeline: durations, tokens, dollars, clock times
 * and the English names of event types, stall causes and run states.
 *
 * @module components/TraceTimeline/traceFormat
 */

import type { StallCause, TraceEvent, TraceOutcomeState } from '../../types/trace.types';

/**
 * A duration in words.
 *
 * @param ms - Milliseconds
 * @returns "2d 3h", "4h 12m", "35m", "<1m"
 */
export function formatDuration(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 1) return '<1m';
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	return `${mins}m`;
}

/**
 * Tokens in words.
 *
 * @param n - Tokens
 * @returns "1.2M", "34k", "512"
 */
export function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(Math.round(n));
}

/**
 * Dollars in words.
 *
 * @param usd - Amount
 * @returns "$3.41", "<$0.01", "$0.00"
 */
export function formatUsd(usd: number): string {
	if (usd > 0 && usd < 0.01) return '<$0.01';
	return `$${usd.toFixed(2)}`;
}

/**
 * Local clock time of a timestamp, with the day when it is not today.
 *
 * @param iso - Timestamp
 * @param now - Today (for tests)
 * @returns "14:05" or "Oct 4, 09:12"
 */
export function formatClock(iso: string, now: Date = new Date()): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
	if (d.toDateString() === now.toDateString()) return time;
	return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** English names of stall causes. */
export const STALL_CAUSE_LABELS: Record<StallCause, string> = {
	runtime_quota: 'runtime out of usage or signed out',
	delivery_failure: 'a message was not delivered',
	waiting_on_owner: 'waiting on you',
	waiting_on_agent: 'waiting on an agent',
	nobody_pushing: 'nobody pushing',
};

/** English names of run states. */
export const OUTCOME_STATE_LABELS: Record<TraceOutcomeState, string> = {
	done: 'Done',
	cancelled: 'Cancelled',
	failed: 'Failed',
	waiting_on_owner: 'Waiting on you',
	in_progress: 'In progress',
	no_open_work: 'Nothing open',
};

/** English names of event types. */
const EVENT_LABELS: Record<string, string> = {
	'trace.root': 'Started',
	'trace.truncated': 'Trace full',
	'request.created': 'Ticket created',
	'request.status': 'Ticket status',
	'ticket.created': 'Project ticket',
	'workitem.created': 'Work item',
	'workitem.status': 'Work item status',
	'turn.delivered': 'Delivered',
	'turn.error': 'Turn failed',
	'turn.ended': 'Turn ended',
	'message.agent': 'Agent message',
	'skill.call': 'Skill call',
	'guard.block': 'Refused',
	error: 'Error',
	'message.outbound': 'Reply',
	'status.routed': 'Status report',
	'decision.created': 'Decision asked',
	'decision.status': 'Decision',
	'harness.redelivery': 'Redelivered',
	'harness.wake': 'Woken',
	'harness.correction': 'Corrected',
	'harness.nudge': 'Nudged',
	'harness.subagent_sendback': 'Subagent sent back',
	'experiment.event': 'Experiment',
	usage: 'Tokens',
	'runtime.blocked': 'Runtime blocked',
	'owner.action': 'Your action',
	'autopilot.action': 'Autopilot',
	'ticket.status': 'Ticket status',
};

/**
 * English name of an event type.
 *
 * @param type - Event type
 * @returns Label (the type itself when unknown)
 */
export function eventLabel(type: string): string {
	return EVENT_LABELS[type] ?? type;
}

/** Event types folded into one summary line inside a group (details on "Show all"). */
export const ROUTINE_EVENT_TYPES: ReadonlySet<string> = new Set(['skill.call', 'usage', 'turn.ended']);

/**
 * Who did an event, for display.
 *
 * @param e - Event
 * @returns "You", the agent session, or "Crewly"
 */
export function actorLabel(e: Pick<TraceEvent, 'actor'>): string {
	if (e.actor.kind === 'owner') return 'You';
	if (e.actor.kind === 'agent') return e.actor.session ?? 'Agent';
	return 'Crewly';
}
