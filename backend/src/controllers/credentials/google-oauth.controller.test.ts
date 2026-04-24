/**
 * Tests for google-oauth.controller — /oauth/google/start + /oauth/google/complete.
 */

import express from 'express';
import request from 'supertest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import { createCredentialsRouter } from './credentials.routes.js';
import {
  CredentialStoreService,
  resetCredentialStoreService,
  _setCredentialStoreForTesting,
} from '../../services/credential/credential-store.service.js';
import { _resetDerivedKeyCache } from '../../utils/encryption.utils.js';
import { _resetGeminiHelperForTesting } from './credentials.controller.js';

describe('google-oauth.controller', () => {
  let app: express.Express;
  let testDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    _resetDerivedKeyCache();
    _resetGeminiHelperForTesting();
    originalFetch = globalThis.fetch;

    testDir = path.join(
      os.tmpdir(),
      `crewly-google-oauth-ctrl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    _setCredentialStoreForTesting(new CredentialStoreService({ dir: testDir }));

    app = express();
    app.use(express.json());
    app.use('/api/credentials', createCredentialsRouter());
    app.use(
      (
        err: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(500).json({ success: false, error: err.message });
      },
    );
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    resetCredentialStoreService();
    _resetGeminiHelperForTesting();
    _resetDerivedKeyCache();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  /** Install a global fetch mock returning the given userinfo email. */
  function mockUserinfoFetch(email: string | null, ok = true): void {
    globalThis.fetch = (async () => ({
      ok,
      status: ok ? 200 : 401,
      json: async () => (email ? { email } : {}),
      text: async () => '',
    })) as unknown as typeof globalThis.fetch;
  }

  // ------------------------------------------------------------------
  //  POST /api/credentials/oauth/google/start
  // ------------------------------------------------------------------

  describe('POST /api/credentials/oauth/google/start', () => {
    it('returns an authUrl with default scopes when body is empty', async () => {
      const res = await request(app)
        .post('/api/credentials/oauth/google/start')
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const url = new URL(res.body.data.authUrl);
      expect(url.origin + url.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('client_id')).toBeTruthy();
      expect(url.searchParams.get('redirect_uri')).toBeTruthy();

      const scope = url.searchParams.get('scope') ?? '';
      expect(scope).toContain('https://www.googleapis.com/auth/gmail.readonly');
      expect(scope).toContain('https://www.googleapis.com/auth/calendar.readonly');

      const state = url.searchParams.get('state') ?? '';
      const decoded = JSON.parse(
        Buffer.from(state, 'base64').toString('utf8'),
      ) as { manual?: boolean };
      expect(decoded.manual).toBe(true);
    });

    it('honours a custom scopes override', async () => {
      const res = await request(app)
        .post('/api/credentials/oauth/google/start')
        .send({
          scopes: ['openid', 'https://www.googleapis.com/auth/drive.file'],
        });
      expect(res.status).toBe(200);
      const url = new URL(res.body.data.authUrl);
      const scope = url.searchParams.get('scope') ?? '';
      expect(scope.split(' ').sort()).toEqual(
        ['openid', 'https://www.googleapis.com/auth/drive.file'].sort(),
      );
      expect(scope).not.toContain('gmail.readonly');
    });

    it('falls back to defaults when scopes is an empty array', async () => {
      const res = await request(app)
        .post('/api/credentials/oauth/google/start')
        .send({ scopes: [] });
      expect(res.status).toBe(200);
      const scope = new URL(res.body.data.authUrl).searchParams.get('scope') ?? '';
      expect(scope).toContain('gmail.readonly');
    });
  });

  // ------------------------------------------------------------------
  //  POST /api/credentials/oauth/google/complete
  // ------------------------------------------------------------------

  describe('POST /api/credentials/oauth/google/complete', () => {
    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post('/api/credentials/oauth/google/complete')
        .send({ credentialsJson: { access_token: 'a', refresh_token: 'r' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/name/i);
    });

    it('returns 400 when credentialsJson is missing', async () => {
      const res = await request(app)
        .post('/api/credentials/oauth/google/complete')
        .send({ name: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/credentialsJson/);
    });

    it('returns 400 for a non-JSON credentialsJson string', async () => {
      const res = await request(app)
        .post('/api/credentials/oauth/google/complete')
        .send({ name: 'x', credentialsJson: 'not-json-at-all' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not valid JSON/i);
    });

    it('returns 400 when access_token / refresh_token are missing', async () => {
      const res = await request(app)
        .post('/api/credentials/oauth/google/complete')
        .send({
          name: 'x',
          credentialsJson: { scope: 'openid', token_type: 'Bearer' },
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/access_token or refresh_token/);
    });

    it('saves a credential from a parsed object and returns metadata only', async () => {
      mockUserinfoFetch('user@example.com');
      const res = await request(app)
        .post('/api/credentials/oauth/google/complete')
        .send({
          name: 'work',
          credentialsJson: {
            access_token: 'ya29.real-at',
            refresh_token: '1//real-rt',
            scope: 'openid https://www.googleapis.com/auth/gmail.readonly',
            token_type: 'Bearer',
            expiry_date: Date.now() + 3600_000,
          },
        });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.type).toBe('google-oauth');
      expect(res.body.data.provider).toBe('google');
      expect(res.body.data.helper).toBe('gemini-cli-workspace');
      expect(res.body.data.accountEmail).toBe('user@example.com');
      expect(JSON.stringify(res.body)).not.toContain('ya29.real-at');
      expect(JSON.stringify(res.body)).not.toContain('1//real-rt');

      const list = await request(app).get('/api/credentials');
      expect(
        list.body.data.find((c: { id: string }) => c.id === res.body.data.id),
      ).toBeTruthy();
    });

    it('accepts credentialsJson as a JSON string', async () => {
      mockUserinfoFetch('string@example.com');
      const body = {
        access_token: 'at-str',
        refresh_token: 'rt-str',
        scope: 'openid',
        token_type: 'Bearer',
        expiry_date: Date.now() + 3600_000,
      };
      const res = await request(app)
        .post('/api/credentials/oauth/google/complete')
        .send({ name: 'str', credentialsJson: JSON.stringify(body) });
      expect(res.status).toBe(201);
      expect(res.body.data.accountEmail).toBe('string@example.com');
    });

    it('still succeeds when userinfo fetch fails (email optional)', async () => {
      mockUserinfoFetch(null, false);
      const res = await request(app)
        .post('/api/credentials/oauth/google/complete')
        .send({
          name: 'no-email',
          credentialsJson: {
            access_token: 'at',
            refresh_token: 'rt',
            scope: 'openid',
            token_type: 'Bearer',
          },
        });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accountEmail).toBeUndefined();
    });

    it('rejects a non-object, non-string credentialsJson', async () => {
      const res = await request(app)
        .post('/api/credentials/oauth/google/complete')
        .send({ name: 'bad', credentialsJson: 42 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/JSON string or object/i);
    });
  });
});
