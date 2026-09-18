/**
 * Consolidation Scheduler — runs memory consolidation for every active
 * agent once per day.
 *
 * `MemoryConsolidationService.consolidate()` was built but nothing ever
 * invoked it, so `consolidation.json` never appeared under any agent dir.
 * This scheduler is the cadence: a 24 h `setInterval` plus a boot-time
 * catch-up when the last recorded sweep is older than the interval (or has
 * never happened). The last-run timestamp is persisted under
 * `CREWLY_HOME/self-improvement-state.json` so restarts don't re-run the
 * sweep every boot.
 *
 * Every failure is non-fatal and logged: a broken memory file for one agent
 * must not stop the sweep for the others, and a broken sweep must never take
 * the backend down.
 *
 * @module services/ai/self-improvement/consolidation-scheduler.service
 */

import * as fs from 'fs';
import * as path from 'path';
import { SELF_IMPROVEMENT_CONSTANTS } from '../../../constants.js';
import { getCrewlyHomePath } from '../../core/crewly-home.utils.js';
import { LoggerService } from '../../core/logger.service.js';
import type { ConsolidationReport } from './memory-consolidation.service.js';

/**
 * Persisted scheduler state.
 */
export interface SelfImprovementState {
	/** ISO timestamp of the last completed consolidation sweep */
	lastConsolidationAt: string | null;
	/** Sessions consolidated during the last sweep */
	lastConsolidatedSessions: string[];
	/** Per-session failures during the last sweep (session → error message) */
	lastErrors: Record<string, string>;
}

/**
 * Result summary of one sweep.
 */
export interface ConsolidationSweepResult {
	/** Sessions whose report was regenerated */
	consolidated: string[];
	/** Sessions that failed, with the error message */
	failed: Record<string, string>;
	/** ISO timestamp the sweep finished */
	finishedAt: string;
}

/**
 * Minimal logger surface so tests can pass a stub.
 */
export interface SchedulerLoggerLike {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	debug(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Construction options.
 */
export interface ConsolidationSchedulerOptions {
	/** Runs consolidation for one session and returns the report */
	consolidate: (sessionName: string) => Promise<ConsolidationReport>;
	/** Lists the sessions that should be consolidated (active members) */
	listActiveSessions: () => Promise<string[]>;
	/** Sweep period in ms (default 24 h) */
	intervalMs?: number;
	/** Delay before the boot-time catch-up run (default 60 s; 0 = immediate) */
	bootDelayMs?: number;
	/** State file path (default `CREWLY_HOME/self-improvement-state.json`) */
	statePath?: string;
	/** Clock override for tests */
	now?: () => number;
	/** Logger override for tests */
	logger?: SchedulerLoggerLike;
}

/**
 * Daily memory-consolidation cadence for active agents.
 */
export class ConsolidationSchedulerService {
	private static instance: ConsolidationSchedulerService | null = null;

	private readonly consolidate: ConsolidationSchedulerOptions['consolidate'];
	private readonly listActiveSessions: ConsolidationSchedulerOptions['listActiveSessions'];
	private readonly intervalMs: number;
	private readonly bootDelayMs: number;
	private readonly statePath: string;
	private readonly now: () => number;
	private readonly logger: SchedulerLoggerLike;

	private intervalTimer: NodeJS.Timeout | null = null;
	private bootTimer: NodeJS.Timeout | null = null;
	private running = false;

	/**
	 * Create a scheduler. Call {@link start} to arm the timers.
	 *
	 * @param options - Dependencies and tuning
	 */
	constructor(options: ConsolidationSchedulerOptions) {
		this.consolidate = options.consolidate;
		this.listActiveSessions = options.listActiveSessions;
		this.intervalMs = options.intervalMs ?? SELF_IMPROVEMENT_CONSTANTS.CONSOLIDATION_INTERVAL_MS;
		this.bootDelayMs = options.bootDelayMs ?? SELF_IMPROVEMENT_CONSTANTS.BOOT_RUN_DELAY_MS;
		this.statePath = options.statePath ?? path.join(getCrewlyHomePath(), SELF_IMPROVEMENT_CONSTANTS.STATE_FILE);
		this.now = options.now ?? (() => Date.now());
		this.logger =
			options.logger ?? LoggerService.getInstance().createComponentLogger('ConsolidationScheduler');
	}

	/**
	 * Process-wide instance set by the backend bootstrap.
	 *
	 * @returns The registered instance, or null before bootstrap
	 */
	static getInstance(): ConsolidationSchedulerService | null {
		return ConsolidationSchedulerService.instance;
	}

	/**
	 * Register (or clear) the process-wide instance.
	 *
	 * @param instance - Scheduler to register, or null to clear
	 */
	static setInstance(instance: ConsolidationSchedulerService | null): void {
		ConsolidationSchedulerService.instance = instance;
	}

	/**
	 * Read persisted state; a missing or corrupt file yields the empty state.
	 *
	 * @returns Current state
	 */
	readState(): SelfImprovementState {
		try {
			const raw = fs.readFileSync(this.statePath, 'utf-8');
			const parsed = JSON.parse(raw) as Partial<SelfImprovementState>;
			return {
				lastConsolidationAt: typeof parsed.lastConsolidationAt === 'string' ? parsed.lastConsolidationAt : null,
				lastConsolidatedSessions: Array.isArray(parsed.lastConsolidatedSessions)
					? parsed.lastConsolidatedSessions.filter((s): s is string => typeof s === 'string')
					: [],
				lastErrors: parsed.lastErrors && typeof parsed.lastErrors === 'object' ? parsed.lastErrors : {},
			};
		} catch {
			return { lastConsolidationAt: null, lastConsolidatedSessions: [], lastErrors: {} };
		}
	}

	/**
	 * Whether the last sweep is missing or older than the interval.
	 *
	 * @returns true when a catch-up run is due
	 */
	isDue(): boolean {
		const { lastConsolidationAt } = this.readState();
		if (!lastConsolidationAt) return true;
		const last = Date.parse(lastConsolidationAt);
		if (!Number.isFinite(last)) return true;
		return this.now() - last >= this.intervalMs;
	}

	/**
	 * Arm the timers: a boot-time catch-up when due, then the periodic sweep.
	 * Timers are unref'd so they never keep the process alive on shutdown.
	 */
	start(): void {
		if (this.intervalTimer) return;

		if (this.isDue()) {
			this.logger.info('Consolidation due at boot — scheduling catch-up run', {
				delayMs: this.bootDelayMs,
			});
			this.bootTimer = setTimeout(() => {
				this.bootTimer = null;
				void this.runOnce();
			}, this.bootDelayMs);
			this.bootTimer.unref?.();
		} else {
			this.logger.debug('Consolidation not due at boot', { lastConsolidationAt: this.readState().lastConsolidationAt });
		}

		this.intervalTimer = setInterval(() => {
			void this.runOnce();
		}, this.intervalMs);
		this.intervalTimer.unref?.();
	}

	/**
	 * Clear all timers.
	 */
	stop(): void {
		if (this.bootTimer) {
			clearTimeout(this.bootTimer);
			this.bootTimer = null;
		}
		if (this.intervalTimer) {
			clearInterval(this.intervalTimer);
			this.intervalTimer = null;
		}
	}

	/**
	 * Run one sweep over every active session. Never throws; per-session
	 * failures are collected into the result and persisted state.
	 *
	 * @returns Sweep summary (null when a sweep is already in progress)
	 */
	async runOnce(): Promise<ConsolidationSweepResult | null> {
		if (this.running) {
			this.logger.debug('Consolidation sweep skipped — previous sweep still running');
			return null;
		}
		this.running = true;
		const consolidated: string[] = [];
		const failed: Record<string, string> = {};

		try {
			let sessions: string[] = [];
			try {
				sessions = Array.from(new Set(await this.listActiveSessions()));
			} catch (err) {
				this.logger.warn('Consolidation sweep could not list active sessions (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}

			for (const sessionName of sessions) {
				try {
					const report = await this.consolidate(sessionName);
					consolidated.push(sessionName);
					this.logger.debug('Consolidated agent memory', {
						sessionName,
						memoriesAnalyzed: report.memoriesAnalyzed,
						patterns: report.patterns.length,
						insights: report.insights.length,
					});
				} catch (err) {
					failed[sessionName] = err instanceof Error ? err.message : String(err);
				}
			}

			const finishedAt = new Date(this.now()).toISOString();
			this.writeState({
				lastConsolidationAt: finishedAt,
				lastConsolidatedSessions: consolidated,
				lastErrors: failed,
			});

			this.logger.info('Memory consolidation sweep finished', {
				consolidated: consolidated.length,
				failed: Object.keys(failed).length,
			});
			return { consolidated, failed, finishedAt };
		} finally {
			this.running = false;
		}
	}

	/**
	 * Persist state; a write failure is logged and swallowed.
	 *
	 * @param state - State to write
	 */
	private writeState(state: SelfImprovementState): void {
		try {
			fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
			fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
		} catch (err) {
			this.logger.warn('Failed to persist self-improvement state (non-fatal)', {
				statePath: this.statePath,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
