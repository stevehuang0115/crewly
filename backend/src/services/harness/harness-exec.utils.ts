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
 * The bin directory of the user-owned npm prefix.
 *
 * @returns Absolute path, e.g. `~/.crewly/npm-global/bin`
 */
export function getUserNpmBinDir(): string {
	return path.join(getUserNpmPrefix(), 'bin');
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

/**
 * Find an executable on a PATH, like `which`.
 *
 * @param command - Bare command name (or an absolute path, returned when executable)
 * @param envPath - PATH to search
 * @param isExecutable - Executable check (injectable for tests)
 * @returns Absolute path, or null when not found
 */
export function resolveExecutable(
	command: string,
	envPath: string | undefined,
	isExecutable: (file: string) => boolean = defaultIsExecutable,
): string | null {
	if (command.includes(path.sep)) {
		return isExecutable(command) ? command : null;
	}
	for (const dir of (envPath ?? '').split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, command);
		if (isExecutable(candidate)) return candidate;
	}
	return null;
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
 * Run a command without a shell and collect its output.
 *
 * Never rejects: a spawn failure (ENOENT) or timeout comes back as
 * `{ code: null, error }`. Secrets must go through `options.stdin`, never
 * through `args`, so they cannot appear in `ps` output.
 *
 * @param command - Executable
 * @param args - Arguments
 * @param options - env, timeout, stdin, streaming output callback
 * @returns Exit code and output
 */
export const runCommand: RunCommand = (
	command: string,
	args: readonly string[],
	options: RunCommandOptions = {},
): Promise<CommandResult> =>
	new Promise((resolve) => {
		let stdout = '';
		let stderr = '';
		let settled = false;
		let timer: NodeJS.Timeout | null = null;
		const finish = (result: CommandResult): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, [...args], {
				env: options.env ?? process.env,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (error) {
			resolve({ code: null, stdout: '', stderr: '', error: error instanceof Error ? error.message : String(error) });
			return;
		}

		if (options.timeoutMs) {
			timer = setTimeout(() => {
				child.kill('SIGKILL');
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
