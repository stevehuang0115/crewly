/**
 * Staggered boot restore: agents with work in hand come back one at a time
 * (each Claude Code relaunch on a loaded machine takes minutes), the owner's
 * agents first. An on-demand wake for an agent still waiting in the queue
 * moves it up instead of starting a second launch in parallel.
 *
 * @module services/agent/restore-queue
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

/** Defaults for the restore queue. */
export const RESTORE_QUEUE_CONSTANTS = {
	DEFAULT_CONCURRENCY: 1,
	MAX_CONCURRENCY: 3,
	/** Per-agent budget before the queue moves on and retries it later */
	DEFAULT_TIMEOUT_MS: 6 * 60 * 1000,
	/** Times an agent that timed out is tried again, at the back of the queue */
	MAX_RETRIES: 1,
} as const;

/** Restore priority tiers, lowest first. */
export const RESTORE_TIER = { OWNER: 1, ORCHESTRATOR: 2, LEAD: 3, OTHER: 4 } as const;

/** One agent to restore. */
export interface RestoreEntry {
	name: string;
	tier: number;
	/** Why it has this position (logged in the plan) */
	reason: string;
	/** Age of the oldest owner message waiting for it (ms epoch); orders the owner tier */
	ownerSince?: number;
	/** Start the agent; resolves when it is registered. `attempt` is 0 on the first try. */
	run: (attempt: number) => Promise<{ success: boolean }>;
	/** Called right after the agent registered */
	onReady?: () => Promise<void>;
}

/** Progress counters exposed in /health. */
export interface RestoreQueueStats {
	running: boolean;
	pending: number;
	started: number;
	ready: number;
	failed: number;
	timedOut: number;
	order: string[];
}

/**
 * Concurrency from `CREWLY_RESTORE_CONCURRENCY`, clamped to 1..3.
 *
 * @param raw - Env value
 * @returns Concurrency
 */
export function restoreConcurrencyFromEnv(raw: string | undefined = process.env.CREWLY_RESTORE_CONCURRENCY): number {
	const n = Number.parseInt(raw ?? '', 10);
	if (!Number.isFinite(n) || n < 1) return RESTORE_QUEUE_CONSTANTS.DEFAULT_CONCURRENCY;
	return Math.min(n, RESTORE_QUEUE_CONSTANTS.MAX_CONCURRENCY);
}

/**
 * Order entries: tier first; inside the owner tier, oldest owner message first.
 *
 * @param entries - Entries to order
 * @returns A new, ordered array
 */
export function orderRestoreEntries(entries: readonly RestoreEntry[]): RestoreEntry[] {
	return entries
		.map((e, i) => ({ e, i }))
		.sort((a, b) =>
			a.e.tier - b.e.tier
			|| (a.e.tier === RESTORE_TIER.OWNER ? (a.e.ownerSince ?? Infinity) - (b.e.ownerSince ?? Infinity) : 0)
			|| a.i - b.i)
		.map((x) => x.e);
}

interface Slot { entry: RestoreEntry; attempt: number; promoted: boolean }

/** The queue itself. */
export class RestoreQueue {
	private pending: Slot[] = [];
	private active = new Set<string>();
	private counters = { started: 0, ready: 0, failed: 0, timedOut: 0 };
	private running = false;
	private done: Promise<void> = Promise.resolve();
	private readonly logger: ComponentLogger;

	constructor(
		private readonly concurrency: number = restoreConcurrencyFromEnv(),
		private readonly timeoutMs: number = Number(process.env.CREWLY_RESTORE_TIMEOUT_MS) || RESTORE_QUEUE_CONSTANTS.DEFAULT_TIMEOUT_MS,
	) {
		this.logger = LoggerService.getInstance().createComponentLogger('RestoreQueue');
	}

	/**
	 * Plan and run the restore. Resolves when every entry is ready, failed or
	 * out of retries. Returns the same promise while already running.
	 *
	 * @param entries - Agents to restore
	 * @returns Promise settled when the queue is drained
	 */
	start(entries: readonly RestoreEntry[]): Promise<void> {
		if (this.running) return this.done;
		this.pending = orderRestoreEntries(entries).map((entry) => ({ entry, attempt: 0, promoted: false }));
		this.counters = { started: 0, ready: 0, failed: 0, timedOut: 0 };
		this.running = true;
		this.logger.info('Restore plan', {
			concurrency: this.concurrency,
			order: this.pending.map((s, i) => `${i + 1}. ${s.entry.name} (${s.entry.reason})`),
		});
		const workers = Array.from({ length: this.concurrency }, () => this.worker());
		this.done = Promise.all(workers).then(() => {
			this.running = false;
			this.logger.info('Restore queue drained', { ...this.counters });
		});
		return this.done;
	}

	/** Whether the agent is still waiting (not yet started) in the queue. */
	isPending(name: string): boolean {
		return this.pending.some((s) => s.entry.name === name);
	}

	/**
	 * An on-demand wake arrived for an agent. Owner-triggered wakes move it to
	 * the front (behind earlier promoted ones); other wakes keep queue order.
	 *
	 * @param name - Session name
	 * @param ownerTriggered - The wake carries an owner message
	 * @returns True when the agent is waiting in the queue (the caller must not start it)
	 */
	wake(name: string, ownerTriggered: boolean): boolean {
		const at = this.pending.findIndex((s) => s.entry.name === name);
		if (at < 0) return false;
		if (ownerTriggered && !this.pending[at].promoted) {
			const [slot] = this.pending.splice(at, 1);
			slot.promoted = true;
			const after = this.pending.reduce((n, s, i) => (s.promoted ? i + 1 : n), 0);
			this.pending.splice(after, 0, slot);
			this.logger.info('Owner wake moved agent to the front of the restore queue', { name, position: after + 1 });
		} else {
			this.logger.info('Wake for an agent waiting in the restore queue; keeping queue order', { name, ownerTriggered });
		}
		return true;
	}

	/** Progress for /health. */
	stats(): RestoreQueueStats {
		return { running: this.running, pending: this.pending.length, ...this.counters, order: this.pending.map((s) => s.entry.name) };
	}

	private async worker(): Promise<void> {
		for (;;) {
			const slot = this.pending.shift();
			if (!slot) return;
			await this.runSlot(slot);
		}
	}

	private async runSlot({ entry, attempt, promoted }: Slot): Promise<void> {
		const { name } = entry;
		this.active.add(name);
		this.counters.started++;
		this.logger.info('Restoring agent', { name, attempt, reason: entry.reason, remaining: this.pending.length });
		let timer: NodeJS.Timeout | undefined;
		const TIMEOUT = Symbol('timeout');
		try {
			const outcome = await Promise.race([
				entry.run(attempt),
				new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), this.timeoutMs); }),
			]);
			if (outcome === TIMEOUT) {
				this.counters.timedOut++;
				if (attempt < RESTORE_QUEUE_CONSTANTS.MAX_RETRIES) {
					this.logger.warn('Agent did not register in time; moving on and retrying it later', { name, timeoutMs: this.timeoutMs });
					this.pending.push({ entry, attempt: attempt + 1, promoted });
				} else {
					this.counters.failed++;
					this.logger.warn('Agent did not register after retry; giving up', { name });
				}
				return;
			}
			if (!outcome.success) {
				this.counters.failed++;
				this.logger.warn('Restore failed', { name });
				return;
			}
			this.counters.ready++;
			this.logger.info('Agent ready', { name });
			try {
				await entry.onReady?.();
			} catch (err) {
				this.logger.warn('Post-restore step failed (non-fatal)', { name, error: err instanceof Error ? err.message : String(err) });
			}
		} catch (err) {
			this.counters.failed++;
			this.logger.error('Restore threw', { name, error: err instanceof Error ? err.message : String(err) });
		} finally {
			if (timer) clearTimeout(timer);
			this.active.delete(name);
		}
	}
}

let instance: RestoreQueue | null = null;

/** The process-wide restore queue. */
export function getRestoreQueue(): RestoreQueue {
	return (instance ??= new RestoreQueue());
}

/** Test hook: drop the singleton. */
export function resetRestoreQueue(): void {
	instance = null;
}
