/**
 * Experiment cards API client (read-only: `GET /api/experiments`,
 * specs/experiment-cards.md). Uses `fetch` and unwraps `{ success, data }`.
 *
 * @module services/experiments.service
 */

/** Base path of the experiments API. */
export const EXPERIMENTS_API_BASE = '/api/experiments';

/** A failed experiments call, with its HTTP status (503 = experiments are not running). */
export class ExperimentsApiError extends Error {
	/**
	 * @param message - Server error text
	 * @param status - HTTP status
	 */
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = 'ExperimentsApiError';
	}
}

/** A metric over one window. */
export interface ExperimentMeasurement {
	start: string;
	end: string;
	total: number | null;
	volume: number;
}

/** An experiment card (the fields the dashboard shows). */
export interface ExperimentCard {
	id: string;
	traceId: string;
	title: string;
	hypothesis: string;
	direction: 'increase' | 'decrease';
	expected?: { from?: number; to?: number };
	metric: { source: 'gsc' | 'ga4'; measure: string; page?: string; query?: string; event?: string; channel?: string; label?: string };
	windowDays: number;
	ticket?: { kind: 'project' | 'harness'; project?: string; id: string };
	createdBy: string;
	confidence: number;
	status: 'planned' | 'running' | 'done' | 'cancelled';
	createdAt: string;
	updatedAt: string;
	shippedAt?: string;
	dueAt?: string;
	baseline?: ExperimentMeasurement;
	result?: ExperimentMeasurement;
	verdict?: 'worked' | 'didnt' | 'inconclusive';
	verdictReason?: string;
	lastError?: string;
	/** Autopilot scope (specs/2026-10-03-autopilot-experiments.md §3) */
	autopilot?: ExperimentAutopilotScope;
	timeline: Array<{ at: string; event: string; detail?: string }>;
}

/** Process numbers of a window (autopilot cards). */
export interface ExperimentProcessSummary {
	range: { start: string; end: string };
	ticketsStarted: number;
	ticketsShipped: number;
	ownerTouches: number;
	ownerTouchesPerTicket: number | null;
	stalls: number;
	stallMs: number;
	costUsd: number;
	costPerShippedTicket: number | null;
	/** No autopilot traces in the window (not zeros) */
	noData?: boolean;
}

/** An autopilot card's scope: project, label, extra outcomes, process before / after. */
export interface ExperimentAutopilotScope {
	projectId: string;
	projectName: string;
	label?: string;
	outcomes: Array<{ metric: ExperimentCard['metric']; baseline?: ExperimentMeasurement; result?: ExperimentMeasurement; verdict?: 'worked' | 'didnt' | 'inconclusive'; verdictReason?: string; lastError?: string }>;
	processBaseline?: ExperimentProcessSummary;
	processResult?: ExperimentProcessSummary;
	checkIns: number;
}

/**
 * GET an experiments endpoint and unwrap the envelope.
 *
 * @param path - Path under {@link EXPERIMENTS_API_BASE}
 * @returns The `data` field
 * @throws ExperimentsApiError with the server's message and status on failure
 */
async function get<T>(path: string): Promise<T> {
	const res = await fetch(`${EXPERIMENTS_API_BASE}${path}`);
	let body: { success?: boolean; data?: T; error?: string } = {};
	try {
		body = (await res.json()) as typeof body;
	} catch {
		body = {};
	}
	if (!res.ok || body.success === false) throw new ExperimentsApiError(body.error || `HTTP ${res.status}`, res.status);
	return body.data as T;
}

/**
 * All experiment cards.
 *
 * @returns Cards, as the backend orders them
 */
export function fetchExperiments(): Promise<ExperimentCard[]> {
	return get<ExperimentCard[]>('');
}

/**
 * One experiment card.
 *
 * @param id - `EXP-n`
 * @returns The card
 */
export function fetchExperiment(id: string): Promise<ExperimentCard> {
	return get<ExperimentCard>(`/${encodeURIComponent(id)}`);
}
