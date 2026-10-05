/**
 * Input circuit breaker — stops redelivery storms against an input box the
 * harness will not touch.
 *
 * Why (crewly#1028, ce-vera 2026-10-03/04): Claude Code collapsed the
 * harness's own paste into markers the guard could not attribute, so every
 * delivery was refused (`input_not_ours`). The reconciler's fast loop kept
 * redelivering and waking the agent every few seconds — ~1,100 failed
 * redeliveries and ~1,100 failed wakes in 2h45m — with no backoff and only a
 * generic notice.
 *
 * The rule: once every delivery to an agent has been refused for
 * OPEN_AFTER_MS, the circuit opens. While open, automatic redelivery/wake
 * for that agent is allowed only as a probe, one per window, the window
 * doubling from PROBE_FIRST_MS up to PROBE_MAX_MS. Opening tells the owner
 * once (listener wired in index.ts). A delivery that goes through closes the
 * circuit; outside input into the terminal (the owner acting on it) allows
 * the next probe at once; a session restart forgets it.
 *
 * Module-level and dependency-free (constants only) so the session helper,
 * the input ledger and the reconciler can share it without import cycles.
 * In memory: a restart starts with every circuit closed.
 *
 * @module services/session/input-circuit-breaker
 */

import { INPUT_CIRCUIT_CONSTANTS } from '../../constants.js';

/** What the guard saw on a refusal. */
export interface InputRefusalInfo {
	/** Guard reading: `foreign` (text not ours) or `unknown` (unreadable) */
	state: string;
	/** Characters in the box (never the text) */
	inputLength: number;
}

/** Passed to the listener when a circuit opens. */
export interface InputCircuitOpenInfo extends InputRefusalInfo {
	sessionName: string;
	/** Refusals since the box was first refused */
	refusals: number;
	/** How long every delivery has been refused (ms) */
	blockedForMs: number;
	/** Wait before the first probe (ms) */
	nextProbeInMs: number;
}

/** One open circuit, as reported. */
export interface OpenCircuitView {
	sessionName: string;
	state: string;
	inputLength: number;
	refusals: number;
	blockedForMs: number;
	/** Automatic redeliveries/wakes skipped while open */
	suppressed: number;
	probes: number;
	nextProbeInMs: number;
}

/** Counters since the process started, plus the open circuits. */
export interface InputCircuitStats {
	open: OpenCircuitView[];
	totals: {
		/** Circuits opened */
		opened: number;
		/** Automatic redeliveries/wakes skipped by an open circuit */
		suppressed: number;
		/** Probe attempts let through while open */
		probes: number;
		/** Open circuits closed by a delivery that went through */
		closed: number;
	};
}

interface Circuit {
	since: number;
	refusals: number;
	state: string;
	inputLength: number;
	open: boolean;
	openedAt?: number;
	probes: number;
	nextProbeAt: number;
	suppressed: number;
}

const circuits = new Map<string, Circuit>();
const totals = { opened: 0, suppressed: 0, probes: 0, closed: 0 };
let openListener: ((info: InputCircuitOpenInfo) => void) | null = null;

/**
 * Set who is told when a circuit opens (once per blocked episode).
 *
 * @param listener - The listener, or null
 */
export function setInputCircuitOpenListener(listener: ((info: InputCircuitOpenInfo) => void) | null): void {
	openListener = listener;
}

/**
 * The guard refused a delivery to this session.
 *
 * @param sessionName - The session
 * @param info - What the guard saw
 * @param now - Clock (ms)
 */
export function noteInputRefused(sessionName: string, info: InputRefusalInfo, now: number = Date.now()): void {
	const c = circuits.get(sessionName) ?? {
		since: now,
		refusals: 0,
		state: info.state,
		inputLength: info.inputLength,
		open: false,
		probes: 0,
		nextProbeAt: 0,
		suppressed: 0,
	};
	c.refusals += 1;
	c.state = info.state;
	c.inputLength = info.inputLength;
	circuits.set(sessionName, c);
	if (c.open || now - c.since < INPUT_CIRCUIT_CONSTANTS.OPEN_AFTER_MS) return;
	c.open = true;
	c.openedAt = now;
	c.nextProbeAt = now + INPUT_CIRCUIT_CONSTANTS.PROBE_FIRST_MS;
	totals.opened += 1;
	try {
		openListener?.({
			sessionName,
			state: c.state,
			inputLength: c.inputLength,
			refusals: c.refusals,
			blockedForMs: now - c.since,
			nextProbeInMs: INPUT_CIRCUIT_CONSTANTS.PROBE_FIRST_MS,
		});
	} catch {
		// The notice is best effort; the circuit is open either way.
	}
}

/**
 * A delivery to this session went through: its circuit closes.
 *
 * @param sessionName - The session
 * @param _now - Clock (ms), unused
 */
export function noteInputDelivered(sessionName: string, _now: number = Date.now()): void {
	const c = circuits.get(sessionName);
	if (!c) return;
	if (c.open) totals.closed += 1;
	circuits.delete(sessionName);
}

/**
 * Someone typed into the session's terminal (likely acting on the alert):
 * let the next automatic delivery through at once.
 *
 * @param sessionName - The session
 */
export function noteInputTouched(sessionName: string): void {
	const c = circuits.get(sessionName);
	if (c?.open) c.nextProbeAt = 0;
}

/**
 * Forget a session's circuit (session created, killed or relaunched).
 *
 * @param sessionName - The session
 */
export function forgetInputCircuit(sessionName: string): void {
	circuits.delete(sessionName);
}

/**
 * Whether an automatic redelivery/wake into this session may go ahead. Always
 * true while the circuit is closed. While open, true once per probe window
 * (and the window doubles, up to PROBE_MAX_MS); otherwise false, counted as
 * suppressed.
 *
 * @param sessionName - The session
 * @param now - Clock (ms)
 * @returns True to attempt the delivery
 */
export function shouldAttemptDelivery(sessionName: string, now: number = Date.now()): boolean {
	const c = circuits.get(sessionName);
	if (!c?.open) return true;
	if (now >= c.nextProbeAt) {
		c.probes += 1;
		totals.probes += 1;
		const wait = Math.min(INPUT_CIRCUIT_CONSTANTS.PROBE_FIRST_MS * 2 ** c.probes, INPUT_CIRCUIT_CONSTANTS.PROBE_MAX_MS);
		c.nextProbeAt = now + wait;
		return true;
	}
	c.suppressed += 1;
	totals.suppressed += 1;
	return false;
}

/**
 * Whether a session's circuit is open.
 *
 * @param sessionName - The session
 * @returns True while open
 */
export function isInputCircuitOpen(sessionName: string): boolean {
	return circuits.get(sessionName)?.open === true;
}

/**
 * Open circuits and counters (for /health and diagnostics).
 *
 * @param now - Clock (ms)
 * @returns The stats
 */
export function inputCircuitStats(now: number = Date.now()): InputCircuitStats {
	const open: OpenCircuitView[] = [];
	for (const [sessionName, c] of circuits) {
		if (!c.open) continue;
		open.push({
			sessionName,
			state: c.state,
			inputLength: c.inputLength,
			refusals: c.refusals,
			blockedForMs: now - c.since,
			suppressed: c.suppressed,
			probes: c.probes,
			nextProbeInMs: Math.max(0, c.nextProbeAt - now),
		});
	}
	return { open, totals: { ...totals } };
}

/** Clear every circuit and counter (tests). */
export function resetInputCircuitsForTesting(): void {
	circuits.clear();
	totals.opened = 0;
	totals.suppressed = 0;
	totals.probes = 0;
	totals.closed = 0;
	openListener = null;
}
