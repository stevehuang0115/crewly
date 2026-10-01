/**
 * Runtime fallback + runtime smoke test endpoints.
 *
 * - `GET  /api/system/runtime-fallback` — settings, runtime availability,
 *   exhausted runtimes and active overrides
 * - `PUT  /api/system/runtime-fallback/settings` — partial settings update
 * - `POST /api/system/runtime-smoke-test { runtime }` — start a smoke test
 *   (`?wait=1` waits for the result, ≤ 5 min)
 * - `GET  /api/system/runtime-smoke-test/:jobId` — a smoke test job
 *
 * specs/2026-10-01-runtime-fallback.md
 *
 * @module controllers/system/runtime-fallback.controller
 */

import type { Request, Response, Router } from 'express';
import { RUNTIME_FALLBACK_CONSTANTS } from '../../constants.js';
import { getApiToken } from '../../services/core/api-token.service.js';
import { getRuntimeFallbackService, type RuntimeFallbackService } from '../../services/runtime-fallback/runtime-fallback.service.js';
import { RuntimeFallbackSettingsError } from '../../services/runtime-fallback/runtime-fallback.types.js';
import { LocalSmokeApi, RuntimeSmokeTestService } from '../../services/runtime-fallback/runtime-smoke-test.service.js';
import { getLocalApiBaseUrl } from '../../utils/local-api-url.utils.js';

/** Dependencies (tests inject fakes). */
export interface RuntimeFallbackControllerDeps {
	fallback: () => Pick<RuntimeFallbackService, 'snapshot' | 'updateSettings'> | null;
	smoke: () => Pick<RuntimeSmokeTestService, 'start' | 'get'>;
}

let smokeService: RuntimeSmokeTestService | null = null;

/** Default dependencies: the backend's services. */
function defaultDeps(): RuntimeFallbackControllerDeps {
	return {
		fallback: () => getRuntimeFallbackService(),
		smoke: () => {
			smokeService ??= new RuntimeSmokeTestService({
				api: new LocalSmokeApi(getLocalApiBaseUrl, getApiToken),
				crewlyAgentModel: () => getRuntimeFallbackService()?.getSettings().crewlyAgentModel ?? RUNTIME_FALLBACK_CONSTANTS.DEFAULT_CREWLY_AGENT_MODEL,
			});
			return smokeService;
		},
	};
}

/**
 * Register the routes.
 *
 * @param router - The /api router
 * @param deps - Dependencies (default: the backend's)
 */
export function registerRuntimeFallbackRoutes(router: Router, deps: RuntimeFallbackControllerDeps = defaultDeps()): void {
	router.get('/system/runtime-fallback', async (_req: Request, res: Response) => {
		const fallback = deps.fallback();
		if (!fallback) {
			res.status(503).json({ success: false, error: 'Runtime fallback is not ready yet — Crewly is still starting.' });
			return;
		}
		try {
			res.json({ success: true, data: await fallback.snapshot() });
		} catch (err) {
			res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
		}
	});

	router.put('/system/runtime-fallback/settings', async (req: Request, res: Response) => {
		const fallback = deps.fallback();
		if (!fallback) {
			res.status(503).json({ success: false, error: 'Runtime fallback is not ready yet — Crewly is still starting.' });
			return;
		}
		try {
			fallback.updateSettings(req.body);
			res.json({ success: true, data: await fallback.snapshot() });
		} catch (err) {
			if (err instanceof RuntimeFallbackSettingsError) {
				res.status(400).json({ success: false, error: err.message });
				return;
			}
			res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
		}
	});

	router.post('/system/runtime-smoke-test', async (req: Request, res: Response) => {
		const runtime = typeof req.body?.runtime === 'string' ? req.body.runtime : '';
		let started: ReturnType<RuntimeSmokeTestService['start']>;
		try {
			started = deps.smoke().start(runtime);
		} catch (err) {
			res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const wait = req.query.wait === '1' || req.query.wait === 'true';
		if (!wait) {
			res.status(202).json({ success: true, data: started.job });
			return;
		}
		const result = await started.done;
		res.json({ success: true, data: { ...started.job, state: 'done', result } });
	});

	router.get('/system/runtime-smoke-test/:jobId', (req: Request, res: Response) => {
		const job = deps.smoke().get(req.params.jobId);
		if (!job) {
			res.status(404).json({ success: false, error: 'No such smoke test' });
			return;
		}
		res.json({ success: true, data: job });
	});
}
