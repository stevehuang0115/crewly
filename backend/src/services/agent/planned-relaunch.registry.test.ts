/**
 * Tests for the planned-relaunch registry.
 */

import {
	clearPlannedRelaunch,
	getPlannedRelaunch,
	isPlannedRelaunch,
	markPlannedRelaunch,
	resetPlannedRelaunches,
} from './planned-relaunch.registry.js';

describe('planned-relaunch registry', () => {
	afterEach(() => resetPlannedRelaunches());

	it('marks a session for a window and forgets it afterwards', () => {
		markPlannedRelaunch('crewly-orc', 'runtime_fallback', 1000, 0);
		expect(isPlannedRelaunch('crewly-orc', 500)).toBe(true);
		expect(getPlannedRelaunch('crewly-orc', 500)).toEqual({ reason: 'runtime_fallback', until: 1000 });
		expect(isPlannedRelaunch('crewly-orc', 1000)).toBe(false);
		expect(getPlannedRelaunch('crewly-orc', 0)).toBeNull();
	});

	it('extends the window when marked again, and clears on request', () => {
		markPlannedRelaunch('dev-1', 'runtime_fallback', 1000, 0);
		markPlannedRelaunch('dev-1', 'runtime_fallback', 1000, 900);
		expect(isPlannedRelaunch('dev-1', 1500)).toBe(true);
		clearPlannedRelaunch('dev-1');
		expect(isPlannedRelaunch('dev-1', 1500)).toBe(false);
		expect(isPlannedRelaunch('other', 0)).toBe(false);
	});
});
