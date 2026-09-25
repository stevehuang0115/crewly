/**
 * npm arguments for installing Crewly over itself (`crewly upgrade`,
 * `crewly start --auto-upgrade`).
 *
 * When the global npm folder is not writable (a system Node on Linux), the
 * installer puts Crewly under the user-owned prefix `<crewlyHome>/npm-global`
 * — the same prefix harness installs fall back to. A plain `npm install -g`
 * would then fail with EACCES (or install a second copy elsewhere), so an
 * upgrade must target the prefix the running copy lives in.
 *
 * @module cli/utils/self-install
 */

import * as fs from 'fs';
import * as path from 'path';
import { getUserNpmPrefix } from '../../../backend/src/services/harness/harness-exec.utils.js';
import { resolvePackageRoot } from './package-root.js';

/**
 * Resolve symlinks when the path exists.
 *
 * @param p - Path
 * @returns Real path, or the resolved path when it does not exist
 */
function realOrResolved(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/**
 * Whether a package root lies inside the user npm prefix.
 *
 * @param packageRoot - Crewly package root (null when unknown)
 * @param userPrefix - The user npm prefix
 * @returns True when installed under the prefix
 */
export function isUnderUserPrefix(packageRoot: string | null, userPrefix: string): boolean {
	if (!packageRoot) return false;
	const root = realOrResolved(packageRoot);
	const prefix = realOrResolved(userPrefix);
	return root === prefix || root.startsWith(prefix + path.sep);
}

/**
 * `npm` arguments that install `spec` where the running Crewly lives.
 *
 * @param spec - Package spec, e.g. `crewly@latest`
 * @param packageRoot - Running package root (defaults to the resolved one)
 * @param userPrefix - User npm prefix (defaults to `<crewlyHome>/npm-global`)
 * @returns Arguments for `npm`
 *
 * @example
 * ```ts
 * selfInstallArgs('crewly@latest');
 * // ['install', '-g', 'crewly@latest']                                   (global install)
 * // ['install', '-g', '--prefix', '/home/me/.crewly/npm-global', 'crewly@latest']  (user prefix)
 * ```
 */
export function selfInstallArgs(
	spec: string,
	packageRoot: string | null = resolvePackageRoot(),
	userPrefix: string = getUserNpmPrefix(),
): string[] {
	return isUnderUserPrefix(packageRoot, userPrefix) ? ['install', '-g', '--prefix', userPrefix, spec] : ['install', '-g', spec];
}
