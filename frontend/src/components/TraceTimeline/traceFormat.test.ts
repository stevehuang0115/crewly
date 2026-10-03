/**
 * Tests for the run timeline formatting helpers.
 */

import { describe, it, expect } from 'vitest';
import { actorLabel, eventLabel, formatClock, formatDuration, formatTokenCount, formatUsd, OUTCOME_STATE_LABELS, STALL_CAUSE_LABELS } from './traceFormat';

describe('traceFormat', () => {
	it('formats durations', () => {
		expect(formatDuration(-5)).toBe('<1m');
		expect(formatDuration(59_000)).toBe('<1m');
		expect(formatDuration(35 * 60_000)).toBe('35m');
		expect(formatDuration(120 * 60_000)).toBe('2h');
		expect(formatDuration(252 * 60_000)).toBe('4h 12m');
		expect(formatDuration(27 * 3_600_000)).toBe('1d 3h');
		expect(formatDuration(48 * 3_600_000)).toBe('2d');
	});

	it('formats tokens and dollars', () => {
		expect(formatTokenCount(512)).toBe('512');
		expect(formatTokenCount(34_400)).toBe('34k');
		expect(formatTokenCount(1_250_000)).toBe('1.3M');
		expect(formatUsd(0)).toBe('$0.00');
		expect(formatUsd(0.004)).toBe('<$0.01');
		expect(formatUsd(1.234)).toBe('$1.23');
	});

	it('shows the day only when it is not today', () => {
		const now = new Date('2026-10-03T12:00:00');
		expect(formatClock(new Date('2026-10-03T09:05:00').toISOString(), now)).toMatch(/09:05/);
		expect(formatClock(new Date('2026-10-01T09:05:00').toISOString(), now)).toMatch(/Oct.*1.*09:05|1.*Oct.*09:05/);
		expect(formatClock('nope', now)).toBe('');
	});

	it('names events, actors, causes and states in English', () => {
		expect(eventLabel('guard.block')).toBe('Refused');
		expect(eventLabel('owner.action')).toBe('Your action');
		expect(eventLabel('custom.type')).toBe('custom.type');
		expect(actorLabel({ actor: { kind: 'owner' } })).toBe('You');
		expect(actorLabel({ actor: { kind: 'agent', session: 'ella' } })).toBe('ella');
		expect(actorLabel({ actor: { kind: 'system' } })).toBe('Crewly');
		expect(STALL_CAUSE_LABELS.waiting_on_owner).toBe('waiting on you');
		expect(OUTCOME_STATE_LABELS.no_open_work).toBe('Nothing open');
	});
});
