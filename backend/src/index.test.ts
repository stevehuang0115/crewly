// Auto-update + priority fix
// JSONL sync to TokenUsageService
/**
 * Tests for the Crewly backend server — headless mode, health endpoint, service initialization.
 *
 * Since backend/src/index.ts uses import.meta.url which is not supported in
 * Jest's CJS module mode, these tests validate the headless mode behavior
 * by replicating the relevant Express route configuration logic.
 *
 * Tests cover:
 * - StartupConfig headless field resolution from env vars and config
 * - Health endpoint response shape (mode, agents, version, uptime)
 * - Conditional frontend serving based on headless flag
 */

import express from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Helpers — replicate the exact route logic from CrewlyServer.configureRoutes()
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Express app with the health endpoint and conditional
 * frontend serving, matching the logic in backend/src/index.ts configureRoutes().
 *
 * @param headless - Whether the server is in headless mode
 * @param sessionData - Mock session data for agent count
 * @param versionData - Mock version data for health response
 * @returns Express application for testing
 */
function buildTestApp(
	headless: boolean,
	sessionData?: { sessionCount: number },
	versionData?: { currentVersion: string; latestVersion: string | null; updateAvailable: boolean },
): express.Application {
	const app = express();

	// Health check (replicates CrewlyServer.configureRoutes health handler)
	app.get('/health', (_req, res) => {
		// listSessions() returns string[] of active session names,
		// so active and total counts are the same
		const agentCount = sessionData?.sessionCount ?? 0;

		const version = versionData?.currentVersion ?? '1.0.0';
		const latestVersion = versionData?.latestVersion ?? null;
		const updateAvailable = versionData?.updateAvailable ?? false;

		res.json({
			status: 'healthy',
			timestamp: new Date().toISOString(),
			uptime: process.uptime(),
			version,
			latestVersion,
			updateAvailable,
			mode: headless ? 'headless' : 'standard',
			agents: {
				active: agentCount,
				total: agentCount,
			},
		});
	});

	// Conditional frontend serving (replicates the headless gate)
	if (!headless) {
		app.get('*', (_req, res) => {
			res.status(200).send('<html><body>SPA</body></html>');
		});
	}

	return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrewlyServer headless mode', () => {
	// -----------------------------------------------------------------------
	// StartupConfig headless resolution
	// -----------------------------------------------------------------------

	describe('StartupConfig headless field', () => {
		it('defaults to false when neither config nor env var is set', () => {
			const originalEnv = process.env.CREWLY_HEADLESS;
			delete process.env.CREWLY_HEADLESS;

			const config = { headless: undefined };
			const headless = config.headless ?? process.env.CREWLY_HEADLESS === 'true';
			expect(headless).toBe(false);

			if (originalEnv !== undefined) process.env.CREWLY_HEADLESS = originalEnv;
		});

		it('resolves to true from CREWLY_HEADLESS=true env var', () => {
			const originalEnv = process.env.CREWLY_HEADLESS;
			process.env.CREWLY_HEADLESS = 'true';

			const config = { headless: undefined };
			const headless = config.headless ?? process.env.CREWLY_HEADLESS === 'true';
			expect(headless).toBe(true);

			if (originalEnv === undefined) delete process.env.CREWLY_HEADLESS;
			else process.env.CREWLY_HEADLESS = originalEnv;
		});

		it('config.headless=false overrides CREWLY_HEADLESS=true env var', () => {
			const originalEnv = process.env.CREWLY_HEADLESS;
			process.env.CREWLY_HEADLESS = 'true';

			const config = { headless: false };
			const headless = config.headless ?? process.env.CREWLY_HEADLESS === 'true';
			expect(headless).toBe(false);

			if (originalEnv === undefined) delete process.env.CREWLY_HEADLESS;
			else process.env.CREWLY_HEADLESS = originalEnv;
		});

		it('CREWLY_HEADLESS=false is treated as not headless', () => {
			const originalEnv = process.env.CREWLY_HEADLESS;
			process.env.CREWLY_HEADLESS = 'false';

			const config = { headless: undefined };
			const headless = config.headless ?? process.env.CREWLY_HEADLESS === 'true';
			expect(headless).toBe(false);

			if (originalEnv === undefined) delete process.env.CREWLY_HEADLESS;
			else process.env.CREWLY_HEADLESS = originalEnv;
		});

		it('CREWLY_HEADLESS unset with config.headless=true resolves to true', () => {
			const originalEnv = process.env.CREWLY_HEADLESS;
			delete process.env.CREWLY_HEADLESS;

			const config = { headless: true };
			const headless = config.headless ?? process.env.CREWLY_HEADLESS === 'true';
			expect(headless).toBe(true);

			if (originalEnv !== undefined) process.env.CREWLY_HEADLESS = originalEnv;
		});
	});

	// -----------------------------------------------------------------------
	// Health endpoint
	// -----------------------------------------------------------------------

	describe('health endpoint', () => {
		it('returns mode=standard when not headless', async () => {
			const app = buildTestApp(false);
			const res = await request(app).get('/health');

			expect(res.status).toBe(200);
			expect(res.body.status).toBe('healthy');
			expect(res.body.mode).toBe('standard');
		});

		it('returns mode=headless when headless is true', async () => {
			const app = buildTestApp(true);
			const res = await request(app).get('/health');

			expect(res.status).toBe(200);
			expect(res.body.mode).toBe('headless');
		});

		it('includes agents count reflecting active session count', async () => {
			const app = buildTestApp(false, { sessionCount: 3 });
			const res = await request(app).get('/health');

			expect(res.body.agents).toBeDefined();
			// listSessions() only returns active sessions, so active === total
			expect(res.body.agents.active).toBe(3);
			expect(res.body.agents.total).toBe(3);
		});

		it('returns zero agents when no sessions exist', async () => {
			const app = buildTestApp(false, { sessionCount: 0 });
			const res = await request(app).get('/health');

			expect(res.body.agents.active).toBe(0);
			expect(res.body.agents.total).toBe(0);
		});

		it('includes version info in health response', async () => {
			const app = buildTestApp(false, undefined, {
				currentVersion: '2.5.0',
				latestVersion: '2.6.0',
				updateAvailable: true,
			});
			const res = await request(app).get('/health');

			expect(res.body.version).toBe('2.5.0');
			expect(res.body.latestVersion).toBe('2.6.0');
			expect(res.body.updateAvailable).toBe(true);
		});

		it('defaults version info when not provided', async () => {
			const app = buildTestApp(false);
			const res = await request(app).get('/health');

			expect(res.body.version).toBe('1.0.0');
			expect(res.body.latestVersion).toBeNull();
			expect(res.body.updateAvailable).toBe(false);
		});

		it('includes uptime as a non-negative number', async () => {
			const app = buildTestApp(false);
			const res = await request(app).get('/health');

			expect(typeof res.body.uptime).toBe('number');
			expect(res.body.uptime).toBeGreaterThanOrEqual(0);
		});

		it('includes valid ISO timestamp', async () => {
			const app = buildTestApp(false);
			const res = await request(app).get('/health');

			expect(res.body.timestamp).toBeDefined();
			const parsed = new Date(res.body.timestamp);
			expect(parsed.getTime()).not.toBeNaN();
		});

		it('returns all expected fields in health response', async () => {
			const app = buildTestApp(true);
			const res = await request(app).get('/health');

			expect(res.body).toHaveProperty('status');
			expect(res.body).toHaveProperty('timestamp');
			expect(res.body).toHaveProperty('uptime');
			expect(res.body).toHaveProperty('version');
			expect(res.body).toHaveProperty('latestVersion');
			expect(res.body).toHaveProperty('updateAvailable');
			expect(res.body).toHaveProperty('mode');
			expect(res.body).toHaveProperty('agents');
			expect(res.body.agents).toHaveProperty('active');
			expect(res.body.agents).toHaveProperty('total');
		});
	});

	// -----------------------------------------------------------------------
	// Frontend serving (headless vs standard)
	// -----------------------------------------------------------------------

	describe('frontend serving', () => {
		it('does not serve SPA catch-all in headless mode', async () => {
			const app = buildTestApp(true);
			const res = await request(app).get('/some-frontend-route');

			// In headless mode, no SPA catch-all is registered
			expect(res.status).toBe(404);
		});

		it('serves SPA catch-all in standard mode', async () => {
			const app = buildTestApp(false);
			const res = await request(app).get('/some-frontend-route');

			// In standard mode, the SPA catch-all returns 200
			expect(res.status).toBe(200);
			expect(res.text).toContain('SPA');
		});

		it('health endpoint works in headless mode', async () => {
			const app = buildTestApp(true);
			const res = await request(app).get('/health');

			expect(res.status).toBe(200);
			expect(res.body.status).toBe('healthy');
		});

		it('health endpoint works in standard mode', async () => {
			const app = buildTestApp(false);
			const res = await request(app).get('/health');

			expect(res.status).toBe(200);
			expect(res.body.status).toBe('healthy');
		});
	});

	// -----------------------------------------------------------------------
	// Background-task wiring smoke tests for the MissionReminderService.
	//
	// We can't load the real index.ts (uses import.meta.url) so these
	// tests replicate the wrapper structure used by configureBackgroundTasks
	// to assert that:
	//  - the dynamic import path resolves
	//  - runSweep errors are swallowed (the watchdog must never crash boot)
	// -----------------------------------------------------------------------
	describe('Background-task wiring — MissionReminderService', () => {
		it('dynamic import path resolves to a singleton with runSweep()', async () => {
			const mod = await import('./services/v3/mission-reminder.service.js');
			expect(typeof mod.MissionReminderService.getInstance).toBe('function');
			expect(typeof mod.MissionReminderService.getInstance().runSweep).toBe('function');
		});

		it('hourly wrapper swallows runSweep errors via try/catch', async () => {
			const fakeService = { runSweep: jest.fn().mockRejectedValue(new Error('boom')) };
			const warn = jest.fn();

			// Replicates the exact try/catch wrapper used in
			// CrewlyServer.configureBackgroundTasks for the hourly sweep.
			const tick = async () => {
				try {
					await fakeService.runSweep();
				} catch (err) {
					warn('Mission OKR reminder sweep failed', { error: String(err) });
				}
			};

			await expect(tick()).resolves.toBeUndefined();
			expect(warn).toHaveBeenCalledWith(
				'Mission OKR reminder sweep failed',
				expect.objectContaining({ error: expect.stringContaining('boom') }),
			);
		});
	});

	// -----------------------------------------------------------------------
	// BRIDGE-1.5 — boot wiring smoke tests for the EventToWorkItemBridge.
	//
	// We can't load the real index.ts (uses import.meta.url) so these
	// tests verify the constructor + lifecycle methods that the boot path
	// relies on, plus the fact that EventToWorkItemBridge.boot accepts
	// only an EventBusService and produces a usable instance.
	// -----------------------------------------------------------------------
	describe('Boot wiring — EventToWorkItemBridge', () => {
		it('boot(eventBus) returns an instance with start/stop/flushPending', async () => {
			const { EventBusService } = await import('./services/event-bus/event-bus.service.js');
			const { EventToWorkItemBridge } = await import(
				'./services/event-bus/event-to-workitem-bridge.service.js'
			);
			const bus = new EventBusService();
			const bridge = EventToWorkItemBridge.boot(bus);

			expect(typeof bridge.start).toBe('function');
			expect(typeof bridge.stop).toBe('function');
			expect(typeof bridge.flushPending).toBe('function');

			// start/stop without throwing
			expect(() => bridge.start()).not.toThrow();
			expect(() => bridge.stop()).not.toThrow();

			bus.cleanup();
		});

		it('exposes the 7 BRIDGE-1 event types via BRIDGE_SUBSCRIBED_EVENTS', async () => {
			const { BRIDGE_SUBSCRIBED_EVENTS } = await import(
				'./services/event-bus/event-to-workitem-bridge.service.js'
			);
			expect(BRIDGE_SUBSCRIBED_EVENTS).toEqual([
				'task:done_by_worker',
				'task:rejected',
				'task:blocked',
				'team:all_tasks_done',
				'mission:review_due',
				'mission:stale',
				'mission:replanned',
			]);
		});
	});

	// -----------------------------------------------------------------------
	// OKR loop closure — boot wiring smoke test for the KRCompletionSubscriber
	// (booted right after the bridge in index.ts, stopped on the same window).
	// -----------------------------------------------------------------------
	describe('Boot wiring — KRCompletionSubscriber', () => {
		it('boot(eventBus) returns an instance with start/stop/flushPending', async () => {
			const { EventBusService } = await import('./services/event-bus/event-bus.service.js');
			const { KRCompletionSubscriber } = await import(
				'./services/v3/kr-completion.subscriber.js'
			);
			const bus = new EventBusService();
			const subscriber = KRCompletionSubscriber.boot(bus);

			expect(typeof subscriber.start).toBe('function');
			expect(typeof subscriber.stop).toBe('function');
			expect(typeof subscriber.flushPending).toBe('function');
			expect(() => subscriber.start()).not.toThrow();
			expect(() => subscriber.stop()).not.toThrow();

			bus.cleanup();
		});
	});
});

// ---------------------------------------------------------------------------
// StartupConfig bindHost resolution + /api token gate mounting
// ---------------------------------------------------------------------------

import { API_SECURITY_CONSTANTS } from './constants.js';
import { apiTokenMiddleware } from './middleware/api-token.middleware.js';
import { resetApiTokenCache } from './services/core/api-token.service.js';

/** Replicates the bindHost resolution in CrewlyServer's constructor. */
function resolveBindHost(config?: { bindHost?: string }): string {
	return (
		config?.bindHost ||
		process.env[API_SECURITY_CONSTANTS.ENV.BIND_HOST] ||
		API_SECURITY_CONSTANTS.DEFAULT_BIND_HOST
	);
}

describe('CrewlyServer bindHost + API token gate', () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
		resetApiTokenCache();
	});

	it('defaults bindHost to 0.0.0.0 for backward compatibility', () => {
		delete process.env.CREWLY_BIND_HOST;
		expect(resolveBindHost()).toBe('0.0.0.0');
	});

	it('honours CREWLY_BIND_HOST and lets config override it', () => {
		process.env.CREWLY_BIND_HOST = '127.0.0.1';
		expect(resolveBindHost()).toBe('127.0.0.1');
		expect(resolveBindHost({ bindHost: '::1' })).toBe('::1');
	});

	it('mounted in front of /api: loopback passes, remote callers need the token, /health stays open', async () => {
		process.env.CREWLY_API_TOKEN = 'idx-test-token';
		const app = express();
		app.use('/api', apiTokenMiddleware);
		app.get('/api/teams', (_req, res) => res.json({ success: true, data: [] }));
		app.get('/health', (_req, res) => res.json({ status: 'ok' }));

		// supertest connects over loopback → no token needed.
		expect((await request(app).get('/api/teams')).status).toBe(200);
		expect((await request(app).get('/health')).status).toBe(200);

		// Simulate a LAN caller by trusting a forwarded address.
		process.env.CREWLY_TRUST_PROXY = '1';
		const denied = await request(app).get('/api/teams').set('X-Forwarded-For', '192.168.1.20');
		expect(denied.status).toBe(401);
		expect(denied.body).toMatchObject({ success: false, error: 'unauthorized' });

		const allowed = await request(app)
			.get('/api/teams')
			.set('X-Forwarded-For', '192.168.1.20')
			.set('X-Crewly-Token', 'idx-test-token');
		expect(allowed.status).toBe(200);

		// /health is outside /api and is never gated.
		expect((await request(app).get('/health').set('X-Forwarded-For', '192.168.1.20')).status).toBe(200);
	});
});
