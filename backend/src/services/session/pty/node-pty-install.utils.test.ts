/**
 * Tests for node-pty install-state helpers (#778).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	ensureSpawnHelperExecutable,
	findLoadedNodePtyDir,
	nodePtyNativeDirs,
	resolveNodePtyDir,
	SPAWN_HELPER_NAME,
} from './node-pty-install.utils.js';

let pkg: string;

beforeEach(() => {
	pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-node-pty-'));
});

afterEach(() => {
	fs.rmSync(pkg, { recursive: true, force: true });
});

/** Create a helper file with the given mode and return its path. */
function writeHelper(relDir: string, mode: number): string {
	const dir = path.join(pkg, relDir);
	fs.mkdirSync(dir, { recursive: true });
	const helper = path.join(dir, SPAWN_HELPER_NAME);
	fs.writeFileSync(helper, '#!/bin/sh\n');
	fs.chmodSync(helper, mode);
	return helper;
}

const isExecutable = (p: string): boolean => (fs.statSync(p).mode & 0o111) !== 0;

describe('nodePtyNativeDirs', () => {
	it('lists node-pty lookup dirs in its load order (build first, prebuild last)', () => {
		expect(nodePtyNativeDirs('/p', 'darwin', 'arm64')).toEqual([
			path.join('/p', 'build', 'Release'),
			path.join('/p', 'build', 'Debug'),
			path.join('/p', 'prebuilds', 'darwin-arm64'),
		]);
	});
});

describe('ensureSpawnHelperExecutable', () => {
	const posixOnly = process.platform === 'win32' ? it.skip : it;

	posixOnly('restores the exec bit on a 0644 prebuild helper (node-pty#850)', () => {
		const helper = writeHelper('prebuilds/darwin-arm64', 0o644);
		const res = ensureSpawnHelperExecutable(pkg, 'darwin', 'arm64');
		expect(res).toEqual({ fixed: [helper], failed: [] });
		expect(isExecutable(helper)).toBe(true);
	});

	posixOnly('also fixes a from-source build helper and leaves executable ones alone', () => {
		const built = writeHelper('build/Release', 0o600);
		const prebuilt = writeHelper('prebuilds/darwin-x64', 0o755);
		const res = ensureSpawnHelperExecutable(pkg, 'darwin', 'x64');
		expect(res.fixed).toEqual([built]);
		expect(isExecutable(prebuilt)).toBe(true);
	});

	it('ignores other arches, missing helpers (Linux prebuilds) and Windows', () => {
		writeHelper('prebuilds/darwin-x64', 0o644);
		fs.mkdirSync(path.join(pkg, 'prebuilds', 'linux-x64'), { recursive: true });
		expect(ensureSpawnHelperExecutable(pkg, 'linux', 'x64')).toEqual({ fixed: [], failed: [] });
		expect(ensureSpawnHelperExecutable(pkg, 'darwin', 'arm64')).toEqual({ fixed: [], failed: [] });
		expect(ensureSpawnHelperExecutable(pkg, 'win32', 'x64')).toEqual({ fixed: [], failed: [] });
	});

	posixOnly('reports a helper it cannot chmod instead of throwing', () => {
		const helper = writeHelper('prebuilds/darwin-arm64', 0o644);
		const res = ensureSpawnHelperExecutable(pkg, 'darwin', 'arm64', () => {
			throw new Error('EROFS: read-only file system');
		});
		expect(res.fixed).toEqual([]);
		expect(res.failed).toEqual([{ path: helper, error: 'EROFS: read-only file system' }]);
	});
});

describe('resolveNodePtyDir', () => {
	it('returns the package dir, or null when node-pty cannot be resolved', () => {
		expect(resolveNodePtyDir(() => '/x/node_modules/node-pty/package.json')).toBe('/x/node_modules/node-pty');
		expect(
			resolveNodePtyDir(() => {
				throw new Error('Cannot find module');
			}),
		).toBeNull();
	});
});

describe('findLoadedNodePtyDir', () => {
	it('finds the loaded node-pty package from require.cache keys', () => {
		const key = path.join('/opt', 'crewly', 'node_modules', 'node-pty', 'lib', 'index.js');
		expect(findLoadedNodePtyDir({ [path.join('/opt', 'x.js')]: {}, [key]: {} })).toBe(
			path.join('/opt', 'crewly', 'node_modules', 'node-pty'),
		);
	});

	it('returns null when node-pty is not loaded (or a look-alike package is)', () => {
		expect(findLoadedNodePtyDir(undefined)).toBeNull();
		expect(findLoadedNodePtyDir({ [path.join('/x', 'my-node-pty', 'lib', 'index.js')]: {} })).toBeNull();
	});
});
