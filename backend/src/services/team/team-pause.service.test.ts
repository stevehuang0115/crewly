/**
 * Tests for TeamPauseService (specs/2026-10-04-team-pause.md), on a real
 * StorageService in a temporary CREWLY_HOME — so restart persistence is the
 * real file round trip.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Team, TeamMember } from '../../types/index.js';
import { StorageService } from '../core/storage.service.js';
import { isOwnerStopped, markOwnerStopped, resetOwnerStoppedForTesting } from '../agent/owner-stopped.registry.js';
import { isSessionPaused, isTeamIdPaused, resetTeamPauseRegistryForTesting } from './team-pause.registry.js';
import { TeamPauseError, TeamPauseService, findTeamByRef } from './team-pause.service.js';

function member(over: Partial<TeamMember> = {}): TeamMember {
	return {
		id: 'aaaaaaaa-1111-2222-3333-444444444444',
		name: 'Leo',
		sessionName: 'crewly-leo-aaaaaaaa',
		role: 'developer',
		systemPrompt: '',
		agentStatus: 'active',
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
		members: [member(), member({ id: 'bbbbbbbb-0000-0000-0000-000000000000', name: 'Mia', sessionName: '' })],
		projectIds: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...over,
	};
}

describe('TeamPauseService', () => {
	let home: string;
	let storage: StorageService;
	let stopMember: jest.Mock;
	let releaseWorkItems: jest.Mock;
	let releaseTickets: jest.Mock;
	let notifyOwner: jest.Mock;
	let now: number;

	const build = (): TeamPauseService =>
		new TeamPauseService({ storage, stopMember, releaseWorkItems, releaseTickets, notifyOwner, now: () => now });

	beforeEach(async () => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-team-pause-'));
		storage = new StorageService(home);
		resetTeamPauseRegistryForTesting();
		resetOwnerStoppedForTesting();
		now = Date.parse('2026-10-04T12:00:00.000Z');
		stopMember = jest.fn(async (t: Team, m: TeamMember) => {
			markOwnerStopped(m.sessionName);
			m.sessionName = '';
			await storage.saveTeam(t);
			return { success: true };
		});
		releaseWorkItems = jest.fn(async () => ['wi-1']);
		releaseTickets = jest.fn(async () => ['Crewly/T-1']);
		notifyOwner = jest.fn(async () => true);
		await storage.saveTeam(team({ issueRepo: 'stevehuang0115/crewly' }));
		await storage.saveTeam(team({ id: 'team-other', name: 'Marketing', members: [member({ id: 'cccccccc-0000-0000-0000-000000000000', name: 'Ann', sessionName: 'marketing-ann' })] }));
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	it('pauses: stores the pause, stops running members, releases unstarted work', async () => {
		const out = await build().pause('Crewly', { reason: 'harness work moved', until: '2026-10-06T00:00:00.000Z' });
		expect(out.alreadyPaused).toBe(false);
		expect(out.stopped).toEqual(['Leo']);
		expect(stopMember).toHaveBeenCalledTimes(1); // Mia had no session
		expect(out.releasedWorkItems).toEqual(['wi-1']);
		expect(out.releasedTickets).toEqual(['Crewly/T-1']);
		const sessions = releaseWorkItems.mock.calls[0][0] as Set<string>;
		expect(sessions.has('crewly-leo-aaaaaaaa')).toBe(true);
		expect(sessions.has('crewly-mia-bbbbbbbb')).toBe(true);

		const stored = (await storage.getTeams()).find((t) => t.id === 'team-crewly');
		expect(stored?.paused).toEqual({ pausedAt: '2026-10-04T12:00:00.000Z', by: 'owner', reason: 'harness work moved', until: '2026-10-06T00:00:00.000Z' });
		expect(stored?.issueRepo).toBe('stevehuang0115/crewly');
		expect(isTeamIdPaused('team-crewly')).toBe(true);
		expect(isSessionPaused('crewly-leo-aaaaaaaa')).toBe(true);
		expect(isTeamIdPaused('team-other')).toBe(false);
	});

	it('survives a restart: a fresh StorageService on the same home sees the pause', async () => {
		await build().pause('team-crewly');
		resetTeamPauseRegistryForTesting();
		resetOwnerStoppedForTesting();
		expect(isSessionPaused('crewly-leo-aaaaaaaa')).toBe(false);

		const afterRestart = new StorageService(home);
		await afterRestart.getTeams(); // boot read rebuilds the index
		expect(isTeamIdPaused('team-crewly')).toBe(true);
		expect(isSessionPaused('crewly-leo-aaaaaaaa')).toBe(true);
		// The owner-stopped rule holds across the restart through the pause.
		expect(isOwnerStopped('crewly-leo-aaaaaaaa')).toBe(true);
	});

	it('keeps paused/issueRepo through an ordinary read-modify-save of the team', async () => {
		await build().pause('Crewly');
		const t = (await storage.getTeams()).find((x) => x.id === 'team-crewly') as Team;
		t.description = 'edited';
		await storage.saveTeam(t);
		const again = (await storage.getTeams()).find((x) => x.id === 'team-crewly');
		expect(again?.paused?.by).toBe('owner');
		expect(again?.issueRepo).toBe('stevehuang0115/crewly');
	});

	it('pausing a paused team updates reason/until and keeps pausedAt', async () => {
		const svc = build();
		await svc.pause('Crewly', { reason: 'a' });
		now += 60_000;
		const out = await svc.pause('Crewly', { reason: 'b' });
		expect(out.alreadyPaused).toBe(true);
		expect(out.team.paused).toEqual({ pausedAt: '2026-10-04T12:00:00.000Z', by: 'owner', reason: 'b' });
	});

	it('rejects bad input and unknown teams', async () => {
		const svc = build();
		await expect(svc.pause('Crewly', { until: 'not a date' })).rejects.toThrow(TeamPauseError);
		await expect(svc.pause('Crewly', { until: '2020-01-01T00:00:00Z' })).rejects.toThrow(/future/);
		await expect(svc.pause('Crewly', { reason: 'x'.repeat(501) })).rejects.toThrow(/too long/);
		await expect(svc.pause('Nope')).rejects.toMatchObject({ status: 404 });
	});

	it('resumes: clears the pause and the owner-stopped marks, starts nobody', async () => {
		const svc = build();
		await svc.pause('Crewly');
		expect(isOwnerStopped('crewly-leo-aaaaaaaa')).toBe(true);
		const out = await svc.resume('Crewly');
		expect(out.wasPaused).toBe(true);
		expect(isTeamIdPaused('team-crewly')).toBe(false);
		expect(isOwnerStopped('crewly-leo-aaaaaaaa')).toBe(false);
		expect((await storage.getTeams()).find((t) => t.id === 'team-crewly')?.paused).toBeUndefined();
		expect((await svc.resume('Crewly')).wasPaused).toBe(false);
	});

	it('auto-resumes a pause whose until has passed and tells the owner', async () => {
		const svc = build();
		await svc.pause('Crewly', { until: '2026-10-04T13:00:00.000Z' });
		expect(await svc.sweepExpired()).toEqual([]);
		now = Date.parse('2026-10-04T13:00:01.000Z');
		// In force no longer, even before the sweep clears storage.
		expect(isSessionPaused('crewly-leo-aaaaaaaa')).toBe(false);
		expect(await svc.sweepExpired()).toEqual(['Crewly']);
		expect((await storage.getTeams()).find((t) => t.id === 'team-crewly')?.paused).toBeUndefined();
		expect(notifyOwner).toHaveBeenCalledWith(expect.stringContaining('Crewly is no longer paused'));
	});

	it('reports a member it could not stop, and a failed release does not fail the pause', async () => {
		stopMember.mockResolvedValueOnce({ success: false, error: 'pty gone' });
		releaseTickets.mockRejectedValueOnce(new Error('disk'));
		const out = await build().pause('Crewly');
		expect(out.stopFailed).toEqual([{ member: 'Leo', error: 'pty gone' }]);
		expect(out.releasedTickets).toEqual([]);
		expect(isTeamIdPaused('team-crewly')).toBe(true);
	});

	it('resolves teams by id, name, "<name> team" and a unique prefix', () => {
		const teams = [team(), team({ id: 'mkt', name: 'Marketing' }), team({ id: 'mob', name: 'Mobile' })];
		expect(findTeamByRef(teams, 'team-crewly')?.id).toBe('team-crewly');
		expect(findTeamByRef(teams, 'crewly')?.id).toBe('team-crewly');
		expect(findTeamByRef(teams, 'team Crewly')?.id).toBe('team-crewly');
		expect(findTeamByRef(teams, 'mark')?.id).toBe('mkt');
		expect(findTeamByRef(teams, 'm')).toBeNull(); // ambiguous
		expect(findTeamByRef(teams, 'deploy')).toBeNull();
	});
});
