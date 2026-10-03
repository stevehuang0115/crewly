/**
 * Deferred idle settling.
 *
 * When an agent's turn ends while it still has background work, the
 * end-of-turn settling (placeholders, DM threads, ticket submit) is skipped:
 * the work is not finished. Skipping with no recheck left placeholders up
 * forever when no further turn came (PR #1013 review). This re-checks on a
 * timer until the background work is gone, then settles once.
 *
 * - background still running → check again later (up to a cap, then settle);
 * - a new turn started → stop; that turn's own `agent:idle` settles;
 * - neither → settle now.
 *
 * @module services/monitoring/deferred-idle-settle
 */

/** Dependencies of {@link DeferredIdleSettle}. */
export interface DeferredIdleSettleDeps {
	/** True while the agent has background work after its turn */
	hasBackgroundWork: (sessionName: string) => boolean;
	/** True while the agent is mid-turn */
	isMidTurn: (sessionName: string) => boolean;
	/** The end-of-turn settling that was skipped */
	settle: (sessionName: string) => void;
	/** Re-check interval (ms) */
	intervalMs: number;
	/** Give up waiting and settle after this long (ms) */
	maxWaitMs: number;
	/** Clock (tests) */
	now?: () => number;
	/** Timer (tests) */
	setTimer?: (fn: () => void, ms: number) => unknown;
	/** Timer cancel (tests) */
	clearTimer?: (handle: unknown) => void;
}

/**
 * Re-checks skipped end-of-turn settling until it can run.
 */
export class DeferredIdleSettle {
	private readonly pending = new Map<string, { since: number; handle: unknown }>();
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;

	/**
	 * @param deps - Checks, settle action and timing
	 */
	constructor(private readonly deps: DeferredIdleSettleDeps) {
		this.now = deps.now ?? Date.now;
		this.setTimer =
			deps.setTimer ??
			((fn, ms) => {
				const t = setTimeout(fn, ms);
				t.unref?.();
				return t;
			});
		this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	/**
	 * Settling was skipped for this agent: re-check later. Idempotent.
	 *
	 * @param sessionName - Agent session
	 */
	defer(sessionName: string): void {
		const existing = this.pending.get(sessionName);
		if (existing) return;
		const since = this.now();
		this.pending.set(sessionName, { since, handle: this.setTimer(() => this.check(sessionName), this.deps.intervalMs) });
	}

	/**
	 * Stop re-checking an agent (its runtime exited).
	 *
	 * @param sessionName - Agent session
	 */
	cancel(sessionName: string): void {
		const p = this.pending.get(sessionName);
		if (!p) return;
		this.clearTimer(p.handle);
		this.pending.delete(sessionName);
	}

	/**
	 * @returns Agents waiting for a re-check
	 */
	get size(): number {
		return this.pending.size;
	}

	/**
	 * Run one re-check (exposed for tests).
	 *
	 * @param sessionName - Agent session
	 */
	check(sessionName: string): void {
		const p = this.pending.get(sessionName);
		if (!p) return;
		let background = false;
		let midTurn = false;
		try {
			background = this.deps.hasBackgroundWork(sessionName);
			midTurn = !background && this.deps.isMidTurn(sessionName);
		} catch {
			background = false;
			midTurn = false;
		}
		if (midTurn) {
			// The work came back as a new turn; its own end settles.
			this.pending.delete(sessionName);
			return;
		}
		if (background && this.now() - p.since < this.deps.maxWaitMs) {
			p.handle = this.setTimer(() => this.check(sessionName), this.deps.intervalMs);
			return;
		}
		this.pending.delete(sessionName);
		try {
			this.deps.settle(sessionName);
		} catch {
			// Settling is best-effort.
		}
	}
}
