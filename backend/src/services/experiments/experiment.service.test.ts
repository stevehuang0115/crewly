/**
 * Tests for ExperimentService (issue #986): create → ship (baseline,
 * prediction) → due → measure → verdict → prediction resolved, wiki log,
 * owner notice; auto-ship from a done ticket; fetch failures; cancel.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ExperimentError, ExperimentService, processWindows, ga4PagePath, metricLabel, resultSummary, statusFilter, ticketLabel, validateMetric, validateTicketLink, type ExperimentServiceDeps } from './experiment.service.js';
import type { ExperimentMetric, Measurement } from '../../types/experiment.types.js';
import type { DateRange } from './experiment-verdict.js';
import { TraceStore, setTraceStoreForTesting } from '../trace/trace-store.js';
import { getTraceContext, setTraceContextForTesting } from '../trace/trace-context.service.js';

const METRIC = { source: 'gsc', measure: 'clicks', config: '/cfg/ce.json', page: 'https://visa.example.com/' };
const silent = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as unknown as ExperimentServiceDeps['logger'];

/**
 * A measurement with a total.
 *
 * @param range - Window
 * @param total - Total
 * @returns Measurement
 */
function meas(range: DateRange, total: number): Measurement {
  return { start: range.start, end: range.end, total, volume: total, days: [], fetchedAt: 'T' };
}

describe('ExperimentService', () => {
  let dir: string;
  let clock: Date;
  let fetchMetric: jest.Mock<Promise<Measurement>, [ExperimentMetric, DateRange]>;
  let predictions: { make: jest.Mock; resolve: jest.Mock };
  let writeLog: jest.Mock;
  let notifyOwner: jest.Mock;
  let noteOnTicket: jest.Mock;
  let ticketShipState: jest.Mock;

  /**
   * Build a service on the temp store.
   *
   * @param extra - Dependency overrides
   * @returns Service
   */
  function service(extra: Partial<ExperimentServiceDeps> = {}): ExperimentService {
    return new ExperimentService({
      storeFile: path.join(dir, 'experiments.json'),
      fetchMetric,
      predictions,
      writeLog,
      notifyOwner,
      noteOnTicket,
      ticketShipState,
      fileExists: async (f) => f === '/cfg/ce.json',
      now: () => clock,
      logger: silent,
      ...extra,
    });
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exp-'));
    clock = new Date('2026-10-10T15:00:00Z');
    fetchMetric = jest.fn(async (_m: ExperimentMetric, r: DateRange) => meas(r, r.start < '2026-10-10' ? 100 : 160));
    predictions = { make: jest.fn().mockResolvedValue({ id: 'pred-1' }), resolve: jest.fn().mockResolvedValue({}) };
    writeLog = jest.fn().mockResolvedValue(true);
    notifyOwner = jest.fn().mockResolvedValue(true);
    noteOnTicket = jest.fn().mockResolvedValue(undefined);
    ticketShipState = jest.fn().mockResolvedValue({ done: false });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('runs the whole loop: create, ship (baseline + prediction), measure when due, report', async () => {
    const svc = service();
    const e = await svc.create({ hypothesis: 'FAQ schema on the home page → organic clicks from 100 to 140', metric: METRIC, expected: { from: 100, to: 140 }, ticket: { kind: 'project', project: 'ce-site', id: 'T-12' }, confidence: 0.7 }, 'ella');
    expect(e).toMatchObject({ id: 'EXP-1', traceId: expect.stringMatching(/^tr-\d{8}-[0-9a-f]{8}$/), status: 'planned', windowDays: 14, direction: 'increase', confidence: 0.7, createdBy: 'ella' });
    expect(noteOnTicket).toHaveBeenCalledWith({ kind: 'project', project: 'ce-site', id: 'T-12' }, expect.stringContaining('Experiment EXP-1'));

    const shipped = await svc.ship('exp-1', 'ella');
    expect(shipped.status).toBe('running');
    expect(shipped.dueAt).toBe('2026-10-28T00:00:00.000Z');
    expect(fetchMetric).toHaveBeenCalledWith(expect.objectContaining({ measure: 'clicks' }), { start: '2026-09-24', end: '2026-10-07' });
    expect(shipped.baseline?.total).toBe(100);
    expect(shipped.predictionId).toBe('pred-1');
    expect(predictions.make).toHaveBeenCalledWith('ella', expect.stringContaining('EXP-1: FAQ schema'), 0.7, '2026-10-28');

    // Not due yet: the tick does nothing; measureNow refuses.
    clock = new Date('2026-10-20T00:00:00Z');
    expect(await svc.tick()).toEqual({ shipped: 0, measured: 0 });
    await expect(svc.measureNow('EXP-1')).rejects.toThrow('not due until 2026-10-28');

    clock = new Date('2026-10-28T01:00:00Z');
    expect(await svc.tick()).toEqual({ shipped: 0, measured: 1 });
    const done = (await svc.get('EXP-1'))!;
    expect(fetchMetric).toHaveBeenLastCalledWith(expect.anything(), { start: '2026-10-11', end: '2026-10-24' });
    expect(done).toMatchObject({ status: 'done', verdict: 'worked' });
    expect(done.verdictReason).toBe('clicks 100 → 160 (+60%), z = 3.72: a real increase');
    expect(predictions.resolve).toHaveBeenCalledWith('ella', 'pred-1', expect.stringMatching(/^worked: /), true);
    expect(writeLog).toHaveBeenCalledWith(expect.objectContaining({ id: 'EXP-1' }), expect.stringContaining('**EXP-1 worked: '));
    expect(notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ title: 'Experiment EXP-1 worked', urgent: false }));
    expect(notifyOwner.mock.calls[0][0].message).toContain('Target 140: reached');
    expect(done.reportedAt).toBeDefined();
    expect(done.loggedAt).toBeDefined();
    expect(done.timeline.map((t) => t.event)).toEqual([
      'created', 'shipped', 'prediction_recorded', 'baseline_captured', 'measured', 'prediction_resolved', 'logged', 'reported', 'ticket_noted',
    ]);

    // Follow-ups are not repeated.
    await svc.tick();
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(writeLog).toHaveBeenCalledTimes(1);
    expect(predictions.resolve).toHaveBeenCalledTimes(1);
  });

  it('ships automatically when the linked ticket is done, dated when it was done', async () => {
    const svc = service();
    await svc.create({ hypothesis: 'h', metric: METRIC, ticket: { kind: 'harness', id: 'TKT-40' } }, 'ella');
    expect(await svc.tick()).toEqual({ shipped: 0, measured: 0 });
    ticketShipState.mockResolvedValue({ done: true, at: '2026-10-09T08:00:00Z' });
    expect(await svc.tick()).toEqual({ shipped: 1, measured: 0 });
    const e = (await svc.get('EXP-1'))!;
    expect(e.shippedAt).toBe('2026-10-09T08:00:00.000Z');
    expect(e.timeline.find((t) => t.event === 'shipped')?.detail).toContain('ticket TKT-40 done');
  });

  it('a ticket done without a recorded done time waits for an explicit ship (owner told once)', async () => {
    const svc = service();
    await svc.create({ hypothesis: 'h', metric: METRIC, ticket: { kind: 'project', project: 'ce', id: 'T-1' } }, 'ella');
    ticketShipState.mockResolvedValue({ done: true, at: null });
    expect(await svc.tick()).toEqual({ shipped: 0, measured: 0 });
    expect(await svc.tick()).toEqual({ shipped: 0, measured: 0 });
    const e = (await svc.get('EXP-1'))!;
    expect(e.status).toBe('planned');
    expect(e.timeline.filter((t) => t.event === 'ship_time_unknown')).toHaveLength(1);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner.mock.calls[0][0].title).toBe('Experiment EXP-1 needs its ship time');
    const shipped = await svc.ship('EXP-1', 'ella', '2026-10-08T00:00:00Z');
    expect(shipped.status).toBe('running');
  });

  it('create on an already-done ticket ships at its done time, or needs shippedAt when that is missing', async () => {
    const svc = service();
    const link = { kind: 'project', project: 'ce', id: 'T-1' };
    ticketShipState.mockResolvedValue({ done: true, at: '2026-10-08T12:00:00Z' });
    const a = await svc.create({ hypothesis: 'h', metric: METRIC, ticket: link }, 'ella');
    expect(a).toMatchObject({ status: 'running', shippedAt: '2026-10-08T12:00:00.000Z' });
    // The create's own ticket note must not move the ship time.
    expect(noteOnTicket).toHaveBeenCalled();

    ticketShipState.mockResolvedValue({ done: true, at: null });
    await expect(svc.create({ hypothesis: 'h2', metric: METRIC, ticket: link }, 'ella')).rejects.toThrow('pass shippedAt');
    const b = await svc.create({ hypothesis: 'h2', metric: METRIC, ticket: link, shippedAt: '2026-10-07T00:00:00Z' }, 'ella');
    expect(b).toMatchObject({ status: 'running', shippedAt: '2026-10-07T00:00:00.000Z' });
    await expect(svc.create({ hypothesis: 'h3', metric: METRIC, shippedAt: '2027-01-01T00:00:00Z' }, 'ella')).rejects.toThrow('in the future');
    expect((await svc.list()).map((e) => e.id)).toEqual(['EXP-2', 'EXP-1']);
  });

  it('retries a failing fetch, tells the owner once when it keeps failing, then recovers', async () => {
    fetchMetric.mockRejectedValue(new Error('seo-ops: SEO_OPS_GOOGLE_CREDENTIALS is not set'));
    const svc = service();
    await svc.create({ hypothesis: 'h', metric: METRIC }, 'ella');
    await svc.ship('EXP-1', 'ella');
    for (let i = 0; i < 8; i += 1) await svc.tick();
    let e = (await svc.get('EXP-1'))!;
    expect(e.baseline).toBeUndefined();
    // 1 at ship + 5 ticks = 6 failures; then it backs off to once a day.
    expect(e.fetchAttempts).toBe(6);
    expect(fetchMetric).toHaveBeenCalledTimes(6);
    expect(e.lastError).toContain('not set');
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner.mock.calls[0][0].title).toBe("Experiment EXP-1 can't fetch its baseline");
    expect(notifyOwner.mock.calls[0][0].message).toContain('once a day');

    clock = new Date(clock.getTime() + 23 * 3600 * 1000);
    await svc.tick();
    expect(fetchMetric).toHaveBeenCalledTimes(6);
    clock = new Date(clock.getTime() + 2 * 3600 * 1000);
    await svc.tick();
    expect(fetchMetric).toHaveBeenCalledTimes(7);
    expect(notifyOwner).toHaveBeenCalledTimes(1);

    fetchMetric.mockImplementation(async (_m, r) => meas(r, 50));
    clock = new Date(clock.getTime() + 25 * 3600 * 1000);
    await svc.tick();
    e = (await svc.get('EXP-1'))!;
    expect(e.baseline?.total).toBe(50);
    expect(e.fetchAttempts).toBe(0);
    expect(e.lastError).toBeUndefined();
    expect(e.lastFetchAt).toBeUndefined();
  });

  it('a stuck notice that was not delivered is tried again on a later failure', async () => {
    fetchMetric.mockRejectedValue(new Error('boom'));
    notifyOwner.mockResolvedValueOnce(false);
    const svc = service();
    await svc.create({ hypothesis: 'h', metric: METRIC }, 'ella');
    await svc.ship('EXP-1', 'ella');
    for (let i = 0; i < 5; i += 1) await svc.tick();
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect((await svc.get('EXP-1'))!.stuckReported).toBe(false);
    clock = new Date(clock.getTime() + 25 * 3600 * 1000);
    await svc.tick();
    expect(notifyOwner).toHaveBeenCalledTimes(2);
    expect((await svc.get('EXP-1'))!.stuckReported).toBe(true);
  });

  it('a result the owner was not sent stays unreported (no reportedAt), and is retried', async () => {
    notifyOwner.mockResolvedValue(false);
    const svc = service();
    await svc.create({ hypothesis: 'h', metric: METRIC }, 'owner');
    await svc.ship('EXP-1', 'owner', '2026-09-20T00:00:00Z');
    await svc.measureNow('EXP-1');
    await svc.tick();
    const e = (await svc.get('EXP-1'))!;
    expect(e.reportedAt).toBeUndefined();
    expect(e.timeline.some((t) => t.event === 'reported')).toBe(false);
    expect(notifyOwner).toHaveBeenCalledTimes(2);
    notifyOwner.mockResolvedValue(true);
    await svc.tick();
    expect((await svc.get('EXP-1'))!.reportedAt).toBeDefined();
    await svc.tick();
    expect(notifyOwner).toHaveBeenCalledTimes(3);
  });

  it('measureNow racing a tick measures and reports once', async () => {
    let release: () => void = () => undefined;
    const svc = service();
    await svc.create({ hypothesis: 'h', metric: METRIC }, 'owner');
    await svc.ship('EXP-1', 'owner', '2026-09-20T00:00:00Z');
    fetchMetric.mockImplementation((_m, r) => new Promise((resolve) => { release = () => resolve(meas(r, 160)); }));
    const now = svc.measureNow('EXP-1');
    const tick = svc.tick();
    while (fetchMetric.mock.calls.length < 2) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([now, tick]);
    const e = (await svc.get('EXP-1'))!;
    expect(e.status).toBe('done');
    expect(fetchMetric).toHaveBeenCalledTimes(2); // baseline at ship + one result
    expect(e.timeline.filter((t) => t.event === 'measured')).toHaveLength(1);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(e.timeline.filter((t) => t.event === 'reported')).toHaveLength(1);
  });

  it('inconclusive leaves the prediction open; follow-ups retry until they land', async () => {
    fetchMetric.mockImplementation(async (_m, r) => meas(r, 3));
    notifyOwner.mockResolvedValueOnce(false);
    writeLog.mockResolvedValueOnce(false);
    const svc = service();
    await svc.create({ hypothesis: 'h', metric: METRIC }, 'ella');
    await svc.ship('EXP-1', 'ella');
    clock = new Date('2026-10-29T00:00:00Z');
    await svc.tick();
    let e = (await svc.get('EXP-1'))!;
    expect(e.verdict).toBe('inconclusive');
    expect(predictions.resolve).not.toHaveBeenCalled();
    expect(e.reportedAt).toBeUndefined();
    expect(e.loggedAt).toBeUndefined();
    await svc.tick();
    e = (await svc.get('EXP-1'))!;
    expect(e.reportedAt).toBeDefined();
    expect(e.loggedAt).toBeDefined();
  });

  it('an owner-created experiment records no prediction; measureNow works once due', async () => {
    const svc = service();
    await svc.create({ hypothesis: 'h', metric: METRIC, windowDays: 7 }, 'owner');
    await svc.ship('EXP-1', 'owner', '2026-09-20T00:00:00Z');
    expect(predictions.make).not.toHaveBeenCalled();
    const e = await svc.measureNow('EXP-1');
    expect(e.status).toBe('done');
  });

  it('validates input', async () => {
    const svc = service();
    await expect(svc.create({ metric: METRIC }, 'a')).rejects.toThrow('hypothesis is required');
    await expect(svc.create({ hypothesis: 'h', metric: { ...METRIC, config: '/nope.json' } }, 'a')).rejects.toThrow('seo-ops config not found');
    await expect(svc.create({ hypothesis: 'h', metric: METRIC, windowDays: 3 }, 'a')).rejects.toThrow('from 7 to 90');
    await expect(svc.create({ hypothesis: 'h', metric: METRIC, direction: 'up' }, 'a')).rejects.toThrow('increase or decrease');
    await expect(svc.create({ hypothesis: 'h', metric: METRIC, confidence: 2 }, 'a')).rejects.toThrow('between 0 and 1');
    await expect(svc.create({ hypothesis: 'h', metric: METRIC, expected: { to: 'lots' } }, 'a')).rejects.toThrow('must be numbers');
    const pos = await svc.create({ hypothesis: 'h', metric: { ...METRIC, measure: 'position' } }, 'a');
    expect(pos.direction).toBe('decrease');
    expect(pos.title).toBe('h');
  });

  it('ship / cancel guard the lifecycle', async () => {
    const svc = service();
    await svc.create({ hypothesis: 'h', metric: METRIC }, 'a');
    await expect(svc.ship('EXP-9', 'a')).rejects.toMatchObject({ status: 404 });
    await expect(svc.ship('EXP-1', 'a', '2027-01-01T00:00:00Z')).rejects.toThrow('in the future');
    await expect(svc.ship('EXP-1', 'a', 'soon')).rejects.toThrow('ISO time');
    const c = await svc.cancel('EXP-1', 'a', 'superseded');
    expect(c.status).toBe('cancelled');
    expect(c.timeline.at(-1)?.detail).toBe('by a: superseded');
    await expect(svc.ship('EXP-1', 'a')).rejects.toMatchObject({ status: 409 });
    await expect(svc.cancel('EXP-1', 'a')).rejects.toThrow('already cancelled');
    await expect(svc.measureNow('EXP-1')).rejects.toMatchObject({ status: 409 });
  });

  it('lists newest first with filters; survives a restart', async () => {
    const svc = service();
    await svc.create({ hypothesis: 'one', metric: METRIC, ticket: { kind: 'harness', id: 'TKT-1' } }, 'a');
    await svc.create({ hypothesis: 'two', metric: METRIC }, 'a');
    await svc.cancel('EXP-2', 'a');
    expect((await svc.list()).map((e) => e.id)).toEqual(['EXP-2', 'EXP-1']);
    expect((await svc.list({ status: 'planned' })).map((e) => e.id)).toEqual(['EXP-1']);
    expect((await svc.list({ ticket: 'TKT-1' })).map((e) => e.id)).toEqual(['EXP-1']);
    const again = service();
    expect((await again.get('EXP-2'))?.status).toBe('cancelled');
    const third = await again.create({ hypothesis: 'three', metric: METRIC }, 'a');
    expect(third.id).toBe('EXP-3');
  });

  it('ticks never overlap', async () => {
    let release: () => void = () => undefined;
    const svc = service();
    await svc.create({ hypothesis: 'h', metric: METRIC, ticket: { kind: 'harness', id: 'TKT-1' } }, 'a');
    ticketShipState.mockReset();
    ticketShipState.mockImplementation(() => new Promise((r) => { release = () => r({ done: false }); }));
    const first = svc.tick();
    while (ticketShipState.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    expect(await svc.tick()).toEqual({ shipped: 0, measured: 0 });
    release();
    await first;
    expect(ticketShipState).toHaveBeenCalledTimes(1);
  });

  it('start runs a tick and stop clears the timer; singleton', async () => {
    const svc = service();
    const spy = jest.spyOn(svc, 'tick').mockResolvedValue({ shipped: 0, measured: 0 });
    svc.start(60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    svc.stop();
    svc.start(0);
    expect(spy).toHaveBeenCalledTimes(1);
    ExperimentService.setInstance(svc);
    expect(ExperimentService.getInstance()).toBe(svc);
    ExperimentService.setInstance(null);
  });
});

describe('experiment helpers', () => {
  it('validateMetric', () => {
    expect(() => validateMetric(null)).toThrow('metric is required');
    expect(() => validateMetric({ source: 'bing' })).toThrow('gsc or ga4');
    expect(() => validateMetric({ source: 'ga4', measure: 'clicks', config: '/c' })).toThrow('sessions, events');
    expect(() => validateMetric({ source: 'gsc', measure: 'clicks', config: 'rel.json' })).toThrow('absolute path');
    expect(() => validateMetric({ source: 'ga4', measure: 'events', config: '/c' })).toThrow('metric.event is required');
    expect(() => validateMetric({ source: 'ga4', measure: 'sessions', config: '/c', query: 'x' })).toThrow('Search Console filter');
    expect(() => validateMetric({ source: 'gsc', measure: 'clicks', config: '/c', channel: 'all' })).toThrow('GA4 filter');
    expect(() => validateMetric({ source: 'gsc', measure: 'clicks', config: '/c', pageMatch: 'regex' })).toThrow('exact or contains');
    expect(() => validateMetric({ source: 'gsc', measure: 'clicks', config: '/c', queryMatch: 'regex' })).toThrow('exact or contains');
    expect(validateMetric({ source: 'ga4', measure: 'events', config: '/c', event: 'generate_lead', page: '/contact', pageMatch: 'contains', channel: 'all', label: 'CE inquiries' })).toEqual({
      source: 'ga4', measure: 'events', config: '/c', event: 'generate_lead', page: '/contact', pageMatch: 'contains', channel: 'all', label: 'CE inquiries',
    });
    // GA4 reports landing pages as paths: a URL becomes its path, the query string is dropped.
    expect(validateMetric({ source: 'ga4', measure: 'sessions', config: '/c', page: 'https://visa.example.com/h1b-guide/?utm_source=x#top' }).page).toBe('/h1b-guide/');
    expect(validateMetric({ source: 'ga4', measure: 'sessions', config: '/c', page: '/h1b?x=1' }).page).toBe('/h1b');
    // Search Console pages stay full URLs.
    expect(validateMetric({ source: 'gsc', measure: 'clicks', config: '/c', page: 'https://visa.example.com/a?b=1' }).page).toBe('https://visa.example.com/a?b=1');
  });

  it('ga4PagePath', () => {
    expect(ga4PagePath('https://site.com')).toBe('/');
    expect(ga4PagePath('h1b-guide')).toBe('/h1b-guide');
    expect(() => ga4PagePath('https://')).toThrow('not a valid URL');
  });

  it('validateTicketLink / ticketLabel', () => {
    expect(validateTicketLink(undefined)).toBeUndefined();
    expect(() => validateTicketLink('T-1')).toThrow(ExperimentError);
    expect(() => validateTicketLink({ kind: 'project', id: 'T-1' })).toThrow('ticket.project');
    expect(() => validateTicketLink({ kind: 'jira', id: 'T-1' })).toThrow('project or harness');
    expect(() => validateTicketLink({ kind: 'harness' })).toThrow('ticket.id');
    expect(ticketLabel(validateTicketLink({ kind: 'project', project: 'ce', id: 'T-1' })!)).toBe('ce/T-1');
    expect(ticketLabel(validateTicketLink({ kind: 'harness', id: 'TKT-4' })!)).toBe('TKT-4');
  });

  it('metricLabel / resultSummary / statusFilter', () => {
    expect(metricLabel({ source: 'gsc', measure: 'clicks', config: '/c', page: 'p', query: 'q' })).toBe('gsc clicks · page p · query q');
    expect(metricLabel({ source: 'ga4', measure: 'events', config: '/c', event: 'generate_lead', label: 'Inquiries' })).toBe('Inquiries · event generate_lead');
    expect(resultSummary({
      id: 'EXP-1', traceId: 'exp:EXP-1', title: 'T', hypothesis: 'H', direction: 'decrease', expected: { to: 5 }, metric: { source: 'gsc', measure: 'position', config: '/c' },
      windowDays: 14, createdBy: 'a', confidence: 0.6, status: 'done', createdAt: '', updatedAt: '', timeline: [], verdict: 'didnt', verdictReason: 'R',
      result: { start: 's', end: 'e', total: 6, volume: 1, days: [], fetchedAt: '' },
    })).toBe("**EXP-1 didn't work: T**\nHypothesis: H\nMetric: gsc position\nResult: R\nTarget 5.0: not reached");
    expect(statusFilter('done')).toBe('done');
    expect(statusFilter('nope')).toBeUndefined();
  });
});

describe('ExperimentService run traces (#983)', () => {
  let dir: string;
  let store: TraceStore;

  function service(): ExperimentService {
    return new ExperimentService({
      storeFile: path.join(dir, 'experiments.json'),
      fetchMetric: jest.fn(async (_m: ExperimentMetric, r: DateRange) => meas(r, 10)),
      fileExists: async () => true,
      now: () => new Date('2026-10-10T15:00:00Z'),
      logger: silent,
    });
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exp-trace-'));
    store = new TraceStore({ dir: path.join(dir, 'traces'), indexFlushDelayMs: 5 });
    setTraceStoreForTesting(store);
    setTraceContextForTesting(null);
  });

  afterEach(async () => {
    await store.idle();
    setTraceStoreForTesting(null);
    setTraceContextForTesting(null);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('starts an experiment trace, links EXP-n and the ticket, and mirrors the timeline', async () => {
    const svc = service();
    const e = await svc.create({ hypothesis: 'FAQ schema → clicks up', metric: METRIC, ticket: { kind: 'project', project: 'ce-site', id: 'CE-31' } }, 'ella');
    expect(store.getEntry(e.traceId)?.root).toMatchObject({ kind: 'experiment', actor: { kind: 'agent', session: 'ella' }, refs: { experimentId: 'EXP-1', ticketId: 'CE-31' } });
    expect(store.traceByRef('experiment', 'EXP-1')).toBe(e.traceId);
    expect(store.traceByRef('ticket', 'CE-31')).toBe(e.traceId);
    await svc.cancel('EXP-1', 'ella', 'not needed');
    const events = (await store.read(e.traceId, 0, 100))!.events.filter((ev) => ev.type === 'experiment.event');
    expect(events.map((ev) => ev.data?.event)).toEqual(['created', 'cancelled']);
    expect(events.every((ev) => ev.refs.experimentId === 'EXP-1')).toBe(true);
  });

  it("joins its ticket's existing trace", async () => {
    const existing = getTraceContext().startTrace({ kind: 'request', summary: 'TKT-007: speed up the form', actor: { kind: 'owner' } })!;
    store.linkRef('ticket', 'TKT-007', existing);
    const e = await service().create({ hypothesis: 'Shorter form → more submissions', metric: METRIC, ticket: { kind: 'harness', id: 'TKT-007' } }, 'owner');
    expect(e.traceId).toBe(existing);
    expect(store.list()).toHaveLength(1);
    expect(store.traceByRef('experiment', 'EXP-1')).toBe(existing);
  });

  it('keeps the trace id out of the owner-facing result', () => {
    const summary = resultSummary({
      id: 'EXP-2', traceId: 'tr-20261010-0123abcd', title: 'T', hypothesis: 'H', direction: 'increase', metric: { source: 'gsc', measure: 'clicks', config: '/c' },
      windowDays: 14, createdBy: 'a', confidence: 0.6, status: 'done', createdAt: 'x', updatedAt: 'x', timeline: [], verdict: 'worked', verdictReason: 'R',
    } as unknown as Parameters<typeof resultSummary>[0]);
    expect(summary).not.toMatch(/tr-20261010|Trace:/);
  });
});

describe('ExperimentService — autopilot scope (specs/2026-10-03-autopilot-experiments.md §3)', () => {
  let dir: string;
  let clock: Date;
  let fetchMetric: jest.Mock<Promise<Measurement>, [ExperimentMetric, DateRange]>;
  let notifyOwner: jest.Mock;
  let process: jest.Mock;

  const PRIMARY = { source: 'ga4', measure: 'events', event: 'feed_card_click', channel: 'all', config: '/cfg/ce.json', label: 'Feed card clicks' };
  const EXTRA = [
    { source: 'ga4', measure: 'sessions', page: '/feed', pageMatch: 'contains', channel: 'all' },
    { source: 'gsc', measure: 'clicks', page: 'https://visa.careerengine.us/feed', pageMatch: 'contains' },
  ];
  const summary = (range: DateRange, shipped: number) => ({
    range, ticketsStarted: shipped + 1, ticketsDone: shipped, ticketsShipped: shipped, ownerTouches: shipped * 2,
    ownerTouchesPerTicket: shipped ? 2 : null, stalls: 1, stallMs: 2 * 3_600_000, interventions: 3, tokens: 1000, costUsd: shipped * 1.5,
    costPerShippedTicket: shipped ? 1.5 : null, pausedMs: 0,
  });

  function service(extra: Partial<ExperimentServiceDeps> = {}): ExperimentService {
    return new ExperimentService({
      storeFile: path.join(dir, 'experiments.json'),
      fetchMetric,
      notifyOwner,
      fileExists: async (f) => f === '/cfg/ce.json',
      autopilot: {
        resolveProject: async (ref) => {
          if (ref !== 'CE' && ref !== 'p-ce') throw new Error(`Project not found: ${ref}`);
          return { id: 'p-ce', name: 'CE' };
        },
        process,
      },
      now: () => clock,
      logger: silent,
      ...extra,
    });
  }

  const create = (svc: ExperimentService, extra: Record<string, unknown> = {}) =>
    svc.create({ hypothesis: 'Autopilot drives /feed → feed card clicks up', metric: PRIMARY, autopilot: { project: 'CE', label: 'feed' }, metrics: EXTRA, ...extra }, 'owner');

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exp-ap-'));
    clock = new Date('2026-10-10T15:00:00Z');
    fetchMetric = jest.fn(async (_m: ExperimentMetric, r: DateRange) => meas(r, r.start < '2026-10-10' ? 100 : 160));
    notifyOwner = jest.fn().mockResolvedValue(true);
    process = jest.fn(async (_p: string, _l: string | null, r: DateRange) => summary(r, r.start < '2026-10-10' ? 0 : 6));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('starts at creation: baselines of every outcome metric plus the process baseline', async () => {
    const e = await create(service());
    expect(e).toMatchObject({ status: 'running', shippedAt: '2026-10-10T15:00:00.000Z', autopilot: { projectId: 'p-ce', projectName: 'CE', label: 'feed', checkIns: 0 } });
    expect(e.baseline?.total).toBe(100);
    expect(fetchMetric).toHaveBeenCalledWith(expect.objectContaining({ event: 'feed_card_click' }), { start: '2026-09-25', end: '2026-10-08' });
    expect(e.autopilot?.outcomes.map((o) => [o.metric.source, o.metric.measure, o.metric.config, o.baseline?.start])).toEqual([
      ['ga4', 'sessions', '/cfg/ce.json', '2026-09-25'],
      ['gsc', 'clicks', '/cfg/ce.json', '2026-09-24'],
    ]);
    // Process windows are local days; the start day belongs to the observation window.
    expect(process).toHaveBeenCalledWith('p-ce', 'feed', { start: '2026-09-26', end: '2026-10-09' });
    expect(e.autopilot?.processBaseline?.ticketsShipped).toBe(0);
    expect(e.timeline.map((t) => t.event)).toEqual(['created', 'autopilot_scope', 'shipped', 'baseline_captured', 'outcome_baseline', 'outcome_baseline', 'process_baseline']);
  });

  it('honours startedAt and validates the scope', async () => {
    const e = await create(service(), { startedAt: '2026-10-08T00:00:00Z' });
    expect(e.shippedAt).toBe('2026-10-08T00:00:00.000Z');
    await expect(create(service(), { startedAt: '2026-11-01T00:00:00Z' })).rejects.toThrow('in the future');
    await expect(create(service(), { autopilot: { project: 'nope' } })).rejects.toThrow('autopilot.project: Project not found: nope');
    await expect(create(service(), { autopilot: {} })).rejects.toThrow('autopilot.project is required');
    await expect(create(service(), { metrics: [{ source: 'ga4', measure: 'clicks' }] })).rejects.toThrow(/metrics\[0\]: metric.measure for ga4/);
    await expect(service().create({ hypothesis: 'h', metric: PRIMARY, metrics: EXTRA }, 'owner')).rejects.toThrow('metrics (extra outcome metrics) are for autopilot cards');
    await expect(create(service({ autopilot: undefined }))).rejects.toThrow('Autopilot experiments are not available');
  });

  it('retries a failed outcome baseline without blocking the primary', async () => {
    fetchMetric.mockImplementation(async (m: ExperimentMetric, r: DateRange) => {
      if (m.source === 'gsc') throw new Error('Environment variable SEO_OPS_GOOGLE_CREDENTIALS is not set.');
      return meas(r, 100);
    });
    const svc = service();
    const e = await create(svc);
    expect(e.baseline?.total).toBe(100);
    expect(e.autopilot?.outcomes[1].lastError).toContain('SEO_OPS_GOOGLE_CREDENTIALS');
    await svc.tick(); // same error: not recorded again
    expect((await svc.get(e.id))!.timeline.filter((t) => t.event === 'fetch_failed')).toHaveLength(1);
    fetchMetric.mockImplementation(async (_m: ExperimentMetric, r: DateRange) => meas(r, 90));
    await svc.tick();
    const after = (await svc.get(e.id))!;
    expect(after.autopilot?.outcomes[1].baseline?.total).toBe(90);
    expect(after.autopilot?.outcomes[1].lastError).toBeUndefined();
  });

  it('sends one short check-in a week while running', async () => {
    const svc = service();
    const e = await create(svc);
    clock = new Date('2026-10-16T15:00:00Z');
    await svc.tick();
    expect(notifyOwner).not.toHaveBeenCalled();
    clock = new Date('2026-10-17T16:00:00Z');
    notifyOwner.mockResolvedValueOnce(false); // Slack down: retried on the next tick
    await svc.tick();
    expect((await svc.get(e.id))!.autopilot?.checkIns).toBe(0);
    await svc.tick();
    expect(notifyOwner).toHaveBeenCalledTimes(2);
    const note = notifyOwner.mock.calls[1][0];
    expect(note.title).toBe('Experiment EXP-1: week 1');
    expect(note.message).toContain('6 tickets shipped (7 started) · 2 owner touches per ticket · stalls 1 (2h) · $1.50 per shipped ticket');
    // Settled days only (GA4 lags 2 days): 10-11 .. 10-14.
    expect(note.message).toContain('Feed card clicks · event feed_card_click: 160 over the first 4 days (baseline 100 over 14 days)');
    expect(process).toHaveBeenLastCalledWith('p-ce', 'feed', { start: '2026-10-10', end: '2026-10-17' });
    await svc.tick();
    expect(notifyOwner).toHaveBeenCalledTimes(2);
    const after = (await svc.get(e.id))!;
    expect(after.autopilot).toMatchObject({ checkIns: 1 });
    expect(after.timeline.filter((t) => t.event === 'check_in')).toHaveLength(1);
  });

  it('the result has the outcome verdicts and the process summary', async () => {
    const svc = service();
    const e = await create(svc);
    expect(e.dueAt).toBe('2026-10-27T00:00:00.000Z');
    clock = new Date('2026-10-28T01:00:00Z'); // past due: the gsc metric's window (lag 3) has settled too
    await svc.tick();
    const done = (await svc.get(e.id))!;
    expect(done).toMatchObject({ status: 'done', verdict: 'worked' });
    expect(done.autopilot?.outcomes.map((o) => o.verdict)).toEqual(['worked', 'worked']);
    expect(done.autopilot?.processResult).toMatchObject({ ticketsShipped: 6, range: { start: '2026-10-10', end: '2026-10-23' } });
    expect(done.timeline.map((t) => t.event)).toEqual(expect.arrayContaining(['measured', 'outcome_result', 'process_result', 'reported']));
    const report = notifyOwner.mock.calls.find((c) => c[0].title === 'Experiment EXP-1 worked')![0].message as string;
    expect(report).toContain('Other metrics:');
    expect(report).toContain('- ga4 sessions · page /feed: sessions 100 → 160 (+60%)');
    expect(report).toContain('Process (autopilot of CE, label feed): 6 tickets shipped (7 started) · 2 owner touches per ticket');
    expect(report).toContain('Process before: 0 tickets shipped (1 started) · 0 owner touches');
  });

  it('process windows are local days with the start day in the observation', () => {
    const w = processWindows(new Date(2026, 9, 10, 15).toISOString(), 14);
    expect(w.baseline).toEqual({ start: '2026-09-26', end: '2026-10-09' });
    expect(w.observation).toEqual({ start: '2026-10-10', end: '2026-10-23' });
    expect(w.dueAtMs).toBe(new Date(2026, 9, 24).getTime());
  });

  it('records the process result on schedule while the outcome fetch keeps failing, and reminds the owner weekly', async () => {
    fetchMetric.mockRejectedValue(new Error('Environment variable SEO_OPS_GOOGLE_CREDENTIALS is not set.'));
    const svc = service();
    const e = await create(svc);
    expect(e.baseline).toBeUndefined();
    expect(e.autopilot?.processBaseline).toBeDefined(); // not held by the failing outcome fetch
    // Fail until stuck: the first stuck notice.
    for (let i = 0; i < 6; i += 1) {
      clock = new Date(clock.getTime() + 20 * 60_000);
      await svc.tick();
    }
    const stuck = notifyOwner.mock.calls.filter((c) => /can't fetch/.test(c[0].title));
    expect(stuck).toHaveLength(1);
    // The observation window ends: the process result is recorded anyway.
    clock = new Date(2026, 9, 24, 12);
    await svc.tick();
    const after = (await svc.get(e.id))!;
    expect(after.status).toBe('running');
    expect(after.autopilot?.processResult).toMatchObject({ ticketsShipped: 6 });
    expect(after.timeline.map((t) => t.event)).toContain('process_result');
    const reminders = () => notifyOwner.mock.calls.filter((c) => /still can't fetch/.test(c[0].title));
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0][0].message).toContain('Process so far: 6 tickets shipped');
    clock = new Date(2026, 9, 26, 12);
    await svc.tick();
    expect(reminders()).toHaveLength(1); // at most once a week
    clock = new Date(2026, 10, 1, 13);
    await svc.tick();
    expect(reminders()).toHaveLength(2);
  });

  it('stores a baseline window without autopilot traces as no data, and leaves it out of the result', async () => {
    process.mockImplementation(async (_p: string, _l: string | null, r: DateRange) => (r.start < '2026-10-10' ? { ...summary(r, 0), noData: true } : summary(r, 6)));
    const svc = service();
    const e = await create(svc);
    expect(e.autopilot?.processBaseline?.noData).toBe(true);
    expect(e.timeline.find((t) => t.event === 'process_baseline')?.detail).toMatch(/^no autopilot work in/);
    clock = new Date('2026-10-28T01:00:00Z');
    await svc.tick();
    const report = notifyOwner.mock.calls.find((c) => c[0].title === 'Experiment EXP-1 worked')![0].message as string;
    expect(report).toContain('Process (autopilot of CE, label feed): 6 tickets shipped');
    expect(report).not.toContain('Process before');
  });

  it('a failed process read is retried, never stored as zeros', async () => {
    const ok = process.getMockImplementation()!;
    process.mockRejectedValue(new Error('index unreadable'));
    const svc = service();
    const e = await create(svc);
    expect(e.autopilot?.processBaseline).toBeUndefined();
    process.mockImplementation(ok);
    await svc.tick();
    expect((await svc.get(e.id))!.autopilot?.processBaseline?.ticketsShipped).toBe(0);
  });
});
