/**
 * Tests for the paused-team index (specs/2026-10-04-team-pause.md).
 */

import type { Team, TeamMember } from '../../types/index.js';
import {
	isPauseActive,
	isSessionPaused,
	isTeamIdPaused,
	isTeamPausedNow,
	listExpiredPauses,
	listKnownTeams,
	listPausedTeams,
	memberSessionKeys,
	notePausedTeam,
	noteTeamDeleted,
	pausedRefusalMessage,
	pausedTeamByRef,
	pausedTeamOfSession,
	resetTeamPauseRegistryForTesting,
	syncPausedTeams,
} from './team-pause.registry.js';

function member(over: Partial<TeamMember> = {}): TeamMember {
	return {
		id: 'aaaaaaaa-1111-2222-3333-444444444444',
		name: 'Leo',
		sessionName: 'crewly-leo-aaaaaaaa',
		role: 'developer',
		systemPrompt: '',
		agentStatus: 'inactive',
		workingStatus: 'idle',
		runtimeType: 'claude-code',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...over,
	} as TeamMember;
}

function team(over: Partial<Team> = {}): Team {
	return {
		id: 'team-crewly',
		name: 'Crewly',
		members: [member()],
		projectIds: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...over,
	};
}

const PAUSE = { pausedAt: '2026-10-04T00:00:00.000Z', by: 'owner' as const };

describe('team-pause.registry', () => {
	beforeEach(() => resetTeamPauseRegistryForTesting());

	it('treats a pause without until as active, and one past its until as over', () => {
		expect(isPauseActive(PAUSE)).toBe(true);
		expect(isPauseActive({ ...PAUSE, until: '2099-01-01T00:00:00.000Z' })).toBe(true);
		expect(isPauseActive({ ...PAUSE, until: '2020-01-01T00:00:00.000Z' })).toBe(false);
		expect(isPauseActive(undefined)).toBe(false);
		expect(isTeamPausedNow(team({ paused: PAUSE }))).toBe(true);
		expect(isTeamPausedNow(team())).toBe(false);
	});

	it('lists every session alias of a member (live session, agent id, derived name)', () => {
		const keys = memberSessionKeys('Crewly Product', member({ sessionName: '', agentId: 'crewly-leo-agent' }));
		expect(keys).toEqual(expect.arrayContaining(['crewly-leo-agent', 'crewly-product-leo-aaaaaaaa']));
		expect(keys).not.toContain('');
	});

	it('indexes paused teams from a full sync and answers by session and team id', () => {
		syncPausedTeams([team({ paused: PAUSE, issueRepo: 'stevehuang0115/crewly' }), team({ id: 'other', name: 'Other', members: [member({ id: 'b', sessionName: 'other-ann' })] })]);
		expect(isTeamIdPaused('team-crewly')).toBe(true);
		expect(isTeamIdPaused('other')).toBe(false);
		expect(isSessionPaused('crewly-leo-aaaaaaaa')).toBe(true);
		expect(isSessionPaused('other-ann')).toBe(false);
		expect(pausedTeamOfSession('crewly-leo-aaaaaaaa')?.issueRepo).toBe('stevehuang0115/crewly');
		expect(pausedTeamByRef('crewly')?.teamId).toBe('team-crewly');
		expect(listPausedTeams().map((t) => t.teamId)).toEqual(['team-crewly']);
		expect(listKnownTeams().map((t) => t.name).sort()).toEqual(['Crewly', 'Other']);
	});

	it('still matches a stopped member (session name cleared) by its derived name', () => {
		syncPausedTeams([team({ paused: PAUSE, members: [member({ sessionName: '' })] })]);
		expect(isSessionPaused('crewly-leo-aaaaaaaa')).toBe(true);
	});

	it('updates on save and forgets on resume and delete', () => {
		notePausedTeam(team({ paused: PAUSE }));
		expect(isSessionPaused('crewly-leo-aaaaaaaa')).toBe(true);
		notePausedTeam(team());
		expect(isSessionPaused('crewly-leo-aaaaaaaa')).toBe(false);
		notePausedTeam(team({ paused: PAUSE }));
		noteTeamDeleted('team-crewly');
		expect(isTeamIdPaused('team-crewly')).toBe(false);
		expect(listKnownTeams()).toEqual([]);
	});

	it('counts an expired pause as resumed at once and lists it for the sweep', () => {
		syncPausedTeams([team({ paused: { ...PAUSE, until: '2020-01-01T00:00:00.000Z' } })]);
		expect(isSessionPaused('crewly-leo-aaaaaaaa')).toBe(false);
		expect(listExpiredPauses().map((t) => t.teamId)).toEqual(['team-crewly']);
	});

	it('tells agents to file an issue in the team repo, else to tell the orc (orc: the owner)', () => {
		expect(pausedRefusalMessage({ teamName: 'Crewly', issueRepo: 'stevehuang0115/crewly' })).toBe(
			'Crewly is paused by the owner. File a GitHub issue instead: `gh issue create -R stevehuang0115/crewly --title "<short title>" --body "<what is needed and why>"`',
		);
		expect(pausedRefusalMessage({ teamName: 'Crewly' })).toBe('Crewly is paused by the owner. Do not hand it work. Tell the orc what you need instead.');
		expect(pausedRefusalMessage({ teamName: 'Crewly' }, { callerIsOrc: true })).toMatch(/tell the owner/);
		expect(pausedRefusalMessage({ teamName: 'Crewly', pause: { ...PAUSE, until: '2026-10-10T00:00:00.000Z' } })).toMatch(/^Crewly is paused by the owner until 2026-10-10T00:00:00.000Z\./);
	});
});
