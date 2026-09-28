/**
 * WorkItemWorktreeSubscriber — wires {@link WorkItemWorktreeService} to
 * WorkItem lifecycle events (#814).
 *
 * It only OBSERVES transitions. It never writes a WorkItem status, adds no
 * transition edge and takes no actor-gated action, so it is independent of
 * the transition-permission table (#813/#819) and of the coordinator: the
 * events are published by TaskPoolService on whatever path (reconciler,
 * HTTP, auto-claim) made the transition.
 *
 * | Signal | Action |
 * |---|---|
 * | `workitem:queued` with a target | pre-create the worktree (in the background) |
 * | TaskPoolService claim listener | create it if not there yet (untargeted pool items) |
 * | `task:done_by_worker`, `task:done` | "worked outside its worktree?" detector (report only) |
 * | `task:done`, `task:verified`, `task:cancelled` | cleanup (guarded; may keep) |
 * | interval | orphan sweep |
 *
 * `task:rejected` is ignored on purpose: rejected work comes back for rework.
 *
 * @module services/worktree/workitem-worktree.subscriber
 */

import axios from 'axios';
import { WORKTREE_CONSTANTS } from '../../constants.js';
import { getLocalApiBaseUrl } from '../../utils/local-api-url.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import type { WorkItemWorktreeService, CleanupReason } from './workitem-worktree.service.js';

/** The event-bus surface used. */
export interface WorktreeEventSource {
	onInProcess(types: EventType | EventType[], handler: (event: AgentEvent) => void | Promise<void>): () => void;
}

/** The pool surface used. */
export interface WorktreeClaimSource {
	findWorkItem(workItemId: string): Promise<WorkItem | null>;
	onClaimed(listener: (workItem: WorkItem, agentId: string) => void | Promise<void>): () => void;
}

/** Construction options. */
export interface WorktreeSubscriberOptions {
	service: Pick<WorkItemWorktreeService, 'ensureWorktree' | 'detectWorkedOutside' | 'cleanup' | 'sweep'>;
	events: WorktreeEventSource;
	pool: WorktreeClaimSource;
	/** Sweep interval (default `WORKTREE_CONSTANTS.SWEEP_INTERVAL_MS`); 0 disables the timer. */
	sweepIntervalMs?: number;
}

const CLEANUP_BY_EVENT: Partial<Record<string, CleanupReason>> = {
	'task:done': 'done',
	'task:verified': 'verified',
	'task:cancelled': 'cancelled',
};

/**
 * Subscribes the worktree service to WorkItem events.
 */
export class WorkItemWorktreeSubscriber {
	private readonly logger: ComponentLogger;
	private readonly unsubscribers: Array<() => void> = [];
	private timer: NodeJS.Timeout | null = null;
	/** Handlers still running (tests await {@link idle}). */
	private readonly pending = new Set<Promise<unknown>>();

	constructor(private readonly options: WorktreeSubscriberOptions) {
		this.logger = LoggerService.getInstance().createComponentLogger('WorkItemWorktreeSubscriber');
	}

	/** Subscribe and start the sweep timer. Idempotent. */
	start(): void {
		if (this.unsubscribers.length) return;
		const { events, pool, service } = this.options;

		this.unsubscribers.push(
			events.onInProcess('workitem:queued', (event) => {
				this.track(async () => {
					const wi = event.workItemId ? await pool.findWorkItem(event.workItemId) : null;
					// No terminal notify here — WorkItemDispatchSubscriber's
					// resolveHint() already puts the workdir in the FIRST
					// [CREWLY-DISPATCH] brief for this same event; a second,
					// separate message is redundant at best (Sam, #829 review).
					if (wi?.target) await service.ensureWorktree(wi, { notify: false });
				}, 'pre-create');
			}),
		);
		this.unsubscribers.push(
			pool.onClaimed((wi) => {
				this.track(() => service.ensureWorktree(wi), 'create-on-claim');
			}),
		);
		this.unsubscribers.push(
			events.onInProcess(['task:done_by_worker', 'task:done', 'task:verified', 'task:cancelled'], (event) => {
				const id = event.workItemId;
				if (!id) return;
				this.track(async () => {
					if (event.type === 'task:done_by_worker' || event.type === 'task:done') await service.detectWorkedOutside(id);
					const reason = CLEANUP_BY_EVENT[event.type];
					if (reason) await service.cleanup(id, reason);
				}, event.type);
			}),
		);

		const interval = this.options.sweepIntervalMs ?? WORKTREE_CONSTANTS.SWEEP_INTERVAL_MS;
		if (interval > 0) {
			this.timer = setInterval(() => this.track(() => service.sweep(), 'sweep'), interval);
			this.timer.unref?.();
		}
	}

	/** Unsubscribe and stop the timer. */
	stop(): void {
		for (const u of this.unsubscribers.splice(0)) u();
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** Resolves when every handler started so far has finished (tests). */
	async idle(): Promise<void> {
		while (this.pending.size) await Promise.allSettled([...this.pending]);
	}

	/** Run a handler in the background; log, never throw. */
	private track(fn: () => Promise<unknown>, what: string): void {
		const p = fn()
			.catch((err) => {
				this.logger.warn('Worktree handler failed (non-fatal)', { what, error: err instanceof Error ? err.message : String(err) });
			})
			.finally(() => this.pending.delete(p));
		this.pending.add(p);
	}
}

/** Caller identity sent with terminal writes. */
const NOTIFIER_SESSION = 'WorkItemWorktree';
/** Terminal write timeout. */
const NOTIFY_TIMEOUT_MS = 5_000;

/**
 * A notifier that writes a message into an agent's terminal through the
 * local API — the same route WorkItemDispatchSubscriber uses.
 *
 * @returns `(sessionName, message) => Promise<void>`; rejects on HTTP failure
 */
export function createTerminalNotifier(): (sessionName: string, message: string) => Promise<void> {
	return async (sessionName, message) => {
		await axios.post(
			`${getLocalApiBaseUrl()}/api/terminal/${encodeURIComponent(sessionName)}/write`,
			{ data: message, mode: 'message' },
			{ headers: { 'X-Agent-Session': NOTIFIER_SESSION }, timeout: NOTIFY_TIMEOUT_MS },
		);
	};
}
