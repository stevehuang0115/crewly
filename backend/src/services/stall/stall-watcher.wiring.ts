/**
 * Stall watcher — wiring with the real requests, task pool, traces, chat,
 * teams and the owner-alert notifier (specs/2026-10-17-stall-watcher.md).
 * Process-specific hooks (how to reach an agent or the owner) come from
 * `index.ts`. The pure pieces (assignment matching, stall-signal reading,
 * message mapping) are exported for tests.
 *
 * @module services/stall/stall-watcher.wiring
 */

import path from 'path';
import { ORCHESTRATOR_SESSION_NAME, STALL_WATCHER_CONSTANTS } from '../../constants.js';
import type { Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { Request } from '../../types/v2/request.types.js';
import { readProjectTicketLink, type ProjectTicketFields } from '../../types/project-ticket.types.js';
import type { ChatMessageDTO } from '../chat-v2/types.js';
import type { TraceMetrics } from '../trace/trace-metrics.js';
import { findLeadSessionFor } from '../../utils/team.utils.js';
import { memberNameFromSession } from '../../utils/member-session-name.utils.js';
import { InFlightRunsStore } from './in-flight-runs.store.js';
import type { ClaimableMember } from './claim-check.js';
import { StallWatcherService, setStallWatcher, type StallBootGate, type StallIncomingMessage, type StallSignal, type StallThreadMessage } from './stall-watcher.service.js';

/** What the composition root provides. */
export interface StallWatcherWiringInput {
	/** CREWLY_HOME (the state file lives under it) */
	crewlyHome: string;
	getTeams: () => Promise<Team[]>;
	/** Deliver one line to an agent, waking it when stopped */
	sendToAgent: (session: string, text: string) => Promise<boolean>;
	/** One plain line to the owner (the owner-alert notifier) */
	notifyOwner: (line: string) => Promise<boolean>;
	/** Called once after the owner was told an agent's work stalled (#1387) */
	onOwnerTold?: (agent: string) => void;
	/** The boot-pressure gate */
	bootGate?: StallBootGate;
}

/** The ticket fields the assignment check reads. */
export type AssignmentTicket = Pick<ProjectTicketFields, 'id' | 'assignee' | 'source' | 'createdAt'>;

/** A harness-created source prefix on a ticket ("harness", "harness:…") */
const HARNESS_SOURCE = /^harness\b/i;

/**
 * Whether a WorkItem or ticket for `member`, made around `saidAt` by the
 * speaker or the harness, backs an "X is doing it" claim (crewly#1362).
 *
 * A WorkItem counts when its target is the member and it was created within
 * the window by the speaker (`metadata.delegatedBy` / `metadata.createdBy`),
 * by the system (`owner: 'system'`, `metadata.harnessCreated`), or — when it
 * carries no creator stamp — by anyone (a delegate-task through the API
 * without the stamp). A ticket counts when it is assigned to the member and
 * was created within the window by the speaker (`source: agent:<speaker>`)
 * or the harness, or with no source at all.
 *
 * @param input - Items, tickets and the claim
 * @returns True when something is assigned
 */
/**
 * Who takes the lead's step of the stall ladder for an agent: its team lead,
 * or the orchestrator when no lead runs on this machine (the lead is on
 * another machine, or the team has none). Owen's stalled promise went to
 * "lead: null" and nobody followed up (2026-10-22 audit).
 *
 * @param teams - Teams on this machine
 * @param session - The stalled agent
 * @returns Lead session, the orchestrator, or null for the orchestrator itself
 */
export function stallLeadFor(teams: Parameters<typeof findLeadSessionFor>[0], session: string): string | null {
	if (session === ORCHESTRATOR_SESSION_NAME) return null;
	return findLeadSessionFor(teams, session) ?? ORCHESTRATOR_SESSION_NAME;
}

export function assignmentBackedBy(input: {
	items: readonly WorkItem[];
	tickets: readonly AssignmentTicket[];
	speaker: string;
	member: string;
	saidAt: number;
	windowMs: number;
}): boolean {
	const { speaker, member, saidAt, windowMs } = input;
	const inWindow = (iso: string | undefined): boolean => {
		const t = Date.parse(iso ?? '');
		return Number.isFinite(t) && Math.abs(t - saidAt) <= windowMs;
	};
	const item = input.items.some((wi) => {
		if (wi.target !== member || !inWindow(wi.createdAt)) return false;
		const meta = wi.metadata ?? {};
		const creator = [meta.delegatedBy, meta.createdBy].find((v): v is string => typeof v === 'string' && v.length > 0);
		// Stamped by someone else: not this speaker's delegation. Unstamped (the
		// harness, or an API delegation without the stamp): counts.
		return creator ? creator === speaker : true;
	});
	if (item) return true;
	return input.tickets.some((t) => {
		if (t.assignee !== member || !inWindow(t.createdAt)) return false;
		if (!t.source) return true;
		return t.source === `agent:${speaker}` || HARNESS_SOURCE.test(t.source);
	});
}

/**
 * The ongoing stall of a trace's metrics, as the watcher reads it.
 *
 * @param metrics - Trace metrics, or null
 * @returns The signal, or null when nothing is stalled right now
 */
export function ongoingStallOf(metrics: TraceMetrics | null | undefined): StallSignal | null {
	const stall = metrics?.stalls.items.find((s) => s.ongoing);
	return stall ? { ms: stall.ms, cause: stall.cause, detail: stall.detail } : null;
}

/**
 * A chat-v2 DTO as a watcher message.
 *
 * @param dto - chat-v2 message
 * @returns Watcher message
 */
export function toStallMessage(dto: ChatMessageDTO): StallIncomingMessage {
	return {
		id: dto.id,
		channelId: dto.channelId,
		...(dto.threadId ? { threadId: dto.threadId } : {}),
		senderType: dto.senderType,
		senderId: dto.senderId,
		content: dto.content ?? '',
		createdAt: dto.createdAt,
		attachmentCount: dto.attachments?.length ?? 0,
		...(dto.metadata ? { metadata: dto.metadata } : {}),
	};
}

/**
 * WorkItems that belong to an in-progress project ticket: the ticket
 * autopilot re-briefs and releases those, the watcher leaves them alone.
 *
 * @param items - Every WorkItem
 * @returns Their ids
 */
export function ticketLinkedIds(items: readonly WorkItem[]): Set<string> {
	return new Set(items.filter((wi) => readProjectTicketLink(wi.metadata as Record<string, unknown> | undefined) !== null).map((wi) => wi.id));
}

/**
 * Members by session across teams.
 *
 * @param teams - Teams
 * @returns session → { name, teamIds }
 */
function membersBySession(teams: readonly Team[]): Map<string, { name: string; teamIds: string[] }> {
	const out = new Map<string, { name: string; teamIds: string[] }>();
	for (const t of teams) {
		for (const m of t.members ?? []) {
			if (!m.sessionName) continue;
			const cur = out.get(m.sessionName) ?? { name: m.name || memberNameFromSession(m.sessionName), teamIds: [] };
			cur.teamIds.push(t.id);
			out.set(m.sessionName, cur);
		}
	}
	return out;
}

/**
 * The teammates of a session: every member of the teams it is in, except itself.
 *
 * @param teams - Teams
 * @param session - The speaker
 * @returns Claimable members
 */
export function teammatesOf(teams: readonly Team[], session: string): ClaimableMember[] {
	const out: ClaimableMember[] = [];
	const seen = new Set<string>();
	for (const t of teams) {
		const members = t.members ?? [];
		if (!members.some((m) => m.sessionName === session)) continue;
		for (const m of members) {
			if (!m.sessionName || m.sessionName === session || seen.has(m.sessionName) || !m.name) continue;
			seen.add(m.sessionName);
			out.push({ name: m.name, session: m.sessionName });
		}
	}
	return out;
}

/**
 * Build the watcher on the real collaborators (not started).
 *
 * @param input - Composition-root hooks
 * @returns The service
 */
export async function createStallWatcher(input: StallWatcherWiringInput): Promise<StallWatcherService> {
	const { RequestService } = await import('../v3/request.service.js');
	const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
	const { getChatV2Service } = await import('../chat-v2/chat-v2.singleton.js');
	const { getTraceStore } = await import('../trace/trace-store.js');
	const { getTraceContext } = await import('../trace/trace-context.service.js');
	const { getTraceAnalysis } = await import('../trace/trace-analysis.service.js');
	const { traceHarness } = await import('../trace/trace-recorder.js');
	const { OpenItemsService } = await import('../open-items/open-items.service.js');
	const { ProjectTicketWorkflowService } = await import('../project-tickets/project-ticket-workflow.service.js');

	const pool = (): InstanceType<typeof TaskPoolService> => TaskPoolService.getInstance();
	const teams = (): Promise<Team[]> => input.getTeams().catch(() => [] as Team[]);
	const threadMessages = (ref: { channelId: string; threadId: string }): StallThreadMessage[] =>
		getChatV2Service()
			.listThreadForBridge(ref.channelId, ref.threadId)
			.map((dto) => toStallMessage(dto));
	const ticketsFor = async (session: string): Promise<AssignmentTicket[]> => {
		const workflow = ProjectTicketWorkflowService.getInstance();
		if (!workflow) return [];
		return (await workflow.listForSession(session).catch(() => [])).flatMap((p) => p.tickets);
	};

	return new StallWatcherService({
		listRequests: () => RequestService.getInstance().listAll(),
		listWorkItems: () => pool().getAllItems(),
		activeClaims: () => pool().getActiveClaims(),
		ticketLinkedWorkItemIds: async () => ticketLinkedIds(await pool().getAllItems()),
		threadMessages: async (ref) => threadMessages(ref),
		stallOf: async ({ workItemId, session }) => {
			const traceId = getTraceStore().traceByRef('workItem', workItemId) ?? getTraceContext().currentTrace(session);
			if (!traceId) return null;
			return ongoingStallOf(await getTraceAnalysis().metrics(traceId));
		},
		releaseClaim: (workItemId, reason) => pool().releaseBack(workItemId, reason, { unassign: true }),
		deliverToAgent: input.sendToAgent,
		leadOf: async (session) => stallLeadFor(await teams(), session),
		displayName: async (session) => membersBySession(await teams()).get(session)?.name ?? memberNameFromSession(session),
		notifyOwner: input.notifyOwner,
		...(input.onOwnerTold ? { onOwnerTold: input.onOwnerTold } : {}),
		recordPromiseStep: async (requestId, itemId, step, at) => {
			await OpenItemsService.getInstance()?.recordStallStep(requestId, itemId, step, at);
		},
		teammatesOf: async (session) => teammatesOf(await teams(), session),
		assignmentExists: async (speaker, member, saidAt, windowMs) =>
			assignmentBackedBy({ items: await pool().getAllItems(), tickets: await ticketsFor(member), speaker, member, saidAt, windowMs }),
		isOwnerThread: async (message) => {
			const open = OpenItemsService.getInstance();
			if (open) {
				const all: Request[] = await RequestService.getInstance().listAll();
				if (open.findRequestFor(message, all)) return true;
			}
			return threadMessages({ channelId: message.channelId, threadId: message.threadId ?? message.id }).some((m) => m.senderType === 'user');
		},
		trace: ({ session, summary, workItemId, data }) => {
			traceHarness('harness.nudge', { session, summary, ...(workItemId ? { workItemId } : {}), ...(data ? { data } : {}) });
		},
		...(input.bootGate ? { bootGate: input.bootGate } : {}),
		store: new InFlightRunsStore(path.join(input.crewlyHome, STALL_WATCHER_CONSTANTS.STATE_FILE)),
	});
}

/**
 * Create, install and start the watcher.
 *
 * @param input - Composition-root hooks
 * @returns The started service
 */
export async function startStallWatcher(input: StallWatcherWiringInput): Promise<StallWatcherService> {
	const service = await createStallWatcher(input);
	setStallWatcher(service);
	service.start();
	return service;
}
