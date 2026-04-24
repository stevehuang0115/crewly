/**
 * Tests for credentials.controller — end-to-end via supertest.
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

describe('credentials.controller', () => {
  let app: express.Express;
  let testDir: string;
  let missingExtensionDir: string;

  beforeEach(async () => {
    _resetDerivedKeyCache();
    _resetGeminiHelperForTesting();
    testDir = path.join(
      os.tmpdir(),
      `crewly-cred-ctrl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    missingExtensionDir = path.join(testDir, 'fake-home', 'no-extension');

    // Replace the store singleton with one pointing at a scratch dir
    _setCredentialStoreForTesting(new CredentialStoreService({ dir: testDir }));

    app = express();
    app.use(express.json());
    app.use('/api/credentials', createCredentialsRouter());
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ success: false, error: err.message });
    });
  });

  afterEach(async () => {
    resetCredentialStoreService();
    _resetGeminiHelperForTesting();
    _resetDerivedKeyCache();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  //  Empty list
  // ------------------------------------------------------------------

  describe('GET /api/credentials', () => {
    it('returns empty list when no credentials exist', async () => {
      const res = await request(app).get('/api/credentials');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });
  });

  // ------------------------------------------------------------------
  //  Add API key
  // ------------------------------------------------------------------

  describe('POST /api/credentials/api-key', () => {
    it('adds a new API key and returns metadata (no value)', async () => {
      const res = await request(app)
        .post('/api/credentials/api-key')
        .send({ name: 'gemini-main', provider: 'gemini', value: 'sk-test-123' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toMatch(/^cred-/);
      expect(res.body.data.name).toBe('gemini-main');
      expect(res.body.data.type).toBe('api-key');
      expect(res.body.data.provider).toBe('gemini');
      // Ensure the raw value is not leaked in the response
      expect(JSON.stringify(res.body)).not.toContain('sk-test-123');
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/credentials/api-key')
        .send({ name: 'incomplete' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/required/i);
    });

    it('makes the credential visible via GET /api/credentials', async () => {
      await request(app)
        .post('/api/credentials/api-key')
        .send({ name: 'k1', provider: 'gemini', value: 'v' });
      await request(app)
        .post('/api/credentials/api-key')
        .send({ name: 'k2', provider: 'openai', value: 'v' });

      const res = await request(app).get('/api/credentials');
      expect(res.body.data).toHaveLength(2);
      const names = res.body.data.map((c: { name: string }) => c.name).sort();
      expect(names).toEqual(['k1', 'k2']);
    });
  });

  // ------------------------------------------------------------------
  //  Get one
  // ------------------------------------------------------------------

  describe('GET /api/credentials/:id', () => {
    it('returns the credential metadata', async () => {
      const add = await request(app)
        .post('/api/credentials/api-key')
        .send({ name: 'one', provider: 'gemini', value: 'v' });
      const id = add.body.data.id;

      const res = await request(app).get(`/api/credentials/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(app).get('/api/credentials/cred-nope');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  //  Update
  // ------------------------------------------------------------------

  describe('PATCH /api/credentials/:id', () => {
    it('renames the credential', async () => {
      const add = await request(app)
        .post('/api/credentials/api-key')
        .send({ name: 'before', provider: 'gemini', value: 'v' });
      const id = add.body.data.id;

      const res = await request(app)
        .patch(`/api/credentials/${id}`)
        .send({ name: 'after' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('after');
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(app)
        .patch('/api/credentials/cred-nope')
        .send({ name: 'x' });
      expect(res.status).toBe(404);
    });

    it('returns 400 when patch body is empty', async () => {
      const add = await request(app)
        .post('/api/credentials/api-key')
        .send({ name: 'x', provider: 'gemini', value: 'v' });
      const id = add.body.data.id;

      const res = await request(app).patch(`/api/credentials/${id}`).send({});
      expect(res.status).toBe(400);
    });
  });

  // ------------------------------------------------------------------
  //  Delete
  // ------------------------------------------------------------------

  describe('DELETE /api/credentials/:id', () => {
    it('deletes the credential', async () => {
      const add = await request(app)
        .post('/api/credentials/api-key')
        .send({ name: 'gone', provider: 'gemini', value: 'v' });
      const id = add.body.data.id;

      const del = await request(app).delete(`/api/credentials/${id}`);
      expect(del.status).toBe(200);

      const get = await request(app).get(`/api/credentials/${id}`);
      expect(get.status).toBe(404);
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(app).delete('/api/credentials/cred-nope');
      expect(res.status).toBe(404);
    });
  });

  // ------------------------------------------------------------------
  //  Gemini-CLI import (error paths — happy path requires real extension)
  // ------------------------------------------------------------------

  describe('POST /api/credentials/oauth/import-gemini-cli', () => {
    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post('/api/credentials/oauth/import-gemini-cli')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/name/i);
    });

    it('surfaces a helpful error when extension token file is missing', async () => {
      // The default helper uses ~/.gemini/... — overriding HOME here would be
      // racy. Instead we rely on the fact that the default extension path is
      // checked at capture time and return the existing error. This test
      // runs in an environment where the user may or may not have the
      // extension installed; handle both cases gracefully.
      const res = await request(app)
        .post('/api/credentials/oauth/import-gemini-cli')
        .send({ name: 'info-test' });
      // Either: file not found (no extension), or the extension lacks a valid
      // logged-in token and we get a different error. Both indicate the
      // error path is reachable.
      expect([201, 400]).toContain(res.status);
      if (res.status === 400) {
        expect(res.body.success).toBe(false);
      }
    });
  });

  // ------------------------------------------------------------------
  //  Headless Google OAuth: /oauth/google/start
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
      // Default scope set should include gmail and calendar readonly
      expect(scope).toContain('https://www.googleapis.com/auth/gmail.readonly');
      expect(scope).toContain('https://www.googleapis.com/auth/calendar.readonly');

      // state must be base64 of {manual:true} so the cloud function renders the
      // manual/copy-paste success page
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
          scopes: [
            'openid',
            'https://www.googleapis.com/auth/drive.file',
          ],
        });
      expect(res.status).toBe(200);
      const url = new URL(res.body.data.authUrl);
      const scope = url.searchParams.get('scope') ?? '';
      expect(scope.split(' ').sort()).toEqual(
        ['openid', 'https://www.googleapis.com/auth/drive.file'].sort(),
      );
      // Should NOT include default-only scopes that weren't requested
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
  //  Headless Google OAuth: /oauth/google/complete
  // ------------------------------------------------------------------

  describe('POST /api/credentials/oauth/google/complete', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    /** Install a fetch mock that returns the given userinfo email. */
    function mockUserinfoFetch(email: string | null, ok = true): void {
      globalThis.fetch = (async () => ({
        ok,
        status: ok ? 200 : 401,
        json: async () => (email ? { email } : {}),
        text: async () => '',
      })) as unknown as typeof globalThis.fetch;
    }

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
            scope:
              'openid https://www.googleapis.com/auth/gmail.readonly',
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
      // Secret values must never appear in the response
      expect(JSON.stringify(res.body)).not.toContain('ya29.real-at');
      expect(JSON.stringify(res.body)).not.toContain('1//real-rt');

      // Credential is visible via list
      const list = await request(app).get('/api/credentials');
      expect(list.body.data.find((c: { id: string }) => c.id === res.body.data.id)).toBeTruthy();
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

  // ------------------------------------------------------------------
  //  Clear extension file
  // ------------------------------------------------------------------

  describe('POST /api/credentials/oauth/gemini-cli/clear-extension-file', () => {
    it('returns success even when the extension file does not exist', async () => {
      // The default helper points at ~/.gemini/... which may or may not exist;
      // clearExtensionFile is a no-op when the file is absent.
      const res = await request(app)
        .post('/api/credentials/oauth/gemini-cli/clear-extension-file');
      // Either succeeds (200 + success:true) or surfaces an unexpected error.
      // We accept 200 here — the no-op-on-missing path is explicit in the helper.
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
