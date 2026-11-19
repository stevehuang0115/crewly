/**
 * Find an executable and read its version without a shell.
 *
 * `which <cmd>` and `<cmd> --version 2>/dev/null` only work where the shell
 * is POSIX. Under cmd.exe (Node's default shell on Windows) `which` does not
 * exist and `/dev/null` is not a path, so every tool read as missing
 * (`crewly init` on Windows, 2026-11-19: "jq not found" with jq on PATH).
 *
 * @module utils/find-executable
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/** Extensions tried on Windows when PATHEXT is unset. */
export const DEFAULT_WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** How long a version probe may run (ms). */
export const VERSION_PROBE_TIMEOUT_MS = 10_000;

/** What the lookup reads; injected in tests. */
export interface FindExecutableDeps {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** Whether a path is a file that can be run (follows symlinks) */
	isFile?: (file: string) => boolean;
}

/**
 * Whether a path is a runnable file. `statSync` follows symlinks, so winget's
 * links under `%LOCALAPPDATA%\Microsoft\WinGet\Links` count.
 *
 * @param file - Candidate path
 * @returns True when it exists and is a file
 */
function isRunnableFile(file: string): boolean {
	try {
		if (!fs.statSync(file).isFile()) return false;
		if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The full path of an executable on PATH, or null.
 *
 * Walks `PATH` (and `PATHEXT` on Windows) itself: no shell, no `which`, no
 * `where`.
 *
 * @param bin - Command name without a directory (e.g. `jq`)
 * @param deps - Platform, environment and file check (defaults: the process's)
 * @returns Absolute path of the first match, or null
 *
 * @example
 * ```typescript
 * findExecutable('jq'); // 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\jq.exe'
 * findExecutable('no-such-tool'); // null
 * ```
 */
export function findExecutable(bin: string, deps: FindExecutableDeps = {}): string | null {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const isFile = deps.isFile ?? isRunnableFile;
	const win = platform === 'win32';
	const p = win ? path.win32 : path.posix;
	// Windows env keys are case-insensitive; a spawned env object may carry `Path`.
	const pathValue = env['PATH'] ?? (win ? env['Path'] ?? env['path'] : undefined) ?? '';
	const dirs = pathValue.split(p.delimiter).filter(Boolean);
	const exts = win ? ['', ...(env['PATHEXT'] || DEFAULT_WINDOWS_PATHEXT).split(';').filter(Boolean)] : [''];
	for (const dir of dirs) {
		for (const ext of exts) {
			// A bare name with no extension is not runnable on Windows unless it already names one.
			if (win && ext === '' && !p.extname(bin)) continue;
			const candidate = p.join(dir, bin + ext);
			if (isFile(candidate)) return candidate;
		}
	}
	return null;
}

/**
 * The version an executable prints, without a shell redirect.
 *
 * stderr is discarded through `stdio`, not `2>/dev/null`. A `.cmd` / `.bat`
 * shim (how npm installs CLIs on Windows) cannot be started directly, so
 * those run through the shell; the arguments are the caller's constants.
 *
 * @param command - Command name or absolute path
 * @param versionFlag - Flag that prints the version
 * @param deps - Lookup overrides (tests)
 * @returns The first version-like token, the first output line, or null when it cannot be run
 *
 * @example
 * ```typescript
 * probeVersion('jq'); // '1.8.2'
 * ```
 */
export function probeVersion(command: string, versionFlag = '--version', deps: FindExecutableDeps = {}): string | null {
	const platform = deps.platform ?? process.platform;
	const resolved = path.isAbsolute(command) ? command : findExecutable(command, deps);
	if (!resolved) return null;
	const viaShell = platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
	try {
		const res = spawnSync(viaShell ? `"${resolved}"` : resolved, [versionFlag], {
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: VERSION_PROBE_TIMEOUT_MS,
			shell: viaShell,
			windowsHide: true,
		});
		if (res.error || res.status !== 0) return null;
		const output = String(res.stdout ?? '').trim();
		if (!output) return null;
		const match = output.match(/\d+\.\d+[\w.-]*/);
		return match ? match[0] : output.split('\n')[0];
	} catch {
		return null;
	}
}
