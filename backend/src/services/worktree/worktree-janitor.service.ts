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
 * 2b. It is not the cwd (or a parent of the cwd) of an enabled scheduled
 *    command in `<CREWLY_HOME>/scheduled-commands.json` (reason
 *    `scheduled-command`); removing it would silently stop that job. The pass
 *    reports how many scheduled cwds it read. If the file cannot be read, every
 *    clean worktree is kept for that pass (`scheduled-probe-failed`).
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
 * 6. Nothing but regenerable output is uncommitted: `git status --porcelain`
 *    shows no tracked change and no untracked file, ignoring untracked
 *    `node_modules` / `.next` / `dist` / `build` / `.turbo` / `coverage` /
 *    `.cache` / `logs` directories and `*.log` files (nested packages rarely
 *    ignore their own). A failing status keeps it.
 * 7. Its work has landed: HEAD is an ancestor of `origin/<default branch>`
 *    after a quiet `git fetch` (fetch errors ignored), OR — when `gh` is
 *    installed and authenticated — a MERGED PR has this branch as head AND
 *    its head commit equals the worktree HEAD (squash merges; commits made
 *    after the merge keep the worktree). A repo without an origin (not on
 *    GitHub) only has the ancestor check, so its worktrees are kept — OR, for
 *    any git host (Bitbucket, GitLab, squash merges), its CONTENT is already in
 *    `origin/<default>`: merging HEAD into it changes nothing
 *    (`git merge-tree --write-tree`, falling back to `git cherry`), or the
 *    branch's combined diff is patch-equivalent to one commit the default
 *    branch gained since (a squash commit). See worktree-landed.ts. Work in
 *    none of these is never removed. `gh` is not asked about non-GitHub remotes.
 *
 * ## Removal
 * `git worktree remove <path>` without `--force`. If git refuses although
 * the status is still clean (only ignored output left) and the worktree has
 * no submodules, it is retried once with `--force`. Then the local branch is
 * deleted (never a protected name), and `git worktree prune` runs per repo.
 *
 * ## Age tiers for kept worktrees (crewly#1354)
 * A worktree kept as `dirty` or `not-merged` is not kept as it is forever.
 * Untouched (shallow tree mtime, git dir, newest commit) for 3 days — 1 day
 * under low disk or once its WorkItem finished — it loses its regenerable dirs
 * (`node_modules`, `.next`, `dist`, `.turbo`, `.cache`; never a dir git
 * tracks anything under); the verdict carries `reclaimed` / `tier`, the lead
 * is told once. Untouched for 14 days it is saved as a patch under
 * `<CREWLY_HOME>/worktree-archive/<repo>/<name>-<date>.patch` (tracked diff +
 * untracked files, size-capped), its branch is kept, the worktree is removed
 * and the lead is told once. See worktree-tiers.ts.
 *
 * ## Work completion
 * A WorkItem reaching a terminal state calls `requestTidy(workItemId)`: one
 * debounced pass (2 min) with a 10 min idle threshold, so a finished worktree
 * is removed as soon as its change has landed, not at the next 30-minute
 * tick; the worktree recorded on the WorkItem (`metadata.worktree`) is noted
 * as finished, which drops its strip tier to 1 day.
 *
 * ## Transcripts, tmp and logs (crewly#1354)
 * Once a day the pass prunes Claude Code transcripts of conversations Crewly
 * launched that are untouched for 14 days (transcript-janitor.ts; the owner's
 * own conversations are never touched). Every 6 hours it removes stale entries
 * of `<CREWLY_HOME>/tmp` and caps `logs/archive` (300 MB) and `logs/sessions`
 * (100 MB) (tmp-janitor.ts).
 *
 * ## Arming
 * Every delete added in crewly#1354 (strip — low disk included — archive,
 * transcripts, tmp, logs) is dry-run only until one day after the first real
 * pass that ran this code: that pass logs what it would do; the next day it
 * does it. State: `retentionArmedAt` in disk-janitor-state.json.
 *
 * ## Scratch sweep
 * After the worktrees, stale Claude Code session dirs
 * (`<tmp>/claude-<uid>/<slug>/<uuid>/`) are deleted when idle for 3 days,
 * unused, and every git repo inside is clean and fully pushed. See
 * {@link module:services/worktree/scratch-janitor} for the rules.
 *
 * ## Low-disk guard
 * Every 10 minutes the free space of the volume holding CREWLY_HOME is read.
 * Below max(15 GB, 8 % of the disk) a pass runs at once (at most one per 30
 * minutes) with every idle threshold halved (never below 2 h); every pass
 * started while space is low uses the halved thresholds. If space is still
 * low the owner is told, at most once per 24 h, with the free space, what was
 * freed by kind, the 5 biggest items the janitor left and why, and that the
 * owner's own files are never touched; below max(5 GB, 3 %) the notice is
 * urgent and repeats at most every 6 h.
 *
 * ## Unmerged work
 * A worktree kept as `not-merged` whose newest commit is older than 24 h is
 * reported to the lead of the team that owns it (project path -> team ->
 * lead; the orchestrator when no team is found), once per worktree per 3
 * days: path, branch, commits not on the default branch, pushed or not, size,
 * and the ask to merge, make main match what is live, and remove it. Never
 * sent to the owner. See {@link module:services/worktree/worktree-unmerged-notice}.
 *
 * ## Runaway files
 * Once a minute a watcher scans agent scratch dirs and worktrees for a single
 * file that grows without bound (a 40 GB `all.md` filled a disk, crewly#1078):
 * a file over 5 GB that is still growing, or any file growing over 1 GB/min,
 * has its writer stopped, is cut to its first 1 MB, the agent working there is
 * told and the owner is alerted once through the low-disk notifier. A big file
 * that is not growing is only reported. See
 * {@link module:services/worktree/runaway-file-watcher}.
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
import { LOG_ROTATION_CONSTANTS, ORCHESTRATOR_SESSION_NAME, SCHEDULED_COMMANDS, WORKTREE_JANITOR_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { safeReadJson, modifyJsonFile } from '../../utils/file-io.utils.js';
import {
	buildLowDiskNotice,
	criticalDiskThresholdBytes,
	diskLevel,
	idleThreshold,
	lowDiskThresholdBytes,
	noticeToSend,
	readDiskSpace,
	readFreeBytes,
	recordNotice,
	retentionArmed,
	type FreedBreakdown,
	type KeptItem,
	type LowDiskNoticeState,
	type StatFsFn,
} from './low-disk-guard.js';
import { defaultScratchRoots, sweepScratch, type ScratchSweepSummary } from './scratch-janitor.js';
import { reclaimDocker, type DockerReclaimResult } from './docker-reclaim.js';
import { RunawayFileWatcher, runawayWatchRoots, type RunawayOutcome } from './runaway-file-watcher.js';
import { getTraceStore, type TraceDiskResult } from '../trace/trace-store.js';
import {
	canonicalPath,
	diskUsageBytes,
	discoverLinkedWorktreeRepos,
	formatBytes,
	isJanitorDisabled,
	isPathInside,
	latestTreeMtimeMs,
	latestWorktreeMtimeMs,
	listProcessCwds,
	parsePorcelainWorktrees,
	runCommand,
	type CommandResult,
	type PorcelainWorktree,
	type RunCommandOptions,
} from './worktree-janitor.git.js';
import {
	buildUnmergedNotice,
	defaultResolveLeadSessions,
	pruneUnmergedState,
	shouldNotifyUnmerged,
	type UnmergedNoticeState,
	type UnmergedWorktreeFacts,
} from './worktree-unmerged-notice.js';
import { findWorktreeHold } from '../project-tickets/ticket-hold-registry.js';
import type { HeldTicketMatch } from '../project-tickets/ticket-hold.js';
import { contentLandedSignal, isNonGithubRemote, type LandedRepoState } from './worktree-landed.js';
import { dirtyStatusLines, reclaimRegenerableDirs } from './worktree-dirty.js';
import {
	archiveKeepRef,
	archivePatchPath,
	buildArchiveNotice,
	buildStripNotice,
	emptyTierState,
	normalizeTierState,
	pruneTierState,
	tierFor,
	tierIdleMs,
	writeArchivePatch,
	type TierState,
	type WorktreeTier,
} from './worktree-tiers.js';
import {
	defaultClaudeHomes,
	readCrewlyRecords,
	sweepTranscripts,
	type TranscriptSourceSets,
	type TranscriptSweepSummary,
} from './transcript-janitor.js';
import { capDirectoryBytes, sweepTmp, type DirCapSummary, type TmpSweepSummary } from './tmp-janitor.js';

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
	| 'scheduled-command'
	| 'scheduled-probe-failed'
	| 'managed-by-workitem-worktrees'
	| 'agent-session-inside'
	| 'process-inside'
	| 'cwd-probe-failed'
	| 'recent'
	| 'dirty'
	| 'status-failed'
	| 'not-merged'
	| 'merged'
	| 'pr-merged'
	| 'content-landed'
	| 'archived';

/** What the age tier did (or would do) to a kept worktree. */
export interface WorktreeTierOutcome {
	/** The tier reached */
	tier: WorktreeTier;
	/** Untouched for this long (ms) */
	idleMs: number;
	/** `done` (acted), `would` (dry run or not yet armed), `failed` (error below) */
	action: 'done' | 'would' | 'failed';
	/** Strip: dirs removed (or that would be) */
	dirs?: string[];
	/** Bytes freed (or that would be) */
	freedBytes: number;
	/** Archive: the patch file */
	patch?: string;
	/** Error text when the action failed */
	error?: string;
}

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
	/** Regenerable dirs (node_modules, .next, dist, …) of a kept worktree that were (or, in a dry run, would be) deleted */
	reclaimed?: { dirs: string[]; freedBytes: number };
	/** Age tier reached by a kept worktree and what was done */
	tier?: WorktreeTierOutcome;
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
	/** Number of scheduled-command cwds read for the keep check (null = unreadable) */
	scheduledCwdsRead?: number | null;
	/** Bytes freed by deleting regenerable dirs (node_modules, .next, dist, …) from kept worktrees (strip tier) */
	reclaimedBytes: number;
	/** Worktrees archived as a patch and removed (archive tier) */
	archived: number;
	/** Bytes those archived worktrees occupied */
	archivedBytes: number;
	/** True when the crewly#1354 deletes were armed for this pass (else they only report) */
	retentionArmed: boolean;
	/** Total bytes of the watched volume, or null when unknown */
	totalBytes: number | null;
	/** Transcript sweep result (null when it was not due) */
	transcripts: TranscriptSweepSummary | null;
	/** CREWLY_HOME/tmp sweep result (null when it was not due) */
	tmp: TmpSweepSummary | null;
	/** Log caps result (null when not due) */
	logs: { archive: DirCapSummary; sessions: DirCapSummary } | null;
	/** Bytes freed this pass by kind (real passes; a dry run reports what would be) */
	freed: FreedBreakdown;
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
	/** Run traces folder: its size and the oldest traces pruned past its cap */
	traces?: TraceDiskResult | null;
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
	/** cwds of enabled scheduled commands; null = could not be read (default: scheduled-commands.json) */
	listScheduledCwds?: () => Promise<string[] | null>;
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
	/** Docker reclaim on low disk (default: the real one, except under jest); null = never */
	reclaimDocker?: (() => Promise<DockerReclaimResult>) | null;
	/** Who leads the team owning a worktree (session names); empty = tell the orchestrator (default: project -> team -> lead) */
	resolveLeadSessions?: (repoMain: string, worktreePath: string) => Promise<string[]>;
	/** Unmerged-worktree notice state file (default `<CREWLY_HOME>/unmerged-worktree-notices.json`); null = in memory */
	unmergedNoticePath?: string | null;
	/** The held ticket naming a worktree's branch / folder, if any (default: every project's tickets, none under jest; crewly#1369) */
	findHold?: (branch: string | null, worktreePath: string) => Promise<HeldTicketMatch | null>;
	/** Debounce before a completion-triggered pass (default COMPLETION_TIDY_DELAY_MS) */
	tidyDelayMs?: number;
	/** Environment for the kill switch (default process.env) */
	env?: NodeJS.ProcessEnv;
	/** Logger (default: component logger `WorktreeJanitor`) */
	logger?: JanitorLogger;
	/** Tier state file (default `<CREWLY_HOME>/worktree-tiers.json`); null = in memory */
	tierStatePath?: string | null;
	/** Where archive patches go (default `<CREWLY_HOME>/worktree-archive`) */
	archiveRoot?: string;
	/** Claude homes whose transcripts are swept (default `~/.claude` + account dirs); [] = never */
	claudeHomes?: string[];
	/** What identifies Crewly's conversations (default: CREWLY_HOME records + live sessions + teams) */
	transcriptSources?: () => Promise<TranscriptSourceSets>;
	/** `<CREWLY_HOME>/tmp` (default); null = never swept */
	tmpRoot?: string | null;
	/** `<CREWLY_HOME>/logs` (default); null = never capped */
	logsDir?: string | null;
	/** Names of live sessions, whose logs are never deleted (default: session backend + persistence) */
	liveSessionNames?: () => Promise<string[]>;
	/** Tests: run the transcript / tmp sweeps on every pass regardless of their interval */
	forceSweeps?: boolean;
	/** Tests: force the arming state (default: from disk-janitor-state.json) */
	armed?: boolean;
	/** WorkItem lookup for the task-end hook (default: task pool) */
	findWorkItemWorktree?: (workItemId: string) => Promise<string | null>;
}

/** Per-repo context built lazily during a pass. */
interface RepoContext {
	main: string;
	entries: PorcelainWorktree[];
	fetched: boolean;
	defaultRef: string | null | undefined;
	/** Memo of the content-landed checks (default-branch tree, merge-tree support) */
	landed: LandedRepoState;
	/** True when origin is clearly not GitHub, so `gh` is never asked about it (resolved once per pass) */
	nonGithub?: boolean;
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
	private agentNotifier: ((sessionName: string, message: string) => Promise<boolean>) | null = null;
	private runawayTimer: NodeJS.Timeout | null = null;
	private tidyTimer: NodeJS.Timeout | null = null;
	private runawayWatcher: RunawayFileWatcher | null = null;
	private runawayInFlight = false;
	private memoryUnmergedState: UnmergedNoticeState = {};
	private memoryTierState: TierState = emptyTierState();

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
	 * Set how an agent is told its working dir had a runaway file (the server
	 * wires the normal agent message delivery here).
	 *
	 * @param notifier - Sender (true when delivered), or null to skip agent notices
	 */
	setAgentNotifier(notifier: ((sessionName: string, message: string) => Promise<boolean>) | null): void {
		this.agentNotifier = notifier;
	}

	/**
	 * One runaway-file scan now (also what the minute timer runs). Never
	 * throws; overlapping scans are skipped. Honours the kill switch.
	 *
	 * @returns What was flagged and done (empty when nothing is wrong)
	 */
	async checkRunawayFiles(): Promise<RunawayOutcome[]> {
		if (this.isDisabled() || this.runawayInFlight) return [];
		this.runawayInFlight = true;
		try {
			if (!this.runawayWatcher) {
				this.runawayWatcher = new RunawayFileWatcher({
					listRoots: async () => {
						const repos = await (this.opts.listRepoPaths ?? defaultListRepoPaths)().catch(() => [] as string[]);
						return runawayWatchRoots(this.scratchRoots(), this.tmpRoots(), repos);
					},
					notifyOwner: async (notice) => (this.notifier ? this.notifier(notice) : false),
					notifyAgents: (file, message) => this.notifyAgentsNear(file, message),
					now: () => this.now(),
					logger: this.logger,
				});
			}
			return await this.runawayWatcher.scan();
		} finally {
			this.runawayInFlight = false;
		}
	}

	/** Sessions whose cwd holds `file`, or sits in the same scratch session dir; told via the agent notifier. */
	private async notifyAgentsNear(file: string, message: string): Promise<string[]> {
		const notifier = this.agentNotifier;
		if (!notifier) return [];
		const told: string[] = [];
		try {
			const { getSessionBackendSync } = await import('../session/session-backend.factory.js');
			const backend = getSessionBackendSync();
			const unit = /^(.*[\\/]claude-\d+[\\/][^\\/]+[\\/][0-9a-f-]{36})(?:[\\/]|$)/i.exec(file)?.[1];
			for (const name of backend?.listSessions() ?? []) {
				const cwd = backend?.getSession(name)?.cwd;
				if (!cwd) continue;
				if (isPathInside(file, cwd) || (unit && isPathInside(cwd, unit))) {
					if (await notifier(name, message).catch(() => false)) told.push(name);
				}
			}
		} catch {
			// no session backend — the owner alert still goes out
		}
		return told;
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
		this.runawayTimer = setInterval(() => void this.checkRunawayFiles(), WORKTREE_JANITOR_CONSTANTS.RUNAWAY_CHECK_INTERVAL_MS);
		this.runawayTimer.unref?.();
		return true;
	}

	/** Cancel scheduled passes. */
	stop(): void {
		if (this.firstRunTimer) clearTimeout(this.firstRunTimer);
		if (this.intervalTimer) clearInterval(this.intervalTimer);
		if (this.diskTimer) clearInterval(this.diskTimer);
		if (this.runawayTimer) clearInterval(this.runawayTimer);
		if (this.tidyTimer) clearTimeout(this.tidyTimer);
		this.tidyTimer = null;
		this.runawayTimer = null;
		this.firstRunTimer = null;
		this.intervalTimer = null;
		this.diskTimer = null;
	}

	/**
	 * Current free space of the watched volume.
	 *
	 * @returns Watched path, free bytes (null when unknown) and level
	 */
	async diskStatus(): Promise<{
		path: string;
		freeBytes: number | null;
		totalBytes: number | null;
		lowBytes: number;
		criticalBytes: number;
		level: 'ok' | 'low' | 'critical' | 'unknown';
	}> {
		const p = this.diskPath();
		const space = await readDiskSpace(p, this.opts.statfs);
		const total = space?.totalBytes ?? null;
		return {
			path: p,
			freeBytes: space?.freeBytes ?? null,
			totalBytes: total,
			lowBytes: lowDiskThresholdBytes(total),
			criticalBytes: criticalDiskThresholdBytes(total),
			level: space === null ? 'unknown' : diskLevel(space.freeBytes, total),
		};
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
	 * Work just finished (a WorkItem / ticket reached done or verified): run one
	 * pass soon, so a finished worktree goes away when its PR is merged instead
	 * of waiting for the next 30-minute tick. Bursts are debounced into one pass
	 * after COMPLETION_TIDY_DELAY_MS; the idle threshold is COMPLETION_MIN_IDLE_MS.
	 * Only worktrees that pass every safety rule are removed (landed, clean, nobody
	 * inside) — unmerged work stays for the next pass. No-op when disabled. Never throws.
	 */
	requestTidy(workItemId?: string): void {
		if (this.isDisabled()) return;
		if (workItemId) void this.noteFinishedWorkItem(workItemId);
		if (this.tidyTimer) return;
		this.tidyTimer = setTimeout(() => {
			this.tidyTimer = null;
			void (async () => {
				try {
					if (this.inFlight) await this.inFlight.catch(() => undefined);
					if (this.isDisabled()) return;
					this.inFlight = this.pass(false, WORKTREE_JANITOR_CONSTANTS.COMPLETION_MIN_IDLE_MS).finally(() => {
						this.inFlight = null;
					});
					const summary = await this.inFlight;
					if (!summary.disabled) {
						this.lastSummary = summary;
						this.lastPassAt = this.now();
					}
				} catch (err) {
					this.logger.warn('Completion tidy failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
				}
			})();
		}, this.opts.tidyDelayMs ?? WORKTREE_JANITOR_CONSTANTS.COMPLETION_TIDY_DELAY_MS);
		this.tidyTimer.unref?.();
	}

	/**
	 * Task-end hook: remember that the WorkItem working in `worktreePath`
	 * finished, so its strip tier needs 1 day untouched instead of 3. Never
	 * throws.
	 *
	 * @param worktreePath - The worktree (any path form; canonicalised)
	 */
	async noteFinishedWorktree(worktreePath: string): Promise<void> {
		try {
			const state = await this.readTierState();
			state.finished[canonicalPath(worktreePath)] = this.now();
			await this.writeTierState(state);
		} catch (err) {
			this.logger.warn('Could not record finished worktree (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
		}
	}

	/** Resolve a WorkItem's worktree (`metadata.worktree.path`) and note it as finished. */
	private async noteFinishedWorkItem(workItemId: string): Promise<void> {
		try {
			const find = this.opts.findWorkItemWorktree ?? defaultFindWorkItemWorktree;
			const p = await find(workItemId);
			if (p) await this.noteFinishedWorktree(p);
		} catch {
			// no task pool — nothing to note
		}
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
		const earliest = (a?: number, b?: number): number | undefined =>
			a === undefined ? b : b === undefined ? a : Math.min(a, b);
		return {
			lastNoticeAt: latest(file.lastNoticeAt, mem.lastNoticeAt),
			lastUrgentAt: latest(file.lastUrgentAt, mem.lastUrgentAt),
			retentionArmedAt: earliest(file.retentionArmedAt, mem.retentionArmedAt),
			lastTranscriptSweepAt: latest(file.lastTranscriptSweepAt, mem.lastTranscriptSweepAt),
			lastTmpSweepAt: latest(file.lastTmpSweepAt, mem.lastTmpSweepAt),
		};
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

	private tierStatePath(): string | null {
		if (this.opts.tierStatePath !== undefined) return this.opts.tierStatePath;
		return path.join(getCrewlyHomePath(), WORKTREE_JANITOR_CONSTANTS.TIER_STATE_FILENAME);
	}

	private async readTierState(): Promise<TierState> {
		const p = this.tierStatePath();
		if (!p) return this.memoryTierState;
		const file = normalizeTierState(await safeReadJson<unknown>(p, null));
		// Memory wins when a save failed (full disk).
		const mem = this.memoryTierState;
		for (const key of ['stripped', 'archived', 'finished'] as const) {
			for (const [k, v] of Object.entries(mem[key])) file[key][k] = Math.max(file[key][k] ?? 0, v);
		}
		return file;
	}

	private async writeTierState(state: TierState): Promise<void> {
		this.memoryTierState = state;
		const p = this.tierStatePath();
		if (!p) return;
		try {
			await modifyJsonFile<TierState | null, TierState>(p, null, () => state);
		} catch (err) {
			this.logger.warn('Could not save worktree tier state', { error: err instanceof Error ? err.message : String(err) });
		}
	}

	private async doCheckDisk(): Promise<LowDiskCheckResult> {
		const result: LowDiskCheckResult = { freeBytesBefore: null, freeBytesAfter: null, ranPass: false, notified: null };
		try {
			if (this.isDisabled()) return result;
			const space = await readDiskSpace(this.diskPath(), this.opts.statfs);
			const before = space?.freeBytes ?? null;
			const total = space?.totalBytes ?? null;
			result.freeBytesBefore = before;
			result.freeBytesAfter = before;
			if (before === null || diskLevel(before, total) === 'ok') return result;

			let summary = this.lastSummary;
			const gapOk = this.lastPassAt === null || this.now() - this.lastPassAt >= WORKTREE_JANITOR_CONSTANTS.LOW_DISK_PASS_GAP_MS;
			if (gapOk) {
				await this.reclaimDockerSpace();
				summary = await this.run();
				result.ranPass = true;
				result.freeBytesAfter = await readFreeBytes(this.diskPath(), this.opts.statfs);
			}
			const after = result.freeBytesAfter;
			if (after === null || !this.notifier) return result;
			const state = await this.readNoticeState();
			const kind = noticeToSend(diskLevel(after, total), state, this.now());
			if (!kind) return result;
			const items = summary ? await this.keptItems(summary) : [];
			// What the volume actually gained covers worktrees and scratch alike.
			const freed = result.ranPass ? Math.max(0, after - before) : 0;
			const breakdown = result.ranPass && summary ? summary.freed : undefined;
			const notice = buildLowDiskNotice({ freeBytes: after, urgent: kind === 'urgent', freedBytes: freed, items, freed: breakdown, totalBytes: total });
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

	/**
	 * Docker images and build cache that can be pulled or rebuilt again
	 * (docker-reclaim.ts). Never throws.
	 */
	private async reclaimDockerSpace(): Promise<void> {
		const fn =
			this.opts.reclaimDocker === undefined
				? (this.opts.env ?? process.env).JEST_WORKER_ID
					? null
					: reclaimDocker
				: this.opts.reclaimDocker;
		if (!fn) return;
		try {
			const r = await fn();
			if (r.ran) this.logger.info('Low disk: reclaimed Docker images and build cache', { removedImages: r.removedImages.length });
		} catch (err) {
			this.logger.warn('Docker reclaim failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
		}
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

	private async pass(dryRun: boolean, idleOverrideMs?: number): Promise<JanitorRunSummary> {
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
			scheduledCwdsRead: null,
			reclaimedBytes: 0,
			archived: 0,
			archivedBytes: 0,
			retentionArmed: false,
			totalBytes: null,
			keptReasons: {},
			worktrees: [],
			lowDisk: false,
			freeBytes: null,
			scratch: null,
			traces: null,
			transcripts: null,
			tmp: null,
			logs: null,
			freed: { worktrees: 0, stripped: 0, archived: 0, transcripts: 0, tmp: 0 },
		};
		if (!dryRun && this.isDisabled()) {
			summary.disabled = true;
			return summary;
		}
		try {
			this.ghUsable = undefined;
			const space = await readDiskSpace(this.diskPath(), this.opts.statfs);
			summary.freeBytes = space?.freeBytes ?? null;
			summary.totalBytes = space?.totalBytes ?? null;
			summary.lowDisk = summary.freeBytes !== null && diskLevel(summary.freeBytes, summary.totalBytes) !== 'ok';
			// Arming: the first real pass with the crewly#1354 deletes only reports them.
			let noticeState = await this.readNoticeState();
			if (!dryRun && noticeState.retentionArmedAt === undefined) {
				noticeState = { ...noticeState, retentionArmedAt: this.now() };
				await this.writeNoticeState(noticeState);
				this.logger.info('Disk janitor: first pass with worktree tiers and transcript/tmp/log retention — reporting only today, deleting from tomorrow');
			}
			summary.retentionArmed = this.opts.armed ?? retentionArmed(noticeState, this.now());
			const repos = await this.resolveRepos();
			summary.repos = repos.map((r) => r.main);
			const busy = await this.safeBusyCwds();
			let tierState = await this.readTierState();
			const existing = new Set<string>();
			const scheduled = await this.safeScheduledCwds();
			summary.scheduledCwdsRead = scheduled === null ? null : scheduled.length;
			for (const repo of repos) {
				let removedHere = 0;
				const unmerged: WorktreeOutcome[] = [];
				for (const entry of repo.entries) {
					existing.add(canonicalPath(entry.path));
					const verdict = await this.evaluate(repo, entry, busy, scheduled, summary.lowDisk, idleOverrideMs);
					const outcome: WorktreeOutcome = { ...verdict, removed: false, forced: false, branchDeleted: false };
					if (verdict.decision === 'keep') {
						tierState = await this.applyTier(repo, entry, outcome, busy, tierState, summary, dryRun);
						if (outcome.removed) removedHere++;
					}
					if (verdict.decision === 'remove' && !dryRun) {
						await this.remove(repo, outcome);
						if (outcome.removed) removedHere++;
					}
					summary.worktrees.push(outcome);
					if (!dryRun && !outcome.removed && verdict.decision === 'keep' && verdict.reason === 'not-merged') unmerged.push(outcome);
					if (outcome.removed) summary.removed++;
					else if (dryRun && verdict.decision === 'remove') summary.wouldRemove++;
					else {
						summary.kept++;
						const key = outcome.error ? 'remove-failed' : verdict.reason;
						summary.keptReasons[key] = (summary.keptReasons[key] ?? 0) + 1;
					}
				}
				if (unmerged.length > 0) await this.noticeUnmerged(repo, unmerged);
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
			summary.freed.worktrees += summary.scratch?.freedBytes ?? 0;
			if (!dryRun) await this.writeTierState(pruneTierState(tierState, this.now(), existing));
			summary.traces = await getTraceStore().enforceTotalCap({ dryRun });
			await this.sweepRetention(summary, busy, noticeState, dryRun);
		} catch (err) {
			this.logger.warn('Worktree janitor pass failed', { error: err instanceof Error ? err.message : String(err) });
		}
		summary.durationMs = Date.now() - started;
		if (!dryRun) {
			const reasons = Object.entries(summary.keptReasons)
				.sort((a, b) => b[1] - a[1])
				.map(([k, v]) => `${k}: ${v}`)
				.join(', ');
			const would = summary.worktrees.filter((w) => w.tier?.action === 'would');
			const wouldStrip = would.filter((w) => w.tier?.tier === 'strip');
			const wouldText =
				would.length > 0
					? `; not yet armed: would strip ${wouldStrip.length} (${formatBytes(wouldStrip.reduce((n, w) => n + (w.tier?.freedBytes ?? 0), 0))}), archive ${would.length - wouldStrip.length}`
					: '';
			this.logger.info(
				`Worktree janitor: removed ${summary.removed}${summary.archived > 0 ? ` (${summary.archived} archived as patches, ${formatBytes(summary.archivedBytes)})` : ''}, kept ${summary.kept}${reasons ? ` (${reasons})` : ''}${summary.reclaimedBytes > 0 ? `, stripped ${formatBytes(summary.reclaimedBytes)} of node_modules/build output from idle kept worktrees` : ''}${wouldText} across ${summary.repos.length} repo(s) in ${summary.durationMs}ms; ${summary.scheduledCwdsRead == null ? 'scheduled-command cwds unreadable (all clean worktrees kept)' : `${summary.scheduledCwdsRead} scheduled-command cwd(s) read`}`,
				{ removed: summary.worktrees.filter((w) => w.removed).map((w) => w.path), lowDisk: summary.lowDisk, retentionArmed: summary.retentionArmed },
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
			const tr = summary.traces;
			if (tr && tr.files > 0) {
				this.logger.info(
					`Trace janitor: traces folder ${formatBytes(tr.bytes)} in ${tr.files} trace(s), cap ${formatBytes(tr.capBytes)}${tr.prunedTraces ? `, pruned ${tr.prunedTraces} oldest (${formatBytes(tr.freedBytes)})` : ''}`,
					{ ...tr },
				);
			}
			this.logRetention(summary);
		}
		return summary;
	}

	/** One log line each for the transcript, tmp and log sweeps of a real pass. */
	private logRetention(summary: JanitorRunSummary): void {
		const days = Math.round(WORKTREE_JANITOR_CONSTANTS.TRANSCRIPT_MAX_AGE_MS / 86_400_000);
		const armed = summary.retentionArmed;
		const ts = summary.transcripts;
		if (ts) {
			const kept = Object.entries(ts.keptReasons).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';
			this.logger.info(
				armed
					? `Transcript janitor: pruned ${ts.pruned} agent transcript(s) older than ${days} days, freed ${formatBytes(ts.freedBytes)}; scanned ${ts.scanned} in ${ts.homes.length} home(s), kept ${kept}`
					: `Transcript janitor (dry run, not yet armed): would prune ${ts.wouldPrune} agent transcript(s) older than ${days} days, ${formatBytes(ts.wouldFreeBytes)}; scanned ${ts.scanned} in ${ts.homes.length} home(s), kept ${kept}`,
				{ homes: ts.homes, pruned: ts.transcripts.filter((t) => t.removed).map((t) => t.path) },
			);
		}
		const tm = summary.tmp;
		if (tm) {
			const kept = Object.entries(tm.keptReasons).map(([k, v]) => `${k}: ${v}`).join(', ');
			this.logger.info(
				armed
					? `Tmp janitor: removed ${tm.removed} entr${tm.removed === 1 ? 'y' : 'ies'} of ${tm.root}, freed ${formatBytes(tm.freedBytes)}, kept ${tm.kept}${kept ? ` (${kept})` : ''}`
					: `Tmp janitor (dry run, not yet armed): would remove ${tm.wouldRemove} entr${tm.wouldRemove === 1 ? 'y' : 'ies'} of ${tm.root}, ${formatBytes(tm.wouldFreeBytes)}, kept ${tm.kept}${kept ? ` (${kept})` : ''}`,
				{ removed: tm.entries.filter((e) => e.removed).map((e) => e.path) },
			);
		}
		const lg = summary.logs;
		if (lg) {
			for (const c of [lg.archive, lg.sessions]) {
				if (c.deleted.length === 0 && c.wouldDelete.length === 0 && c.overCapBytes === 0) continue;
				this.logger.info(
					armed
						? `Log janitor: ${c.dir} was ${formatBytes(c.totalBytes)} (cap ${formatBytes(c.capBytes)}), deleted ${c.deleted.length} oldest file(s), freed ${formatBytes(c.freedBytes)}${c.overCapBytes > 0 ? `, still ${formatBytes(c.overCapBytes)} over the cap (live or fresh logs)` : ''}`
						: `Log janitor (dry run, not yet armed): ${c.dir} is ${formatBytes(c.totalBytes)} (cap ${formatBytes(c.capBytes)}), would delete ${c.wouldDelete.length} oldest file(s), ${formatBytes(c.wouldFreeBytes)}`,
				);
			}
		}
	}

	/**
	 * Age tiers for a kept worktree (crewly#1354): strip its regenerable dirs
	 * after 3 days untouched (1 day under low disk / after a finished WorkItem),
	 * archive it as a patch and remove it after 14 days. Managed per-WorkItem
	 * worktrees are only stripped (keeping their shared symlinks), never
	 * archived — their own service owns them. Never throws.
	 *
	 * @returns The (possibly updated) tier state
	 */
	private async applyTier(
		repo: RepoContext,
		entry: PorcelainWorktree,
		outcome: WorktreeOutcome,
		busy: BusyCwd[] | null,
		state: TierState,
		summary: JanitorRunSummary,
		dryRun: boolean,
	): Promise<TierState> {
		const managed = outcome.reason === 'managed-by-workitem-worktrees';
		if (!managed && outcome.reason !== 'dirty' && outcome.reason !== 'not-merged') return state;
		try {
			const key = canonicalPath(entry.path);
			const finishedAt = state.finished[key];
			if (managed) {
				// Only a finished WorkItem's managed worktree is touched, and only to strip it.
				if (finishedAt === undefined) return state;
				if (busy === null || busy.some((b) => isPathInside(b.cwd, entry.path))) return state;
			}
			const gitDirR = await this.git(['-C', entry.path, 'rev-parse', '--absolute-git-dir']);
			const gitDir = gitDirR.code === 0 ? gitDirR.stdout.trim() : null;
			const log = await this.git(['-C', entry.path, 'log', '-1', '--format=%ct', 'HEAD']);
			const newestCommitMs = log.code === 0 && /^\d+$/.test(log.stdout.trim()) ? Number(log.stdout.trim()) * 1000 : null;
			const idleMs = tierIdleMs({
				now: this.now(),
				treeMtimeMs: await latestTreeMtimeMs(entry.path, WORKTREE_JANITOR_CONSTANTS.TIER_MTIME_DEPTH),
				gitMtimeMs: latestWorktreeMtimeMs(entry.path, gitDir),
				newestCommitMs,
			});
			let tier = tierFor({ idleMs, lowDisk: summary.lowDisk, finishedAt });
			if (tier === null) return state;
			if (managed && tier === 'archive') tier = 'strip';
			const idle = idleMs ?? 0;
			if (tier === 'strip') {
				const act = !dryRun && summary.retentionArmed;
				const rec = await reclaimRegenerableDirs(entry.path, this.opts.sizeOf ?? diskUsageBytes, !act, {
					isTracked: (dir) => this.isTracked(entry.path, dir),
					keepSymlinks: managed,
				});
				if (rec.dirs.length === 0) return state;
				// `reclaimed` keeps its pre-#1354 meaning (low-disk reclaim, done or planned); the tier carries the rest.
				if (act || (summary.lowDisk && dryRun)) outcome.reclaimed = rec;
				outcome.tier = { tier, idleMs: idle, action: act ? 'done' : 'would', dirs: rec.dirs, freedBytes: rec.freedBytes };
				if (act) {
					summary.reclaimedBytes += rec.freedBytes;
					summary.freed.stripped += rec.freedBytes;
					if (state.stripped[key] === undefined) {
						state = { ...state, stripped: { ...state.stripped, [key]: this.now() } };
						await this.tellLead(repo, entry.path, buildStripNotice({ path: entry.path, reason: outcome.reason, idleMs: idle, dirs: rec.dirs, freedBytes: rec.freedBytes }));
					}
				}
				return state;
			}
			const act = !dryRun && summary.retentionArmed;
			const bytes = (await (this.opts.sizeOf ?? diskUsageBytes)(entry.path)) ?? 0;
			if (!act) {
				outcome.tier = { tier, idleMs: idle, action: 'would', freedBytes: bytes };
				return state;
			}
			const defaultRef = await this.defaultRef(repo);
			let commits: number | null = null;
			if (entry.head && defaultRef) {
				const c = await this.git(['-C', repo.main, 'rev-list', '--count', entry.head, `^${defaultRef}`]);
				commits = c.code === 0 && /^\d+$/.test(c.stdout.trim()) ? Number(c.stdout.trim()) : null;
			}
			let keepRef: string | null = null;
			if (!entry.branch && entry.head && (commits ?? 1) > 0) {
				keepRef = archiveKeepRef(entry.path, this.now());
				const u = await this.git(['-C', repo.main, 'update-ref', keepRef, entry.head]);
				if (u.code !== 0) keepRef = null;
			}
			const file = archivePatchPath(this.opts.archiveRoot ?? path.join(getCrewlyHomePath(), WORKTREE_JANITOR_CONSTANTS.ARCHIVE_DIR), repo.main, entry.path, this.now());
			let patch;
			try {
				patch = await writeArchivePatch(
					(args, options) => this.git(args, options),
					{ repoMain: repo.main, worktreePath: entry.path, branch: entry.branch, head: entry.head, defaultRef, commitsNotOnDefault: commits, keepRef },
					file,
					this.now(),
				);
			} catch (err) {
				outcome.tier = { tier, idleMs: idle, action: 'failed', freedBytes: 0, error: err instanceof Error ? err.message : String(err) };
				this.logger.warn('Worktree archive failed; worktree kept', { path: entry.path, error: outcome.tier.error });
				return state;
			}
			const r = await this.git(['-C', repo.main, 'worktree', 'remove', '--force', entry.path]);
			if (r.code !== 0) {
				outcome.tier = { tier, idleMs: idle, action: 'failed', freedBytes: 0, patch: file, error: (r.stderr || 'git worktree remove failed').trim().slice(0, 300) };
				this.logger.warn('Worktree archive: patch saved but removal failed; worktree kept', { path: entry.path, patch: file, error: outcome.tier.error });
				return state;
			}
			outcome.removed = true;
			outcome.forced = true;
			outcome.decision = 'remove';
			outcome.reason = 'archived';
			outcome.detail = `untouched ${Math.floor(idle / 86_400_000)} days; patch ${file}`;
			outcome.tier = { tier, idleMs: idle, action: 'done', freedBytes: bytes, patch: file };
			summary.archived += 1;
			summary.archivedBytes += bytes;
			summary.freed.archived += bytes;
			state = { ...state, archived: { ...state.archived, [key]: this.now() } };
			await this.tellLead(repo, entry.path, buildArchiveNotice({ path: entry.path, branch: entry.branch, patch, idleMs: idle, commitsNotOnDefault: commits, keepRef }));
			this.logger.info('Archived and removed an untouched worktree', { path: entry.path, patch: file, bytes, branch: entry.branch });
		} catch (err) {
			this.logger.warn('Worktree tier failed (non-fatal)', { path: entry.path, error: err instanceof Error ? err.message : String(err) });
		}
		return state;
	}

	/** Whether git tracks anything under `dir` of the worktree (null = could not tell). */
	private async isTracked(worktreePath: string, dir: string): Promise<boolean | null> {
		const rel = path.relative(worktreePath, dir);
		const r = await this.git(['-C', worktreePath, 'ls-files', '--', rel]);
		if (r.code !== 0) return null;
		return r.stdout.trim() !== '';
	}

	/** Tell the owning team's lead (else the orchestrator) one message. Never throws. */
	private async tellLead(repo: RepoContext, worktreePath: string, message: string): Promise<void> {
		const notifier = this.agentNotifier;
		if (!notifier) return;
		try {
			const leads = await (this.opts.resolveLeadSessions ?? defaultResolveLeadSessions)(repo.main, worktreePath).catch(() => [] as string[]);
			for (const session of leads.length > 0 ? leads : [ORCHESTRATOR_SESSION_NAME]) await notifier(session, message).catch(() => false);
		} catch {
			// best effort
		}
	}

	/**
	 * Transcript, tmp and log retention (crewly#1354), each on its own
	 * cadence; all dry-run until armed. Never throws.
	 */
	private async sweepRetention(summary: JanitorRunSummary, busy: BusyCwd[] | null, noticeState: LowDiskNoticeState, dryRun: boolean): Promise<void> {
		const now = this.now();
		const effectiveDry = dryRun || !summary.retentionArmed;
		const due = (last: number | undefined, interval: number): boolean => this.opts.forceSweeps === true || last === undefined || now - last >= interval;
		let stateChanged = false;
		try {
			// Under jest the real ~/.claude is never scanned unless a test asks for it.
			const homes = this.opts.claudeHomes ?? ((this.opts.env ?? process.env).JEST_WORKER_ID ? [] : defaultClaudeHomes(getCrewlyHomePath()));
			if (homes.length > 0 && due(noticeState.lastTranscriptSweepAt, WORKTREE_JANITOR_CONSTANTS.TRANSCRIPT_SWEEP_INTERVAL_MS)) {
				const sources = await (this.opts.transcriptSources ?? (() => defaultTranscriptSources(now)))();
				summary.transcripts = await sweepTranscripts({ claudeHomes: homes, sources, now, dryRun: effectiveDry, sizeOf: this.opts.sizeOf });
				summary.freed.transcripts += summary.transcripts.freedBytes;
				if (!effectiveDry) {
					noticeState.lastTranscriptSweepAt = now;
					stateChanged = true;
				}
			}
		} catch (err) {
			this.logger.warn('Transcript sweep failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
		}
		try {
			const tmpRoot = this.opts.tmpRoot === undefined ? path.join(getCrewlyHomePath(), WORKTREE_JANITOR_CONSTANTS.TMP_DIR) : this.opts.tmpRoot;
			const logsDir = this.opts.logsDir === undefined ? path.join(getCrewlyHomePath(), LOG_ROTATION_CONSTANTS.LOGS_DIR) : this.opts.logsDir;
			if ((tmpRoot || logsDir) && due(noticeState.lastTmpSweepAt, WORKTREE_JANITOR_CONSTANTS.TMP_SWEEP_INTERVAL_MS)) {
				if (tmpRoot) {
					summary.tmp = await sweepTmp({ root: tmpRoot, busy, now, dryRun: effectiveDry, sizeOf: this.opts.sizeOf });
					summary.freed.tmp += summary.tmp.freedBytes;
				}
				if (logsDir) {
					const live = new Set(await (this.opts.liveSessionNames ?? defaultLiveSessionNames)().catch(() => [] as string[]));
					const archive = await capDirectoryBytes({
						dir: path.join(logsDir, LOG_ROTATION_CONSTANTS.ARCHIVE_DIR),
						capBytes: WORKTREE_JANITOR_CONSTANTS.LOG_ARCHIVE_CAP_BYTES,
						now,
						dryRun: effectiveDry,
					});
					const sessions = await capDirectoryBytes({
						dir: path.join(logsDir, LOG_ROTATION_CONSTANTS.SESSIONS_LOG_DIR),
						capBytes: WORKTREE_JANITOR_CONSTANTS.LOG_SESSIONS_CAP_BYTES,
						now,
						dryRun: effectiveDry,
						protect: (name) => live.has(name.replace(/\.log$/, '')),
					});
					summary.logs = { archive, sessions };
					summary.freed.tmp += archive.freedBytes + sessions.freedBytes;
				}
				if (!effectiveDry) {
					noticeState.lastTmpSweepAt = now;
					stateChanged = true;
				}
			}
		} catch (err) {
			this.logger.warn('Tmp/log sweep failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
		}
		if (stateChanged) await this.writeNoticeState(noticeState);
	}

	/**
	 * Tell the owning team's lead (else the orchestrator) about kept worktrees
	 * with unmerged work, once per worktree per interval. Never throws.
	 */
	private async noticeUnmerged(repo: RepoContext, kept: WorktreeOutcome[]): Promise<void> {
		const notifier = this.agentNotifier;
		if (!notifier) return;
		try {
			const defaultRef = await this.defaultRef(repo);
			if (!defaultRef) return;
			const now = this.now();
			let state = await this.readUnmergedState();
			let changed = false;
			for (const w of kept) {
				if (!w.head) continue;
				const ts = await this.git(['-C', w.path, 'log', '-1', '--format=%ct', w.head]);
				const newest = ts.code === 0 && /^\d+$/.test(ts.stdout.trim()) ? Number(ts.stdout.trim()) * 1000 : null;
				if (!shouldNotifyUnmerged(state, w.path, newest, now)) continue;
				const count = await this.git(['-C', w.path, 'rev-list', '--count', w.head, `^${defaultRef}`]);
				const commits = count.code === 0 ? Number(count.stdout.trim()) : NaN;
				if (!Number.isFinite(commits) || commits <= 0) continue;
				let pushed = false;
				if (w.branch) {
					const ahead = await this.git(['-C', w.path, 'rev-list', '--count', w.head, `^refs/remotes/origin/${w.branch}`]);
					pushed = ahead.code === 0 && ahead.stdout.trim() === '0';
				}
				const facts: UnmergedWorktreeFacts = {
					path: w.path,
					branch: w.branch,
					commitsNotOnMain: commits,
					defaultRef,
					pushed,
					sizeBytes: await (this.opts.sizeOf ?? diskUsageBytes)(w.path).catch(() => null),
				};
				const leads = await (this.opts.resolveLeadSessions ?? defaultResolveLeadSessions)(repo.main, w.path).catch(() => [] as string[]);
				const targets = leads.length > 0 ? leads : [ORCHESTRATOR_SESSION_NAME];
				const findHold = this.opts.findHold ?? ((this.opts.env ?? process.env).JEST_WORKER_ID ? null : findWorktreeHold);
				const hold = findHold ? await findHold(w.branch, w.path).catch(() => null) : null;
				const message = buildUnmergedNotice(facts, hold);
				let delivered = false;
				for (const session of targets) {
					if (await notifier(session, message).catch(() => false)) delivered = true;
				}
				if (delivered) {
					state = { ...state, [w.path]: now };
					changed = true;
					this.logger.info('Told lead about unmerged worktree', { path: w.path, to: targets, commits, ...(hold ? { heldBy: hold.hold.heldBy ?? hold.ticketId } : {}) });
				}
			}
			if (changed) await this.writeUnmergedState(pruneUnmergedState(state, now));
		} catch (err) {
			this.logger.warn('Unmerged worktree notice failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
		}
	}

	private async readUnmergedState(): Promise<UnmergedNoticeState> {
		const p = this.opts.unmergedNoticePath === undefined
			? path.join(getCrewlyHomePath(), WORKTREE_JANITOR_CONSTANTS.UNMERGED_NOTICE_STATE_FILENAME)
			: this.opts.unmergedNoticePath;
		if (!p) return this.memoryUnmergedState;
		const file = (await safeReadJson<UnmergedNoticeState | null>(p, null)) ?? {};
		const merged: UnmergedNoticeState = { ...file };
		for (const [k, v] of Object.entries(this.memoryUnmergedState)) merged[k] = Math.max(merged[k] ?? 0, v);
		return merged;
	}

	private async writeUnmergedState(state: UnmergedNoticeState): Promise<void> {
		this.memoryUnmergedState = state;
		const p = this.opts.unmergedNoticePath === undefined
			? path.join(getCrewlyHomePath(), WORKTREE_JANITOR_CONSTANTS.UNMERGED_NOTICE_STATE_FILENAME)
			: this.opts.unmergedNoticePath;
		if (!p) return;
		try {
			await modifyJsonFile<UnmergedNoticeState | null, UnmergedNoticeState>(p, null, () => state);
		} catch (err) {
			this.logger.warn('Could not save unmerged worktree notice state', { error: err instanceof Error ? err.message : String(err) });
		}
	}

	private async resolveRepos(): Promise<RepoContext[]> {
		const registered = await (this.opts.listRepoPaths ?? defaultListRepoPaths)().catch(() => [] as string[]);
		let discovered: string[] = [];
		try {
			// CREWLY_HOME/tmp too: agents put worktrees there, and the tmp sweep leaves git checkouts to these rules.
			const crewlyTmp = this.opts.tmpRoot === undefined ? path.join(getCrewlyHomePath(), WORKTREE_JANITOR_CONSTANTS.TMP_DIR) : this.opts.tmpRoot;
			discovered = await discoverLinkedWorktreeRepos([...this.tmpRoots(), ...this.scratchRoots(), ...(crewlyTmp ? [crewlyTmp] : [])]);
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
			seen.set(key, { main: main.path, entries, fetched: false, defaultRef: undefined, landed: {} });
		}
		return [...seen.values()];
	}

	private async safeScheduledCwds(): Promise<string[] | null> {
		try {
			return await (this.opts.listScheduledCwds ?? defaultListScheduledCwds)();
		} catch {
			return null;
		}
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
		scheduled: string[] | null,
		lowDisk: boolean,
		idleOverrideMs?: number,
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

		if (scheduled === null) return keep('scheduled-probe-failed');
		const sched = scheduled.find((c) => isPathInside(c, entry.path));
		if (sched) return keep('scheduled-command', sched);

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
		const minIdle = idleOverrideMs !== undefined ? Math.min(idleOverrideMs, idleThreshold(normalIdle, lowDisk)) : idleThreshold(normalIdle, lowDisk);
		if (idleMs === undefined || idleMs < minIdle) {
			return keep('recent', `needs ${Math.round(minIdle / MS_PER_MINUTE)} min idle (${agentLocation ? 'agent location' : 'other location'})`, idleMs);
		}

		// `normal` keeps untracked directories collapsed (one line per
		// `node_modules/`), so a huge dependency tree cannot flood the output.
		const status = await this.git(['-C', entry.path, 'status', '--porcelain', '--untracked-files=normal']);
		if (status.code !== 0) return keep('status-failed', status.stderr.trim().slice(0, 200), idleMs);
		const dirtyLines = dirtyStatusLines(status.stdout);
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
		if (defaultRef) {
			// Host-agnostic: squash merges on Bitbucket / GitLab / anywhere leave no
			// ancestry and no GitHub PR, but the CONTENT is in the default branch.
			const signal = await contentLandedSignal((a, o) => this.git(a, o), repo.main, defaultRef, entry.head, repo.landed);
			if (signal) return { ...base, decision: 'remove', reason: 'content-landed', detail: `${signal} in ${defaultRef}`, idleMs };
		}
		return keep('not-merged', defaultRef ? `not in ${defaultRef} (history or content), no merged PR` : 'no origin default branch, no merged PR', idleMs);
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
		if (repo.nonGithub === undefined) {
			const url = await this.git(['-C', repo.main, 'config', '--get', 'remote.origin.url']);
			repo.nonGithub = url.code === 0 && isNonGithubRemote(url.stdout);
		}
		// Bitbucket / GitLab remotes: gh cannot see their PRs, and asking costs a call per worktree.
		if (repo.nonGithub) return null;
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
			const status = await this.git(['-C', outcome.path, 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none']);
			const clean = status.code === 0 && dirtyStatusLines(status.stdout).length === 0;
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
 * Default WorkItem -> worktree lookup for the task-end hook: the worktree the
 * per-WorkItem worktree feature recorded on the item (`metadata.worktree.path`).
 *
 * @param workItemId - WorkItem id
 * @returns Worktree path, or null when the item has none
 */
export async function defaultFindWorkItemWorktree(workItemId: string): Promise<string | null> {
	try {
		const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
		const item = (await TaskPoolService.getInstance().getAllItems()).find((i) => i.id === workItemId);
		const wt = item?.metadata?.worktree as { path?: unknown } | undefined;
		return typeof wt?.path === 'string' ? wt.path : null;
	} catch {
		return null;
	}
}

/**
 * Default transcript sources: Crewly's records under CREWLY_HOME
 * (session-state, last-conversations, handover files), the live session
 * backend (names) and persistence (names + current conversation ids, kept),
 * and every team member's session name.
 *
 * @param now - Current time (ms)
 * @returns Known session names, recorded ids, ids to keep
 */
export async function defaultTranscriptSources(now: number): Promise<TranscriptSourceSets> {
	const sets = await readCrewlyRecords(getCrewlyHomePath(), now);
	try {
		const { getSessionBackendSync } = await import('../session/session-backend.factory.js');
		for (const name of getSessionBackendSync()?.listSessions() ?? []) sets.knownSessionNames.add(name);
	} catch {
		// no session backend
	}
	try {
		const { getSessionStatePersistence } = await import('../session/session-state-persistence.js');
		const persistence = getSessionStatePersistence();
		for (const name of persistence.getRegisteredSessions()) {
			sets.knownSessionNames.add(name);
			const id = persistence.getSessionId(name);
			if (id) {
				sets.keepIds.add(id.toLowerCase());
				sets.recordedIds.add(id.toLowerCase());
			}
		}
	} catch {
		// no persistence
	}
	try {
		const { StorageService } = await import('../core/storage.service.js');
		for (const team of await StorageService.getInstance().getTeams()) {
			for (const m of team.members ?? []) if (m.sessionName) sets.knownSessionNames.add(m.sessionName);
		}
	} catch {
		// no teams store
	}
	return sets;
}

/**
 * Default live-session names (their logs are never deleted by the cap): the
 * session backend's sessions plus every persisted session.
 *
 * @returns Session names
 */
export async function defaultLiveSessionNames(): Promise<string[]> {
	const out = new Set<string>();
	try {
		const { getSessionBackendSync } = await import('../session/session-backend.factory.js');
		for (const name of getSessionBackendSync()?.listSessions() ?? []) out.add(name);
	} catch {
		// no session backend
	}
	try {
		const { getSessionStatePersistence } = await import('../session/session-state-persistence.js');
		for (const name of getSessionStatePersistence().getRegisteredSessions()) out.add(name);
	} catch {
		// no persistence
	}
	return [...out];
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

/**
 * Default scheduled-command probe: the cwds of the enabled entries in
 * `<CREWLY_HOME>/scheduled-commands.json`.
 *
 * @returns Absolute cwds (empty when no config file), or null when the file is unreadable
 */
export async function defaultListScheduledCwds(): Promise<string[] | null> {
	const { readScheduledCommandCwds } = await import('../system/scheduled-commands.service.js');
	return readScheduledCommandCwds(path.join(getCrewlyHomePath(), SCHEDULED_COMMANDS.CONFIG_FILE));
}
