/**
 * Which agents ResourceMode must not stop to free a slot.
 *
 * Idle PTY output is not the same as "nothing to do": an agent waiting for a
 * teammate's report is silent too. An agent is protected while
 *  - a WorkItem is queued for it ({@link PENDING_WORK_STATUSES}, the same
 *    check IdleDetectionService uses),
 *  - it owns an open project ticket (assignee, ready / in_progress / review),
 *  - it delegated work that is still open: a WorkItem whose
 *    `metadata.delegatedBy` is the agent (stamped by delegate-task) and that
 *    has not finished, or a ticket created by it (`source: agent:<session>`)
 *    that is not done or cancelled,
 *  - it announced a background run (a render, a sub-agent) that is still
 *    expected (the stall watcher's record, crewly#1363).
 * The two waiting-on-a-teammate reasons (open delegation, open ticket it
 * created) lapse once the agent has been idle for SOFT_KEEP_MAX_IDLE_MS: the
 * teammate's report wakes it again, and an idle waiter must not hold a slot
 * for hours (2026-10-19: Owen and Sam held two of six slots this way).
 * Delegations that carry no `delegatedBy` stamp (other skills, the owner's
 * own tasks) cannot be seen; those agents are only protected by the rules above.
 *
 * @module services/agent/resource-mode-protection
 */

import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import { PENDING_WORK_STATUSES } from './idle-detection.service.js';
import { RESOURCE_MODE_CONSTANTS } from './resource-mode.service.js';

/** WorkItem statuses in which a delegation is still open (a worker's "done" awaits verification). */
const OPEN_DELEGATION_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>([
	'queued', 'scheduled', 'proposed', 'accepted', 'running', 'blocked', 'escalated', 'done_by_worker',
]);

/** Ticket statuses that count as work the assignee has in hand. */
const OWNED_TICKET_STATUSES: ReadonlySet<string> = new Set(['ready', 'in_progress', 'review']);

/** Ticket statuses that are finished. */
const FINISHED_TICKET_STATUSES: ReadonlySet<string> = new Set(['done', 'cancelled']);

/** The ticket fields the check reads. */
export interface ProtectionTicket {
	id: string;
	status: string;
	assignee: string | null;
	source: string | null;
}

/** Where the check reads from. */
export interface ProtectionSources {
	getWorkItems: () => Promise<WorkItem[]>;
	/** Tickets of the projects the session works on; absent when ticket storage is not up */
	listTickets?: (sessionName: string) => Promise<ProtectionTicket[]>;
	/** Number of messages queued for the session (sub-agent message queue); absent = not checked */
	queuedMessageCount?: (sessionName: string) => number;
	/** A background run the agent announced and that is still expected (stall watcher, crewly#1363); absent = not checked */
	backgroundRunReason?: (sessionName: string) => string | null;
}

/**
 * Build the `protectedReason` dependency of ResourceMode.
 *
 * @param sources - WorkItem and ticket readers
 * @returns Function `(sessionName, idleMs?)` returning an English reason, or null when the agent may be stopped
 */
export function createProtectedReason(sources: ProtectionSources): (sessionName: string, idleMs?: number) => Promise<string | null> {
	return async (sessionName, idleMs) => {
		const waitingCounts = idleMs === undefined || idleMs < RESOURCE_MODE_CONSTANTS.SOFT_KEEP_MAX_IDLE_MS;
		const messages = sources.queuedMessageCount?.(sessionName) ?? 0;
		if (messages > 0) return `${messages} message(s) are queued for it`;
		const run = sources.backgroundRunReason?.(sessionName);
		if (run) return run;
		const items = await sources.getWorkItems();
		const queued = items.find((wi) => wi.target === sessionName && PENDING_WORK_STATUSES.has(wi.status));
		if (queued) return `work item ${queued.id} is queued for it`;
		const delegated = items.find(
			(wi) => wi.metadata?.delegatedBy === sessionName && wi.target !== sessionName && OPEN_DELEGATION_STATUSES.has(wi.status),
		);
		if (delegated && waitingCounts) return `it is waiting on work item ${delegated.id} that it delegated to ${delegated.target ?? 'a teammate'}`;
		if (sources.listTickets) {
			const tickets = await sources.listTickets(sessionName);
			const owned = tickets.find((t) => t.assignee === sessionName && OWNED_TICKET_STATUSES.has(t.status));
			if (owned) return `it owns open ticket ${owned.id} (${owned.status})`;
			const requested = tickets.find((t) => t.source === `agent:${sessionName}` && t.assignee !== sessionName && !FINISHED_TICKET_STATUSES.has(t.status));
			if (requested && waitingCounts) return `it is waiting on ticket ${requested.id} (${requested.status}) that it created for ${requested.assignee ?? 'a teammate'}`;
		}
		return null;
	};
}

/**
 * Build the `waitsOn` dependency of ResourceMode: whether a waiting start
 * depends on a running agent's work. Stopping that agent to start the waiter
 * would only make the waiter wait longer (and release the very work it needs
 * back to the pool).
 *
 * The waiter depends on the candidate when the waiter delegated an open
 * WorkItem to it (`metadata.delegatedBy` = waiter, target = candidate) or
 * created an open ticket assigned to it (`source: agent:<waiter>`).
 *
 * @param sources - WorkItem and ticket readers
 * @returns Function `(waiter, candidate) => true` when the waiter is waiting on the candidate's work
 *
 * @example
 * ```typescript
 * const waitsOn = createWaitsOn({ getWorkItems: () => pool.getAllItems() });
 * await waitsOn('pia', 'dex'); // true while Dex works on a task Pia delegated
 * ```
 */
export function createWaitsOn(sources: ProtectionSources): (waiter: string, candidate: string) => Promise<boolean> {
	return async (waiter, candidate) => {
		const items = await sources.getWorkItems();
		if (items.some((wi) => wi.target === candidate && wi.metadata?.delegatedBy === waiter && OPEN_DELEGATION_STATUSES.has(wi.status))) return true;
		if (!sources.listTickets) return false;
		const tickets = await sources.listTickets(waiter);
		return tickets.some((t) => t.source === `agent:${waiter}` && t.assignee === candidate && !FINISHED_TICKET_STATUSES.has(t.status));
	};
}
