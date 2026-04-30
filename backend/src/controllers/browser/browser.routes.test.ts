/**
 * Tests for Browser Routes
 *
 * Verifies that all expected browser control routes are registered correctly.
 *
 * @module controllers/browser/browser.routes.test
 */

import { createBrowserRouter } from './browser.routes.js';

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

// Mock ws module
jest.mock('ws', () => ({
	WebSocketServer: jest.fn(() => ({
		on: jest.fn(),
		close: jest.fn(),
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
		expect(routePaths).toContain('POST /select-option');
		expect(routePaths).toContain('POST /set-file-input');
		// Per-tab dispatch (M2)
		expect(routePaths).toContain('POST /bind');
		expect(routePaths).toContain('POST /unbind');
		expect(routePaths).toContain('GET /bindings');
	});

	it('should have exactly 30 routes', () => {
		// 27 legacy routes (added /select-option) + 3 per-tab dispatch routes
		// (bind / unbind / bindings).
		const router = createBrowserRouter();
		const routes = router.stack.filter((layer: any) => layer.route);
		expect(routes.length).toBe(30);
	});
});
