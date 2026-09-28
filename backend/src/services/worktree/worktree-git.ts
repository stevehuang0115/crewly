/**
 * Git primitives for per-WorkItem worktrees (#814).
 *
 * Every check that gates a destructive operation (the dirty check, the
 * "landed" check) reports what it examined and returns a three-way state.
 * `unknown` is never treated as safe: a git command that failed, a path that
 * is not a worktree root, or a worktree with zero tracked files all read as
 * `unknown`, never `clean` (norm-guard-reports-what-it-examined; the
 * 2026-08-21 worktree incident, where a check that examined nothing declared
 * unmerged work safe to delete).
 *
 * All git calls go through `execFile` (no shell), so paths are never
 * word-split or glob-expanded.
 *
 * @module services/worktree/worktree-git
 */

import path from 'path';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import { WORKTREE_CONSTANTS } from '../../constants.js';

/**
 * SHA-256 of a file's content, or null when it cannot be read (removed,
 * permissions). Used to tell an edited `.worktreeinclude` copy from an
 * untouched one — the copy is untracked, so `git status` never sees it.
 *
 * @param p - Absolute file path
 */
async function hashFile(p: string): Promise<string | null> {
	try {
		return createHash('sha256').update(await fs.readFile(p)).digest('hex');
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

/** Result of one git invocation. */
export interface GitResult {
	/** Exit code 0. */
	ok: boolean;
	/** Exit code (-1 when git could not be started or timed out). */
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Run git with arguments in a directory. Never throws.
 *
 * @param cwd - Working directory
 * @param args - Arguments (no shell parsing)
 * @param timeoutMs - Kill after this long
 * @returns Exit code and output
 */
export function runGit(cwd: string, args: string[], timeoutMs: number = WORKTREE_CONSTANTS.GIT_TIMEOUT_MS): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			'git',
			args,
			{
				cwd,
				timeout: timeoutMs,
				maxBuffer: 64 * 1024 * 1024,
				// Never prompt for credentials (ls-remote offline must fail fast, not hang).
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
			},
			(err, stdout, stderr) => {
				const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
				resolve({ ok: !err, code, stdout: String(stdout), stderr: String(stderr) });
			},
		);
	});
}

/** Resolve symlinks when the path exists; otherwise normalise it. */
async function realpathOrResolve(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return path.resolve(p);
	}
}

// ---------------------------------------------------------------------------
// Repo facts
// ---------------------------------------------------------------------------

/**
 * The repository root containing `dir`, or null when `dir` is not in a git
 * work tree (or git is unavailable).
 *
 * @param dir - Any directory
 * @returns Absolute, symlink-resolved repo root, or null
 */
export async function getRepoRoot(dir: string): Promise<string | null> {
	const r = await runGit(dir, ['rev-parse', '--show-toplevel']);
	if (!r.ok || !r.stdout.trim()) return null;
	return realpathOrResolve(r.stdout.trim());
}

/** A resolved base for a new worktree. */
export interface BaseRef {
	/** What it was resolved from, e.g. `origin/main` or `HEAD`. */
	name: string;
	/** Commit the worktree branch starts at. */
	sha: string;
}

/**
 * The base a new worktree branches from.
 *
 * `preferredBranch` (e.g. `wi/<workerId>` for a verify/retry/review
 * WorkItem's own worktree) is tried FIRST when given and it resolves — a
 * verifier must see the worker's own commits, including ones never pushed
 * to `origin`, not a snapshot of `origin/main` from before the worker even
 * started (#829 review). Falls back to the remote default branch
 * (`origin/HEAD` → e.g. `origin/main`) when known, else the repo's HEAD.
 *
 * @param repo - Repo root
 * @param preferredBranch - Tried before the normal fallback chain, when given
 * @returns The base, or null when nothing resolves
 */
export async function resolveBaseRef(repo: string, preferredBranch?: string): Promise<BaseRef | null> {
	const remoteHead = await runGit(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
	const fallback = remoteHead.ok && remoteHead.stdout.trim() ? [remoteHead.stdout.trim(), 'HEAD'] : ['HEAD'];
	const candidates = preferredBranch ? [preferredBranch, ...fallback] : fallback;
	for (const name of candidates) {
		const sha = await runGit(repo, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]);
		if (sha.ok && sha.stdout.trim()) return { name, sha: sha.stdout.trim() };
	}
	return null;
}

/**
 * Whether a local branch exists.
 *
 * @param repo - Repo root
 * @param branch - Short branch name
 * @returns true when `refs/heads/<branch>` resolves
 */
export async function branchExists(repo: string, branch: string): Promise<boolean> {
	return (await runGit(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
}

/**
 * A WorkItem id, made safe as a git ref component and a path segment.
 *
 * A verify/retry/review WorkItem's id contains ':' (e.g. `abc:verify:def`),
 * which `git check-ref-format` rejects — `git worktree add -b wi/abc:verify:def`
 * fails outright, so that WorkItem would silently get no worktree at all.
 * Replaces every character git disallows in a ref component (control chars,
 * space, `~^:?*[\`), collapses a leading/trailing `.` or `/` and a `..` run
 * (also disallowed), and guards the empty-string and lone-`@` edge cases.
 *
 * @param id - Raw WorkItem id
 * @returns A string safe to use for both the branch name and the worktree path
 */
export function sanitizeWorktreeId(id: string): string {
	const cleaned = id
		.replace(/[\x00-\x1f\x7f\s~^:?*[\\]/g, '-')
		.replace(/@\{/g, '-')
		.replace(/\.\.+/g, '-')
		.replace(/^[./]+|[./]+$/g, '')
		.replace(/\.lock$/, '-lock');
	return cleaned && cleaned !== '@' ? cleaned : `wi-${id.length}`;
}

/**
 * Registered worktree paths of a repo (`git worktree list --porcelain`),
 * symlink-resolved, excluding the main checkout.
 *
 * @param repo - Repo root
 * @returns Paths, or null when the listing could not be read
 */
export async function listWorktrees(repo: string): Promise<string[] | null> {
	const r = await runGit(repo, ['worktree', 'list', '--porcelain']);
	if (!r.ok) return null;
	const paths = r.stdout
		.split('\n')
		.filter((l) => l.startsWith('worktree '))
		.map((l) => l.slice('worktree '.length).trim());
	const resolved = await Promise.all(paths.map(realpathOrResolve));
	const root = await realpathOrResolve(repo);
	return resolved.filter((p) => p !== root);
}

// ---------------------------------------------------------------------------
// Shared paths: .worktreeinclude copies and heavy-dir symlinks
// ---------------------------------------------------------------------------

/** Result of reading `.worktreeinclude`. */
export interface IncludeList {
	/** Accepted repo-relative literal paths. */
	entries: string[];
	/** Lines refused (glob, absolute, `..`), with why. */
	rejected: Array<{ line: string; reason: string }>;
	/** Entries dropped by the cap. */
	truncated: number;
}

/**
 * Read the repo-root `.worktreeinclude`: one literal repo-relative path per
 * line; blank lines and `#` comments ignored; globs, absolute paths and `..`
 * segments refused; at most `INCLUDE_MAX_ENTRIES` honoured.
 *
 * @param repo - Repo root
 * @returns Accepted entries and what was refused
 */
export async function readIncludeFile(repo: string): Promise<IncludeList> {
	const out: IncludeList = { entries: [], rejected: [], truncated: 0 };
	let raw: string;
	try {
		raw = await fs.readFile(path.join(repo, WORKTREE_CONSTANTS.INCLUDE_FILE), 'utf8');
	} catch {
		return out;
	}
	for (const line of raw.split(/\r?\n/).map((l) => l.trim())) {
		if (!line || line.startsWith('#')) continue;
		const rel = line.replace(/\\/g, '/').replace(/\/+$/, '');
		let reason: string | null = null;
		if (/[*?[\]{}]/.test(rel)) reason = 'globs are not allowed (literal paths only)';
		else if (path.isAbsolute(rel) || rel.startsWith('/')) reason = 'absolute paths are not allowed';
		else if (rel.split('/').some((seg) => seg === '..' || seg === '.git')) reason = '".." and ".git" segments are not allowed';
		if (reason) {
			out.rejected.push({ line, reason });
			continue;
		}
		if (out.entries.length >= WORKTREE_CONSTANTS.INCLUDE_MAX_ENTRIES) {
			out.truncated += 1;
			continue;
		}
		if (!out.entries.includes(rel)) out.entries.push(rel);
	}
	return out;
}

/** Whether git tracks anything at or under a repo-relative path. `null` = could not tell. */
async function isTracked(repo: string, rel: string): Promise<boolean | null> {
	const r = await runGit(repo, ['ls-files', '-z', '--', rel]);
	if (!r.ok) return null;
	return r.stdout.length > 0;
}

/** What {@link applySharedPaths} did. */
export interface SharedPathsResult {
	/** Repo-relative paths symlinked into the worktree (ours to remove). */
	symlinks: string[];
	/** Repo-relative files copied from `.worktreeinclude` (ours to remove). */
	copies: string[];
	/**
	 * SHA-256 of each copy's content right after copying, keyed by its
	 * repo-relative path — the baseline {@link checkDirty} and
	 * {@link removeWorktree} compare against, so an agent's own edit to a
	 * copy (e.g. `.env`) is never silently deleted as "just our copy".
	 */
	copyHashes: Record<string, string>;
	/** Paths not applied, with why. */
	skipped: Array<{ path: string; reason: string }>;
}

/**
 * Symlink heavy directories and copy `.worktreeinclude` files from the repo
 * root into a new worktree. A path is applied only when it exists in the
 * repo, git tracks nothing under it (a repo that commits `node_modules`
 * gets the real checkout, never a symlink), and it does not already exist
 * in the worktree. Every applied path is then added to the repo's
 * `info/exclude` as a rooted pattern, so it can never be committed from the
 * worktree even in a repo whose `.gitignore` does not cover it.
 *
 * @param repo - Repo root
 * @param worktree - New worktree path
 * @param sharedDirs - Repo-relative directories to symlink
 * @param includes - Repo-relative files to copy
 * @returns What was symlinked, copied and skipped
 */
export async function applySharedPaths(repo: string, worktree: string, sharedDirs: readonly string[], includes: readonly string[]): Promise<SharedPathsResult> {
	const result: SharedPathsResult = { symlinks: [], copies: [], copyHashes: {}, skipped: [] };
	const apply = async (rel: string, kind: 'symlink' | 'copy'): Promise<void> => {
		const src = path.join(repo, rel);
		const dest = path.join(worktree, rel);
		let stat;
		try {
			stat = await fs.stat(src);
		} catch {
			result.skipped.push({ path: rel, reason: 'not present in the repo' });
			return;
		}
		if (kind === 'symlink' && !stat.isDirectory()) {
			result.skipped.push({ path: rel, reason: 'not a directory' });
			return;
		}
		if (kind === 'copy' && !stat.isFile()) {
			result.skipped.push({ path: rel, reason: 'not a regular file' });
			return;
		}
		const tracked = await isTracked(repo, rel);
		if (tracked !== false) {
			result.skipped.push({ path: rel, reason: tracked ? 'tracked by git (checked out, not shared)' : 'could not tell whether git tracks it' });
			return;
		}
		try {
			await fs.lstat(dest);
			result.skipped.push({ path: rel, reason: 'already exists in the worktree' });
			return;
		} catch {
			// absent — good
		}
		await fs.mkdir(path.dirname(dest), { recursive: true });
		if (kind === 'symlink') {
			await fs.symlink(src, dest, 'dir');
			result.symlinks.push(rel);
		} else {
			await fs.copyFile(src, dest);
			result.copies.push(rel);
			const hash = await hashFile(dest);
			if (hash) result.copyHashes[rel] = hash;
		}
	};
	for (const dir of sharedDirs) await apply(dir.replace(/\\/g, '/').replace(/\/+$/, ''), 'symlink');
	for (const file of includes) await apply(file, 'copy');
	await ensureExcluded(repo, [...result.symlinks, ...result.copies]);
	return result;
}

/**
 * Add rooted patterns (`/node_modules`, no trailing slash, so a symlink
 * matches too) to the repo's shared `info/exclude` under a marker line.
 * Idempotent. Exclude rules never affect tracked files.
 *
 * @param repo - Repo root
 * @param rels - Repo-relative paths
 */
export async function ensureExcluded(repo: string, rels: readonly string[]): Promise<void> {
	if (rels.length === 0) return;
	const common = await runGit(repo, ['rev-parse', '--git-common-dir']);
	if (!common.ok) throw new Error(`cannot locate the git dir of ${repo}: ${common.stderr.trim()}`);
	const file = path.join(path.resolve(repo, common.stdout.trim()), 'info', 'exclude');
	let current = '';
	try {
		current = await fs.readFile(file, 'utf8');
	} catch {
		// no exclude file yet
	}
	const lines = current.split('\n');
	const wanted = rels.map((r) => `/${r}`).filter((p) => !lines.includes(p));
	if (wanted.length === 0) return;
	const add = [...(lines.includes(WORKTREE_CONSTANTS.EXCLUDE_MARKER) ? [] : [WORKTREE_CONSTANTS.EXCLUDE_MARKER]), ...wanted];
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Guards: dirty check and landed check
// ---------------------------------------------------------------------------

/** Paths this feature created in a worktree (the only ones a check may exclude). */
export interface OwnedPaths {
	symlinks: readonly string[];
	copies: readonly string[];
	/**
	 * SHA-256 of each copy's content as applied ({@link SharedPathsResult.copyHashes}).
	 * A copy whose current content no longer matches is an agent's edit, not
	 * "just our copy" — {@link checkDirty} flags it, {@link removeWorktree}
	 * refuses to delete it. Absent (older manifests, or a copy this map has
	 * no entry for) falls back to the pre-#829-review behaviour: existence
	 * alone excludes it.
	 */
	copyHashes?: Readonly<Record<string, string>>;
}

/**
 * Repo-relative paths this feature added to the repo's shared
 * `info/exclude` (the lines under {@link WORKTREE_CONSTANTS.EXCLUDE_MARKER}),
 * minus the worktree directory itself.
 *
 * @param dir - Any directory in the repo or one of its worktrees
 * @returns Paths without the leading slash (empty when none / unreadable)
 */
export async function readOwnExcludePatterns(dir: string): Promise<string[]> {
	const common = await runGit(dir, ['rev-parse', '--git-common-dir']);
	if (!common.ok) return [];
	let text: string;
	try {
		text = await fs.readFile(path.join(path.resolve(dir, common.stdout.trim()), 'info', 'exclude'), 'utf8');
	} catch {
		return [];
	}
	const lines = text.split('\n');
	const start = lines.indexOf(WORKTREE_CONSTANTS.EXCLUDE_MARKER);
	if (start < 0) return [];
	const out: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (!line.startsWith('/')) continue;
		const rel = line.slice(1);
		if (rel && rel !== WORKTREE_CONSTANTS.DIR) out.push(rel);
	}
	return out;
}

/** Outcome of {@link checkDirty}. */
export interface DirtyReport {
	state: 'clean' | 'dirty' | 'unknown';
	/** Tracked files + status entries looked at. */
	examined: number;
	/** Our own symlinks/copies verified and excluded. */
	excludedOurs: number;
	/** Paths that make the worktree dirty. */
	dirtyPaths: string[];
	/** Why the state is unknown (when it is). */
	reason?: string;
	/** One-line human summary: "N path(s) examined, M excluded as ours, K dirty". */
	summary: string;
}

/** Parse `git status --porcelain=v1 -z` into paths (renames yield both). */
function parsePorcelainZ(out: string): string[] {
	const parts = out.split('\0').filter((p) => p.length > 0);
	const paths: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		const xy = entry.slice(0, 2);
		paths.push(entry.slice(3));
		if (xy[0] === 'R' || xy[0] === 'C') {
			i += 1; // the next NUL-separated field is the rename source
			if (parts[i] !== undefined) paths.push(parts[i]);
		}
	}
	return paths;
}

/**
 * Is a worktree safe to remove as far as uncommitted work goes?
 *
 * - The path must be a worktree ROOT (so git never answers for a parent repo).
 * - It must have at least one tracked file (an empty examination is not "clean").
 * - `git status` must succeed; its entries, minus EXACTLY the recorded owned
 *   paths, must be empty.
 * - Each owned symlink must still be a symlink; one replaced by real content
 *   counts as dirty.
 *
 * @param worktree - Worktree path
 * @param owned - Symlinks/copies recorded at creation
 * @returns clean / dirty / unknown, with counts
 */
export async function checkDirty(worktree: string, owned: OwnedPaths): Promise<DirtyReport> {
	const unknown = (reason: string, examined = 0): DirtyReport => ({
		state: 'unknown',
		examined,
		excludedOurs: 0,
		dirtyPaths: [],
		reason,
		summary: `UNKNOWN (${reason}) — ${examined} path(s) examined; treated as NOT safe`,
	});

	let wtReal: string;
	try {
		wtReal = await fs.realpath(worktree);
	} catch {
		return unknown('worktree path does not exist');
	}
	const top = await runGit(wtReal, ['rev-parse', '--show-toplevel']);
	if (!top.ok || (await realpathOrResolve(top.stdout.trim())) !== wtReal) {
		return unknown('path is not a worktree root');
	}
	const tracked = await runGit(wtReal, ['ls-files', '-z']);
	if (!tracked.ok) return unknown('git ls-files failed');
	const trackedCount = tracked.stdout.split('\0').filter(Boolean).length;
	if (trackedCount === 0) return unknown('0 tracked files examined');
	const status = await runGit(wtReal, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
	if (!status.ok) return unknown(`git status failed: ${status.stderr.trim()}`, trackedCount);

	const ownedSet = new Set([...owned.symlinks, ...owned.copies]);
	const entries = parsePorcelainZ(status.stdout);
	const dirty = entries.filter((p) => !ownedSet.has(p.replace(/\/$/, '')));

	// The shared .git/info/exclude hides every path ANY worktree of this repo
	// registered (e.g. /node_modules, /.env). In THIS worktree such a path is
	// only ours if it was recorded here; otherwise it is the agent's content
	// that plain `git status` would never show. List ignored entries and flag
	// the ones under our exclude patterns that this worktree did not record.
	const ourPatterns = await readOwnExcludePatterns(wtReal);
	let hiddenChecked = 0;
	if (ourPatterns.length) {
		const ignored = await runGit(wtReal, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
		if (!ignored.ok) return unknown(`git status --ignored failed: ${ignored.stderr.trim()}`, trackedCount + entries.length);
		for (const raw of ignored.stdout.split('\0')) {
			if (!raw.startsWith('!! ')) continue;
			const p = raw.slice(3).replace(/\/$/, '');
			const pattern = ourPatterns.find((q) => p === q || p.startsWith(`${q}/`));
			if (!pattern) continue;
			hiddenChecked += 1;
			if (!ownedSet.has(pattern)) dirty.push(`${p} (hidden by the shared worktree exclude; not recorded for this worktree)`);
		}
	}
	let excludedOurs = 0;
	for (const rel of owned.symlinks) {
		try {
			const st = await fs.lstat(path.join(wtReal, rel));
			if (st.isSymbolicLink()) excludedOurs += 1;
			else dirty.push(`${rel} (was our symlink; now real content)`);
		} catch {
			// removed by the agent: nothing to lose
		}
	}
	for (const rel of owned.copies) {
		const dest = path.join(wtReal, rel);
		let exists = true;
		try {
			await fs.lstat(dest);
		} catch {
			exists = false; // removed: nothing to lose
		}
		if (!exists) continue;
		const recordedHash = owned.copyHashes?.[rel];
		if (recordedHash) {
			const currentHash = await hashFile(dest);
			if (currentHash !== recordedHash) {
				dirty.push(`${rel} (was our copy; content edited since)`);
				continue;
			}
		}
		excludedOurs += 1;
	}
	const examined = trackedCount + entries.length + hiddenChecked;
	return {
		state: dirty.length ? 'dirty' : 'clean',
		examined,
		excludedOurs,
		dirtyPaths: dirty,
		summary: `${examined} path(s) examined, ${excludedOurs} excluded as our symlinks/copies, ${dirty.length} dirty`,
	};
}

/** Outcome of {@link checkLanded}. */
export interface LandedReport {
	state: 'landed' | 'not_landed' | 'unknown';
	/** The worktree HEAD commit checked. */
	tip?: string;
	/** How it was established (or why it could not be). */
	detail: string;
}

/**
 * Are the worktree's commits safe elsewhere? "Landed" means the HEAD commit
 * is an ancestor of the branch's upstream or of the base ref, OR it is the
 * tip of some ref on `origin` (`git ls-remote`). When neither can be
 * established — e.g. offline and not merged locally — the answer is
 * `unknown`, which callers must treat as "keep".
 *
 * @param worktree - Worktree path
 * @param baseRefName - The base recorded at creation (e.g. `origin/main`)
 * @returns landed / not_landed / unknown
 */
export async function checkLanded(worktree: string, baseRefName: string): Promise<LandedReport> {
	const head = await runGit(worktree, ['rev-parse', '--verify', 'HEAD']);
	if (!head.ok) return { state: 'unknown', detail: 'cannot resolve HEAD' };
	const tip = head.stdout.trim();

	const upstream = await runGit(worktree, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
	const targets = [...new Set([upstream.ok ? upstream.stdout.trim() : '', baseRefName].filter(Boolean))];
	let ancestorErrors = 0;
	for (const target of targets) {
		const r = await runGit(worktree, ['merge-base', '--is-ancestor', tip, target]);
		if (r.ok) return { state: 'landed', tip, detail: `HEAD is an ancestor of ${target}` };
		if (r.code !== 1) ancestorErrors += 1; // 1 = "not an ancestor"; anything else = could not tell
	}

	const remote = await runGit(worktree, ['ls-remote', 'origin'], WORKTREE_CONSTANTS.REMOTE_TIMEOUT_MS);
	if (remote.ok) {
		if (remote.stdout.split('\n').some((l) => l.split('\t')[0] === tip)) {
			return { state: 'landed', tip, detail: 'HEAD is the tip of a ref on origin' };
		}
		if (ancestorErrors === 0) return { state: 'not_landed', tip, detail: `not merged into ${targets.join(' / ')} and not on origin` };
	}
	return { state: 'unknown', tip, detail: remote.ok ? 'ancestry could not be determined' : 'origin unreachable and not merged locally' };
}

/**
 * Commits on the worktree HEAD beyond a base commit.
 *
 * @param worktree - Worktree path
 * @param baseSha - Base commit
 * @returns Count, or null when it could not be determined
 */
export async function commitsBeyond(worktree: string, baseSha: string): Promise<number | null> {
	const r = await runGit(worktree, ['rev-list', '--count', `${baseSha}..HEAD`]);
	if (!r.ok) return null;
	const n = Number.parseInt(r.stdout.trim(), 10);
	return Number.isFinite(n) ? n : null;
}

/**
 * Remove our own symlinks/copies, then `git worktree remove` WITHOUT force.
 *
 * Callers must have run {@link checkDirty} first (the primary guard). This
 * is a second line of defence specifically for a `.worktreeinclude` copy:
 * unlike an ordinary untracked file, a copy is deliberately added to
 * `info/exclude` (so an UNTOUCHED one never blocks a normal removal) — which
 * means git's own dirty check for `worktree remove` does not see an EDITED
 * one either (git's worktree-remove check, like `git status`, does not
 * count ignored files). So git refusing on its own is not a safe backstop
 * here the way it is for a plain untracked file; this function checks every
 * copy's content BEFORE touching anything, and refuses outright, leaving
 * the whole worktree untouched, if any changed.
 *
 * @param repo - Repo root
 * @param worktree - Worktree path
 * @param owned - Paths this feature created
 * @returns git's result, or a synthetic failure when an edited copy blocked it
 */
export async function removeWorktree(repo: string, worktree: string, owned: OwnedPaths): Promise<GitResult> {
	for (const rel of owned.copies) {
		const p = path.join(worktree, rel);
		let isFile = false;
		try {
			isFile = (await fs.lstat(p)).isFile();
		} catch {
			continue; // already gone — nothing to lose
		}
		if (!isFile) continue;
		const recordedHash = owned.copyHashes?.[rel];
		if (recordedHash && (await hashFile(p)) !== recordedHash) {
			return { ok: false, code: -1, stdout: '', stderr: `refusing to remove: ${rel} was our copy but its content was edited since` };
		}
	}
	for (const rel of owned.symlinks) {
		const p = path.join(worktree, rel);
		try {
			if ((await fs.lstat(p)).isSymbolicLink()) await fs.unlink(p);
		} catch {
			// already gone
		}
	}
	for (const rel of owned.copies) {
		await fs.unlink(path.join(worktree, rel)).catch(() => undefined);
	}
	return runGit(repo, ['worktree', 'remove', worktree]);
}
