/**
 * Version Check Service
 *
 * Singleton service that queries the npm registry for the latest published
 * version of Crewly and compares it against the locally installed version.
 * Results are cached in ~/.crewly/.update-check for 24 hours to avoid
 * hitting the network on every startup.
 *
 * @module services/system/version-check.service
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { VERSION_CHECK_CONSTANTS, CREWLY_CONSTANTS } from '../../constants.js';
import { findPackageRoot } from '../../utils/package-root.js';

// ========================= Types =========================

/**
 * Cached version check result persisted to disk
 */
export interface CachedVersionCheck {
	/** The latest version found on npm */
	latestVersion: string;
	/** ISO timestamp of when the check was performed */
	checkedAt: string;
}

/**
 * Result of a version comparison
 */
export interface VersionCheckResult {
	/** Currently installed version */
	currentVersion: string;
	/** Latest version on npm, or null if check failed */
	latestVersion: string | null;
	/** Whether a newer version is available */
	updateAvailable: boolean;
}

// ========================= Service =========================

/**
 * Manages version checking against the npm registry with disk-based caching.
 *
 * Usage:
 * ```typescript
 * const service = VersionCheckService.getInstance();
 * const result = await service.checkForUpdate();
 * if (result.updateAvailable) {
 *   console.log(`Update available: ${result.latestVersion}`);
 * }
 * ```
 */
export class VersionCheckService {
	private static instance: VersionCheckService | null = null;
	private cachedResult: VersionCheckResult | null = null;

	private constructor() {}

	/**
	 * Returns the singleton instance of VersionCheckService.
	 *
	 * @returns The singleton instance
	 */
	static getInstance(): VersionCheckService {
		if (!VersionCheckService.instance) {
			VersionCheckService.instance = new VersionCheckService();
		}
		return VersionCheckService.instance;
	}

	/**
	 * Resets the singleton instance (for testing).
	 */
	static resetInstance(): void {
		VersionCheckService.instance = null;
	}

	/**
	 * Reads the current Crewly version from the root package.json.
	 *
	 * @returns The version string from package.json
	 * @throws Error if the package root or package.json cannot be found
	 */
	getLocalVersion(): string {
		const root = findPackageRoot(process.cwd());
		const pkgPath = path.join(root, 'package.json');
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
		return pkg.version as string;
	}

	/**
	 * Fetches the latest version of Crewly from the npm registry.
	 * Uses the cached result if it is still fresh (within CACHE_TTL_MS).
	 *
	 * A cached "latest" older than the running version is stale by definition
	 * (the machine was just upgraded past it), so it is re-fetched rather than
	 * reported for up to a day (2026-09-24: /health said latest 1.20.108 on
	 * 1.20.109).
	 *
	 * @param currentVersion - The running version, when known
	 * @returns The latest version string, or null if the request failed
	 */
	async getLatestVersion(currentVersion?: string): Promise<string | null> {
		// Check cache first
		const cached = this.getCachedResult();
		if (cached) {
			const age = Date.now() - new Date(cached.checkedAt).getTime();
			const behindUs = !!currentVersion && this.isNewerVersion(currentVersion, cached.latestVersion);
			if (age < VERSION_CHECK_CONSTANTS.CACHE_TTL_MS && !behindUs) {
				return cached.latestVersion;
			}
		}

		try {
			const controller = new AbortController();
			const timeout = setTimeout(
				() => controller.abort(),
				VERSION_CHECK_CONSTANTS.REQUEST_TIMEOUT_MS
			);

			const response = await fetch(VERSION_CHECK_CONSTANTS.NPM_REGISTRY_URL, {
				signal: controller.signal,
				headers: { 'Accept': 'application/json' },
			});
			clearTimeout(timeout);

			if (!response.ok) {
				return null;
			}

			const data = await response.json() as { version?: string };
			const latestVersion = data.version ?? null;

			if (latestVersion) {
				this.writeCacheResult(latestVersion);
			}

			return latestVersion;
		} catch {
			// Network error, timeout, or parse error — return null silently
			return null;
		}
	}

	/**
	 * Compares the local version against the latest npm version and returns
	 * a structured result indicating whether an update is available.
	 *
	 * @returns An object with currentVersion, latestVersion, and updateAvailable
	 */
	async checkForUpdate(): Promise<VersionCheckResult> {
		const currentVersion = this.getLocalVersion();
		const latestVersion = await this.getLatestVersion(currentVersion);

		const updateAvailable =
			latestVersion !== null && this.isNewerVersion(latestVersion, currentVersion);

		this.cachedResult = { currentVersion, latestVersion, updateAvailable };
		return this.cachedResult;
	}

	/**
	 * Returns the in-memory cached result from the last checkForUpdate() call.
	 * Does not perform any I/O.
	 *
	 * @returns The cached VersionCheckResult, or null if no check has been performed
	 */
	getCachedCheckResult(): VersionCheckResult | null {
		return this.cachedResult;
	}

	/**
	 * Reads the disk-cached version check result from ~/.crewly/.update-check.
	 *
	 * @returns The cached result, or null if the file does not exist or is malformed
	 */
	getCachedResult(): CachedVersionCheck | null {
		try {
			const cachePath = this.getCachePath();
			if (!existsSync(cachePath)) {
				return null;
			}
			const content = readFileSync(cachePath, 'utf-8');
			const parsed = JSON.parse(content) as CachedVersionCheck;
			if (parsed.latestVersion && parsed.checkedAt) {
				return parsed;
			}
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Writes a version check result to the disk cache.
	 *
	 * @param version - The latest version string to cache
	 */
	writeCacheResult(version: string): void {
		try {
			const cachePath = this.getCachePath();
			const cacheDir = path.dirname(cachePath);
			if (!existsSync(cacheDir)) {
				mkdirSync(cacheDir, { recursive: true });
			}

			const data: CachedVersionCheck = {
				latestVersion: version,
				checkedAt: new Date().toISOString(),
			};
			writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8');
		} catch {
			// Silently ignore write failures (permissions, disk full, etc.)
		}
	}

	/**
	 * Compares two semver version strings to determine if `latest` is newer than `current`.
	 *
	 * @param latest - The version to compare against
	 * @param current - The currently installed version
	 * @returns true if latest is strictly newer than current
	 */
	private isNewerVersion(latest: string, current: string): boolean {
		const latestParts = latest.split('.').map(Number);
		const currentParts = current.split('.').map(Number);

		for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
			const l = latestParts[i] ?? 0;
			const c = currentParts[i] ?? 0;
			if (l > c) return true;
			if (l < c) return false;
		}
		return false;
	}

	/**
	 * Returns the absolute path to the cache file.
	 *
	 * @returns Path to ~/.crewly/.update-check
	 */
	private getCachePath(): string {
		return path.join(
			os.homedir(),
			CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
			VERSION_CHECK_CONSTANTS.CHECK_CACHE_FILE
		);
	}
}
