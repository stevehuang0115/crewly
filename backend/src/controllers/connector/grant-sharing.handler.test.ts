/**
 * Tests for the shared per-person connector route pieces (issue #968).
 */

import express from 'express';
import request from 'supertest';
import { connectingPerson, createSharingHandler, readSharingChange } from './grant-sharing.handler.js';
import { ActingForService, setActingForForTesting } from '../../services/people/acting-for.service.js';
import { GrantSharingError } from '../../services/people/grant-sharing.js';

describe('grant sharing handler', () => {
	afterEach(() => setActingForForTesting(null));

	it('reads a change and refuses an empty or invalid one', () => {
		expect(readSharingChange({ sharing: { mode: 'members' } })).toEqual({ sharing: { mode: 'members' } });
		expect(readSharingChange({ authorizedBy: 'UINFO001' })).toEqual({ authorizedBy: 'UINFO001' });
		expect(() => readSharingChange({})).toThrow(GrantSharingError);
		expect(() => readSharingChange({ sharing: { mode: 'x' } })).toThrow(GrantSharingError);
	});

	it('serves the owner, refuses an agent and invalid input, and passes errors to the connector', async () => {
		const apply = jest.fn(async () => ({ authorizedBy: 'UINFO001', sharing: { mode: 'members' as const } }));
		const sendError = jest.fn((_req, res: express.Response) => void res.status(502).json({ success: false }));
		const app = express();
		app.use(express.json());
		app.post('/sharing', createSharingHandler(apply, sendError));

		const ok = await request(app).post('/sharing').send({ sharing: { mode: 'members' } });
		expect(ok.body).toEqual({ success: true, data: { authorizedBy: 'UINFO001', sharing: { mode: 'members' } } });
		expect(apply).toHaveBeenCalledWith(expect.anything(), { sharing: { mode: 'members' } });

		expect((await request(app).post('/sharing').set('X-Agent-Session', 'dev-1').send({ sharing: { mode: 'members' } })).status).toBe(403);
		expect((await request(app).post('/sharing').send({ sharing: { mode: 'everyone' } })).status).toBe(400);

		apply.mockRejectedValueOnce(new Error('cloud down'));
		expect((await request(app).post('/sharing').send({ sharing: { mode: 'owner' } })).status).toBe(502);
		expect(sendError).toHaveBeenCalledTimes(1);
	});

	it('a grant connected from the dashboard is the owner’s; one asked for by an agent is its person’s', () => {
		const actingFor = new ActingForService({
			filePath: '/nonexistent/acting-for.json',
			people: () => ({ isOwner: (id: string) => id === 'owner', ownerId: () => 'owner', roleOf: () => 'member', displayName: (id: string) => id }) as never,
		});
		actingFor.record('dev-1', 'UINFO001', 'slack');
		setActingForForTesting(actingFor);
		expect(connectingPerson({ headers: {} })).toBe('owner');
		expect(connectingPerson({ headers: { 'x-agent-session': 'dev-1' } })).toBe('UINFO001');
	});
});
