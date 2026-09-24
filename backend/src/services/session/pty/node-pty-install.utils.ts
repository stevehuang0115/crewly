/**
 * node-pty install-state helpers (spawn-helper exec bit, native dirs).
 *
 * Crewly depends on node-pty's prebuilt binaries (`prebuilds/<platform>-<arch>/`)
 * so `npm i -g crewly` works without a C/C++ toolchain (#778). On Unix the
 * PTY fork goes through a small `spawn-helper` executable next to `pty.node`;
 * if it loses its exec bit (node-pty 1.1.0's npm tarball shipped it as 0644,
 * microsoft/node-pty#850/#919, and some package managers / copy steps still
 * drop the mode) every spawn fails with a bare `posix_spawnp failed.` — which
 * Crewly's retry loop would otherwise misreport as a process-table spike.
 *
 * Dependency-free (node builtins only): imported by the backend at spawn time
 * and by the CLI's postinstall script, where no other dependency is guaranteed.
 *
 * @module services/session/pty/node-pty-install.utils
 */

import * as fs from 'fs';
import * as path from 'path';

/** File name of node-pty's Unix fork helper. */
export const SPAWN_HELPER_NAME = 'spawn-helper';

/**
 * Directories node-pty's `loadNativeModule` searches for `pty.node`, in its
 * lookup order (compiled build first, prebuild last). `spawn-helper` is read
 * from whichever directory `pty.node` loaded from.
 *
 * @param packageDir - The node-pty package directory
 * @param platform - Platform tag (defaults to the current one)
 * @param arch - Arch tag (defaults to the current one)
 * @returns Absolute candidate directories
 */
export function nodePtyNativeDirs(
	packageDir: string,
	platform: string = process.platform,
	arch: string = process.arch,
): string[] {
	return [
		path.join(packageDir, 'build', 'Release'),
		path.join(packageDir, 'build', 'Debug'),
		path.join(packageDir, 'prebuilds', `${platform}-${arch}`),
	];
}

/** Result of {@link ensureSpawnHelperExecutable}. */
export interface SpawnHelperFixResult {
	/** Helpers that were not executable and were chmod'ed to 0755. */
	fixed: string[];
	/** Helpers that are not executable and could not be fixed (e.g. read-only install). */
	failed: Array<{ path: string; error: string }>;
}

/**
 * Make sure every `spawn-helper` node-pty may use is executable.
 *
 * No-op on Windows (ConPTY has no helper) and for directories without one
 * (Linux prebuilds do not ship a helper).
 *
 * @param packageDir - The node-pty package directory
 * @param platform - Platform tag (defaults to the current one)
 * @param arch - Arch tag (defaults to the current one)
 * @param chmod - chmod implementation (injectable for tests)
 * @returns Which helpers were fixed and which could not be
 */
export function ensureSpawnHelperExecutable(
	packageDir: string,
	platform: string = process.platform,
	arch: string = process.arch,
	chmod: (file: string, mode: number) => void = fs.chmodSync,
): SpawnHelperFixResult {
	const result: SpawnHelperFixResult = { fixed: [], failed: [] };
	if (platform === 'win32') return result;
	for (const dir of nodePtyNativeDirs(packageDir, platform, arch)) {
		const helper = path.join(dir, SPAWN_HELPER_NAME);
		if (!fs.existsSync(helper)) continue;
		try {
			fs.accessSync(helper, fs.constants.X_OK);
			continue;
		} catch {
			// not executable — fix below
		}
		try {
			chmod(helper, 0o755);
			result.fixed.push(helper);
		} catch (error) {
			result.failed.push({ path: helper, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return result;
}

/**
 * Locate the node-pty package directory through a resolver.
 *
 * @param resolve - A `require.resolve`-compatible function anchored where node-pty is installed
 * @returns The package directory, or null when node-pty cannot be resolved
 */
export function resolveNodePtyDir(resolve: (request: string) => string): string | null {
	try {
		return path.dirname(resolve('node-pty/package.json'));
	} catch {
		return null;
	}
}

/**
 * Locate the node-pty copy this process has ALREADY loaded, from the CJS
 * module cache (Node records CJS modules there even when they were reached
 * through an ESM `import`). Unlike resolving, this does not depend on where
 * the entry script lives — `process.argv[1]` may be outside the package.
 *
 * @param cache - `require.cache` (shared across all `createRequire` instances)
 * @returns The loaded package directory, or null when node-pty is not in the cache
 */
export function findLoadedNodePtyDir(cache: Record<string, unknown> | undefined): string | null {
	if (!cache) return null;
	const suffix = path.join('node-pty', 'lib', 'index.js');
	const entry = Object.keys(cache).find((key) => key.endsWith(path.sep + suffix));
	return entry ? path.dirname(path.dirname(entry)) : null;
}
