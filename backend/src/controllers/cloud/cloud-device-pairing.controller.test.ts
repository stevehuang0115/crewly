/**
 * Integration tests for the backend's device pairing endpoints
 * (`/api/cloud/device/*`): owner-only, start/status/cancel wired to the
 * pairing service, no secrets in responses. Placeholder values only.
 *
 * @module controllers/cloud/cloud-device-pairing.controller.test
 */

import express from 'express';
import request from 'supertest';
import {
  startCloudDevicePairing,
  getCloudDevicePairingStatus,
  cancelCloudDevicePairing,
  setCloudDevicePairingServiceForTests,
  getCloudDevicePairingService,
} from './cloud-device-pairing.controller.js';
import { CloudDevicePairingService } from '../../services/cloud/cloud-device-pairing.service.js';
import type { DevicePairingOutcome } from '../../services/cloud/cloud-device-pairing.client.js';

jest.mock('./cloud.controller.js', () => ({ performCloudConnect: jest.fn() }));

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

function createApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/cloud/device/start', startCloudDevicePairing);
  app.get('/api/cloud/device/status', getCloudDevicePairingStatus);
  app.post('/api/cloud/device/cancel', cancelCloudDevicePairing);
  return app;
}

describe('cloud device pairing endpoints', () => {
  let resolveOutcome: (o: DevicePairingOutcome) => void;
  let connect: jest.Mock;
  let start: jest.Mock;
  let service: CloudDevicePairingService;

  beforeEach(() => {
    connect = jest.fn().mockResolvedValue({ tier: 'free' });
    start = jest.fn().mockResolvedValue({
      deviceCode: 'device-secret',
      userCode: 'ABCD-2345',
      verificationUrl: 'https://portal.example.test/cloud/pair?code=ABCD-2345',
      expiresIn: 900,
      interval: 5,
    });
    service = new CloudDevicePairingService({
      cloudUrl: () => 'https://api.example.test',
      identity: async () => ({ deviceId: 'dev-1', deviceName: 'studio-mac' }),
      connect,
      start,
      wait: () => new Promise<DevicePairingOutcome>((resolve) => { resolveOutcome = resolve; }),
      logger: silentLogger as never,
    });
    setCloudDevicePairingServiceForTests(service);
  });
  afterEach(() => setCloudDevicePairingServiceForTests(null));

  it('start → status pending → owner approves → status connected, no secrets on the wire', async () => {
    const app = createApp();
    const started = await request(app).post('/api/cloud/device/start').send({ deviceName: 'Office Mac' });
    expect(started.status).toBe(200);
    expect(started.body.data).toMatchObject({ state: 'pending', userCode: 'ABCD-2345', deviceName: 'Office Mac' });
    expect(started.body.data.verificationUrl).toContain('/cloud/pair?code=ABCD-2345');
    expect(JSON.stringify(started.body)).not.toContain('device-secret');

    expect((await request(app).get('/api/cloud/device/status')).body.data.state).toBe('pending');

    resolveOutcome({ status: 'approved', credentials: { token: 'access-x', refreshToken: 'refresh-x', tier: 'free' } });
    await service.settled();
    const status = await request(app).get('/api/cloud/device/status');
    expect(status.headers['cache-control']).toContain('no-store');
    expect(status.body.data).toMatchObject({ state: 'connected', tier: 'free' });
    expect(JSON.stringify(status.body)).not.toMatch(/access-x|refresh-x/);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('cancel stops a pending pairing', async () => {
    const app = createApp();
    await request(app).post('/api/cloud/device/start').send({});
    const cancelled = await request(app).post('/api/cloud/device/cancel');
    expect(cancelled.body.data.state).toBe('cancelled');
  });

  it.each([
    ['post', '/api/cloud/device/start'],
    ['get', '/api/cloud/device/status'],
    ['post', '/api/cloud/device/cancel'],
  ] as const)('%s %s refuses an agent session (403)', async (method, path) => {
    const res = await request(createApp())[method](path).set('X-Agent-Session', 'crewly-orc');
    expect(res.status).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it('a Cloud refusal on start is a 502 with the reason', async () => {
    start.mockRejectedValueOnce(new Error('Too many pairing requests'));
    const res = await request(createApp()).post('/api/cloud/device/start').send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Too many pairing requests');
  });

  it('builds a real service when none is injected', () => {
    setCloudDevicePairingServiceForTests(null);
    const real = getCloudDevicePairingService();
    expect(real).toBeInstanceOf(CloudDevicePairingService);
    expect(getCloudDevicePairingService()).toBe(real);
    expect(real.getStatus()).toEqual({ state: 'idle' });
  });
});
