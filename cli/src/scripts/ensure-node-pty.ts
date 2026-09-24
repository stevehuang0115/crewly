/**
 * Install-time node-pty check (#778), wired into `package.json` `postinstall`.
 *
 * node-pty ships prebuilt binaries for macOS and glibc Linux, so a plain
 * `npm i -g crewly` needs no compiler. This script:
 *
 *   1. restores the exec bit on node-pty's `spawn-helper` (lost by some
 *      package managers / node-pty 1.1.0's tarball);
 *   2. checks that node-pty actually loads — in a child process, so a bad
 *      binary cannot poison this one;
 *   3. only if it does NOT load (musl, glibc < 2.28, unusual arch, stale
 *      build), compiles it from source and checks again;
 *   4. says clearly when node-pty still cannot load, and exits 1 so npm
 *      shows that message (npm hides lifecycle output of scripts that pass).
 *      The backend cannot boot without node-pty, so such an install is broken.
 *
 * It replaces an unconditional `npm rebuild node-pty --build-from-source`,
 * which deletes node-pty's prebuilds and then fails without a toolchain.
 * In every other case — including a failure of this script itself — it exits
 * 0, so it never turns a working install into a failing one.
 *
 * @module cli/scripts/ensure-node-pty
 */

import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { detectLinuxLibc, prebuildLibcProblem, toolchainInstallHint } from '../utils/native-toolchain.js';
import {
	ensureSpawnHelperExecutable,
	resolveNodePtyDir,
} from '../../../backend/src/services/session/pty/node-pty-install.utils.js';

/** Upper bound for a from-source compile (node-gyp on a slow VPS). */
const REBUILD_TIMEOUT_MS = 10 * 60 * 1000;

/** Upper bound for the load probe. */
const LOAD_PROBE_TIMEOUT_MS = 30 * 1000;

/** Result of a load probe. */
export interface LoadProbeResult {
	ok: boolean;
	/** First line of the load error when not ok. */
	error?: string;
}

/** Final state reported by {@link ensureNodePty}. */
export type EnsureNodePtyStatus = 'ok' | 'rebuilt' | 'failed' | 'missing';

/** Injection points (defaults do real work). */
export interface EnsureNodePtyDeps {
	/** Directory containing `package.json` and `node_modules/`. */
	packageRoot: string;
	/** Platform tag (defaults to the current one). */
	platform?: string;
	/** Arch tag (defaults to the current one). */
	arch?: string;
	/** Locate node-pty's package dir. */
	findNodePtyDir?: (packageRoot: string) => string | null;
	/** Check that `require('node-pty')` works. */
	probeLoad?: (packageRoot: string) => LoadProbeResult;
	/** Compile node-pty from source; true on success. */
	rebuildFromSource?: (packageRoot: string) => boolean;
	/** Message sink. */
	log?: (message: string) => void;
	/** Known reason the prebuild cannot run here (defaults to libc detection). */
	prebuildProblem?: string | null;
	/** Package-manager command that installs the build tools. */
	installHint?: string;
}

/**
 * Default node-pty locator: resolve from the package root.
 *
 * @param packageRoot - Package root
 * @returns node-pty's package directory or null
 */
function defaultFindNodePtyDir(packageRoot: string): string | null {
	const req = createRequire(pathToFileURL(path.join(packageRoot, 'package.json')).href);
	return resolveNodePtyDir((request) => req.resolve(request));
}

/**
 * Pick the thrown message out of a Node stack dump (`Error: ...`), skipping
 * the echoed source line Node prints above it.
 *
 * @param stderr - Child stderr
 * @returns The message line, or null when there is none
 */
export function firstErrorLine(stderr: string): string | null {
	const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
	return lines.find((line) => /^[A-Za-z]*Error(\s\[[A-Z_]+\])?:/.test(line))
		?? lines.find((line) => /error/i.test(line))
		?? null;
}

/**
 * Default load probe: `node -e "require('node-pty')"` in a child process.
 *
 * @param packageRoot - Package root (cwd for the resolver)
 * @returns Whether it loaded
 */
function defaultProbeLoad(packageRoot: string): LoadProbeResult {
	const res = spawnSync(process.execPath, ['-e', "require('node-pty')"], {
		cwd: packageRoot,
		encoding: 'utf8',
		timeout: LOAD_PROBE_TIMEOUT_MS,
	});
	if (res.status === 0) return { ok: true };
	return { ok: false, error: firstErrorLine(res.stderr || res.error?.message || '') ?? `exit ${res.status}` };
}

/**
 * Default from-source rebuild. Runs npm in project mode against the package
 * root — inside a global install's lifecycle `npm_config_global=true` would
 * otherwise point `npm rebuild` at the global prefix, where node-pty is not.
 *
 * @param packageRoot - Package root
 * @returns true when npm exited 0
 */
function defaultRebuildFromSource(packageRoot: string): boolean {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/^npm_config_(global|location|prefix)$/i.test(key)) delete env[key];
	}
	const npmCli = process.env.npm_execpath;
	const args = ['rebuild', 'node-pty', '--build-from-source', '--global=false', '--prefix', packageRoot];
	const res = npmCli && /\.c?js$/.test(npmCli)
		? spawnSync(process.execPath, [npmCli, ...args], { cwd: packageRoot, env, stdio: 'inherit', timeout: REBUILD_TIMEOUT_MS })
		: spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
			cwd: packageRoot,
			env,
			stdio: 'inherit',
			timeout: REBUILD_TIMEOUT_MS,
			shell: process.platform === 'win32',
		});
	return res.status === 0;
}

/**
 * Make node-pty usable, compiling only when the prebuilt binary does not load.
 *
 * @param deps - Injection points
 * @returns Final status
 */
export function ensureNodePty(deps: EnsureNodePtyDeps): EnsureNodePtyStatus {
	const platform = deps.platform ?? process.platform;
	const arch = deps.arch ?? process.arch;
	const log = deps.log ?? ((m: string) => console.error(m));
	const findDir = deps.findNodePtyDir ?? defaultFindNodePtyDir;
	const probeLoad = deps.probeLoad ?? defaultProbeLoad;
	const rebuild = deps.rebuildFromSource ?? defaultRebuildFromSource;

	const dir = findDir(deps.packageRoot);
	if (!dir) {
		log('[crewly] node-pty is not installed — agent terminals will not work. Reinstall with: npm i -g crewly');
		return 'missing';
	}

	const fixHelpers = (): void => {
		const { fixed, failed } = ensureSpawnHelperExecutable(dir, platform, arch);
		for (const helper of fixed) log(`[crewly] Made node-pty's spawn-helper executable: ${helper}`);
		for (const f of failed) log(`[crewly] node-pty's spawn-helper is not executable (${f.error}). Run: chmod +x ${f.path}`);
	};

	fixHelpers();
	const first = probeLoad(deps.packageRoot);
	if (first.ok) return 'ok';

	// node-pty's loader reports the LAST path it tried, which hides e.g. a
	// musl dlopen failure — name the libc reason ourselves when we know it.
	const problem = deps.prebuildProblem === undefined
		? prebuildLibcProblem(platform, detectLinuxLibc(platform))
		: deps.prebuildProblem;
	log(`[crewly] node-pty's prebuilt binary does not load on ${platform}-${arch}: ${problem ?? first.error ?? 'unknown error'}.`);
	log('[crewly] Compiling node-pty from source (needs a C++ compiler, make and python3)...');
	const rebuilt = rebuild(deps.packageRoot);
	fixHelpers();
	const second = probeLoad(deps.packageRoot);
	if (second.ok) {
		log('[crewly] node-pty compiled from source and loads.');
		return 'rebuilt';
	}

	// The install is about to fail and npm rolls it back, so point at a
	// re-install rather than at a package directory that will not exist.
	log(
		[
			`[crewly] node-pty still cannot load${rebuilt ? '' : ' (the compile failed)'}: ${second.error ?? 'unknown error'}`,
			'[crewly] Crewly cannot start agent terminals without it. Install the build tools, then re-run the install:',
			`[crewly]   ${deps.installHint ?? toolchainInstallHint()}`,
			'[crewly]   npm i -g crewly',
		].join('\n'),
	);
	return 'failed';
}

/* c8 ignore start — lifecycle entry, exercised by npm not by unit tests */
const invokedDirectly =
	process.argv[1] !== undefined && process.argv[1].endsWith('ensure-node-pty.js');

if (invokedDirectly) {
	try {
		if (ensureNodePty({ packageRoot: path.resolve(process.cwd()) }) === 'failed') {
			process.exitCode = 1;
		}
	} catch (error) {
		// Never fail an install because the check itself broke.
		console.error(`[crewly] node-pty install check skipped: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/* c8 ignore stop */
