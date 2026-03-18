/**
 * Addon System Types
 *
 * Defines the manifest format, addon interface, and registration
 * contract for the Crewly addon/plugin system. Pro and third-party
 * extensions implement these interfaces to hook into the server.
 *
 * @module services/addon/addon.types
 */

import type { Application } from 'express';
import type { Server as HttpServer } from 'http';

// =============================================================================
// Addon Manifest
// =============================================================================

/**
 * Schema for an addon's manifest.json file.
 * Every addon directory must contain a manifest.json matching this shape.
 */
export interface AddonManifest {
	/** Unique addon identifier (e.g. "crewly-pro") */
	name: string;
	/** Semver version string */
	version: string;
	/** Path to the compiled entrypoint relative to the addon directory */
	entrypoint: string;
	/** Human-readable description */
	description?: string;
	/** Author name or organization */
	author?: string;
	/** SPDX license identifier */
	license?: string;
}

// =============================================================================
// Addon Module Interface
// =============================================================================

/**
 * The export contract for an addon's entrypoint module.
 * The addon loader calls `register()` on startup and optionally
 * `unregister()` on shutdown.
 */
export interface AddonModule {
	/**
	 * Called during server startup to let the addon attach routes,
	 * WebSocket servers, middleware, or other functionality.
	 *
	 * @param app - The Express application instance
	 * @param server - The underlying HTTP server (for WS upgrades)
	 */
	register(app: Application, server: HttpServer): void | Promise<void>;

	/**
	 * Optional cleanup hook called during server shutdown.
	 */
	unregister?(): void | Promise<void>;
}

// =============================================================================
// Loaded Addon Record
// =============================================================================

/**
 * Internal record of a successfully loaded addon.
 */
export interface LoadedAddon {
	/** Parsed manifest data */
	manifest: AddonManifest;
	/** The imported module */
	module: AddonModule;
	/** Absolute path to the addon directory */
	path: string;
	/** Timestamp when the addon was loaded */
	loadedAt: Date;
}
