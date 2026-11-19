/**
 * Process helpers for harness onboarding: the PATH every harness process gets
 * and a shell-free command runner.
 *
 * PATH: when `npm install -g` hits EACCES, Crewly installs the harness under a
 * user-owned prefix (`<crewlyHome>/npm-global`). Its `bin` dir is prepended to
 * PATH for everything Crewly spawns — status probes, the login broker and agent
 * sessions — so a harness installed there is found without touching the
 * user's shell profile. Claude Code's native installer dir (`~/.local/bin`) is
 * appended when missing, because a backend started by launchd/systemd often
 * lacks it.
 *
 * @module services/harness/harness-exec.utils
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HARNESS_CONSTANTS } from '../../constants.js';
import { DEFAULT_WINDOWS_PATHEXT } from '../../utils/find-executable.utils.js';
import { LoggerService } from '../core/logger.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import type { CommandResult, RunCommand, RunCommandOptions } from './harness.types.js';

/**
 * The user-owned npm prefix used when a global install is not permitted.
 *
 * @returns Absolute path, e.g. `~/.crewly/npm-global`
 */
export function getUserNpmPrefix(): string {
	return path.join(getCrewlyHomePath(), HARNESS_CONSTANTS.USER_NPM_PREFIX_DIR);
}

/**
 * The bin directory of the user-owned npm prefix. On Windows npm puts the
 * command shims in the prefix itself.
 *
 * @param platform - Platform (injectable for tests)
 * @returns Absolute path, e.g. `~/.crewly/npm-global/bin`
 */
export function getUserNpmBinDir(platform: NodeJS.Platform = process.platform): string {
	return platform === 'win32' ? getUserNpmPrefix() : path.join(getUserNpmPrefix(), 'bin');
}

/**
 * Build the PATH value harness processes run with.
 *
 * Prepends the user npm prefix bin dir and appends `~/.local/bin`, each only
 * when not already present. Order of the existing entries is preserved.
 *
 * @param currentPath - Existing PATH (may be undefined)
 * @param homeDir - Home directory (injectable for tests)
 * @returns The PATH string
 *
 * @example
 * ```ts
 * buildHarnessPath('/usr/bin', '/home/me');
 * // '/home/me/.crewly/npm-global/bin:/usr/bin:/home/me/.local/bin'
 * ```
 */
export function buildHarnessPath(currentPath: string | undefined, homeDir: string = os.homedir()): string {
	const entries = (currentPath ?? '').split(path.delimiter).filter((entry) => entry.length > 0);
	const npmBin = getUserNpmBinDir();
	const nativeBin = path.join(homeDir, HARNESS_CONSTANTS.NATIVE_INSTALLER_BIN_DIR);
	const result = entries.includes(npmBin) ? [...entries] : [npmBin, ...entries];
	if (!result.includes(nativeBin)) result.push(nativeBin);
	return result.join(path.delimiter);
}

/**
 * PATH for running `npm`: the harness PATH plus the directory of the running
 * Node binary, where npm lives in nvm / installer layouts. A backend started
 * by launchd or systemd often has neither on its PATH.
 *
 * @param currentPath - Existing PATH
 * @param homeDir - Home directory (injectable for tests)
 * @param nodeBinDir - Directory of the Node binary (injectable for tests)
 * @returns The PATH string
 */
export function buildNpmPath(
	currentPath: string | undefined,
	homeDir: string = os.homedir(),
	nodeBinDir: string = path.dirname(process.execPath),
): string {
	const harnessPath = buildHarnessPath(currentPath, homeDir);
	return harnessPath.split(path.delimiter).includes(nodeBinDir) ? harnessPath : `${harnessPath}${path.delimiter}${nodeBinDir}`;
}

/**
 * Copy an environment with PATH set to {@link buildHarnessPath}.
 *
 * @param env - Source environment (defaults to process.env)
 * @returns A new environment object
 */
export function withHarnessPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...env, PATH: buildHarnessPath(env.PATH) };
}

/** What {@link resolveExecutable} reads besides the PATH; injected in tests. */
export interface ResolveExecutableOptions {
	platform?: NodeJS.Platform;
	/** `PATHEXT` (Windows): the extensions a bare command name may have */
	pathExt?: string;
}

/**
 * Find an executable on a PATH, like `which`.
 *
 * On Windows a command is a file with one of the `PATHEXT` extensions
 * (`claude.exe`, `claude.cmd`), so a bare name is tried with each of them.
 * Without that every harness read as "not installed" there (2026-11-19).
 *
 * @param command - Bare command name (or an absolute path, returned when executable)
 * @param envPath - PATH to search
 * @param isExecutable - Executable check (injectable for tests)
 * @param options - Platform and PATHEXT (default: the process's)
 * @returns Absolute path, or null when not found
 *
 * @example
 * ```ts
 * resolveExecutable('claude', process.env.PATH); // 'C:\\Users\\me\\.local\\bin\\claude.exe'
 * ```
 */
export function resolveExecutable(
	command: string,
	envPath: string | undefined,
	isExecutable: (file: string) => boolean = defaultIsExecutable,
	options: ResolveExecutableOptions = {},
): string | null {
	const win = (options.platform ?? process.platform) === 'win32';
	const p = win ? path.win32 : path.posix;
	const suffixes =
		win && !p.extname(command)
			? (options.pathExt ?? process.env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT).split(';').filter((ext) => ext.length > 0)
			: [''];
	const firstRunnable = (base: string): string | null => {
		for (const suffix of suffixes) {
			if (isExecutable(base + suffix)) return base + suffix;
		}
		return null;
	};
	if (command.includes(p.sep) || (win && command.includes('/'))) {
		return firstRunnable(command);
	}
	for (const dir of (envPath ?? '').split(p.delimiter)) {
		if (!dir) continue;
		const found = firstRunnable(p.join(dir, command));
		if (found) return found;
	}
	return null;
}

/**
 * How to start a resolved executable. A `.cmd` / `.bat` shim (how npm installs
 * CLIs on Windows) cannot be started directly: it runs through `cmd.exe`, with
 * the whole command line in one pair of quotes so paths with spaces survive.
 *
 * @param file - Executable (absolute path, or a bare name)
 * @param args - Arguments
 * @param platform - Platform
 * @returns What to pass to `spawn`
 *
 * @example
 * ```ts
 * spawnTarget('C:\\npm\\codex.cmd', ['--version'], 'win32');
 * // { file: 'cmd.exe', args: ['/d', '/s', '/c', '""C:\\npm\\codex.cmd" --version"'], verbatim: true }
 * ```
 */
export function spawnTarget(file: string, args: readonly string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[]; verbatim: boolean } {
	if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) return { file, args: [...args], verbatim: false };
	const quote = (value: string): string => (/[\s"&|<>^()%!]/.test(value) || value === '' ? `"${value.replace(/"/g, '""')}"` : value);
	const line = [`"${file}"`, ...args.map(quote)].join(' ');
	return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/**
 * Whether a file exists and is executable by this user.
 *
 * @param file - Absolute path
 * @returns True when executable
 */
function defaultIsExecutable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * SIGKILL a child and everything in its process group.
 *
 * @param child - Child spawned with `detached` (its own group)
 */
function killTree(child: ReturnType<typeof spawn>): void {
	if (child.pid && process.platform !== 'win32') {
		try {
			process.kill(-child.pid, 'SIGKILL');
			return;
		} catch {
			// Group already gone: fall through to the direct kill.
		}
	}
	child.kill('SIGKILL');
}

/** Injectable seams of {@link createRunCommand}. */
export interface RunCommandDeps {
	spawn?: typeof spawn;
	now?: () => number;
	/** Whether a pid still exists (default: `process.kill(pid, 0)`) */
	isAlive?: (pid: number) => boolean;
	/** Receives the rate-limited stuck-executable warning */
	warn?: (message: string, data: Record<string, unknown>) => void;
}

/**
 * Whether anything from a run is still alive. Runs are spawned as their own
 * process group (pgid = the child's pid), and the process that hangs is
 * usually the native binary a wrapper started, not the wrapper itself, so on
 * POSIX the whole group is checked.
 *
 * @param pid - Pid of the spawned child (its process group id on POSIX)
 * @returns True when signal 0 to the group (or pid) succeeds; EPERM still means alive
 */
function defaultIsAlive(pid: number): boolean {
	try {
		process.kill(process.platform === 'win32' ? pid : -pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Build a command runner with per-executable pile-up protection.
 *
 * On macOS a process stuck in exec / Gatekeeper verification survives SIGKILL
 * until the kernel call returns, so killing a timed-out probe does not free
 * it, and every new probe of that executable hangs too (hundreds of `codex`
 * processes). The runner therefore remembers killed-but-still-alive children
 * per executable and, while any exist, returns `{ code: null, error }`
 * without spawning. It also caps concurrent timeout-bounded runs per
 * executable. Callers already treat `code: null` as "could not run".
 *
 * @param deps - Injectable seams (tests)
 * @returns A {@link RunCommand}
 */
export function createRunCommand(deps: RunCommandDeps = {}): RunCommand {
	const spawnFn = deps.spawn ?? spawn;
	const now = deps.now ?? Date.now;
	const isAlive = deps.isAlive ?? defaultIsAlive;
	const warn =
		deps.warn ??
		((message: string, data: Record<string, unknown>): void =>
			LoggerService.getInstance().createComponentLogger('HarnessExec').warn(message, data));
	const stuck = new Map<string, Set<number>>();
	const inflight = new Map<string, number>();
	const lastWarnAt = new Map<string, number>();

	const stuckCount = (key: string): number => {
		const pids = stuck.get(key);
		if (!pids) return 0;
		for (const pid of [...pids]) if (!isAlive(pid)) pids.delete(pid);
		if (pids.size === 0) stuck.delete(key);
		return pids.size;
	};
	const warnOnce = (key: string, count: number): void => {
		const last = lastWarnAt.get(key);
		if (last !== undefined && now() - last < HARNESS_CONSTANTS.STUCK_WARN_INTERVAL_MS) return;
		lastWarnAt.set(key, now());
		warn(`${key} is not responding; skipping new runs until the stuck ones exit`, { executable: key, stuckPids: count });
	};

	return (command: string, args: readonly string[], options: RunCommandOptions = {}): Promise<CommandResult> =>
		new Promise((resolve) => {
			const key = resolveExecutable(command, options.env?.PATH ?? process.env.PATH) ?? command;
			const stuckNow = stuckCount(key);
			if (stuckNow > 0) {
				warnOnce(key, stuckNow);
				resolve({ code: null, stdout: '', stderr: '', error: `${key} is not responding (an earlier run is still stuck)` });
				return;
			}
			const bounded = Boolean(options.timeoutMs);
			if (bounded && (inflight.get(key) ?? 0) >= HARNESS_CONSTANTS.MAX_INFLIGHT_PER_EXECUTABLE) {
				warnOnce(key, 0);
				resolve({ code: null, stdout: '', stderr: '', error: `${key} is not responding (too many runs in flight)` });
				return;
			}

			let stdout = '';
			let stderr = '';
			let settled = false;
			let timer: NodeJS.Timeout | null = null;
			let released = false;
			const release = (): void => {
				if (released || !bounded) return;
				released = true;
				inflight.set(key, Math.max(0, (inflight.get(key) ?? 1) - 1));
			};
			const finish = (result: CommandResult): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				release();
				resolve(result);
			};

			let child: ReturnType<typeof spawn>;
			try {
				// Windows starts `npm` / `codex` only by their real file name (`npm.cmd`).
				const target = spawnTarget(process.platform === 'win32' ? key : command, args);
				child = spawnFn(target.file, target.args, {
					env: options.env ?? process.env,
					...(options.cwd ? { cwd: options.cwd } : {}),
					stdio: ['pipe', 'pipe', 'pipe'],
					detached: process.platform !== 'win32',
					...(target.verbatim ? { windowsVerbatimArguments: true, windowsHide: true } : {}),
				});
			} catch (error) {
				resolve({ code: null, stdout: '', stderr: '', error: error instanceof Error ? error.message : String(error) });
				return;
			}
			if (bounded) inflight.set(key, (inflight.get(key) ?? 0) + 1);

			if (options.timeoutMs) {
				timer = setTimeout(() => {
					killTree(child);
					// Remember the group even if the wrapper itself dies: its native
					// child may be the one that cannot be reaped. stuckCount() drops it
					// once nothing in the group is left.
					if (child.pid !== undefined) {
						const pids = stuck.get(key) ?? new Set<number>();
						pids.add(child.pid);
						stuck.set(key, pids);
					}
					finish({ code: null, stdout, stderr, error: `timed out after ${options.timeoutMs} ms` });
				}, options.timeoutMs);
			}

			child.stdout?.on('data', (chunk: Buffer) => {
				const text = chunk.toString();
				stdout += text;
				options.onOutput?.(text);
			});
			child.stderr?.on('data', (chunk: Buffer) => {
				const text = chunk.toString();
				stderr += text;
				options.onOutput?.(text);
			});
			child.on('error', (error) => finish({ code: null, stdout, stderr, error: error.message }));
			child.on('close', (code) => finish({ code, stdout, stderr }));

			child.stdin?.on('error', () => undefined);
			if (options.stdin !== undefined) {
				child.stdin?.end(options.stdin);
			} else {
				child.stdin?.end();
			}
		});
}

/**
 * Run a command without a shell and collect its output.
 *
 * Never rejects: a spawn failure (ENOENT), timeout, or a refusal because an
 * earlier run of the same executable is still stuck comes back as
 * `{ code: null, error }`. The command runs in its own process group and a
 * timeout kills the whole group: harness CLIs such as `codex` are Node
 * wrappers around a native binary, and SIGKILL on the wrapper alone left the
 * native child running forever. See {@link createRunCommand} for the
 * pile-up guard. Secrets must go through `options.stdin`, never through
 * `args`, so they cannot appear in `ps` output.
 *
 * @param command - Executable
 * @param args - Arguments
 * @param options - env, timeout, stdin, streaming output callback
 * @returns Exit code and output
 */
export const runCommand: RunCommand = createRunCommand();
