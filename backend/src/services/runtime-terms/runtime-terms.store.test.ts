/**
 * Tests for the per-machine Terms consent store.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RuntimeTermsStore } from './runtime-terms.store.js';

describe('RuntimeTermsStore', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terms-store-'));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('reads empty, then round-trips a record per runtime', () => {
		const store = RuntimeTermsStore.inHome(dir);
		expect(store.get('antigravity-cli')).toBeNull();
		store.set({ runtime: 'antigravity-cli', status: 'declined', reason: "You chose Don't agree", updatedAt: '2026-10-01T10:00:00.000Z' });
		const again = RuntimeTermsStore.inHome(dir);
		expect(again.get('antigravity-cli')).toEqual({ runtime: 'antigravity-cli', status: 'declined', reason: "You chose Don't agree", updatedAt: '2026-10-01T10:00:00.000Z' });
		expect(Object.keys(again.all())).toEqual(['antigravity-cli']);
		expect(fs.existsSync(path.join(dir, 'runtime-terms-consent.json'))).toBe(true);
	});

	it('reads a corrupt file as empty and drops invalid records', () => {
		const file = path.join(dir, 'runtime-terms-consent.json');
		fs.writeFileSync(file, '{not json');
		expect(new RuntimeTermsStore(file).all()).toEqual({});
		fs.writeFileSync(file, JSON.stringify({ version: 1, runtimes: { a: { status: 'bogus', updatedAt: 'x' }, b: { status: 'accepted', updatedAt: 'x' } } }));
		expect(Object.keys(new RuntimeTermsStore(file).all())).toEqual(['b']);
	});
});
