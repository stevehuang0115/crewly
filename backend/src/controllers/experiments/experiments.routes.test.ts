/**
 * Tests for /api/experiments (issue #986).
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { createExperimentsRouter } from './experiments.routes.js';
import { ExperimentService } from '../../services/experiments/experiment.service.js';
import { API_SECURITY_CONSTANTS } from '../../constants.js';

const METRIC = { source: 'ga4', measure: 'events', event: 'generate_lead', config: '/cfg/ce.json' };

describe('/api/experiments', () => {
  let dir: string;
  let svc: ExperimentService;
  let app: express.Express;
  let clock: Date;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exp-routes-'));
    clock = new Date('2026-10-10T12:00:00Z');
    svc = new ExperimentService({
      storeFile: path.join(dir, 'experiments.json'),
      fetchMetric: async (_m, r) => ({ start: r.start, end: r.end, total: r.end < '2026-09-01' ? 5 : 30, volume: 0, days: [], fetchedAt: 'T' }),
      now: () => clock,
      logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as never,
    });
    app = express();
    app.use(express.json());
    app.use('/api/experiments', createExperimentsRouter(() => svc));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates (caller = agent session), lists, reads, ships, measures', async () => {
    const created = await request(app)
      .post('/api/experiments')
      .set(API_SECURITY_CONSTANTS.AGENT_SESSION_HEADER, 'ella')
      .send({ hypothesis: 'Shorter inquiry form → submissions from 5 to 10', metric: METRIC, ticket: { kind: 'harness', id: 'TKT-7' } });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ id: 'EXP-1', createdBy: 'ella', status: 'planned' });

    expect((await request(app).get('/api/experiments')).body.data).toHaveLength(1);
    expect((await request(app).get('/api/experiments?status=done')).body.data).toHaveLength(0);
    expect((await request(app).get('/api/experiments?ticket=TKT-7')).body.data).toHaveLength(1);
    expect((await request(app).get('/api/experiments?status=bogus')).status).toBe(400);
    expect((await request(app).get('/api/experiments/EXP-1')).body.data.traceId).toMatch(/^tr-\d{8}-[0-9a-f]{8}$/);
    expect((await request(app).get('/api/experiments/EXP-9')).status).toBe(404);

    const shipped = await request(app).post('/api/experiments/EXP-1/ship').send({ shippedAt: '2026-09-01T00:00:00Z' });
    expect(shipped.body.data).toMatchObject({ status: 'running', baseline: { total: 5 } });
    expect(shipped.body.data.timeline.find((t: { event: string }) => t.event === 'shipped').detail).toContain('by owner');

    const measured = await request(app).post('/api/experiments/EXP-1/measure');
    expect(measured.body.data).toMatchObject({ status: 'done', verdict: 'worked' });
  });

  it('validation errors are 400, lifecycle conflicts 409, cancel works', async () => {
    expect((await request(app).post('/api/experiments').send({ metric: METRIC })).status).toBe(400);
    await request(app).post('/api/experiments').send({ hypothesis: 'h', metric: METRIC });
    expect((await request(app).post('/api/experiments/EXP-1/measure')).status).toBe(409);
    const c = await request(app).post('/api/experiments/EXP-1/cancel').send({ reason: 'dup' });
    expect(c.body.data.status).toBe('cancelled');
    expect((await request(app).post('/api/experiments/EXP-1/ship').send({})).status).toBe(409);
  });

  it('503 before the service runs; 500 on an unexpected error', async () => {
    const off = express();
    off.use(express.json());
    off.use('/api/experiments', createExperimentsRouter(() => null));
    expect((await request(off).get('/api/experiments')).status).toBe(503);
    jest.spyOn(svc, 'list').mockRejectedValueOnce(new Error('disk'));
    const res = await request(app).get('/api/experiments');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('disk');
  });
});
