/**
 * Disk janitor — removes git worktrees whose work has landed, stale Claude
 * Code session scratch dirs, and watches free disk space.
 *
 * Agents create a worktree per code task and never delete it — under
 * `<repo>/.claude/worktrees/`, `/tmp/crewly-worktrees/`, but also at
 * arbitrary paths (`/private/tmp/claude-501/visa-cm-wt`, `../crewly-wt-805`),
 * each with its own node_modules. They also clone whole repos into Claude
 * Code's per-session temp dirs. A Mac filled its disk (ENOSPC) with both.
 * Owner decision: finished work goes away by itself.
 *
 * ## Which repos
 * Every registered project path (projects store) that is inside a git repo,
 * the Crewly package root when it is a dev checkout, and every repo that owns
 * a linked worktree found under the temp roots (`/tmp`, os.tmpdir(), and the
 * Claude scratch roots `<tmp>/claude-<uid>`, searched a few levels deep) — so
 * a repo that is not a registered project still gets its temp worktrees
 * cleaned. Repos are de-duplicated by their main worktree.
 *
 * ## Worktree removal rules — a worktree is removed only when ALL hold
 * 1. It is not the main worktree, not bare, and not `prunable` (a missing
 *    directory is left to `git worktree prune`). Any other linked worktree of
 *    a known repo is a candidate, wherever it lives and whatever its branch.
 * 2. It is not locked (`git worktree lock`; Claude Code locks the worktree of
 *    a running subagent).
 * 3. It is not under `<repo>/.crewly/worktrees/` — that directory belongs to
 *    the per-WorkItem worktree feature (#814), which does its own
 *    WorkItem-aware cleanup.
 * 4. Nothing is working in it: no Crewly agent session was started in it and
 *    no process of this user (PTY shells, runtimes, editors, test runners)
 *    has its cwd inside it. If the process probe fails, everything is kept.
 * 5. It is idle: last touched (newest mtime of the directory and its git
 *    dir's index / HEAD / logs/HEAD) more than 2 hours ago in a known agent
 *    location (`<main>/.claude/worktrees/`, `<tmp>/crewly-worktrees/`, or a
 *    `worktree-agent-*` branch), more than 24 hours ago anywhere else.
 * 6. `git status --porcelain --untracked-files=all` is empty: no tracked
 *    change and no untracked file. Ignored files (node_modules, dist) do not
 *    count. A failing status keeps it.
 * 7. Its work has landed: HEAD is an ancestor of `origin/<default branch>`
 *    after a quiet `git fetch` (fetch errors ignored), OR — when `gh` is
 *    installed and authenticated — a MERGED PR has this branch as head AND
 *    its head commit equals the worktree HEAD (squash merges; commits made
 *    after the merge keep the worktree). A repo without an origin (not on
 *    GitHub) only has the ancestor check, so its worktrees are kept.
 *
 * ## Removal
 * `git worktree remove <path>` without `--force`. If git refuses although
 * the status is still clean (only ignored output left) and the worktree has
 * no submodules, it is retried once with `--force`. Then the local branch is
 * deleted (never a protected name), and `git worktree prune` runs per repo.
 *
 * ## Scratch sweep
 * After the worktrees, stale Claude Code session dirs
 * (`<tmp>/claude-<uid>/<slug>/<uuid>/`) are deleted when idle for 3 days,
 * unused, and every git repo inside is clean and fully pushed. See
 * {@link module:services/worktree/scratch-janitor} for the rules.
 *
 * ## Low-disk guard
 * Every 10 minutes the free space of the volume holding CREWLY_HOME is read.
 * Below 15 GB a pass runs at once (at most one per 30 minutes) with every
 * idle threshold halved (never below 2 h); every pass started while space is
 * low uses the halved thresholds. If space is still below 15 GB the owner is
 * told, at most once per 24 h, with the free space and the 5 biggest items
 * the janitor left and why; below 5 GB the notice is urgent and repeats at
 * most every 6 h.
 *
 * Runs every 30 minutes (first run 10 minutes after boot). Kill switch:
 * `CREWLY_WORKTREE_JANITOR=0` (also stops the low-disk guard). Never throws;
 * logs one summary line per sweep.
 *
 * @module services/worktree/worktree-janitor.service
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WORKTREE_JANITOR_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { safeReadJson, modifyJsonFile } from '../../utils/file-io.utils.js';
import {
	buildLowDiskNotice,
	diskLevel,
	idleThreshold,
	noticeToSend,
	readFreeBytes,
	recordNotice,
	type KeptItem,
	type LowDiskNoticeState,
	type StatFsFn,
} from './low-disk-guard.js';
import { defaultScratchRoots, sweepScratch, type ScratchSweepSummary } from './scratch-janitor.js';
import {
	canonicalPath,
	diskUsageBytes,
	discoverLinkedWorktreeRepos,
	formatBytes,
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

/** Milliseconds per minute (for the `recent` detail text). */
const MS_PER_MINUTE = 60 * 1000;

/**
 * Why a worktree is kept, or why it may go. (`not-agent-worktree` is retired:
 * location no longer decides eligibility, only the idle threshold.)
 */
export type WorktreeReason =
	| 'main-worktree'
	| 'bare'
	| 'prunable'
	| 'locked'
	| 'managed-by-workitem-worktrees'
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
	/** True when free space was below LOW_DISK_BYTES at the start (thresholds halved) */
	lowDisk: boolean;
	/** Free bytes on the CREWLY_HOME volume at the start, or null when unknown */
	freeBytes: number | null;
	/** Stale scratch sweep result */
	scratch: ScratchSweepSummary | null;
}

/** What one low-disk check did. */
export interface LowDiskCheckResult {
	/** Free bytes before (null when statfs failed) */
	freeBytesBefore: number | null;
	/** Free bytes after the cleanup pass (same as before when no pass ran) */
	freeBytesAfter: number | null;
	/** True when a cleanup pass ran */
	ranPass: boolean;
	/** Owner notice sent, if any */
	notified: 'urgent' | 'normal' | null;
}

/** Owner notice about low disk. Returns true when it was delivered. */
export type LowDiskNotifier = (notice: { title: string; message: string; urgent: boolean }) => Promise<boolean>;

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
	/** Minimum idle time before removal in an agent location (default 2 h) */
	minIdleMs?: number;
	/** Minimum idle time before removal anywhere else (default 24 h) */
	minIdleOtherMs?: number;
	/** Minimum idle time of a scratch session dir (default 3 days) */
	scratchMinIdleMs?: number;
	/** Temp roots whose `crewly-worktrees/` holds agent worktrees, also scanned for repo discovery (default `/tmp` + os.tmpdir()) */
	tmpRoots?: string[];
	/** Claude Code scratch roots (default `<tmp>/claude-<uid>` variants that exist) */
	scratchRoots?: string[];
	/** Free-space probe (default fs.promises.statfs) */
	statfs?: StatFsFn;
	/** Path whose volume is watched (default CREWLY_HOME) */
	diskPath?: string;
	/** Owner notifier for low disk (default: none — set by the server via setLowDiskNotifier) */
	notifyOwner?: LowDiskNotifier | null;
	/** Size probe for removed / kept items (default `du -sk`) */
	sizeOf?: (p: string) => Promise<number | null>;
	/** Low-disk notice state file (default `<CREWLY_HOME>/disk-janitor-state.json`); null = in memory */
	statePath?: string | null;
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
	private diskTimer: NodeJS.Timeout | null = null;
	private diskCheckInFlight: Promise<LowDiskCheckResult> | null = null;
	private lastPassAt: number | null = null;
	private memoryNoticeState: LowDiskNoticeState = {};
	private notifier: LowDiskNotifier | null;

	/**
	 * @param options - Injectable dependencies; defaults use the live backend
	 */
	constructor(options: WorktreeJanitorOptions = {}) {
		this.opts = options;
		this.notifier = options.notifyOwner ?? null;
	}

	/**
	 * Set how the owner is told about low disk (the server wires the existing
	 * Slack owner-notification path here).
	 *
	 * @param notifier - Sender, or null to disable notices
	 */
	setLowDiskNotifier(notifier: LowDiskNotifier | null): void {
		this.notifier = notifier;
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
	 * INTERVAL_MS; plus the low-disk check every LOW_DISK_CHECK_INTERVAL_MS.
	 * No-op when disabled or already started. Timers are unref'd.
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
		this.diskTimer = setInterval(() => void this.checkDisk(), WORKTREE_JANITOR_CONSTANTS.LOW_DISK_CHECK_INTERVAL_MS);
		this.diskTimer.unref?.();
		return true;
	}

	/** Cancel scheduled passes. */
	stop(): void {
		if (this.firstRunTimer) clearTimeout(this.firstRunTimer);
		if (this.intervalTimer) clearInterval(this.intervalTimer);
		if (this.diskTimer) clearInterval(this.diskTimer);
		this.firstRunTimer = null;
		this.intervalTimer = null;
		this.diskTimer = null;
	}

	/**
	 * Current free space of the watched volume.
	 *
	 * @returns Watched path, free bytes (null when unknown) and level
	 */
	async diskStatus(): Promise<{ path: string; freeBytes: number | null; level: 'ok' | 'low' | 'critical' | 'unknown' }> {
		const p = this.diskPath();
		const freeBytes = await readFreeBytes(p, this.opts.statfs);
		return { path: p, freeBytes, level: freeBytes === null ? 'unknown' : diskLevel(freeBytes) };
	}

	/**
	 * Low-disk check: read free space; below LOW_DISK_BYTES run a pass now
	 * (unless one ran within LOW_DISK_PASS_GAP_MS), then, if space is still
	 * short, tell the owner within the notice cadence. Never throws. Honours
	 * the kill switch. Concurrent calls share the check in flight.
	 *
	 * @returns What the check did
	 */
	async checkDisk(): Promise<LowDiskCheckResult> {
		if (this.diskCheckInFlight) return this.diskCheckInFlight;
		this.diskCheckInFlight = this.doCheckDisk().finally(() => {
			this.diskCheckInFlight = null;
		});
		return this.diskCheckInFlight;
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
		if (!summary.dryRun && !summary.disabled) {
			this.lastSummary = summary;
			this.lastPassAt = this.now();
		}
		return summary;
	}

	// ---------------------------------------------------------------------

	private get logger(): JanitorLogger {
		if (this.opts.logger) return this.opts.logger;
		if (!this.loggerInstance) this.loggerInstance = LoggerService.getInstance().createComponentLogger('WorktreeJanitor');
		return this.loggerInstance;
	}

	private now(): number {
		return (this.opts.now ?? Date.now)();
	}

	private diskPath(): string {
		return this.opts.diskPath ?? getCrewlyHomePath();
	}

	private scratchRoots(): string[] {
		return this.opts.scratchRoots ?? defaultScratchRoots();
	}

	private tmpRoots(): string[] {
		return this.opts.tmpRoots ?? ['/tmp', os.tmpdir()];
	}

	private statePath(): string | null {
		if (this.opts.statePath !== undefined) return this.opts.statePath;
		return path.join(getCrewlyHomePath(), WORKTREE_JANITOR_CONSTANTS.STATE_FILENAME);
	}

	private async readNoticeState(): Promise<LowDiskNoticeState> {
		const p = this.statePath();
		const mem = this.memoryNoticeState;
		if (!p) return mem;
		const file = (await safeReadJson<LowDiskNoticeState | null>(p, null)) ?? {};
		// Memory wins when a save failed (full disk), so the owner is not re-told every check.
		const latest = (a?: number, b?: number): number | undefined =>
			a === undefined ? b : b === undefined ? a : Math.max(a, b);
		return { lastNoticeAt: latest(file.lastNoticeAt, mem.lastNoticeAt), lastUrgentAt: latest(file.lastUrgentAt, mem.lastUrgentAt) };
	}

	private async writeNoticeState(state: LowDiskNoticeState): Promise<void> {
		const p = this.statePath();
		this.memoryNoticeState = state;
		if (!p) return;
		try {
			await modifyJsonFile<LowDiskNoticeState | null, LowDiskNoticeState>(p, null, () => state);
		} catch (err) {
			// A full disk can refuse the write; the in-memory copy still holds for this process.
			this.logger.warn('Could not save disk janitor state', { error: err instanceof Error ? err.message : String(err) });
		}
	}

	private async doCheckDisk(): Promise<LowDiskCheckResult> {
		const result: LowDiskCheckResult = { freeBytesBefore: null, freeBytesAfter: null, ranPass: false, notified: null };
		try {
			if (this.isDisabled()) return result;
			const before = await readFreeBytes(this.diskPath(), this.opts.statfs);
			result.freeBytesBefore = before;
			result.freeBytesAfter = before;
			if (before === null || diskLevel(before) === 'ok') return result;

			let summary = this.lastSummary;
			const gapOk = this.lastPassAt === null || this.now() - this.lastPassAt >= WORKTREE_JANITOR_CONSTANTS.LOW_DISK_PASS_GAP_MS;
			if (gapOk) {
				summary = await this.run();
				result.ranPass = true;
				result.freeBytesAfter = await readFreeBytes(this.diskPath(), this.opts.statfs);
			}
			const after = result.freeBytesAfter;
			if (after === null || !this.notifier) return result;
			const state = await this.readNoticeState();
			const kind = noticeToSend(diskLevel(after), state, this.now());
			if (!kind) return result;
			const items = summary ? await this.keptItems(summary) : [];
			// What the volume actually gained covers worktrees and scratch alike.
			const freed = result.ranPass ? Math.max(0, after - before) : 0;
			const notice = buildLowDiskNotice({ freeBytes: after, urgent: kind === 'urgent', freedBytes: freed, items });
			const delivered = await this.notifier({ ...notice, urgent: kind === 'urgent' }).catch(() => false);
			if (delivered) {
				await this.writeNoticeState(recordNotice(state, kind, this.now()));
				result.notified = kind;
			}
			this.logger.warn(`Low disk: ${formatBytes(after)} free${delivered ? `, owner notified (${kind})` : ', owner notice not delivered'}`);
		} catch (err) {
			this.logger.warn('Low-disk check failed', { error: err instanceof Error ? err.message : String(err) });
		}
		return result;
	}

	/** Sizes of everything a pass left on disk that the owner could act on. */
	private async keptItems(summary: JanitorRunSummary): Promise<KeptItem[]> {
		const skip = new Set<string>(['main-worktree', 'bare', 'prunable']);
		const candidates: Array<{ path: string; reason: string }> = [];
		for (const w of summary.worktrees) {
			if (!w.removed && !skip.has(w.reason) && (w.decision === 'keep' || w.error)) {
				candidates.push({ path: w.path, reason: w.error ? 'remove-failed' : w.reason });
			}
		}
		for (const s of summary.scratch?.sessions ?? []) {
			if (!s.removed) candidates.push({ path: s.path, reason: s.error ? 'remove-failed' : s.reason });
		}
		const sizeOf = this.opts.sizeOf ?? diskUsageBytes;
		const items: KeptItem[] = [];
		for (const c of candidates) {
			const bytes = await sizeOf(c.path);
			if (bytes !== null) items.push({ ...c, bytes });
		}
		return items;
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
			lowDisk: false,
			freeBytes: null,
			scratch: null,
		};
		if (!dryRun && this.isDisabled()) {
			summary.disabled = true;
			return summary;
		}
		try {
			this.ghUsable = undefined;
			summary.freeBytes = await readFreeBytes(this.diskPath(), this.opts.statfs);
			summary.lowDisk = summary.freeBytes !== null && diskLevel(summary.freeBytes) !== 'ok';
			const repos = await this.resolveRepos();
			summary.repos = repos.map((r) => r.main);
			const busy = await this.safeBusyCwds();
			for (const repo of repos) {
				let removedHere = 0;
				for (const entry of repo.entries) {
					const verdict = await this.evaluate(repo, entry, busy, summary.lowDisk);
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
			summary.scratch = await sweepScratch({
				roots: this.scratchRoots(),
				busy,
				now: this.now(),
				minIdleMs: idleThreshold(this.opts.scratchMinIdleMs ?? WORKTREE_JANITOR_CONSTANTS.SCRATCH_MIN_IDLE_MS, summary.lowDisk),
				dryRun,
				git: (args) => this.git(args),
				sizeOf: this.opts.sizeOf,
			});
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
				{ removed: summary.worktrees.filter((w) => w.removed).map((w) => w.path), lowDisk: summary.lowDisk },
			);
			const sc = summary.scratch;
			if (sc) {
				const scReasons = Object.entries(sc.keptReasons)
					.sort((a, b) => b[1] - a[1])
					.map(([k, v]) => `${k}: ${v}`)
					.join(', ');
				this.logger.info(
					`Scratch janitor: removed ${sc.removed} session dir(s), freed ${formatBytes(sc.freedBytes)}, kept ${sc.kept}${scReasons ? ` (${scReasons})` : ''}`,
					{ removed: sc.sessions.filter((s) => s.removed).map((s) => s.path), freedBytes: sc.freedBytes },
				);
			}
		}
		return summary;
	}

	private async resolveRepos(): Promise<RepoContext[]> {
		const registered = await (this.opts.listRepoPaths ?? defaultListRepoPaths)().catch(() => [] as string[]);
		let discovered: string[] = [];
		try {
			discovered = discoverLinkedWorktreeRepos([...this.tmpRoots(), ...this.scratchRoots()]);
		} catch {
			// discovery is best effort
		}
		const candidates = [...registered, ...discovered];
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

	/** Known agent location (short idle threshold) vs anywhere else (long one). */
	private isAgentLocation(repo: RepoContext, entry: PorcelainWorktree): boolean {
		if (isPathInside(entry.path, path.join(repo.main, WORKTREE_JANITOR_CONSTANTS.AGENT_WORKTREE_DIR))) return true;
		for (const root of this.tmpRoots()) {
			if (isPathInside(entry.path, path.join(root, WORKTREE_JANITOR_CONSTANTS.TMP_WORKTREE_DIR))) return true;
		}
		const branch = entry.branch;
		return !!branch && WORKTREE_JANITOR_CONSTANTS.AGENT_BRANCH_PREFIXES.some((p) => branch.startsWith(p));
	}

	/**
	 * Apply the removal rules to one worktree (read-only apart from fetch).
	 */
	private async evaluate(
		repo: RepoContext,
		entry: PorcelainWorktree,
		busy: BusyCwd[] | null,
		lowDisk: boolean,
	): Promise<WorktreeVerdict> {
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

		if (busy === null) return keep('cwd-probe-failed');
		const hit = busy.find((b) => isPathInside(b.cwd, entry.path));
		if (hit) return keep(hit.source === 'agent-session' ? 'agent-session-inside' : 'process-inside', hit.cwd);

		const gitDirR = await this.git(['-C', entry.path, 'rev-parse', '--absolute-git-dir']);
		const gitDir = gitDirR.code === 0 ? gitDirR.stdout.trim() : null;
		const mtime = latestWorktreeMtimeMs(entry.path, gitDir);
		const idleMs = mtime === null ? undefined : Math.max(0, this.now() - mtime);
		const agentLocation = this.isAgentLocation(repo, entry);
		const normalIdle = agentLocation
			? (this.opts.minIdleMs ?? WORKTREE_JANITOR_CONSTANTS.MIN_IDLE_MS)
			: (this.opts.minIdleOtherMs ?? WORKTREE_JANITOR_CONSTANTS.MIN_IDLE_OTHER_MS);
		const minIdle = idleThreshold(normalIdle, lowDisk);
		if (idleMs === undefined || idleMs < minIdle) {
			return keep('recent', `needs ${Math.round(minIdle / MS_PER_MINUTE)} min idle (${agentLocation ? 'agent location' : 'other location'})`, idleMs);
		}

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
