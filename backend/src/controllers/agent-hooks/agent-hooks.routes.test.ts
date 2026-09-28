/**
 * Tests for the /api/agent-hooks router (#815).
 */

import { createAgentHooksRouter } from './agent-hooks.routes.js';

describe('createAgentHooksRouter', () => {
	it('exposes exactly POST /', () => {
		const router = createAgentHooksRouter();
		const routes = (router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>)
			.filter((l) => l.route)
			.map((l) => ({ path: l.route!.path, methods: Object.keys(l.route!.methods) }));
		expect(routes).toEqual([{ path: '/', methods: ['post'] }]);
	});
});
