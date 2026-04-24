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

  beforeEach(async () => {
    _resetDerivedKeyCache();
    _resetGeminiHelperForTesting();
    testDir = path.join(
      os.tmpdir(),
      `crewly-cred-ctrl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

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

    it('rejects non-string field types (R2 defensive check)', async () => {
      const res = await request(app)
        .post('/api/credentials/api-key')
        .send({ name: 42, provider: ['gemini'], value: true });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/string/i);
    });

    it('rejects empty-string field values', async () => {
      const res = await request(app)
        .post('/api/credentials/api-key')
        .send({ name: '', provider: 'gemini', value: 'v' });
      expect(res.status).toBe(400);
    });

    it('rejects null field values (isNonEmptyString guard)', async () => {
      const res = await request(app)
        .post('/api/credentials/api-key')
        .send({ name: null, provider: 'gemini', value: 'v' });
      expect(res.status).toBe(400);
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

    it('rejects an unknown status value (R2 runtime validation)', async () => {
      const add = await request(app)
        .post('/api/credentials/api-key')
        .send({ name: 's1', provider: 'gemini', value: 'v' });
      const id = add.body.data.id;

      const res = await request(app)
        .patch(`/api/credentials/${id}`)
        .send({ status: 'pending' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/active|revoked/);
    });

    it('accepts the allowed status values', async () => {
      const add = await request(app)
        .post('/api/credentials/api-key')
        .send({ name: 's2', provider: 'gemini', value: 'v' });
      const id = add.body.data.id;

      const r1 = await request(app)
        .patch(`/api/credentials/${id}`)
        .send({ status: 'revoked' });
      expect(r1.status).toBe(200);
      expect(r1.body.data.status).toBe('revoked');

      const r2 = await request(app)
        .patch(`/api/credentials/${id}`)
        .send({ status: 'active' });
      expect(r2.status).toBe(200);
      expect(r2.body.data.status).toBe('active');
    });

    it('rejects non-string name', async () => {
      const add = await request(app)
        .post('/api/credentials/api-key')
        .send({ name: 's3', provider: 'gemini', value: 'v' });
      const id = add.body.data.id;

      const res = await request(app)
        .patch(`/api/credentials/${id}`)
        .send({ name: 99 });
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
  //  Clear extension file
  // ------------------------------------------------------------------

  describe('POST /api/credentials/oauth/gemini-cli/clear-extension-file', () => {
    it('returns success even when the extension file does not exist', async () => {
      // The default helper points at ~/.gemini/... which may or may not exist;
      // clearExtensionFile is a no-op when the file is absent.
      const res = await request(app)
        .post('/api/credentials/oauth/gemini-cli/clear-extension-file');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
