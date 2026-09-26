/**
 * StandingRefreshService — raises a refresh WorkItem for a standing-answer
 * page, but only when the memory behind it has moved (#816).
 *
 * Runs on the reflect-trigger cadence (wired in `backend/src/index.ts`
 * next to WikiReflectTriggerService). Each tick looks at every project
 * page for every known project and the agent page for every known agent
 * session, and raises one WorkItem per page when ALL of these hold:
 *
 *  1. the page has in-scope entries at all (nothing to answer from → no page);
 *  2. the page is stale (missing, no watermark, or newer entries exist);
 *  3. the sources' watermark differs from the one this service last raised
 *     for — so a refresh that was skipped or failed is not re-raised until
 *     the memory moves again ("only when the watermark moves");
 *  4. no refresh WorkItem for the page is still open;
 *  5. the page's cooldown has passed;
 *  6. fewer than `maxCreatesPerTick` were created this tick (PTY paste-flood
 *     guard, same reasoning as WikiWorkItemBridgeService).
 *
 * No LLM runs here and nothing is written to memory: the WorkItem brief
 * lists the entries, and the agent working it writes sections through the
 * standing-update skill. Project pages go to the vault owner (team leader)
 * or the orchestrator; the agent page goes to that agent.
 *
 * The last-raised watermark per page is persisted so a restart does not
 * re-raise what was already raised.
 *
 * @module services/memory/standing-refresh.service
 */

import path from 'path';
import { STANDING_ANSWERS_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { createWorkItem, type WorkItem, type WorkItemStatus } from '../../types/v2/work-item.types.js';
import { atomicWriteJson, ensureDir, safeReadJson } from '../../utils/file-io.utils.js';
import {
	StandingAnswersService,
	PROJECT_STANDING_PAGES,
	AGENT_STANDING_PAGE,
	type StandingLocation,
	type StandingPageDef,
} from './standing-answers.service.js';

/** Statuses after which a refresh WorkItem no longer blocks a new one. */
const CLOSED_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(['done', 'verified', 'cancelled', 'failed', 'rejected']);

/** The pool operations this service needs. */
export interface RefreshPool {
	addToPool(workItem: WorkItem): Promise<void>;
	getAllItems(): Promise<WorkItem[]>;
}

/** Construction options. */
export interface StandingRefreshOptions {
	pool: RefreshPool;
	/** Absolute path of the agent skills dir, written into briefs. */
	agentSkillsPath: string;
	/** Project roots to check. */
	listProjects: () => Promise<string[]>;
	/** Agent session names to check. */
	listAgents: () => Promise<string[]>;
	/** Owner of a project's pages (e.g. its team leader); null → fallback. */
	resolveProjectTarget?: (projectPath: string) => Promise<string | null>;
	/** Target when no owner resolves (default: the orchestrator). */
	fallbackTarget?: string;
	service?: StandingAnswersService;
	cooldownMs?: number;
	maxCreatesPerTick?: number;
	/** State file (default `<CREWLY_HOME>/standing-refresh-state.json`). */
	statePath?: string;
	/** Clock (tests). */
	now?: () => number;
}

/** Why a page produced no WorkItem this tick. */
export type RefreshSkipReason = 'no_entries' | 'fresh' | 'watermark_unchanged' | 'inflight' | 'cooldown' | 'tick_cap';

/** Outcome of one tick — counts what was examined, not only what was done. */
export interface RefreshTickResult {
	pagesExamined: number;
	created: Array<{ key: string; workItemId: string; target: string; watermark: string | null }>;
	skipped: Record<RefreshSkipReason, number>;
}

/** Persisted per-page bookkeeping. */
interface RefreshState {
	[pageKey: string]: { watermark: string | null; raisedAt: number };
}

/**
 * Raises standing-page refresh WorkItems when their watermark moves.
 */
export class StandingRefreshService {
	private readonly logger: ComponentLogger;
	private readonly service: StandingAnswersService;
	private readonly cooldownMs: number;
	private readonly maxCreatesPerTick: number;
	private readonly statePath: string;
	private readonly now: () => number;
	private readonly fallbackTarget: string;
	private timer: NodeJS.Timeout | null = null;
	private running = false;

	constructor(private readonly options: StandingRefreshOptions) {
		this.logger = LoggerService.getInstance().createComponentLogger('StandingRefreshService');
		this.service = options.service ?? new StandingAnswersService();
		this.cooldownMs = options.cooldownMs ?? STANDING_ANSWERS_CONSTANTS.REFRESH_COOLDOWN_MS;
		this.maxCreatesPerTick = options.maxCreatesPerTick ?? STANDING_ANSWERS_CONSTANTS.REFRESH_MAX_CREATES_PER_TICK;
		this.statePath = options.statePath ?? path.join(getCrewlyHomePath(), STANDING_ANSWERS_CONSTANTS.REFRESH_STATE_FILE);
		this.now = options.now ?? Date.now;
		this.fallbackTarget = options.fallbackTarget ?? ORCHESTRATOR_SESSION_NAME;
	}

	/**
	 * Start ticking every `intervalMs` (first tick after one interval).
	 *
	 * @param intervalMs - Tick interval
	 */
	start(intervalMs: number): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick().catch((err) => {
				this.logger.warn('Standing refresh tick failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
			});
		}, intervalMs);
		this.timer.unref?.();
	}

	/** Stop ticking. */
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * One pass over every page. Re-entrant calls while a tick runs return an
	 * empty result instead of double-raising.
	 *
	 * @returns What was examined, created and skipped (by reason)
	 */
	async tick(): Promise<RefreshTickResult> {
		const result: RefreshTickResult = {
			pagesExamined: 0,
			created: [],
			skipped: { no_entries: 0, fresh: 0, watermark_unchanged: 0, inflight: 0, cooldown: 0, tick_cap: 0 },
		};
		if (this.running) return result;
		this.running = true;
		try {
			const [projects, agents, items, state] = await Promise.all([
				this.options.listProjects(),
				this.options.listAgents(),
				this.options.pool.getAllItems(),
				safeReadJson<RefreshState>(this.statePath, {}),
			]);
			const inflight = new Set(
				items
					.filter((wi) => wi.metadata?.['kind'] === STANDING_ANSWERS_CONSTANTS.WORKITEM_KIND && !CLOSED_STATUSES.has(wi.status))
					.map((wi) => String(wi.metadata?.['pageKey'])),
			);

			const candidates: Array<{ def: StandingPageDef; loc: StandingLocation; key: string }> = [
				...[...new Set(projects)].flatMap((projectPath) =>
					PROJECT_STANDING_PAGES.map((def) => ({ def, loc: { projectPath }, key: `project:${projectPath}:${def.id}` })),
				),
				...[...new Set(agents)].map((sessionName) => ({
					def: AGENT_STANDING_PAGE,
					loc: { sessionName },
					key: `agent:${sessionName}:${AGENT_STANDING_PAGE.id}`,
				})),
			];

			let stateChanged = false;
			for (const c of candidates) {
				const status = await this.service.getPageStatus(c.def, c.loc);
				if (!status) continue;
				result.pagesExamined += 1;

				const prior = state[c.key];
				let skip: RefreshSkipReason | null = null;
				if (status.entriesInScope === 0) skip = 'no_entries';
				else if (!status.stale) skip = 'fresh';
				else if (prior && prior.watermark === status.currentWatermark) skip = 'watermark_unchanged';
				else if (inflight.has(c.key)) skip = 'inflight';
				else if (prior && this.now() - prior.raisedAt < this.cooldownMs) skip = 'cooldown';
				else if (result.created.length >= this.maxCreatesPerTick) skip = 'tick_cap';
				if (skip) {
					result.skipped[skip] += 1;
					continue;
				}

				const target = await this.targetFor(c.def, c.loc);
				const brief = await this.service.buildRefreshBrief(status, c.loc, this.options.agentSkillsPath);
				const scopeLabel = c.def.scope === 'project' ? path.basename(c.loc.projectPath ?? '') : c.loc.sessionName;
				const wi = createWorkItem({
					type: 'delegate',
					owner: c.def.scope === 'project' ? 'orchestrator' : 'agent',
					target,
					title: `Refresh standing answer "${c.def.question}" — ${scopeLabel} (${status.newerEntries} newer)`,
					description: `Refresh the standing-answer page ${c.def.id} at ${status.filePath}: ${status.newerEntries} in-scope memor${status.newerEntries === 1 ? 'y is' : 'ies are'} newer than the page.`,
					briefMarkdown: brief,
					maxRetries: 1,
					metadata: {
						kind: STANDING_ANSWERS_CONSTANTS.WORKITEM_KIND,
						pageKey: c.key,
						pageId: c.def.id,
						scope: c.def.scope,
						...(c.loc.projectPath ? { projectPath: c.loc.projectPath } : {}),
						...(c.loc.sessionName ? { sessionName: c.loc.sessionName } : {}),
						watermark: status.currentWatermark,
						autoCreated: true,
					},
				});
				await this.options.pool.addToPool(wi);
				state[c.key] = { watermark: status.currentWatermark, raisedAt: this.now() };
				stateChanged = true;
				result.created.push({ key: c.key, workItemId: wi.id, target, watermark: status.currentWatermark });
			}

			if (stateChanged) {
				await ensureDir(path.dirname(this.statePath));
				await atomicWriteJson(this.statePath, state);
			}
			this.logger.info('Standing refresh tick', {
				pagesExamined: result.pagesExamined,
				created: result.created.length,
				skipped: result.skipped,
			});
			return result;
		} finally {
			this.running = false;
		}
	}

	/** Who works a page's refresh. */
	private async targetFor(def: StandingPageDef, loc: StandingLocation): Promise<string> {
		if (def.scope === 'agent') return loc.sessionName ?? this.fallbackTarget;
		if (!this.options.resolveProjectTarget || !loc.projectPath) return this.fallbackTarget;
		try {
			return (await this.options.resolveProjectTarget(loc.projectPath)) ?? this.fallbackTarget;
		} catch {
			return this.fallbackTarget;
		}
	}
}
