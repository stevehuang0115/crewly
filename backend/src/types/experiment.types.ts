/**
 * Experiment cards (issue #986): a hypothesis attached to an optimisation
 * ticket, with a metric, a baseline captured when the change ships and an
 * observation window after which the harness measures it and labels it.
 *
 * specs/experiment-cards.md
 *
 * @module types/experiment.types
 */

/** Where the metric comes from (the seo-ops `metric` command). */
export type ExperimentSource = 'gsc' | 'ga4';

/** What is measured. gsc: clicks / impressions / ctr / position; ga4: sessions / events / conversions (key events). */
export type ExperimentMeasure = 'clicks' | 'impressions' | 'ctr' | 'position' | 'sessions' | 'events' | 'conversions';

/** Which way the hypothesis says the metric moves. */
export type ExperimentDirection = 'increase' | 'decrease';

/**
 * Lifecycle:
 * - `planned`: waiting for the change to ship (the linked ticket reaching done, or a ship call)
 * - `running`: shipped; baseline captured (or being retried); waiting for the window to end
 * - `done`: measured and labelled
 * - `cancelled`: stopped by a person or agent
 */
export type ExperimentStatus = 'planned' | 'running' | 'done' | 'cancelled';

/** The label a measured experiment gets. */
export type ExperimentVerdict = 'worked' | 'didnt' | 'inconclusive';

/** The metric definition. */
export interface ExperimentMetric {
  source: ExperimentSource;
  measure: ExperimentMeasure;
  /** seo-ops site config (absolute path) — property ids and credentials live there */
  config: string;
  /** gsc: page URL; ga4: landing page path (a URL is stored as its path, without query string) */
  page?: string;
  pageMatch?: 'exact' | 'contains';
  /** gsc only */
  query?: string;
  queryMatch?: 'exact' | 'contains';
  /** ga4 events: event name, e.g. `generate_lead` for the inquiry form (required); ga4 conversions: one key event (optional) */
  event?: string;
  /** ga4: channel group (default Organic Search; `all` = every channel) */
  channel?: string;
  /** Human label, e.g. "CE organic clicks" */
  label?: string;
}

/** One day of a measurement. */
export interface MeasurementDay {
  date: string;
  /** The day's value (null = no impressions that day for ctr / position) */
  value: number | null;
  /** The day's volume (impressions for gsc, the count for ga4) */
  volume: number;
  clicks?: number;
  impressions?: number;
}

/** A metric over one window, as seo-ops `metric` returns it. */
export interface Measurement {
  start: string;
  end: string;
  /** Sum (counts), ratio (ctr) or impression-weighted mean (position); null with no impressions */
  total: number | null;
  volume: number;
  clicks?: number;
  impressions?: number;
  days: MeasurementDay[];
  fetchedAt: string;
}

/** The ticket an experiment rides on. */
export interface ExperimentTicketLink {
  /** `project` = a project ticket (`<project>/.crewly/tickets`), `harness` = a TKT-n request */
  kind: 'project' | 'harness';
  /** Project id, name or path (project tickets) */
  project?: string;
  /** Ticket id (project) or TKT-n / request id (harness) */
  id: string;
}

/** One entry of an experiment's timeline (the experiment is its run's trace root). */
export interface ExperimentEvent {
  at: string;
  event: string;
  detail?: string;
}

/** An experiment card. */
export interface Experiment {
  /** EXP-n */
  id: string;
  /** Run trace of this experiment (`tr-…`, or the ticket's trace; `exp:EXP-n` only if tracing failed) */
  traceId: string;
  title: string;
  /** "change X → metric Y from a to b" */
  hypothesis: string;
  direction: ExperimentDirection;
  /** Optional numbers from the hypothesis (from a to b) */
  expected?: { from?: number; to?: number };
  metric: ExperimentMetric;
  windowDays: number;
  ticket?: ExperimentTicketLink;
  /** Agent session (or `owner`) that created it — its prediction is recorded under this session */
  createdBy: string;
  /** Confidence recorded on the prediction (0..1) */
  confidence: number;
  status: ExperimentStatus;
  createdAt: string;
  updatedAt: string;
  /** When the change went live */
  shippedAt?: string;
  /** When the result can be measured (window end + source lag) */
  dueAt?: string;
  baseline?: Measurement;
  result?: Measurement;
  verdict?: ExperimentVerdict;
  /** One line: why this verdict (numbers included) */
  verdictReason?: string;
  /** Prediction recorded for createdBy (record-prediction / resolve-prediction) */
  predictionId?: string;
  /** Consecutive failed fetches of the current step */
  fetchAttempts?: number;
  /** When the last failed fetch ran (drives the once-a-day retry after MAX_FETCH_ATTEMPTS failures) */
  lastFetchAt?: string;
  lastError?: string;
  /** Set once the owner was told a fetch is stuck (once per step) */
  stuckReported?: boolean;
  /** Set when the result was delivered to the owner (claimed just before sending, cleared if not delivered) */
  reportedAt?: string;
  /** Set when the result was written to the wiki experiment log */
  loggedAt?: string;
  timeline: ExperimentEvent[];
}

/** Persisted store. */
export interface ExperimentStoreData {
  version: 1;
  nextNumber: number;
  experiments: Experiment[];
}

/** All sources. */
export const EXPERIMENT_SOURCES: readonly ExperimentSource[] = ['gsc', 'ga4'];

/** All statuses. */
export const EXPERIMENT_STATUSES: readonly ExperimentStatus[] = ['planned', 'running', 'done', 'cancelled'];

/**
 * Is this an experiment source?
 *
 * @param v - Value
 * @returns True for gsc / ga4
 */
export function isExperimentSource(v: unknown): v is ExperimentSource {
  return typeof v === 'string' && (EXPERIMENT_SOURCES as readonly string[]).includes(v);
}

/**
 * Is this an experiment status?
 *
 * @param v - Value
 * @returns True for a known status
 */
export function isExperimentStatus(v: unknown): v is ExperimentStatus {
  return typeof v === 'string' && (EXPERIMENT_STATUSES as readonly string[]).includes(v);
}
