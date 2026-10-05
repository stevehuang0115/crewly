/**
 * Tests for the skill-setup controller (supertest against an express app with fakes).
 */

import express from 'express';
import request from 'supertest';
import type { SkillCandidate, SkillDiscoveryService } from '../../services/skill-setup/skill-discovery.service.js';
import { SkillInstallError, type SkillInstallJobService, type StartInstallInput } from '../../services/skill-setup/skill-install-job.service.js';
import { findGuidance } from './skill-setup.controller.js';
import { createSkillSetupRouter } from './skill-setup.routes.js';
import { ownerUnlessAgentForTests } from '../../middleware/caller-identity.testing.js';

jest.mock('../../services/core/logger.service.js', () => ({
	LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }) },
}));

const candidate: SkillCandidate = {
	id: 'transcribe-audio',
	name: 'transcribe-audio',
	description: 'Whisper',
	tags: ['audio'],
	triggers: [],
	source: 'bundled',
	official: true,
	officialReason: 'bundled with Crewly',
	installed: true,
	ready: false,
	executePath: '/pkg/transcribe-audio/execute.sh',
	setup: { declared: true, estimatedMinutes: 6, satisfied: false, missing: ['ffmpeg'] },
	score: 12,
};

/**
 * App wired to fakes.
 *
 * @param startInstall - Fake job start
 * @returns Express app
 */
function app(startInstall: (input: StartInstallInput) => Promise<unknown>) {
	const discovery = {
		find: jest.fn(async () => ({ candidates: [candidate], registryAvailable: true })),
		resolve: jest.fn(async (id: string) => (id === 'transcribe-audio' ? { ...candidate } : null)),
		probe: jest.fn(async (s: SkillCandidate) => s),
		publicView: jest.fn((s: SkillCandidate) => s),
	} as unknown as SkillDiscoveryService;
	const jobs = {
		startInstall: jest.fn(startInstall),
		getJob: jest.fn((id: string) => {
			if (id !== 'job1') throw new SkillInstallError('job_not_found', `Install job not found: ${id}`);
			return { jobId: 'job1', state: 'running' };
		}),
	} as unknown as SkillInstallJobService;
	const a = express();
	a.use(ownerUnlessAgentForTests);
	a.use(express.json());
	a.use('/api/skill-setup', createSkillSetupRouter({ discovery: () => discovery, jobs: () => jobs }));
	return { app: a, jobs };
}

const runningJob = {
	kind: 'job',
	job: { jobId: 'job1', skillId: 'transcribe-audio', state: 'running', official: true, officialReason: 'bundled with Crewly', estimatedMinutes: 6, requesterSessions: ['dev-1'], log: '', notified: false, startedAt: '' },
};

describe('skill-setup controller', () => {
	it('GET /find returns ranked candidates and what to do next', async () => {
		const { app: a } = app(async () => runningJob);
		const res = await request(a).get('/api/skill-setup/find').query({ query: 'voice message' });
		expect(res.status).toBe(200);
		expect(res.body.data.candidates[0].id).toBe('transcribe-audio');
		expect(res.body.data.next).toMatch(/Tell the user in one line that you are installing it \(about 6 min\), then run install-skill --id transcribe-audio/);
	});

	it('GET /find without a query is a 400', async () => {
		const { app: a } = app(async () => runningJob);
		expect((await request(a).get('/api/skill-setup/find')).status).toBe(400);
	});

	it('POST /install passes the agent session and flags, and answers 202 with the job', async () => {
		const { app: a, jobs } = app(async () => runningJob);
		const res = await request(a)
			.post('/api/skill-setup/install')
			.set('X-Agent-Session', 'dev-1')
			.send({ id: 'transcribe-audio', resume: 'transcribe clip.m4a', approvedByOwner: 'yes' });
		expect(res.status).toBe(202);
		expect(res.body.data).toMatchObject({ jobId: 'job1', state: 'running', estimatedMinutes: 6, willNotify: ['dev-1'] });
		expect(res.body.data.next).toMatch(/Installing transcribe-audio in the background/);
		expect((jobs.startInstall as jest.Mock).mock.calls[0][0]).toEqual({
			skillId: 'transcribe-audio',
			requesterSession: 'dev-1',
			approvedByOwner: false, // only a real boolean counts
			ownerDashboard: false,
			resumeNote: 'transcribe clip.m4a',
			force: false,
			ownerClaim: undefined,
		});
	});

	it('POST /install forwards the owner quote the agent cites (base64 header)', async () => {
		const { app: a, jobs } = app(async () => runningJob);
		const quote = '可以，装 shady-ocr';
		await request(a).post('/api/skill-setup/install').set('X-Agent-Authorization', `b64:${Buffer.from(quote).toString('base64')}`).send({ id: 'shady-ocr', approvedByOwner: true });
		expect((jobs.startInstall as jest.Mock).mock.calls[0][0]).toMatchObject({ approvedByOwner: true, ownerClaim: quote });
	});

	it('POST /install marks a dashboard request as the owner', async () => {
		const { app: a, jobs } = app(async () => runningJob);
		await request(a).post('/api/skill-setup/install').set('X-Crewly-Caller', 'dashboard').send({ id: 'x' });
		expect((jobs.startInstall as jest.Mock).mock.calls[0][0].ownerDashboard).toBe(true);
	});

	it('POST /install reports already-ready with 200', async () => {
		const { app: a } = app(async () => ({ kind: 'already-ready', skill: { id: 'transcribe-audio', executePath: '/x/execute.sh', officialReason: '' } }));
		const res = await request(a).post('/api/skill-setup/install').send({ id: 'transcribe-audio' });
		expect(res.status).toBe(200);
		expect(res.body.data).toMatchObject({ state: 'already-ready', next: 'transcribe-audio is already installed and set up — use it now: bash /x/execute.sh.' });
	});

	it('POST /install maps trust refusals to 403 with the code', async () => {
		const { app: a } = app(async () => {
			throw new SkillInstallError('owner_approval_required', 'Ask the owner', { official: false });
		});
		const res = await request(a).post('/api/skill-setup/install').send({ id: 'shady' });
		expect(res.status).toBe(403);
		expect(res.body).toEqual({ success: false, error: 'Ask the owner', code: 'owner_approval_required', official: false });
	});

	it('POST /install without an id is a 400', async () => {
		const { app: a } = app(async () => runningJob);
		expect((await request(a).post('/api/skill-setup/install').send({})).status).toBe(400);
	});

	it('GET /jobs/:jobId returns the job or 404', async () => {
		const { app: a } = app(async () => runningJob);
		expect((await request(a).get('/api/skill-setup/jobs/job1')).body.data.jobId).toBe('job1');
		expect((await request(a).get('/api/skill-setup/jobs/nope')).status).toBe(404);
	});

	it('GET /status/:id probes one skill', async () => {
		const { app: a } = app(async () => runningJob);
		expect((await request(a).get('/api/skill-setup/status/transcribe-audio')).body.data.id).toBe('transcribe-audio');
		expect((await request(a).get('/api/skill-setup/status/nope')).status).toBe(404);
	});
});

describe('findGuidance', () => {
	it('covers ready, third-party and no-match', () => {
		expect(findGuidance([{ ...candidate, ready: true }])).toBe('transcribe-audio is installed and ready — use it now: bash /pkg/transcribe-audio/execute.sh');
		expect(findGuidance([{ ...candidate, official: false, officialReason: 'third-party: author "x"' }])).toMatch(/Ask the owner in chat before installing/);
		expect(findGuidance([])).toMatch(/^No skill matches/);
	});
});

describe('skill-setup controller — Marketplace catalog and remove', () => {
	const installed = { ...candidate, id: 'ocr-images', name: 'OCR', source: 'installed' as const, official: true, installed: true };

	/**
	 * App with a discovery fake that knows three skills and a fake uninstall.
	 *
	 * @param uninstallOk - What the fake uninstall reports
	 * @returns App and the uninstall mock
	 */
	function catalogApp(uninstallOk = true) {
		const discovery = {
			catalog: jest.fn(async () => ({ skills: [{ id: 'ocr-images', installed: true, removable: true }], registryAvailable: true })),
			resolve: jest.fn(async (id: string) => {
				if (id === 'ocr-images') return { ...installed };
				if (id === 'agent-ocr') return { ...installed, registryId: 'agent-ocr' };
				if (id === 'transcribe-audio') return { ...candidate };
				if (id === 'not-here') return { ...candidate, id: 'not-here', source: 'registry', installed: false };
				return null;
			}),
		} as unknown as SkillDiscoveryService;
		const uninstall = jest.fn(async (id: string) => (uninstallOk ? { success: true, message: `Uninstalled ${id}` } : { success: false, message: 'Uninstall failed: EACCES' }));
		const a = express();
		a.use(ownerUnlessAgentForTests);
		a.use(express.json());
		a.use('/api/skill-setup', createSkillSetupRouter({ discovery: () => discovery, uninstall }));
		return { app: a, uninstall };
	}

	it('GET /catalog returns every marketplace skill with this machine\'s state', async () => {
		const res = await request(catalogApp().app).get('/api/skill-setup/catalog');
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true, data: { skills: [{ id: 'ocr-images', installed: true, removable: true }], registryAvailable: true } });
	});

	it('POST /uninstall removes a marketplace skill, by its registry id', async () => {
		const { app: a, uninstall } = catalogApp();
		const res = await request(a).post('/api/skill-setup/uninstall').send({ id: 'agent-ocr' });
		expect(res.status).toBe(200);
		expect(res.body.data).toEqual({ skillId: 'agent-ocr', message: 'Uninstalled agent-ocr' });
		expect(uninstall).toHaveBeenCalledWith('agent-ocr');
	});

	it('POST /uninstall refuses agents, bundled skills, skills not installed and a missing id', async () => {
		const { app: a, uninstall } = catalogApp();
		const agent = await request(a).post('/api/skill-setup/uninstall').set('X-Agent-Session', 'dev-1').send({ id: 'ocr-images' });
		expect(agent.status).toBe(403);
		expect(agent.body.code).toBe('owner_only');
		const bundled = await request(a).post('/api/skill-setup/uninstall').send({ id: 'transcribe-audio' });
		expect(bundled.status).toBe(409);
		expect(bundled.body.code).toBe('bundled');
		expect((await request(a).post('/api/skill-setup/uninstall').send({ id: 'not-here' })).status).toBe(404);
		expect((await request(a).post('/api/skill-setup/uninstall').send({ id: 'unknown' })).status).toBe(404);
		expect((await request(a).post('/api/skill-setup/uninstall').send({})).status).toBe(400);
		expect(uninstall).not.toHaveBeenCalled();
	});

	it('POST /uninstall reports a failed removal', async () => {
		const res = await request(catalogApp(false).app).post('/api/skill-setup/uninstall').send({ id: 'ocr-images' });
		expect(res.status).toBe(500);
		expect(res.body).toMatchObject({ success: false, error: 'Uninstall failed: EACCES', code: 'uninstall_failed' });
	});
});
