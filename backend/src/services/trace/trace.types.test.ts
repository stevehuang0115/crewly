/**
 * Tests for run trace types (ids, root kinds, ref keys).
 */

import { isEndedRefStatus, isTraceId, isTraceRootKind, newTraceId, refStatusOfEvent, traceRefKey, TRACE_EVENT_TYPES } from './trace.types.js';

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

	it('knows which statuses are final for each entity kind', () => {
		for (const status of ['done', 'verified', 'cancelled']) expect(isEndedRefStatus('workItem', status)).toBe(true);
		// Review, rework and retry still happen in the run.
		for (const status of ['queued', 'running', 'blocked', 'escalated', 'proposed', 'done_by_worker', 'rejected', 'failed']) expect(isEndedRefStatus('workItem', status)).toBe(false);
		for (const kind of ['ticket', 'request'] as const) {
			expect(isEndedRefStatus(kind, 'done')).toBe(true);
			expect(isEndedRefStatus(kind, 'cancelled')).toBe(true);
			expect(isEndedRefStatus(kind, 'in_progress')).toBe(false);
			expect(isEndedRefStatus(kind, 'awaiting_followup')).toBe(false);
		}
		expect(isEndedRefStatus('decision', 'done')).toBe(false);
		expect(isEndedRefStatus('ticket', undefined)).toBe(false);
	});

	it('reads the entity and new status out of a status event, and nothing from other events', () => {
		expect(refStatusOfEvent({ type: 'ticket.status', refs: { ticketId: 'CE-1', workItemId: 'w' }, data: { to: 'done' } })).toEqual({ kind: 'ticket', id: 'CE-1', status: 'done' });
		expect(refStatusOfEvent({ type: 'workitem.status', refs: { workItemId: 'w' }, data: { to: 'running' } })).toEqual({ kind: 'workItem', id: 'w', status: 'running' });
		expect(refStatusOfEvent({ type: 'request.status', refs: { requestId: 'r' }, data: { to: 'cancelled' } })).toEqual({ kind: 'request', id: 'r', status: 'cancelled' });
		expect(refStatusOfEvent({ type: 'ticket.status', refs: {}, data: { to: 'done' } })).toBeNull();
		expect(refStatusOfEvent({ type: 'ticket.status', refs: { ticketId: 'CE-1' } })).toBeNull();
		expect(refStatusOfEvent({ type: 'skill.call', refs: { ticketId: 'CE-1' }, data: { to: 'done' } })).toBeNull();
	});
});
