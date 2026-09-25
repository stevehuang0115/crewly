/**
 * Tests for the onboarding checklist router configuration.
 */

import { createOnboardingChecklistRouter } from './onboarding-checklist.routes.js';
import type { OnboardingChecklistService } from '../../services/onboarding/onboarding-checklist.service.js';

describe('createOnboardingChecklistRouter', () => {
	it('registers GET/POST-only routes (the relay carries only these)', () => {
		const stack = (createOnboardingChecklistRouter(() => ({}) as OnboardingChecklistService) as unknown as {
			stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
		}).stack;
		const routes = stack.filter((l) => l.route).map((l) => ({ path: l.route!.path, methods: Object.keys(l.route!.methods) }));
		expect(routes).toEqual([
			{ path: '/checklist', methods: ['get'] },
			{ path: '/checklist/dismiss', methods: ['post'] },
			{ path: '/starters', methods: ['get'] },
			{ path: '/starter-team', methods: ['post'] },
			{ path: '/first-task', methods: ['post'] },
		]);
	});
});
