/**
 * Tests for CLI package-root resolution.
 *
 * Builds throwaway directory trees so the walk-up logic is exercised against
 * real files: a fake global install (`lib/node_modules/crewly/dist/cli/...`
 * reached through a `bin/crewly` symlink) and an unrelated cwd.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	findPackageRoot,
	packageRootCandidates,
	resolvePackageRoot,
	setCliModuleDir,
} from './package-root.js';

let tmp: string;
let pkgRoot: string;
let entryScript: string;
let binLink: string;
let unrelatedCwd: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-pkgroot-'));
	pkgRoot = path.join(tmp, 'lib', 'node_modules', 'crewly');
	const entryDir = path.join(pkgRoot, 'dist', 'cli', 'cli', 'src');
	fs.mkdirSync(entryDir, { recursive: true });
	fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'crewly', version: '0.0.0' }));
	entryScript = path.join(entryDir, 'index.js');
	fs.writeFileSync(entryScript, '');
	fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
	binLink = path.join(tmp, 'bin', 'crewly');
	fs.symlinkSync(path.relative(path.dirname(binLink), entryScript), binLink);
	unrelatedCwd = path.join(tmp, 'somewhere', 'else');
	fs.mkdirSync(unrelatedCwd, { recursive: true });
	fs.writeFileSync(path.join(unrelatedCwd, 'package.json'), JSON.stringify({ name: 'not-crewly' }));
	setCliModuleDir(null);
});

afterEach(() => {
	setCliModuleDir(null);
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('findPackageRoot', () => {
	it('walks up to the package.json named crewly', () => {
		expect(findPackageRoot(path.join(pkgRoot, 'dist', 'cli'))).toBe(pkgRoot);
	});

	it('returns null when no parent is a crewly package', () => {
		expect(findPackageRoot(unrelatedCwd)).toBeNull();
	});

	it('skips a malformed package.json and keeps walking', () => {
		const inner = path.join(pkgRoot, 'dist', 'broken');
		fs.mkdirSync(inner, { recursive: true });
		fs.writeFileSync(path.join(inner, 'package.json'), '{ not json');
		expect(findPackageRoot(inner)).toBe(pkgRoot);
	});
});

describe('packageRootCandidates', () => {
	it('orders registered module dir, realpath of argv[1], then cwd', () => {
		setCliModuleDir('/registered/dir');
		const candidates = packageRootCandidates(binLink, unrelatedCwd);
		expect(candidates[0]).toBe('/registered/dir');
		expect(candidates[1]).toBe(fs.realpathSync(path.dirname(entryScript)));
		expect(candidates[2]).toBe(unrelatedCwd);
	});

	it('falls back to a resolved path when argv[1] cannot be realpath-ed', () => {
		const ghost = path.join(tmp, 'ghost', 'index.js');
		expect(packageRootCandidates(ghost, unrelatedCwd)).toEqual([path.dirname(ghost), unrelatedCwd]);
	});

	it('omits argv[1] when empty', () => {
		expect(packageRootCandidates('', unrelatedCwd)).toEqual([unrelatedCwd]);
	});
});

describe('resolvePackageRoot', () => {
	it('finds the global install through the bin symlink from an unrelated cwd (finding 8)', () => {
		expect(resolvePackageRoot(binLink, unrelatedCwd)).toBe(fs.realpathSync(pkgRoot));
	});

	it('prefers the registered module dir over argv[1]', () => {
		const other = path.join(tmp, 'other-crewly');
		fs.mkdirSync(path.join(other, 'cli'), { recursive: true });
		fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'crewly' }));
		setCliModuleDir(path.join(other, 'cli'));
		expect(resolvePackageRoot(binLink, unrelatedCwd)).toBe(other);
	});

	it('falls back to cwd for source checkouts run via tsx', () => {
		const jestBin = path.join(tmp, 'jest', 'bin', 'jest.js');
		fs.mkdirSync(path.dirname(jestBin), { recursive: true });
		fs.writeFileSync(jestBin, '');
		expect(resolvePackageRoot(jestBin, path.join(pkgRoot, 'dist'))).toBe(pkgRoot);
	});

	it('returns null when nothing is inside a crewly package', () => {
		expect(resolvePackageRoot('', unrelatedCwd)).toBeNull();
	});
});
