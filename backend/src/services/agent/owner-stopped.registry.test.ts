/**
 * Tests for the owner-stopped registry.
 */

import {
	clearOwnerStopped,
	AGENT_RESTART_WINDOW_MS,
	isOwnerStopped,
	isRestartAfterAgentStop,
	markOwnerStopped,
	resetOwnerStoppedForTesting,
	stopSource,
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

	it('records who asked for the stop (owner by default, or an agent)', () => {
		expect(stopSource('dev-1')).toBeUndefined();
		markOwnerStopped('dev-1');
		expect(stopSource('dev-1')).toBe('owner');
		markOwnerStopped('dev-2', 'agent');
		expect(stopSource('dev-2')).toBe('agent');
		expect(isOwnerStopped('dev-2')).toBe(true);
		clearOwnerStopped('dev-2');
		expect(stopSource('dev-2')).toBeUndefined();
	});

	it('a start soon after an agent-made stop is a restart; not after an owner stop or once the window passed', () => {
		markOwnerStopped('dev-1', 'agent');
		expect(isRestartAfterAgentStop('dev-1')).toBe(true);
		expect(isRestartAfterAgentStop('dev-1', Date.now() + AGENT_RESTART_WINDOW_MS + 1000)).toBe(false);
		markOwnerStopped('dev-2');
		expect(isRestartAfterAgentStop('dev-2')).toBe(false);
		expect(isRestartAfterAgentStop('dev-3')).toBe(false);
	});

	it('a deliberate stop drops the start-up block: a stopped agent no longer waits on the user', async () => {
		const { recordStartupBlock, startupBlockOf, resetStartupBlocksForTesting } = await import('./startup-block.registry.js');
		recordStartupBlock('dev-1', 'consent_required', 'Accept Bypass Permissions mode.');
		recordStartupBlock('dev-2', 'consent_required', 'Accept Bypass Permissions mode.');
		markOwnerStopped('dev-1');
		expect(startupBlockOf('dev-1')).toBeNull();
		expect(startupBlockOf('dev-2')).not.toBeNull();
		resetStartupBlocksForTesting();
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
