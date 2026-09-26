/**
 * Tests for the owner receipt API (#828).
 */

import express from 'express';
import request from 'supertest';
import { createRequest } from '../../types/v2/request.types.js';
import { OwnerReceiptService, setOwnerReceiptService } from '../../services/v3/owner-receipt/owner-receipt.service.js';
import { createOwnerReceiptRouter } from './owner-receipt.routes.js';

const app = express();
app.use(express.json());
app.use('/api/owner-receipt', createOwnerReceiptRouter());

const NOW = new Date('2026-09-27T01:00:00Z');
let sent: string[];
let senderOk: boolean;

beforeEach(() => {
  sent = [];
  senderOk = true;
  const t = { ...createRequest({ sourceConversationItemId: 'r1', title: 't', description: '研究 Orca', ticketNumber: 1 }), createdAt: '2026-09-26T15:00:00Z', status: 'done' as const };
  setOwnerReceiptService(
    new OwnerReceiptService({
      listRequests: async () => [t],
      listWorkItems: async () => [],
      loadTeamIndex: async () => new Map(),
      sender: async (text) => {
        sent.push(text);
        return senderOk;
      },
      statePath: null,
      now: () => NOW,
    }),
  );
});

afterEach(() => setOwnerReceiptService(null));

describe('GET /api/owner-receipt', () => {
  it('returns the data and the rendered text', async () => {
    const res = await request(app).get('/api/owner-receipt');
    expect(res.status).toBe(200);
    expect(res.body.data.receipt).toMatchObject({ askCount: 1, window: { basis: 'local_day' } });
    expect(res.body.data.text).toContain('研究 Orca');
  });

  it('takes an explicit window and a mode, and rejects bad ones', async () => {
    const res = await request(app).get('/api/owner-receipt?from=2026-09-26T16:00:00Z&to=2026-09-26T18:00:00Z');
    expect(res.body.data.receipt).toMatchObject({ askCount: 0, window: { basis: 'explicit' } });
    expect((await request(app).get('/api/owner-receipt?from=yesterday')).status).toBe(400);
    expect((await request(app).get('/api/owner-receipt?mode=week')).status).toBe(400);
    expect((await request(app).get('/api/owner-receipt?mode=local_day')).status).toBe(200);
  });

  it('503 when not wired', async () => {
    setOwnerReceiptService(null);
    expect((await request(app).get('/api/owner-receipt')).status).toBe(503);
  });
});

describe('settings', () => {
  it('the owner can read and change them (PUT and the POST twin)', async () => {
    expect((await request(app).get('/api/owner-receipt/settings')).body.data).toEqual({
      settings: { enabled: true, time: '21:00', timezone: 'America/New_York' },
      lastSentAt: null,
    });
    const put = await request(app).put('/api/owner-receipt/settings').send({ time: '20:30' });
    expect(put.body.data.settings.time).toBe('20:30');
    const post = await request(app).post('/api/owner-receipt/settings').send({ enabled: false });
    expect(post.body.data.settings).toMatchObject({ enabled: false, time: '20:30' });
  });

  it('rejects bad values with 400', async () => {
    expect((await request(app).put('/api/owner-receipt/settings').send({ time: '9pm' })).status).toBe(400);
  });

  it('refuses an agent', async () => {
    const res = await request(app).put('/api/owner-receipt/settings').set('X-Agent-Session', 'ella').send({ enabled: false });
    expect(res.status).toBe(403);
    expect((await request(app).get('/api/owner-receipt/settings')).body.data.settings.enabled).toBe(true);
  });
});

describe('POST /api/owner-receipt/send', () => {
  it('sends now and records the send', async () => {
    const res = await request(app).post('/api/owner-receipt/send');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ sent: true, askCount: 1 });
    expect(sent).toHaveLength(1);
    expect((await request(app).get('/api/owner-receipt/settings')).body.data.lastSentAt).toBe(NOW.toISOString());
  });

  it('502 when Slack does not accept it', async () => {
    senderOk = false;
    const res = await request(app).post('/api/owner-receipt/send');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('sender_failed');
  });

  it('refuses an agent', async () => {
    expect((await request(app).post('/api/owner-receipt/send').set('X-Agent-Session', 'ella')).status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});
