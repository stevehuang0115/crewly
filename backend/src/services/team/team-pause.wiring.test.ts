/**
 * Tests for the team pause boot wiring (specs/2026-10-04-team-pause.md).
 */

const addInboundInterceptor = jest.fn();
const sendToOwner = jest.fn(async () => true);

jest.mock('../slack/slack-orchestrator-bridge.js', () => ({
	getSlackOrchestratorBridge: () => ({ addInboundInterceptor }),
}));
jest.mock('../slack/slack.service.js', () => ({ getSlackService: () => ({}) }));
jest.mock('../slack/slack-agent-identity.service.js', () => ({ getSlackAgentIdentityService: () => null }));
jest.mock('../slack/slack-relogin-dm.service.js', () => ({
	SlackReloginDmService: jest.fn().mockImplementation(() => ({
		sendToOwner,
		ownerDmScope: () => 'orc',
		replyTargetOf: () => ({}),
	})),
}));
jest.mock('../../controllers/team/team.controller.js', () => ({
	stopTeamMemberGracefully: jest.fn(async () => ({ success: true })),
}));

import type { ApiContext } from '../../controllers/types.js';
import type { Team } from '../../types/index.js';
import { getTeamPauseService, setTeamPauseService } from './team-pause.service.js';
import { isTeamIdPaused, resetTeamPauseRegistryForTesting } from './team-pause.registry.js';
import { startTeamPause } from './team-pause.wiring.js';

describe('startTeamPause', () => {
	afterEach(() => {
		setTeamPauseService(null);
		resetTeamPauseRegistryForTesting();
	});

	it('hydrates the index from storage, installs the service and registers the DM commands', async () => {
		const teams: Team[] = [
			{ id: 't1', name: 'Crewly', members: [], projectIds: [], createdAt: '', updatedAt: '', paused: { pausedAt: '2026-10-04T00:00:00Z', by: 'owner' } },
		];
		const context = { storageService: { getTeams: jest.fn(async () => teams), saveTeam: jest.fn() } } as unknown as ApiContext;
		const logger = { info: jest.fn(), warn: jest.fn() };

		const service = await startTeamPause({ context, logger });

		expect(isTeamIdPaused('t1')).toBe(true);
		expect(getTeamPauseService()).toBe(service);
		expect(addInboundInterceptor).toHaveBeenCalledWith('the team pause commands', expect.any(Function));
		expect(logger.info).toHaveBeenCalledWith('Team pause wired');
	});
});
