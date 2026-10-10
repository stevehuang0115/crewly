/**
 * Ticket work guard: an owner request is a tracked deliverable.
 *
 * When an agent ends its turn and a ticket assigned to it has no WorkItem,
 * the harness creates one — assigned to that agent, linked to the ticket,
 * with the owner's words as the brief. The WorkItem is what the active-work
 * briefing, the idle-stop check and the reconciler's redelivery all look at;
 * without it a promise to the owner lives only in the agent's context
 * (2026-10-10: "make three videos" was never a deliverable; one attempt was
 * made, the owner asked 2h45m later).
 *
 * A request that lists several deliverables also gets a checklist on the
 * ticket (its acceptance criteria), so partial delivery shows as "1 of 3".
 *
 * @module services/v3/ticket-work-guard
 * @see specs/2026-10-10-agent-follow-through.md
 */

import type { Request } from '../../types/v2/request.types.js';
import { TERMINAL_REQUEST_STATUSES } from '../../types/v2/request.types.js';
import { activeAcceptance, formatTicketNumber } from '../../types/v2/ticket.types.js';
import { createWorkItem, type WorkItem } from '../../types/v2/work-item.types.js';
import { detectStatedIntent, extractDeliverables } from '../agent/stated-intent.js';

/** Metadata marker on WorkItems this guard created. */
export const TICKET_FOLLOW_THROUGH_MARKER = 'ticket-follow-through';

/** Tickets older than this are not picked up (a stale ticket is not "just asked") */
export const TICKET_WORK_MAX_AGE_MS = 24 * 60 * 60_000;

const OPEN_TICKET_STATUSES: ReadonlySet<string> = new Set(['open', 'ready', 'running']);

/** What the guard needs from the rest of the backend. */
export interface TicketWorkGuardDeps {
	listTickets: () => Promise<Request[]>;
	listWorkItems: () => Promise<WorkItem[]>;
	/** Add to the pool (links the WorkItem to its Request, stamps the owner thread) */
	addWorkItem: (workItem: WorkItem, creatorSession: string) => Promise<void>;
	/** Write the checklist onto the ticket */
	setChecklist: (ticketId: string, items: ReadonlyArray<{ text: string }>) => Promise<unknown>;
	/** Whether the agent holds an unfulfilled stated intent */
	holdsIntent: (agent: string) => boolean;
	/** When the agent last posted a non-intent reply to the owner */
	lastRealReplyAt: (agent: string) => number | undefined;
	/** The tickets' team, to route the WorkItem like other team work */
	teamIdOf?: (agent: string) => string | undefined;
	now?: () => number;
}

/** Result for one ticket the guard acted on. */
export interface TicketWorkCreated {
	ticketId: string;
	workItemId: string;
	checklist: number;
}

/**
 * The brief an agent gets for a ticket the harness turned into work.
 *
 * @param ticket - The ticket
 * @param deliverables - Checklist items, when the request lists several
 * @returns Markdown brief (internal: never shown to the owner)
 */
export function buildTicketWorkBrief(ticket: Request, deliverables: readonly string[]): string {
	const num = typeof ticket.ticketNumber === 'number' ? formatTicketNumber(ticket.ticketNumber) : ticket.id;
	const lines = [
		`The owner asked for this (tracked as ${num}; internal reference, do not mention it to the owner):`,
		'',
		...ticket.description.trim().split('\n').map((l) => `> ${l}`),
	];
	if (deliverables.length >= 2) {
		lines.push('', `This asks for ${deliverables.length} separate deliverables. Deliver each one, and after each is delivered record it:`);
		deliverables.forEach((d, i) => lines.push(`${i}. ${d}`));
		lines.push('', `Record a delivered item with: ticket-check --ticket ${num} --index <n> --result pass --evidence "<what you sent and where>"`);
	}
	lines.push(
		'',
		'Crewly created this work item because your turn ended without one for this request. Start it now; reply to the owner when there is a result or a real blocker.',
	);
	return lines.join('\n');
}

/**
 * Create a WorkItem for each open ticket assigned to `agent` that has none
 * and is not already answered.
 *
 * A ticket is skipped when it is a pure question, needs no review (cron /
 * mission / communication), is older than a day, is not open, already has a
 * WorkItem (linked or in the pool), or was answered with a real reply and
 * lists only one deliverable and the agent holds no unfulfilled promise.
 *
 * @param agent - The agent whose turn ended
 * @param deps - Seams
 * @returns What was created
 */
export async function ensureTicketWorkItems(agent: string, deps: TicketWorkGuardDeps): Promise<TicketWorkCreated[]> {
	const now = deps.now ? deps.now() : Date.now();
	const tickets = (await deps.listTickets()).filter(
		(t) =>
			typeof t.ticketNumber === 'number' &&
			t.assignee === agent &&
			OPEN_TICKET_STATUSES.has(t.status) &&
			!TERMINAL_REQUEST_STATUSES.has(t.status) &&
			t.kind !== 'question' &&
			t.requiresConfirmation === true &&
			now - Date.parse(t.createdAt) <= TICKET_WORK_MAX_AGE_MS,
	);
	if (tickets.length === 0) return [];
	const pool = await deps.listWorkItems();
	const out: TicketWorkCreated[] = [];
	// Newest first, at most a few per turn end: a burst is one conversation, not many jobs.
	for (const t of tickets.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 3)) {
		if ((t.workItemIds?.length ?? 0) > 0 || pool.some((wi) => wi.requestId === t.id)) continue;
		const deliverables = extractDeliverables(t.description);
		const replyAt = deps.lastRealReplyAt(agent);
		const answeredByReply = !!t.reply && !detectStatedIntent(t.reply.excerpt);
		const answered = answeredByReply || (replyAt !== undefined && replyAt >= Date.parse(t.createdAt));
		if (answered && deliverables.length < 2 && !deps.holdsIntent(agent)) continue;

		const wi = createWorkItem({
			type: 'delegate',
			owner: 'agent',
			target: agent,
			title: t.title,
			description: t.description.length > 600 ? `${t.description.slice(0, 599)}…` : t.description,
			briefMarkdown: buildTicketWorkBrief(t, deliverables),
			requestId: t.id,
			metadata: {
				harnessCreated: TICKET_FOLLOW_THROUGH_MARKER,
				ticketNumber: t.ticketNumber,
				...(deps.teamIdOf?.(agent) ? { teamId: deps.teamIdOf(agent) } : {}),
			},
		});
		await deps.addWorkItem(wi, agent);
		let checklist = 0;
		if (deliverables.length >= 2 && activeAcceptance(t.acceptance).length === 0) {
			await deps.setChecklist(t.id, deliverables.map((text) => ({ text }))).catch(() => undefined);
			checklist = deliverables.length;
		}
		out.push({ ticketId: t.id, workItemId: wi.id, checklist });
	}
	return out;
}

/**
 * "N of M delivered" for a ticket's checklist (criteria the agent marked
 * `pass`), or null when it lists fewer than two.
 *
 * @param ticket - The ticket
 * @returns Counts, or null
 */
export function checklistProgress(ticket: Pick<Request, 'acceptance'>): { delivered: number; total: number } | null {
	const live = activeAcceptance(ticket.acceptance);
	if (live.length < 2) return null;
	return { delivered: live.filter((a) => a.selfCheck === 'pass').length, total: live.length };
}
