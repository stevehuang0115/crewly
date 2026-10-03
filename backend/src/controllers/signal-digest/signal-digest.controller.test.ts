/**
 * Tests for the signal digest API: envelopes, the caller header on propose,
 * the owner-only answer route, validation of its body, and error mapping.
 *
 * @module controllers/signal-digest/signal-digest.controller.test
 */

import request from 'supertest';
import express, { type Application } from 'express';
import { createSignalDigestRouter } from './signal-digest.controller.js';
import { SignalDigestError } from '../../services/signal-digest/signal-digest-contract.js';
import type { SignalDigestService } from '../../services/signal-digest/signal-digest.service.js';

let app: Application;
let service: { propose: jest.Mock; list: jest.Mock; history: jest.Mock; get: jest.Mock; choose: jest.Mock };
let running: boolean;

beforeEach(() => {
  service = { propose: jest.fn(), list: jest.fn(), history: jest.fn(), get: jest.fn(), choose: jest.fn() };
  running = true;
  app = express();
  app.use(express.json());
  app.use('/api/signal-digests', createSignalDigestRouter({ service: () => (running ? (service as unknown as SignalDigestService) : null) }));
});

it('POST / proposes as the calling agent and answers 201', async () => {
  service.propose.mockResolvedValue({ id: 'SD-1' });
  const res = await request(app).post('/api/signal-digests').set('X-Agent-Session', 'tl-owen').send({ site: 's', items: [] });
  expect(res.status).toBe(201);
  expect(res.body).toEqual({ success: true, data: { id: 'SD-1' } });
  expect(service.propose).toHaveBeenCalledWith('tl-owen', { site: 's', items: [] });
});

it('maps contract errors to their status and others to 500', async () => {
  service.propose.mockRejectedValueOnce(new SignalDigestError(409, 'already decided'));
  const conflict = await request(app).post('/api/signal-digests').set('X-Agent-Session', 'tl').send({});
  expect(conflict.status).toBe(409);
  expect(conflict.body).toEqual({ success: false, error: 'already decided' });
  service.propose.mockRejectedValueOnce(new Error('disk full'));
  expect((await request(app).post('/api/signal-digests').send({})).status).toBe(500);
});

it('GET / lists (optionally by site); /history needs a site; /:id 404s when missing', async () => {
  service.list.mockResolvedValue([]);
  await request(app).get('/api/signal-digests?site=visa.careerengine.us');
  expect(service.list).toHaveBeenLastCalledWith('visa.careerengine.us');
  await request(app).get('/api/signal-digests');
  expect(service.list).toHaveBeenLastCalledWith(undefined);

  expect((await request(app).get('/api/signal-digests/history')).status).toBe(400);
  service.history.mockResolvedValue([{ key: 'k', status: 'do' }]);
  const h = await request(app).get('/api/signal-digests/history?site=s');
  expect(h.body.data).toEqual({ site: 's', entries: [{ key: 'k', status: 'do' }] });

  service.get.mockResolvedValue(null);
  expect((await request(app).get('/api/signal-digests/SD-9')).status).toBe(404);
});

it('POST /:id/items/:n answers for the owner only, with do / skip', async () => {
  service.choose.mockResolvedValue({ id: 'SD-1' });
  const ok = await request(app).post('/api/signal-digests/SD-1/items/2').send({ choice: 'do' });
  expect(ok.status).toBe(200);
  expect(service.choose).toHaveBeenCalledWith('SD-1', 2, 'do');

  expect((await request(app).post('/api/signal-digests/SD-1/items/2').set('X-Agent-Session', 'tl').send({ choice: 'do' })).status).toBe(403);
  expect((await request(app).post('/api/signal-digests/SD-1/items/2').send({ choice: 'maybe' })).status).toBe(400);
  expect((await request(app).post('/api/signal-digests/SD-1/items/zero').send({ choice: 'skip' })).status).toBe(400);
  expect(service.choose).toHaveBeenCalledTimes(1);
});

it('answers 503 while the service is not running', async () => {
  running = false;
  const res = await request(app).get('/api/signal-digests');
  expect(res.status).toBe(503);
});
