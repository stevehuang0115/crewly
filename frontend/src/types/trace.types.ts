/**
 * Run trace shapes the dashboard reads (mirrors the backend's
 * `services/trace/trace.types.ts`, `trace-metrics.ts`, `trace-timeline.ts`;
 * specs/2026-10-03-autonomy-metrics.md).
 *
 * @module types/trace.types
 */

/** Who did it. */
export interface TraceActor {
	kind: 'owner' | 'agent' | 'system';
	session?: string;
}

/** How an event ended. */
export type TraceOutcome = 'ok' | 'failed' | 'blocked' | 'queued' | 'skipped' | 'info';

/** One recorded event. */
export interface TraceEvent {
	ts: string;
	traceId: string;
	type: string;
	actor: TraceActor;
	refs: Record<string, string | undefined>;
	summary: string;
	outcome: TraceOutcome;
	data?: Record<string, string | number | boolean>;
}

/** What started a trace. */
export interface TraceRoot {
	traceId: string;
	kind: 'request' | 'goal' | 'experiment' | 'owner_message' | 'autopilot' | 'ticket';
	summary: string;
	createdAt: string;
	actor: TraceActor;
	refs: Record<string, string | undefined>;
}

/** Why nothing moved during a stall. */
export type StallCause = 'runtime_quota' | 'delivery_failure' | 'waiting_on_owner' | 'waiting_on_agent' | 'nobody_pushing';

/** One stall. */
export interface TraceStall {
	start: string;
	end: string;
	ms: number;
	cause: StallCause;
	detail: string;
	sessions?: string[];
	ongoing?: boolean;
}

/** Overall state of a run. */
export type TraceOutcomeState = 'done' | 'cancelled' | 'failed' | 'waiting_on_owner' | 'in_progress' | 'no_open_work';

/** Tokens and cost of one agent or model. */
export interface UsageBreakdown {
	key: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
}

/** The autonomy metrics of one trace. */
export interface TraceMetrics {
	traceId: string;
	window: { start: string; end: string };
	eventCount: number;
	agents: string[];
	time: {
		wallMs: number;
		activeMs: number;
		waitingOwnerMs: number;
		waitingAgentMs: number;
		idleMs: number;
		activeSource: 'turn_events' | 'inferred' | 'mixed' | 'none';
	};
	ownerTouches: { answered: number; approved: number; sentBack: number; corrected: number; manual: number; total: number };
	rework: { sendBacks: number; retries: number; failedVerifications: number; subagentSendBacks: number; total: number };
	stalls: { thresholdMinutes: number; count: number; totalMs: number; byCause: Record<StallCause, number>; items: TraceStall[] };
	interventions: { nudges: number; redeliveries: number; wakes: number; corrections: number; guardBlocks: number; misroutes: number; total: number };
	usage: {
		inputTokens: number;
		cachedInputTokens: number;
		outputTokens: number;
		totalTokens: number;
		costUsd: number;
		byAgent: UsageBreakdown[];
		byModel: UsageBreakdown[];
	};
	outcome: {
		state: TraceOutcomeState;
		requestStatus?: string;
		workItems: { total: number; done: number; failed: number; open: number };
		experiment?: { id: string; status?: string; verdict?: string };
	};
}

/** One row of the timeline. */
export interface TimelineGroup {
	id: string;
	kind: 'turn' | 'owner' | 'system' | 'stall';
	session?: string;
	title: string;
	start: string;
	end: string;
	counts: { events: number; skillCalls: number; blocks: number; errors: number };
	tokens: number;
	costUsd: number;
	outcome: 'failed' | 'blocked' | 'ok';
	events: TraceEvent[];
	stall?: TraceStall;
}

/** `GET /api/traces/:id/timeline`. */
export interface TraceTimelineData {
	root: TraceRoot;
	metrics: TraceMetrics;
	groups: TimelineGroup[];
	truncated: boolean;
}

/** Entity kinds a trace can be looked up by (`GET /api/traces/by-ref`). */
export type TraceRefParam = 'workItemId' | 'ticketId' | 'requestId' | 'decisionId' | 'experimentId';
