/**
 * Addon Loader Service
 *
 * Scans ~/.crewly/addons/ on server startup, loads each addon's
 * manifest.json, dynamically imports its entrypoint, and calls
 * addon.register(app, server) so addons can attach routes, WS
 * servers, and middleware to the running Crewly instance.
 *
 * Singleton pattern matching other Crewly services.
 *
 * @module services/addon/addon-loader.service
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';
import type { Application } from 'express';
import type { Server as HttpServer } from 'http';
import type { AddonManifest, AddonModule, LoadedAddon } from './addon.types.js';
import { ADDON_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';

// =============================================================================
// Service
// =============================================================================

/**
 * AddonLoaderService discovers and loads addons from the file system.
 *
 * On server startup, call `loadAddons(app, server)` to scan the
 * addons directory and register all valid addons. On shutdown, call
 * `unloadAddons()` to invoke each addon's cleanup hook.
 */
export class AddonLoaderService {
	private static instance: AddonLoaderService | null = null;

	/** Successfully loaded addons indexed by name */
	private addons: Map<string, LoadedAddon> = new Map();

	private logger: LoggerService;

	private constructor() {
		this.logger = LoggerService.getInstance();
	}

	/**
	 * Get the singleton instance.
	 *
	 * @returns The singleton AddonLoaderService instance
	 */
	static getInstance(): AddonLoaderService {
		if (!AddonLoaderService.instance) {
			AddonLoaderService.instance = new AddonLoaderService();
		}
		return AddonLoaderService.instance;
	}

	/**
	 * Clear the singleton instance (for testing).
	 */
	static clearInstance(): void {
		AddonLoaderService.instance = null;
	}

	// =========================================================================
	// Public API
	// =========================================================================

	/**
	 * Scan the addons directory and load all valid addons.
	 *
	 * Each addon directory must contain a manifest.json with name,
	 * version, and entrypoint fields. The entrypoint module must
	 * export a `register(app, server)` function.
	 *
	 * Errors in one addon do not prevent others from loading.
	 *
	 * @param app - The Express application instance
	 * @param server - The HTTP server instance
	 * @returns Array of successfully loaded addon names
	 */
	async loadAddons(app: Application, server: HttpServer): Promise<string[]> {
		const addonsDir = this.getAddonsDir();

		// Ensure addons directory exists
		try {
			await fs.mkdir(addonsDir, { recursive: true });
		} catch {
			// Directory likely already exists
		}

		// List subdirectories
		let entries: string[];
		try {
			const dirEntries = await fs.readdir(addonsDir, { withFileTypes: true });
			entries = dirEntries
				.filter(e => e.isDirectory())
				.map(e => e.name);
		} catch (error) {
			this.logger.warn('Failed to read addons directory', {
				path: addonsDir,
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}

		if (entries.length === 0) {
			this.logger.info('No addons found', { path: addonsDir });
			return [];
		}

		this.logger.info('Discovered addon directories', {
			count: entries.length,
			names: entries,
		});

		const loaded: string[] = [];

		for (const dirName of entries) {
			const addonPath = path.join(addonsDir, dirName);
			try {
				await this.loadSingleAddon(addonPath, app, server);
				loaded.push(dirName);
			} catch (error) {
				this.logger.error('Failed to load addon', {
					addon: dirName,
					path: addonPath,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		this.logger.info('Addon loading complete', {
			loaded: loaded.length,
			total: entries.length,
			names: loaded,
		});

		return loaded;
	}

	/**
	 * Unload all loaded addons, calling their unregister hooks.
	 * Called during server shutdown.
	 */
	async unloadAddons(): Promise<void> {
		for (const [name, addon] of this.addons) {
			try {
				if (addon.module.unregister) {
					await addon.module.unregister();
				}
				this.logger.info('Unloaded addon', { addon: name });
			} catch (error) {
				this.logger.error('Error unloading addon', {
					addon: name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		this.addons.clear();
	}

	/**
	 * Get a loaded addon by name.
	 *
	 * @param name - The addon name from its manifest
	 * @returns The loaded addon record, or undefined
	 */
	getAddon(name: string): LoadedAddon | undefined {
		return this.addons.get(name);
	}

	/**
	 * List all loaded addons.
	 *
	 * @returns Array of loaded addon records
	 */
	listAddons(): LoadedAddon[] {
		return Array.from(this.addons.values());
	}

	/**
	 * Get the number of loaded addons.
	 *
	 * @returns Count of loaded addons
	 */
	getAddonCount(): number {
		return this.addons.size;
	}

	/**
	 * Get the absolute path to the addons directory.
	 *
	 * @returns Path to ~/.crewly/addons/
	 */
	getAddonsDir(): string {
		return path.join(
			os.homedir(),
			ADDON_CONSTANTS.PATHS.ADDONS_DIR === 'addons'
				? `.crewly/${ADDON_CONSTANTS.PATHS.ADDONS_DIR}`
				: ADDON_CONSTANTS.PATHS.ADDONS_DIR,
		);
	}

	// =========================================================================
	// Internal
	// =========================================================================

	/**
	 * Load a single addon from its directory.
	 *
	 * @param addonPath - Absolute path to the addon directory
	 * @param app - Express app
	 * @param server - HTTP server
	 * @throws If manifest is invalid or entrypoint fails to load
	 */
	private async loadSingleAddon(
		addonPath: string,
		app: Application,
		server: HttpServer,
	): Promise<void> {
		// Read and validate manifest
		const manifestPath = path.join(addonPath, ADDON_CONSTANTS.MANIFEST_FILE);
		const manifestRaw = await fs.readFile(manifestPath, 'utf-8');
		const manifest = JSON.parse(manifestRaw) as AddonManifest;

		this.validateManifest(manifest, manifestPath);

		// Resolve entrypoint path
		const entrypointPath = path.join(addonPath, manifest.entrypoint);

		// Verify entrypoint file exists
		try {
			await fs.access(entrypointPath);
		} catch {
			throw new Error(
				`Addon entrypoint not found: ${entrypointPath} (from manifest.entrypoint: "${manifest.entrypoint}")`,
			);
		}

		// Dynamic import — use file:// URL for ESM compatibility
		const entrypointUrl = pathToFileURL(entrypointPath).href;
		const mod = await import(entrypointUrl) as AddonModule | { default: AddonModule };

		// Handle both default export and named export patterns
		const addonModule: AddonModule =
			'default' in mod && typeof (mod.default as AddonModule)?.register === 'function'
				? mod.default as AddonModule
				: mod as AddonModule;

		if (typeof addonModule.register !== 'function') {
			throw new Error(
				`Addon "${manifest.name}" entrypoint does not export a register() function`,
			);
		}

		// Call register with timeout
		await Promise.race([
			addonModule.register(app, server),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error(`Addon "${manifest.name}" register() timed out`)),
					ADDON_CONSTANTS.TIMEOUTS.LOAD_TIMEOUT_MS,
				),
			),
		]);

		// Store loaded addon
		this.addons.set(manifest.name, {
			manifest,
			module: addonModule,
			path: addonPath,
			loadedAt: new Date(),
		});

		this.logger.info('Loaded addon', {
			name: manifest.name,
			version: manifest.version,
			entrypoint: manifest.entrypoint,
		});
	}

	/**
	 * Validate that a manifest has all required fields.
	 *
	 * @param manifest - The parsed manifest object
	 * @param manifestPath - Path to the manifest file (for error messages)
	 * @throws If any required field is missing or invalid
	 */
	private validateManifest(manifest: AddonManifest, manifestPath: string): void {
		if (!manifest.name || typeof manifest.name !== 'string') {
			throw new Error(`Invalid manifest at ${manifestPath}: missing or invalid "name" field`);
		}
		if (!manifest.version || typeof manifest.version !== 'string') {
			throw new Error(`Invalid manifest at ${manifestPath}: missing or invalid "version" field`);
		}
		if (!manifest.entrypoint || typeof manifest.entrypoint !== 'string') {
			throw new Error(`Invalid manifest at ${manifestPath}: missing or invalid "entrypoint" field`);
		}
	}
}
