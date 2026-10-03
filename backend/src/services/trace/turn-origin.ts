/**
 * Turn origin — records turns the harness did not start, and agent actions
 * taken outside any trace.
 *
 * Why (2026-10-03): text that predicted the owner's next message was
 * submitted in an agent's input without any harness delivery. The agent
 * treated it as the owner's approval and posted on LinkedIn as the owner.
 * That turn, and the browser actions it took, appeared in no trace.
 *
 * Two things are recorded:
 *
 * - `turn.unsolicited`: Claude Code's UserPromptSubmit hook fired, but the
 *   harness typed nothing into the session since the last submitted prompt.
 *   The text came from somewhere else (a pre-filled line, a prompt
 *   suggestion, someone typing in the terminal).
 * - Agent browser actions (`skill.call` / `guard.block`) with what was done
 *   and where — never typed text, only its length.
 *
 * Both go to the session's current trace, else its last known trace, else a
 * new `unsolicited` trace, so they are never untraced.
 *
 * @module services/trace/turn-origin
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { getTraceContext } from './trace-context.service.js';
import type { TraceOutcome } from './trace.types.js';

/** Harness writes not yet consumed by a submitted prompt, per session */
const pendingWrites = new Map<string, number>();
/** Last trace each session was seen working in */
const lastSeenTrace = new Map<string, string>();
/** Bound on tracked sessions (oldest dropped first) */
const MAX_SESSIONS = 500;

let logger: ComponentLogger | null = null;

/**
 * Lazy logger (keeps this module import-cheap for the session layer).
 *
 * @returns Logger
 */
function log(): ComponentLogger {
	if (!logger) logger = LoggerService.getInstance().createComponentLogger('TurnOrigin');
	return logger;
}

/**
 * Set a bounded map entry.
 *
 * @param map - Map
 * @param key - Key
 * @param value - Value
 */
function boundedSet<V>(map: Map<string, V>, key: string, value: V): void {
	map.delete(key);
	if (map.size >= MAX_SESSIONS) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
	map.set(key, value);
}

/**
 * Remember the session's current trace, if it has one.
 *
 * @param session - Agent session
 * @returns The current trace id, or null
 */
function rememberCurrent(session: string): string | null {
	try {
		const current = getTraceContext().currentTrace(session);
		if (current) boundedSet(lastSeenTrace, session, current);
		return current;
	} catch {
		return null;
	}
}

/**
 * The trace to record into: current, else last known, else a new
 * `unsolicited` trace bound to the session.
 *
 * @param session - Agent session
 * @param summary - Summary for a new trace
 * @returns Trace id, or null when none could be made
 */
function traceFor(session: string, summary: string): string | null {
	const current = rememberCurrent(session);
	if (current) return current;
	const last = lastSeenTrace.get(session);
	if (last) return last;
	try {
		const started = getTraceContext().startTrace({
			kind: 'unsolicited',
			summary,
			actor: { kind: 'agent', session },
			session,
		});
		if (started) boundedSet(lastSeenTrace, session, started);
		return started;
	} catch {
		return null;
	}
}

/**
 * The harness is about to submit text into a session's input (called by the
 * guarded writer before it presses Enter).
 *
 * @param session - Agent session
 */
export function noteHarnessWrite(session: string): void {
	boundedSet(pendingWrites, session, (pendingWrites.get(session) ?? 0) + 1);
	rememberCurrent(session);
}

/**
 * A prompt was submitted in the session (Claude Code UserPromptSubmit hook).
 * When the harness typed nothing since the last submitted prompt, the turn
 * was not started by a harness delivery: record `turn.unsolicited`.
 *
 * Claude Code may submit several queued harness messages as one prompt, so
 * one submit consumes every pending write.
 *
 * @param session - Agent session
 * @returns True when the turn was unsolicited (and recorded)
 */
export function notePromptSubmitted(session: string): boolean {
	const pending = pendingWrites.get(session) ?? 0;
	if (pending > 0) {
		pendingWrites.delete(session);
		return false;
	}
	const summary = 'Turn not started by a harness delivery (text was already in the input or typed in the terminal)';
	log().warn('Unsolicited turn: a prompt was submitted that the harness did not type', { session });
	const traceId = traceFor(session, summary);
	if (traceId) {
		getTraceContext().record({
			traceId,
			type: 'turn.unsolicited',
			actor: { kind: 'agent', session },
			summary,
			outcome: 'info',
		});
	}
	return true;
}

/** An agent browser action, as recorded in a trace. */
export interface BrowserActionTrace {
	/** Agent session */
	session: string;
	/** Browser tool */
	tool: string;
	/** Tool params (only names and lengths are recorded, never typed text) */
	params?: Record<string, unknown>;
	/** Page URL, when known */
	url?: string;
	/** What happened: ok, failed, or blocked (held / refused) */
	outcome: TraceOutcome;
	/** Why it was held or refused */
	reason?: string;
}

/**
 * Record an agent browser action in the session's trace — always, starting
 * an `unsolicited` trace when the session has none.
 *
 * @param input - The action
 */
export function traceBrowserAction(input: BrowserActionTrace): void {
	try {
		const { session, tool, params, url, outcome, reason } = input;
		const traceId = traceFor(session, `Browser work outside any trace (${tool})`);
		if (!traceId) return;
		const target = ['selector', 'key', 'operation']
			.map((k) => params?.[k])
			.find((v): v is string => typeof v === 'string' && v.trim() !== '');
		const typed = [params?.text, params?.value, params?.code].find((v): v is string => typeof v === 'string');
		let host: string | undefined;
		try {
			host = url ? new URL(url).hostname : undefined;
		} catch {
			host = undefined;
		}
		getTraceContext().record({
			traceId,
			type: outcome === 'blocked' ? 'guard.block' : 'skill.call',
			actor: { kind: 'agent', session },
			summary: `browser ${tool}${target ? ` ${target.slice(0, 80)}` : ''}${host ? ` on ${host}` : ''}${reason ? ` — ${reason}` : ''}`,
			outcome,
			refs: { skill: `browser.${tool}` },
			data: {
				tool,
				...(target ? { target: target.slice(0, 200) } : {}),
				...(host ? { host } : {}),
				...(typed !== undefined ? { typedChars: typed.length } : {}),
				...(typeof params?.x === 'number' && typeof params?.y === 'number' ? { x: params.x, y: params.y } : {}),
				...(reason ? { reason } : {}),
			},
		});
	} catch {
		// Tracing must never affect the action.
	}
}

/**
 * Forget all state (tests).
 */
export function resetTurnOriginForTesting(): void {
	pendingWrites.clear();
	lastSeenTrace.clear();
}
