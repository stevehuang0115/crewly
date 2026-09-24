/**
 * Restart Drain Service
 *
 * Owns the "safe restart" state of the process:
 * - a delivery pause: once shutdown starts, nothing new is written into an
 *   agent's PTY — messages stay on the persistent queues instead;
 * - the drain: wait until no agent is mid-turn, capped by a timeout, and
 *   interruptible by a second signal;
 * - restart readiness for operators (`GET /api/system/restart-readiness`);
 * - a hook through which the REST restart endpoint asks the server for the
 *   same graceful, drained shutdown a SIGTERM gets.
 *
 * "Queue empty" is not "safe to restart": a delivered message is off the
 * queue while the agent is still working on it (2026-09-24, Ella). Readiness
 * therefore reports in-flight turns, not queue depth.
 *
 * @module services/restart/restart-drain
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SAFE_RESTART } from '../../constants.js';
import { InFlightTurnTracker, type InFlightTurn } from './in-flight-turn-tracker.service.js';

/** How a drain ended. */
export type DrainOutcome = 'drained' | 'timed-out' | 'skipped' | 'disabled';

/** Result of a drain. */
export interface DrainResult {
	/** How it ended */
	outcome: DrainOutcome;
	/** Time spent waiting (ms) */
	waitedMs: number;
	/** Turns still in flight when the drain ended (to be persisted and resumed) */
	remaining: InFlightTurn[];
}

/** Options for {@link RestartDrainService.drain}. */
export interface DrainOptions {
	/** Maximum wait (ms); 0 skips the wait */
	timeoutMs: number;
	/** Re-check interval (ms) */
	pollMs?: number;
	/** Interval for the repeated "still waiting" log line (ms) */
	logIntervalMs?: number;
	/** Clock (tests) */
	now?: () => number;
	/** Sleep (tests) */
	sleep?: (ms: number) => Promise<void>;
}

/** One agent the readiness endpoint reports as busy. */
export interface BusyAgent {
	/** Agent session name */
	session: string;
	/** ISO time of the oldest open delivery */
	since: string;
	/** Preview of the most recent open delivery */
	messagePreview: string;
}

/** Body of `GET /api/system/restart-readiness`. */
export interface RestartReadiness {
	/** True when no agent is mid-turn */
	safe: boolean;
	/** Agents mid-turn */
	busyAgents: BusyAgent[];
	/** Messages waiting on the persistent queues (they survive a restart) */
	queued: number;
	/** True when a shutdown drain is already running */
	draining: boolean;
}

/** Options for a graceful shutdown requested through the service. */
export interface GracefulShutdownRequest {
	/** Why (for logs) */
	reason: string;
	/** Process exit code at the end of shutdown */
	exitCode?: number;
}

/**
 * Resolve the drain timeout from the environment.
 *
 * @param env - Environment (defaults to process.env)
 * @returns Timeout in ms; 0 disables the wait. Invalid or negative values fall back to the default.
 *
 * @example
 * ```typescript
 * resolveRestartDrainMs({ CREWLY_RESTART_DRAIN_MS: '0' }); // 0
 * resolveRestartDrainMs({}); // 120000
 * ```
 */
export function resolveRestartDrainMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[SAFE_RESTART.DRAIN_ENV_VAR];
	if (raw === undefined || raw.trim() === '') return SAFE_RESTART.DRAIN_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return SAFE_RESTART.DRAIN_TIMEOUT_MS;
	return Math.floor(parsed);
}

/**
 * Process-wide safe-restart state. Singleton.
 */
export class RestartDrainService {
	private static instance: RestartDrainService | null = null;
	private readonly logger: ComponentLogger;
	private paused = false;
	private pauseReason: string | null = null;
	private draining = false;
	private skipRequested = false;
	private wakeSleeper: (() => void) | null = null;
	private queueCounter: (() => number) | null = null;
	private shutdownHandler: ((request: GracefulShutdownRequest) => Promise<void>) | null = null;

	private constructor(private readonly tracker: InFlightTurnTracker) {
		this.logger = LoggerService.getInstance().createComponentLogger('RestartDrain');
	}

	/**
	 * Get the singleton instance.
	 *
	 * @returns The service
	 */
	static getInstance(): RestartDrainService {
		if (!RestartDrainService.instance) {
			RestartDrainService.instance = new RestartDrainService(InFlightTurnTracker.getInstance());
		}
		return RestartDrainService.instance;
	}

	/**
	 * Reset the singleton (tests only).
	 */
	static resetInstance(): void {
		RestartDrainService.instance = null;
	}

	/**
	 * Whether deliveries into agent PTYs are paused (shutdown in progress).
	 *
	 * @returns True while paused
	 */
	isDeliveryPaused(): boolean {
		return this.paused;
	}

	/**
	 * Whether the drain wait is running right now.
	 *
	 * @returns True during the wait
	 */
	isDraining(): boolean {
		return this.draining;
	}

	/**
	 * Stop writing new messages into agent PTYs. Idempotent; never undone in
	 * this process (the next boot starts unpaused).
	 *
	 * @param reason - Why (for logs)
	 */
	pauseDelivery(reason: string): void {
		if (this.paused) return;
		this.paused = true;
		this.pauseReason = reason;
		this.logger.info('Agent message delivery paused for shutdown; new messages stay queued', { reason });
	}

	/**
	 * Ask a running drain to stop waiting (second signal, supervisor escalation).
	 *
	 * @param reason - Why (for logs)
	 * @returns True if a drain was running and will now end
	 */
	requestSkip(reason: string): boolean {
		if (!this.draining) return false;
		if (!this.skipRequested) {
			this.logger.warn('Drain skipped on request; in-flight turns will be resumed after restart', { reason });
		}
		this.skipRequested = true;
		this.wakeSleeper?.();
		return true;
	}

	/**
	 * Register the counter used for `queued` in readiness.
	 *
	 * @param counter - Returns the number of messages on the persistent queues
	 */
	setQueueCounter(counter: (() => number) | null): void {
		this.queueCounter = counter;
	}

	/**
	 * Register the server's graceful-shutdown entry point.
	 *
	 * @param handler - Runs the drained shutdown and exits the process
	 */
	setShutdownHandler(handler: ((request: GracefulShutdownRequest) => Promise<void>) | null): void {
		this.shutdownHandler = handler;
	}

	/**
	 * Run the server's graceful (drained) shutdown, if one is registered.
	 *
	 * @param request - Reason and exit code
	 * @returns True if a handler was registered and has been started
	 */
	requestGracefulShutdown(request: GracefulShutdownRequest): boolean {
		if (!this.shutdownHandler) return false;
		void this.shutdownHandler(request).catch((error: unknown) => {
			this.logger.error('Graceful shutdown handler failed', {
				reason: request.reason,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return true;
	}

	/**
	 * Current restart readiness.
	 *
	 * @returns Busy agents, queued count, and whether a restart is safe now
	 */
	getReadiness(): RestartReadiness {
		const busy = this.tracker.getMidTurn();
		let queued = 0;
		try {
			queued = this.queueCounter ? this.queueCounter() : 0;
		} catch {
			queued = 0;
		}
		return {
			safe: busy.length === 0,
			busyAgents: busy.map(toBusyAgent),
			queued,
			draining: this.draining,
		};
	}

	/**
	 * Wait until no agent is mid-turn, the timeout passes, or a skip arrives.
	 * Pauses delivery first (idempotent) so the set of turns can only shrink.
	 *
	 * @param options - Timeout and test hooks
	 * @returns How it ended and the turns still in flight
	 */
	async drain(options: DrainOptions): Promise<DrainResult> {
		const now = options.now ?? Date.now;
		const pollMs = options.pollMs ?? SAFE_RESTART.DRAIN_POLL_INTERVAL_MS;
		const logIntervalMs = options.logIntervalMs ?? SAFE_RESTART.DRAIN_LOG_INTERVAL_MS;
		const sleep = options.sleep ?? null;
		const start = now();

		this.pauseDelivery(this.pauseReason ?? 'drain');

		if (options.timeoutMs <= 0) {
			const remaining = this.tracker.getMidTurn(now());
			this.logger.info('Restart drain disabled; not waiting for agents', {
				envVar: SAFE_RESTART.DRAIN_ENV_VAR,
				inFlight: remaining.map(describeTurn),
			});
			return { outcome: 'disabled', waitedMs: 0, remaining };
		}

		this.draining = true;
		let lastLogAt = -Infinity;
		let lastLoggedKey = '';
		try {
			for (;;) {
				const t = now();
				const busy = this.tracker.getMidTurn(t);
				const waitedMs = t - start;
				if (busy.length === 0) {
					this.logger.info('Restart drain complete: no agent is mid-turn', { waitedMs });
					return { outcome: 'drained', waitedMs, remaining: [] };
				}
				if (this.skipRequested) {
					this.logger.warn('Restart drain skipped; these turns will be resumed after restart', {
						waitedMs,
						interrupted: busy.map(describeTurn),
					});
					return { outcome: 'skipped', waitedMs, remaining: busy };
				}
				if (waitedMs >= options.timeoutMs) {
					this.logger.warn('Restart drain timed out; these turns will be resumed after restart', {
						waitedMs,
						timeoutMs: options.timeoutMs,
						interrupted: busy.map(describeTurn),
					});
					return { outcome: 'timed-out', waitedMs, remaining: busy };
				}
				const key = busy.map((b) => b.sessionName).join(',');
				if (key !== lastLoggedKey || t - lastLogAt >= logIntervalMs) {
					this.logger.info('Restart drain: waiting for agents to finish their current turn', {
						waitingOn: busy.map(describeTurn),
						waitedMs,
						timeoutMs: options.timeoutMs,
						hint: 'send the signal again to stop waiting',
					});
					lastLoggedKey = key;
					lastLogAt = t;
				}
				await this.sleepUnlessSkipped(sleep, Math.min(pollMs, options.timeoutMs - waitedMs));
			}
		} finally {
			this.draining = false;
			this.wakeSleeper = null;
		}
	}

	/**
	 * Sleep, but wake early when a skip is requested.
	 *
	 * @param sleep - Injected sleep (tests), or null for a cancellable timer
	 * @param ms - Duration
	 */
	private async sleepUnlessSkipped(sleep: ((ms: number) => Promise<void>) | null, ms: number): Promise<void> {
		if (this.skipRequested) return;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const wait = sleep
			? sleep(Math.max(0, ms))
			: new Promise<void>((resolve) => {
				timer = setTimeout(resolve, Math.max(0, ms));
			});
		try {
			await Promise.race([
				wait,
				new Promise<void>((resolve) => {
					this.wakeSleeper = resolve;
				}),
			]);
		} finally {
			// A skip must not leave the poll timer holding the process open.
			if (timer) clearTimeout(timer);
		}
	}
}

/**
 * Map an in-flight turn to the readiness shape.
 *
 * @param turn - Open turn
 * @returns Busy-agent entry
 */
function toBusyAgent(turn: InFlightTurn): BusyAgent {
	const newest = turn.messages[turn.messages.length - 1];
	return {
		session: turn.sessionName,
		since: new Date(turn.since).toISOString(),
		messagePreview: newest?.preview ?? '',
	};
}

/**
 * Compact log description of a turn.
 *
 * @param turn - Open turn
 * @returns Session, age and preview
 */
function describeTurn(turn: InFlightTurn): { session: string; since: string; messagePreview: string } {
	return toBusyAgent(turn);
}
