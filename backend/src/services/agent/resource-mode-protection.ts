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
 *    that is not done or cancelled.
 * Delegations that carry no `delegatedBy` stamp (other skills, the owner's
 * own tasks) cannot be seen; those agents are only protected by the rules above.
 *
 * @module services/agent/resource-mode-protection
 */

import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import { PENDING_WORK_STATUSES } from './idle-detection.service.js';

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
}

/**
 * Build the `protectedReason` dependency of ResourceMode.
 *
 * @param sources - WorkItem and ticket readers
 * @returns Function returning an English reason, or null when the agent may be stopped
 */
export function createProtectedReason(sources: ProtectionSources): (sessionName: string) => Promise<string | null> {
	return async (sessionName) => {
		const items = await sources.getWorkItems();
		const queued = items.find((wi) => wi.target === sessionName && PENDING_WORK_STATUSES.has(wi.status));
		if (queued) return `work item ${queued.id} is queued for it`;
		const delegated = items.find(
			(wi) => wi.metadata?.delegatedBy === sessionName && wi.target !== sessionName && OPEN_DELEGATION_STATUSES.has(wi.status),
		);
		if (delegated) return `it is waiting on work item ${delegated.id} that it delegated to ${delegated.target ?? 'a teammate'}`;
		if (sources.listTickets) {
			const tickets = await sources.listTickets(sessionName);
			const owned = tickets.find((t) => t.assignee === sessionName && OWNED_TICKET_STATUSES.has(t.status));
			if (owned) return `it owns open ticket ${owned.id} (${owned.status})`;
			const requested = tickets.find((t) => t.source === `agent:${sessionName}` && t.assignee !== sessionName && !FINISHED_TICKET_STATUSES.has(t.status));
			if (requested) return `it is waiting on ticket ${requested.id} (${requested.status}) that it created for ${requested.assignee ?? 'a teammate'}`;
		}
		return null;
	};
}
