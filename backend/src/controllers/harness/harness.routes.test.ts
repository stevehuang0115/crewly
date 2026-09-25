/**
 * Tests for the harness router configuration.
 */

import { createHarnessRouter } from './harness.routes.js';

describe('createHarnessRouter', () => {
	it('registers the contract routes, static paths before /:id', () => {
		const stack = (createHarnessRouter() as unknown as {
			stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
		}).stack;
		const routes = stack.filter((l) => l.route).map((l) => ({ path: l.route!.path, methods: Object.keys(l.route!.methods) }));
		expect(routes).toEqual([
			{ path: '/', methods: ['get'] },
			{ path: '/install/:jobId', methods: ['get'] },
			{ path: '/orc', methods: ['put'] },
			{ path: '/orc', methods: ['post'] },
			{ path: '/login/:sessionId', methods: ['get'] },
			{ path: '/login/:sessionId/input', methods: ['post'] },
			{ path: '/login/:sessionId/cancel', methods: ['post'] },
			{ path: '/:id/install', methods: ['post'] },
			{ path: '/:id/login', methods: ['post'] },
			{ path: '/:id/api-key', methods: ['post'] },
		]);
	});
});
