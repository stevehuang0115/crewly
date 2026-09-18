/**
 * Package-root resolution for the CLI.
 *
 * `crewly service install` (and anything else that needs the install
 * directory) used to walk up from `process.cwd()`, which only works when the
 * operator happens to be inside the package directory. For a global npm
 * install the CLI already knows where it lives — the entry script is inside
 * the package — so resolve from the CLI's own location first and fall back to
 * the cwd walk only for source checkouts run through `tsx`.
 *
 * `import.meta.url` cannot appear in this module (ts-jest compiles the CLI as
 * CommonJS, where the meta-property is a compile error), so the ESM entry
 * (`cli/src/index.ts`) registers its module directory via
 * {@link setCliModuleDir}; `process.argv[1]` (realpath'd, so the global
 * `bin` symlink resolves into the package) is the second anchor.
 *
 * @module cli/utils/package-root
 */

import * as fs from 'fs';
import * as path from 'path';

/** Package name that identifies the Crewly install root. */
const CREWLY_PACKAGE_NAME = 'crewly';

/** Module directory registered by the ESM entry point (via `import.meta.url`). */
let registeredModuleDir: string | null = null;

/**
 * Register the directory of the CLI entry module so package-root resolution
 * can anchor on it. Called once by `cli/src/index.ts`.
 *
 * @param dir - Absolute directory of the running CLI module
 */
export function setCliModuleDir(dir: string | null): void {
	registeredModuleDir = dir;
}

/**
 * Walk up from `startDir` looking for a `package.json` whose `name` is
 * `crewly`.
 *
 * @param startDir - Directory to start searching from
 * @returns Absolute package root, or null when no parent matches
 */
export function findPackageRoot(startDir: string): string | null {
	let current = path.resolve(startDir);
	let parent = path.dirname(current);

	// Stop once dirname() no longer changes the path (filesystem root).
	for (;;) {
		const pkgPath = path.join(current, 'package.json');
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
				if (pkg.name === CREWLY_PACKAGE_NAME) {
					return current;
				}
			} catch {
				// Malformed package.json — keep searching
			}
		}

		if (parent === current) {
			return null;
		}
		current = parent;
		parent = path.dirname(current);
	}
}

/**
 * Candidate directories to anchor the package-root walk on, most reliable
 * first: the registered CLI module dir, the realpath of the entry script
 * (`process.argv[1]`), then the current working directory.
 *
 * @param argv1 - Entry script path (defaults to `process.argv[1]`)
 * @param cwd - Working directory (defaults to `process.cwd()`)
 * @returns Ordered, de-duplicated candidate directories
 */
export function packageRootCandidates(
	argv1: string | undefined = process.argv[1],
	cwd: string = process.cwd(),
): string[] {
	const candidates: string[] = [];
	if (registeredModuleDir) candidates.push(registeredModuleDir);
	if (argv1) {
		try {
			candidates.push(path.dirname(fs.realpathSync(argv1)));
		} catch {
			candidates.push(path.dirname(path.resolve(argv1)));
		}
	}
	candidates.push(cwd);
	return [...new Set(candidates)];
}

/**
 * Resolve the Crewly package root regardless of the caller's cwd.
 *
 * Tries each candidate from {@link packageRootCandidates} in order and returns
 * the first that sits inside a Crewly package.
 *
 * @param argv1 - Entry script path (defaults to `process.argv[1]`)
 * @param cwd - Working directory (defaults to `process.cwd()`)
 * @returns Absolute package root, or null when none of the anchors is inside a Crewly install
 */
export function resolvePackageRoot(
	argv1: string | undefined = process.argv[1],
	cwd: string = process.cwd(),
): string | null {
	for (const dir of packageRootCandidates(argv1, cwd)) {
		const root = findPackageRoot(dir);
		if (root) return root;
	}
	return null;
}
