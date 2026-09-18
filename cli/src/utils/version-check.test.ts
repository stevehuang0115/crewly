/**
 * Tests for CLI version check utilities
 *
 * @module cli/utils/version-check.test
 */

import path from 'path';
import os from 'os';
import fs from 'fs';

// Mock chalk (ESM-only package not transformable by Jest)
jest.mock('chalk', () => ({
	__esModule: true,
	default: new Proxy({}, {
		get: () => {
			const fn = (s: string) => s;
			return new Proxy(fn, { get: () => fn, apply: (_t, _this, args) => args[0] });
		},
	}),
}));

import {
	getLocalVersion,
	registerCliModuleDir,
	readCache,
	writeCache,
	checkForUpdate,
	printUpdateNotification,
} from './version-check.js';

// Remove the disk cache before each test to avoid cross-test contamination
const CREWLY_HOME = path.join(os.homedir(), '.crewly');
const CACHE_FILE = path.join(CREWLY_HOME, '.update-check');

describe('CLI version-check utilities', () => {
	let cacheBackup: string | null = null;

	beforeEach(() => {
		// Back up existing cache file if present
		if (fs.existsSync(CACHE_FILE)) {
			cacheBackup = fs.readFileSync(CACHE_FILE, 'utf-8');
			fs.unlinkSync(CACHE_FILE);
		} else {
			cacheBackup = null;
		}
	});

	afterEach(() => {
		// Restore original cache file
		if (cacheBackup !== null) {
			fs.writeFileSync(CACHE_FILE, cacheBackup, 'utf-8');
		} else if (fs.existsSync(CACHE_FILE)) {
			fs.unlinkSync(CACHE_FILE);
		}
		jest.restoreAllMocks();
	});

	describe('getLocalVersion', () => {
		const rootPkgVersion = JSON.parse(
			fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'),
		).version as string;

		afterEach(() => {
			registerCliModuleDir(null);
		});

		it('should return a version string', () => {
			const version = getLocalVersion();
			expect(typeof version).toBe('string');
			expect(version).toMatch(/^\d+\.\d+\.\d+/);
		});

		it('resolves from the CLI module location, not process.cwd() (finding 5)', () => {
			// Stand in a directory that is NOT inside the crewly package — the old
			// cwd-based lookup threw here and the CLI fell back to "1.0.0".
			const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());

			expect(getLocalVersion(__dirname)).toBe(rootPkgVersion);
			cwdSpy.mockRestore();
		});

		it('uses the registered CLI module dir when no startDir is passed', () => {
			const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
			registerCliModuleDir(__dirname);

			expect(getLocalVersion()).toBe(rootPkgVersion);
			cwdSpy.mockRestore();
		});

		it('does not report a different project\'s version when run inside one', () => {
			// A foreign package.json above the start dir must be skipped: only
			// the package named "crewly" counts.
			const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-vc-'));
			fs.writeFileSync(path.join(foreign, 'package.json'), JSON.stringify({ name: 'other-app', version: '9.9.9' }));
			try {
				expect(() => getLocalVersion(foreign)).toThrow(/no package.json with name "crewly"/);
			} finally {
				fs.rmSync(foreign, { recursive: true, force: true });
			}
		});
	});

	describe('checkForUpdate', () => {
		it('should return a result object with correct shape', async () => {
			jest.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				json: async () => ({ version: '99.0.0' }),
			} as Response);

			const result = await checkForUpdate();
			expect(result).toHaveProperty('currentVersion');
			expect(result).toHaveProperty('latestVersion');
			expect(result).toHaveProperty('updateAvailable');
			expect(typeof result.currentVersion).toBe('string');
			expect(result.updateAvailable).toBe(true);
			expect(result.latestVersion).toBe('99.0.0');

			// Clean up cache written by this test
			if (fs.existsSync(CACHE_FILE)) {
				fs.unlinkSync(CACHE_FILE);
			}
		});

		it('should handle network errors gracefully', async () => {
			jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

			const result = await checkForUpdate();
			expect(result.latestVersion).toBeNull();
			expect(result.updateAvailable).toBe(false);
		});

		it('should handle non-ok responses gracefully', async () => {
			jest.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: false,
				status: 500,
			} as Response);

			const result = await checkForUpdate();
			expect(result.latestVersion).toBeNull();
			expect(result.updateAvailable).toBe(false);
		});
	});

	describe('printUpdateNotification', () => {
		it('should print without errors', () => {
			const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
			printUpdateNotification('1.0.0', '2.0.0');
			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});
	});

	describe('readCache / writeCache', () => {
		it('should export readCache and writeCache functions', () => {
			expect(typeof readCache).toBe('function');
			expect(typeof writeCache).toBe('function');
		});
	});
});
