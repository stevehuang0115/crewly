/**
 * Tests for the remote MCP API: owner-only, masked listing, add / rename /
 * remove, the test action, OAuth detection on add / test with the phone
 * sign-in link, the authorize action, and no URL in any response.
 *
 * @module controllers/connector/remote-mcp.controller.test
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import express, { type Application } from 'express';
import { createConnectorRouter } from './connector.routes.js';
import { ConnectorAccessService } from '../../services/connector/connector-access.service.js';
import { RemoteMcpService } from '../../services/connector/remote-mcp.service.js';
import { ownerUnlessAgentForTests } from '../../middleware/caller-identity.testing.js';
import { RemoteMcpAuthService } from '../../services/connector/remote-mcp-auth.service.js';
import type { OAuthFetch } from '../../services/connector/remote-mcp-oauth.js';

jest.mock('../../services/core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));
jest.mock('../../services/connector/remote-mcp-probe.service.js', () => ({ probeRemoteMcp: jest.fn() }));

import { probeRemoteMcp } from '../../services/connector/remote-mcp-probe.service.js';

const mockProbe = probeRemoteMcp as jest.MockedFunction<typeof probeRemoteMcp>;
const ZOHO_URL = 'https://crm-600.zohomcp.com/mcp/SECRETKEY123/message';

let home: string;
let app: Application;
let access: ConnectorAccessService;
let store: RemoteMcpService;
let auth: RemoteMcpAuthService;
/** Whether the fake Zoho asks for OAuth. */
let zohoWantsOAuth: boolean;

const CLOUD = 'https://api.crewlyai.com';
/** Fake Zoho MCP + authorization server + Crewly Cloud broker (no network). */
const fakeFetch: OAuthFetch = async (url, init) => {
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status, ok: status >= 200 && status < 300, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => JSON.stringify(body),
  });
  const key = `${init.method} ${url.split('?')[0]}`;
  if (key === `POST ${ZOHO_URL}`) {
    return zohoWantsOAuth ? reply(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://crm-600.zohomcp.com/.well-known/oauth-protected-resource"' }) : reply(200, {});
  }
  if (key === 'GET https://crm-600.zohomcp.com/.well-known/oauth-protected-resource') return reply(200, { authorization_servers: ['https://accounts.zoho.com'] });
  if (key === 'GET https://accounts.zoho.com/.well-known/oauth-authorization-server') {
    return reply(200, { authorization_endpoint: 'https://accounts.zoho.com/oauth/v2/auth', token_endpoint: 'https://accounts.zoho.com/oauth/v2/token', registration_endpoint: 'https://accounts.zoho.com/oauth/v2/register' });
  }
  if (key === 'POST https://accounts.zoho.com/oauth/v2/register') return reply(201, { client_id: 'cid' });
  if (key === `GET ${CLOUD}/api/cloud/mcp-oauth/config`) return reply(200, { success: true, data: { redirectUri: `${CLOUD}/api/cloud/mcp-oauth/callback` } });
  if (key === `POST ${CLOUD}/api/cloud/mcp-oauth/sessions`) return reply(201, { success: true, data: { state: 's1', url: `${CLOUD}/api/cloud/mcp-oauth/go/T1`, expiresAt: new Date(Date.now() + 86_400_000).toISOString() } });
  if (key.startsWith(`GET ${CLOUD}/api/cloud/mcp-oauth/sessions/`)) return reply(200, { success: true, data: { status: 'waiting' } });
  return reply(404, {});
};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-mcp-api-'));
  access = new ConnectorAccessService(home);
  store = new RemoteMcpService(home, access);
  jest.spyOn(RemoteMcpService, 'getInstance').mockReturnValue(store);
  jest.spyOn(ConnectorAccessService, 'getInstance').mockReturnValue(access);
  zohoWantsOAuth = false;
  auth = new RemoteMcpAuthService({
    crewlyHome: home,
    fetchImpl: fakeFetch,
    cloud: { getToken: () => 'cloud-token', getCloudUrl: () => CLOUD },
    setTimer: () => undefined,
    clearTimer: () => undefined,
  });
  jest.spyOn(RemoteMcpAuthService, 'getInstance').mockReturnValue(auth);
  mockProbe.mockReset();

  app = express();
  app.use(ownerUnlessAgentForTests);
  app.use(express.json());
  app.use('/api/connectors', createConnectorRouter());
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

const add = () => request(app).post('/api/connectors/remote-mcp').send({ label: 'Zoho', url: ZOHO_URL, provider: 'zoho' });

describe('owner only', () => {
  it.each([
    ['get', '/api/connectors/remote-mcp'],
    ['post', '/api/connectors/remote-mcp'],
    ['patch', '/api/connectors/remote-mcp/zoho'],
    ['delete', '/api/connectors/remote-mcp/zoho'],
    ['post', '/api/connectors/remote-mcp/zoho/test'],
    ['post', '/api/connectors/remote-mcp/zoho/rename'],
    ['post', '/api/connectors/remote-mcp/zoho/remove'],
    ['post', '/api/connectors/remote-mcp/zoho/access'],
    ['post', '/api/connectors/remote-mcp/zoho/authorize'],
  ] as const)('%s %s refuses an agent', async (method, url) => {
    const res = await request(app)[method](url).set('X-Agent-Session', 'dev-1').send({ label: 'x', url: ZOHO_URL });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner_only');
  });

  it('agents cannot add a server', async () => {
    await request(app).post('/api/connectors/remote-mcp').set('X-Agent-Session', 'dev-1').send({ label: 'x', url: ZOHO_URL });
    expect(await store.list()).toEqual([]);
  });
});

describe('add / list / rename / remove', () => {
  it('adds and lists with the URL masked, saying when it applies', async () => {
    const created = await add();
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ id: 'zoho', label: 'Zoho', provider: 'zoho', urlMasked: 'https://crm-600.zohomcp.com/…', connectorId: 'mcp:zoho' });
    expect(created.body.note).toContain('next time they start');

    const listed = await request(app).get('/api/connectors/remote-mcp');
    expect(listed.body.data).toHaveLength(1);
    for (const body of [created.body, listed.body]) expect(JSON.stringify(body)).not.toContain('SECRETKEY');

    // It shows up in the access map, open by default.
    const accessRes = await request(app).get('/api/connectors/access');
    expect(accessRes.body.data['mcp:zoho']).toEqual({ allowedRoles: [] });
  });

  it('400s on a bad URL without echoing it', async () => {
    const res = await request(app).post('/api/connectors/remote-mcp').send({ label: 'Zoho', url: 'http://evil.example.com/SECRETKEY' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('SECRETKEY');
    expect((await request(app).post('/api/connectors/remote-mcp').send({ url: ZOHO_URL })).status).toBe(400);
  });

  it('renames and removes, 404 for unknown ids', async () => {
    await add();
    const renamed = await request(app).patch('/api/connectors/remote-mcp/zoho').send({ label: 'Zoho CRM' });
    expect(renamed.body.data).toMatchObject({ id: 'zoho', label: 'Zoho CRM' });
    expect((await request(app).patch('/api/connectors/remote-mcp/zoho').send({ label: '' })).status).toBe(400);
    expect((await request(app).patch('/api/connectors/remote-mcp/nope').send({ label: 'x' })).status).toBe(404);

    await access.setAllowedRoles('mcp:zoho', ['sales']);
    expect((await request(app).delete('/api/connectors/remote-mcp/zoho')).body).toMatchObject({ success: true });
    expect(await store.list()).toEqual([]);
    expect(await access.list()).toEqual({});
    expect((await request(app).delete('/api/connectors/remote-mcp/zoho')).status).toBe(404);
  });
});

describe('POST twins (the relay forwards GET/POST only)', () => {
  it('renames and removes via POST, 404 for unknown ids', async () => {
    await add();
    const renamed = await request(app).post('/api/connectors/remote-mcp/zoho/rename').send({ label: 'Zoho CRM' });
    expect(renamed.body.data).toMatchObject({ id: 'zoho', label: 'Zoho CRM' });
    expect(JSON.stringify(renamed.body)).not.toContain('SECRETKEY');
    expect((await request(app).post('/api/connectors/remote-mcp/nope/rename').send({ label: 'x' })).status).toBe(404);

    expect((await request(app).post('/api/connectors/remote-mcp/zoho/remove')).body).toMatchObject({ success: true });
    expect(await store.list()).toEqual([]);
    expect((await request(app).post('/api/connectors/remote-mcp/zoho/remove')).status).toBe(404);
  });

  it('sets a server\'s role allowlist, only for a server that exists', async () => {
    await add();
    const res = await request(app).post('/api/connectors/remote-mcp/zoho/access').send({ allowedRoles: ['Sales', 'orchestrator'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ connectorId: 'mcp:zoho', allowedRoles: ['sales', 'orchestrator'] });
    expect(res.body.note).toContain('next time they start');
    expect(await access.list()).toEqual({ 'mcp:zoho': { allowedRoles: ['sales', 'orchestrator'] } });

    expect((await request(app).post('/api/connectors/remote-mcp/zoho/access').send({ allowedRoles: 'sales' })).status).toBe(400);
    expect((await request(app).post('/api/connectors/remote-mcp/nope/access').send({ allowedRoles: [] })).status).toBe(404);
    expect(await access.list()).toEqual({ 'mcp:zoho': { allowedRoles: ['sales', 'orchestrator'] } });
  });
});

describe('test action', () => {
  it('returns the tool count and names from the probe', async () => {
    await add();
    mockProbe.mockResolvedValue({ ok: true, toolCount: 2, tools: ['ZohoCRM_getRecords', 'ZohoMail_sendMail'] });
    const res = await request(app).post('/api/connectors/remote-mcp/zoho/test');
    expect(res.body).toMatchObject({ success: true, data: { ok: true, toolCount: 2, tools: ['ZohoCRM_getRecords', 'ZohoMail_sendMail'] } });
    expect(res.body.authorize).toBeUndefined();
    expect(mockProbe).toHaveBeenCalledWith(expect.objectContaining({ url: ZOHO_URL }));
    expect(JSON.stringify(res.body)).not.toContain('SECRETKEY');
  });

  it('passes a failure through and 404s for an unknown id', async () => {
    await add();
    mockProbe.mockResolvedValue({ ok: false, error: 'The server refused the request (401).' });
    expect((await request(app).post('/api/connectors/remote-mcp/zoho/test')).body.data).toEqual({ ok: false, error: 'The server refused the request (401).' });
    expect((await request(app).post('/api/connectors/remote-mcp/nope/test')).status).toBe(404);
  });
});

describe('OAuth servers (Zoho MCP answers 401 + resource_metadata)', () => {
  it('detects OAuth on add and returns the phone sign-in link, never the server URL', async () => {
    zohoWantsOAuth = true;
    const created = await add();
    expect(created.status).toBe(201);
    expect(created.body.authorize).toEqual({ url: `${CLOUD}/api/cloud/mcp-oauth/go/T1`, expiresAt: expect.any(String), posted: false });
    expect(created.body.data.auth).toMatchObject({ mode: 'oauth', status: 'needs_auth', authorizeUrl: `${CLOUD}/api/cloud/mcp-oauth/go/T1`, authorizationServer: 'accounts.zoho.com' });
    expect(JSON.stringify(created.body)).not.toContain('SECRETKEY');

    const listed = await request(app).get('/api/connectors/remote-mcp');
    expect(listed.body.data[0].auth.status).toBe('needs_auth');
  });

  it('adds a static-key server without any auth state', async () => {
    const created = await add();
    expect(created.body.authorize).toBeUndefined();
    expect(created.body.data.auth).toBeUndefined();
  });

  it('turns a 401 on test into a sign-in link', async () => {
    await add();
    zohoWantsOAuth = true;
    mockProbe.mockResolvedValue({ ok: false, error: 'x', needsAuth: true, wwwAuthenticate: 'Bearer resource_metadata="https://crm-600.zohomcp.com/.well-known/oauth-protected-resource"' });
    const res = await request(app).post('/api/connectors/remote-mcp/zoho/test');
    expect(res.body.data).toMatchObject({ ok: false, needsAuth: true });
    expect(res.body.data.wwwAuthenticate).toBeUndefined();
    expect(res.body.authorize.url).toBe(`${CLOUD}/api/cloud/mcp-oauth/go/T1`);
    expect(res.body.server.auth.status).toBe('needs_auth');
  });

  it('authorize returns the link (and 409s for a server that never asked)', async () => {
    zohoWantsOAuth = true;
    await add();
    const res = await request(app).post('/api/connectors/remote-mcp/zoho/authorize').send({});
    expect(res.body).toMatchObject({ success: true, data: { url: `${CLOUD}/api/cloud/mcp-oauth/go/T1`, posted: false } });
    expect((await request(app).post('/api/connectors/remote-mcp/nope/authorize')).status).toBe(404);

    zohoWantsOAuth = false;
    await store.add({ label: 'Plain', url: 'https://plain.example/mcp' });
    const plain = await request(app).post('/api/connectors/remote-mcp/plain/authorize');
    expect(plain.status).toBe(409);
  });

  it('forgets the sign-in when the server is removed', async () => {
    zohoWantsOAuth = true;
    await add();
    expect(await auth.usesOAuth('zoho')).toBe(true);
    await request(app).delete('/api/connectors/remote-mcp/zoho');
    expect(await auth.usesOAuth('zoho')).toBe(false);
  });
});
