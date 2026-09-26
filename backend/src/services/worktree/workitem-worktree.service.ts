/**
 * WorkItemWorktreeService — one git worktree per repo-editing WorkItem (#814).
 *
 * Lifecycle (driven by WorkItemWorktreeSubscriber, which only OBSERVES
 * WorkItem transitions — it never writes a status):
 *
 *   queued (targeted) / claimed → {@link ensureWorktree}: `git worktree add
 *     <repo>/.crewly/worktrees/<id> -b wi/<id> <base>`, copy `.worktreeinclude`
 *     files, symlink heavy dirs, record everything in a manifest and on the
 *     WorkItem (`metadata.worktree`), tell the target agent the path.
 *   done / done_by_worker → {@link detectWorkedOutside} (report only).
 *   done / verified / cancelled → {@link cleanup}.
 *   anything left behind → {@link sweep}.
 *
 * Safety rules (norm-guard-reports-what-it-examined; 2026-08-21 incident):
 * - A worktree is removed only when {@link checkDirty} says `clean`
 *   (unknown = keep), and — for done/verified/missing WorkItems — when
 *   {@link checkLanded} says `landed` (unknown = keep). Cancelled/failed
 *   WorkItems need only `clean`: the branch `wi/<id>` is never deleted, so
 *   committed work survives removal.
 * - Removal never uses `--force`.
 * - Creation is serialised per repo (one `git worktree add` at a time);
 *   removal shares the same queue.
 * - v1 is opt-in: `Project.worktrees === 'on'`; `Team.worktrees === 'off'`
 *   and `CREWLY_WORKTREES=off` override it.
 *
 * @module services/worktree/workitem-worktree.service
 */

import path from 'path';
import { promises as fs } from 'fs';
import { WORKTREE_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { Project, Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import {
	runGit,
	getRepoRoot,
	resolveBaseRef,
	branchExists,
	listWorktrees,
	readIncludeFile,
	applySharedPaths,
	ensureExcluded,
	checkDirty,
	checkLanded,
	commitsBeyond,
	removeWorktree,
	type DirtyReport,
	type LandedReport,
} from './worktree-git.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The worktree record kept in the manifest and on `WorkItem.metadata.worktree`. */
export interface WorktreeRecord {
	workItemId: string;
	/** Repo root the worktree belongs to. */
	repo: string;
	/** Worktree root. */
	path: string;
	/** Where the agent should work: the worktree root, or the project subdir inside it. */
	workdir: string;
	branch: string;
	/** Base the branch started from (`origin/main`, or `HEAD`). */
	baseRef: string;
	baseSha: string;
	/** Repo-relative paths this feature symlinked in (the only ones a dirty check may exclude). */
	symlinks: string[];
	/** Repo-relative `.worktreeinclude` files copied in. */
	copies: string[];
	state: 'creating' | 'ready' | 'failed' | 'removed' | 'kept';
	createdAt: string;
	/** Last cleanup/sweep verdict, human-readable. */
	lastCheck?: string;
	error?: string;
}

/** Pool operations used (no status writes). */
export interface WorktreePool {
	findWorkItem(workItemId: string): Promise<WorkItem | null>;
	patchMetadata(workItemId: string, key: string, value: unknown): Promise<WorkItem | null>;
	appendNote(workItemId: string, author: string, note: string): Promise<WorkItem | null>;
}

/** Storage reads used to resolve a WorkItem's project and team. */
export interface WorktreeStorage {
	getProjects(): Promise<Project[]>;
	getTeams(): Promise<Team[]>;
}

/** Why a WorkItem got no worktree. */
export type WorktreeSkipReason =
	| 'kill_switch'
	| 'no_project'
	| 'team_opted_out'
	| 'project_not_opted_in'
	| 'not_a_git_repo';

/** Resolution of a WorkItem to a repo. */
export type WorktreeTarget =
	| { ok: true; repo: string; project: Project; team?: Team }
	| { ok: false; reason: WorktreeSkipReason };

/** Why a cleanup was attempted. */
export type CleanupReason = 'done' | 'verified' | 'cancelled' | 'failed' | 'missing';

/** Outcome of {@link WorkItemWorktreeService.cleanup}. */
export interface CleanupOutcome {
	action: 'removed' | 'kept';
	why: string;
	dirty?: DirtyReport;
	landed?: LandedReport;
}

/** Outcome of {@link WorkItemWorktreeService.detectWorkedOutside}. */
export interface OutsideWorkReport {
	suspected: boolean;
	commitsOnBranch: number | null;
	/** Shared-checkout paths changed since the worktree was created. */
	sharedChanges: string[];
}

/** Per-repo sweep tallies. */
export interface SweepRepoReport {
	repo: string;
	/** Entries in `.crewly/worktrees` (excluding the manifest dir). */
	listed: number;
	/** Listed entries that are registered git worktrees. */
	examined: number;
	removed: number;
	keptDirty: number;
	keptNotLanded: number;
	keptUnknown: number;
	active: number;
	/** Listed entries git does not know as worktrees (left alone). */
	unregistered: number;
	/** Set when the repo was skipped wholesale (e.g. listing parse failed). */
	refused?: string;
}

/** Whole sweep result. */
export interface SweepReport {
	reposExamined: number;
	repos: SweepRepoReport[];
}

/** Construction options. */
export interface WorkItemWorktreeOptions {
	pool: WorktreePool;
	storage: WorktreeStorage;
	/** Tell an agent something (e.g. the worktree path). Optional; failures are ignored. */
	notify?: (sessionName: string, message: string) => Promise<void>;
	/** Environment (tests). */
	env?: NodeJS.ProcessEnv;
}

/** WorkItem statuses after which a leftover worktree may be swept. */
const SWEEPABLE: ReadonlySet<string> = new Set(['done', 'verified', 'cancelled', 'failed']);

const NOTE_AUTHOR = 'worktree';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Creates, checks and removes per-WorkItem worktrees.
 */
export class WorkItemWorktreeService {
	private readonly logger: ComponentLogger;
	private readonly env: NodeJS.ProcessEnv;
	/** Per-repo serialisation chain. */
	private readonly chains = new Map<string, Promise<unknown>>();
	/** Per-repo in-flight git operations (for the serialisation guarantee + tests). */
	private readonly active = new Map<string, number>();
	/** Highest concurrency ever observed per repo (tests assert it stays 1). */
	readonly maxConcurrent = new Map<string, number>();
	/** Dirty worktrees already reported by the sweep (report once). */
	private readonly reportedDirty = new Set<string>();

	constructor(private readonly options: WorkItemWorktreeOptions) {
		this.logger = LoggerService.getInstance().createComponentLogger('WorkItemWorktreeService');
		this.env = options.env ?? process.env;
	}

	// -------------------------------------------------------------------------
	// Resolution + opt-in
	// -------------------------------------------------------------------------

	/**
	 * Decide whether a WorkItem gets a worktree, and in which repo.
	 *
	 * Project: `metadata.projectPath` when it names a registered project, else
	 * the first project of the target member's team. Opt-in: the project must
	 * have `worktrees: 'on'`; the team's `worktrees: 'off'` and
	 * `CREWLY_WORKTREES=off` win over it. The project must be in a git repo.
	 *
	 * @param wi - WorkItem
	 * @returns The repo, or why not
	 */
	async resolveTarget(wi: WorkItem): Promise<WorktreeTarget> {
		if ((this.env[WORKTREE_CONSTANTS.ENV_KILL_SWITCH] ?? '').toLowerCase() === 'off') return { ok: false, reason: 'kill_switch' };
		const [projects, teams] = await Promise.all([this.options.storage.getProjects(), this.options.storage.getTeams()]);
		const team = wi.target ? teams.find((t) => (t.members ?? []).some((m) => m.sessionName === wi.target)) : undefined;

		let project: Project | undefined;
		const metaPath = typeof wi.metadata?.['projectPath'] === 'string' ? (wi.metadata['projectPath'] as string) : undefined;
		if (metaPath) {
			const want = await realpathOrResolve(metaPath);
			for (const p of projects) {
				if ((await realpathOrResolve(p.path)) === want) project = p;
			}
		}
		if (!project && team?.projectIds?.[0]) project = projects.find((p) => p.id === team.projectIds[0]);
		if (!project) return { ok: false, reason: 'no_project' };
		if (team?.worktrees === 'off') return { ok: false, reason: 'team_opted_out' };
		if (project.worktrees !== 'on') return { ok: false, reason: 'project_not_opted_in' };
		const repo = await getRepoRoot(project.path);
		if (!repo) return { ok: false, reason: 'not_a_git_repo' };
		return { ok: true, repo, project, team };
	}

	// -------------------------------------------------------------------------
	// Create
	// -------------------------------------------------------------------------

	/**
	 * Create the WorkItem's worktree if it should have one (idempotent).
	 *
	 * @param wi - WorkItem (queued with a target, or just claimed)
	 * @returns The record, or null when the WorkItem gets no worktree
	 */
	async ensureWorktree(wi: WorkItem): Promise<WorktreeRecord | null> {
		const target = await this.resolveTarget(wi);
		if (!target.ok) {
			this.logger.debug('No worktree for WorkItem', { workItemId: wi.id, reason: target.reason });
			return null;
		}
		return this.exclusive(target.repo, () => this.create(wi, target.repo, target.project));
	}

	/** Body of {@link ensureWorktree}, run inside the repo's queue. */
	private async create(wi: WorkItem, repo: string, project: Project): Promise<WorktreeRecord> {
		const existing = await this.readManifest(repo, wi.id);
		if (existing && existing.state !== 'removed' && existing.state !== 'failed' && (await exists(existing.path))) return existing;

		const wtPath = path.join(repo, WORKTREE_CONSTANTS.DIR, wi.id);
		const branch = `${WORKTREE_CONSTANTS.BRANCH_PREFIX}${wi.id}`;
		const base = await resolveBaseRef(repo);
		const rel = path.relative(repo, await realpathOrResolve(project.path));
		const record: WorktreeRecord = {
			workItemId: wi.id,
			repo,
			path: wtPath,
			workdir: rel && !rel.startsWith('..') ? path.join(wtPath, rel) : wtPath,
			branch,
			baseRef: base?.name ?? 'HEAD',
			baseSha: base?.sha ?? '',
			symlinks: [],
			copies: [],
			state: 'creating',
			createdAt: new Date().toISOString(),
		};
		if (!base) return this.fail(record, 'could not resolve a base commit');
		await this.record(record);
		// The worktrees (and manifests) must never show up in the main checkout —
		// `git add -A` there would otherwise stage them as embedded repos in any
		// repo whose .gitignore does not cover .crewly/.
		await ensureExcluded(repo, [WORKTREE_CONSTANTS.DIR]);

		// Re-use the branch if a previous attempt (or a requeue after removal) left it.
		const args = (await branchExists(repo, branch))
			? ['worktree', 'add', wtPath, branch]
			: ['worktree', 'add', wtPath, '-b', branch, base.sha];
		const added = await runGit(repo, args);
		if (!added.ok) return this.fail(record, `git worktree add failed: ${added.stderr.trim()}`);

		const includes = await readIncludeFile(repo);
		const shared = await applySharedPaths(repo, wtPath, project.worktreeSharedDirs ?? WORKTREE_CONSTANTS.DEFAULT_SHARED_DIRS, includes.entries);
		record.symlinks = shared.symlinks;
		record.copies = shared.copies;
		record.state = 'ready';
		await this.record(record);
		this.logger.info('Worktree ready', {
			workItemId: wi.id,
			path: wtPath,
			branch,
			base: record.baseRef,
			symlinks: shared.symlinks,
			copies: shared.copies,
			skipped: shared.skipped,
			includeRejected: includes.rejected,
			includeTruncated: includes.truncated,
		});
		if (wi.target && this.options.notify) {
			await this.options
				.notify(
					wi.target,
					`[CREWLY-WORKTREE] WorkItem ${wi.id} has its own git worktree. Work ONLY in:\n  ${record.workdir}\n(branch ${branch}, based on ${record.baseRef}). cd there before editing; do not edit ${repo} directly. Commit and push from the worktree.`,
				)
				.catch(() => undefined);
		}
		return record;
	}

	/** Mark a record failed, persist it, note it on the WorkItem. */
	private async fail(record: WorktreeRecord, error: string): Promise<WorktreeRecord> {
		record.state = 'failed';
		record.error = error;
		await this.record(record);
		await this.options.pool.appendNote(record.workItemId, NOTE_AUTHOR, `worktree not created: ${error}`).catch(() => null);
		this.logger.warn('Worktree creation failed', { workItemId: record.workItemId, error });
		return record;
	}

	// -------------------------------------------------------------------------
	// Detector: worked outside the worktree
	// -------------------------------------------------------------------------

	/**
	 * At task completion: if the WorkItem's branch has 0 commits beyond its
	 * base AND the shared checkout has files changed since the worktree was
	 * created, note a warning on the WorkItem. Report only — never blocks.
	 *
	 * @param workItemId - WorkItem id
	 * @returns What was found (null when the WorkItem has no worktree)
	 */
	async detectWorkedOutside(workItemId: string): Promise<OutsideWorkReport | null> {
		const record = await this.findRecord(workItemId);
		if (!record || record.state !== 'ready' || !(await exists(record.path))) return null;
		const commits = await commitsBeyond(record.path, record.baseSha);
		const status = await runGit(record.repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
		const since = Date.parse(record.createdAt);
		const changed: string[] = [];
		if (status.ok) {
			for (const entry of status.stdout.split('\0').filter(Boolean)) {
				const rel = entry.slice(3);
				if (!rel || rel.startsWith('.crewly/')) continue;
				try {
					if ((await fs.lstat(path.join(record.repo, rel))).mtimeMs >= since) changed.push(rel);
				} catch {
					changed.push(rel); // deleted since: still a change
				}
			}
		}
		const suspected = commits === 0 && changed.length > 0;
		if (suspected) {
			await this.options.pool
				.appendNote(
					workItemId,
					NOTE_AUTHOR,
					`WARNING: worked outside its worktree? ${record.branch} has 0 commits beyond ${record.baseRef}, but the shared checkout ${record.repo} has ${changed.length} file(s) changed since the worktree was created: ${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', …' : ''}`,
				)
				.catch(() => null);
			this.logger.warn('WorkItem may have worked outside its worktree', { workItemId, branch: record.branch, sharedChanges: changed.length });
		}
		return { suspected, commitsOnBranch: commits, sharedChanges: changed };
	}

	// -------------------------------------------------------------------------
	// Cleanup
	// -------------------------------------------------------------------------

	/**
	 * Remove a WorkItem's worktree if — and only if — it is provably safe.
	 *
	 * @param workItemId - WorkItem id
	 * @param reason - Why: the WorkItem's end state, or `missing`
	 * @returns Removed or kept, with the guard reports
	 */
	async cleanup(workItemId: string, reason: CleanupReason): Promise<CleanupOutcome | null> {
		const record = await this.findRecord(workItemId);
		if (!record || record.state === 'removed') return null;
		return this.exclusive(record.repo, () => this.cleanupRecord(record, reason));
	}

	/** Body of {@link cleanup}, inside the repo's queue. */
	private async cleanupRecord(record: WorktreeRecord, reason: CleanupReason): Promise<CleanupOutcome> {
		const keep = async (why: string, extra: Partial<CleanupOutcome> = {}): Promise<CleanupOutcome> => {
			record.state = 'kept';
			record.lastCheck = `${new Date().toISOString()} kept (${reason}): ${why}`;
			await this.record(record);
			return { action: 'kept', why, ...extra };
		};

		const dirty = await checkDirty(record.path, record);
		if (dirty.state !== 'clean') return keep(`dirty check ${dirty.state}: ${dirty.summary}${dirty.dirtyPaths.length ? ` — ${dirty.dirtyPaths.slice(0, 5).join(', ')}` : ''}`, { dirty });

		let landed: LandedReport | undefined;
		if (reason === 'done' || reason === 'verified' || reason === 'missing') {
			landed = await checkLanded(record.path, record.baseRef);
			if (landed.state !== 'landed') return keep(`commits not provably landed (${landed.state}: ${landed.detail})`, { dirty, landed });
		}

		const removed = await removeWorktree(record.repo, record.path, record);
		if (!removed.ok) return keep(`git worktree remove refused: ${removed.stderr.trim()}`, { dirty, landed });

		record.state = 'removed';
		record.lastCheck = `${new Date().toISOString()} removed (${reason}): ${dirty.summary}${landed ? `; ${landed.detail}` : ''}; branch ${record.branch} kept`;
		await this.record(record);
		this.logger.info('Worktree removed', { workItemId: record.workItemId, reason, check: dirty.summary, landed: landed?.detail });
		return { action: 'removed', why: record.lastCheck, dirty, landed };
	}

	// -------------------------------------------------------------------------
	// Orphan sweep
	// -------------------------------------------------------------------------

	/**
	 * Sweep every registered project's `.crewly/worktrees`: worktrees whose
	 * WorkItem is gone or finished are cleaned up under the same rules as
	 * {@link cleanup}; dirty ones are kept and reported once. A repo whose
	 * directory lists entries but whose worktree listing matches none of them
	 * is refused (the parse failed — never act on an empty examination).
	 *
	 * @returns Per-repo tallies
	 */
	async sweep(): Promise<SweepReport> {
		const projects = await this.options.storage.getProjects();
		const repos = new Set<string>();
		for (const p of projects) {
			const repo = await getRepoRoot(p.path).catch(() => null);
			if (repo) repos.add(repo);
		}
		const report: SweepReport = { reposExamined: 0, repos: [] };
		for (const repo of repos) {
			const dir = path.join(repo, WORKTREE_CONSTANTS.DIR);
			let names: string[];
			try {
				names = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== WORKTREE_CONSTANTS.META_DIR).map((d) => d.name);
			} catch {
				continue; // no worktree dir: nothing to sweep
			}
			report.reposExamined += 1;
			report.repos.push(await this.exclusive(repo, () => this.sweepRepo(repo, dir, names)));
		}
		this.logger.info('Worktree sweep', {
			reposExamined: report.reposExamined,
			repos: report.repos.map((r) => ({ ...r })),
		});
		return report;
	}

	/** Sweep one repo (inside its queue). */
	private async sweepRepo(repo: string, dir: string, names: string[]): Promise<SweepRepoReport> {
		const r: SweepRepoReport = { repo, listed: names.length, examined: 0, removed: 0, keptDirty: 0, keptNotLanded: 0, keptUnknown: 0, active: 0, unregistered: 0 };
		const registered = await listWorktrees(repo);
		if (registered === null) {
			r.refused = 'git worktree list failed';
			return r;
		}
		const regSet = new Set(registered);
		const examinedNames: string[] = [];
		for (const name of names) {
			if (regSet.has(await realpathOrResolve(path.join(dir, name)))) examinedNames.push(name);
			else r.unregistered += 1;
		}
		r.examined = examinedNames.length;
		if (names.length > 0 && examinedNames.length === 0) {
			r.refused = `${names.length} entr${names.length === 1 ? 'y' : 'ies'} listed but 0 matched a registered worktree — refusing to act on an empty examination`;
			this.logger.warn('Worktree sweep refused', { repo, listed: names.length });
			return r;
		}

		for (const id of examinedNames) {
			const record = await this.readManifest(repo, id);
			if (!record) {
				r.keptUnknown += 1; // no manifest: we do not know what is ours
				continue;
			}
			const wi = await this.options.pool.findWorkItem(id);
			if (wi && !SWEEPABLE.has(wi.status)) {
				r.active += 1;
				continue;
			}
			const outcome = await this.cleanupRecord(record, wi ? (wi.status as CleanupReason) : 'missing');
			if (outcome.action === 'removed') r.removed += 1;
			else if (outcome.dirty?.state === 'dirty') {
				r.keptDirty += 1;
				if (!this.reportedDirty.has(record.path)) {
					this.reportedDirty.add(record.path);
					if (wi) await this.options.pool.appendNote(id, NOTE_AUTHOR, `leftover worktree kept (dirty): ${outcome.why}`).catch(() => null);
					this.logger.warn('Leftover worktree is dirty — kept', { workItemId: id, path: record.path, why: outcome.why });
				}
			} else if (outcome.landed?.state === 'not_landed') r.keptNotLanded += 1;
			else r.keptUnknown += 1;
		}
		await runGit(repo, ['worktree', 'prune']);
		return r;
	}

	// -------------------------------------------------------------------------
	// Records
	// -------------------------------------------------------------------------

	/** Manifest path for a WorkItem in a repo. */
	private manifestPath(repo: string, workItemId: string): string {
		return path.join(repo, WORKTREE_CONSTANTS.DIR, WORKTREE_CONSTANTS.META_DIR, `${workItemId}.json`);
	}

	/** Read a manifest, or null. */
	async readManifest(repo: string, workItemId: string): Promise<WorktreeRecord | null> {
		try {
			return JSON.parse(await fs.readFile(this.manifestPath(repo, workItemId), 'utf8')) as WorktreeRecord;
		} catch {
			return null;
		}
	}

	/** The record for a WorkItem: from its metadata, refreshed from the manifest. */
	private async findRecord(workItemId: string): Promise<WorktreeRecord | null> {
		const wi = await this.options.pool.findWorkItem(workItemId);
		const meta = wi?.metadata?.[WORKTREE_CONSTANTS.METADATA_KEY] as WorktreeRecord | undefined;
		if (!meta?.repo) return null;
		return (await this.readManifest(meta.repo, workItemId)) ?? meta;
	}

	/** Persist a record to the manifest and the WorkItem. */
	private async record(record: WorktreeRecord): Promise<void> {
		const file = this.manifestPath(record.repo, record.workItemId);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, JSON.stringify(record, null, 2));
		await this.options.pool.patchMetadata(record.workItemId, WORKTREE_CONSTANTS.METADATA_KEY, { ...record }).catch(() => null);
	}

	/** Run `fn` after every earlier operation on the same repo (max 1 concurrent). */
	private exclusive<T>(repo: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(repo) ?? Promise.resolve();
		const run = prev.catch(() => undefined).then(async () => {
			const n = (this.active.get(repo) ?? 0) + 1;
			this.active.set(repo, n);
			this.maxConcurrent.set(repo, Math.max(this.maxConcurrent.get(repo) ?? 0, n));
			try {
				return await fn();
			} finally {
				this.active.set(repo, (this.active.get(repo) ?? 1) - 1);
			}
		});
		this.chains.set(repo, run);
		return run;
	}
}

/** Resolve symlinks when the path exists; otherwise normalise it. */
async function realpathOrResolve(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return path.resolve(p);
	}
}

/** Whether a path exists. */
async function exists(p: string): Promise<boolean> {
	try {
		await fs.lstat(p);
		return true;
	} catch {
		return false;
	}
}
