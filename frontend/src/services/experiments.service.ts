/**
 * Experiment cards API client (read-only: `GET /api/experiments`,
 * specs/experiment-cards.md). Uses `fetch` and unwraps `{ success, data }`.
 *
 * @module services/experiments.service
 */

/** Base path of the experiments API. */
export const EXPERIMENTS_API_BASE = '/api/experiments';

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
	timeline: Array<{ at: string; event: string; detail?: string }>;
}

/**
 * GET an experiments endpoint and unwrap the envelope.
 *
 * @param path - Path under {@link EXPERIMENTS_API_BASE}
 * @returns The `data` field
 * @throws Error with the server's message on failure
 */
async function get<T>(path: string): Promise<T> {
	const res = await fetch(`${EXPERIMENTS_API_BASE}${path}`);
	let body: { success?: boolean; data?: T; error?: string } = {};
	try {
		body = (await res.json()) as typeof body;
	} catch {
		body = {};
	}
	if (!res.ok || body.success === false) throw new Error(body.error || `HTTP ${res.status}`);
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
