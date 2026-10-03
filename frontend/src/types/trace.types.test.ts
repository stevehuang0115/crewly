/**
 * The trace types are shapes only; this checks the fixtures satisfy them.
 *
 * @module types/trace.types.test
 */

import { describe, it, expect } from 'vitest';
import type { TraceRefParam, TraceTimelineData } from './trace.types';
import { timelineData } from '../test/trace.fixtures';

describe('trace types', () => {
	it('describe the timeline response', () => {
		const data: TraceTimelineData = timelineData();
		const param: TraceRefParam = 'requestId';
		expect(data.groups.map((g) => g.kind)).toEqual(['turn', 'stall', 'owner']);
		expect(param).toBe('requestId');
	});
});
