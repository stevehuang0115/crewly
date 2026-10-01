/**
 * Tests for the persisted re-login state.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileReloginStateStore, MemoryReloginStateStore } from './relogin-state.store.js';

describe('MemoryReloginStateStore', () => {
	it('merges patches, drops undefined fields, clears with null', () => {
		const store = new MemoryReloginStateStore();
		expect(store.get('claude-code')).toEqual({});
		store.update('claude-code', { signedOutSince: 1, noticeCount: 1 });
		store.update('claude-code', { lastNoticeAt: 2, noticeCount: 2 });
		expect(store.get('claude-code')).toEqual({ signedOutSince: 1, lastNoticeAt: 2, noticeCount: 2 });
		store.update('claude-code', { signedOutSince: undefined });
		expect(store.get('claude-code')).toEqual({ lastNoticeAt: 2, noticeCount: 2 });
		store.update('claude-code', null);
		expect(store.get('claude-code')).toEqual({});
	});

	it('returns copies', () => {
		const store = new MemoryReloginStateStore();
		store.update('codex-cli', { noticeCount: 1 });
		store.get('codex-cli').noticeCount = 99;
		expect(store.get('codex-cli').noticeCount).toBe(1);
	});
});

describe('FileReloginStateStore', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-state-'));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('persists across instances (a backend restart) with mode 0600', () => {
		const file = path.join(dir, 'sub', 'harness-relogin-state.json');
		new FileReloginStateStore(file).update('claude-code', { signedOutSince: 5, lastNoticeAt: 6, noticeCount: 1 });
		expect(new FileReloginStateStore(file).get('claude-code')).toEqual({ signedOutSince: 5, lastNoticeAt: 6, noticeCount: 1 });
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});

	it('starts empty on a missing or corrupt file and ignores unknown harness ids', () => {
		expect(new FileReloginStateStore(path.join(dir, 'none.json')).get('claude-code')).toEqual({});
		const corrupt = path.join(dir, 'corrupt.json');
		fs.writeFileSync(corrupt, '{nope');
		expect(new FileReloginStateStore(corrupt).get('claude-code')).toEqual({});
		const odd = path.join(dir, 'odd.json');
		fs.writeFileSync(odd, JSON.stringify({ harnesses: { cursor: { noticeCount: 3 }, 'codex-cli': { noticeCount: 2 } } }));
		const store = new FileReloginStateStore(odd);
		expect(store.get('codex-cli')).toEqual({ noticeCount: 2 });
		expect(store.entries().map(([id]) => id)).toEqual(['codex-cli']);
	});
});
