/**
 * Tests for AddonLoaderService
 *
 * @module services/addon/addon-loader.service.test
 */

import path from 'path';
import os from 'os';

// Mock fs
jest.mock('fs', () => ({
	promises: {
		readdir: jest.fn(),
		readFile: jest.fn(),
		mkdir: jest.fn(),
		access: jest.fn(),
	},
}));

// Mock logger
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			info: jest.fn(),
			warn: jest.fn(),
			error: jest.fn(),
			debug: jest.fn(),
		}),
	},
}));

import { promises as fs } from 'fs';
import { AddonLoaderService } from './addon-loader.service.js';

// =============================================================================
// Test helpers
// =============================================================================

const ADDONS_DIR = path.join(os.homedir(), '.crewly/addons');

const mockFs = fs as jest.Mocked<typeof fs>;

function makeDirent(name: string, isDir = true) {
	return { name, isDirectory: () => isDir, isFile: () => !isDir } as any;
}

// =============================================================================
// Tests
// =============================================================================

describe('AddonLoaderService', () => {
	let service: AddonLoaderService;
	let mockApp: any;
	let mockServer: any;

	beforeEach(() => {
		jest.clearAllMocks();
		AddonLoaderService.clearInstance();
		service = AddonLoaderService.getInstance();
		mockApp = { use: jest.fn(), get: jest.fn(), post: jest.fn() };
		mockServer = { on: jest.fn() };
	});

	afterEach(() => {
		AddonLoaderService.clearInstance();
	});

	// =========================================================================
	// Singleton
	// =========================================================================

	describe('singleton', () => {
		it('returns the same instance on repeated calls', () => {
			const a = AddonLoaderService.getInstance();
			const b = AddonLoaderService.getInstance();
			expect(a).toBe(b);
		});

		it('returns a fresh instance after clearInstance', () => {
			const a = AddonLoaderService.getInstance();
			AddonLoaderService.clearInstance();
			const b = AddonLoaderService.getInstance();
			expect(a).not.toBe(b);
		});
	});

	// =========================================================================
	// getAddonsDir
	// =========================================================================

	describe('getAddonsDir', () => {
		it('returns the expected path under home directory', () => {
			const dir = service.getAddonsDir();
			expect(dir).toBe(ADDONS_DIR);
		});
	});

	// =========================================================================
	// loadAddons — directory handling
	// =========================================================================

	describe('loadAddons', () => {
		it('creates the addons directory if missing', async () => {
			mockFs.mkdir.mockResolvedValue(undefined);
			mockFs.readdir.mockResolvedValue([]);

			await service.loadAddons(mockApp, mockServer);

			expect(mockFs.mkdir).toHaveBeenCalledWith(ADDONS_DIR, { recursive: true });
		});

		it('returns empty array when no addon directories exist', async () => {
			mockFs.mkdir.mockResolvedValue(undefined);
			mockFs.readdir.mockResolvedValue([]);

			const result = await service.loadAddons(mockApp, mockServer);

			expect(result).toEqual([]);
		});

		it('returns empty array when readdir fails', async () => {
			mockFs.mkdir.mockResolvedValue(undefined);
			mockFs.readdir.mockRejectedValue(new Error('ENOENT'));

			const result = await service.loadAddons(mockApp, mockServer);

			expect(result).toEqual([]);
		});

		it('skips non-directory entries', async () => {
			mockFs.mkdir.mockResolvedValue(undefined);
			mockFs.readdir.mockResolvedValue([
				makeDirent('readme.txt', false),
				makeDirent('.DS_Store', false),
			]);

			const result = await service.loadAddons(mockApp, mockServer);

			expect(result).toEqual([]);
		});

		it('handles errors in individual addon loading gracefully', async () => {
			mockFs.mkdir.mockResolvedValue(undefined);
			mockFs.readdir.mockResolvedValue([makeDirent('bad-addon')]);
			// Return invalid JSON to trigger error
			mockFs.readFile.mockResolvedValue('{invalid json}' as any);

			const result = await service.loadAddons(mockApp, mockServer);

			// Should not throw, just skip the bad addon
			expect(result).toEqual([]);
		});

		it('rejects addon with missing manifest fields', async () => {
			mockFs.mkdir.mockResolvedValue(undefined);
			mockFs.readdir.mockResolvedValue([makeDirent('incomplete-addon')]);
			mockFs.readFile.mockResolvedValue(JSON.stringify({ name: 'test' }) as any);

			const result = await service.loadAddons(mockApp, mockServer);

			expect(result).toEqual([]);
		});

		it('rejects addon when entrypoint file is missing', async () => {
			mockFs.mkdir.mockResolvedValue(undefined);
			mockFs.readdir.mockResolvedValue([makeDirent('no-dist')]);
			mockFs.readFile.mockResolvedValue(
				JSON.stringify({ name: 'no-dist', version: '1.0.0', entrypoint: 'dist/index.js' }) as any,
			);
			mockFs.access.mockRejectedValue(new Error('ENOENT'));

			const result = await service.loadAddons(mockApp, mockServer);

			expect(result).toEqual([]);
		});
	});

	// =========================================================================
	// unloadAddons
	// =========================================================================

	describe('unloadAddons', () => {
		it('calls unregister on each addon that has it', async () => {
			const mockUnregister = jest.fn().mockResolvedValue(undefined);

			(service as any).addons.set('addon-a', {
				manifest: { name: 'addon-a', version: '1.0.0', entrypoint: 'dist/index.js' },
				module: { register: jest.fn(), unregister: mockUnregister },
				path: '/test/addon-a',
				loadedAt: new Date(),
			});

			await service.unloadAddons();

			expect(mockUnregister).toHaveBeenCalled();
			expect(service.getAddonCount()).toBe(0);
		});

		it('clears addons even if unregister throws', async () => {
			(service as any).addons.set('bad-addon', {
				manifest: { name: 'bad-addon', version: '1.0.0', entrypoint: 'dist/index.js' },
				module: {
					register: jest.fn(),
					unregister: jest.fn().mockRejectedValue(new Error('boom')),
				},
				path: '/test/bad-addon',
				loadedAt: new Date(),
			});

			await service.unloadAddons();

			expect(service.getAddonCount()).toBe(0);
		});

		it('skips unregister for addons without it', async () => {
			(service as any).addons.set('simple-addon', {
				manifest: { name: 'simple-addon', version: '1.0.0', entrypoint: 'dist/index.js' },
				module: { register: jest.fn() },
				path: '/test/simple',
				loadedAt: new Date(),
			});

			await service.unloadAddons();

			expect(service.getAddonCount()).toBe(0);
		});

		it('handles multiple addons in sequence', async () => {
			const unregisterA = jest.fn().mockResolvedValue(undefined);
			const unregisterB = jest.fn().mockResolvedValue(undefined);

			(service as any).addons.set('addon-a', {
				manifest: { name: 'addon-a', version: '1.0.0', entrypoint: 'dist/index.js' },
				module: { register: jest.fn(), unregister: unregisterA },
				path: '/a',
				loadedAt: new Date(),
			});
			(service as any).addons.set('addon-b', {
				manifest: { name: 'addon-b', version: '1.0.0', entrypoint: 'dist/index.js' },
				module: { register: jest.fn(), unregister: unregisterB },
				path: '/b',
				loadedAt: new Date(),
			});

			await service.unloadAddons();

			expect(unregisterA).toHaveBeenCalled();
			expect(unregisterB).toHaveBeenCalled();
			expect(service.getAddonCount()).toBe(0);
		});
	});

	// =========================================================================
	// getAddon / listAddons / getAddonCount
	// =========================================================================

	describe('accessor methods', () => {
		beforeEach(() => {
			const entry = {
				manifest: { name: 'test', version: '2.0.0', entrypoint: 'dist/index.js' },
				module: { register: jest.fn() },
				path: '/test',
				loadedAt: new Date(),
			};
			(service as any).addons.set('test', entry);
		});

		it('getAddon returns the addon by name', () => {
			expect(service.getAddon('test')).toBeDefined();
			expect(service.getAddon('test')!.manifest.version).toBe('2.0.0');
		});

		it('getAddon returns undefined for unknown name', () => {
			expect(service.getAddon('nonexistent')).toBeUndefined();
		});

		it('listAddons returns all loaded addons', () => {
			expect(service.listAddons()).toHaveLength(1);
		});

		it('getAddonCount returns correct count', () => {
			expect(service.getAddonCount()).toBe(1);
		});
	});

	// =========================================================================
	// validateManifest
	// =========================================================================

	describe('manifest validation', () => {
		it('rejects manifest without name', () => {
			expect(() =>
				(service as any).validateManifest(
					{ version: '1.0.0', entrypoint: 'dist/index.js' },
					'/test/manifest.json',
				),
			).toThrow('missing or invalid "name"');
		});

		it('rejects manifest without version', () => {
			expect(() =>
				(service as any).validateManifest(
					{ name: 'test', entrypoint: 'dist/index.js' },
					'/test/manifest.json',
				),
			).toThrow('missing or invalid "version"');
		});

		it('rejects manifest without entrypoint', () => {
			expect(() =>
				(service as any).validateManifest(
					{ name: 'test', version: '1.0.0' },
					'/test/manifest.json',
				),
			).toThrow('missing or invalid "entrypoint"');
		});

		it('accepts valid manifest', () => {
			expect(() =>
				(service as any).validateManifest(
					{ name: 'test', version: '1.0.0', entrypoint: 'dist/index.js' },
					'/test/manifest.json',
				),
			).not.toThrow();
		});

		it('rejects manifest with non-string name', () => {
			expect(() =>
				(service as any).validateManifest(
					{ name: 123, version: '1.0.0', entrypoint: 'dist/index.js' },
					'/test/manifest.json',
				),
			).toThrow('missing or invalid "name"');
		});
	});
});
