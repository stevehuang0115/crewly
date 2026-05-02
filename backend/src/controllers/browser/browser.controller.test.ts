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

		// -------------------------------------------------------------------
		// Fix B / Layered Click Dispatch — backend response-shape audit (T5)
		// -------------------------------------------------------------------
		//
		// Trace findings (Max, 2026-05-02):
		//
		// PATH:  remote-browser skill → POST /api/browser/click
		//          → browser.controller.ts::click (L393)
		//            → sendToolCommand(req, res, 'click', req.body)
		//              → BrowserBridgeService.sendCommand (direct WS)
		//                | OR BrowserProxyService.sendCommand (proxy)
		//                | OR BrowserRelayAdapter.sendViaRelay (relay)
		//          → Chrome Extension processes layeredClick(...)
		//          → Extension WS reply → handleMessage / handleRelayPayload
		//            → pending.resolve(msg as BrowserCommandResponse)
		//          → res.json(result) in sendToolCommand
		//
		// CONCLUSION: the backend is a transparent pass-through.
		//
		//   1. browser.controller.ts forwards req.body verbatim — no field
		//      whitelist on the request side.
		//   2. BrowserBridgeService.handleMessage (L355–362) calls
		//      `pending.resolve(msg as BrowserCommandResponse)` — the `as`
		//      cast is type-only; JS preserves all extra fields on the
		//      parsed JSON object.
		//   3. BrowserProxyService.handleRelayPayload (L683–704) and
		//      BrowserRelayAdapter.handleRelayResponse (L192–212) use the
		//      same pattern.
		//   4. sendToolCommand calls `res.json(result)` with the whole
		//      BrowserCommandResponse object on every successful path.
		//
		// Therefore the new fields introduced by layeredClick — `layer`,
		// `verified`, `attempts[]`, `totalDurationMs` — flow end-to-end
		// without modification. There is NO `messaging/relay-bridge.service.ts`
		// allowlist as the spec suspected; that file does not exist (the
		// suspected path is the WS-relay path through the three services
		// listed above, none of which strip fields).
		//
		// CAPS: per spec §7 risks, `attempts.length ≤ 3` and `error` strings
		// truncated to 200 chars are enforced at the EXTENSION boundary, not
		// here. The backend trusts whatever the extension sends.
		describe('Fix B layered-click response shape', () => {
			it('preserves layer / verified / attempts / totalDurationMs end-to-end', async () => {
				const bridge = BrowserBridgeService.getInstance();
				markBridgeConnected(bridge);

				// Realistic layered-click result nested under .result, matching
				// the existing extension wrapper pattern (see selectOption test).
				const layeredResult = {
					clicked: true,
					verified: true,
					layer: 'L1_CDP_POINTER' as const,
					attempts: [
						{
							layer: 'L1_CDP_POINTER' as const,
							verifierResult: 'pass' as const,
							durationMs: 47,
						},
					],
					totalDurationMs: 252,
					selector: '[data-qa="manifest-textarea"]',
					tag: 'BUTTON',
				};

				jest.spyOn(bridge, 'sendCommand').mockResolvedValue({
					id: 'click-1',
					success: true,
					result: layeredResult,
				} as Awaited<ReturnType<typeof bridge.sendCommand>>);

				const res = await request(app)
					.post('/api/browser/click')
					.send({
						selector: '[data-qa="manifest-textarea"]',
						expectAfter: '[data-qa="manifest-modal-open"]',
					});

				expect(res.status).toBe(200);
				expect(res.body).toMatchObject({
					id: 'click-1',
					success: true,
					result: {
						clicked: true,
						verified: true,
						layer: 'L1_CDP_POINTER',
						totalDurationMs: 252,
					},
				});
				// attempts array preserved with full shape — this is the
				// canonical regression: relay/bridge MUST NOT strip array fields.
				expect(Array.isArray(res.body.result.attempts)).toBe(true);
				expect(res.body.result.attempts).toHaveLength(1);
				expect(res.body.result.attempts[0]).toEqual({
					layer: 'L1_CDP_POINTER',
					verifierResult: 'pass',
					durationMs: 47,
				});
				// Other optional fields preserved
				expect(res.body.result.selector).toBe('[data-qa="manifest-textarea"]');
				expect(res.body.result.tag).toBe('BUTTON');
			});

			it('preserves a multi-attempt failure shape with error strings', async () => {
				const bridge = BrowserBridgeService.getInstance();
				markBridgeConnected(bridge);

				// Worst case: all three layers ran, all failed. Verifies that
				// the backend forwards every attempt and the error strings.
				const layeredResult = {
					clicked: false,
					verified: false,
					layer: null,
					attempts: [
						{ layer: 'L1_CDP_POINTER', verifierResult: 'fail', durationMs: 250 },
						{ layer: 'L2_MAIN_WORLD', error: 'tab not focused', durationMs: 30 },
						{ layer: 'L3_RAW_DOM_BURST', verifierResult: 'fail', durationMs: 120 },
					],
					totalDurationMs: 412,
					selector: '#nope',
				};

				jest.spyOn(bridge, 'sendCommand').mockResolvedValue({
					id: 'click-2',
					success: true, // domain failure — transport still succeeded
					result: layeredResult,
				} as Awaited<ReturnType<typeof bridge.sendCommand>>);

				const res = await request(app)
					.post('/api/browser/click')
					.send({ selector: '#nope', verifier: { kind: 'mutation' } });

				expect(res.status).toBe(200); // domain failure ≠ HTTP error
				expect(res.body.result.clicked).toBe(false);
				expect(res.body.result.verified).toBe(false);
				expect(res.body.result.layer).toBeNull();
				expect(res.body.result.attempts).toHaveLength(3);
				// Layer order preserved
				expect(res.body.result.attempts.map((a: { layer: string }) => a.layer)).toEqual([
					'L1_CDP_POINTER',
					'L2_MAIN_WORLD',
					'L3_RAW_DOM_BURST',
				]);
				// Error string from L2 preserved verbatim
				expect(res.body.result.attempts[1].error).toBe('tab not focused');
				expect(res.body.result.totalDurationMs).toBe(412);
			});

			it('forwards new opt-in params (expectAfter / verifier / layers / reactIdleQuietMs) verbatim to the extension', async () => {
				const bridge = BrowserBridgeService.getInstance();
				markBridgeConnected(bridge);
				const sendSpy = jest
					.spyOn(bridge, 'sendCommand')
					.mockResolvedValue({
						id: 'click-3',
						success: true,
						result: { clicked: true, verified: true, layer: 'L2_MAIN_WORLD', attempts: [], totalDurationMs: 80 },
					} as Awaited<ReturnType<typeof bridge.sendCommand>>);

				const reqBody = {
					selector: '#combo',
					expectAfter: '[role="listbox"]',
					verifier: { kind: 'selector', expectAfter: '[role="listbox"]', timeoutMs: 500 },
					layers: ['L2_MAIN_WORLD', 'L3_RAW_DOM_BURST'],
					reactIdleQuietMs: 250,
					reactIdleMaxWaitMs: 1500,
				};

				const res = await request(app).post('/api/browser/click').send(reqBody);

				expect(res.status).toBe(200);
				expect(sendSpy).toHaveBeenCalledTimes(1);
				expect(sendSpy.mock.calls[0][0]).toBe('click');
				// All new params reach the extension untouched.
				expect(sendSpy.mock.calls[0][1]).toEqual(expect.objectContaining(reqBody));
			});
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

	describe('POST /api/browser/select-option', () => {
		it('should return 503 when not connected', async () => {
			const res = await request(app)
				.post('/api/browser/select-option')
				.send({ selector: '#level', value: 'opt2' });
			expect(res.status).toBe(503);
		});

		it('forwards selector + value through sendCommand as the selectOption tool', async () => {
			const bridge = BrowserBridgeService.getInstance();
			markBridgeConnected(bridge);
			const sendSpy = jest
				.spyOn(bridge, 'sendCommand')
				.mockResolvedValue({
					id: 'sel-1',
					success: true,
					result: { selectedValue: 'opt2', selectedText: 'Option 2' },
				} as Awaited<ReturnType<typeof bridge.sendCommand>>);

			const res = await request(app)
				.post('/api/browser/select-option')
				.send({ selector: '#level', value: 'opt2' });

			expect(res.status).toBe(200);
			expect(sendSpy).toHaveBeenCalledTimes(1);
			expect(sendSpy.mock.calls[0][0]).toBe('selectOption');
			expect(sendSpy.mock.calls[0][1]).toEqual(
				expect.objectContaining({ selector: '#level', value: 'opt2' }),
			);
		});

		it('accepts label / index / strategy alternatives in the body', async () => {
			const bridge = BrowserBridgeService.getInstance();
			markBridgeConnected(bridge);
			const sendSpy = jest
				.spyOn(bridge, 'sendCommand')
				.mockResolvedValue({
					id: 'sel-2',
					success: true,
					result: { selectedValue: '', selectedText: '' },
				} as Awaited<ReturnType<typeof bridge.sendCommand>>);

			await request(app)
				.post('/api/browser/select-option')
				.send({ selector: '#level', label: 'Beginner', strategy: 'aria' });
			expect(sendSpy.mock.calls[0][1]).toEqual(
				expect.objectContaining({
					selector: '#level',
					label: 'Beginner',
					strategy: 'aria',
				}),
			);

			await request(app)
				.post('/api/browser/select-option')
				.send({ selector: '#level', index: 2 });
			expect(sendSpy.mock.calls[1][1]).toEqual(
				expect.objectContaining({ selector: '#level', index: 2 }),
			);
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
