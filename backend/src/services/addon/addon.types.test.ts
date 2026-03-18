/**
 * Tests for addon type definitions
 *
 * Validates that the type interfaces are correctly shaped
 * at the value level (type guards and runtime checks).
 *
 * @module services/addon/addon.types.test
 */

import { describe, it, expect } from '@jest/globals';
import type { AddonManifest, AddonModule, LoadedAddon } from './addon.types.js';

describe('Addon Types', () => {
	describe('AddonManifest', () => {
		it('accepts a valid manifest object', () => {
			const manifest: AddonManifest = {
				name: 'crewly-pro',
				version: '1.0.0',
				entrypoint: 'dist/index.js',
			};
			expect(manifest.name).toBe('crewly-pro');
			expect(manifest.version).toBe('1.0.0');
			expect(manifest.entrypoint).toBe('dist/index.js');
		});

		it('accepts manifest with optional fields', () => {
			const manifest: AddonManifest = {
				name: 'crewly-pro',
				version: '1.0.0',
				entrypoint: 'dist/index.js',
				description: 'Pro features for Crewly',
				author: 'Crewly Team',
				license: 'MIT',
			};
			expect(manifest.description).toBe('Pro features for Crewly');
			expect(manifest.author).toBe('Crewly Team');
			expect(manifest.license).toBe('MIT');
		});
	});

	describe('AddonModule', () => {
		it('accepts a module with register function', () => {
			const mod: AddonModule = {
				register: () => {},
			};
			expect(typeof mod.register).toBe('function');
		});

		it('accepts a module with register and unregister', () => {
			const mod: AddonModule = {
				register: () => {},
				unregister: () => {},
			};
			expect(typeof mod.register).toBe('function');
			expect(typeof mod.unregister).toBe('function');
		});

		it('accepts async register function', () => {
			const mod: AddonModule = {
				register: async () => {},
			};
			expect(typeof mod.register).toBe('function');
		});
	});

	describe('LoadedAddon', () => {
		it('has all required fields', () => {
			const loaded: LoadedAddon = {
				manifest: { name: 'test', version: '1.0.0', entrypoint: 'dist/index.js' },
				module: { register: () => {} },
				path: '/home/user/.crewly/addons/test',
				loadedAt: new Date(),
			};
			expect(loaded.manifest.name).toBe('test');
			expect(loaded.path).toContain('addons/test');
			expect(loaded.loadedAt).toBeInstanceOf(Date);
		});
	});
});
