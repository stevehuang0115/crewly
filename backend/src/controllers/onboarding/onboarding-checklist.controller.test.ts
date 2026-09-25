/**
 * Tests for the onboarding checklist REST handlers: responses, owner-only
 * refusals (X-Agent-Session → 403) and error mapping.
 */

import express from 'express';
import request from 'supertest';
import {
	OnboardingError,
	type OnboardingChecklistService,
} from '../../services/onboarding/onboarding-checklist.service.js';
import { createOnboardingChecklistRouter } from './onboarding-checklist.routes.js';
import { sendOnboardingError } from './onboarding-checklist.controller.js';

const CHECKLIST = { steps: [], doneCount: 0, total: 5, allDone: false, dismissed: false, dismissedAt: null };
const AGENT = { 'X-Agent-Session': 'crewly-orc' };

/**
 * Fake checklist service.
 *
 * @returns Mocks cast to the service
 */
function fakeService() {
	const mocks = {
		getChecklist: jest.fn(async () => CHECKLIST),
		setDismissed: jest.fn(async (dismissed: boolean) => ({ ...CHECKLIST, dismissed })),
		listStarters: jest.fn(() => [{ id: 'personal-assistant-team' }, { id: 'blank' }]),
		createStarterTeam: jest.fn(async (starterId: string) => ({ starterId, team: { id: 't1' }, created: true })),
		sendFirstTask: jest.fn(async () => ({ forwarded: true, queued: true, conversationId: 'c1', teamId: 't1', sentAt: 'now', message: null })),
	};
	return { mocks, service: mocks as unknown as OnboardingChecklistService };
}

/**
 * App with the router mounted where the backend mounts it.
 *
 * @param service - Checklist service
 * @returns App
 */
function appWith(service: OnboardingChecklistService) {
	const app = express();
	app.use(express.json());
	app.use('/api/onboarding', createOnboardingChecklistRouter(() => service));
	return app;
}

describe('onboarding checklist controller', () => {
	it('GET /checklist returns the checklist, also to agents', async () => {
		const { service } = fakeService();
		const res = await request(appWith(service)).get('/api/onboarding/checklist');
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true, data: CHECKLIST });
		expect((await request(appWith(service)).get('/api/onboarding/checklist').set(AGENT)).status).toBe(200);
	});

	it('GET /starters returns the starters', async () => {
		const { service } = fakeService();
		const res = await request(appWith(service)).get('/api/onboarding/starters');
		expect(res.body).toEqual({ success: true, data: { starters: [{ id: 'personal-assistant-team' }, { id: 'blank' }] } });
	});

	it('POST /checklist/dismiss hides by default and shows with dismissed:false', async () => {
		const { service, mocks } = fakeService();
		await request(appWith(service)).post('/api/onboarding/checklist/dismiss').send({});
		expect(mocks.setDismissed).toHaveBeenLastCalledWith(true);
		const res = await request(appWith(service)).post('/api/onboarding/checklist/dismiss').send({ dismissed: false });
		expect(mocks.setDismissed).toHaveBeenLastCalledWith(false);
		expect(res.body.data.dismissed).toBe(false);
	});

	it('POST /starter-team creates (201) or returns the existing team (200)', async () => {
		const { service, mocks } = fakeService();
		const res = await request(appWith(service)).post('/api/onboarding/starter-team').send({ starterId: 'personal-assistant-team' });
		expect(res.status).toBe(201);
		expect(mocks.createStarterTeam).toHaveBeenCalledWith('personal-assistant-team');
		mocks.createStarterTeam.mockResolvedValueOnce({ starterId: 'blank', team: null, created: false } as never);
		expect((await request(appWith(service)).post('/api/onboarding/starter-team').send({ starterId: 'blank' })).status).toBe(200);
	});

	it('POST /starter-team requires a starterId', async () => {
		const { service } = fakeService();
		const res = await request(appWith(service)).post('/api/onboarding/starter-team').send({});
		expect(res.status).toBe(400);
	});

	it('POST /first-task hands the task over (201)', async () => {
		const { service, mocks } = fakeService();
		const res = await request(appWith(service)).post('/api/onboarding/first-task').send({ text: 'Plan my week', teamId: 't1' });
		expect(res.status).toBe(201);
		expect(mocks.sendFirstTask).toHaveBeenCalledWith('Plan my week', 't1');
		expect(res.body.data.conversationId).toBe('c1');
	});

	it('POST /first-task reports 503 when the orchestrator could not take it', async () => {
		const { service, mocks } = fakeService();
		mocks.sendFirstTask.mockResolvedValueOnce({ forwarded: false, queued: false, conversationId: null, teamId: null, sentAt: null, message: 'Orchestrator is not running.' } as never);
		const res = await request(appWith(service)).post('/api/onboarding/first-task').send({ text: 'Hi' });
		expect(res.status).toBe(503);
		expect(res.body).toMatchObject({ success: false, error: 'Orchestrator is not running.' });
	});

	it('maps service errors to statuses', async () => {
		const { service, mocks } = fakeService();
		mocks.sendFirstTask.mockRejectedValueOnce(new OnboardingError('invalid_task', 'Write something'));
		const bad = await request(appWith(service)).post('/api/onboarding/first-task').send({ text: '' });
		expect(bad.status).toBe(400);
		expect(bad.body).toEqual({ success: false, error: 'Write something', code: 'invalid_task' });
		mocks.createStarterTeam.mockRejectedValueOnce(new OnboardingError('unknown_starter', 'nope'));
		expect((await request(appWith(service)).post('/api/onboarding/starter-team').send({ starterId: 'x' })).status).toBe(404);
		mocks.getChecklist.mockRejectedValueOnce(new Error('disk'));
		const failed = await request(appWith(service)).get('/api/onboarding/checklist');
		expect(failed.status).toBe(500);
		expect(failed.body.error).toBe('disk');
	});

	it.each([
		['/api/onboarding/checklist/dismiss', {}],
		['/api/onboarding/starter-team', { starterId: 'blank' }],
		['/api/onboarding/first-task', { text: 'Hi' }],
	])('refuses agents on POST %s', async (url, body) => {
		const { service, mocks } = fakeService();
		const res = await request(appWith(service)).post(url).set(AGENT).send(body);
		expect(res.status).toBe(403);
		expect(mocks.setDismissed).not.toHaveBeenCalled();
		expect(mocks.createStarterTeam).not.toHaveBeenCalled();
		expect(mocks.sendFirstTask).not.toHaveBeenCalled();
	});

	it('sendOnboardingError stringifies non-errors', () => {
		const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
		sendOnboardingError(res as never, 'weird');
		expect(res.status).toHaveBeenCalledWith(500);
		expect(res.json).toHaveBeenCalledWith({ success: false, error: 'weird' });
	});
});
