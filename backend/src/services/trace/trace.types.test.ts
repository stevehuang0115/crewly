/**
 * Tests for run trace types (ids, root kinds, ref keys).
 */

import { isTraceId, isTraceRootKind, newTraceId, traceRefKey, TRACE_EVENT_TYPES } from './trace.types.js';

describe('trace.types', () => {
	it('builds ids with the UTC date and 8 hex chars', () => {
		const id = newTraceId(new Date('2026-10-03T23:30:00Z'));
		expect(id).toMatch(/^tr-20261003-[0-9a-f]{8}$/);
		expect(isTraceId(id)).toBe(true);
	});

	it('makes a different id each time', () => {
		const ids = new Set(Array.from({ length: 50 }, () => newTraceId()));
		expect(ids.size).toBe(50);
	});

	it('rejects anything that could escape the traces folder', () => {
		for (const bad of ['../etc/passwd', 'tr-20261003-zzzzzzzz', 'tr-2026103-abcdef12', 'tr-20261003-abcdef12/..', '', 42, null]) {
			expect(isTraceId(bad)).toBe(false);
		}
	});

	it('knows the root kinds', () => {
		expect(isTraceRootKind('request')).toBe(true);
		expect(isTraceRootKind('experiment')).toBe(true);
		expect(isTraceRootKind('cron')).toBe(false);
	});

	it('keys refs by kind', () => {
		expect(traceRefKey('workItem', 'abc')).toBe('workItem:abc');
	});

	it('lists every event type once', () => {
		expect(new Set(TRACE_EVENT_TYPES).size).toBe(TRACE_EVENT_TYPES.length);
		expect(TRACE_EVENT_TYPES).toContain('usage');
	});
});
