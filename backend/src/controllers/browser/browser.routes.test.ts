/**
 * Tests for Browser Routes
 *
 * Verifies that all expected browser control routes are registered correctly.
 *
 * @module controllers/browser/browser.routes.test
 */

import { describe, it, expect, vi } from 'vitest';
import { createBrowserRouter } from './browser.routes.js';

// Mock logger
vi.mock('../../services/core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			}),
		}),
	},
}));

// Mock ws module
vi.mock('ws', () => ({
	WebSocketServer: vi.fn(() => ({
		on: vi.fn(),
		close: vi.fn(),
	})),
	WebSocket: { OPEN: 1, CLOSED: 3 },
}));

describe('createBrowserRouter', () => {
	it('should create a router with all expected routes', () => {
		const router = createBrowserRouter();
		expect(router).toBeDefined();

		// Extract registered routes
		const routes = router.stack
			.filter((layer: any) => layer.route)
			.map((layer: any) => ({
				path: layer.route.path,
				methods: Object.keys(layer.route.methods),
			}));

		// Verify key routes exist
		const routePaths = routes.map((r: any) => `${r.methods[0].toUpperCase()} ${r.path}`);

		expect(routePaths).toContain('GET /status');
		expect(routePaths).toContain('GET /instances');
		expect(routePaths).toContain('POST /proxy/connect');
		expect(routePaths).toContain('GET /tabs');
		expect(routePaths).toContain('GET /cookies');
		expect(routePaths).toContain('GET /console');
		expect(routePaths).toContain('POST /navigate');
		expect(routePaths).toContain('POST /screenshot');
		expect(routePaths).toContain('POST /read-text');
		expect(routePaths).toContain('POST /execute');
		expect(routePaths).toContain('POST /execute-js');
		expect(routePaths).toContain('POST /click');
		expect(routePaths).toContain('POST /fill');
		expect(routePaths).toContain('POST /type');
		expect(routePaths).toContain('POST /scroll');
		expect(routePaths).toContain('POST /scroll-in-element');
		expect(routePaths).toContain('POST /hover');
		expect(routePaths).toContain('POST /press-key');
		expect(routePaths).toContain('POST /get-element');
		expect(routePaths).toContain('POST /wait-for-selector');
		expect(routePaths).toContain('POST /local-storage');
		expect(routePaths).toContain('POST /full-page-screenshot');
		expect(routePaths).toContain('POST /get-interactive-elements');
		expect(routePaths).toContain('POST /search-text');
		expect(routePaths).toContain('POST /list-options');
		expect(routePaths).toContain('POST /set-file-input');
	});

	it('should have exactly 26 routes', () => {
		const router = createBrowserRouter();
		const routes = router.stack.filter((layer: any) => layer.route);
		expect(routes.length).toBe(26);
	});
});
