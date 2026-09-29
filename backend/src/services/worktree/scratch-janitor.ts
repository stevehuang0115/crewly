/**
 * Scratch janitor — removes stale Claude Code session scratch dirs.
 *
 * Claude Code gives every session a temp dir
 * `<tmp>/claude-<uid>/<project-slug>/<session-uuid>/` (with `scratchpad/`
 * inside). Agents clone whole repos and build test homes there — 0.5–1.8 GB
 * each — and nothing ever deletes them; one Mac filled its disk with dozens
 * of GB of week-old sessions. These are not worktrees, so the worktree rules
 * never see them.
 *
 * ## Roots
 * `<os.tmpdir()>/claude-<uid>`, `/private/tmp/claude-<uid>` and
 * `/tmp/claude-<uid>`, de-duplicated by real path. Only the
 * `<root>/<slug>/<uuid>/` pattern is a unit; anything else in the root
 * (loose files, worktrees such as `<root>/visa-cm-wt`) is left alone here.
 * Symlinks are never followed out of the root.
 *
 * ## A session dir is deleted only when ALL hold
 * 1. Idle: the newest mtime of the dir and everything in its top two levels,
 *    and of every git repo's HEAD / index / logs/HEAD inside it, is older
 *    than 3 days (halved in low-disk mode, never below 2 h).
 * 2. No process of this user (nor a Crewly agent session) has its cwd
 *    inside. If the probe fails, everything is kept.
 * 3. It holds no linked worktree of a repo outside it — those belong to the
 *    worktree rules (`git worktree remove`), never `rm -rf`.
 * 4. Every git repo inside (depth ≤ 3, `node_modules` skipped) is safe:
 *    - `git status --porcelain --untracked-files=all` is empty (untracked
 *      files count, ignored ones do not);
 *    - it has a remote (no remote → kept: its commits may exist nowhere else);
 *    - `git rev-list HEAD --branches --not --remotes` is empty (no local
 *      commit missing from the remote-tracking refs) and there is no stash;
 *    - it has no linked worktree outside the session dir (deleting the
 *      clone would orphan it).
 *    Any git error keeps the dir.
 *
 * @module services/worktree/scratch-janitor
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WORKTREE_JANITOR_CONSTANTS } from '../../constants.js';
import {
	canonicalPath,
	diskUsageBytes,
	EventLoopYielder,
	findGitCheckouts,
	isPathInside,
	latestTreeMtimeMs,
	latestWorktreeMtimeMs,
	parsePorcelainWorktrees,
	readGitFilePointer,
	type CommandResult,
	type FoundRepo,
} from './worktree-janitor.git.js';

/** Why a session dir is kept, or why it may go. */
export type ScratchReason =
	| 'recent'
	| 'process-inside'
	| 'agent-session-inside'
	| 'cwd-probe-failed'
	| 'contains-worktree'
	| 'dirty'
	| 'no-remote'
	| 'unpushed'
	| 'stash'
	| 'has-external-worktrees'
	| 'git-failed'
	| 'stale';

/** Verdict and outcome for one session dir. */
export interface ScratchVerdict {
	/** Absolute session dir */
	path: string;
	/** What the janitor would do / did */
	decision: 'remove' | 'keep';
	/** The deciding rule */
	reason: ScratchReason;
	/** Repo (or path) that decided it, and what was found */
	detail?: string;
	/** Ms since last touched, when computed */
	idleMs?: number;
	/** Git repos found inside */
	repos: string[];
	/** True when the dir was deleted */
	removed: boolean;
	/** Bytes freed (measured before deletion), when removed */
	freedBytes?: number;
	/** Error text when deletion failed */
	error?: string;
}

/** Result of one scratch sweep. */
export interface ScratchSweepSummary {
	/** Roots scanned (real paths) */
	roots: string[];
	/** Session dirs removed */
	removed: number;
	/** Dry run only: dirs a real sweep would remove */
	wouldRemove: number;
	/** Session dirs kept */
	kept: number;
	/** Bytes freed by removed dirs */
	freedBytes: number;
	/** Kept dirs by reason */
	keptReasons: Record<string, number>;
	/** Per-dir results */
	sessions: ScratchVerdict[];
}

/** A place something is working in (same shape as the worktree janitor's). */
export interface ScratchBusyCwd {
	/** Absolute directory */
	cwd: string;
	/** `agent-session` for Crewly sessions, `process` for anything else */
	source: 'agent-session' | 'process';
}

/** Inputs of one sweep. */
export interface ScratchSweepInput {
	/** Roots to scan (already resolved) */
	roots: string[];
	/** Busy cwds, or null when the probe failed */
	busy: ScratchBusyCwd[] | null;
	/** Current time (ms) */
	now: number;
	/** Minimum idle time */
	minIdleMs: number;
	/** When true, nothing is deleted */
	dryRun: boolean;
	/** git runner (`args` as for `git`) */
	git: (args: string[]) => Promise<CommandResult>;
	/** Size probe (default `du -sk`) */
	sizeOf?: (p: string) => Promise<number | null>;
}

/**
 * The per-user Claude Code temp roots that exist, de-duplicated by real path.
 *
 * @param uid - User id (default: process.getuid())
 * @param tmpDir - System temp dir (default: os.tmpdir())
 * @returns Existing root directories (real paths)
 *
 * @example
 * ```typescript
 * defaultScratchRoots(501); // ['/private/tmp/claude-501']
 * ```
 */
export function defaultScratchRoots(uid?: number, tmpDir: string = os.tmpdir()): string[] {
	const id = uid ?? (typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid);
	const name = `${WORKTREE_JANITOR_CONSTANTS.SCRATCH_ROOT_PREFIX}${id}`;
	const candidates = [tmpDir, ...WORKTREE_JANITOR_CONSTANTS.SCRATCH_TMP_DIRS].map((d) => path.join(d, name));
	const out = new Set<string>();
	for (const c of candidates) {
		try {
			if (fs.lstatSync(c).isDirectory()) out.add(fs.realpathSync(c));
		} catch {
			// missing
		}
	}
	return [...out];
}

/**
 * Session dirs (`<root>/<slug>/<uuid>`) under a root. Symlinked slugs or
 * session dirs are skipped, as is anything not matching the pattern. Async;
 * yields to the event loop every few entries.
 *
 * @param root - A scratch root (real path)
 * @returns Absolute session dirs
 */
export async function listSessionDirs(root: string): Promise<string[]> {
	const out: string[] = [];
	const yielder = new EventLoopYielder();
	let slugs: fs.Dirent[];
	try {
		slugs = await fs.promises.readdir(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const slug of slugs) {
		await yielder.tick();
		if (!slug.isDirectory()) continue;
		const slugDir = path.join(root, slug.name);
		let sessions: fs.Dirent[];
		try {
			sessions = await fs.promises.readdir(slugDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const s of sessions) {
			if (!s.isDirectory() || !WORKTREE_JANITOR_CONSTANTS.SCRATCH_SESSION_DIR_PATTERN.test(s.name)) continue;
			out.push(path.join(slugDir, s.name));
		}
	}
	return out;
}

/** Git dir of a checkout (`.git` dir, or the one a `.git` file points to). */
async function gitDirOf(repo: FoundRepo): Promise<string | null> {
	return repo.kind === 'dir' ? path.join(repo.path, '.git') : readGitFilePointer(repo.path);
}

/**
 * Evaluate one session dir. Read-only.
 *
 * @param dir - Session dir
 * @param input - Sweep inputs
 * @returns Verdict (not yet acted on)
 */
export async function evaluateSessionDir(dir: string, input: ScratchSweepInput): Promise<ScratchVerdict> {
	const repos = await findGitCheckouts(dir, WORKTREE_JANITOR_CONSTANTS.SCRATCH_REPO_SEARCH_DEPTH);
	const base = { path: dir, repos: repos.map((r) => r.path), removed: false };
	const keep = (reason: ScratchReason, detail?: string, idleMs?: number): ScratchVerdict => ({
		...base,
		decision: 'keep',
		reason,
		...(detail ? { detail } : {}),
		...(idleMs !== undefined ? { idleMs } : {}),
	});

	let newest = await latestTreeMtimeMs(dir, WORKTREE_JANITOR_CONSTANTS.SCRATCH_MTIME_DEPTH);
	for (const r of repos) {
		const gd = await gitDirOf(r);
		const m = latestWorktreeMtimeMs(r.path, gd);
		if (m !== null && (newest === null || m > newest)) newest = m;
		if (gd) {
			const logs = await latestTreeMtimeMs(path.join(gd, 'logs'), WORKTREE_JANITOR_CONSTANTS.SCRATCH_MTIME_DEPTH);
			if (logs !== null && (newest === null || logs > newest)) newest = logs;
		}
	}
	const idleMs = newest === null ? undefined : Math.max(0, input.now - newest);
	if (idleMs === undefined || idleMs < input.minIdleMs) return keep('recent', undefined, idleMs);

	if (input.busy === null) return keep('cwd-probe-failed', undefined, idleMs);
	const hit = input.busy.find((b) => isPathInside(b.cwd, dir));
	if (hit) return keep(hit.source === 'agent-session' ? 'agent-session-inside' : 'process-inside', hit.cwd, idleMs);

	for (const r of repos) {
		if (r.kind === 'file') {
			const common = await input.git(['-C', r.path, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
			if (common.code !== 0) return keep('git-failed', `${r.path}: ${common.stderr.trim().slice(0, 200)}`, idleMs);
			if (!isPathInside(common.stdout.trim(), dir)) return keep('contains-worktree', r.path, idleMs);
		}
		const status = await input.git(['-C', r.path, 'status', '--porcelain', '--untracked-files=all']);
		if (status.code !== 0) return keep('git-failed', `${r.path}: ${status.stderr.trim().slice(0, 200)}`, idleMs);
		const dirty = status.stdout.split('\n').filter((l) => l.trim() !== '').length;
		if (dirty > 0) return keep('dirty', `${r.path}: ${dirty} changed/untracked path(s)`, idleMs);

		const remotes = await input.git(['-C', r.path, 'remote']);
		if (remotes.code !== 0) return keep('git-failed', `${r.path}: ${remotes.stderr.trim().slice(0, 200)}`, idleMs);
		if (remotes.stdout.trim() === '') return keep('no-remote', r.path, idleMs);

		const unpushed = await input.git(['-C', r.path, 'rev-list', '--max-count=1', 'HEAD', '--branches', '--not', '--remotes']);
		if (unpushed.code !== 0) return keep('git-failed', `${r.path}: ${unpushed.stderr.trim().slice(0, 200)}`, idleMs);
		if (unpushed.stdout.trim() !== '') return keep('unpushed', `${r.path}: commit ${unpushed.stdout.trim().slice(0, 12)} is on no remote`, idleMs);

		const stash = await input.git(['-C', r.path, 'rev-parse', '--verify', '--quiet', 'refs/stash']);
		if (stash.code === 0) return keep('stash', r.path, idleMs);

		const wts = await input.git(['-C', r.path, 'worktree', 'list', '--porcelain']);
		if (wts.code !== 0) return keep('git-failed', `${r.path}: ${wts.stderr.trim().slice(0, 200)}`, idleMs);
		const external = parsePorcelainWorktrees(wts.stdout).find(
			(w) => !w.isMain && !w.prunable && fs.existsSync(w.path) && !isPathInside(w.path, dir),
		);
		if (external) return keep('has-external-worktrees', `${r.path} → ${external.path}`, idleMs);
	}
	return { ...base, decision: 'remove', reason: 'stale', idleMs };
}

/**
 * One sweep over every session dir of every root. Never throws.
 *
 * @param input - Roots, busy cwds, clock, threshold, dry-run flag, git runner
 * @returns Per-dir verdicts and totals
 */
export async function sweepScratch(input: ScratchSweepInput): Promise<ScratchSweepSummary> {
	const summary: ScratchSweepSummary = {
		roots: input.roots.map(canonicalPath),
		removed: 0,
		wouldRemove: 0,
		kept: 0,
		freedBytes: 0,
		keptReasons: {},
		sessions: [],
	};
	const sizeOf = input.sizeOf ?? diskUsageBytes;
	for (const root of summary.roots) {
		for (const dir of await listSessionDirs(root)) {
			let v: ScratchVerdict;
			try {
				v = await evaluateSessionDir(dir, input);
			} catch (err) {
				v = { path: dir, decision: 'keep', reason: 'git-failed', detail: err instanceof Error ? err.message : String(err), repos: [], removed: false };
			}
			if (v.decision === 'remove' && !input.dryRun) await removeSessionDir(root, v, sizeOf);
			summary.sessions.push(v);
			if (v.removed) {
				summary.removed++;
				summary.freedBytes += v.freedBytes ?? 0;
			} else if (input.dryRun && v.decision === 'remove') summary.wouldRemove++;
			else {
				summary.kept++;
				const key = v.error ? 'remove-failed' : v.reason;
				summary.keptReasons[key] = (summary.keptReasons[key] ?? 0) + 1;
			}
		}
	}
	return summary;
}

/** Delete one session dir after re-checking it is a real dir inside its root. */
async function removeSessionDir(root: string, v: ScratchVerdict, sizeOf: (p: string) => Promise<number | null>): Promise<void> {
	try {
		const st = await fs.promises.lstat(v.path);
		if (!st.isDirectory() || st.isSymbolicLink() || !(await fs.promises.realpath(v.path)).startsWith(root + path.sep)) {
			v.error = 'not a real directory inside the scratch root';
			return;
		}
		const size = await sizeOf(v.path);
		// fs.rm removes symlinks themselves, never their targets.
		await fs.promises.rm(v.path, { recursive: true, force: true });
		v.removed = true;
		if (size !== null) v.freedBytes = size;
	} catch (err) {
		v.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
	}
}
