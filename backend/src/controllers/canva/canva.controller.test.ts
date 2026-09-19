/**
 * Tests for the Canva controller — envelopes, not_connected → 409 + connect
 * URL hint, query/body plumbing, export success flag.
 *
 * @module controllers/canva/canva.controller.test
 */

import request from 'supertest';
import express, { type Application } from 'express';
import { createCanvaRouter } from './canva.routes.js';
import { setCanvaControllerDeps, type CanvaControllerDeps } from './canva.controller.js';
import { CanvaError, type CanvaTokenService } from '../../services/canva/canva-token.service.js';
import type { CanvaService } from '../../services/canva/canva.service.js';

jest.mock('../../services/core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));

const CONNECT_URL = 'https://api.crewlyai.com/api/cloud/canva/start?token=cloud-jwt&returnUrl=x';

let app: Application;
let tokens: { status: jest.Mock; disconnect: jest.Mock; buildConnectUrl: jest.Mock };
let canva: { listDesigns: jest.Mock; getDesign: jest.Mock; createDesign: jest.Mock; exportDesign: jest.Mock; uploadAsset: jest.Mock };

beforeEach(() => {
  tokens = {
    status: jest.fn().mockResolvedValue({ connected: true, cloudConnected: true, canvaUserId: 'cu' }),
    disconnect: jest.fn().mockResolvedValue({ removed: true }),
    buildConnectUrl: jest.fn().mockReturnValue(CONNECT_URL),
  };
  canva = { listDesigns: jest.fn(), getDesign: jest.fn(), createDesign: jest.fn(), exportDesign: jest.fn(), uploadAsset: jest.fn() };
  setCanvaControllerDeps({ tokens: tokens as unknown as CanvaTokenService, canva: canva as unknown as CanvaService } as CanvaControllerDeps);
  app = express();
  app.use(express.json({ limit: '60mb' }));
  app.use('/api/canva', createCanvaRouter());
});

afterEach(() => setCanvaControllerDeps(null));

it('status / connect-url / disconnect wrap the token service', async () => {
  expect((await request(app).get('/api/canva/status')).body).toEqual({ success: true, data: { connected: true, cloudConnected: true, canvaUserId: 'cu' } });
  const cu = await request(app).get('/api/canva/connect-url');
  expect(cu.body.data.url).toBe(CONNECT_URL);
  expect(tokens.buildConnectUrl.mock.calls[0][0]).toMatch(/\/connections\?platform=canva$/);
  expect((await request(app).delete('/api/canva/disconnect')).body).toEqual({ success: true, data: { removed: true } });
});

it('designs: list passes the filters, get by id, create with the body', async () => {
  canva.listDesigns.mockResolvedValue({ designs: [{ id: 'd1' }], continuation: 'c2' });
  const res = await request(app).get('/api/canva/designs?q=poster&ownership=owned&sort=modified_descending&limit=5&continuation=c1');
  expect(res.body.data).toEqual({ count: 1, designs: [{ id: 'd1' }], continuation: 'c2' });
  expect(canva.listDesigns).toHaveBeenCalledWith({ query: 'poster', ownership: 'owned', sortBy: 'modified_descending', limit: 5, continuation: 'c1' });
  canva.getDesign.mockResolvedValue({ id: 'd1' });
  expect((await request(app).get('/api/canva/designs/d1')).body.data).toEqual({ id: 'd1' });
  canva.createDesign.mockResolvedValue({ id: 'n1', editUrl: 'https://e' });
  await request(app).post('/api/canva/designs').send({ title: 'T', preset: 'presentation' });
  expect(canva.createDesign).toHaveBeenCalledWith({ title: 'T', preset: 'presentation', width: undefined, height: undefined, assetId: undefined });
});

it('export reports success=false for a failed job; assets decode base64', async () => {
  canva.exportDesign.mockResolvedValue({ jobId: 'j', status: 'failed', urls: [], error: { code: 'x' } });
  const res = await request(app).post('/api/canva/designs/d1/export').send({ format: 'pdf', pages: [1] });
  expect(res.body).toEqual({ success: false, data: { jobId: 'j', status: 'failed', urls: [], error: { code: 'x' } } });
  expect(canva.exportDesign).toHaveBeenCalledWith({ designId: 'd1', format: 'pdf', quality: undefined, videoQuality: undefined, pages: [1] });
  canva.uploadAsset.mockResolvedValue({ id: 'a1', name: 'logo.png' });
  await request(app).post('/api/canva/assets').send({ name: 'logo.png', content: Buffer.from([1, 2]).toString('base64') });
  expect(canva.uploadAsset).toHaveBeenCalledWith('logo.png', Buffer.from([1, 2]));
});

it('maps not_connected to 409 with the connect URL, validation to 400, and unexpected throws to 500', async () => {
  canva.getDesign.mockRejectedValueOnce(new CanvaError(409, 'not_connected', 'no grant'));
  let res = await request(app).get('/api/canva/designs/d1');
  expect(res.status).toBe(409);
  expect(res.body).toEqual({ success: false, error: 'not_connected', message: 'no grant', hint: CONNECT_URL });
  canva.getDesign.mockRejectedValueOnce(new CanvaError(400, 'validation', 'bad'));
  res = await request(app).get('/api/canva/designs/d1');
  expect(res.status).toBe(400);
  canva.getDesign.mockRejectedValueOnce(new Error('boom'));
  res = await request(app).get('/api/canva/designs/d1');
  expect(res.status).toBe(500);
  expect(res.body.error).toBe('internal');
});
