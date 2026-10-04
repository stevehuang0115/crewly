/**
 * Tests for the team pause owner controls and the agent filter on
 * `GET /api/teams` (specs/2026-10-04-team-pause.md).
 */

import type { Request, Response } from 'express';
import type { Team } from '../../types/index.js';
import type { ApiContext } from '../types.js';
import { setCallerIdentity, type CallerIdentity } from '../../middleware/caller-identity.middleware.js';
import { markOwner } from '../../middleware/caller-identity.testing.js';
import { setTeamPauseService, TeamPauseError, type TeamPauseService } from '../../services/team/team-pause.service.js';
import { filterTeamsBodyForAgent, hidePausedTeamsFromAgents, pauseTeamHandler, resumeTeamHandler } from './team-pause.controller.js';

const PAUSED: Team = {
	id: 'team-crewly',
	name: 'Crewly',
	members: [{ id: 'aaaaaaaa-1', name: 'Leo', sessionName: 'crewly-leo', role: 'developer' } as Team['members'][number]],
	projectIds: [],
	createdAt: '',
	updatedAt: '',
	paused: { pausedAt: '2026-10-04T00:00:00.000Z', by: 'owner' },
};
const OPEN: Team = { ...PAUSED, id: 'team-mkt', name: 'Marketing', paused: undefined, members: [{ id: 'b', name: 'Ann', sessionName: 'mkt-ann', role: 'developer' } as Team['members'][number]] };

type TestRes = Response & { statusCode: number; body: unknown };

function res(): TestRes {
	const r = { statusCode: 200, body: undefined as unknown } as unknown as TestRes;
	const self = r as unknown as Record<string, unknown>;
	self.status = jest.fn((code: number) => {
		r.statusCode = code;
		return r;
	});
	self.json = jest.fn((body: unknown) => {
		r.body = body;
		return r;
	});
	return r;
}

function req(identity: 'owner' | string | null, over: Partial<Request> = {}): Request {
	const r = { headers: {}, params: { id: 'team-crewly' }, body: {}, ...over } as unknown as Request;
	if (identity === 'owner') markOwner(r);
	else if (identity) setCallerIdentity(r, { kind: 'agent', via: 'agent-badge', session: identity } as CallerIdentity);
	else setCallerIdentity(r, { kind: 'anonymous', via: 'none' } as unknown as CallerIdentity);
	return r;
}

describe('team pause controller', () => {
	const service = { pause: jest.fn(), resume: jest.fn(), stop: jest.fn() };
	const ctx = {} as ApiContext;

	beforeEach(() => {
		jest.clearAllMocks();
		setTeamPauseService(service as unknown as TeamPauseService);
	});
	afterAll(() => setTeamPauseService(null));

	it('lets the owner pause with reason and until', async () => {
		service.pause.mockResolvedValue({ team: PAUSED, alreadyPaused: false, stopped: ['Leo'], stopFailed: [], releasedWorkItems: [], releasedTickets: [] });
		const r = res();
		await pauseTeamHandler.call(ctx, req('owner', { body: { reason: 'harness', until: '2099-01-01T00:00:00Z' } }), r);
		expect(service.pause).toHaveBeenCalledWith('team-crewly', { reason: 'harness', until: '2099-01-01T00:00:00Z' });
		expect(r.statusCode).toBe(200);
		expect(r.body).toMatchObject({ success: true, message: 'Crewly is paused. Stopped: Leo.' });
	});

	it('refuses an agent (403) and a caller without an owner credential (401)', async () => {
		const a = res();
		await pauseTeamHandler.call(ctx, req('crewly-orc'), a);
		expect(a.statusCode).toBe(403);
		const b = res();
		await resumeTeamHandler.call(ctx, req(null), b);
		expect(b.statusCode).toBe(401);
		expect(service.pause).not.toHaveBeenCalled();
		expect(service.resume).not.toHaveBeenCalled();
	});

	it('maps service errors to their status', async () => {
		service.pause.mockRejectedValue(new TeamPauseError(400, 'until must be in the future'));
		const r = res();
		await pauseTeamHandler.call(ctx, req('owner'), r);
		expect(r.statusCode).toBe(400);
		expect(r.body).toEqual({ success: false, error: 'until must be in the future' });
	});

	it('lets the owner resume', async () => {
		service.resume.mockResolvedValue({ team: PAUSED, wasPaused: true });
		const r = res();
		await resumeTeamHandler.call(ctx, req('owner'), r);
		expect(r.body).toMatchObject({ success: true, message: 'Crewly is resumed.' });
	});
});

describe('GET /teams agent filter', () => {
	const body = { success: true, data: [PAUSED, OPEN] };

	it('hides a paused team from other agents', () => {
		expect((filterTeamsBodyForAgent(body, 'mkt-ann') as { data: Team[] }).data.map((t) => t.id)).toEqual(['team-mkt']);
	});

	it('shows it to the orc, the owner and the paused team\'s own members', () => {
		expect(filterTeamsBodyForAgent(body, 'crewly-orc')).toBe(body);
		expect(filterTeamsBodyForAgent(body, undefined)).toBe(body);
		expect((filterTeamsBodyForAgent(body, 'crewly-leo') as { data: Team[] }).data).toHaveLength(2);
	});

	it('filters the response (fresh or cached) through res.json for agents only', () => {
		const next = jest.fn();
		const agentRes = res();
		const originalJson = agentRes.json as jest.Mock;
		hidePausedTeamsFromAgents(req('mkt-ann'), agentRes, next);
		agentRes.json(body);
		expect(next).toHaveBeenCalled();
		expect((originalJson.mock.calls[0][0] as { data: Team[] }).data.map((t) => t.id)).toEqual(['team-mkt']);

		const ownerRes = res();
		const ownerJson = ownerRes.json;
		hidePausedTeamsFromAgents(req('owner'), ownerRes, next);
		expect(ownerRes.json).toBe(ownerJson);
	});
});
