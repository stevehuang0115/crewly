/**
 * Worktree janitor — low-level helpers.
 *
 * A command runner that never throws, a parser for `git worktree list
 * --porcelain`, path helpers, and the process-cwd probe used to tell whether
 * anything is still working inside a worktree. Kept apart from the service so
 * each piece can be tested on its own.
 *
 * @module services/worktree/worktree-janitor.git
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WORKTREE_JANITOR_CONSTANTS } from '../../constants.js';

/** Result of one external command. `code` is null when it could not start or timed out. */
export interface CommandResult {
	/** Exit code, or null when the process did not exit normally */
	code: number | null;
	/** Captured stdout */
	stdout: string;
	/** Captured stderr (or the spawn error message) */
	stderr: string;
}

/** Options for {@link runCommand}. */
export interface RunCommandOptions {
	/** Working directory */
	cwd?: string;
	/** Timeout in ms (default: GIT_TIMEOUT_MS) */
	timeoutMs?: number;
	/** Extra environment variables merged over process.env */
	env?: Record<string, string>;
}

/**
 * Run a command without a shell and never throw.
 *
 * Git and gh are told never to prompt (no credential dialogs, no pager), so a
 * periodic background job cannot hang on input.
 *
 * @param file - Executable (e.g. `git`, `gh`, or an absolute path)
 * @param args - Arguments
 * @param options - cwd / timeout / env
 * @returns Exit code and output; `code` is null on spawn failure or timeout
 *
 * @example
 * ```typescript
 * const r = await runCommand('git', ['-C', repo, 'status', '--porcelain']);
 * if (r.code === 0 && r.stdout === '') console.log('clean');
 * ```
 */
export function runCommand(file: string, args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
	return new Promise((resolve) => {
		try {
			execFile(
				file,
				args,
				{
					cwd: options.cwd,
					timeout: options.timeoutMs ?? WORKTREE_JANITOR_CONSTANTS.GIT_TIMEOUT_MS,
					maxBuffer: WORKTREE_JANITOR_CONSTANTS.MAX_OUTPUT_BYTES,
					env: {
						...process.env,
						GIT_TERMINAL_PROMPT: '0',
						GIT_PAGER: 'cat',
						GH_PROMPT_DISABLED: '1',
						GH_NO_UPDATE_NOTIFIER: '1',
						...(options.env ?? {}),
					},
				},
				(error, stdout, stderr) => {
					const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
					const err = typeof stderr === 'string' ? stderr : String(stderr ?? '');
					if (!error) {
						resolve({ code: 0, stdout: out, stderr: err });
						return;
					}
					const errCode = (error as NodeJS.ErrnoException & { code?: unknown }).code;
					const code = typeof errCode === 'number' && !(error as { killed?: boolean }).killed ? errCode : null;
					resolve({ code, stdout: out, stderr: err || error.message });
				},
			);
		} catch (spawnErr) {
			resolve({ code: null, stdout: '', stderr: spawnErr instanceof Error ? spawnErr.message : String(spawnErr) });
		}
	});
}

/** One entry of `git worktree list --porcelain`. */
export interface PorcelainWorktree {
	/** Absolute worktree path as git reports it */
	path: string;
	/** HEAD commit, or null (bare) */
	head: string | null;
	/** Short branch name (`refs/heads/` stripped), or null when detached */
	branch: string | null;
	/** True for the bare entry */
	bare: boolean;
	/** True when HEAD is detached */
	detached: boolean;
	/** True when the worktree is locked (`git worktree lock`) */
	locked: boolean;
	/** Lock reason, when given */
	lockReason?: string;
	/** True when git reports the directory as gone (`prunable`) */
	prunable: boolean;
	/** True for the first entry — the main worktree */
	isMain: boolean;
}

/**
 * Parse `git worktree list --porcelain` output.
 *
 * Entries are separated by blank lines; the first entry is the main worktree.
 *
 * @param output - Raw porcelain output
 * @returns Parsed entries in git's order
 *
 * @example
 * ```typescript
 * parsePorcelainWorktrees('worktree /r\nHEAD abc\nbranch refs/heads/main\n');
 * // [{ path: '/r', head: 'abc', branch: 'main', isMain: true, ... }]
 * ```
 */
export function parsePorcelainWorktrees(output: string): PorcelainWorktree[] {
	const result: PorcelainWorktree[] = [];
	let current: PorcelainWorktree | null = null;
	for (const rawLine of output.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if (line.startsWith('worktree ')) {
			current = {
				path: line.slice('worktree '.length),
				head: null,
				branch: null,
				bare: false,
				detached: false,
				locked: false,
				prunable: false,
				isMain: result.length === 0,
			};
			result.push(current);
			continue;
		}
		if (!current || line === '') continue;
		if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
		else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
		else if (line === 'bare') current.bare = true;
		else if (line === 'detached') current.detached = true;
		else if (line === 'locked' || line.startsWith('locked ')) {
			current.locked = true;
			const reason = line.slice('locked'.length).trim();
			if (reason) current.lockReason = reason;
		} else if (line === 'prunable' || line.startsWith('prunable ')) current.prunable = true;
	}
	return result;
}

/**
 * Real path of `p`, or its resolved form when it does not exist.
 *
 * @param p - Path
 * @returns Canonical path for comparisons
 */
export function canonicalPath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/**
 * Whether `child` is `parent` or inside it (both canonicalised first).
 *
 * @param child - Candidate path
 * @param parent - Directory
 * @returns True when child === parent or child is under parent
 *
 * @example
 * ```typescript
 * isPathInside('/r/.claude/worktrees/a/src', '/r/.claude/worktrees/a'); // true
 * isPathInside('/r/.claude/worktrees/ab', '/r/.claude/worktrees/a');    // false
 * ```
 */
export function isPathInside(child: string, parent: string): boolean {
	const c = canonicalPath(child);
	const p = canonicalPath(parent);
	if (c === p) return true;
	const withSep = p.endsWith(path.sep) ? p : p + path.sep;
	return c.startsWith(withSep);
}

/**
 * Latest modification time (ms) of a worktree: the directory itself plus its
 * private git dir's `index`, `HEAD` and `logs/HEAD` — every commit, checkout,
 * stage or reset touches one of those. Uncommitted edits are caught by the
 * dirty check instead.
 *
 * @param worktreePath - Worktree root
 * @param gitDir - Its private git dir (`.git/worktrees/<name>`), when known
 * @returns Newest mtime in ms, or null when nothing could be stat'ed
 */
export function latestWorktreeMtimeMs(worktreePath: string, gitDir: string | null): number | null {
	const candidates = [worktreePath, path.join(worktreePath, '.git')];
	if (gitDir) {
		candidates.push(gitDir, path.join(gitDir, 'index'), path.join(gitDir, 'HEAD'), path.join(gitDir, 'logs', 'HEAD'));
	}
	let newest: number | null = null;
	for (const c of candidates) {
		try {
			const m = fs.lstatSync(c).mtimeMs;
			if (newest === null || m > newest) newest = m;
		} catch {
			// missing — ignore
		}
	}
	return newest;
}

/**
 * Current working directories of every process this user can see.
 *
 * macOS: `lsof -a -d cwd -u <uid> -Fn`. Linux: `/proc/<pid>/cwd`. Returns
 * null when the probe cannot run, so the caller can treat "unknown" as busy.
 *
 * @returns Absolute cwd paths (deduplicated), or null when unavailable
 */
export async function listProcessCwds(): Promise<string[] | null> {
	if (process.platform === 'linux') {
		try {
			const out = new Set<string>();
			for (const entry of fs.readdirSync('/proc')) {
				if (!/^\d+$/.test(entry)) continue;
				try {
					out.add(fs.readlinkSync(path.join('/proc', entry, 'cwd')));
				} catch {
					// other user's process or already gone
				}
			}
			return [...out];
		} catch {
			return null;
		}
	}
	if (process.platform === 'win32') return null;
	const uid = typeof process.getuid === 'function' ? String(process.getuid()) : String(os.userInfo().uid);
	const r = await runCommand('lsof', ['-a', '-d', 'cwd', '-u', uid, '-Fn', '-w'], {
		timeoutMs: WORKTREE_JANITOR_CONSTANTS.CWD_PROBE_TIMEOUT_MS,
	});
	// lsof exits 1 when some listed item had no match; the output is still valid.
	if (r.code === null || !r.stdout) return null;
	const out = new Set<string>();
	for (const line of r.stdout.split('\n')) {
		if (line.startsWith('n/')) out.add(line.slice(1));
	}
	return out.size > 0 ? [...out] : null;
}

/**
 * Whether the kill switch disables the janitor.
 *
 * @param env - Environment (defaults to process.env)
 * @returns True when `CREWLY_WORKTREE_JANITOR` is `0`/`off`/`false`/`no`
 */
export function isJanitorDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env[WORKTREE_JANITOR_CONSTANTS.ENV_VAR];
	if (raw === undefined) return false;
	return WORKTREE_JANITOR_CONSTANTS.DISABLED_VALUES.includes(raw.trim().toLowerCase());
}
