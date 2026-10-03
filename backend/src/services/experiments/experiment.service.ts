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
import {
  isExperimentSource,
  isExperimentStatus,
  type Experiment,
  type ExperimentDirection,
  type ExperimentMeasure,
  type ExperimentMetric,
  type ExperimentStatus,
  type ExperimentStoreData,
  type ExperimentTicketLink,
  type Measurement,
} from '../../types/experiment.types.js';
import { decideVerdict, defaultDirection, experimentWindows, formatValue } from './experiment-verdict.js';
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
  /** Does a file exist (the seo-ops config) */
  fileExists?: (file: string) => Promise<boolean>;
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
  if (e.ticket) lines.push(`Ticket: ${ticketLabel(e.ticket)}`);
  return lines.join('\n');
}

/**
 * Experiment cards: store, lifecycle and the measuring tick.
 */
export class ExperimentService {
  private static instance: ExperimentService | null = null;
  private readonly logger: ComponentLogger;
  private readonly now: () => Date;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** A tick is running (fetches can be slow; ticks never overlap) */
  private ticking = false;
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
   * @returns Store data (empty when missing)
   */
  private async load(): Promise<ExperimentStoreData> {
    try {
      const data = JSON.parse(await fs.readFile(this.deps.storeFile, 'utf-8')) as Partial<ExperimentStoreData>;
      return { version: 1, nextNumber: data.nextNumber ?? 1, experiments: Array.isArray(data.experiments) ? data.experiments : [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn('Experiment store unreadable; starting empty', { error: errText(err) });
      return { version: 1, nextNumber: 1, experiments: [] };
    }
  }

  /**
   * Write the store atomically.
   *
   * @param data - Store data
   */
  private async save(data: ExperimentStoreData): Promise<void> {
    await fs.mkdir(path.dirname(this.deps.storeFile), { recursive: true });
    const tmp = `${this.deps.storeFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, this.deps.storeFile);
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
    const explicitShip = input.shippedAt === undefined || input.shippedAt === null || input.shippedAt === '' ? undefined : parseShipTime(String(input.shippedAt), this.now());
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
        timeline: [],
      };
      this.record(e, 'created', `by ${caller}${ticket ? ` on ${ticketLabel(ticket)}` : ''}`);
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
          // After MAX_FETCH_ATTEMPTS failures in a row, retry once a day.
          if (this.backingOff(e, nowMs)) continue;
          if (!e.baseline) await this.captureBaseline(e.id);
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
