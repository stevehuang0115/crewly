/**
 * Experiment cards (issue #986, epic #982).
 *
 * An optimisation ticket carries an experiment: a hypothesis ("change X →
 * metric Y from a to b"), a metric (Search Console / GA4 through the seo-ops
 * skill), a baseline captured when the change ships and an observation
 * window (default 14 days). When the window has settled the harness fetches
 * the metric, labels the result worked / didn't / inconclusive (simple
 * significance rules plus a minimum volume, see experiment-verdict.ts),
 * resolves the agent's prediction, appends the result to the wiki
 * experiment log and tells the owner.
 *
 * The experiment is a trace root: `traceId` (a run trace, `tr-…`; the ticket's
 * trace when its ticket already has one) names the run, and
 * the timeline records every step (created, shipped, baseline, each fetch
 * failure, measured, logged, reported), so the whole run can be reviewed.
 *
 * State: `~/.crewly/experiments.json`. A tick (every 15 min) moves
 * experiments forward, so restarts lose nothing.
 *
 * specs/experiment-cards.md
 *
 * @module services/experiments/experiment.service
 */

import { promises as fs } from 'fs';
import path from 'path';
import { EXPERIMENT_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { atomicWriteFile, readJsonStore } from '../../utils/file-io.utils.js';
import {
  isExperimentSource,
  isExperimentStatus,
  type Experiment,
  type ExperimentAutopilotScope,
  type ExperimentOutcome,
  type ExperimentProcessSummary,
  type ExperimentDirection,
  type ExperimentMeasure,
  type ExperimentMetric,
  type ExperimentStatus,
  type ExperimentStoreData,
  type ExperimentTicketLink,
  type Measurement,
} from '../../types/experiment.types.js';
import { decideVerdict, defaultDirection, experimentWindows, formatValue, type DateRange } from './experiment-verdict.js';
import { startExperimentTrace, traceExperimentEvent } from '../trace/trace-recorder.js';
import type { MetricFetcher } from './seo-ops-metric.fetcher.js';

/** A notice for the owner (same shape as the ticket autopilot's). */
export interface ExperimentOwnerNotice {
  title: string;
  message: string;
  urgent: boolean;
}

/** The prediction calls the service makes (record-prediction / resolve-prediction). */
export interface ExperimentPredictions {
  make(session: string, statement: string, confidence: number, resolveBy: string): Promise<{ id: string }>;
  resolve(session: string, id: string, outcome: string, accurate: boolean): Promise<unknown>;
}

/**
 * Whether the linked ticket is done and when. `at` is null when the ticket is
 * done but the time of its done transition is not recorded.
 */
export type TicketShipState = { done: false } | { done: true; at: string | null };

/** The ticket autopilot as an experiment sees it (specs/2026-10-03-autopilot-experiments.md §3). */
export interface ExperimentAutopilotSource {
  /** A project by id / name / path; throws when unknown */
  resolveProject(ref: string): Promise<{ id: string; name: string }>;
  /** The autopilot's process numbers over a window (local days, inclusive) */
  process(projectId: string, label: string | null, range: DateRange): Promise<ExperimentProcessSummary>;
}

/** Dependencies. */
export interface ExperimentServiceDeps {
  /** JSON store */
  storeFile: string;
  /** Fetch a metric over a window (seo-ops) */
  fetchMetric: MetricFetcher;
  /** Whether the linked ticket shipped, dated by its done transition (never its updatedAt) */
  ticketShipState?: (link: ExperimentTicketLink) => Promise<TicketShipState>;
  /** Note the experiment on its ticket (best effort) */
  noteOnTicket?: (link: ExperimentTicketLink, note: string) => Promise<void>;
  predictions?: ExperimentPredictions;
  /** Append a result to the wiki experiment log; false = not written (no vault) */
  writeLog?: (experiment: Experiment, entry: string) => Promise<boolean>;
  /** Tell the owner; false = not sent (Slack not connected) */
  notifyOwner?: (notice: ExperimentOwnerNotice) => Promise<boolean>;
  /** Tell an agent (the card's creator); false = not delivered */
  notifyAgent?: (session: string, text: string) => Promise<boolean>;
  /** Does a file exist (the seo-ops config) */
  fileExists?: (file: string) => Promise<boolean>;
  /** Ticket autopilot stats (autopilot-scoped cards); absent = such cards are refused */
  autopilot?: ExperimentAutopilotSource;
  now?: () => Date;
  logger?: ComponentLogger;
}

/** Input of {@link ExperimentService.create}. */
export interface CreateExperimentInput {
  title?: unknown;
  hypothesis?: unknown;
  direction?: unknown;
  expected?: unknown;
  metric?: unknown;
  windowDays?: unknown;
  ticket?: unknown;
  confidence?: unknown;
  /** When the change went live (ISO). Required when the linked ticket is already done with no recorded done time. */
  shippedAt?: unknown;
  /** Autopilot scope `{ project, label? }`: the card measures a period of autopilot work */
  autopilot?: unknown;
  /** Extra outcome metrics (autopilot scope), each like `metric`; `config` defaults to the primary's */
  metrics?: unknown;
  /** Autopilot scope: when the period starts (ISO, not in the future; default: now) */
  startedAt?: unknown;
}

/** An error with an HTTP status. */
export class ExperimentError extends Error {
  /**
   * @param status - HTTP status
   * @param message - What went wrong
   */
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ExperimentError';
  }
}

/**
 * A ship time: a valid ISO instant that is not in the future.
 *
 * @param raw - Value
 * @param now - Current time
 * @returns ISO time
 * @throws ExperimentError(400)
 */
function parseShipTime(raw: string, now: Date): string {
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new ExperimentError(400, 'shippedAt must be an ISO time');
  if (t > now.getTime()) throw new ExperimentError(400, 'shippedAt is in the future');
  return new Date(t).toISOString();
}

/**
 * Error text.
 *
 * @param err - Anything thrown
 * @returns Message
 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A local calendar day (the autopilot's days; the budget resets at local midnight).
 *
 * @param d - Time
 * @returns YYYY-MM-DD
 */
export function localDay(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The process windows of an autopilot card, in local days: the observation
 * window starts ON the start day (the autopilot works that day too), the
 * baseline is the equal window right before it.
 *
 * @param startedAt - When the card started (ISO)
 * @param windowDays - Days per window
 * @returns Baseline, observation, and when the observation window is over
 */
export function processWindows(startedAt: string, windowDays: number): { baseline: DateRange; observation: DateRange; dueAtMs: number } {
  const t = new Date(startedAt);
  const at = (delta: number): Date => new Date(t.getFullYear(), t.getMonth(), t.getDate() + delta, 12);
  return {
    baseline: { start: localDay(at(-windowDays)), end: localDay(at(-1)) },
    observation: { start: localDay(at(0)), end: localDay(at(windowDays - 1)) },
    dueAtMs: new Date(t.getFullYear(), t.getMonth(), t.getDate() + windowDays, 0, 0, 0, 0).getTime(),
  };
}

/**
 * Trimmed, length-capped string, or undefined.
 *
 * @param v - Value
 * @returns Text
 */
function text(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, EXPERIMENT_CONSTANTS.MAX_TEXT_LENGTH) : undefined;
}

/**
 * A GA4 landing-page filter as a path: GA4 reports landing pages as paths, so
 * a full URL is reduced to its path and any query string / fragment dropped
 * (`https://site/x/?utm=1` → `/x/`).
 *
 * @param page - Page as given
 * @returns The path
 * @throws ExperimentError(400) when it is a URL that cannot be read
 */
export function ga4PagePath(page: string): string {
  let p = page.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      throw new ExperimentError(400, `metric.page is not a valid URL: ${page} (for ga4 give the landing page path, e.g. /h1b-guide)`);
    }
  }
  p = p.split('#')[0].split('?')[0];
  if (!p.startsWith('/')) p = `/${p}`;
  return p;
}

/**
 * Validate a metric definition.
 *
 * @param raw - Body
 * @returns Metric
 * @throws ExperimentError(400) with what is wrong
 */
export function validateMetric(raw: unknown): ExperimentMetric {
  if (!raw || typeof raw !== 'object') throw new ExperimentError(400, 'metric is required: {source, measure, config, …}');
  const m = raw as Record<string, unknown>;
  if (!isExperimentSource(m.source)) throw new ExperimentError(400, 'metric.source must be gsc or ga4');
  const measures = EXPERIMENT_CONSTANTS.SOURCE_MEASURES[m.source] ?? [];
  if (typeof m.measure !== 'string' || !measures.includes(m.measure)) {
    throw new ExperimentError(400, `metric.measure for ${m.source} must be one of: ${measures.join(', ')}`);
  }
  const config = text(m.config);
  if (!config || !path.isAbsolute(config)) throw new ExperimentError(400, 'metric.config must be the absolute path of the seo-ops site config');
  const out: ExperimentMetric = { source: m.source, measure: m.measure as ExperimentMeasure, config };
  const page = text(m.page);
  if (page) out.page = m.source === 'ga4' ? ga4PagePath(page) : page;
  if (m.pageMatch !== undefined) {
    if (m.pageMatch !== 'exact' && m.pageMatch !== 'contains') throw new ExperimentError(400, 'metric.pageMatch must be exact or contains');
    out.pageMatch = m.pageMatch;
  }
  const query = text(m.query);
  if (query) {
    if (m.source !== 'gsc') throw new ExperimentError(400, 'metric.query is a Search Console filter (source gsc)');
    out.query = query;
  }
  if (m.queryMatch !== undefined) {
    if (m.queryMatch !== 'exact' && m.queryMatch !== 'contains') throw new ExperimentError(400, 'metric.queryMatch must be exact or contains');
    out.queryMatch = m.queryMatch;
  }
  const event = text(m.event);
  if (out.measure === 'events' && !event) throw new ExperimentError(400, 'metric.event is required for ga4 events (e.g. generate_lead); for every key event use measure conversions');
  if (event) out.event = event;
  const channel = text(m.channel);
  if (channel) {
    if (m.source !== 'ga4') throw new ExperimentError(400, 'metric.channel is a GA4 filter (source ga4)');
    out.channel = channel;
  }
  const label = text(m.label);
  if (label) out.label = label;
  return out;
}

/**
 * Validate a ticket link.
 *
 * @param raw - Body
 * @returns Link or undefined
 * @throws ExperimentError(400)
 */
export function validateTicketLink(raw: unknown): ExperimentTicketLink | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'object') throw new ExperimentError(400, 'ticket must be {kind: "project", project, id} or {kind: "harness", id}');
  const t = raw as Record<string, unknown>;
  const id = text(t.id);
  if (!id) throw new ExperimentError(400, 'ticket.id is required');
  if (t.kind === 'harness') return { kind: 'harness', id };
  if (t.kind === 'project') {
    const project = text(t.project);
    if (!project) throw new ExperimentError(400, 'ticket.project is required for a project ticket');
    return { kind: 'project', project, id };
  }
  throw new ExperimentError(400, 'ticket.kind must be project or harness');
}

/**
 * How a ticket link reads.
 *
 * @param link - Link
 * @returns e.g. "ce-site/T-12" or "TKT-40"
 */
export function ticketLabel(link: ExperimentTicketLink): string {
  return link.kind === 'project' ? `${link.project}/${link.id}` : link.id;
}

/**
 * The verdict word for people.
 *
 * @param e - Experiment
 * @returns worked / didn't work / inconclusive
 */
function verdictWord(e: Experiment): string {
  return e.verdict === 'worked' ? 'worked' : e.verdict === 'didnt' ? "didn't work" : 'inconclusive';
}

/**
 * The metric as one line.
 *
 * @param m - Metric
 * @returns e.g. "gsc clicks · page https://… · query visa"
 */
export function metricLabel(m: ExperimentMetric): string {
  const parts = [m.label ?? `${m.source} ${m.measure}`];
  if (m.page) parts.push(`page ${m.page}`);
  if (m.query) parts.push(`query ${m.query}`);
  if (m.event) parts.push(`event ${m.event}`);
  return parts.join(' · ');
}

/**
 * The result as markdown (wiki log entry and owner message share it).
 *
 * @param e - A measured experiment
 * @returns Markdown
 */
export function resultSummary(e: Experiment): string {
  const lines = [
    `**${e.id} ${verdictWord(e)}: ${e.title}**`,
    `Hypothesis: ${e.hypothesis}`,
    `Metric: ${metricLabel(e.metric)}`,
    `Result: ${e.verdictReason ?? 'n/a'}`,
  ];
  if (e.expected?.to !== undefined && e.result) {
    const reached = e.direction === 'increase' ? (e.result.total ?? -Infinity) >= e.expected.to : (e.result.total ?? Infinity) <= e.expected.to;
    lines.push(`Target ${formatValue(e.expected.to, e.metric.measure)}: ${reached ? 'reached' : 'not reached'}`);
  }
  if (e.baseline && e.result) lines.push(`Baseline ${e.baseline.start}..${e.baseline.end} · Result ${e.result.start}..${e.result.end}`);
  if (e.autopilot) lines.push(...autopilotSummaryLines(e.autopilot));
  if (e.ticket) lines.push(`Ticket: ${ticketLabel(e.ticket)}`);
  return lines.join('\n');
}

/**
 * Duration in words.
 *
 * @param ms - Milliseconds
 * @returns "3h 10m" / "45m"
 */
function durationText(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/**
 * The process numbers as one line.
 *
 * @param p - Process summary
 * @returns e.g. "9 tickets shipped · 1.2 owner touches per ticket · stalls 3h 10m · $2.10 per shipped ticket"
 */
export function processLine(p: ExperimentProcessSummary): string {
  return [
    `${p.ticketsShipped} ticket${p.ticketsShipped === 1 ? '' : 's'} shipped (${p.ticketsStarted} started)`,
    `${p.ownerTouchesPerTicket === null ? `${p.ownerTouches} owner touches` : `${p.ownerTouchesPerTicket} owner touches per ticket`}`,
    `stalls ${p.stalls === 0 ? 'none' : `${p.stalls} (${durationText(p.stallMs)})`}`,
    p.costPerShippedTicket === null ? `$${p.costUsd.toFixed(2)} spent` : `$${p.costPerShippedTicket.toFixed(2)} per shipped ticket`,
  ].join(' · ');
}

/**
 * The autopilot part of a result: the other outcome metrics and the process.
 *
 * @param a - Scope
 * @returns Lines
 */
export function autopilotSummaryLines(a: ExperimentAutopilotScope): string[] {
  const lines: string[] = [];
  if (a.outcomes.length > 0) {
    lines.push('Other metrics:');
    for (const o of a.outcomes) {
      const word = o.verdict === 'worked' ? 'worked' : o.verdict === 'didnt' ? "didn't work" : o.verdict ? 'inconclusive' : 'not measured';
      lines.push(`- ${metricLabel(o.metric)}: ${o.verdictReason ?? (o.lastError ? `fetch failed (${o.lastError.slice(0, 120)})` : 'n/a')} — ${word}`);
    }
  }
  const scope = `autopilot of ${a.projectName}${a.label ? `, label ${a.label}` : ''}`;
  if (a.processResult) lines.push(`Process (${scope}): ${a.processResult.noData ? 'no autopilot work recorded' : processLine(a.processResult)}`);
  // A baseline window without autopilot traces is no data, not zeros: left out.
  if (a.processBaseline && !a.processBaseline.noData) lines.push(`Process before: ${processLine(a.processBaseline)}`);
  return lines;
}

/**
 * Experiment cards: store, lifecycle and the measuring tick.
 */
export class ExperimentService {
  private static instance: ExperimentService | null = null;
  private readonly logger: ComponentLogger;
  /** The store file was bad and has been copied aside (don't copy it again on every read). */
  private storeSetAside = false;
  private readonly now: () => Date;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** A tick is running (fetches can be slow; ticks never overlap) */
  private ticking = false;
  /** Check-ins whose reads / send keep failing: next try and failures so far */
  private readonly checkInRetry = new Map<string, { at: number; failures: number }>();
  /** Experiments being measured right now (a measureNow racing a tick fetches once) */
  private readonly measuring = new Set<string>();

  /**
   * @param deps - Dependencies
   */
  constructor(private readonly deps: ExperimentServiceDeps) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('ExperimentService');
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Set how agents are told (wired at boot, where agent delivery exists).
   *
   * @param notify - Delivers a message to an agent; false = not delivered
   */
  setAgentNotifier(notify: (session: string, text: string) => Promise<boolean>): void {
    this.deps.notifyAgent = notify;
  }

  /**
   * The installed service (null before boot).
   *
   * @returns Service or null
   */
  static getInstance(): ExperimentService | null {
    return ExperimentService.instance;
  }

  /**
   * Install the process service.
   *
   * @param service - Service, or null to clear
   */
  static setInstance(service: ExperimentService | null): void {
    ExperimentService.instance = service;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the periodic tick (runs once right away).
   *
   * @param intervalMs - Interval (0 = no timer; tests call {@link tick})
   */
  start(intervalMs: number = EXPERIMENT_CONSTANTS.TICK_INTERVAL_MS): void {
    if (intervalMs > 0 && !this.timer) {
      const run = (): void => {
        void this.tick().catch((err) => this.logger.warn('Experiment tick failed (non-fatal)', { error: errText(err) }));
      };
      this.timer = setInterval(run, intervalMs);
      this.timer.unref?.();
      run();
    }
  }

  /** Stop the tick. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------------------
  // Store
  // ---------------------------------------------------------------------------

  /**
   * Run one store operation at a time.
   *
   * @param fn - Operation
   * @returns Its result
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * Read the store.
   *
   * Missing: empty. Unreadable or invalid: copied aside once to
   * `experiments.json.corrupt-<ts>` (error logged), then empty, so the next
   * save may replace it. If the copy fails, or the file cannot be read at
   * all (EMFILE, EIO…), this throws, and nothing is saved over the file.
   *
   * @returns Store data (empty when missing)
   */
  private async load(): Promise<ExperimentStoreData> {
    const empty: ExperimentStoreData = { version: 1, nextNumber: 1, experiments: [] };
    if (this.storeSetAside) {
      // Already copied aside: read it again only to see whether it was fixed.
      try {
        const data = JSON.parse(await fs.readFile(this.deps.storeFile, 'utf-8')) as Partial<ExperimentStoreData>;
        if (data && typeof data === 'object') this.storeSetAside = false;
        return this.normalize(data);
      } catch {
        return empty;
      }
    }
    const read = await readJsonStore<Partial<ExperimentStoreData>>(this.deps.storeFile, {
      validate: (d) => (d && typeof d === 'object' && !Array.isArray(d) ? null : 'not a JSON object'),
      logger: this.logger,
    });
    if (read.status === 'ok') return this.normalize(read.data);
    if (read.status === 'quarantined') this.storeSetAside = true;
    return empty;
  }

  /**
   * Fill defaults into a parsed store.
   *
   * @param data - Parsed store
   * @returns Store data
   */
  private normalize(data: Partial<ExperimentStoreData>): ExperimentStoreData {
    return { version: 1, nextNumber: data.nextNumber ?? 1, experiments: Array.isArray(data.experiments) ? data.experiments : [] };
  }

  /**
   * Write the store atomically (temp file + fsync + rename).
   *
   * @param data - Store data
   */
  private async save(data: ExperimentStoreData): Promise<void> {
    await fs.mkdir(path.dirname(this.deps.storeFile), { recursive: true });
    await atomicWriteFile(this.deps.storeFile, JSON.stringify(data, null, 2));
    this.storeSetAside = false;
  }

  /**
   * Load, change one experiment, save.
   *
   * @param id - Experiment id
   * @param fn - Change (mutates the experiment)
   * @returns The experiment after the change
   * @throws ExperimentError(404) when not found
   */
  private async mutate(id: string, fn: (e: Experiment) => void | Promise<void>): Promise<Experiment> {
    return this.serial(async () => {
      const data = await this.load();
      const e = data.experiments.find((x) => x.id.toLowerCase() === String(id).trim().toLowerCase());
      if (!e) throw new ExperimentError(404, `Experiment not found: ${id}`);
      await fn(e);
      e.updatedAt = this.now().toISOString();
      await this.save(data);
      return e;
    });
  }

  /**
   * Add a timeline entry.
   *
   * @param e - Experiment
   * @param event - Event name
   * @param detail - Optional detail
   */
  private record(e: Experiment, event: string, detail?: string): void {
    e.timeline.push({ at: this.now().toISOString(), event, ...(detail ? { detail: detail.slice(0, 500) } : {}) });
    traceExperimentEvent(e.traceId, e.id, event, detail);
    if (e.timeline.length > EXPERIMENT_CONSTANTS.MAX_TIMELINE) e.timeline.splice(0, e.timeline.length - EXPERIMENT_CONSTANTS.MAX_TIMELINE);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * All experiments, newest first.
   *
   * @param filter - Optional status / ticket filter
   * @returns Experiments
   */
  async list(filter: { status?: string; ticket?: string } = {}): Promise<Experiment[]> {
    const data = await this.serial(() => this.load());
    return data.experiments
      .filter((e) => !filter.status || e.status === filter.status)
      .filter((e) => !filter.ticket || (e.ticket && (e.ticket.id === filter.ticket || ticketLabel(e.ticket) === filter.ticket)))
      .reverse();
  }

  /**
   * One experiment.
   *
   * @param id - EXP-n
   * @returns Experiment or null
   */
  async get(id: string): Promise<Experiment | null> {
    const data = await this.serial(() => this.load());
    return data.experiments.find((e) => e.id.toLowerCase() === String(id).trim().toLowerCase()) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Create an experiment card.
   *
   * @param input - Hypothesis, metric, window, ticket, confidence
   * @param caller - Agent session, or `owner`
   * @returns The new experiment (status planned)
   * @throws ExperimentError(400) on invalid input
   */
  async create(input: CreateExperimentInput, caller: string): Promise<Experiment> {
    const C = EXPERIMENT_CONSTANTS;
    const hypothesis = text(input.hypothesis);
    if (!hypothesis) throw new ExperimentError(400, 'hypothesis is required: "change X → metric Y from a to b"');
    const metric = validateMetric(input.metric);
    if (this.deps.fileExists && !(await this.deps.fileExists(metric.config))) {
      throw new ExperimentError(400, `seo-ops config not found: ${metric.config}`);
    }
    let windowDays: number = C.DEFAULT_WINDOW_DAYS;
    if (input.windowDays !== undefined && input.windowDays !== null && input.windowDays !== '') {
      const n = Number(input.windowDays);
      if (!Number.isInteger(n) || n < C.MIN_WINDOW_DAYS || n > C.MAX_WINDOW_DAYS) {
        throw new ExperimentError(400, `windowDays must be a whole number from ${C.MIN_WINDOW_DAYS} to ${C.MAX_WINDOW_DAYS}`);
      }
      windowDays = n;
    }
    let direction: ExperimentDirection = defaultDirection(metric.measure);
    if (input.direction !== undefined && input.direction !== null && input.direction !== '') {
      if (input.direction !== 'increase' && input.direction !== 'decrease') throw new ExperimentError(400, 'direction must be increase or decrease');
      direction = input.direction;
    }
    let expected: Experiment['expected'];
    if (input.expected && typeof input.expected === 'object') {
      const raw = input.expected as Record<string, unknown>;
      const from = raw.from === undefined || raw.from === null || raw.from === '' ? undefined : Number(raw.from);
      const to = raw.to === undefined || raw.to === null || raw.to === '' ? undefined : Number(raw.to);
      if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) {
        throw new ExperimentError(400, 'expected.from / expected.to must be numbers');
      }
      if (from !== undefined || to !== undefined) expected = { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
    }
    let confidence: number = C.DEFAULT_CONFIDENCE;
    if (input.confidence !== undefined && input.confidence !== null && input.confidence !== '') {
      const c = Number(input.confidence);
      if (!Number.isFinite(c) || c < 0 || c > 1) throw new ExperimentError(400, 'confidence must be between 0 and 1');
      confidence = c;
    }
    const ticket = validateTicketLink(input.ticket);
    const title = text(input.title) ?? hypothesis.slice(0, 80);
    const scope = await this.parseAutopilotScope(input, metric);
    const startedAt = input.startedAt === undefined || input.startedAt === null || input.startedAt === '' ? undefined : parseShipTime(String(input.startedAt), this.now());
    // An autopilot card starts at its creation (or startedAt): the baseline is
    // the equal window before it (specs/2026-10-03-autopilot-experiments.md §3).
    const explicitShip = scope
      ? (startedAt ?? (input.shippedAt ? parseShipTime(String(input.shippedAt), this.now()) : this.now().toISOString()))
      : input.shippedAt === undefined || input.shippedAt === null || input.shippedAt === ''
        ? undefined
        : parseShipTime(String(input.shippedAt), this.now());
    // A ticket that is already done ships the card right away. Its done
    // transition dates the ship; with no recorded done time the caller must
    // say when the change went live (guessing would skew the baseline).
    let ticketDoneAt: string | undefined;
    if (ticket && this.deps.ticketShipState && !explicitShip) {
      const state = await this.deps.ticketShipState(ticket).catch((err) => {
        this.logger.debug('Could not read the linked ticket (non-fatal)', { ticket: ticketLabel(ticket), error: errText(err) });
        return { done: false } as TicketShipState;
      });
      if (state.done && !state.at) {
        throw new ExperimentError(
          400,
          `Ticket ${ticketLabel(ticket)} is already done but has no recorded done time; pass shippedAt (the ISO time the change went live)`,
        );
      }
      if (state.done && state.at) ticketDoneAt = new Date(Math.min(Date.parse(state.at), this.now().getTime())).toISOString();
    }

    const created = await this.serial(async () => {
      const data = await this.load();
      const id = `${C.ID_PREFIX}${data.nextNumber}`;
      data.nextNumber += 1;
      const at = this.now().toISOString();
      // The card's run: its ticket's trace, else a new `experiment` root
      // (specs/2026-10-03-run-traces.md). `exp:EXP-n` only when tracing failed.
      const traceId = startExperimentTrace({ id, title, ...(ticket ? { ticket: { kind: ticket.kind, id: ticket.id } } : {}) }, caller) ?? `exp:${id}`;
      const e: Experiment = {
        id,
        traceId,
        title,
        hypothesis,
        direction,
        ...(expected ? { expected } : {}),
        metric,
        windowDays,
        ...(ticket ? { ticket } : {}),
        createdBy: caller,
        confidence,
        status: 'planned',
        createdAt: at,
        updatedAt: at,
        ...(scope ? { autopilot: scope } : {}),
        timeline: [],
      };
      this.record(e, 'created', `by ${caller}${ticket ? ` on ${ticketLabel(ticket)}` : ''}`);
      if (scope) {
        this.record(
          e,
          'autopilot_scope',
          `autopilot of ${scope.projectName}${scope.label ? `, label ${scope.label}` : ''}; outcome metrics: ${[metricLabel(metric), ...scope.outcomes.map((o) => metricLabel(o.metric))].join('; ')}`,
        );
      }
      data.experiments.push(e);
      await this.save(data);
      return e;
    });
    if (ticket && this.deps.noteOnTicket) {
      await this.deps.noteOnTicket(ticket, `Experiment ${created.id}: ${hypothesis} (metric: ${metricLabel(metric)}, ${windowDays}-day window; measured automatically after ship)`).catch((err) =>
        this.logger.debug('Could not note the experiment on its ticket (non-fatal)', { id: created.id, error: errText(err) }),
      );
    }
    this.logger.info('Experiment created', { id: created.id, caller, ticket: ticket ? ticketLabel(ticket) : undefined });
    if (explicitShip) return this.ship(created.id, caller, explicitShip);
    if (ticketDoneAt && ticket) return this.ship(created.id, `ticket ${ticketLabel(ticket)} done`, ticketDoneAt);
    return created;
  }

  /**
   * The autopilot scope of a new card, validated.
   *
   * @param input - Create input
   * @param primary - The primary metric (its config is the default of the extra metrics)
   * @returns Scope, or undefined for an ordinary card
   * @throws ExperimentError(400)
   */
  private async parseAutopilotScope(input: CreateExperimentInput, primary: ExperimentMetric): Promise<ExperimentAutopilotScope | undefined> {
    if (input.autopilot === undefined || input.autopilot === null || input.autopilot === '' || input.autopilot === false) {
      if (input.metrics !== undefined && input.metrics !== null) throw new ExperimentError(400, 'metrics (extra outcome metrics) are for autopilot cards: add autopilot: {project}');
      return undefined;
    }
    if (!this.deps.autopilot) throw new ExperimentError(400, 'Autopilot experiments are not available (the ticket autopilot is not running)');
    const raw = (typeof input.autopilot === 'object' ? input.autopilot : {}) as Record<string, unknown>;
    const ref = text(raw.project) ?? text(raw.projectId);
    if (!ref) throw new ExperimentError(400, 'autopilot.project is required (project id, name or path)');
    let project: { id: string; name: string };
    try {
      project = await this.deps.autopilot.resolveProject(ref);
    } catch (err) {
      throw new ExperimentError(400, `autopilot.project: ${errText(err)}`);
    }
    const label = text(raw.label);
    const list = input.metrics === undefined || input.metrics === null ? [] : input.metrics;
    if (!Array.isArray(list)) throw new ExperimentError(400, 'metrics must be a list of metric definitions');
    if (list.length > EXPERIMENT_CONSTANTS.MAX_EXTRA_METRICS) throw new ExperimentError(400, `at most ${EXPERIMENT_CONSTANTS.MAX_EXTRA_METRICS} extra metrics`);
    const outcomes: ExperimentOutcome[] = [];
    for (const [i, m] of list.entries()) {
      const withConfig = m && typeof m === 'object' ? { config: primary.config, ...(m as Record<string, unknown>) } : m;
      try {
        const metric = validateMetric(withConfig);
        if (metric.config !== primary.config && this.deps.fileExists && !(await this.deps.fileExists(metric.config))) {
          throw new ExperimentError(400, `seo-ops config not found: ${metric.config}`);
        }
        outcomes.push({ metric });
      } catch (err) {
        throw new ExperimentError(400, `metrics[${i}]: ${errText(err)}`);
      }
    }
    return { projectId: project.id, projectName: project.name, ...(label ? { label } : {}), outcomes, checkIns: 0 };
  }

  /**
   * Autopilot cards: fetch the extra outcome metrics' baselines and the
   * process baseline that are still missing (retried by the tick).
   *
   * @param id - EXP-n
   */
  private async captureAutopilotBaseline(id: string): Promise<void> {
    const e = await this.get(id);
    if (!e || e.status !== 'running' || !e.autopilot || !e.shippedAt) return;
    const fetched: Array<{ index: number; m?: Measurement; error?: string }> = [];
    for (const [index, o] of e.autopilot.outcomes.entries()) {
      if (o.baseline) continue;
      const ow = experimentWindows(e.shippedAt, e.windowDays, o.metric.source);
      try {
        fetched.push({ index, m: await this.deps.fetchMetric(o.metric, ow.baseline) });
      } catch (err) {
        fetched.push({ index, error: errText(err).slice(0, 500) });
      }
    }
    if (fetched.length === 0) return;
    await this.mutate(id, (x) => {
      if (!x.autopilot) return;
      for (const f of fetched) {
        const o = x.autopilot.outcomes[f.index];
        if (!o || o.baseline) continue;
        if (f.m) {
          o.baseline = f.m;
          delete o.lastError;
          this.record(x, 'outcome_baseline', `${metricLabel(o.metric)}: ${formatValue(f.m.total, o.metric.measure)} over ${f.m.start}..${f.m.end}`);
        } else if (o.lastError !== f.error) {
          o.lastError = f.error;
          this.record(x, 'fetch_failed', `baseline of ${metricLabel(o.metric)}: ${f.error}`);
        }
      }
    });
  }

  /**
   * Autopilot cards: the process baseline (as soon as the card starts) and
   * the process result (once the observation window's last local day is
   * over), each recorded once, independent of the outcome metrics. A failed
   * read is retried by the next tick; a window with no autopilot traces is
   * stored as no-data, never as zeros.
   *
   * @param id - EXP-n
   */
  private async captureProcess(id: string): Promise<void> {
    const e = await this.get(id);
    if (!e || e.status !== 'running' || !e.autopilot || !e.shippedAt || !this.deps.autopilot) return;
    const w = processWindows(e.shippedAt, e.windowDays);
    const label = e.autopilot.label ?? null;
    const read = async (range: DateRange, what: string): Promise<ExperimentProcessSummary | undefined> =>
      this.deps.autopilot?.process(e.autopilot!.projectId, label, range).catch((err) => {
        this.logger.debug(`Could not read the autopilot process ${what}`, { id, error: errText(err) });
        return undefined;
      });
    const base = e.autopilot.processBaseline ? undefined : await read(w.baseline, 'baseline');
    const result = !e.autopilot.processResult && this.now().getTime() >= w.dueAtMs ? await read(w.observation, 'result') : undefined;
    if (!base && !result) return;
    await this.mutate(id, (x) => {
      if (!x.autopilot) return;
      if (base && !x.autopilot.processBaseline) {
        x.autopilot.processBaseline = base;
        this.record(x, 'process_baseline', base.noData ? `no autopilot work in ${w.baseline.start}..${w.baseline.end}` : processLine(base));
      }
      if (result && !x.autopilot.processResult) {
        x.autopilot.processResult = result;
        this.record(x, 'process_result', result.noData ? `no autopilot work in ${w.observation.start}..${w.observation.end}` : processLine(result));
      }
    });
  }

  /**
   * Autopilot cards whose outcome fetch keeps failing: remind the owner at
   * most once a week (the first notice is {@link fetchFailed}'s).
   *
   * @param id - EXP-n
   */
  private async remindStuck(id: string): Promise<void> {
    const e = await this.get(id);
    if (!e || !e.autopilot || !e.stuckReported || !this.deps.notifyOwner) return;
    const last = Date.parse(e.stuckNoticeAt ?? '') || 0;
    if (this.now().getTime() - last < EXPERIMENT_CONSTANTS.CHECK_IN_INTERVAL_MS) return;
    const process = e.autopilot.processResult && !e.autopilot.processResult.noData ? `\nProcess so far: ${processLine(e.autopilot.processResult)}` : '';
    const sent = await this.deps
      .notifyOwner({
        title: `Experiment ${e.id} still can't fetch its metric`,
        message: `${e.title}\nMetric: ${metricLabel(e.metric)}\nStill failing: ${e.lastError ?? 'unknown error'}\nFix the seo-ops config or credentials (${e.metric.config}).${process}`,
        urgent: false,
      })
      .catch(() => false);
    if (sent) await this.mutate(id, (x) => {
      x.stuckNoticeAt = this.now().toISOString();
      this.record(x, 'stuck_reminder', x.lastError ?? '');
    });
  }

  /**
   * Autopilot cards: one short owner note per week while running.
   *
   * @param id - EXP-n
   * @returns True when a check-in went out
   */
  private async checkIn(id: string): Promise<boolean> {
    const e = await this.get(id);
    if (!e || e.status !== 'running' || !e.autopilot || !e.shippedAt || !this.deps.autopilot) return false;
    const nowMs = this.now().getTime();
    if (e.dueAt && Date.parse(e.dueAt) <= nowMs) return false;
    const week = Math.floor((nowMs - Date.parse(e.shippedAt)) / EXPERIMENT_CONSTANTS.CHECK_IN_INTERVAL_MS);
    if (week < 1 || week <= e.autopilot.checkIns) return false;
    const retry = this.checkInRetry.get(id);
    if (retry && nowMs < retry.at) return false;
    const backOff = (): false => {
      const failures = (retry?.failures ?? 0) + 1;
      const C = EXPERIMENT_CONSTANTS;
      this.checkInRetry.set(id, { failures, at: nowMs + Math.min(C.CHECK_IN_RETRY_MAX_MS, C.CHECK_IN_RETRY_MIN_MS * 2 ** (failures - 1)) });
      return false;
    };
    const w = experimentWindows(e.shippedAt, e.windowDays, e.metric.source);
    // Process numbers in local days, start day included (the autopilot's days).
    const pw = processWindows(e.shippedAt, e.windowDays);
    const today = localDay(this.now());
    const soFar: DateRange = { start: pw.observation.start, end: today < pw.observation.end ? today : pw.observation.end };
    const process = await this.deps.autopilot.process(e.autopilot.projectId, e.autopilot.label ?? null, soFar).catch(() => null);
    // No process numbers: no note (it would say nothing); retry with a backoff.
    if (!process) return backOff();
    // The primary metric so far: only days that have settled.
    const lag = EXPERIMENT_CONSTANTS.SOURCE_LAG_DAYS[e.metric.source] ?? 0;
    const settled = new Date(nowMs - (lag + 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const metricEnd = settled < w.observation.end ? settled : w.observation.end;
    let metricSoFar: Measurement | null = null;
    if (metricEnd >= w.observation.start) {
      metricSoFar = await this.deps.fetchMetric(e.metric, { start: w.observation.start, end: metricEnd }).catch(() => null);
    }
    const lines = [`${e.id} week ${week}: ${e.title}`];
    lines.push(process.noData ? 'No autopilot work recorded yet.' : processLine(process));
    if (metricSoFar) {
      const days = Math.round((Date.parse(`${metricEnd}T00:00:00Z`) - Date.parse(`${w.observation.start}T00:00:00Z`)) / (24 * 60 * 60 * 1000)) + 1;
      const base = e.baseline ? ` (baseline ${formatValue(e.baseline.total, e.metric.measure)} over ${e.windowDays} days)` : '';
      lines.push(`${metricLabel(e.metric)}: ${formatValue(metricSoFar.total, e.metric.measure)} over the first ${days} day${days === 1 ? '' : 's'}${base}`);
    }
    lines.push(`Result due ${e.dueAt?.slice(0, 10) ?? 'later'}.`);
    const message = lines.join('\n');
    const sent = this.deps.notifyOwner ? await this.deps.notifyOwner({ title: `Experiment ${e.id}: week ${week}`, message, urgent: false }).catch(() => false) : true;
    if (!sent) return backOff();
    this.checkInRetry.delete(id);
    await this.mutate(id, (x) => {
      if (!x.autopilot) return;
      x.autopilot.checkIns = week;
      x.autopilot.lastCheckInAt = this.now().toISOString();
      this.record(x, 'check_in', `week ${week}: ${process.noData ? 'no autopilot work yet' : processLine(process)}${metricSoFar ? `; ${metricLabel(e.metric)} so far ${formatValue(metricSoFar.total, e.metric.measure)}` : ''}`);
    });
    return true;
  }

  /**
   * Mark an experiment shipped: fix its windows, record the prediction and
   * capture the baseline.
   *
   * @param id - EXP-n
   * @param caller - Who shipped it
   * @param shippedAt - When it went live (default now; not in the future)
   * @returns The experiment
   * @throws ExperimentError(404 / 409 / 400)
   */
  async ship(id: string, caller: string, shippedAt?: string): Promise<Experiment> {
    const t = Date.parse(parseShipTime(shippedAt ?? this.now().toISOString(), this.now()));
    await this.mutate(id, (e) => {
      if (e.status !== 'planned') throw new ExperimentError(409, `${e.id} is ${e.status}; only a planned experiment can ship`);
      const w = experimentWindows(new Date(t).toISOString(), e.windowDays, e.metric.source);
      e.status = 'running';
      e.shippedAt = new Date(t).toISOString();
      e.dueAt = w.dueAt;
      e.fetchAttempts = 0;
      e.stuckReported = false;
      delete e.lastFetchAt;
      this.record(e, 'shipped', `by ${caller}; baseline ${w.baseline.start}..${w.baseline.end}, result ${w.observation.start}..${w.observation.end}, due ${w.dueAt.slice(0, 10)}`);
    });
    await this.recordPrediction(id);
    await this.captureBaseline(id);
    // Autopilot cards: the process baseline does not wait for the outcome fetch.
    await this.captureProcess(id);
    return (await this.get(id)) as Experiment;
  }

  /**
   * Cancel an experiment that has not been measured.
   *
   * @param id - EXP-n
   * @param caller - Who
   * @param reason - Why
   * @returns The experiment
   * @throws ExperimentError(404 / 409)
   */
  async cancel(id: string, caller: string, reason?: string): Promise<Experiment> {
    return this.mutate(id, (e) => {
      if (e.status === 'done' || e.status === 'cancelled') throw new ExperimentError(409, `${e.id} is already ${e.status}`);
      e.status = 'cancelled';
      this.record(e, 'cancelled', `by ${caller}${reason ? `: ${reason}` : ''}`);
    });
  }

  /**
   * Measure a due experiment now (instead of waiting for the tick).
   *
   * @param id - EXP-n
   * @returns The experiment
   * @throws ExperimentError(404 / 409) when it is not running or not yet due
   */
  async measureNow(id: string): Promise<Experiment> {
    const e = await this.get(id);
    if (!e) throw new ExperimentError(404, `Experiment not found: ${id}`);
    if (e.status !== 'running') throw new ExperimentError(409, `${e.id} is ${e.status}; only a running experiment can be measured`);
    if (e.dueAt && Date.parse(e.dueAt) > this.now().getTime()) {
      throw new ExperimentError(409, `${e.id} is not due until ${e.dueAt.slice(0, 10)} (the window's numbers have not settled)`);
    }
    if (!e.baseline) await this.captureBaseline(id);
    await this.measure(id);
    await this.followUp(id);
    return (await this.get(id)) as Experiment;
  }

  // ---------------------------------------------------------------------------
  // The tick
  // ---------------------------------------------------------------------------

  /**
   * Move every experiment forward: ship planned ones whose ticket shipped,
   * retry missing baselines, measure due ones, finish follow-ups.
   *
   * @returns Counts of what happened (zeros when a tick is already running)
   */
  async tick(): Promise<{ shipped: number; measured: number }> {
    if (this.ticking) return { shipped: 0, measured: 0 };
    this.ticking = true;
    try {
      return await this.runTick();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * One pass over all experiments (see {@link tick}).
   *
   * @returns Counts of what happened
   */
  private async runTick(): Promise<{ shipped: number; measured: number }> {
    const all = await this.serial(() => this.load());
    let shipped = 0;
    let measured = 0;
    const nowMs = this.now().getTime();
    for (const e of all.experiments) {
      try {
        if (e.status === 'planned' && e.ticket && this.deps.ticketShipState) {
          const state = await this.deps.ticketShipState(e.ticket);
          if (state.done && state.at) {
            const t = Math.min(Date.parse(state.at) || nowMs, nowMs);
            await this.ship(e.id, `ticket ${ticketLabel(e.ticket)} done`, new Date(t).toISOString());
            shipped += 1;
          } else if (state.done) {
            await this.shipTimeUnknown(e.id);
          }
          continue;
        }
        if (e.status === 'running') {
          // Autopilot process numbers and check-ins run on their own schedule:
          // a failing outcome fetch (e.g. missing credentials) never holds them.
          if (e.autopilot) {
            await this.captureProcess(e.id);
            await this.checkIn(e.id);
            await this.remindStuck(e.id);
          }
          // After MAX_FETCH_ATTEMPTS failures in a row, retry once a day.
          if (this.backingOff(e, nowMs)) continue;
          if (!e.baseline) await this.captureBaseline(e.id);
          if (e.autopilot) await this.captureAutopilotBaseline(e.id);
          if (e.dueAt && Date.parse(e.dueAt) <= nowMs) {
            const after = await this.get(e.id);
            if (after?.baseline) {
              await this.measure(e.id);
              if ((await this.get(e.id))?.status === 'done') measured += 1;
            }
          }
        }
        if (e.status === 'done' || (await this.get(e.id))?.status === 'done') await this.followUp(e.id);
      } catch (err) {
        this.logger.warn('Experiment step failed (non-fatal)', { id: e.id, error: errText(err) });
      }
    }
    return { shipped, measured };
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  /**
   * Whether a running experiment's fetches are backing off: after
   * MAX_FETCH_ATTEMPTS failures in a row the tick retries once every
   * FETCH_BACKOFF_MS instead of every tick.
   *
   * @param e - Experiment
   * @param nowMs - Now
   * @returns True to skip this tick
   */
  private backingOff(e: Experiment, nowMs: number): boolean {
    if ((e.fetchAttempts ?? 0) < EXPERIMENT_CONSTANTS.MAX_FETCH_ATTEMPTS || !e.lastFetchAt) return false;
    return nowMs - Date.parse(e.lastFetchAt) < EXPERIMENT_CONSTANTS.FETCH_BACKOFF_MS;
  }

  /**
   * The linked ticket is done but its done time is not recorded: the card
   * cannot be dated, so it waits for an explicit ship. Recorded (and the
   * owner told) once.
   *
   * @param id - EXP-n
   */
  private async shipTimeUnknown(id: string): Promise<void> {
    let first: Experiment | null = null;
    await this.mutate(id, (e) => {
      if (e.status !== 'planned' || e.timeline.some((t) => t.event === 'ship_time_unknown')) return;
      this.record(e, 'ship_time_unknown', 'the linked ticket is done but has no recorded done time; ship it with shippedAt');
      first = { ...e };
    });
    if (!first) return;
    const e = first as Experiment;
    this.logger.warn('Experiment ticket is done without a done time; waiting for an explicit ship', { id });
    // Bookkeeping the agent can do itself: the creator finds when the change
    // went live and ships the card. The owner hears only when no agent can
    // be told (2026-10-06: the owner got two of these and could not act).
    if (e.ticket && e.createdBy && e.createdBy !== 'owner' && this.deps.notifyAgent) {
      const told = await this.deps
        .notifyAgent(
          e.createdBy,
          `[EXPERIMENT ${e.id}] ${e.title}\nTicket ${ticketLabel(e.ticket)} is done, but its log has no done time, so the baseline can't be dated. ` +
            `Find when the change actually went live (deploy log, release, merge time) and run: experiment-card ship --id ${e.id} --shipped-at <ISO time>. ` +
            `This is bookkeeping — do not ask the owner.`,
        )
        .catch(() => false);
      if (told) return;
    }
    if (this.deps.notifyOwner && e.ticket) {
      await this.deps
        .notifyOwner({
          title: `Experiment ${e.id} needs its ship time`,
          message: `${e.title}\nTicket ${ticketLabel(e.ticket)} is done, but its log has no done time, so the baseline can't be dated. Ship it with the time the change went live: experiment-card ship --id ${e.id} --shipped-at <ISO time>.`,
          urgent: false,
        })
        .catch(() => false);
    }
  }

  /**
   * Record the creating agent's prediction that the hypothesis holds.
   *
   * @param id - EXP-n
   */
  private async recordPrediction(id: string): Promise<void> {
    const e = await this.get(id);
    if (!e || !this.deps.predictions || e.predictionId || e.createdBy === 'owner' || !e.dueAt) return;
    try {
      const p = await this.deps.predictions.make(e.createdBy, `${e.id}: ${e.hypothesis}`, e.confidence, e.dueAt.slice(0, 10));
      await this.mutate(id, (x) => {
        x.predictionId = p.id;
        this.record(x, 'prediction_recorded', `${p.id} for ${x.createdBy} at ${Math.round(x.confidence * 100)}%`);
      });
    } catch (err) {
      this.logger.debug('Could not record the experiment prediction (non-fatal)', { id, error: errText(err) });
    }
  }

  /**
   * A fetch failed: count it, and tell the owner once when it keeps failing.
   *
   * @param id - EXP-n
   * @param step - baseline / result
   * @param err - The error
   */
  private async fetchFailed(id: string, step: string, err: unknown): Promise<void> {
    let tell: Experiment | null = null;
    await this.mutate(id, (e) => {
      e.fetchAttempts = (e.fetchAttempts ?? 0) + 1;
      e.lastFetchAt = this.now().toISOString();
      e.lastError = errText(err).slice(0, 500);
      this.record(e, 'fetch_failed', `${step}: ${e.lastError}`);
      if (e.fetchAttempts >= EXPERIMENT_CONSTANTS.MAX_FETCH_ATTEMPTS && !e.stuckReported) {
        e.stuckReported = true;
        e.stuckNoticeAt = this.now().toISOString();
        tell = { ...e };
      }
    });
    if (tell && this.deps.notifyOwner) {
      const e = tell as Experiment;
      const sent = await this.deps
        .notifyOwner({
          title: `Experiment ${e.id} can't fetch its ${step}`,
          message: `${e.title}\nMetric: ${metricLabel(e.metric)}\nThe last ${EXPERIMENT_CONSTANTS.MAX_FETCH_ATTEMPTS} tries failed: ${e.lastError}\nIt now retries once a day; fix the seo-ops config or credentials (${e.metric.config}).`,
          urgent: false,
        })
        .catch(() => false);
      // Not delivered: try again on the next failure.
      if (!sent) await this.mutate(id, (x) => { x.stuckReported = false; }).catch(() => undefined);
    }
  }

  /**
   * Fetch the baseline window.
   *
   * @param id - EXP-n
   */
  private async captureBaseline(id: string): Promise<void> {
    const e = await this.get(id);
    if (!e || e.status !== 'running' || e.baseline || !e.shippedAt) return;
    const w = experimentWindows(e.shippedAt, e.windowDays, e.metric.source);
    let m: Measurement;
    try {
      m = await this.deps.fetchMetric(e.metric, w.baseline);
    } catch (err) {
      await this.fetchFailed(id, 'baseline', err);
      return;
    }
    await this.mutate(id, (x) => {
      // A concurrent measureNow / tick may have captured it meanwhile.
      if (x.status !== 'running' || x.baseline) return;
      x.baseline = m;
      x.fetchAttempts = 0;
      x.stuckReported = false;
      delete x.lastError;
      delete x.lastFetchAt;
      this.record(x, 'baseline_captured', `${formatValue(m.total, x.metric.measure)} over ${m.start}..${m.end} (volume ${m.volume})`);
    });
    if (e.autopilot) {
      await this.captureAutopilotBaseline(id);
      await this.captureProcess(id);
    }
  }

  /**
   * Fetch the observation window and label the result.
   *
   * @param id - EXP-n
   */
  private async measure(id: string): Promise<void> {
    if (this.measuring.has(id)) return;
    this.measuring.add(id);
    try {
      await this.measureOnce(id);
    } finally {
      this.measuring.delete(id);
    }
  }

  /**
   * One measurement (see {@link measure}).
   *
   * @param id - EXP-n
   */
  private async measureOnce(id: string): Promise<void> {
    const e = await this.get(id);
    if (!e || e.status !== 'running' || !e.baseline || !e.shippedAt) return;
    const w = experimentWindows(e.shippedAt, e.windowDays, e.metric.source);
    let m: Measurement;
    try {
      m = await this.deps.fetchMetric(e.metric, w.observation);
    } catch (err) {
      await this.fetchFailed(id, 'result', err);
      return;
    }
    // Autopilot cards: the extra outcome metrics and the process numbers of
    // the same window (a failed extra fetch never blocks the result).
    const extras: Array<{ m?: Measurement; error?: string }> = [];
    let process: ExperimentProcessSummary | null = null;
    if (e.autopilot) {
      for (const o of e.autopilot.outcomes) {
        try {
          extras.push({ m: await this.deps.fetchMetric(o.metric, experimentWindows(e.shippedAt, e.windowDays, o.metric.source).observation) });
        } catch (err) {
          extras.push({ error: errText(err).slice(0, 500) });
        }
      }
      if (this.deps.autopilot && !e.autopilot.processResult) {
        process = await this.deps.autopilot.process(e.autopilot.projectId, e.autopilot.label ?? null, processWindows(e.shippedAt, e.windowDays).observation).catch(() => null);
      }
    }
    await this.mutate(id, (x) => {
      // Re-checked under the store lock: a racing measureNow / tick may
      // have measured it already.
      if (x.status !== 'running' || !x.baseline) return;
      const v = decideVerdict(x.metric.measure, x.direction, x.baseline, m);
      x.result = m;
      x.verdict = v.verdict;
      x.verdictReason = v.reason;
      x.status = 'done';
      x.fetchAttempts = 0;
      delete x.lastError;
      delete x.lastFetchAt;
      this.record(x, 'measured', `${v.verdict}: ${v.reason}`);
      if (x.autopilot) {
        for (const [i, o] of x.autopilot.outcomes.entries()) {
          const got = extras[i];
          if (!got) continue;
          if (got.m) {
            o.result = got.m;
            delete o.lastError;
            if (o.baseline) {
              const ov = decideVerdict(o.metric.measure, defaultDirection(o.metric.measure), o.baseline, got.m);
              o.verdict = ov.verdict;
              o.verdictReason = ov.reason;
            }
            this.record(x, 'outcome_result', `${metricLabel(o.metric)}: ${o.verdictReason ?? `${formatValue(got.m.total, o.metric.measure)} (no baseline)`}`);
          } else {
            o.lastError = got.error;
            this.record(x, 'fetch_failed', `result of ${metricLabel(o.metric)}: ${got.error}`);
          }
        }
        if (process && !x.autopilot.processResult) {
          x.autopilot.processResult = process;
          this.record(x, 'process_result', process.noData ? 'no autopilot work in the window' : processLine(process));
        }
      }
    });
    this.logger.info('Experiment measured', { id });
  }

  /**
   * After a result: resolve the prediction, write the wiki log, tell the
   * owner. Each step is retried by later ticks until it lands.
   *
   * @param id - EXP-n
   */
  private async followUp(id: string): Promise<void> {
    const e = await this.get(id);
    if (!e || e.status !== 'done' || !e.verdict) return;
    const summary = resultSummary(e);

    if (e.predictionId && this.deps.predictions && !e.timeline.some((t) => t.event === 'prediction_resolved') && e.verdict !== 'inconclusive') {
      try {
        await this.deps.predictions.resolve(e.createdBy, e.predictionId, `${verdictWord(e)}: ${e.verdictReason ?? ''}`, e.verdict === 'worked');
        await this.mutate(id, (x) => this.record(x, 'prediction_resolved', `${x.predictionId}: ${x.verdict === 'worked' ? 'accurate' : 'inaccurate'}`));
      } catch (err) {
        this.logger.debug('Could not resolve the experiment prediction (non-fatal)', { id, error: errText(err) });
      }
    }

    if (!e.loggedAt && this.deps.writeLog) {
      const ok = await this.deps.writeLog(e, summary).catch((err) => {
        this.logger.debug('Wiki experiment log write failed (non-fatal)', { id, error: errText(err) });
        return false;
      });
      if (ok) await this.mutate(id, (x) => {
        x.loggedAt = this.now().toISOString();
        this.record(x, 'logged', EXPERIMENT_CONSTANTS.WIKI_LOG_PATH);
      });
    }

    if (!e.reportedAt && this.deps.notifyOwner) {
      // Claim the report under the store lock before sending, so a racing
      // followUp cannot send it twice; release the claim when not delivered.
      const claimAt = this.now().toISOString();
      let claimed = false;
      await this.mutate(id, (x) => {
        if (x.reportedAt) return;
        x.reportedAt = claimAt;
        claimed = true;
      });
      if (claimed) {
        const sent = await this.deps
          .notifyOwner({ title: `Experiment ${e.id} ${verdictWord(e)}`, message: summary, urgent: false })
          .catch(() => false);
        await this.mutate(id, (x) => {
          if (x.reportedAt !== claimAt) return;
          if (sent) this.record(x, 'reported', 'owner');
          else delete x.reportedAt;
        });
      }
    }

    if (e.ticket && this.deps.noteOnTicket && !e.timeline.some((t) => t.event === 'ticket_noted')) {
      try {
        await this.deps.noteOnTicket(e.ticket, `Experiment ${e.id} ${verdictWord(e)}: ${e.verdictReason ?? ''}`);
        await this.mutate(id, (x) => this.record(x, 'ticket_noted', ticketLabel(e.ticket as ExperimentTicketLink)));
      } catch (err) {
        this.logger.debug('Could not note the result on the ticket (non-fatal)', { id, error: errText(err) });
      }
    }
  }
}

/**
 * Is this a status filter value?
 *
 * @param v - Query value
 * @returns The status or undefined
 */
export function statusFilter(v: unknown): ExperimentStatus | undefined {
  return isExperimentStatus(v) ? v : undefined;
}
