/**
 * Tests for the Talk transcription router (#1074).
 */

import { createTalkTranscribeRouter } from './talk-transcribe.routes.js';

describe('createTalkTranscribeRouter', () => {
	it('registers status, setup and transcribe', () => {
		const stack = (createTalkTranscribeRouter() as unknown as {
			stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
		}).stack;
		const routes = stack.filter((l) => l.route).map((l) => ({ path: l.route?.path, methods: Object.keys(l.route?.methods ?? {}) }));
		expect(routes).toEqual([
			{ path: '/status', methods: ['get'] },
			{ path: '/setup', methods: ['post'] },
			{ path: '/', methods: ['post'] },
		]);
	});
});
