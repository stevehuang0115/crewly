/**
 * Tests for the planned-relaunch registry.
 */

import {
	clearPlannedRelaunch,
	clearPlannedStop,
	getPlannedRelaunch,
	isPlannedRelaunch,
	markPlannedRelaunch,
	markPlannedStop,
	resetPlannedRelaunches,
} from './planned-relaunch.registry.js';
import { PLANNED_RELAUNCH_CONSTANTS } from '../../constants.js';

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

	it('a deliberate stop is a short planned window that clears on request or expires (#1464)', () => {
		markPlannedStop('dev-2', 0);
		expect(getPlannedRelaunch('dev-2', 1)).toEqual({
			reason: PLANNED_RELAUNCH_CONSTANTS.STOP_REASON,
			until: PLANNED_RELAUNCH_CONSTANTS.STOP_WINDOW_MS,
		});
		expect(isPlannedRelaunch('dev-2', PLANNED_RELAUNCH_CONSTANTS.STOP_WINDOW_MS)).toBe(false);

		markPlannedStop('dev-3', 0);
		clearPlannedStop('dev-3');
		expect(isPlannedRelaunch('dev-3', 1)).toBe(false);
	});

	it('a stop never shortens or clears a relaunch already planned under the same name', () => {
		markPlannedRelaunch('crewly-orc', 'runtime_fallback', 1000, 0);
		markPlannedStop('crewly-orc', 0);
		expect(getPlannedRelaunch('crewly-orc', 1)).toEqual({ reason: 'runtime_fallback', until: 1000 });
		clearPlannedStop('crewly-orc');
		expect(isPlannedRelaunch('crewly-orc', 999)).toBe(true);
	});
});
