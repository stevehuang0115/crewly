/**
 * Tests for the owner's "pause <team>" / "resume <team>" DM commands
 * (specs/2026-10-04-team-pause.md).
 */

import type { SlackIncomingMessage } from '../../types/slack.types.js';
import type { Team } from '../../types/index.js';
import { createTeamPauseInterceptor, parseTeamPauseCommand, runTeamPauseCommand, type TeamPauseCommandDeps } from './team-pause-command.js';

const TEAM = { id: 'team-crewly', name: 'Crewly', members: [], projectIds: [], createdAt: '', updatedAt: '' } as Team;

function deps(over: Partial<TeamPauseCommandDeps> = {}): TeamPauseCommandDeps & { reply: jest.Mock; pause: jest.Mock; resume: jest.Mock } {
	return {
		ownerDmScope: (m) => (m.userId === 'U_OWNER' && m.channelId.startsWith('D') ? (m.agentSession && m.agentSession !== 'crewly-orc' ? 'agent' : 'orc') : null),
		replyTargetOf: (m) => ({ channelId: m.channelId }),
		reply: jest.fn(async () => true),
		knownTeams: () => [
			{ id: 'team-crewly', name: 'Crewly' },
			{ id: 'team-mkt', name: 'Marketing' },
		],
		pause: jest.fn(async () => ({
			team: { ...TEAM, paused: { pausedAt: 'x', by: 'owner' as const }, issueRepo: 'stevehuang0115/crewly' },
			alreadyPaused: false,
			stopped: ['Leo'],
			stopFailed: [],
			releasedWorkItems: ['wi'],
			releasedTickets: [],
		})),
		resume: jest.fn(async () => ({ team: TEAM, wasPaused: true })),
		now: () => Date.parse('2026-10-04T00:00:00.000Z'),
		...over,
	} as TeamPauseCommandDeps & { reply: jest.Mock; pause: jest.Mock; resume: jest.Mock };
}

function dm(text: string, over: Partial<SlackIncomingMessage> = {}): SlackIncomingMessage {
	return { text, channelId: 'D123', userId: 'U_OWNER', ts: '1.0', ...over } as SlackIncomingMessage;
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('parseTeamPauseCommand', () => {
	it.each([
		['pause Crewly', { kind: 'pause', target: 'Crewly', explicitTeam: false }],
		['pause team Crewly', { kind: 'pause', target: 'Crewly', explicitTeam: true }],
		['Pause the Crewly team.', { kind: 'pause', target: 'Crewly', explicitTeam: false }],
		['pause Crewly for 3d', { kind: 'pause', target: 'Crewly', explicitTeam: false, forMs: 3 * 86_400_000 }],
		['pause Crewly for 2 hours because harness moved', { kind: 'pause', target: 'Crewly', explicitTeam: false, forMs: 7_200_000, reason: 'harness moved' }],
		['pause Crewly until 2026-10-10T09:00', { kind: 'pause', target: 'Crewly', explicitTeam: false, until: '2026-10-10T09:00' }],
		['pause Crewly: harness session owns it', { kind: 'pause', target: 'Crewly', explicitTeam: false, reason: 'harness session owns it' }],
		['resume Crewly', { kind: 'resume', target: 'Crewly', explicitTeam: false }],
		['unpause team Crewly', { kind: 'resume', target: 'Crewly', explicitTeam: true }],
		['暂停 Crewly', { kind: 'pause', target: 'Crewly', explicitTeam: false }],
		['恢复 Crewly', { kind: 'resume', target: 'Crewly', explicitTeam: false }],
		['取消暂停团队 Crewly', { kind: 'resume', target: 'Crewly', explicitTeam: true }],
	])('%s', (text, expected) => {
		expect(parseTeamPauseCommand(text)).toEqual(expected);
	});

	it('ignores other messages', () => {
		expect(parseTeamPauseCommand('what is the status of Crewly?')).toBeNull();
		expect(parseTeamPauseCommand('')).toBeNull();
		expect(parseTeamPauseCommand(undefined)).toBeNull();
	});
});

describe('createTeamPauseInterceptor', () => {
	it('pauses a named team from the owner\'s orc DM and replies in English', async () => {
		const d = deps();
		const consumed = createTeamPauseInterceptor(d)(dm('pause Crewly for 1d'));
		expect(consumed).toBe(true);
		await flush();
		await flush();
		expect(d.pause).toHaveBeenCalledWith('team-crewly', { until: '2026-10-05T00:00:00.000Z' });
		expect(d.reply.mock.calls[0][0]).toMatch(/^Crewly is paused\. .*GitHub issue in stevehuang0115\/crewly.*Stopped: Leo\..*Say "resume Crewly" to undo\.$/);
	});

	it('resumes a team', async () => {
		const d = deps();
		expect(createTeamPauseInterceptor(d)(dm('resume crewly'))).toBe(true);
		await flush();
		await flush();
		expect(d.resume).toHaveBeenCalledWith('team-crewly');
		expect(d.reply.mock.calls[0][0]).toMatch(/^Crewly is resumed\./);
	});

	it('only takes the owner\'s own messages in the orc DM', () => {
		const d = deps();
		const intercept = createTeamPauseInterceptor(d);
		expect(intercept(dm('pause Crewly', { userId: 'U_SOMEONE' }))).toBe(false);
		expect(intercept(dm('pause Crewly', { channelId: 'C123' }))).toBe(false);
		expect(intercept(dm('pause Crewly', { agentSession: 'crewly-leo' }))).toBe(false);
		expect(d.pause).not.toHaveBeenCalled();
	});

	it('leaves "pause <not a team>" to the orc, but answers an explicit "pause team <x>"', async () => {
		const d = deps();
		const intercept = createTeamPauseInterceptor(d);
		expect(intercept(dm('pause the deploy'))).toBe(false);
		expect(intercept(dm('pause the deploy until tomorrow'))).toBe(false);
		expect(intercept(dm('pause team Nope'))).toBe(true);
		await flush();
		expect(d.reply.mock.calls[0][0]).toBe('No team named "Nope". Teams: Crewly, Marketing.');
		expect(d.pause).not.toHaveBeenCalled();
	});

	it('reports a failed pause to the owner', async () => {
		const d = deps({ pause: jest.fn(async () => { throw new Error('until must be in the future'); }) });
		createTeamPauseInterceptor(d)(dm('pause Crewly until 2020-01-01'));
		await flush();
		await flush();
		expect(d.reply.mock.calls[0][0]).toBe("Couldn't pause Crewly: until must be in the future");
	});
});

describe('runTeamPauseCommand', () => {
	it('says when the team was not paused', async () => {
		const d = deps({ resume: jest.fn(async () => ({ team: TEAM, wasPaused: false })) });
		expect(await runTeamPauseCommand({ kind: 'resume', target: 'Crewly', explicitTeam: false }, 'team-crewly', d)).toBe('Crewly was not paused.');
	});
});
