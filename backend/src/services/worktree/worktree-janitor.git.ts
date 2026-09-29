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
 * periodic background job cannot hang on input, and git takes no optional
 * locks (a status never rewrites the index).
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
						// `git status` must not rewrite the index: that would bump its
						// mtime (resetting the idle clock) and contend with agents' git.
						GIT_OPTIONAL_LOCKS: '0',
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

/**
 * Yield to the event loop every YIELD_EVERY_ENTRIES calls, so a long
 * filesystem walk never holds up Slack, relay polls or PTY I/O.
 */
export class EventLoopYielder {
	private count = 0;

	/**
	 * Count one unit of work; every YIELD_EVERY_ENTRIES units, wait one
	 * `setImmediate` turn.
	 *
	 * @returns Resolves when the caller may continue
	 */
	async tick(): Promise<void> {
		this.count++;
		if (this.count % WORKTREE_JANITOR_CONSTANTS.YIELD_EVERY_ENTRIES === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
}

/** lstat that resolves null instead of throwing. */
async function lstatOrNull(p: string): Promise<fs.Stats | null> {
	try {
		return await fs.promises.lstat(p);
	} catch {
		return null;
	}
}

/**
 * Git dir a `.git` file points to (`gitdir: <path>`), resolved against `dir`.
 *
 * @param dir - Directory holding the `.git` file
 * @returns Absolute git dir, or null when there is no readable `.git` file
 */
export async function readGitFilePointer(dir: string): Promise<string | null> {
	try {
		const m = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.promises.readFile(path.join(dir, '.git'), 'utf-8'));
		return m ? path.resolve(dir, m[1]) : null;
	} catch {
		return null;
	}
}

/**
 * Main worktree of the repo a linked worktree belongs to, read from the
 * worktree's `.git` file (`gitdir: <main>/.git/worktrees/<name>`). Returns
 * null for anything else: a `.git` directory (a normal clone), a submodule
 * (`gitdir: …/.git/modules/…`), or an unreadable file.
 *
 * @param dir - Directory that may be a linked worktree
 * @returns Absolute path of the main worktree, or null
 *
 * @example
 * ```typescript
 * // /tmp/visa-cm-wt/.git contains "gitdir: /src/ce-core/.git/worktrees/visa-cm-wt"
 * await mainRepoOfLinkedWorktree('/tmp/visa-cm-wt'); // '/src/ce-core'
 * ```
 */
export async function mainRepoOfLinkedWorktree(dir: string): Promise<string | null> {
	const st = await lstatOrNull(path.join(dir, '.git'));
	if (!st?.isFile()) return null;
	const gitDir = await readGitFilePointer(dir);
	if (!gitDir) return null;
	const worktreesDir = path.dirname(gitDir);
	if (path.basename(worktreesDir) !== 'worktrees') return null;
	const commonDir = path.dirname(worktreesDir);
	if (path.basename(commonDir) !== '.git') return null;
	return path.dirname(commonDir);
}

/** A git checkout found on disk. */
export interface FoundRepo {
	/** Directory holding `.git` */
	path: string;
	/** `dir` for a `.git` directory (clone / main worktree), `file` for a `.git` file (linked worktree or submodule) */
	kind: 'dir' | 'file';
}

/**
 * Find git checkouts under `root` without following symlinks. A directory
 * with a `.git` directory or file is a checkout and is not descended into;
 * `node_modules` and `.git` are never descended into. Fully async; yields to
 * the event loop every few directories.
 *
 * @param root - Directory to search (itself included, at depth 0)
 * @param maxDepth - Deepest level searched (root = 0)
 * @param maxDirs - Stop after visiting this many directories
 * @returns Checkouts found, in walk order
 */
export async function findGitCheckouts(root: string, maxDepth: number, maxDirs = Number.POSITIVE_INFINITY): Promise<FoundRepo[]> {
	const out: FoundRepo[] = [];
	const yielder = new EventLoopYielder();
	let visited = 0;
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (visited >= maxDirs) return;
		visited++;
		await yielder.tick();
		const dotGit = await lstatOrNull(path.join(dir, '.git'));
		if (dotGit && (dotGit.isDirectory() || dotGit.isFile())) {
			out.push({ path: dir, kind: dotGit.isDirectory() ? 'dir' : 'file' });
			return;
		}
		if (depth >= maxDepth) return;
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			// Dirent.isDirectory() is false for symlinks, so links are never followed.
			if (!e.isDirectory() || WORKTREE_JANITOR_CONSTANTS.SEARCH_SKIP_DIRS.includes(e.name)) continue;
			await walk(path.join(dir, e.name), depth + 1);
		}
	};
	await walk(root, 0);
	return out;
}

/**
 * Main worktrees of every repo that owns a linked worktree somewhere under
 * the given roots (e.g. `/tmp/claude-501/visa-cm-wt` → `~/src/ce-core`), so
 * repos that are not registered projects still get their temp worktrees
 * cleaned. Visits at most DISCOVERY_MAX_DIRS directories per root.
 *
 * @param roots - Temp roots to scan (missing roots are skipped)
 * @returns De-duplicated main-worktree paths
 */
export async function discoverLinkedWorktreeRepos(roots: readonly string[]): Promise<string[]> {
	const out = new Set<string>();
	for (const root of roots) {
		if (!(await lstatOrNull(root))) continue;
		const found = await findGitCheckouts(root, WORKTREE_JANITOR_CONSTANTS.DISCOVERY_DEPTH, WORKTREE_JANITOR_CONSTANTS.DISCOVERY_MAX_DIRS);
		for (const f of found) {
			if (f.kind !== 'file') continue;
			const main = await mainRepoOfLinkedWorktree(f.path);
			if (main && (await lstatOrNull(main))) out.add(main);
		}
	}
	return [...out];
}

/**
 * Newest mtime (ms) of `dir` and everything within `depth` levels below it,
 * using lstat (symlinks are not followed). Async; yields every few entries.
 *
 * @param dir - Directory
 * @param depth - Levels below `dir` to include (0 = only `dir`)
 * @returns Newest mtime in ms, or null when `dir` cannot be stat'ed
 */
export async function latestTreeMtimeMs(dir: string, depth: number): Promise<number | null> {
	let newest: number | null = null;
	const yielder = new EventLoopYielder();
	const visit = async (p: string, level: number): Promise<void> => {
		await yielder.tick();
		const st = await lstatOrNull(p);
		if (!st) return;
		if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
		if (level >= depth || !st.isDirectory()) return;
		let names: string[];
		try {
			names = await fs.promises.readdir(p);
		} catch {
			return;
		}
		for (const n of names) await visit(path.join(p, n), level + 1);
	};
	await visit(dir, 0);
	return newest;
}

/**
 * Disk usage of a path in bytes (`du -sk` in a child process, so the event
 * loop is never blocked; `du` does not follow symlinks).
 *
 * @param p - File or directory
 * @returns Bytes, or null when `du` failed or timed out
 */
export async function diskUsageBytes(p: string): Promise<number | null> {
	const r = await runCommand('du', ['-sk', p], { timeoutMs: WORKTREE_JANITOR_CONSTANTS.DU_TIMEOUT_MS });
	const kb = Number.parseInt(r.stdout.trim().split(/\s+/)[0] ?? '', 10);
	return Number.isFinite(kb) ? kb * 1024 : null;
}

/**
 * Human-readable size (`1.8 GB`, `512 MB`).
 *
 * @param bytes - Size in bytes
 * @returns Short string with one decimal for GB
 */
export function formatBytes(bytes: number): string {
	const gb = bytes / 1024 ** 3;
	if (gb >= 1) return `${gb.toFixed(1)} GB`;
	const mb = bytes / 1024 ** 2;
	if (mb >= 1) return `${Math.round(mb)} MB`;
	return `${Math.round(bytes / 1024)} KB`;
}
