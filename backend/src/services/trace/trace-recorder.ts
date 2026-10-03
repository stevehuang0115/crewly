/**
 * Run trace hooks: the one-line calls the rest of the backend makes to start
 * traces, carry them onto entities, and record what happened.
 *
 * Every function here is fire-and-forget: it catches its own errors and never
 * throws, so a trace problem can never break a turn, a delivery or a request.
 *
 * specs/2026-10-03-run-traces.md
 *
 * @module services/trace/trace-recorder
 */

import type { Request } from '../../types/v2/request.types.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import { readProjectTicketLink } from '../../types/project-ticket.types.js';
import { formatTicketNumber } from '../../types/v2/ticket.types.js';
import { getTraceContext } from './trace-context.service.js';
import { appendTraceMarker, formatTraceMarker } from './trace-markers.js';
import { isTraceId, type TraceActor, type TraceEventType, type TraceOutcome, type TraceRefs } from './trace.types.js';

/**
 * Run a hook, swallowing any error.
 *
 * @param fn - The hook body
 * @param fallback - Value on error
 * @returns The hook's value, or the fallback
 */
function safely<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

/**
 * A trace id that is well-formed and known to the store.
 *
 * @param id - Candidate
 * @returns The id, or null
 */
function known(id: string | null | undefined): string | null {
	return id && isTraceId(id) && getTraceContext().store.has(id) ? id : null;
}

/**
 * Actor for an agent session (the orchestrator included).
 *
 * @param session - Session name
 * @returns Agent actor, or system when unknown
 */
function agentActor(session: string | null | undefined): TraceActor {
	return session ? { kind: 'agent', session } : { kind: 'system' };
}

// ---------------------------------------------------------------------------
// Turn context
// ---------------------------------------------------------------------------

/**
 * The trace a session's turn is on (no pending root is materialised).
 *
 * @param session - Agent session
 * @returns Trace id, or null
 */
export function currentTraceOf(session: string | null | undefined): string | null {
	return safely(() => getTraceContext().currentTrace(session), null);
}

/**
 * The trace a session's turn is on; a waiting owner message becomes a root now
 * because the turn is starting work.
 *
 * @param session - Agent session
 * @returns Trace id, or null
 */
export function ensureTraceForSession(session: string | null | undefined): string | null {
	return safely(() => getTraceContext().ensureTraceForSession(session), null);
}

/**
 * A message was written into an agent turn (PTY or in-process).
 *
 * @param session - Agent session
 * @param text - Exactly what was delivered
 * @param runtime - `pty` or `in-process`
 * @returns The trace the turn is now on, or null
 */
export function noteTurnDelivery(session: string, text: string, runtime: string = 'pty'): string | null {
	return safely(() => getTraceContext().noteTurnDelivery(session, text, runtime), null);
}

/**
 * An in-process turn failed.
 *
 * @param session - Agent session
 * @param error - What failed
 */
export function traceTurnError(session: string, error: unknown): void {
	safely(() => {
		const traceId = getTraceContext().currentTrace(session);
		if (!traceId) return;
		getTraceContext().record({
			traceId,
			type: 'turn.error',
			actor: agentActor(session),
			summary: `Turn of ${session} failed: ${error instanceof Error ? error.message : String(error)}`,
			outcome: 'failed',
			refs: { session },
		});
	}, undefined);
}

/**
 * Start a goal or experiment trace (POST /api/traces, #986 experiment cards).
 *
 * @param input - Kind, summary, who, refs, session to bind
 * @returns Trace id, or null
 */
export function startGoalTrace(input: {
	kind: 'goal' | 'experiment';
	summary: string;
	session?: string;
	refs?: TraceRefs;
}): string | null {
	return safely(
		() =>
			getTraceContext().startTrace({
				kind: input.kind,
				summary: input.summary,
				actor: input.session ? agentActor(input.session) : { kind: 'owner' },
				refs: input.refs ?? {},
				...(input.session ? { session: input.session } : {}),
			}),
		null,
	);
}

// ---------------------------------------------------------------------------
// Requests (TKT tickets) and project tickets
// ---------------------------------------------------------------------------

/**
 * Give a new Request its trace (call before its first save): an explicit or
 * creator trace, the parent ticket's trace, or a new `request` root. Sets
 * `request.traceId` and records `request.created`.
 *
 * @param request - The Request about to be saved (mutated)
 * @param opts.traceId - Trace to join (e.g. the creating agent's)
 * @param opts.creatorSession - Agent creating it, when known
 * @returns The trace id, or null
 */
export function assignRequestTrace(request: Request, opts: { traceId?: string; creatorSession?: string } = {}): string | null {
	return safely(() => {
		const ctx = getTraceContext();
		const store = ctx.store;
		const label = typeof request.ticketNumber === 'number' ? formatTicketNumber(request.ticketNumber) : undefined;
		const fromOwner = !opts.creatorSession && !!request.origin && !['agent', 'cron', 'mission', 'legacy'].includes(request.origin.channel);
		const actor: TraceActor = opts.creatorSession ? agentActor(opts.creatorSession) : fromOwner ? { kind: 'owner' } : { kind: 'system' };
		let traceId =
			known(request.traceId) ??
			known(opts.traceId) ??
			store.traceByRef('request', request.parentTicketId) ??
			ensureTraceForSession(opts.creatorSession);
		if (!traceId) {
			traceId = ctx.startTrace({
				kind: 'request',
				summary: `${label ? `${label}: ` : ''}${request.title}`,
				actor,
				refs: { requestId: request.id, ...(label ? { ticketId: label } : {}) },
			});
		}
		if (!traceId) return null;
		request.traceId = traceId;
		store.linkRef('request', request.id, traceId);
		if (label) store.linkRef('ticket', label, traceId);
		ctx.record({
			traceId,
			type: 'request.created',
			actor,
			summary: `Ticket ${label ?? request.id} created: ${request.title}`,
			refs: { requestId: request.id, ...(label ? { ticketId: label } : {}), ...(request.assignee ? { session: request.assignee } : {}) },
			data: { status: request.status, ...(request.parentTicketId ? { parentRequestId: request.parentTicketId } : {}) },
		});
		return traceId;
	}, null);
}

/** Outcome of a Request (ticket) status. */
const REQUEST_STATUS_OUTCOME: Record<string, TraceOutcome> = {
	done: 'ok',
	cancelled: 'skipped',
	waiting_confirmation: 'queued',
	blocked: 'blocked',
};

/**
 * A Request (ticket) changed status: submitted for review, accepted, sent
 * back, reopened, cancelled.
 *
 * @param request - The Request after the change
 * @param previous - Its status before
 */
export function traceRequestStatus(request: Request, previous: string): void {
	safely(() => {
		if (request.status === previous) return;
		const ctx = getTraceContext();
		const traceId = known(request.traceId) ?? ctx.store.traceByRef('request', request.id);
		if (!traceId) return;
		const label = typeof request.ticketNumber === 'number' ? formatTicketNumber(request.ticketNumber) : undefined;
		const byOwner = request.status === 'done' && request.acceptedBy === 'owner';
		ctx.record({
			traceId,
			type: 'request.status',
			actor: byOwner ? { kind: 'owner' } : { kind: 'system' },
			summary: `Ticket ${label ?? request.id} ${previous} → ${request.status}: ${request.title}`,
			outcome: REQUEST_STATUS_OUTCOME[request.status] ?? 'info',
			refs: { requestId: request.id, ...(label ? { ticketId: label } : {}) },
			data: {
				from: previous,
				to: request.status,
				...(request.acceptedBy ? { acceptedBy: request.acceptedBy } : {}),
				...(typeof request.rejectCount === 'number' ? { rejectCount: request.rejectCount } : {}),
			},
		});
	}, undefined);
}

/**
 * A project ticket was created: link it to the trace of its Request or of the
 * creating agent's turn, and record `ticket.created`.
 *
 * @param ticket - The ticket
 * @param actor - Who created it (agent session, or a non-agent label)
 * @returns The trace id, or null
 */
export function traceProjectTicketCreated(
	ticket: { id: string; title: string; requestId?: string | null; assignee?: string | null },
	actor: string,
): string | null {
	return safely(() => {
		const ctx = getTraceContext();
		const traceId = ctx.store.traceByRef('request', ticket.requestId ?? undefined) ?? ensureTraceForSession(actor);
		if (!traceId) return null;
		ctx.store.linkRef('ticket', ticket.id, traceId);
		ctx.record({
			traceId,
			type: 'ticket.created',
			actor: agentActor(actor),
			summary: `Project ticket ${ticket.id} created: ${ticket.title}`,
			refs: { ticketId: ticket.id, ...(ticket.requestId ? { requestId: ticket.requestId } : {}), ...(ticket.assignee ? { session: ticket.assignee } : {}) },
		});
		return traceId;
	}, null);
}

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

/**
 * Give a work item its trace before it is stored. Order: its own `traceId`;
 * the item it continues (parent / verify-of / source); its Request; its
 * project ticket; the creating agent's turn. Sets `workItem.traceId`.
 *
 * @param workItem - The item (mutated)
 * @param creatorSession - Agent creating it (X-Agent-Session), when known
 * @returns The trace id, or null
 */
export function assignWorkItemTrace(workItem: WorkItem, creatorSession?: string): string | null {
	return safely(() => {
		const store = getTraceContext().store;
		const meta = (workItem.metadata ?? {}) as Record<string, unknown>;
		const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
		const explicit = known(workItem.traceId) ?? known(str(meta.traceId));
		const parentTrace = [workItem.parentWorkItemId, str(meta.verifyOf), str(meta.sourceWorkItemId)]
			.map((id) => store.traceByRef('workItem', id))
			.find((id): id is string => !!id);
		const creator = creatorSession ?? str(meta.delegatedBy);
		const traceId =
			explicit ??
			parentTrace ??
			store.traceByRef('request', workItem.requestId) ??
			store.traceByRef('ticket', readProjectTicketLink(meta)?.id) ??
			ensureTraceForSession(creator);
		if (!traceId) return null;
		workItem.traceId = traceId;
		store.linkRef('workItem', workItem.id, traceId);
		return traceId;
	}, null);
}

/**
 * A work item entered the pool (PoolStorage.addWorkItem): fill in its trace if
 * the caller did not, and record `workitem.created`.
 *
 * @param workItem - The stored item (mutated when its trace is filled in)
 */
export function traceWorkItemCreated(workItem: WorkItem): void {
	safely(() => {
		const traceId = known(workItem.traceId) ?? assignWorkItemTrace(workItem);
		if (!traceId) return;
		const ctx = getTraceContext();
		ctx.store.linkRef('workItem', workItem.id, traceId);
		const meta = (workItem.metadata ?? {}) as Record<string, unknown>;
		const creator = typeof meta.delegatedBy === 'string' ? meta.delegatedBy : undefined;
		const ticketId = readProjectTicketLink(meta)?.id;
		ctx.record({
			traceId,
			type: 'workitem.created',
			actor: workItem.owner === 'system' || !creator ? { kind: 'system' } : agentActor(creator),
			summary: `Work item for ${workItem.target ?? 'anyone'}: ${workItem.title}`,
			outcome: 'queued',
			refs: {
				workItemId: workItem.id,
				...(workItem.requestId ? { requestId: workItem.requestId } : {}),
				...(ticketId ? { ticketId } : {}),
				...(workItem.target ? { session: workItem.target } : {}),
			},
			data: { type: workItem.type, status: workItem.status },
		});
	}, undefined);
}

/** Outcome of a work item status. */
const STATUS_OUTCOME: Partial<Record<WorkItemStatus, TraceOutcome>> = {
	done: 'ok',
	done_by_worker: 'ok',
	verified: 'ok',
	failed: 'failed',
	rejected: 'failed',
	blocked: 'blocked',
	escalated: 'blocked',
	cancelled: 'skipped',
	queued: 'queued',
};

/**
 * A work item changed status (PoolStorage.updateWorkItem). `running` is the
 * claim.
 *
 * @param workItem - The item after the change
 * @param previous - Its status before
 */
export function traceWorkItemStatus(workItem: WorkItem, previous: WorkItemStatus): void {
	safely(() => {
		if (workItem.status === previous) return;
		const traceId = known(workItem.traceId);
		if (!traceId) return;
		const reason = workItem.error ?? workItem.blockedReason ?? workItem.cancelReason;
		getTraceContext().record({
			traceId,
			type: 'workitem.status',
			actor: workItem.status === 'running' ? agentActor(workItem.target) : { kind: 'system' },
			summary: `Work item ${previous} → ${workItem.status}: ${workItem.title}${reason ? ` (${reason})` : ''}`,
			outcome: STATUS_OUTCOME[workItem.status] ?? 'info',
			refs: { workItemId: workItem.id, ...(workItem.target ? { session: workItem.target } : {}) },
			data: { from: previous, to: workItem.status, retryCount: workItem.retryCount },
		});
	}, undefined);
}

/**
 * The `[TRACE:…]` header line for a work item's prompt.
 *
 * @param workItem - The item
 * @returns The marker, or '' when the item has no trace
 */
export function workItemTraceMarker(workItem: Pick<WorkItem, 'traceId'>): string {
	return safely(() => (known(workItem.traceId) ? formatTraceMarker(workItem.traceId as string) : ''), '');
}

/**
 * Put a work item's trace marker in front of a hand-over message, unless it
 * is already there.
 *
 * @param message - The hand-over text
 * @param workItem - The item handed over
 * @returns The text with the header
 */
export function withWorkItemTraceHeader(message: string, workItem: Pick<WorkItem, 'traceId'>): string {
	return safely(() => {
		const marker = workItemTraceMarker(workItem);
		if (!marker || message.includes(marker)) return message;
		return `${marker}\n${message}`;
	}, message);
}

// ---------------------------------------------------------------------------
// Messages, status, decisions
// ---------------------------------------------------------------------------

/**
 * One agent messaged another through `/terminal/:to/*`: return the text with
 * the sender's trace appended so the receiving turn joins it, and record
 * `message.agent`.
 *
 * @param sender - Sending agent session
 * @param target - Receiving session
 * @param text - Message text
 * @returns The text to deliver (unchanged when the sender has no trace)
 */
export function carryAgentMessageTrace(sender: string, target: string, text: string): string {
	return safely(() => {
		if (!sender || sender === target) return text;
		const ctx = getTraceContext();
		if (ctx.resolveTracesFromText(text).length > 0) return text;
		const traceId = ensureTraceForSession(sender);
		if (!traceId) return text;
		ctx.record({
			traceId,
			type: 'message.agent',
			actor: agentActor(sender),
			summary: `${sender} → ${target}: ${text}`,
			refs: { session: target },
		});
		return appendTraceMarker(text, traceId);
	}, text);
}

/**
 * A status report was routed. Returns the trace so the routed text can carry
 * its marker.
 *
 * @param input.sender - Reporting agent
 * @param input.content - Report text
 * @param input.workItem - The work item it is about, if found
 * @param input.action - Route (`orc`, `team-lead`, `digest`, `record`)
 * @param input.target - Who receives it
 * @returns The trace id, or null
 */
export function traceStatusRouted(input: {
	sender: string;
	content: string;
	workItem?: Pick<WorkItem, 'id' | 'traceId'> | null;
	action: string;
	target?: string;
}): string | null {
	return safely(() => {
		const ctx = getTraceContext();
		const traceId = known(input.workItem?.traceId) ?? ctx.currentTrace(input.sender);
		if (!traceId) return null;
		ctx.record({
			traceId,
			type: 'status.routed',
			actor: agentActor(input.sender),
			summary: `Status from ${input.sender} → ${input.target ?? input.action}: ${input.content}`,
			outcome: input.action === 'record' || input.action === 'digest' ? 'queued' : 'ok',
			refs: { ...(input.workItem?.id ? { workItemId: input.workItem.id } : {}), ...(input.target ? { session: input.target } : {}) },
			data: { route: input.action },
		});
		return traceId;
	}, null);
}

/**
 * Append the trace marker to a routed status text.
 *
 * @param text - Status text
 * @param traceId - Trace (no-op when null)
 * @returns The text with the marker last
 */
export function withTraceMarker(text: string, traceId: string | null): string {
	return safely(() => appendTraceMarker(text, traceId), text);
}

/** What the reply resolver did with an agent message (subset of ReplyDelivery). */
export interface OutboundReplyResult {
	ok: boolean;
	error?: string;
	messageId?: string;
	conversationId?: string;
	slackChannelId?: string;
	messageTs?: string;
	destination?: { kind?: string; source?: string };
}

/**
 * The reply resolver (#954) delivered or refused an agent message.
 *
 * @param input.session - Agent
 * @param input.content - Message text
 * @param input.reference - The reference it named (ticket / work item / decision / message)
 * @param result - The delivery
 */
export function traceOutboundReply(
	input: { session: string; content: string; reference?: { messageId?: string; ticket?: string; workItemId?: string; decisionId?: string } },
	result: OutboundReplyResult,
): void {
	safely(() => {
		const ctx = getTraceContext();
		const ref = input.reference ?? {};
		const traceId =
			ctx.store.traceByRef('workItem', ref.workItemId) ??
			ctx.store.traceByRef('decision', ref.decisionId) ??
			ctx.store.traceByRef('ticket', ref.ticket) ??
			ctx.currentTrace(input.session);
		if (!traceId) return;
		const where = result.conversationId
			? `conversation ${result.conversationId}`
			: result.slackChannelId
				? `Slack ${result.slackChannelId}`
				: (result.destination?.kind ?? 'nowhere');
		ctx.record({
			traceId,
			type: 'message.outbound',
			actor: agentActor(input.session),
			summary: result.ok ? `${input.session} → ${where}: ${input.content}` : `Message from ${input.session} not delivered: ${result.error ?? 'unknown reason'}`,
			outcome: result.ok ? 'ok' : 'failed',
			refs: {
				session: input.session,
				...(result.messageId ? { messageId: result.messageId } : result.messageTs ? { messageId: result.messageTs } : {}),
				...(ref.ticket ? { ticketId: ref.ticket } : {}),
				...(ref.workItemId ? { workItemId: ref.workItemId } : {}),
				...(ref.decisionId ? { decisionId: ref.decisionId } : {}),
			},
			data: { ...(result.destination?.source ? { source: result.destination.source } : {}), ...(result.destination?.kind ? { destination: result.destination.kind } : {}) },
		});
	}, undefined);
}

/** Outcome of a decision status. */
const DECISION_OUTCOME: Record<string, TraceOutcome> = {
	resolved: 'ok',
	defaulted: 'info',
	parked: 'blocked',
	cancelled: 'skipped',
	expired: 'skipped',
	skipped: 'skipped',
};

/**
 * A decision card was asked: link it to the trace of its work item, Request,
 * project ticket or asker's turn, and record `decision.created`.
 *
 * @param decision - The stored decision
 */
export function traceDecisionCreated(decision: OwnerDecision): void {
	safely(() => {
		const ctx = getTraceContext();
		const store = ctx.store;
		const traceId =
			store.traceByRef('workItem', decision.workItemId) ??
			store.traceByRef('request', decision.requestRef?.requestId) ??
			store.traceByRef('ticket', decision.ticket?.id) ??
			(decision.requestedBy === 'crewly' ? null : ensureTraceForSession(decision.asker));
		if (!traceId) return;
		store.linkRef('decision', decision.id, traceId);
		ctx.record({
			traceId,
			type: 'decision.created',
			actor: decision.requestedBy === 'crewly' ? { kind: 'system' } : agentActor(decision.asker),
			summary: `Decision ${decision.id} asked: ${decision.question}`,
			outcome: 'queued',
			refs: {
				decisionId: decision.id,
				session: decision.asker,
				...(decision.workItemId ? { workItemId: decision.workItemId } : {}),
				...(decision.ticket?.id ? { ticketId: decision.ticket.id } : {}),
			},
			data: { ...(decision.kind ? { kind: decision.kind } : {}), ...(decision.sensitive ? { sensitive: decision.sensitive } : {}) },
		});
	}, undefined);
}

/**
 * A decision changed state (answered, defaulted, cancelled, …).
 *
 * @param previous - Before
 * @param next - After
 */
export function traceDecisionChanged(previous: Pick<OwnerDecision, 'status'>, next: OwnerDecision): void {
	safely(() => {
		if (previous.status === next.status) return;
		const ctx = getTraceContext();
		const traceId = ctx.store.traceByRef('decision', next.id);
		if (!traceId) return;
		ctx.record({
			traceId,
			type: 'decision.status',
			actor: next.status === 'resolved' || next.status === 'skipped' ? { kind: 'owner' } : { kind: 'system' },
			summary: `Decision ${next.id} ${previous.status} → ${next.status}${next.chosenKey ? ` (${next.chosenKey})` : ''}${next.closedReason ? `: ${next.closedReason}` : ''}`,
			outcome: DECISION_OUTCOME[next.status] ?? 'info',
			refs: { decisionId: next.id, session: next.asker },
			data: {
				from: previous.status,
				to: next.status,
				...(next.answeredVia ? { via: next.answeredVia } : {}),
				...(next.chosenKey ? { chosenKey: next.chosenKey } : {}),
			},
		});
	}, undefined);
}

// ---------------------------------------------------------------------------
// Harness interventions and usage
// ---------------------------------------------------------------------------

/** Input of {@link traceHarness}. */
export interface HarnessEventInput {
	/** Session acted on */
	session?: string;
	workItemId?: string;
	workItem?: Pick<WorkItem, 'id' | 'traceId'> | null;
	/** Trace, when the caller knows it */
	traceId?: string | null;
	summary: string;
	outcome?: TraceOutcome;
	data?: Record<string, unknown>;
}

/**
 * The harness intervened (redelivery, wake, correction, nudge, guard block):
 * record it in the trace of the work item, else of the session's turn.
 *
 * @param type - Event type
 * @param input - What and on whom
 * @returns True when recorded
 */
export function traceHarness(type: Extract<TraceEventType, `harness.${string}` | 'guard.block'>, input: HarnessEventInput): boolean {
	return safely(() => {
		const ctx = getTraceContext();
		const workItemId = input.workItem?.id ?? input.workItemId;
		const traceId =
			known(input.traceId) ??
			known(input.workItem?.traceId) ??
			ctx.store.traceByRef('workItem', workItemId) ??
			ctx.currentTrace(input.session);
		if (!traceId) return false;
		return ctx.record({
			traceId,
			type,
			actor: { kind: 'system' },
			summary: input.summary,
			outcome: input.outcome ?? 'info',
			refs: { ...(workItemId ? { workItemId } : {}), ...(input.session ? { session: input.session } : {}) },
			...(input.data ? { data: input.data } : {}),
		});
	}, false);
}

/** A token-ledger entry (subset of TokenUsageEvent). */
export interface UsageEntry {
	timestamp: string;
	input: number;
	output: number;
	model: string;
	cachedInput?: number;
	runtime?: string;
}

/**
 * A token-ledger entry was recorded: find the trace the session was on at
 * that time, record `usage`, and return the id to stamp on the entry.
 *
 * @param session - Agent session
 * @param entry - The usage
 * @returns Trace id, or null
 */
export function traceUsage(session: string, entry: UsageEntry): string | null {
	return safely(() => {
		const ctx = getTraceContext();
		const at = Date.parse(entry.timestamp);
		const traceId = ctx.traceAt(session, Number.isFinite(at) ? at : undefined);
		if (!traceId) return null;
		ctx.record({
			traceId,
			type: 'usage',
			actor: agentActor(session),
			summary: `${session} used ${entry.input + entry.output} tokens (${entry.model})`,
			refs: { session },
			data: {
				input: entry.input,
				output: entry.output,
				model: entry.model,
				...(entry.cachedInput !== undefined ? { cachedInput: entry.cachedInput } : {}),
				...(entry.runtime ? { runtime: entry.runtime } : {}),
			},
			...(Number.isFinite(at) ? { at: new Date(at) } : {}),
		});
		return traceId;
	}, null);
}
