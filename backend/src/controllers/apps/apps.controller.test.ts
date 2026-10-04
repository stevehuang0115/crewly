/**
 * Tests for the Crewly Apps controller — the owner / verified-agent gate,
 * the caller's session reaching the service, envelopes and error mapping.
 */

import request from 'supertest';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Application } from 'express';
import { createAppsRouter, rejectOversizedPublish } from './apps.routes.js';
import { bodyParserExcept } from '../../middleware/body-parser-except.js';
import { sendAppsError } from './apps.controller.js';
import { setAppsParts } from '../../services/apps/apps.wiring.js';
import { AppsCloudError, type AppsCloudClient } from '../../services/apps/apps-cloud.client.js';
import type { AppsRegistryService } from '../../services/apps/apps-registry.service.js';
import type { AppsService } from '../../services/apps/apps.service.js';
import { agentAuthHeaders, ownerUnlessAgentForTests } from '../../middleware/caller-identity.testing.js';

jest.mock('../../services/core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));

const ID = '28au74d9cj';
let app: Application;
let service: Record<string, jest.Mock>;

beforeEach(() => {
  service = {
    publish: jest.fn().mockResolvedValue({ appId: ID, name: 'G', url: `https://apps.crewlyai.com/${ID}`, version: 1, created: true, notified: false }),
    rollback: jest.fn().mockResolvedValue({ appId: ID, currentVersion: 1 }),
    list: jest.fn().mockResolvedValue([{ appId: ID }]),
    versions: jest.fn().mockResolvedValue([]),
    listDocs: jest.fn().mockResolvedValue({ docs: [], next: null }),
    addDoc: jest.fn().mockResolvedValue({ id: 'n', rev: 1 }),
    getDoc: jest.fn().mockResolvedValue({ id: 'milk', data: {}, rev: 1 }),
    setDoc: jest.fn().mockResolvedValue({ id: 'milk', rev: 2 }),
    updateDoc: jest.fn().mockResolvedValue({ id: 'milk', rev: 3 }),
    deleteDoc: jest.fn().mockResolvedValue({ deleted: true }),
  };
  setAppsParts({
    client: {} as AppsCloudClient,
    registry: {} as AppsRegistryService,
    service: service as unknown as AppsService,
  });
  app = express();
  app.use(ownerUnlessAgentForTests);
  // As in index.ts: the app-wide parser skips the publish route.
  app.use(bodyParserExcept(['/api/apps/publish'], express.json({ limit: '10mb' })));
  app.use('/api/apps', createAppsRouter());
});

afterEach(() => setAppsParts(null));

describe('Crewly Apps controller', () => {
  it('publishes as the verified agent', async () => {
    const res = await request(app)
      .post('/api/apps/publish')
      .set(agentAuthHeaders('dev-ella'))
      .send({ files: [{ path: 'index.html', contentBase64: 'eA==' }], name: 'G', source: '/w/g', notify: true, extra: 'ignored' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: expect.objectContaining({ appId: ID, created: true }) });
    expect(service.publish).toHaveBeenCalledWith(
      { files: [{ path: 'index.html', contentBase64: 'eA==' }], name: 'G', appId: undefined, source: '/w/g', entry: undefined, note: undefined, notify: true },
      { agentSession: 'dev-ella' },
    );
  });

  it('lets the owner call without an agent session', async () => {
    const res = await request(app).get('/api/apps');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ appId: ID }]);
    expect(service.list).toHaveBeenLastCalledWith({});
    await request(app).get('/api/apps').set(agentAuthHeaders('dev-ella'));
    expect(service.list).toHaveBeenLastCalledWith({ agentSession: 'dev-ella' });

    await request(app).post(`/api/apps/${ID}/rollback`).send({ version: 1 });
    expect(service.rollback).toHaveBeenCalledWith(ID, 1, {});
  });

  it('refuses an agent with only the session header (no badge)', async () => {
    const res = await request(app).get('/api/apps').set('X-Agent-Session', 'dev-ella');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('agent_badge_required');
    expect(service.list).not.toHaveBeenCalled();
  });

  /**
   * POST a publish that declares `declared` bytes but sends only the first
   * 64 KB, and resolve with the response the server gives before the body
   * arrives. A server that waited for (or parsed) the body would never answer.
   */
  async function declareLargePublish(headers: Record<string, string>, declared: number): Promise<{ status: number; connection?: string }> {
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      return await new Promise((resolve, reject) => {
        const req = http.request({
          port,
          method: 'POST',
          path: '/api/apps/publish',
          headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': String(declared) },
        });
        req.on('response', (res) => {
          resolve({ status: res.statusCode ?? 0, connection: res.headers.connection });
          res.resume();
          req.destroy();
        });
        req.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') reject(err);
        });
        req.write(Buffer.alloc(64 * 1024, 0x7b));
        setTimeout(() => reject(new Error('no response before the body was sent')), 3000).unref();
      });
    } finally {
      server.close();
    }
  }

  it('rejects an unauthenticated 30 MB publish from its headers, without reading or parsing the body', async () => {
    const res = await declareLargePublish({ 'X-Test-Anonymous': '1' }, 30 * 1024 * 1024);
    expect(res).toEqual({ status: 401, connection: 'close' });
    expect(service.publish).not.toHaveBeenCalled();
  });

  it('rejects a badge-less agent publish the same way', async () => {
    const res = await declareLargePublish({ 'X-Agent-Session': 'dev-ella' }, 30 * 1024 * 1024);
    expect(res).toEqual({ status: 403, connection: 'close' });
    expect(service.publish).not.toHaveBeenCalled();
  });

  it('answers a verified agent declaring more than the limit with 413 before reading', async () => {
    const res = await declareLargePublish(agentAuthHeaders('dev-ella'), 40 * 1024 * 1024);
    expect(res).toEqual({ status: 413, connection: 'close' });
    expect(service.publish).not.toHaveBeenCalled();
  });

  it('parses a publish only after the caller is verified (bad JSON from an agent → 400)', async () => {
    const res = await request(app).post('/api/apps/publish').set(agentAuthHeaders('dev-ella')).set('Content-Type', 'application/json').send('{not json');
    expect(res.status).toBe(400);
    expect(service.publish).not.toHaveBeenCalled();
  });

  it('refuses a declared size over the limit before reading it', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const setHeader = jest.fn();
    const next = jest.fn();
    const res = { status, setHeader } as unknown as express.Response;
    rejectOversizedPublish({ headers: { 'content-length': String(37 * 1024 * 1024) } } as express.Request, res, next);
    expect(status).toHaveBeenCalledWith(413);
    expect(setHeader).toHaveBeenCalledWith('Connection', 'close');
    expect(next).not.toHaveBeenCalled();
    rejectOversizedPublish({ headers: { 'content-length': '1000' } } as express.Request, res, next);
    rejectOversizedPublish({ headers: {} } as express.Request, res, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('refuses an anonymous caller', async () => {
    const res = await request(app).get('/api/apps').set('X-Test-Anonymous', '1');
    expect(res.status).toBe(401);
  });

  it('wires every data route to the service with the caller', async () => {
    const h = agentAuthHeaders('dev-ella');
    const who = { agentSession: 'dev-ella' };
    await request(app).get(`/api/apps/${ID}/data/items?limit=5&after=a`).set(h);
    expect(service.listDocs).toHaveBeenCalledWith(ID, 'items', { limit: '5', after: 'a' }, who);
    const added = await request(app).post(`/api/apps/${ID}/data/items`).set(h).send({ data: { n: 1 } });
    expect(added.status).toBe(201);
    expect(service.addDoc).toHaveBeenCalledWith(ID, 'items', { n: 1 }, who);
    await request(app).get(`/api/apps/${ID}/data/items/milk`).set(h);
    expect(service.getDoc).toHaveBeenCalledWith(ID, 'items', 'milk', who);
    await request(app).put(`/api/apps/${ID}/data/items/milk`).set(h).send({ data: { a: 1 } });
    expect(service.setDoc).toHaveBeenCalledWith(ID, 'items', 'milk', { a: 1 }, who);
    await request(app).patch(`/api/apps/${ID}/data/items/milk`).set(h).send({ data: { a: 2 }, ifRev: 2 });
    expect(service.updateDoc).toHaveBeenCalledWith(ID, 'items', 'milk', { a: 2 }, 2, who);
    await request(app).delete(`/api/apps/${ID}/data/items/milk`).set(h);
    expect(service.deleteDoc).toHaveBeenCalledWith(ID, 'items', 'milk', who);
    await request(app).get(`/api/apps/${ID}/versions`).set(h);
    expect(service.versions).toHaveBeenCalledWith(ID, who);
  });

  it("maps Cloud errors to their status with the code in `error`", async () => {
    service.getDoc.mockRejectedValueOnce(new AppsCloudError(404, 'not_found', 'Document not found.'));
    const res = await request(app).get(`/api/apps/${ID}/data/items/nope`).set(agentAuthHeaders('dev-ella'));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'not_found', message: 'Document not found.', hint: 'No such app, document or version for this account.' });

    service.list.mockRejectedValueOnce(new AppsCloudError(409, 'not_logged_in', 'not signed in'));
    const res2 = await request(app).get('/api/apps');
    expect(res2.status).toBe(409);
    expect(res2.body.hint).toMatch(/crewly cloud login/);
  });

  it('hides unexpected error details', async () => {
    service.list.mockRejectedValueOnce(new Error('boom: Bearer secret'));
    const res = await request(app).get('/api/apps');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('sendAppsError leaves out the hint for other codes', () => {
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) } as unknown as express.Response;
    sendAppsError(res, new AppsCloudError(429, 'rate_limited', 'slow down'));
    expect(json).toHaveBeenCalledWith({ success: false, error: 'rate_limited', message: 'slow down' });
  });
});
