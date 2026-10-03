/**
 * Tests for the run timeline fixtures.
 *
 * @module test/trace.fixtures.test
 */

import { describe, it, expect } from 'vitest';
import { experimentCard, stallGroup, timelineData, traceEvent, traceMetrics, turnGroup, TRACE_ID } from './trace.fixtures';

describe('trace fixtures', () => {
	it('build consistent data', () => {
		expect(traceEvent(5, 'skill.call').ts).toBe('2026-10-03T10:05:00.000Z');
		expect(traceMetrics({ eventCount: 3 }).eventCount).toBe(3);
		expect(turnGroup().events).toHaveLength(4);
		expect(stallGroup().stall?.cause).toBe('waiting_on_owner');
		expect(timelineData().root.traceId).toBe(TRACE_ID);
		expect(experimentCard({ id: 'EXP-9' }).id).toBe('EXP-9');
	});
});
