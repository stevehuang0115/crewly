/**
 * Tests for the input circuit breaker (crewly#1028: ~1,100 failed
 * redeliveries + wakes in 2h45m against one blocked input box).
 */

import { INPUT_CIRCUIT_CONSTANTS } from '../../constants.js';
import {
	forgetInputCircuit,
	inputCircuitStats,
	isInputCircuitOpen,
	noteInputDelivered,
	noteInputRefused,
	noteInputTouched,
	resetInputCircuitsForTesting,
	setInputCircuitOpenListener,
	shouldAttemptDelivery,
	type InputCircuitOpenInfo,
} from './input-circuit-breaker.js';

const S = 'ce-vera-d8f94e9c';
const FOREIGN = { state: 'foreign', inputLength: 52 };
const MIN = 60 * 1000;

describe('input circuit breaker', () => {
	let opened: InputCircuitOpenInfo[];
	beforeEach(() => {
		resetInputCircuitsForTesting();
		opened = [];
		setInputCircuitOpenListener((info) => opened.push(info));
	});
	afterAll(() => resetInputCircuitsForTesting());

	/** Refuse every 10 s (the reconciler fast loop) from `from` for `ms`. */
	function refuseFor(from: number, ms: number): number {
		let t = from;
		for (; t <= from + ms; t += 10_000) noteInputRefused(S, FOREIGN, t);
		return t;
	}

	it('stays closed (every attempt allowed) until refusals have lasted OPEN_AFTER_MS', () => {
		refuseFor(0, INPUT_CIRCUIT_CONSTANTS.OPEN_AFTER_MS - 10_000);
		expect(isInputCircuitOpen(S)).toBe(false);
		expect(shouldAttemptDelivery(S, INPUT_CIRCUIT_CONSTANTS.OPEN_AFTER_MS - 1)).toBe(true);
		expect(opened).toEqual([]);
	});

	it('opens once, telling the listener once with the agent and what blocks it', () => {
		refuseFor(0, 30 * MIN);
		expect(isInputCircuitOpen(S)).toBe(true);
		expect(opened).toHaveLength(1);
		expect(opened[0]).toMatchObject({ sessionName: S, state: 'foreign', inputLength: 52, nextProbeInMs: INPUT_CIRCUIT_CONSTANTS.PROBE_FIRST_MS });
		expect(opened[0].blockedForMs).toBeGreaterThanOrEqual(INPUT_CIRCUIT_CONSTANTS.OPEN_AFTER_MS);
		expect(inputCircuitStats(30 * MIN).totals.opened).toBe(1);
	});

	it('the incident shape: 2h45m of 10 s attempts become a handful of probes, backing off to PROBE_MAX_MS', () => {
		const open = INPUT_CIRCUIT_CONSTANTS.OPEN_AFTER_MS;
		refuseFor(0, open);
		let allowed = 0;
		let skipped = 0;
		const gaps: number[] = [];
		let last = open;
		for (let t = open; t <= 165 * MIN; t += 10_000) {
			if (shouldAttemptDelivery(S, t)) {
				allowed++;
				gaps.push(t - last);
				last = t;
				noteInputRefused(S, FOREIGN, t); // the probe is refused too
			} else skipped++;
		}
		expect(allowed).toBeLessThan(20);
		expect(skipped).toBeGreaterThan(900);
		// Doubling gaps, capped.
		expect(Math.max(...gaps)).toBeLessThanOrEqual(INPUT_CIRCUIT_CONSTANTS.PROBE_MAX_MS + 10_000);
		expect(gaps.slice(-3).every((g) => g >= INPUT_CIRCUIT_CONSTANTS.PROBE_MAX_MS)).toBe(true);
		const stats = inputCircuitStats(165 * MIN);
		expect(stats.totals.suppressed).toBe(skipped);
		expect(stats.totals.probes).toBe(allowed);
		expect(stats.open).toEqual([expect.objectContaining({ sessionName: S, suppressed: skipped, probes: allowed })]);
		expect(opened).toHaveLength(1);
	});

	it('a delivery that goes through closes it (and is counted); the next episode alerts again', () => {
		refuseFor(0, 10 * MIN);
		noteInputDelivered(S);
		expect(isInputCircuitOpen(S)).toBe(false);
		expect(shouldAttemptDelivery(S, 10 * MIN + 1)).toBe(true);
		expect(inputCircuitStats().totals.closed).toBe(1);
		refuseFor(20 * MIN, 10 * MIN);
		expect(opened).toHaveLength(2);
	});

	it('outside input (someone acting on the terminal) lets the next probe through at once', () => {
		const t = refuseFor(0, 10 * MIN);
		expect(shouldAttemptDelivery(S, t)).toBe(true); // first probe due
		expect(shouldAttemptDelivery(S, t + 1000)).toBe(false);
		noteInputTouched(S);
		expect(shouldAttemptDelivery(S, t + 2000)).toBe(true);
	});

	it('a session restart forgets it; other sessions are unaffected', () => {
		refuseFor(0, 10 * MIN);
		expect(shouldAttemptDelivery('other-agent', 10 * MIN)).toBe(true);
		forgetInputCircuit(S);
		expect(isInputCircuitOpen(S)).toBe(false);
		expect(inputCircuitStats().open).toEqual([]);
	});

	it('a throwing listener does not break the breaker', () => {
		setInputCircuitOpenListener(() => {
			throw new Error('notify failed');
		});
		expect(() => refuseFor(0, 10 * MIN)).not.toThrow();
		expect(isInputCircuitOpen(S)).toBe(true);
	});
});
