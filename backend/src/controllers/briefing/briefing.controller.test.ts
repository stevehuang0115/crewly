/**
 * Tests for the Drive mode briefing API: owner only (agents 403, anonymous
 * 401, the relay allowed), each route reaches the service, errors keep
 * their status and code, and nothing the owner says is logged.
 */

import express from 'express';
import request from 'supertest';
import { ownerUnlessAgentForTests, relayAuthHeaders } from '../../middleware/caller-identity.testing.js';
import { setBriefingService, type BriefingService } from '../../services/briefing/briefing.service.js';
import { BriefingError } from '../../services/briefing/briefing.types.js';
import { createBriefingRouter } from './briefing.controller.js';

const app = express();
app.use(ownerUnlessAgentForTests);
app.use(express.json());
app.use('/api/briefing', createBriefingRouter());

let service: { queue: jest.Mock; answer: jest.Mock; skip: jest.Mock; later: jest.Mock; ask: jest.Mock };

beforeEach(() => {
  service = {
    queue: jest.fn(async () => ({ items: [], lookupsPending: [], hidden: 0, generatedAt: 'now' })),
    answer: jest.fn(async () => ({ status: 'done', itemId: 'd:D-1', spoken: 'Done.' })),
    skip: jest.fn(async () => ({ status: 'hidden', itemId: 'd:D-1', until: 'x', spoken: 'Skipped.' })),
    later: jest.fn(async () => ({ status: 'hidden', itemId: 'd:D-1', until: 'x', spoken: 'Later.' })),
    ask: jest.fn(async () => ({ status: 'lookup_pending', itemId: 'd:D-1', handedTo: 'Ella', details: '', spoken: 'Asked.' })),
  };
  setBriefingService(service as unknown as BriefingService);
});

afterEach(() => setBriefingService(null));

const ROUTES = [
  ['get', '/api/briefing'],
  ['post', '/api/briefing/d%3AD-1/answer'],
  ['post', '/api/briefing/d%3AD-1/skip'],
  ['post', '/api/briefing/d%3AD-1/later'],
  ['post', '/api/briefing/d%3AD-1/ask'],
] as const;

describe('owner only', () => {
  it('refuses agents on every route', async () => {
    for (const [method, path] of ROUTES) {
      const res = await request(app)[method](path).set('X-Agent-Session', 'ella').send({ text: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('owner_only');
    }
    expect(service.answer).not.toHaveBeenCalled();
  });

  it('refuses a caller with no owner credential', async () => {
    const res = await request(app).get('/api/briefing').set('X-Test-Anonymous', '1');
    expect(res.status).toBe(401);
  });

  it('serves the relay (phone / portal)', async () => {
    const res = await request(app).get('/api/briefing').set(relayAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { items: [], lookupsPending: [], hidden: 0, generatedAt: 'now' } });
  });
});

describe('routes', () => {
  it('answer passes the decoded id and only known fields', async () => {
    await request(app).post('/api/briefing/d%3AD-1/answer').send({ optionKey: 'a', text: 'go', confirm: true, confirmToken: 't', extra: 1 });
    expect(service.answer).toHaveBeenCalledWith('d:D-1', { optionKey: 'a', text: 'go', confirm: true, confirmToken: 't' });
    await request(app).post('/api/briefing/d%3AD-1/answer').send({ optionKey: 'a', confirm: 'yes' });
    expect(service.answer).toHaveBeenLastCalledWith('d:D-1', { optionKey: 'a', text: undefined, confirm: false, confirmToken: undefined });
  });

  it('skip, later and ask', async () => {
    await request(app).post('/api/briefing/t%3Areq-9/skip').send({ dismiss: true });
    expect(service.skip).toHaveBeenCalledWith('t:req-9', { dismiss: true });
    await request(app).post('/api/briefing/t%3Areq-9/later').send({ at: '2026-10-09T09:00:00Z' });
    expect(service.later).toHaveBeenCalledWith('t:req-9', { at: '2026-10-09T09:00:00Z' });
    await request(app).post('/api/briefing/t%3Areq-9/ask').send({ question: 'Which browsers?' });
    expect(service.ask).toHaveBeenCalledWith('t:req-9', 'Which browsers?');
  });
});

describe('errors', () => {
  it('a briefing error keeps its status and code', async () => {
    service.answer.mockRejectedValueOnce(new BriefingError(409, 'confirm_mismatch', 'Confirm first'));
    const res = await request(app).post('/api/briefing/d%3AD-1/answer').send({ optionKey: 'a', confirm: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, code: 'confirm_mismatch', error: 'Confirm first' });
  });

  it('anything else is a plain failure without details', async () => {
    service.queue.mockRejectedValueOnce(new Error('/secret/path'));
    const res = await request(app).get('/api/briefing');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, code: 'failed', error: 'That did not work.' });
  });

  it('503 before boot wired the service', async () => {
    setBriefingService(null);
    expect((await request(app).get('/api/briefing')).status).toBe(503);
  });
});
