/**
 * Tests for the skill-setup router configuration.
 */

import { createSkillSetupRouter } from './skill-setup.routes.js';

describe('createSkillSetupRouter', () => {
	it('registers the find / install / job / status routes', () => {
		const stack = (createSkillSetupRouter({ discovery: () => ({}) as never, jobs: () => ({}) as never }) as unknown as {
			stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
		}).stack;
		const routes = stack.filter((l) => l.route).map((l) => ({ path: l.route!.path, methods: Object.keys(l.route!.methods) }));
		expect(routes).toEqual([
			{ path: '/find', methods: ['get'] },
			{ path: '/install', methods: ['post'] },
			{ path: '/jobs/:jobId', methods: ['get'] },
			{ path: '/status/:id', methods: ['get'] },
		]);
	});
});
