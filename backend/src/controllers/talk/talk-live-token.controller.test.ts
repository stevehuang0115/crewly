/**
 * Tests for the Drive mode voice token API: owner only, the language passed
 * through, and the "add a key" error the page shows.
 */

import express from 'express';
import request from 'supertest';
import { ownerUnlessAgentForTests, relayAuthHeaders } from '../../middleware/caller-identity.testing.js';
import { setTalkLiveTokenService, TalkLiveTokenError, TalkLiveTokenService } from '../../services/talk/talk-live-token.service.js';
import { createTalkLiveTokenRouter } from './talk-live-token.controller.js';

const app = express();
app.use(ownerUnlessAgentForTests);
app.use(express.json());
app.use('/api/talk/live-token', createTalkLiveTokenRouter());

let mint: jest.Mock;

beforeEach(() => {
  const real = new TalkLiveTokenService({ getApiKey: () => 'k', env: {} });
  mint = jest.fn(async (language: string) => ({ token: 'auth_tokens/abc', language }));
  setTalkLiveTokenService(Object.assign(real, { mint }) as unknown as TalkLiveTokenService);
});

afterEach(() => setTalkLiveTokenService(null));

describe('owner only', () => {
  it('refuses agents', async () => {
    for (const [method, path] of [['get', '/api/talk/live-token/status'], ['post', '/api/talk/live-token']] as const) {
      const res = await request(app)[method](path).set('X-Agent-Session', 'ella');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('owner_only');
    }
    expect(mint).not.toHaveBeenCalled();
  });

  it('serves the relay', async () => {
    const res = await request(app).post('/api/talk/live-token').set(relayAuthHeaders()).send({ language: 'en-US' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ token: 'auth_tokens/abc', language: 'en' });
  });
});

describe('POST /', () => {
  it('defaults to Chinese', async () => {
    await request(app).post('/api/talk/live-token').send({});
    expect(mint).toHaveBeenCalledWith('zh');
  });

  it('no key: a code the page turns into "Add a Gemini API key in Settings"', async () => {
    mint.mockRejectedValueOnce(new TalkLiveTokenError(409, 'no_gemini_key', 'Add a Gemini API key in Settings to use Drive mode.'));
    const res = await request(app).post('/api/talk/live-token').send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, code: 'no_gemini_key', error: 'Add a Gemini API key in Settings to use Drive mode.' });
  });

  it('an unexpected error carries no details', async () => {
    mint.mockRejectedValueOnce(new Error('key=AIza...'));
    const res = await request(app).post('/api/talk/live-token').send({});
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('AIza');
  });
});

describe('GET /status', () => {
  it('says whether a key exists and which model', async () => {
    const res = await request(app).get('/api/talk/live-token/status');
    expect(res.body).toEqual({ success: true, data: { hasKey: true, model: 'gemini-3.8-live' } });
  });
});
