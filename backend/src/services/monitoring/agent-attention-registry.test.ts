/**
 * Tests for the waiting_on_human registry (#815).
 */

import {
	clearWaiting,
	getWaiting,
	listWaiting,
	markWaiting,
	resetWaitingRegistry,
} from './agent-attention-registry.js';

describe('agent-attention-registry', () => {
	beforeEach(() => resetWaitingRegistry());

	it('starts a wait and reports it as new', () => {
		expect(markWaiting({ sessionName: 's1', kind: 'permission', since: '2026-09-26T10:00:00Z', evidence: ['e'] })).toBe(true);
		expect(getWaiting('s1')?.kind).toBe('permission');
		expect(listWaiting()).toHaveLength(1);
	});

	it('keeps the original since across polls, updating kind and evidence', () => {
		markWaiting({ sessionName: 's1', kind: 'menu', since: '2026-09-26T10:00:00Z', evidence: ['a'] });
		expect(markWaiting({ sessionName: 's1', kind: 'permission', since: '2026-09-26T10:05:00Z', evidence: ['b'] })).toBe(false);
		const e = getWaiting('s1');
		expect(e?.since).toBe('2026-09-26T10:00:00Z');
		expect(e?.kind).toBe('permission');
		expect(e?.evidence).toEqual(['b']);
	});

	it('clears a wait and returns what was cleared', () => {
		markWaiting({ sessionName: 's1', kind: 'trust', since: 'x', evidence: [] });
		expect(clearWaiting('s1')?.kind).toBe('trust');
		expect(getWaiting('s1')).toBeUndefined();
		expect(clearWaiting('s1')).toBeUndefined();
	});
});
