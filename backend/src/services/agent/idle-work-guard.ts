/**
 * What keeps an idle agent from being stopped, and what happens to its work
 * when memory forces a stop anyway.
 *
 * The idle check used to spare an agent only for (a) a WorkItem waiting for
 * it (queued / proposed / accepted — not `running`) or (b) an owner message
 * or promise from the last 30 minutes. A request that never became a
 * WorkItem, a `running` item, or an assigned ticket protected nothing, so
 * Pia (2026-10-10) was stopped 30 minutes after the owner's message with the
 * owner's three videos still owed.
 *
 * @module services/agent/idle-work-guard
 * @see specs/2026-10-10-agent-follow-through.md
 */

import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import type { Request } from '../../types/v2/request.types.js';

/** WorkItem statuses that mean "this agent owes this work". */
export const HELD_WORK_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(['queued', 'proposed', 'accepted', 'running']);

/** Ticket statuses that mean the assignee still owes the owner. */
const OWED_TICKET_STATUSES: ReadonlySet<string> = new Set(['open', 'ready', 'running']);

/** Why an agent must not be idle-stopped. */
export type HoldReason = 'work_item' | 'ticket' | 'promise' | 'stated_intent';

/** What the guard reads. */
export interface IdleWorkGuardDeps {
	listWorkItems: () => Promise<WorkItem[]>;
	listTickets: () => Promise<Request[]>;
	/** An open promise or unanswered owner message in an owner thread */
	owesOwner: (session: string) => boolean;
	/** An unfulfilled "I'm doing X now" */
	holdsIntent: (session: string) => boolean;
	now?: () => number;
}

/** Tickets older than this no longer hold an agent (a forgotten ticket must not pin memory forever). */
export const TICKET_HOLD_MAX_AGE_MS = 48 * 60 * 60_000;

/**
 * Why `session` must be kept alive, or null when nothing holds it.
 *
 * @param session - Agent session
 * @param deps - Seams
 * @returns The first reason found
 */
export async function holdReasonFor(session: string, deps: IdleWorkGuardDeps): Promise<HoldReason | null> {
	if (deps.owesOwner(session)) return 'promise';
	if (deps.holdsIntent(session)) return 'stated_intent';
	const items = await deps.listWorkItems();
	if (items.some((wi) => wi.target === session && HELD_WORK_STATUSES.has(wi.status))) return 'work_item';
	const now = deps.now ? deps.now() : Date.now();
	const tickets = await deps.listTickets();
	if (
		tickets.some(
			(t) =>
				typeof t.ticketNumber === 'number' &&
				t.assignee === session &&
				OWED_TICKET_STATUSES.has(t.status) &&
				t.kind !== 'question' &&
				now - Date.parse(t.createdAt) <= TICKET_HOLD_MAX_AGE_MS,
		)
	) {
		return 'ticket';
	}
	return null;
}

/** What {@link releaseHeldWork} needs. */
export interface ReleaseWorkDeps {
	listWorkItems: () => Promise<WorkItem[]>;
	/** running → queued, owner kept (TaskPoolService.releaseBack) */
	releaseBack: (workItemId: string, reason: string) => Promise<void>;
	/** Turn an unfulfilled "doing X now" into queued work for the agent; returns its id */
	parkIntent?: (session: string) => Promise<string | null>;
}

/**
 * The agent is being stopped for memory: put its `running` WorkItems back in
 * the queue (same target) so the reconciler redelivers them when the agent
 * is next started, and park an unfulfilled stated intent as a WorkItem.
 * Never throws.
 *
 * @param session - Agent being stopped
 * @param why - Reason text for the release
 * @param deps - Seams
 * @returns Ids released or created
 */
export async function releaseHeldWork(session: string, why: string, deps: ReleaseWorkDeps): Promise<string[]> {
	const out: string[] = [];
	try {
		for (const wi of await deps.listWorkItems()) {
			if (wi.target !== session || wi.status !== 'running') continue;
			try {
				await deps.releaseBack(wi.id, why);
				out.push(wi.id);
			} catch {
				/* already moved on */
			}
		}
		const parked = await deps.parkIntent?.(session);
		if (parked) out.push(parked);
	} catch {
		/* best-effort: a failed release must not block freeing memory */
	}
	return out;
}
