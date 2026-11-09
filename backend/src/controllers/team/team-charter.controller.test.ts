import type { Request, Response } from 'express';
import { setTeamCharter } from './team-charter.controller.js';
import { StorageService } from '../../services/core/storage.service.js';
import { TeamRosterService } from '../../services/team-roster/team-roster.service.js';
import * as callerUtils from '../../utils/agent-caller.utils.js';
import type { Team } from '../../types/index.js';

const mockRecordActivity = jest.fn();
jest.mock('../../services/activity/activity-log.service.js', () => ({ recordActivity: (...a: unknown[]) => mockRecordActivity(...a) }));

function makeTeam(): Team {
	return {
		id: 't1',
		name: 'CE',
		description: 'old',
		charter: 'Old charter.',
		members: [
			{ id: 'm-lead', name: 'Owen', role: 'tech-lead', agentId: 'owen-agent', sessionName: '' },
			{ id: 'm-dev', name: 'Vera', role: 'developer', agentId: 'vera-agent', sessionName: '' },
		],
		projectIds: [],
		leaderIds: ['m-lead'],
	} as unknown as Team;
}

function call(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
	return new Promise((resolve) => {
		const out = { status: 200, body: {} as Record<string, unknown> };
		const res = {
			status(c: number) { out.status = c; return this; },
			json(b: Record<string, unknown>) { out.body = b; resolve(out); return this; },
		} as unknown as Response;
		void setTeamCharter({ params: { id: 't1' }, body } as unknown as Request, res);
	});
}

describe('setTeamCharter', () => {
	let team: Team;
	let saveTeam: jest.Mock;
	let caller: jest.SpyInstance;
	let invalidate: jest.SpyInstance;

	beforeEach(() => {
		team = makeTeam();
		saveTeam = jest.fn(async () => undefined);
		jest.spyOn(StorageService, 'getInstance').mockReturnValue({ getTeams: async () => [team], saveTeam } as unknown as StorageService);
		caller = jest.spyOn(callerUtils, 'resolveAgentCaller').mockResolvedValue({});
		invalidate = jest.spyOn(TeamRosterService.prototype, 'invalidate').mockImplementation(() => undefined);
	});
	afterEach(() => jest.restoreAllMocks());

	it('lets the owner write a charter, collapsing whitespace, stamping who and when, and drops the roster cache', async () => {
		const r = await call({ charter: '  Owns   CE.\nTakes bugs. ' });
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ success: true, data: { teamId: 't1', charter: 'Owns CE. Takes bugs.' } });
		expect(saveTeam).toHaveBeenCalledWith(expect.objectContaining({ charter: 'Owns CE. Takes bugs.', charterUpdatedBy: 'owner' }));
		expect(team.charterUpdatedAt).toBeTruthy();
		expect(invalidate).toHaveBeenCalled();
		expect(mockRecordActivity).toHaveBeenCalledWith({ actor: { type: 'owner' }, action: 'team.charter.updated', target: { type: 'team', id: 't1', name: 'CE' }, after: { charter: 'Owns CE. Takes bugs.' } });
	});

	it('lets the lead of the team write it, and records the session', async () => {
		caller.mockResolvedValue({ session: 'owen-agent', role: 'tech-lead' });
		expect((await call({ charter: 'Mine.' })).status).toBe(200);
		expect(team.charterUpdatedBy).toBe('owen-agent');
		expect(mockRecordActivity).toHaveBeenLastCalledWith(expect.objectContaining({ actor: { type: 'agent', id: 'owen-agent' } }));
	});

	it('lets the orchestrator write it', async () => {
		caller.mockResolvedValue({ session: 'crewly-orc', role: 'orchestrator' });
		expect((await call({ charter: 'From orc.' })).status).toBe(200);
		expect(team.charterUpdatedBy).toBe('orchestrator');
	});

	it('refuses a member who is not a lead, and an unidentified caller', async () => {
		caller.mockResolvedValue({ session: 'vera-agent', role: 'developer' });
		expect((await call({ charter: 'Nope.' })).status).toBe(403);
		caller.mockResolvedValue({ anonymous: true });
		expect((await call({ charter: 'Nope.' })).status).toBe(401);
		expect(saveTeam).not.toHaveBeenCalled();
	});

	it('clears the charter on an empty string', async () => {
		const r = await call({ charter: '   ' });
		expect(r.body).toMatchObject({ success: true, data: { charter: null } });
		expect(team.charter).toBeUndefined();
		expect(team.charterUpdatedBy).toBeUndefined();
		expect(saveTeam).toHaveBeenCalled();
	});

	it('rejects a non-string or over-long charter without saving', async () => {
		expect((await call({})).status).toBe(400);
		expect((await call({ charter: 5 })).status).toBe(400);
		const long = await call({ charter: 'x'.repeat(401) });
		expect(long.status).toBe(400);
		expect(String(long.body.error)).toContain('400');
		expect(saveTeam).not.toHaveBeenCalled();
	});

	it('answers 404 for an unknown team', async () => {
		jest.spyOn(StorageService, 'getInstance').mockReturnValue({ getTeams: async () => [], saveTeam } as unknown as StorageService);
		expect((await call({ charter: 'x' })).status).toBe(404);
	});
});
