import {
	MEMORY_STOP_HOLD_CONSTANTS,
	clearMemoryStop,
	isMemoryPressureStop,
	memoryStopHold,
	noteMemoryStop,
	resetMemoryStops,
} from './memory-stop-hold.js';

describe('memory-stop-hold: an agent the machine stopped for memory stays down while pressure lasts (Vera, 2026-10-26)', () => {
	const T0 = Date.parse('2026-10-26T03:40:27Z');

	beforeEach(() => resetMemoryStops());

	it('recognises the two memory-pressure stop reasons and nothing else', () => {
		expect(isMemoryPressureStop('idle stop under memory pressure')).toBe(true);
		expect(isMemoryPressureStop('emergency stop under memory pressure')).toBe(true);
		expect(isMemoryPressureStop('runtime exited')).toBe(false);
		expect(isMemoryPressureStop('stopped to free a running-agent slot')).toBe(false);
	});

	it('holds a noted agent in pressure mode and says why', () => {
		noteMemoryStop('ce-vera', T0);
		const held = memoryStopHold('ce-vera', 'pressure', T0 + 5_000);
		expect(held).toMatch(/stopped for memory 0 min ago/);
		expect(held).toMatch(/still under pressure/);
	});

	it('never holds an agent nobody noted', () => {
		expect(memoryStopHold('ce-owen', 'pressure', T0)).toBeNull();
	});

	it('lets go when the machine leaves pressure mode, and forgets the note', () => {
		noteMemoryStop('ce-vera', T0);
		expect(memoryStopHold('ce-vera', 'normal', T0 + 60_000)).toBeNull();
		// Back in pressure later: the old note does not hold a fresh start.
		expect(memoryStopHold('ce-vera', 'pressure', T0 + 120_000)).toBeNull();
	});

	it('lets go after MAX_HOLD_MS even while pressure persists (wedge guard)', () => {
		noteMemoryStop('ce-vera', T0);
		expect(memoryStopHold('ce-vera', 'pressure', T0 + MEMORY_STOP_HOLD_CONSTANTS.MAX_HOLD_MS - 1)).not.toBeNull();
		expect(memoryStopHold('ce-vera', 'pressure', T0 + MEMORY_STOP_HOLD_CONSTANTS.MAX_HOLD_MS)).toBeNull();
	});

	it('is cleared when the agent starts by another path (an owner start is never held)', () => {
		noteMemoryStop('ce-vera', T0);
		clearMemoryStop('ce-vera');
		expect(memoryStopHold('ce-vera', 'pressure', T0 + 1_000)).toBeNull();
	});

	it('a later note restarts the clock', () => {
		noteMemoryStop('ce-vera', T0);
		noteMemoryStop('ce-vera', T0 + 20 * 60_000);
		expect(memoryStopHold('ce-vera', 'pressure', T0 + MEMORY_STOP_HOLD_CONSTANTS.MAX_HOLD_MS + 60_000)).not.toBeNull();
	});
});
