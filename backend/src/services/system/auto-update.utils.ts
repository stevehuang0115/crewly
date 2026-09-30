/**
 * Auto-update helpers — pure / filesystem-only pieces of the self-update
 * (specs/auto-update.md), kept apart from the service so each rule is
 * testable without timers:
 *
 * - where the running copy lives and what kind of install it is (npm global,
 *   user-prefix npm, dev checkout, anything else);
 * - the `npm install -g` arguments that target that same prefix;
 * - the on/off decision (setting + env override);
 * - whether a supervisor will bring the backend back after RESTART_REQUESTED;
 * - the status file (`crewly update-status`) and the pending-upgrade marker.
 *
 * @module services/system/auto-update.utils
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AUTO_UPDATE_CONSTANTS } from '../../constants.js';

/** Name of the directory npm installs packages into. */
const NODE_MODULES_DIR = 'node_modules';

/** Directory between the prefix and node_modules for POSIX global installs. */
const POSIX_GLOBAL_LIB_DIR = 'lib';

/** Env values that force auto-update off. */
const ENV_OFF_VALUES = ['0', 'false', 'off', 'no'];

/** Env values that force auto-update on. */
const ENV_ON_VALUES = ['1', 'true', 'on', 'yes'];

/** Pattern matching the `crewly start` command line of a supervising CLI parent. */
const CLI_START_CMDLINE_PATTERN = /(?:\bcrewly|cli[\\/]src[\\/]index\.[jt]s)\S*\s+start\b/;

/** What kind of install the running copy is. */
export type InstallKind = 'npm-global' | 'dev-checkout' | 'unmanaged';

/** Where and how the running copy is installed. */
export interface InstallInfo {
	/** Install kind */
	kind: InstallKind;
	/** Real path of the Crewly package root (null when not found) */
	packageRoot: string | null;
	/** npm prefix the package lives under (npm-global only) */
	prefix: string | null;
	/** Human-readable reason, used in the skip log line */
	detail: string;
}

/** Why auto-update is on or off. */
export type AutoUpdateSwitch = 'enabled' | 'disabled-setting' | 'disabled-env' | 'enabled-env';

/** How the last auto-update attempt ended. */
export type AutoUpdateOutcome =
	| 'up-to-date'
	| 'deferred-busy'
	| 'installed-restarting'
	| 'upgraded'
	| 'install-failed'
	| 'verify-failed'
	| 'restart-unavailable'
	| 'check-failed'
	| 'skipped';

/** Persisted status of the auto-updater (`<crewlyHome>/auto-update-state.json`). */
export interface AutoUpdateState {
	/** Version this backend is running */
	currentVersion: string | null;
	/** Latest version the registry reported */
	latestVersion: string | null;
	/** ISO time of the last registry check */
	lastCheckAt: string | null;
	/** Whether the updater would act, and why not when it would not */
	mode: string;
	/** How the last attempt ended */
	lastResult: { outcome: AutoUpdateOutcome; at: string; version?: string; message?: string } | null;
	/** Failed attempts in a row (reset on success) */
	consecutiveFailures: number;
	/** ISO time before which no new attempt is made */
	backoffUntil: string | null;
	/** Target version the owner was already told about (one failure DM per version) */
	failureNotifiedVersion: string | null;
}

/** Marker persisted before an upgrade restart and read on the next boot. */
export interface PendingUpgradeMarker {
	/** Version the process was running before the restart */
	fromVersion: string;
	/** Version that was installed */
	toVersion: string;
	/** ISO time the marker was written */
	at: string;
}

/**
 * Resolve symlinks when the path exists.
 *
 * @param p - Path
 * @returns Real path, or the resolved path when it does not exist
 */
export function realOrResolved(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/**
 * Walk up from `startDir` to the directory whose package.json is `crewly`.
 *
 * @param startDir - Directory to start from
 * @returns The package root, or null when none is found
 */
export function findCrewlyPackageRoot(startDir: string): string | null {
	let current = path.resolve(startDir);
	for (;;) {
		const pkgPath = path.join(current, 'package.json');
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
				if (pkg.name === AUTO_UPDATE_CONSTANTS.PACKAGE_NAME) return current;
			} catch {
				// Malformed package.json — keep walking
			}
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Package root of the running backend, anchored on the entry script
 * (`process.argv[1]`, e.g. `<root>/dist/backend/backend/src/index.js`) rather
 * than the cwd — after `npm install -g` replaces the package directory the
 * old cwd no longer exists.
 *
 * @param argv1 - Entry script path (defaults to process.argv[1])
 * @param cwd - Fallback start directory
 * @returns Real path of the package root, or null
 */
export function resolveRunningPackageRoot(argv1: string | undefined = process.argv[1], cwd?: string): string | null {
	const anchors: string[] = [];
	if (argv1) anchors.push(path.dirname(realOrResolved(argv1)));
	if (cwd) anchors.push(cwd);
	for (const anchor of anchors) {
		const root = findCrewlyPackageRoot(anchor);
		if (root) return realOrResolved(root);
	}
	return null;
}

/**
 * The npm prefix a package root was installed under, when it is a global
 * install: `<prefix>/lib/node_modules/crewly` on POSIX,
 * `<prefix>\node_modules\crewly` on Windows. Covers the default global prefix
 * (nvm, Homebrew, /usr/local) and the user prefix (`<crewlyHome>/npm-global`)
 * alike — installing with `--prefix <that>` replaces exactly the running copy
 * even when a different `npm` is first on PATH.
 *
 * @param packageRoot - Real path of the package root
 * @param platform - Platform (tests)
 * @returns The prefix, or null for anything that is not a global install
 *
 * @example
 * ```ts
 * derivePrefixFromPackageRoot('/usr/local/lib/node_modules/crewly'); // '/usr/local'
 * derivePrefixFromPackageRoot('/home/me/.crewly/npm-global/lib/node_modules/crewly'); // '/home/me/.crewly/npm-global'
 * derivePrefixFromPackageRoot('/home/me/proj/node_modules/crewly'); // null (local dependency)
 * ```
 */
export function derivePrefixFromPackageRoot(packageRoot: string, platform: NodeJS.Platform = process.platform): string | null {
	const p = platform === 'win32' ? path.win32 : path.posix;
	if (p.basename(packageRoot) !== AUTO_UPDATE_CONSTANTS.PACKAGE_NAME) return null;
	const nodeModules = p.dirname(packageRoot);
	if (p.basename(nodeModules) !== NODE_MODULES_DIR) return null;
	const parent = p.dirname(nodeModules);
	if (platform === 'win32') return parent;
	if (p.basename(parent) !== POSIX_GLOBAL_LIB_DIR) return null;
	return p.dirname(parent);
}

/**
 * Whether a directory is a git working tree root (`.git` directory, or the
 * `.git` file of a worktree).
 *
 * @param dir - Directory
 * @returns True when `.git` exists there
 */
export function isGitWorkingTree(dir: string): boolean {
	return fs.existsSync(path.join(dir, '.git'));
}

/**
 * Classify the running install.
 *
 * - `dev-checkout`: the package root is a git working tree (e.g. the owner's
 *   `crewly/` repo running its own build, or an `npm link` that resolves into
 *   it). It must never npm-install over itself.
 * - `npm-global`: the root sits in `<prefix>/lib/node_modules/crewly`.
 * - `unmanaged`: anything else (Docker image at /app, a local dependency, an
 *   npx cache) — nobody owns an in-place upgrade there.
 *
 * @param packageRoot - Real path of the package root (null when unknown)
 * @param platform - Platform (tests)
 * @returns Install info
 */
export function detectInstall(packageRoot: string | null, platform: NodeJS.Platform = process.platform): InstallInfo {
	if (!packageRoot) {
		return { kind: 'unmanaged', packageRoot: null, prefix: null, detail: 'package root not found' };
	}
	if (isGitWorkingTree(packageRoot)) {
		return { kind: 'dev-checkout', packageRoot, prefix: null, detail: `dev checkout (${packageRoot})` };
	}
	const prefix = derivePrefixFromPackageRoot(packageRoot, platform);
	if (!prefix) {
		return { kind: 'unmanaged', packageRoot, prefix: null, detail: `not a global npm install (${packageRoot})` };
	}
	return { kind: 'npm-global', packageRoot, prefix, detail: `npm global install under ${prefix}` };
}

/**
 * `npm` arguments that install `crewly@<version>` over the running copy.
 *
 * @param prefix - Prefix from {@link derivePrefixFromPackageRoot}
 * @param version - Exact target version
 * @returns Arguments for npm
 *
 * @example
 * ```ts
 * npmInstallArgs('/usr/local', '1.20.144');
 * // ['install', '-g', '--prefix', '/usr/local', 'crewly@1.20.144']
 * ```
 */
export function npmInstallArgs(prefix: string, version: string): string[] {
	return ['install', '-g', '--prefix', prefix, `${AUTO_UPDATE_CONSTANTS.PACKAGE_NAME}@${version}`];
}

/**
 * The npm executable that belongs to the running node, when it sits next to
 * it (nvm, official installers); plain `npm` from PATH otherwise.
 *
 * @param execPath - Running node binary (defaults to process.execPath)
 * @param platform - Platform (tests)
 * @returns Command to run
 */
export function resolveNpmCommand(execPath: string = process.execPath, platform: NodeJS.Platform = process.platform): string {
	const name = platform === 'win32' ? 'npm.cmd' : 'npm';
	const sibling = path.join(path.dirname(execPath), name);
	return fs.existsSync(sibling) ? sibling : name;
}

/**
 * Version in `<packageRoot>/package.json`, read fresh from disk.
 *
 * @param packageRoot - Package root
 * @returns The version, or null when unreadable
 */
export function readInstalledVersion(packageRoot: string): string | null {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8')) as { version?: unknown };
		return typeof pkg.version === 'string' ? pkg.version : null;
	} catch {
		return null;
	}
}

/**
 * Whether `latest` is a strictly newer semver than `current`
 * (numeric major.minor.patch; pre-release tags are ignored).
 *
 * @param latest - Candidate version
 * @param current - Running version
 * @returns True when latest > current
 */
export function isNewerVersion(latest: string, current: string): boolean {
	const parse = (v: string): number[] => v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
	const l = parse(latest);
	const c = parse(current);
	for (let i = 0; i < Math.max(l.length, c.length); i++) {
		const a = l[i] ?? 0;
		const b = c[i] ?? 0;
		if (a !== b) return a > b;
	}
	return false;
}

/**
 * Resolve the on/off switch: the env override wins over the setting.
 *
 * @param settingValue - `settings.general.autoUpdate` (undefined = default on)
 * @param env - Environment
 * @returns The switch state
 *
 * @example
 * ```ts
 * resolveAutoUpdateSwitch(true, { CREWLY_AUTO_UPDATE: '0' }); // 'disabled-env'
 * resolveAutoUpdateSwitch(false, {}); // 'disabled-setting'
 * ```
 */
export function resolveAutoUpdateSwitch(settingValue: boolean | undefined, env: NodeJS.ProcessEnv = process.env): AutoUpdateSwitch {
	const raw = env[AUTO_UPDATE_CONSTANTS.ENV_VAR]?.trim().toLowerCase();
	if (raw && ENV_OFF_VALUES.includes(raw)) return 'disabled-env';
	if (raw && ENV_ON_VALUES.includes(raw)) return 'enabled-env';
	return settingValue === false ? 'disabled-setting' : 'enabled';
}

/**
 * Whether a switch state means "on".
 *
 * @param state - Switch state
 * @returns True when enabled
 */
export function isSwitchOn(state: AutoUpdateSwitch): boolean {
	return state === 'enabled' || state === 'enabled-env';
}

/**
 * Read the command line of a process (POSIX only; `/proc` on Linux, `ps`
 * elsewhere).
 *
 * @param pid - Process id
 * @returns The command line, or null
 */
export function readProcessCommandLine(pid: number): string | null {
	if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 1) return null;
	try {
		const procFile = `/proc/${pid}/cmdline`;
		if (fs.existsSync(procFile)) {
			return fs.readFileSync(procFile, 'utf-8').split('\0').join(' ').trim();
		}
		return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8', timeout: 2000 }).trim();
	} catch {
		return null;
	}
}

/**
 * Whether a supervisor will respawn the backend after it exits with
 * RESTART_REQUESTED. That supervisor is `crewly start` (foreground, under the
 * macOS login-item wrapper, under systemd, or under the desktop app). New
 * CLIs say so in the env; an older CLI parent is recognised by its command line.
 *
 * @param env - Environment
 * @param parentCommandLine - Reader for the parent's command line (tests)
 * @returns True when a respawning parent is present
 */
export function hasRestartSupervisor(
	env: NodeJS.ProcessEnv = process.env,
	parentCommandLine: () => string | null = () => readProcessCommandLine(process.ppid),
): boolean {
	if (env[AUTO_UPDATE_CONSTANTS.SUPERVISOR_ENV_VAR] === AUTO_UPDATE_CONSTANTS.SUPERVISOR_CLI_START) return true;
	const cmd = parentCommandLine();
	return !!cmd && CLI_START_CMDLINE_PATTERN.test(cmd);
}

/**
 * A fresh, empty state.
 *
 * @returns Default state
 */
export function emptyAutoUpdateState(): AutoUpdateState {
	return {
		currentVersion: null,
		latestVersion: null,
		lastCheckAt: null,
		mode: 'unknown',
		lastResult: null,
		consecutiveFailures: 0,
		backoffUntil: null,
		failureNotifiedVersion: null,
	};
}

/**
 * Read the status file; missing or malformed → empty state.
 *
 * @param file - Path of the status file
 * @returns The state
 */
export function readAutoUpdateState(file: string): AutoUpdateState {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<AutoUpdateState>;
		return { ...emptyAutoUpdateState(), ...parsed };
	} catch {
		return emptyAutoUpdateState();
	}
}

/**
 * Write the status file atomically (temp file + rename).
 *
 * @param file - Path of the status file
 * @param state - State to write
 */
export function writeAutoUpdateState(file: string, state: AutoUpdateState): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
	fs.renameSync(tmp, file);
}

/**
 * Write the pending-upgrade marker.
 *
 * @param file - Marker path
 * @param marker - Contents
 */
export function writePendingMarker(file: string, marker: PendingUpgradeMarker): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(marker, null, 2), 'utf-8');
}

/**
 * Read and delete the pending-upgrade marker. It is removed even when
 * malformed, so a crash loop can never repeat the notice.
 *
 * @param file - Marker path
 * @returns The marker, or null when absent or malformed
 */
export function consumePendingMarker(file: string): PendingUpgradeMarker | null {
	if (!fs.existsSync(file)) return null;
	let marker: PendingUpgradeMarker | null = null;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<PendingUpgradeMarker>;
		if (typeof parsed.fromVersion === 'string' && typeof parsed.toVersion === 'string' && typeof parsed.at === 'string') {
			marker = { fromVersion: parsed.fromVersion, toVersion: parsed.toVersion, at: parsed.at };
		}
	} catch {
		marker = null;
	}
	try {
		fs.unlinkSync(file);
	} catch {
		// Already gone
	}
	return marker;
}

/**
 * Owner notice after a successful auto-upgrade.
 *
 * @param version - New version
 * @param deviceName - This machine's name
 * @returns The one-line notice
 */
export function composeUpgradedNotice(version: string, deviceName: string): string {
	return `Crewly 已自动升级到 ${version}（本机：${deviceName}）`;
}

/**
 * Owner notice after repeated failures.
 *
 * @param version - Target version
 * @param deviceName - This machine's name
 * @param failures - Failures in a row
 * @param reason - Last failure reason
 * @returns The notice text
 */
export function composeFailureNotice(version: string, deviceName: string, failures: number, reason: string): string {
	return `Crewly 自动升级到 ${version} 失败（本机：${deviceName}，已连续 ${failures} 次）：${reason}。会稍后重试；也可以在这台机器上运行 crewly upgrade。`;
}

/**
 * Directory to run `npm install -g` from: the first candidate that exists.
 *
 * npm calls process.cwd() before it does anything else and dies with
 * `ENOENT: uv_cwd` (exit 7) when the directory it was started in is gone.
 * The backend's own cwd is the package root, which every global install
 * deletes and recreates — so npm must never inherit it.
 *
 * @param candidates - Directories in order of preference (e.g. crewlyHome, home, tmp)
 * @param isDir - Existence check (tests)
 * @returns The first existing directory, or the filesystem root
 *
 * @example
 * ```ts
 * resolveInstallCwd(['/root/.crewly', '/root', '/tmp']); // '/root/.crewly'
 * ```
 */
export function resolveInstallCwd(
	candidates: Array<string | undefined | null>,
	isDir: (dir: string) => boolean = isExistingDirectory,
): string {
	for (const dir of candidates) {
		if (dir && path.isAbsolute(dir) && isDir(dir)) return dir;
	}
	return path.parse(process.execPath).root || '/';
}

/**
 * Whether a path is an existing directory.
 *
 * @param dir - Path
 * @returns True when it exists and is a directory
 */
function isExistingDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/** Patterns whose matches are replaced before npm output is logged or sent to the owner. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
	// .npmrc-style auth: //registry.npmjs.org/:_authToken=xxx, _auth=, _password=
	[/(_authToken|_auth|_password|password|token)(\s*[=:]\s*)("?)[^\s"']+\3/gi, '$1$2$3[redacted]$3'],
	// Authorization headers
	[/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, '$1[redacted]'],
	// Credentials in URLs: https://user:pass@host
	[/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@'],
	// npm automation/granular tokens and GitHub tokens
	[/\bnpm_[A-Za-z0-9]{20,}\b/g, '[redacted]'],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted]'],
];

/**
 * Remove credentials from npm output.
 *
 * @param text - Raw output
 * @returns The output with secrets replaced by `[redacted]`
 */
export function sanitizeNpmOutput(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
	return out;
}

/** Lines that name the actual npm / Node failure (as opposed to a stack frame or trailer). */
const ERROR_LINE_PATTERN = /^(npm (ERR!|error)\s+\S|\w*Error\b|Error:|ERR_)/;

/**
 * Last `maxLines` non-empty, sanitised lines of npm's output — what goes to
 * the backend log so the next failure is diagnosable without the box.
 *
 * @param outputTail - Combined stdout/stderr tail
 * @param maxLines - Lines to keep
 * @returns The sanitised tail
 */
export function installOutputTail(outputTail: string, maxLines: number = AUTO_UPDATE_CONSTANTS.FAILURE_LOG_TAIL_LINES): string {
	const lines = sanitizeNpmOutput(outputTail).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
	return lines.slice(-maxLines).join('\n');
}

/**
 * One-line reason for a failed install. Node crashes end with a
 * `Node.js vX` trailer and npm with a log-file pointer, so the last line
 * alone says nothing; this picks the first line that names the error and
 * appends the last line when it differs.
 *
 * @param code - npm exit code (null when killed)
 * @param outputTail - Combined stdout/stderr tail
 * @returns e.g. `npm exited with 7: Error: ENOENT: no such file or directory, uv_cwd (… Node.js v22.23.2)`
 *
 * @example
 * ```ts
 * describeInstallFailure(7, 'Error: ENOENT: no such file or directory, uv_cwd\n  at x\nNode.js v22.23.2');
 * // 'npm exited with 7: Error: ENOENT: no such file or directory, uv_cwd (… Node.js v22.23.2)'
 * ```
 */
export function describeInstallFailure(code: number | null, outputTail: string): string {
	const lines = sanitizeNpmOutput(outputTail).split('\n').map((l) => l.trim()).filter(Boolean);
	const last = lines[lines.length - 1] ?? '';
	const errorLine = lines.find((l) => ERROR_LINE_PATTERN.test(l)) ?? '';
	const head = `npm exited with ${code ?? 'a signal'}`;
	const max = AUTO_UPDATE_CONSTANTS.FAILURE_REASON_MAX_CHARS;
	const clip = (s: string): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
	if (!errorLine || errorLine === last) return last ? `${head}: ${clip(last)}` : head;
	return `${head}: ${clip(errorLine)} (… ${clip(last)})`;
}
