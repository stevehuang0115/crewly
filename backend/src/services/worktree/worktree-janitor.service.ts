/**
 * Worktree janitor — removes git worktrees whose work has landed.
 *
 * Agents create a worktree per code task (`<repo>/.claude/worktrees/<name>`,
 * `/tmp/crewly-worktrees/<session>-<slug>`) and never delete it; a busy Mac
 * collected 30+ of them, tens of GB. Owner decision: once the PR is merged the
 * worktree goes away by itself.
 *
 * ## Which repos
 * Every registered project path (projects store) that is inside a git repo,
 * plus the Crewly package root when it is a dev checkout. Repos are
 * de-duplicated by their main worktree.
 *
 * ## Removal rules — a worktree is removed only when ALL hold
 * 1. It is not the main worktree, not bare, and not `prunable` (a missing
 *    directory is left to `git worktree prune`).
 * 2. It is not locked (`git worktree lock`; Claude Code locks the worktree of
 *    a running subagent).
 * 3. It is not under `<repo>/.crewly/worktrees/` — that directory belongs to
 *    the per-WorkItem worktree feature (#814), which does its own
 *    WorkItem-aware cleanup.
 * 4. It is an agent worktree: its path is under `<main>/.claude/worktrees/`
 *    or `<tmp>/crewly-worktrees/` (`/tmp` and `os.tmpdir()`), OR its branch
 *    starts with an agent-only prefix (`worktree-agent-`, Claude Code's
 *    automatic subagent branch). Human-made worktrees such as
 *    `../crewly-wt-805` on `fix/...` are never touched. Deliberately narrow:
 *    a false "keep" costs disk, a false "remove" costs work.
 * 5. Nothing is working in it: no Crewly agent session was started in it and
 *    no process of this user (PTY shells, runtimes, editors, test runners)
 *    has its cwd inside it. If the process probe fails, everything is kept.
 * 6. It was last touched more than 2 hours ago (newest mtime of the
 *    directory and its git dir's index / HEAD / logs/HEAD).
 * 7. `git status --porcelain --untracked-files=all` is empty: no tracked
 *    change and no untracked file. Ignored files (node_modules, dist) do not
 *    count. A failing status keeps it.
 * 8. Its work has landed: HEAD is an ancestor of `origin/<default branch>`
 *    after a quiet `git fetch` (fetch errors ignored), OR — when `gh` is
 *    installed and authenticated — a MERGED PR has this branch as head AND
 *    its head commit equals the worktree HEAD (squash merges; commits made
 *    after the merge keep the worktree).
 *
 * ## Removal
 * `git worktree remove <path>` without `--force`. If git refuses although
 * the status is still clean (only ignored output left) and the worktree has
 * no submodules, it is retried once with `--force`. Then the local branch is
 * deleted (never a protected name), and `git worktree prune` runs per repo.
 *
 * Runs every 30 minutes (first run 10 minutes after boot). Kill switch:
 * `CREWLY_WORKTREE_JANITOR=0`. Never throws; logs one summary line per run.
 *
 * @module services/worktree/worktree-janitor.service
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WORKTREE_JANITOR_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import {
	canonicalPath,
	isJanitorDisabled,
	isPathInside,
	latestWorktreeMtimeMs,
	listProcessCwds,
	parsePorcelainWorktrees,
	runCommand,
	type CommandResult,
	type PorcelainWorktree,
	type RunCommandOptions,
} from './worktree-janitor.git.js';

/** Why a worktree is kept, or why it may go. */
export type WorktreeReason =
	| 'main-worktree'
	| 'bare'
	| 'prunable'
	| 'locked'
	| 'managed-by-workitem-worktrees'
	| 'not-agent-worktree'
	| 'agent-session-inside'
	| 'process-inside'
	| 'cwd-probe-failed'
	| 'recent'
	| 'dirty'
	| 'status-failed'
	| 'not-merged'
	| 'merged'
	| 'pr-merged';

/** Verdict for one worktree (the dry-run output). */
export interface WorktreeVerdict {
	/** Main worktree of the repo this worktree belongs to */
	repo: string;
	/** Worktree path */
	path: string;
	/** Branch, or null when detached */
	branch: string | null;
	/** HEAD commit */
	head: string | null;
	/** What the janitor would do */
	decision: 'remove' | 'keep';
	/** The deciding rule */
	reason: WorktreeReason;
	/** Human-readable detail (lock reason, dirty file count, PR number, …) */
	detail?: string;
	/** Ms since last touched, when computed */
	idleMs?: number;
}

/** Outcome of acting on one verdict. */
export interface WorktreeOutcome extends WorktreeVerdict {
	/** True when the worktree directory was removed */
	removed: boolean;
	/** True when `--force` was needed (only ignored files were in the way) */
	forced: boolean;
	/** True when the local branch was deleted */
	branchDeleted: boolean;
	/** Error text when removal failed (the worktree is then counted as kept) */
	error?: string;
}

/** Result of one janitor pass. */
export interface JanitorRunSummary {
	/** ISO start time */
	startedAt: string;
	/** Duration in ms */
	durationMs: number;
	/** True when the kill switch stopped the pass */
	disabled: boolean;
	/** True when this was a dry run (nothing removed) */
	dryRun: boolean;
	/** Repos (main worktrees) examined */
	repos: string[];
	/** Worktrees removed */
	removed: number;
	/** Dry run only: worktrees a real pass would remove */
	wouldRemove: number;
	/** Worktrees kept */
	kept: number;
	/** Kept worktrees by reason (removal failures under `remove-failed`) */
	keptReasons: Record<string, number>;
	/** Per-worktree results */
	worktrees: WorktreeOutcome[];
}

/** A place a live process or agent is working in. */
export interface BusyCwd {
	/** Absolute directory */
	cwd: string;
	/** `agent-session` for Crewly sessions, `process` for anything else */
	source: 'agent-session' | 'process';
}

/** Minimal logger surface (a ComponentLogger fits). */
export interface JanitorLogger {
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
}

/** Injectable dependencies (defaults talk to the real backend). */
export interface WorktreeJanitorOptions {
	/** Candidate repo/project paths (default: projects store + dev checkout) */
	listRepoPaths?: () => Promise<string[]>;
	/** Where Crewly agents and processes are working; null = probe failed (default: sessions + lsof) */
	listBusyCwds?: () => Promise<BusyCwd[] | null>;
	/** git executable (default `git`) */
	gitBin?: string;
	/** gh executable (default `gh`); set to null to never use gh */
	ghBin?: string | null;
	/** Clock (default Date.now) */
	now?: () => number;
	/** Minimum idle time before removal (default 2 h) */
	minIdleMs?: number;
	/** Temp roots whose `crewly-worktrees/` holds agent worktrees (default `/tmp` + os.tmpdir()) */
	tmpRoots?: string[];
	/** Environment for the kill switch (default process.env) */
	env?: NodeJS.ProcessEnv;
	/** Logger (default: component logger `WorktreeJanitor`) */
	logger?: JanitorLogger;
}

/** Per-repo context built lazily during a pass. */
interface RepoContext {
	main: string;
	entries: PorcelainWorktree[];
	fetched: boolean;
	defaultRef: string | null | undefined;
}

/**
 * Periodic cleaner of finished agent worktrees. See the module JSDoc for the
 * exact rules.
 *
 * @example
 * ```typescript
 * const janitor = WorktreeJanitorService.getInstance();
 * janitor.start();                 // first pass in 10 min, then every 30 min
 * const plan = await janitor.plan(); // dry run: verdict per worktree
 * const summary = await janitor.run(); // one real pass now
 * ```
 */
export class WorktreeJanitorService {
	private static instance: WorktreeJanitorService | null = null;

	private readonly opts: WorktreeJanitorOptions;
	private firstRunTimer: NodeJS.Timeout | null = null;
	private intervalTimer: NodeJS.Timeout | null = null;
	private inFlight: Promise<JanitorRunSummary> | null = null;
	private ghUsable: boolean | undefined;
	private lastSummary: JanitorRunSummary | null = null;
	private loggerInstance: JanitorLogger | null = null;

	/**
	 * @param options - Injectable dependencies; defaults use the live backend
	 */
	constructor(options: WorktreeJanitorOptions = {}) {
		this.opts = options;
	}

	/**
	 * Process-wide instance used by the server and the HTTP routes.
	 *
	 * @returns The singleton
	 */
	static getInstance(): WorktreeJanitorService {
		if (!WorktreeJanitorService.instance) WorktreeJanitorService.instance = new WorktreeJanitorService();
		return WorktreeJanitorService.instance;
	}

	/** Reset the singleton (tests). */
	static resetInstance(): void {
		WorktreeJanitorService.instance?.stop();
		WorktreeJanitorService.instance = null;
	}

	/**
	 * Whether the kill switch is on.
	 *
	 * @returns True when `CREWLY_WORKTREE_JANITOR` disables the janitor
	 */
	isDisabled(): boolean {
		return isJanitorDisabled(this.opts.env ?? process.env);
	}

	/**
	 * Schedule the periodic pass: first after FIRST_RUN_DELAY_MS, then every
	 * INTERVAL_MS. No-op when disabled or already started. Timers are unref'd.
	 *
	 * @returns True when scheduled
	 */
	start(): boolean {
		if (this.isDisabled() || this.firstRunTimer || this.intervalTimer) return false;
		this.firstRunTimer = setTimeout(() => {
			this.firstRunTimer = null;
			void this.run();
			this.intervalTimer = setInterval(() => void this.run(), WORKTREE_JANITOR_CONSTANTS.INTERVAL_MS);
			this.intervalTimer.unref?.();
		}, WORKTREE_JANITOR_CONSTANTS.FIRST_RUN_DELAY_MS);
		this.firstRunTimer.unref?.();
		return true;
	}

	/** Cancel scheduled passes. */
	stop(): void {
		if (this.firstRunTimer) clearTimeout(this.firstRunTimer);
		if (this.intervalTimer) clearInterval(this.intervalTimer);
		this.firstRunTimer = null;
		this.intervalTimer = null;
	}

	/**
	 * Summary of the last completed real pass, if any.
	 *
	 * @returns Last summary or null
	 */
	getLastSummary(): JanitorRunSummary | null {
		return this.lastSummary;
	}

	/**
	 * Dry run: the verdict for every worktree of every known repo. Removes
	 * nothing (it may `git fetch`).
	 *
	 * @returns Summary with per-worktree verdicts
	 */
	async plan(): Promise<JanitorRunSummary> {
		return this.pass(true);
	}

	/**
	 * One real pass. Concurrent calls share the pass in flight. Never throws.
	 * Honours the kill switch.
	 *
	 * @returns Summary of what was removed and kept
	 */
	async run(): Promise<JanitorRunSummary> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.pass(false).finally(() => {
			this.inFlight = null;
		});
		const summary = await this.inFlight;
		if (!summary.dryRun && !summary.disabled) this.lastSummary = summary;
		return summary;
	}

	// ---------------------------------------------------------------------

	private get logger(): JanitorLogger {
		if (this.opts.logger) return this.opts.logger;
		if (!this.loggerInstance) this.loggerInstance = LoggerService.getInstance().createComponentLogger('WorktreeJanitor');
		return this.loggerInstance;
	}

	private git(args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
		return runCommand(this.opts.gitBin ?? 'git', args, options);
	}

	private async pass(dryRun: boolean): Promise<JanitorRunSummary> {
		const started = Date.now();
		const summary: JanitorRunSummary = {
			startedAt: new Date(started).toISOString(),
			durationMs: 0,
			disabled: false,
			dryRun,
			repos: [],
			removed: 0,
			wouldRemove: 0,
			kept: 0,
			keptReasons: {},
			worktrees: [],
		};
		if (!dryRun && this.isDisabled()) {
			summary.disabled = true;
			return summary;
		}
		try {
			this.ghUsable = undefined;
			const repos = await this.resolveRepos();
			summary.repos = repos.map((r) => r.main);
			const busy = await this.safeBusyCwds();
			for (const repo of repos) {
				let removedHere = 0;
				for (const entry of repo.entries) {
					const verdict = await this.evaluate(repo, entry, busy);
					const outcome: WorktreeOutcome = { ...verdict, removed: false, forced: false, branchDeleted: false };
					if (verdict.decision === 'remove' && !dryRun) {
						await this.remove(repo, outcome);
						if (outcome.removed) removedHere++;
					}
					summary.worktrees.push(outcome);
					if (outcome.removed) summary.removed++;
					else if (dryRun && verdict.decision === 'remove') summary.wouldRemove++;
					else {
						summary.kept++;
						const key = outcome.error ? 'remove-failed' : verdict.reason;
						summary.keptReasons[key] = (summary.keptReasons[key] ?? 0) + 1;
					}
				}
				if (!dryRun) {
					const pr = await this.git(['-C', repo.main, 'worktree', 'prune']);
					if (pr.code !== 0 && removedHere > 0) {
						this.logger.warn('git worktree prune failed', { repo: repo.main, error: pr.stderr.trim() });
					}
				}
			}
		} catch (err) {
			this.logger.warn('Worktree janitor pass failed', { error: err instanceof Error ? err.message : String(err) });
		}
		summary.durationMs = Date.now() - started;
		if (!dryRun) {
			const reasons = Object.entries(summary.keptReasons)
				.sort((a, b) => b[1] - a[1])
				.map(([k, v]) => `${k}: ${v}`)
				.join(', ');
			this.logger.info(
				`Worktree janitor: removed ${summary.removed}, kept ${summary.kept}${reasons ? ` (${reasons})` : ''} across ${summary.repos.length} repo(s) in ${summary.durationMs}ms`,
				{ removed: summary.worktrees.filter((w) => w.removed).map((w) => w.path) },
			);
		}
		return summary;
	}

	private async resolveRepos(): Promise<RepoContext[]> {
		const candidates = await (this.opts.listRepoPaths ?? defaultListRepoPaths)().catch(() => [] as string[]);
		const seen = new Map<string, RepoContext>();
		for (const candidate of candidates) {
			if (!candidate || !fs.existsSync(candidate)) continue;
			const r = await this.git(['-C', candidate, 'worktree', 'list', '--porcelain']);
			if (r.code !== 0) continue;
			const entries = parsePorcelainWorktrees(r.stdout);
			const main = entries.find((e) => e.isMain);
			if (!main) continue;
			const key = canonicalPath(main.path);
			if (seen.has(key)) continue;
			seen.set(key, { main: main.path, entries, fetched: false, defaultRef: undefined });
		}
		return [...seen.values()];
	}

	private async safeBusyCwds(): Promise<BusyCwd[] | null> {
		try {
			return await (this.opts.listBusyCwds ?? defaultListBusyCwds)();
		} catch {
			return null;
		}
	}

	private isAgentWorktree(repo: RepoContext, entry: PorcelainWorktree): boolean {
		if (isPathInside(entry.path, path.join(repo.main, WORKTREE_JANITOR_CONSTANTS.AGENT_WORKTREE_DIR))) return true;
		const tmpRoots = this.opts.tmpRoots ?? ['/tmp', os.tmpdir()];
		for (const root of tmpRoots) {
			if (isPathInside(entry.path, path.join(root, WORKTREE_JANITOR_CONSTANTS.TMP_WORKTREE_DIR))) return true;
		}
		const branch = entry.branch;
		return !!branch && WORKTREE_JANITOR_CONSTANTS.AGENT_BRANCH_PREFIXES.some((p) => branch.startsWith(p));
	}

	/**
	 * Apply the removal rules to one worktree (read-only apart from fetch).
	 */
	private async evaluate(repo: RepoContext, entry: PorcelainWorktree, busy: BusyCwd[] | null): Promise<WorktreeVerdict> {
		const base = { repo: repo.main, path: entry.path, branch: entry.branch, head: entry.head };
		const keep = (reason: WorktreeReason, detail?: string, idleMs?: number): WorktreeVerdict => ({
			...base,
			decision: 'keep',
			reason,
			...(detail ? { detail } : {}),
			...(idleMs !== undefined ? { idleMs } : {}),
		});

		if (entry.isMain) return keep('main-worktree');
		if (entry.bare) return keep('bare');
		if (entry.prunable || !fs.existsSync(entry.path)) return keep('prunable', 'directory missing; left to git worktree prune');
		if (entry.locked) return keep('locked', entry.lockReason);
		if (isPathInside(entry.path, path.join(repo.main, WORKTREE_JANITOR_CONSTANTS.MANAGED_WORKTREE_DIR))) {
			return keep('managed-by-workitem-worktrees');
		}
		if (!this.isAgentWorktree(repo, entry)) return keep('not-agent-worktree');

		if (busy === null) return keep('cwd-probe-failed');
		const hit = busy.find((b) => isPathInside(b.cwd, entry.path));
		if (hit) return keep(hit.source === 'agent-session' ? 'agent-session-inside' : 'process-inside', hit.cwd);

		const gitDirR = await this.git(['-C', entry.path, 'rev-parse', '--absolute-git-dir']);
		const gitDir = gitDirR.code === 0 ? gitDirR.stdout.trim() : null;
		const mtime = latestWorktreeMtimeMs(entry.path, gitDir);
		const now = (this.opts.now ?? Date.now)();
		const idleMs = mtime === null ? undefined : Math.max(0, now - mtime);
		const minIdle = this.opts.minIdleMs ?? WORKTREE_JANITOR_CONSTANTS.MIN_IDLE_MS;
		if (idleMs === undefined || idleMs < minIdle) return keep('recent', undefined, idleMs);

		const status = await this.git(['-C', entry.path, 'status', '--porcelain', '--untracked-files=all']);
		if (status.code !== 0) return keep('status-failed', status.stderr.trim().slice(0, 200), idleMs);
		const dirtyLines = status.stdout.split('\n').filter((l) => l.trim() !== '');
		if (dirtyLines.length > 0) return keep('dirty', `${dirtyLines.length} changed/untracked path(s)`, idleMs);

		if (!entry.head) return keep('not-merged', 'no HEAD', idleMs);
		const defaultRef = await this.defaultRef(repo);
		if (defaultRef) {
			const anc = await this.git(['-C', repo.main, 'merge-base', '--is-ancestor', entry.head, defaultRef]);
			if (anc.code === 0) return { ...base, decision: 'remove', reason: 'merged', detail: `HEAD is in ${defaultRef}`, idleMs };
		}
		if (entry.branch) {
			const pr = await this.mergedPrFor(repo, entry.branch, entry.head);
			if (pr !== null) return { ...base, decision: 'remove', reason: 'pr-merged', detail: `PR #${pr} merged`, idleMs };
		}
		return keep('not-merged', defaultRef ? `not in ${defaultRef}, no merged PR` : 'no origin default branch, no merged PR', idleMs);
	}

	/** `origin/<default>` after one quiet fetch per repo per pass; null when there is no origin. */
	private async defaultRef(repo: RepoContext): Promise<string | null> {
		if (repo.defaultRef !== undefined) return repo.defaultRef;
		let ref: string | null = null;
		const sym = await this.git(['-C', repo.main, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
		if (sym.code === 0 && sym.stdout.trim()) ref = sym.stdout.trim();
		if (!ref) {
			for (const name of ['main', 'master']) {
				const v = await this.git(['-C', repo.main, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]);
				if (v.code === 0) {
					ref = `origin/${name}`;
					break;
				}
			}
		}
		if (!ref) {
			const remote = await this.git(['-C', repo.main, 'remote', 'get-url', 'origin']);
			if (remote.code === 0) {
				// origin exists but no remote-tracking ref yet — try one fetch.
				await this.git(['-C', repo.main, 'fetch', '--quiet', 'origin'], { timeoutMs: WORKTREE_JANITOR_CONSTANTS.FETCH_TIMEOUT_MS });
				repo.fetched = true;
				for (const name of ['main', 'master']) {
					const v = await this.git(['-C', repo.main, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]);
					if (v.code === 0) {
						ref = `origin/${name}`;
						break;
					}
				}
			}
		}
		if (ref && !repo.fetched) {
			const branchName = ref.replace(/^origin\//, '');
			// Errors (offline, auth) are ignored: the stale ref is still a safe lower bound.
			await this.git(['-C', repo.main, 'fetch', '--quiet', 'origin', branchName], {
				timeoutMs: WORKTREE_JANITOR_CONSTANTS.FETCH_TIMEOUT_MS,
			});
			repo.fetched = true;
		}
		repo.defaultRef = ref;
		return ref;
	}

	/** Number of a MERGED PR whose head is `branch` at exactly `head`, or null. */
	private async mergedPrFor(repo: RepoContext, branch: string, head: string): Promise<number | null> {
		const gh = this.opts.ghBin === undefined ? 'gh' : this.opts.ghBin;
		if (!gh) return null;
		if (this.ghUsable === undefined) {
			const auth = await runCommand(gh, ['auth', 'status'], { cwd: repo.main, timeoutMs: WORKTREE_JANITOR_CONSTANTS.GH_TIMEOUT_MS });
			this.ghUsable = auth.code === 0;
		}
		if (!this.ghUsable) return null;
		const r = await runCommand(
			gh,
			['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,headRefOid,state', '--limit', String(WORKTREE_JANITOR_CONSTANTS.GH_PR_LIMIT)],
			{ cwd: repo.main, timeoutMs: WORKTREE_JANITOR_CONSTANTS.GH_TIMEOUT_MS },
		);
		if (r.code !== 0) return null;
		try {
			const prs = JSON.parse(r.stdout) as Array<{ number?: unknown; headRefOid?: unknown; state?: unknown }>;
			if (!Array.isArray(prs)) return null;
			const match = prs.find((p) => p.state === 'MERGED' && p.headRefOid === head && typeof p.number === 'number');
			return match ? (match.number as number) : null;
		} catch {
			return null;
		}
	}

	/** Remove one worktree whose verdict is `remove`, then its branch. Never throws. */
	private async remove(repo: RepoContext, outcome: WorktreeOutcome): Promise<void> {
		let r = await this.git(['-C', repo.main, 'worktree', 'remove', outcome.path]);
		if (r.code !== 0) {
			// Force only when git's refusal can only be ignored output: status is
			// still clean (untracked included) and there are no submodules.
			const status = await this.git(['-C', outcome.path, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);
			const clean = status.code === 0 && status.stdout.trim() === '';
			const hasSubmodules = fs.existsSync(path.join(outcome.path, '.gitmodules'));
			if (clean && !hasSubmodules) {
				r = await this.git(['-C', repo.main, 'worktree', 'remove', '--force', outcome.path]);
				if (r.code === 0) outcome.forced = true;
			}
		}
		if (r.code !== 0) {
			outcome.error = (r.stderr || 'git worktree remove failed').trim().slice(0, 300);
			return;
		}
		outcome.removed = true;
		const branch = outcome.branch;
		if (!branch || WORKTREE_JANITOR_CONSTANTS.PROTECTED_BRANCHES.includes(branch)) return;
		if (repo.defaultRef && branch === repo.defaultRef.replace(/^origin\//, '')) return;
		// Only delete when the branch still points at the commit we verified.
		const tip = await this.git(['-C', repo.main, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
		if (tip.code !== 0 || tip.stdout.trim() !== outcome.head) return;
		// -D: the merge was verified against origin (or the PR), which a local
		// `-d` cannot see when the local default branch is behind.
		const del = await this.git(['-C', repo.main, 'branch', '-D', branch]);
		outcome.branchDeleted = del.code === 0;
	}
}

/**
 * Default repo candidates: every registered project path, plus the running
 * Crewly package root when it is a git checkout.
 *
 * @returns Paths (may include non-git paths; those are skipped)
 */
export async function defaultListRepoPaths(): Promise<string[]> {
	const out: string[] = [];
	try {
		const { StorageService } = await import('../core/storage.service.js');
		const projects = await StorageService.getInstance().getProjects();
		for (const p of projects) if (p?.path) out.push(p.path);
	} catch {
		// projects store unavailable — continue with the dev checkout only
	}
	try {
		const { resolveRunningPackageRoot, detectInstall } = await import('../system/auto-update.utils.js');
		const info = detectInstall(resolveRunningPackageRoot(process.argv[1], process.cwd()));
		if (info.kind === 'dev-checkout' && info.packageRoot) out.push(info.packageRoot);
	} catch {
		// not resolvable — fine
	}
	return out;
}

/**
 * Default busy-cwd probe: the start directory of every live Crewly session,
 * plus the cwd of every process of this user (which covers the PTY shells,
 * the agent runtimes under them, and anything the owner has open).
 *
 * @returns Busy directories, or null when the process probe failed
 */
export async function defaultListBusyCwds(): Promise<BusyCwd[] | null> {
	const out: BusyCwd[] = [];
	try {
		const { getSessionBackendSync } = await import('../session/session-backend.factory.js');
		const backend = getSessionBackendSync();
		for (const name of backend?.listSessions() ?? []) {
			const cwd = backend?.getSession(name)?.cwd;
			if (cwd) out.push({ cwd, source: 'agent-session' });
		}
	} catch {
		// no session backend — process probe still covers live shells
	}
	const procs = await listProcessCwds();
	if (procs === null) return null;
	for (const cwd of procs) out.push({ cwd, source: 'process' });
	return out;
}
