/**
 * Tests for VersionCheckService
 *
 * @module services/system/version-check.service.test
 */

import path from 'path';
import os from 'os';
import fs from 'fs';

// Mock findPackageRoot before importing the service
jest.mock('../../utils/package-root.js', () => ({
	findPackageRoot: jest.fn(() => '/fake/package/root'),
}));

import { VersionCheckService } from './version-check.service.js';
import { findPackageRoot } from '../../utils/package-root.js';

const mockedFindPackageRoot = findPackageRoot as jest.MockedFunction<typeof findPackageRoot>;

describe('VersionCheckService', () => {
	let tmpDir: string;

	beforeEach(() => {
		VersionCheckService.resetInstance();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-check-test-'));
	});

	afterEach(() => {
		VersionCheckService.resetInstance();
		fs.rmSync(tmpDir, { recursive: true, force: true });
		jest.restoreAllMocks();
	});

	describe('getInstance', () => {
		it('should return the same instance on repeated calls', () => {
			const a = VersionCheckService.getInstance();
			const b = VersionCheckService.getInstance();
			expect(a).toBe(b);
		});

		it('should return a new instance after resetInstance', () => {
			const a = VersionCheckService.getInstance();
			VersionCheckService.resetInstance();
			const b = VersionCheckService.getInstance();
			expect(a).not.toBe(b);
		});
	});

	describe('getLocalVersion', () => {
		it('should return a version string from package.json', () => {
			const fakeRoot = tmpDir;
			fs.writeFileSync(
				path.join(fakeRoot, 'package.json'),
				JSON.stringify({ name: 'crewly', version: '2.3.4' })
			);
			mockedFindPackageRoot.mockReturnValue(fakeRoot);

			const service = VersionCheckService.getInstance();
			expect(service.getLocalVersion()).toBe('2.3.4');
		});
	});

	describe('getLatestVersion', () => {
		it('should return version from npm registry on success', async () => {
			const service = VersionCheckService.getInstance();

			const mockFetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				json: async () => ({ version: '3.0.0' }),
			} as Response);

			jest.spyOn(service, 'getCachedResult').mockReturnValue(null);
			jest.spyOn(service, 'writeCacheResult').mockImplementation(() => {});

			const result = await service.getLatestVersion();
			expect(result).toBe('3.0.0');
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		it('should return null when fetch fails', async () => {
			const service = VersionCheckService.getInstance();

			jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
			jest.spyOn(service, 'getCachedResult').mockReturnValue(null);

			const result = await service.getLatestVersion();
			expect(result).toBeNull();
		});

		it('should return null when response is not ok', async () => {
			const service = VersionCheckService.getInstance();

			jest.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: false,
				status: 404,
			} as Response);
			jest.spyOn(service, 'getCachedResult').mockReturnValue(null);

			const result = await service.getLatestVersion();
			expect(result).toBeNull();
		});

		it('should return cached version when cache is fresh', async () => {
			const service = VersionCheckService.getInstance();

			jest.spyOn(service, 'getCachedResult').mockReturnValue({
				latestVersion: '2.0.0',
				checkedAt: new Date().toISOString(),
			});

			const mockFetch = jest.spyOn(globalThis, 'fetch');

			const result = await service.getLatestVersion();
			expect(result).toBe('2.0.0');
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it('should re-fetch when cache is stale', async () => {
			const service = VersionCheckService.getInstance();

			const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
			jest.spyOn(service, 'getCachedResult').mockReturnValue({
				latestVersion: '1.5.0',
				checkedAt: staleDate.toISOString(),
			});
			jest.spyOn(service, 'writeCacheResult').mockImplementation(() => {});

			jest.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				json: async () => ({ version: '2.0.0' }),
			} as Response);

			const result = await service.getLatestVersion();
			expect(result).toBe('2.0.0');
		});

		it('should re-fetch a fresh cache that is older than the running version', async () => {
			const service = VersionCheckService.getInstance();
			jest.spyOn(service, 'getCachedResult').mockReturnValue({
				latestVersion: '1.20.108',
				checkedAt: new Date().toISOString(),
			});
			jest.spyOn(service, 'writeCacheResult').mockImplementation(() => {});
			const mockFetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				json: async () => ({ version: '1.20.109' }),
			} as Response);

			expect(await service.getLatestVersion('1.20.109')).toBe('1.20.109');
			expect(mockFetch).toHaveBeenCalledTimes(1);
			// Same running version as the cache: the fresh cache is used.
			mockFetch.mockClear();
			expect(await service.getLatestVersion('1.20.108')).toBe('1.20.108');
			expect(mockFetch).not.toHaveBeenCalled();
		});
	});

	describe('checkForUpdate', () => {
		it('should return updateAvailable true when latest > current', async () => {
			const service = VersionCheckService.getInstance();

			jest.spyOn(service, 'getLocalVersion').mockReturnValue('1.0.0');
			jest.spyOn(service, 'getLatestVersion').mockResolvedValue('1.1.0');

			const result = await service.checkForUpdate();
			expect(result).toEqual({
				currentVersion: '1.0.0',
				latestVersion: '1.1.0',
				updateAvailable: true,
			});
		});

		it('should return updateAvailable false when versions are equal', async () => {
			const service = VersionCheckService.getInstance();

			jest.spyOn(service, 'getLocalVersion').mockReturnValue('1.0.0');
			jest.spyOn(service, 'getLatestVersion').mockResolvedValue('1.0.0');

			const result = await service.checkForUpdate();
			expect(result).toEqual({
				currentVersion: '1.0.0',
				latestVersion: '1.0.0',
				updateAvailable: false,
			});
		});

		it('should return updateAvailable false when latest is null', async () => {
			const service = VersionCheckService.getInstance();

			jest.spyOn(service, 'getLocalVersion').mockReturnValue('1.0.0');
			jest.spyOn(service, 'getLatestVersion').mockResolvedValue(null);

			const result = await service.checkForUpdate();
			expect(result).toEqual({
				currentVersion: '1.0.0',
				latestVersion: null,
				updateAvailable: false,
			});
		});

		it('should return updateAvailable false when current > latest', async () => {
			const service = VersionCheckService.getInstance();

			jest.spyOn(service, 'getLocalVersion').mockReturnValue('2.0.0');
			jest.spyOn(service, 'getLatestVersion').mockResolvedValue('1.5.0');

			const result = await service.checkForUpdate();
			expect(result).toEqual({
				currentVersion: '2.0.0',
				latestVersion: '1.5.0',
				updateAvailable: false,
			});
		});

		it('should cache the result in memory', async () => {
			const service = VersionCheckService.getInstance();

			jest.spyOn(service, 'getLocalVersion').mockReturnValue('1.0.0');
			jest.spyOn(service, 'getLatestVersion').mockResolvedValue('1.2.0');

			await service.checkForUpdate();
			const cached = service.getCachedCheckResult();
			expect(cached).toEqual({
				currentVersion: '1.0.0',
				latestVersion: '1.2.0',
				updateAvailable: true,
			});
		});
	});

	describe('getCachedCheckResult', () => {
		it('should return null before any check is performed', () => {
			const service = VersionCheckService.getInstance();
			expect(service.getCachedCheckResult()).toBeNull();
		});
	});

	describe('writeCacheResult / getCachedResult', () => {
		it('should write and read a cache file', () => {
			const service = VersionCheckService.getInstance();

			const cachePath = path.join(tmpDir, '.update-check');
			jest.spyOn(service as any, 'getCachePath').mockReturnValue(cachePath);

			service.writeCacheResult('5.0.0');

			const cached = service.getCachedResult();
			expect(cached).not.toBeNull();
			expect(cached!.latestVersion).toBe('5.0.0');
			expect(cached!.checkedAt).toBeDefined();
		});

		it('should return null when cache file does not exist', () => {
			const service = VersionCheckService.getInstance();
			const cachePath = path.join(tmpDir, 'nonexistent', '.update-check');
			jest.spyOn(service as any, 'getCachePath').mockReturnValue(cachePath);

			expect(service.getCachedResult()).toBeNull();
		});

		it('should return null when cache file is malformed', () => {
			const service = VersionCheckService.getInstance();
			const cachePath = path.join(tmpDir, '.update-check');
			jest.spyOn(service as any, 'getCachePath').mockReturnValue(cachePath);

			fs.writeFileSync(cachePath, 'not json', 'utf-8');
			expect(service.getCachedResult()).toBeNull();
		});
	});
});
