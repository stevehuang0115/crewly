/**
 * Tests for runtime-fallback persistence.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileRuntimeFallbackStore, MemoryRuntimeFallbackStore, normalizeState } from './runtime-fallback.store.js';

describe('FileRuntimeFallbackStore', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-store-'));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('reads defaults when the file is missing or corrupt', () => {
		const file = path.join(dir, 'runtime-fallback.json');
		const store = new FileRuntimeFallbackStore(file);
		expect(store.load()).toMatchObject({ version: 1, exhausted: {}, overrides: {} });
		fs.writeFileSync(file, '{not json');
		expect(store.load().settings.chain).toEqual(['claude-code', 'crewly-agent', 'antigravity-cli']);
	});

	it('round-trips state', () => {
		const store = new FileRuntimeFallbackStore(path.join(dir, 'sub', 'runtime-fallback.json'));
		const state = store.load();
		state.exhausted['claude-code'] = {
			runtime: 'claude-code',
			since: '2026-10-01T12:00:00.000Z',
			until: '2026-10-01T22:00:00.000Z',
			ruleId: 'claude.hit_your_limit',
			switched: ['dev-1'],
			switchedTo: ['crewly-agent'],
			notified: true,
		};
		state.overrides['dev-1'] = { runtime: 'crewly-agent', primary: 'claude-code', reason: 'usage_limit', since: '2026-10-01T12:00:00.000Z', primarySessionId: 'abc' };
		store.save(state);
		expect(store.load()).toEqual(state);
	});
});

describe('normalizeState', () => {
	it('drops malformed entries', () => {
		const s = normalizeState({ exhausted: { x: { nope: 1 } }, overrides: { a: { runtime: 'x' } } });
		expect(s.exhausted).toEqual({});
		expect(s.overrides).toEqual({});
	});

	it('memory store returns copies', () => {
		const store = new MemoryRuntimeFallbackStore();
		const a = store.load();
		a.overrides.x = { runtime: 'a', primary: 'b', reason: 'usage_limit', since: 'now' };
		expect(store.load().overrides).toEqual({});
	});
});
