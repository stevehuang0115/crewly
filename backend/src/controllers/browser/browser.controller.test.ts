/**
 * Tests for Browser Controller
 *
 * Covers the original 503-when-disconnected surface AND the M2 per-tab
 * dispatch handlers (`/bind`, `/unbind`, `/bindings`) plus the tabId
 * resolution priority threading agentSession through to the bridge.
 *
 * @module controllers/browser/browser.controller.test
 */

import express from 'express';
import request from 'supertest';
import { createBrowserRouter } from './browser.routes.js';
import {
	BrowserBridgeService,
	type BrowserCommandResponse,
} from '../../services/browser/browser-bridge.service.js';

// Mock logger
jest.mock('../../services/core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				info: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
				debug: jest.fn(),
			}),
		}),
	},
}));

// Mock ws module (not needed for controller tests but required by service import)
jest.mock('ws', () => ({
	WebSocketServer: jest.fn(() => ({
		on: jest.fn(),
		close: jest.fn(),
	})),
	WebSocket: { OPEN: 1, CLOSED: 3 },
}));

describe('Browser Controller', () => {
	let app: express.Application;

	beforeEach(() => {
		BrowserBridgeService.resetInstance();
		app = express();
		app.use(express.json());
		app.use('/api/browser', createBrowserRouter());
	});

	afterEach(() => {
		BrowserBridgeService.resetInstance();
	});

	describe('GET /api/browser/status', () => {
		it('should return disconnected status when no Chrome Extension is connected', async () => {
			const res = await request(app).get('/api/browser/status');
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				connected: false,
				clientCount: 0,
				wsPath: '/ws/browser',
			});
		});
	});

	describe('POST /api/browser/navigate', () => {
		it('should return 503 when no Chrome Extension is connected', async () => {
			const res = await request(app)
				.post('/api/browser/navigate')
				.send({ url: 'https://example.com' });
			expect(res.status).toBe(503);
			expect(res.body.code).toBe('NO_BROWSER_CLIENT');
		});
	});

	describe('POST /api/browser/screenshot', () => {
		it('should return 503 when no Chrome Extension is connected', async () => {
			const res = await request(app).post('/api/browser/screenshot');
			expect(res.status).toBe(503);
			expect(res.body.code).toBe('NO_BROWSER_CLIENT');
		});
	});

	describe('POST /api/browser/read-text', () => {
		it('should return 503 when not connected', async () => {
			const res = await request(app)
				.post('/api/browser/read-text')
				.send({});
			expect(res.status).toBe(503);
			expect(res.body.code).toBe('NO_BROWSER_CLIENT');
		});
	});

	describe('GET /api/browser/tabs', () => {
		it('should return 503 when not connected', async () => {
			const res = await request(app).get('/api/browser/tabs');
			expect(res.status).toBe(503);
			expect(res.body.code).toBe('NO_BROWSER_CLIENT');
		});
	});

	describe('POST /api/browser/click', () => {
		it('should return 503 when not connected', async () => {
			const res = await request(app)
				.post('/api/browser/click')
				.send({ selector: '#btn' });
			expect(res.status).toBe(503);
			expect(res.body.code).toBe('NO_BROWSER_CLIENT');
		});
	});

	describe('POST /api/browser/execute', () => {
		it('should return 503 when not connected', async () => {
			const res = await request(app)
				.post('/api/browser/execute')
				.send({ code: 'document.title' });
			expect(res.status).toBe(503);
			expect(res.body.code).toBe('NO_BROWSER_CLIENT');
		});
	});

	describe('GET /api/browser/cookies', () => {
		it('should return 503 when not connected', async () => {
			const res = await request(app).get('/api/browser/cookies');
			expect(res.status).toBe(503);
			expect(res.body.code).toBe('NO_BROWSER_CLIENT');
		});
	});

	describe('GET /api/browser/console', () => {
		it('should return 503 when not connected', async () => {
			const res = await request(app).get('/api/browser/console');
			expect(res.status).toBe(503);
			expect(res.body.code).toBe('NO_BROWSER_CLIENT');
		});
	});

	describe('POST /api/browser/fill', () => {
		it('should return 503 when not connected', async () => {
			const res = await request(app)
				.post('/api/browser/fill')
				.send({ selector: '#input', value: 'hello' });
			expect(res.status).toBe(503);
		});
	});

	describe('POST /api/browser/hover', () => {
		it('should return 503 when not connected', async () => {
			const res = await request(app)
				.post('/api/browser/hover')
				.send({ selector: '#link' });
			expect(res.status).toBe(503);
		});
	});

	describe('POST /api/browser/full-page-screenshot', () => {
		it('should return 503 when not connected', async () => {
			const res = await request(app).post('/api/browser/full-page-screenshot');
			expect(res.status).toBe(503);
		});
	});

	describe('POST /api/browser/search-text', () => {
		it('should return 503 when not connected', async () => {
			const res = await request(app)
				.post('/api/browser/search-text')
				.send({ text: 'hello' });
			expect(res.status).toBe(503);
		});
	});
});

// ---------------------------------------------------------------------------
// Per-tab dispatch (M2) — bind / unbind / bindings + tabId resolution priority
// ---------------------------------------------------------------------------

/**
 * Mark the bridge as connected so `sendToolCommand` enters Path 2 (the
 * direct-WS branch) where per-tab routing lives. We only need
 * `isConnected()` to return true; the actual WS plumbing is irrelevant
 * because we stub the methods that would have hit it.
 */
function markBridgeConnected(bridge: BrowserBridgeService): void {
	jest.spyOn(bridge, 'isConnected').mockReturnValue(true);
}

describe('Browser Controller — per-tab dispatch (M2)', () => {
	let app: express.Application;

	beforeEach(() => {
		BrowserBridgeService.resetInstance();
		app = express();
		app.use(express.json());
		app.use('/api/browser', createBrowserRouter());
		jest.restoreAllMocks();
	});

	afterEach(() => {
		BrowserBridgeService.resetInstance();
		jest.restoreAllMocks();
	});

	// -------------------------------------------------------------------------
	// POST /api/browser/bind
	// -------------------------------------------------------------------------

	describe('POST /api/browser/bind', () => {
		it('returns 400 when X-Agent-Session header is missing', async () => {
			const bridge = BrowserBridgeService.getInstance();
			markBridgeConnected(bridge);
			const res = await request(app).post('/api/browser/bind').send({});
			expect(res.status).toBe(400);
			expect(res.body.error).toBe('agent_session_required');
		});

		it('returns 503 NO_BROWSER_CLIENT when extension not connected', async () => {
			// bridge.isConnected() returns false by default — no Extension wired.
			const res = await request(app)
				.post('/api/browser/bind')
				.set('X-Agent-Session', 'agent-A')
				.send({});
			expect(res.status).toBe(503);
			expect(res.body.code).toBe('NO_BROWSER_CLIENT');
		});

		it('returns the new tabId on success and increments bindingCount', async () => {
			const bridge = BrowserBridgeService.getInstance();
			markBridgeConnected(bridge);
			jest.spyOn(bridge, 'bindAgentTab').mockResolvedValue({
				agentSession: 'agent-A',
				tabId: 42,
				windowId: 9,
				boundAt: new Date(),
				lastActivityAt: new Date(),
			});

			const res = await request(app)
				.post('/api/browser/bind')
				.set('X-Agent-Session', 'agent-A')
				.send({});

			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				success: true,
				data: { tabId: 42, windowId: 9 },
			});
			// bindAgentTab called with foreground=false by default
			expect(bridge.bindAgentTab).toHaveBeenCalledWith(
				'agent-A',
				expect.objectContaining({ foreground: false })
			);
		});

		it('forwards foreground:true when body.active === true', async () => {
			const bridge = BrowserBridgeService.getInstance();
			markBridgeConnected(bridge);
			const spy = jest.spyOn(bridge, 'bindAgentTab').mockResolvedValue({
				agentSession: 'agent-A',
				tabId: 7,
				boundAt: new Date(),
				lastActivityAt: new Date(),
			});

			await request(app)
				.post('/api/browser/bind')
				.set('X-Agent-Session', 'agent-A')
				.send({ active: true });

			expect(spy).toHaveBeenCalledWith(
				'agent-A',
				expect.objectContaining({ foreground: true })
			);
		});

		it('returns 503 with retryAfterMs when tab pool is full', async () => {
			const bridge = BrowserBridgeService.getInstance();
			markBridgeConnected(bridge);
			const err = new Error('tab_pool_full: 50 bindings at hard cap 50');
			(err as Error & { code?: string }).code = 'tab_pool_full';
			jest.spyOn(bridge, 'bindAgentTab').mockRejectedValue(err);

			const res = await request(app)
				.post('/api/browser/bind')
				.set('X-Agent-Session', 'agent-A')
				.send({});

			expect(res.status).toBe(503);
			expect(res.body.error).toBe('tab_pool_full');
			expect(typeof res.body.retryAfterMs).toBe('number');
			expect(res.body.retryAfterMs).toBeGreaterThan(0);
		});

		it('returns 502 bind_failed for other Extension errors', async () => {
			const bridge = BrowserBridgeService.getInstance();
			markBridgeConnected(bridge);
			jest.spyOn(bridge, 'bindAgentTab').mockRejectedValue(
				new Error('Extension refused: permission_denied')
			);

			const res = await request(app)
				.post('/api/browser/bind')
				.set('X-Agent-Session', 'agent-A')
				.send({});

			expect(res.status).toBe(502);
			expect(res.body.error).toBe('bind_failed');
			expect(res.body.details).toMatch(/permission_denied/);
		});
	});

	// -------------------------------------------------------------------------
	// POST /api/browser/unbind
	// -------------------------------------------------------------------------

	describe('POST /api/browser/unbind', () => {
		it('returns 400 when X-Agent-Session header is missing', async () => {
			const res = await request(app).post('/api/browser/unbind').send({});
			expect(res.status).toBe(400);
			expect(res.body.error).toBe('agent_session_required');
		});

		it('returns 200 with released:true when unbind succeeded', async () => {
			const bridge = BrowserBridgeService.getInstance();
			jest.spyOn(bridge, 'unbindAgentTab').mockResolvedValue({
				released: true,
				tabClosed: true,
			});

			const res = await request(app)
				.post('/api/browser/unbind')
				.set('X-Agent-Session', 'agent-A')
				.send({});

			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				success: true,
				data: { released: true, tabClosed: true },
			});
			expect(bridge.unbindAgentTab).toHaveBeenCalledWith(
				'agent-A',
				expect.objectContaining({ closeTab: true })
			);
		});

		it('returns released:false when no binding existed', async () => {
			const bridge = BrowserBridgeService.getInstance();
			jest.spyOn(bridge, 'unbindAgentTab').mockResolvedValue({
				released: false,
				tabClosed: false,
			});

			const res = await request(app)
				.post('/api/browser/unbind')
				.set('X-Agent-Session', 'agent-no-binding')
				.send({});

			expect(res.status).toBe(200);
			expect(res.body.data.released).toBe(false);
		});

		it('forwards closeTab:false when body.closeTab === false', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const spy = jest.spyOn(bridge, 'unbindAgentTab').mockResolvedValue({
				released: true,
				tabClosed: false,
			});

			await request(app)
				.post('/api/browser/unbind')
				.set('X-Agent-Session', 'agent-A')
				.send({ closeTab: false });

			expect(spy).toHaveBeenCalledWith(
				'agent-A',
				expect.objectContaining({ closeTab: false })
			);
		});
	});

	// -------------------------------------------------------------------------
	// GET /api/browser/bindings
	// -------------------------------------------------------------------------

	describe('GET /api/browser/bindings', () => {
		it('returns the binding snapshot plus cap metadata', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const fakeBoundAt = new Date('2026-04-25T00:00:00.000Z');
			const fakeActivity = new Date('2026-04-25T01:00:00.000Z');
			jest.spyOn(bridge, 'listBindings').mockReturnValue([
				{
					agentSession: 'agent-A',
					tabId: 11,
					boundAt: fakeBoundAt,
					lastActivityAt: fakeActivity,
				},
				{
					agentSession: 'agent-B',
					tabId: 12,
					boundAt: fakeBoundAt,
					lastActivityAt: fakeActivity,
				},
			]);

			const res = await request(app).get('/api/browser/bindings');
			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(res.body.data.bindings).toHaveLength(2);
			expect(res.body.data.bindings[0].tabId).toBe(11);
			expect(res.body.data.bindings[1].tabId).toBe(12);
			expect(typeof res.body.data.hardCap).toBe('number');
			expect(typeof res.body.data.softWarn).toBe('number');
		});
	});

	// -------------------------------------------------------------------------
	// tabId resolution priority on data-plane endpoints (§4.2)
	// -------------------------------------------------------------------------

	describe('tabId resolution priority on POST /api/browser/navigate', () => {
		const okResponse: BrowserCommandResponse = {
			id: 'r1',
			success: true,
			result: { url: 'https://example.com' },
		};

		it('routes through sendCommandForAgent when X-Agent-Session is set', async () => {
			const bridge = BrowserBridgeService.getInstance();
			markBridgeConnected(bridge);
			const spy = jest
				.spyOn(bridge, 'sendCommandForAgent')
				.mockResolvedValue(okResponse);
			jest.spyOn(bridge, 'sendCommand').mockResolvedValue(okResponse);

			await request(app)
				.post('/api/browser/navigate')
				.set('X-Agent-Session', 'agent-A')
				.send({ url: 'https://example.com' });

			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith(
				'agent-A',
				'navigate',
				expect.objectContaining({ url: 'https://example.com' }),
				undefined,
				expect.any(String)
			);
			expect(bridge.sendCommand).not.toHaveBeenCalled();
		});

		it('falls back to sendCommand (legacy active-tab) when no agentSession is set', async () => {
			const bridge = BrowserBridgeService.getInstance();
			markBridgeConnected(bridge);
			const sendSpy = jest.spyOn(bridge, 'sendCommand').mockResolvedValue(okResponse);
			const forAgentSpy = jest
				.spyOn(bridge, 'sendCommandForAgent')
				.mockResolvedValue(okResponse);

			await request(app)
				.post('/api/browser/navigate')
				.send({ url: 'https://example.com' });

			expect(sendSpy).toHaveBeenCalledTimes(1);
			expect(forAgentSpy).not.toHaveBeenCalled();
		});

		it('returns 403 when explicit tabId is owned by a different agent', async () => {
			const bridge = BrowserBridgeService.getInstance();
			markBridgeConnected(bridge);
			jest.spyOn(bridge, 'listBindings').mockReturnValue([
				{
					agentSession: 'agent-other',
					tabId: 99,
					boundAt: new Date(),
					lastActivityAt: new Date(),
				},
			]);
			jest.spyOn(bridge, 'sendCommandForAgent').mockResolvedValue(okResponse);

			const res = await request(app)
				.post('/api/browser/navigate')
				.set('X-Agent-Session', 'agent-mine')
				.send({ url: 'https://example.com', tabId: 99 });

			expect(res.status).toBe(403);
			expect(res.body.error).toBe('tab_owned_by_other_agent');
			expect(bridge.sendCommandForAgent).not.toHaveBeenCalled();
		});

		it('allows explicit tabId when it belongs to the calling agent', async () => {
			const bridge = BrowserBridgeService.getInstance();
			markBridgeConnected(bridge);
			jest.spyOn(bridge, 'listBindings').mockReturnValue([
				{
					agentSession: 'agent-mine',
					tabId: 77,
					boundAt: new Date(),
					lastActivityAt: new Date(),
				},
			]);
			const spy = jest
				.spyOn(bridge, 'sendCommandForAgent')
				.mockResolvedValue(okResponse);

			const res = await request(app)
				.post('/api/browser/navigate')
				.set('X-Agent-Session', 'agent-mine')
				.send({ url: 'https://example.com', tabId: 77 });

			expect(res.status).toBe(200);
			expect(spy).toHaveBeenCalled();
		});

		it('allows explicit tabId when no agent owns that tabId yet', async () => {
			const bridge = BrowserBridgeService.getInstance();
			markBridgeConnected(bridge);
			jest.spyOn(bridge, 'listBindings').mockReturnValue([]);
			const spy = jest
				.spyOn(bridge, 'sendCommandForAgent')
				.mockResolvedValue(okResponse);

			const res = await request(app)
				.post('/api/browser/navigate')
				.set('X-Agent-Session', 'agent-anon')
				.send({ url: 'https://example.com', tabId: 33 });

			expect(res.status).toBe(200);
			expect(spy).toHaveBeenCalled();
		});
	});
});
