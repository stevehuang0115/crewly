/**
 * Tests for the owner-stopped registry.
 */

import {
	clearOwnerStopped,
	isOwnerStopped,
	markOwnerStopped,
	resetOwnerStoppedForTesting,
} from './owner-stopped.registry.js';

describe('owner-stopped registry', () => {
	afterEach(() => resetOwnerStoppedForTesting());

	it('remembers a deliberate stop until the agent is started again', () => {
		expect(isOwnerStopped('dev-1')).toBe(false);
		markOwnerStopped('dev-1');
		expect(isOwnerStopped('dev-1')).toBe(true);
		expect(isOwnerStopped('dev-2')).toBe(false);
		clearOwnerStopped('dev-1');
		expect(isOwnerStopped('dev-1')).toBe(false);
	});

	it('ignores an empty session name', () => {
		markOwnerStopped('');
		expect(isOwnerStopped('')).toBe(false);
	});
});
