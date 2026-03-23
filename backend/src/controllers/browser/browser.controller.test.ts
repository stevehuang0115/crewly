/**
 * Tests for Browser Controller
 *
 * @module controllers/browser/browser.controller.test
 */

import express from 'express';
import request from 'supertest';
import { createBrowserRouter } from './browser.routes.js';
import { BrowserBridgeService } from '../../services/browser/browser-bridge.service.js';

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
			expect(res.body).toEqual({
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
