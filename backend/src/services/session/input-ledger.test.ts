/**
 * Tests for the input ledger.
 */

import { noteInputRefused, resetInputCircuitsForTesting, shouldAttemptDelivery } from './input-circuit-breaker.js';
import {
	forgetInputLedger,
	harnessPastesSinceOutsideInput,
	keepHarnessPastes,
	keepShownMarkers,
	lastOutsideInputAt,
	noteHarnessPaste,
	noteOutsideInput,
	noteShownMarker,
	resetInputLedgerForTesting,
	sessionsWithHarnessPastes,
	shownMarkers,
} from './input-ledger.js';

describe('input-ledger', () => {
	afterEach(() => resetInputLedgerForTesting());

	it('keeps the harness pastes since the last outside input, oldest first', () => {
		noteHarnessPaste('s', 'a', 1);
		noteHarnessPaste('s', 'b', 2);
		expect(harnessPastesSinceOutsideInput('s').map((p) => p.message)).toEqual(['a', 'b']);
		expect(sessionsWithHarnessPastes()).toEqual(['s']);
		noteOutsideInput('s', 3);
		expect(harnessPastesSinceOutsideInput('s')).toEqual([]);
		expect(lastOutsideInputAt('s')).toBe(3);
		noteHarnessPaste('s', 'c', 4);
		expect(harnessPastesSinceOutsideInput('s').map((p) => p.message)).toEqual(['c']);
	});

	it('remembers at most ten pastes, and forgets on request', () => {
		for (let i = 0; i < 12; i++) noteHarnessPaste('s', `m${i}`, i);
		expect(harnessPastesSinceOutsideInput('s').map((p) => p.message)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11']);
		keepHarnessPastes('s', (p) => p.at >= 10);
		expect(harnessPastesSinceOutsideInput('s').map((p) => p.message)).toEqual(['m10', 'm11']);
		forgetInputLedger('s');
		expect(harnessPastesSinceOutsideInput('s')).toEqual([]);
		expect(sessionsWithHarnessPastes()).toEqual([]);
	});

	it('shown markers survive outside input (their counters are ours) until the box no longer holds them', () => {
		noteShownMarker('s', '[Pasted text #2 +4 lines]', 'a');
		noteShownMarker('s', '[Pasted text #2 +4 lines]', 'a');
		noteOutsideInput('s');
		expect(shownMarkers('s')).toEqual([{ marker: '[Pasted text #2 +4 lines]', message: 'a' }]);
		keepShownMarkers('s', () => false);
		expect(shownMarkers('s')).toEqual([]);
	});

	it('outside input lets an open delivery circuit probe at once (crewly#1028)', () => {
		resetInputCircuitsForTesting();
		noteInputRefused('s', { state: 'foreign', inputLength: 3 }, 0);
		noteInputRefused('s', { state: 'foreign', inputLength: 3 }, 10 * 60_000);
		expect(shouldAttemptDelivery('s', 10 * 60_000 + 1)).toBe(false);
		noteOutsideInput('s');
		expect(shouldAttemptDelivery('s', 10 * 60_000 + 2)).toBe(true);
		resetInputCircuitsForTesting();
	});
});
