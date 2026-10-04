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

describe('owner-stopped registry — team pause (specs/2026-10-04-team-pause.md)', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const registry = require('../team/team-pause.registry.js') as typeof import('../team/team-pause.registry.js');
	const team = {
		id: 'team-p',
		name: 'Crewly',
		projectIds: [],
		createdAt: '2026-01-01',
		updatedAt: '2026-01-01',
		members: [{ id: 'm1', name: 'Leo', sessionName: 'crewly-leo', agentId: 'crewly-leo' }] as never,
	};

	afterEach(() => {
		registry.resetTeamPauseRegistryForTesting();
		resetOwnerStoppedForTesting();
	});

	it('counts a paused team\'s member as owner-stopped until the team is resumed', () => {
		registry.notePausedTeam({ ...team, paused: { pausedAt: '2026-10-04T00:00:00.000Z', by: 'owner' } });
		expect(isOwnerStopped('crewly-leo')).toBe(true);
		expect(isOwnerStopped('someone-else')).toBe(false);
		// Starting the member (clearing the stop mark) does not lift the pause.
		clearOwnerStopped('crewly-leo');
		expect(isOwnerStopped('crewly-leo')).toBe(true);
		registry.notePausedTeam(team); // resumed
		expect(isOwnerStopped('crewly-leo')).toBe(false);
	});
});
