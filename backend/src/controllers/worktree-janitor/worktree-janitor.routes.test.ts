/**
 * Tests for the worktree janitor routes (service is faked).
 */

import express from 'express';
import request from 'supertest';
import { createWorktreeJanitorRouter } from './worktree-janitor.routes.js';
import type { WorktreeJanitorService, JanitorRunSummary } from '../../services/worktree/worktree-janitor.service.js';

function summary(overrides: Partial<JanitorRunSummary> = {}): JanitorRunSummary {
	return {
		startedAt: '2026-09-28T00:00:00.000Z',
		durationMs: 5,
		disabled: false,
		dryRun: false,
		repos: ['/r'],
		removed: 0,
		wouldRemove: 0,
		kept: 1,
		keptReasons: { 'main-worktree': 1 },
		worktrees: [],
		...overrides,
	};
}

function appWith(service: Partial<WorktreeJanitorService>) {
	const app = express();
	app.use('/api/worktree-janitor', createWorktreeJanitorRouter(() => service as WorktreeJanitorService));
	return app;
}

describe('worktree janitor routes', () => {
	it('GET /worktrees returns the dry-run plan with the kill-switch state and last run', async () => {
		const plan = summary({ dryRun: true, wouldRemove: 2 });
		const last = summary({ removed: 3 });
		const service = {
			plan: jest.fn().mockResolvedValue(plan),
			run: jest.fn(),
			isDisabled: jest.fn().mockReturnValue(false),
			getLastSummary: jest.fn().mockReturnValue(last),
		};
		const res = await request(appWith(service)).get('/api/worktree-janitor/worktrees');
		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data).toMatchObject({ dryRun: true, wouldRemove: 2, disabled: false, lastRun: { removed: 3 } });
		expect(service.run).not.toHaveBeenCalled();
	});

	it('POST /run runs one pass', async () => {
		const service = {
			run: jest.fn().mockResolvedValue(summary({ removed: 4 })),
			isDisabled: jest.fn().mockReturnValue(false),
		};
		const res = await request(appWith(service)).post('/api/worktree-janitor/run');
		expect(res.status).toBe(200);
		expect(res.body.data.removed).toBe(4);
	});

	it('POST /run is refused with 409 when the kill switch is on', async () => {
		const service = { run: jest.fn(), isDisabled: jest.fn().mockReturnValue(true) };
		const res = await request(appWith(service)).post('/api/worktree-janitor/run');
		expect(res.status).toBe(409);
		expect(res.body.error).toContain('CREWLY_WORKTREE_JANITOR');
		expect(service.run).not.toHaveBeenCalled();
	});

	it('returns 500 when the service throws', async () => {
		const service = {
			plan: jest.fn().mockRejectedValue(new Error('boom')),
			isDisabled: jest.fn().mockReturnValue(false),
		};
		const res = await request(appWith(service)).get('/api/worktree-janitor/worktrees');
		expect(res.status).toBe(500);
		expect(res.body).toEqual({ success: false, error: 'boom' });
	});
});
