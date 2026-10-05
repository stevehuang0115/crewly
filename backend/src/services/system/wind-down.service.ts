/**
 * Wind-down — the step before an owner shutdown or restart.
 *
 * Tells every running agent (the orchestrator included) to reach a safe
 * point — save work, write a short handover note, start nothing new, go
 * idle — then waits until all of them are idle or the grace period ends.
 * While it runs new work is held: the restart-drain delivery pause keeps
 * every message (the owner's too) on the persistent queues, and the
 * `isWindingDown` gates stop autopilot ticks, reconciler passes, cron fires
 * and new agent starts.
 *
 * The note is delivered twice over, because an agent mid-turn may not read
 * its terminal: written to the agent (queued with owner priority when it is
 * busy) and handed over as PostToolUse `additionalContext` at its next tool
 * boundary (see {@link WindDownService.noteForHook}).
 *
 * All I/O goes through {@link WindDownDeps}. Harness text is English.
 *
 * @module services/system/wind-down
 */

import { SAFE_RESTART } from '../../constants.js';
import { RestartDrainService } from '../restart/restart-drain.service.js';

/** What the wind-down is for. */
export type WindDownKind = 'restart' | 'shutdown';

/** How the wait ended. */
export type WindDownEnd = 'idle' | 'grace' | 'skipped' | 'no-agents';

/** Where the wind-down is. */
export type WindDownPhase = 'notifying' | 'waiting' | 'done';

/** Progress the dashboard shows. */
export interface WindDownProgress {
	/** What it is for */
	kind: WindDownKind;
	/** Where it is */
	phase: WindDownPhase;
	/** ISO start time */
	startedAt: string;
	/** ISO time the grace period ends */
	deadlineAt: string;
	/** Grace period (seconds) */
	graceSeconds: number;
	/** Running agents when it started */
	total: number;
	/** Agents told so far */
	notified: string[];
	/** Agents still mid-turn */
	busy: string[];
	/** How the wait ended, once done */
	endedBy?: WindDownEnd;
}

/** I/O of the wind-down. */
export interface WindDownDeps {
	/** Sessions of every running agent (orchestrator included) */
	listAgents: () => string[];
	/** Sessions of agents mid-turn right now */
	getBusyAgents: () => string[];
	/** Write the note to one agent (queued with owner priority when busy) */
	deliver: (session: string, text: string) => Promise<unknown>;
	/** Clock */
	now: () => number;
	/** Sleep */
	sleep: (ms: number) => Promise<void>;
	/** Logger */
	logger: { info: (m: string, meta?: Record<string, unknown>) => void; warn: (m: string, meta?: Record<string, unknown>) => void };
}

/** Request to {@link WindDownService.run}. */
export interface WindDownRequest {
	/** Shutdown or restart */
	kind: WindDownKind;
	/** Grace period (seconds); clamped to 0..max, default per kind */
	graceSeconds?: number;
	/** Called on each progress change */
	onProgress?: (progress: WindDownProgress) => void;
}

/**
 * Clamp a requested grace period.
 *
 * @param kind - Shutdown or restart (picks the default)
 * @param requested - Seconds the caller asked for
 * @returns Whole seconds within 0..WIND_DOWN_MAX_GRACE_SECONDS
 *
 * @example
 * ```typescript
 * resolveGraceSeconds('restart', undefined); // 180
 * resolveGraceSeconds('shutdown', 99999); // 900
 * ```
 */
export function resolveGraceSeconds(kind: WindDownKind, requested: unknown): number {
	const fallback = kind === 'shutdown' ? SAFE_RESTART.WIND_DOWN_SHUTDOWN_GRACE_SECONDS : SAFE_RESTART.WIND_DOWN_RESTART_GRACE_SECONDS;
	if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 0) return fallback;
	return Math.min(Math.floor(requested), SAFE_RESTART.WIND_DOWN_MAX_GRACE_SECONDS);
}

/**
 * The note every agent receives (English harness text).
 *
 * @param kind - Shutdown or restart
 * @param graceSeconds - Grace period
 * @returns The note
 */
export function buildWindDownNote(kind: WindDownKind, graceSeconds: number): string {
	const minutes = Math.max(1, Math.round(graceSeconds / 60));
	const what = kind === 'shutdown' ? 'shutting down' : 'restarting';
	const after = kind === 'shutdown' ? 'when Crewly is started again' : 'right after the restart';
	return (
		`${SAFE_RESTART.WIND_DOWN_TAG} The owner asked Crewly to stop: Crewly is ${what} in about ${minutes} minute${minutes === 1 ? '' : 's'}. ` +
		'Stop at a safe point: commit or save your work, write a short handover note of where you are ' +
		'(save it to your memory so it lands in your wiki, the same handover you write when your conversation is cleared), ' +
		'do not start new long tasks, then go idle. ' +
		`Nothing is lost: messages sent to you meanwhile are kept and delivered ${after}.`
	);
}

/**
 * Process-wide wind-down. Singleton, wired once at boot.
 */
export class WindDownService {
	private static instance: WindDownService | null = null;
	private progress: WindDownProgress | null = null;
	private skipRequested = false;
	private wake: (() => void) | null = null;
	private running = false;
	/** Sessions whose note is still to be handed over at their next tool boundary */
	private readonly hookPending = new Map<string, string>();

	constructor(private readonly deps: WindDownDeps) {}

	/** @param service - The instance (null clears it) */
	static setInstance(service: WindDownService | null): void {
		WindDownService.instance = service;
	}

	/** @returns The wired instance, if any */
	static getInstance(): WindDownService | null {
		return WindDownService.instance;
	}

	/** @returns True while a wind-down runs */
	isActive(): boolean {
		return this.running;
	}

	/** @returns Current (or last) progress, or null */
	getProgress(): WindDownProgress | null {
		return this.progress ? { ...this.progress, notified: [...this.progress.notified], busy: [...this.progress.busy] } : null;
	}

	/**
	 * Stop waiting for the agents ("skip waiting"). No effect when idle.
	 *
	 * @returns True when a wind-down was running
	 */
	skip(): boolean {
		if (!this.running) return false;
		this.skipRequested = true;
		this.wake?.();
		return true;
	}

	/**
	 * The note for an agent's PostToolUse hook: once per agent per wind-down.
	 *
	 * @param session - The agent
	 * @returns The note, or null
	 */
	noteForHook(session: string): string | null {
		const note = this.hookPending.get(session);
		if (!note) return null;
		this.hookPending.delete(session);
		return note;
	}

	/**
	 * Notify every running agent, hold new work, and wait for them to go idle.
	 * Never throws; a delivery that fails is logged and the wait goes on.
	 *
	 * @param request - Kind, grace period, progress callback
	 * @returns How the wait ended
	 */
	async run(request: WindDownRequest): Promise<WindDownEnd> {
		if (this.running) return this.progress?.endedBy ?? 'grace';
		const { deps } = this;
		this.running = true;
		this.skipRequested = false;
		const graceSeconds = resolveGraceSeconds(request.kind, request.graceSeconds);
		const start = deps.now();
		const deadline = start + graceSeconds * 1000;
		const drain = RestartDrainService.getInstance();
		drain.beginWindDown(`wind-down for ${request.kind}`);
		const emit = (patch: Partial<WindDownProgress>): void => {
			this.progress = { ...(this.progress as WindDownProgress), ...patch };
			request.onProgress?.(this.getProgress() as WindDownProgress);
		};
		let agents: string[] = [];
		try {
			try {
				agents = [...new Set(deps.listAgents())];
			} catch (error) {
				deps.logger.warn('Wind-down: could not list the running agents', { error: errText(error) });
			}
			this.progress = {
				kind: request.kind,
				phase: 'notifying',
				startedAt: new Date(start).toISOString(),
				deadlineAt: new Date(deadline).toISOString(),
				graceSeconds,
				total: agents.length,
				notified: [],
				busy: [],
			};
			request.onProgress?.(this.getProgress() as WindDownProgress);
			deps.logger.info('Wind-down: notifying agents', { kind: request.kind, graceSeconds, agents });

			const note = buildWindDownNote(request.kind, graceSeconds);
			const busyNow = new Set(this.safeBusy());
			for (const session of agents) {
				// A busy agent may not read its terminal until the turn ends: the
				// note also rides its next tool boundary.
				if (busyNow.has(session)) this.hookPending.set(session, note);
				try {
					await drain.runAsWindDownNotice(() => deps.deliver(session, note));
				} catch (error) {
					deps.logger.warn('Wind-down: could not deliver the note', { session, error: errText(error) });
				}
				emit({ notified: [...(this.progress?.notified ?? []), session] });
			}

			if (agents.length === 0) {
				emit({ phase: 'done', endedBy: 'no-agents', busy: [] });
				return 'no-agents';
			}

			emit({ phase: 'waiting', busy: this.safeBusy() });
			let lastKey = '';
			for (;;) {
				const busy = this.safeBusy();
				const key = busy.join(',');
				if (key !== lastKey) {
					lastKey = key;
					emit({ busy });
					deps.logger.info('Wind-down: waiting on agents', { busy });
				}
				if (this.skipRequested) return this.finish('skipped');
				if (busy.length === 0) return this.finish('idle');
				if (deps.now() >= deadline) return this.finish('grace');
				await this.sleepOrWake(Math.min(SAFE_RESTART.WIND_DOWN_POLL_MS, Math.max(0, deadline - deps.now())));
			}
		} finally {
			this.running = false;
			this.wake = null;
			this.hookPending.clear();
		}
	}

	/** Lift the hold after a failed action (the process keeps running). */
	abort(): void {
		this.skipRequested = true;
		this.wake?.();
		this.hookPending.clear();
		RestartDrainService.getInstance().abortWindDown();
	}

	private finish(endedBy: WindDownEnd): WindDownEnd {
		const busy = this.safeBusy();
		this.progress = { ...(this.progress as WindDownProgress), phase: 'done', endedBy, busy };
		this.deps.logger.info('Wind-down finished', { endedBy, stillBusy: busy });
		return endedBy;
	}

	private safeBusy(): string[] {
		try {
			return this.deps.getBusyAgents();
		} catch {
			return [];
		}
	}

	private async sleepOrWake(ms: number): Promise<void> {
		if (this.skipRequested) return;
		await Promise.race([this.deps.sleep(ms), new Promise<void>((resolve) => { this.wake = resolve; })]);
	}
}

function errText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
