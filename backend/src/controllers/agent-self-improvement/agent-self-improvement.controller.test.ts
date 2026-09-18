/**
 * Tests for the Agent Self-Improvement controller.
 *
 * Runs the real file-backed services against a temp HOME so the routes are
 * exercised end-to-end (validation → service → persisted JSON) without
 * touching the developer's `~/.crewly`.
 *
 * @module controllers/agent-self-improvement/agent-self-improvement.controller.test
 */

jest.mock('../../services/core/logger.service.js', () => {
	const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
	return {
		LoggerService: {
			getInstance: () => ({ createComponentLogger: () => mockLogger }),
		},
	};
});

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	createAgentSelfImprovementRouter,
	createDefaultSelfImprovementServices,
	deriveAccurate,
	type SelfImprovementServices,
} from './agent-self-improvement.controller.js';
import { AttentionService } from '../../services/ai/self-improvement/attention.service.js';
import { SelfModelService } from '../../services/ai/self-improvement/self-model.service.js';
import { PredictionCalibrationService } from '../../services/ai/self-improvement/prediction-calibration.service.js';
import { MemoryConsolidationService } from '../../services/ai/self-improvement/memory-consolidation.service.js';

const SESSION = 'crewly-dev-alpha';

describe('AgentSelfImprovementController', () => {
	let tmpHome: string;
	let originalHome: string | undefined;
	let app: express.Express;
	let services: SelfImprovementServices;
	let memories: string[];

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-self-'));
		originalHome = process.env.HOME;
		process.env.HOME = tmpHome;
		memories = [];
		services = {
			attention: new AttentionService(),
			selfModel: new SelfModelService(),
			predictions: new PredictionCalibrationService(),
			consolidation: new MemoryConsolidationService(async () => memories),
		};
		app = express();
		app.use(express.json());
		app.use('/api/agents', createAgentSelfImprovementRouter(services));
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	describe('GET /:sessionName/self-improvement', () => {
		it('returns empty defaults for an unknown agent', async () => {
			const res = await request(app).get(`/api/agents/${SESSION}/self-improvement`);
			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(res.body.data).toEqual({
				attention: { focus: [], suppressed: [], lastPruned: '', focusTimestamps: {} },
				selfModel: { decisionPatterns: [], biases: [], blindSpots: [] },
				calibrationScore: 0,
				consolidation: { patterns: [], insights: [], consolidatedAt: '', memoriesAnalyzed: 0 },
			});
		});

		it('reflects data written through the other routes and the latest consolidation report', async () => {
			await request(app).post(`/api/agents/${SESSION}/self-improvement/attention/focus`).send({ items: ['ship v2'] });
			await request(app).post(`/api/agents/${SESSION}/self-improvement/attention/suppress`).send({ item: 'legacy CI' });
			await services.selfModel.addBias(SESSION, 'optimism', 'medium');
			memories = [
				'test failure in jest mock setup',
				'fixed jest coverage assert after test refactor',
				'test mock error again',
			];
			await services.consolidation.consolidate(SESSION);

			const res = await request(app).get(`/api/agents/${SESSION}/self-improvement`);
			expect(res.status).toBe(200);
			expect(res.body.data.attention.focus).toEqual(['ship v2']);
			expect(res.body.data.attention.suppressed).toEqual(['legacy CI']);
			expect(res.body.data.selfModel.biases).toEqual([{ bias: 'optimism', severity: 'medium' }]);
			expect(res.body.data.consolidation.memoriesAnalyzed).toBe(3);
			expect(res.body.data.consolidation.patterns[0].pattern).toBe('testing');
		});

		it('returns 500 when a service throws', async () => {
			services.attention.getAttention = jest.fn(async () => {
				throw new Error('boom');
			});
			const res = await request(app).get(`/api/agents/${SESSION}/self-improvement`);
			expect(res.status).toBe(500);
			expect(res.body).toEqual({ success: false, error: 'boom' });
		});
	});

	describe('POST attention/focus', () => {
		it('replaces the focus list, trimming and de-duplicating', async () => {
			await services.attention.setFocus(SESSION, ['old']);
			const res = await request(app)
				.post(`/api/agents/${SESSION}/self-improvement/attention/focus`)
				.send({ items: [' a ', 'b', 'a'] });
			expect(res.status).toBe(200);
			expect(res.body.data.focus).toEqual(['a', 'b']);
		});

		it('rejects a missing or malformed items array', async () => {
			const missing = await request(app).post(`/api/agents/${SESSION}/self-improvement/attention/focus`).send({});
			expect(missing.status).toBe(400);
			const bad = await request(app)
				.post(`/api/agents/${SESSION}/self-improvement/attention/focus`)
				.send({ items: ['ok', ''] });
			expect(bad.status).toBe(400);
			expect(bad.body.error).toMatch(/non-empty strings/);
		});
	});

	describe('POST attention/suppress', () => {
		it('adds the item and removes it from focus', async () => {
			await services.attention.setFocus(SESSION, ['noise', 'signal']);
			const res = await request(app)
				.post(`/api/agents/${SESSION}/self-improvement/attention/suppress`)
				.send({ item: 'noise' });
			expect(res.status).toBe(200);
			expect(res.body.data).toEqual({ focus: ['signal'], suppressed: ['noise'] });
		});

		it('rejects an empty item', async () => {
			const res = await request(app)
				.post(`/api/agents/${SESSION}/self-improvement/attention/suppress`)
				.send({ item: '  ' });
			expect(res.status).toBe(400);
		});
	});

	describe('POST predictions', () => {
		it('records a prediction with an optional resolveBy and returns 201', async () => {
			const res = await request(app)
				.post(`/api/agents/${SESSION}/self-improvement/predictions`)
				.send({ statement: 'PR lands today', confidence: '0.7', resolveBy: '2026-12-01' });
			expect(res.status).toBe(201);
			expect(res.body.data.prediction).toMatchObject({
				prediction: 'PR lands today',
				confidence: 0.7,
				resolveBy: '2026-12-01',
			});
			expect(res.body.data.prediction.id).toMatch(/^pred-/);
		});

		it('validates statement, confidence range and resolveBy format', async () => {
			const base = `/api/agents/${SESSION}/self-improvement/predictions`;
			expect((await request(app).post(base).send({ confidence: 0.5 })).status).toBe(400);
			expect((await request(app).post(base).send({ statement: 'x', confidence: 1.5 })).status).toBe(400);
			expect((await request(app).post(base).send({ statement: 'x', confidence: 'abc' })).status).toBe(400);
			expect((await request(app).post(base).send({ statement: 'x', confidence: 0.5, resolveBy: 'soon' })).status).toBe(400);
		});
	});

	describe('POST predictions/:id/resolve', () => {
		it('resolves with an explicit accurate flag and returns the new calibration score', async () => {
			const created = await services.predictions.makePrediction(SESSION, 'x', 0.9);
			const res = await request(app)
				.post(`/api/agents/${SESSION}/self-improvement/predictions/${created.id}/resolve`)
				.send({ outcome: 'it shipped on time', accurate: true });
			expect(res.status).toBe(200);
			expect(res.body.data.prediction.outcome).toBe('it shipped on time');
			expect(res.body.data.prediction.accurate).toBe(true);
			expect(res.body.data.calibrationScore).toBeCloseTo(0.99, 2);
		});

		it('infers accuracy from a plain verdict outcome', async () => {
			const created = await services.predictions.makePrediction(SESSION, 'x', 0.9);
			const res = await request(app)
				.post(`/api/agents/${SESSION}/self-improvement/predictions/${created.id}/resolve`)
				.send({ outcome: 'wrong' });
			expect(res.status).toBe(200);
			expect(res.body.data.prediction.accurate).toBe(false);
		});

		it('rejects an ambiguous outcome without accurate, and 404s an unknown id', async () => {
			const created = await services.predictions.makePrediction(SESSION, 'x', 0.9);
			const ambiguous = await request(app)
				.post(`/api/agents/${SESSION}/self-improvement/predictions/${created.id}/resolve`)
				.send({ outcome: 'took longer than planned' });
			expect(ambiguous.status).toBe(400);

			const missing = await request(app)
				.post(`/api/agents/${SESSION}/self-improvement/predictions/pred-nope/resolve`)
				.send({ outcome: 'correct' });
			expect(missing.status).toBe(404);
		});
	});

	describe('deriveAccurate', () => {
		it('prefers an explicit boolean, accepts string booleans, and maps verdict keywords', () => {
			expect(deriveAccurate('wrong', true)).toBe(true);
			expect(deriveAccurate('anything', 'false')).toBe(false);
			expect(deriveAccurate('Correct', undefined)).toBe(true);
			expect(deriveAccurate('missed', undefined)).toBe(false);
			expect(deriveAccurate('sort of', undefined)).toBeNull();
		});
	});

	describe('createDefaultSelfImprovementServices', () => {
		it('builds the disk-backed bundle', () => {
			const bundle = createDefaultSelfImprovementServices();
			expect(bundle.attention).toBeInstanceOf(AttentionService);
			expect(bundle.selfModel).toBeInstanceOf(SelfModelService);
			expect(bundle.predictions).toBeInstanceOf(PredictionCalibrationService);
			expect(bundle.consolidation).toBeInstanceOf(MemoryConsolidationService);
		});
	});

	describe('router', () => {
		it('exposes the five expected routes', () => {
			const router = createAgentSelfImprovementRouter(services);
			type Layer = { route?: { path: string; methods: Record<string, boolean> } };
			const routes = (router as unknown as { stack: Layer[] }).stack
				.map((l) => l.route)
				.filter((r): r is NonNullable<Layer['route']> => Boolean(r))
				.map((r) => `${Object.keys(r.methods)[0].toUpperCase()} ${r.path}`);
			expect(routes).toEqual([
				'GET /:sessionName/self-improvement',
				'POST /:sessionName/self-improvement/attention/focus',
				'POST /:sessionName/self-improvement/attention/suppress',
				'POST /:sessionName/self-improvement/predictions',
				'POST /:sessionName/self-improvement/predictions/:id/resolve',
			]);
		});
	});
});
