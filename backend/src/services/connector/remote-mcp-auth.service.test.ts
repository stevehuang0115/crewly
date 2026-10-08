/**
 * Tests for RemoteMcpAuthService: detection, start (DCR + PKCE + Cloud
 * session), the broker poll → code exchange → tokens stored encrypted and
 * 0600, Cloud + Slack told, refresh before expiry (single-flight), a dead
 * refresh → needs_auth, the 6-hour card throttle, and no secret in logs.
 *
 * @module services/connector/remote-mcp-auth.service.test
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { RemoteMcpAuthService, setRemoteMcpAuthNotifier, type RemoteMcpAuthNotifier } from './remote-mcp-auth.service.js';
import type { OAuthFetch } from './remote-mcp-oauth.js';
import type { RemoteMcpServer } from './remote-mcp.service.js';
import { _resetDerivedKeyCache } from '../../utils/encryption.utils.js';

const logs: unknown[][] = [];
jest.mock('../core/logger.service.js', () => {
  const log = (...args: unknown[]) => logs.push(args);
  return { LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: log, warn: log, debug: log, error: log }) }) } };
});

const SERVER: RemoteMcpServer = { id: 'zoho', label: 'Zoho', url: 'https://crm-600.zohomcp.com/mcp/SECRETKEY123/message', provider: 'zoho', createdAt: '' };
const PRM_URL = 'https://crm-600.zohomcp.com/.well-known/oauth-protected-resource';
const CLOUD = 'https://api.crewlyai.com';
const CALLBACK = `${CLOUD}/api/cloud/mcp-oauth/callback`;
const TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token';

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

/** A fake Zoho + Crewly Cloud. */
function world() {
  const calls: Call[] = [];
  const state = {
    pollStatus: { status: 'waiting' } as Record<string, unknown>,
    tokenResponses: [] as Array<{ status?: number; body: unknown }>,
    sessions: 0,
    results: [] as unknown[],
  };
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  });
  const impl: OAuthFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    const key = `${init.method} ${url.split('?')[0]}`;
    if (key === `POST ${SERVER.url}`) return reply(401, {}, { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` });
    if (key === `GET ${PRM_URL}`) return reply(200, { resource: 'https://crm-600.zohomcp.com', authorization_servers: ['https://accounts.zoho.com'] });
    if (key === 'GET https://accounts.zoho.com/.well-known/oauth-authorization-server') {
      return reply(200, { authorization_endpoint: 'https://accounts.zoho.com/oauth/v2/auth', token_endpoint: TOKEN_URL, registration_endpoint: 'https://accounts.zoho.com/oauth/v2/register', code_challenge_methods_supported: ['S256'] });
    }
    if (key === 'POST https://accounts.zoho.com/oauth/v2/register') return reply(201, { client_id: 'cid-1', token_endpoint_auth_method: 'none' });
    if (key === `GET ${CLOUD}/api/cloud/mcp-oauth/config`) return reply(200, { success: true, data: { redirectUri: CALLBACK } });
    if (key === `POST ${CLOUD}/api/cloud/mcp-oauth/sessions`) {
      state.sessions++;
      return reply(201, { success: true, data: { state: `st-${state.sessions}`, url: `${CLOUD}/api/cloud/mcp-oauth/go/TICKET${state.sessions}`, expiresAt: new Date(NOW + 86_400_000).toISOString() } });
    }
    if (key.startsWith(`GET ${CLOUD}/api/cloud/mcp-oauth/sessions/`)) return reply(200, { success: true, data: state.pollStatus });
    if (key.startsWith(`POST ${CLOUD}/api/cloud/mcp-oauth/sessions/`)) {
      state.results.push(JSON.parse(init.body ?? '{}'));
      return reply(200, { success: true });
    }
    if (key === `POST ${TOKEN_URL}`) {
      const next = state.tokenResponses.shift() ?? { status: 500, body: {} };
      return reply(next.status ?? 200, next.body);
    }
    return reply(404, {});
  };
  return { impl, calls, state };
}

const NOW = 1_800_000_000_000;
let home: string;
let now: number;
let w: ReturnType<typeof world>;
let timers: Array<{ fn: () => void; ms: number }>;
let notifier: { postAuthCard: jest.Mock; postReceipt: jest.Mock };
let service: RemoteMcpAuthService;

function make(): RemoteMcpAuthService {
  return new RemoteMcpAuthService({
    crewlyHome: home,
    fetchImpl: w.impl,
    cloud: { getToken: () => 'cloud-token', getCloudUrl: () => CLOUD },
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      timers = timers.filter((t) => t !== h);
    },
    getServer: async (id) => (id === SERVER.id ? SERVER : undefined),
    countTools: async () => 42,
  });
}

beforeEach(async () => {
  logs.length = 0;
  _resetDerivedKeyCache();
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-mcp-auth-'));
  now = NOW;
  w = world();
  timers = [];
  notifier = { postAuthCard: jest.fn().mockResolvedValue(true), postReceipt: jest.fn().mockResolvedValue(true) };
  setRemoteMcpAuthNotifier(notifier as unknown as RemoteMcpAuthNotifier);
  service = make();
});

afterEach(async () => {
  setRemoteMcpAuthNotifier(null);
  service.stop();
  await fs.rm(home, { recursive: true, force: true });
});

async function connect(): Promise<void> {
  await service.startAuthorization(SERVER, { notify: true, agentSession: 'team-dev-1' });
  w.state.pollStatus = { status: 'authorized', code: 'CODE-1' };
  w.state.tokenResponses.push({ body: { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, scope: 'ZohoMCP.tools.ALL' } });
  await service.pollOnce(SERVER.id);
}

describe('detection and start', () => {
  it('detects a Bearer challenge', async () => {
    expect(await service.detect(SERVER)).toEqual({ resourceMetadata: PRM_URL });
  });

  it('starts a sign-in: discovery, registration for the Cloud callback, PKCE, Cloud session, Slack card', async () => {
    const out = await service.startAuthorization(SERVER, { notify: true, agentSession: 'team-dev-1' });
    expect(out).toEqual({ url: `${CLOUD}/api/cloud/mcp-oauth/go/TICKET1`, expiresAt: new Date(NOW + 86_400_000).toISOString(), posted: true });

    const reg = w.calls.find((c) => c.url.endsWith('/register'))!;
    expect(JSON.parse(reg.body!).redirect_uris).toEqual([CALLBACK]);
    const session = w.calls.find((c) => c.url.endsWith('/mcp-oauth/sessions'))!;
    expect(session.headers['Authorization']).toBe('Bearer cloud-token');
    const sent = JSON.parse(session.body!) as { instanceKey: string; serverId: string; authorizeUrl: string };
    expect(sent.serverId).toBe('zoho');
    expect(sent.instanceKey).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    const authorize = new URL(sent.authorizeUrl);
    expect(authorize.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.has('state')).toBe(false);
    // The verifier stays here; Cloud only sees its challenge.
    const rec = await service.getRecord('zoho');
    expect(authorize.searchParams.get('code_challenge')).toBe(createHash('sha256').update(rec!.pending!.verifier).digest('base64url'));
    expect(sent.authorizeUrl).not.toContain(rec!.pending!.verifier);
    expect(sent.authorizeUrl).not.toContain('SECRETKEY');

    expect(notifier.postAuthCard).toHaveBeenCalledWith(expect.objectContaining({ serverLabel: 'Zoho', url: out.url, agentSession: 'team-dev-1' }));
    expect((await service.view('zoho'))).toMatchObject({ mode: 'oauth', status: 'needs_auth', authorizeUrl: out.url, authorizationServer: 'accounts.zoho.com' });
    expect(timers).toHaveLength(1);
  });

  it('reuses a live untapped link and throttles the card to once per 6 hours', async () => {
    await service.startAuthorization(SERVER, { notify: true });
    const again = await service.startAuthorization(SERVER, { notify: true });
    expect(again.posted).toBe(false);
    expect(w.state.sessions).toBe(1);
    now += 6 * 60 * 60_000 + 1;
    expect((await service.startAuthorization(SERVER, { notify: true })).posted).toBe(true);
    expect(notifier.postAuthCard).toHaveBeenCalledTimes(2);
  });

  it('refuses a server that never asked for OAuth, leaving no record', async () => {
    const plain = { ...SERVER, id: 'plain', url: 'https://plain.example/mcp' };
    await expect(service.startAuthorization(plain)).rejects.toMatchObject({ code: 'not_oauth' });
    expect(await service.usesOAuth('plain')).toBe(false);
  });

  it('needs Crewly Cloud', async () => {
    const offline = new RemoteMcpAuthService({ crewlyHome: home, fetchImpl: w.impl, cloud: { getToken: () => null, getCloudUrl: () => null } });
    await expect(offline.startAuthorization(SERVER)).rejects.toMatchObject({ code: 'not_signed_in' });
  });
});

describe('callback → tokens', () => {
  it('exchanges the code, stores tokens encrypted at 0600, tells Cloud and Slack', async () => {
    await service.startAuthorization(SERVER, { agentSession: 'team-dev-1' });
    expect(await service.pollOnce('zoho')).toBe('waiting');
    w.state.pollStatus = { status: 'opened' };
    expect(await service.pollOnce('zoho')).toBe('opened');
    expect(timers[timers.length - 1].ms).toBe(2000);

    w.state.pollStatus = { status: 'authorized', code: 'CODE-1' };
    w.state.tokenResponses.push({ body: { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, scope: 'ZohoMCP.tools.ALL' } });
    expect(await service.pollOnce('zoho')).toBe('authorized');

    const tokenCall = w.calls.find((c) => c.url === TOKEN_URL)!;
    const form = new URLSearchParams(tokenCall.body);
    expect(form.get('code')).toBe('CODE-1');
    expect(form.get('redirect_uri')).toBe(CALLBACK);
    expect(form.get('code_verifier')).toBeTruthy();

    expect(await service.getAccessToken('zoho')).toBe('AT-1');
    expect(await service.view('zoho')).toMatchObject({ status: 'connected', scopes: ['ZohoMCP.tools.ALL'], expiresAt: new Date(NOW + 3_600_000).toISOString() });
    expect(w.state.results).toEqual([expect.objectContaining({ ok: true, message: '42 tools ready for your agents.' })]);
    expect(notifier.postReceipt).toHaveBeenCalledWith(expect.objectContaining({ agentSession: 'team-dev-1', text: expect.stringContaining('Zoho is connected') }));

    const file = service.getFilePath();
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const onDisk = await fs.readFile(file);
    for (const secret of ['AT-1', 'RT-1', 'cid-1']) expect(onDisk.includes(secret)).toBe(false);

    // A fresh process reads it back.
    _resetDerivedKeyCache();
    expect(await make().getAccessToken('zoho')).toBe('AT-1');
  });

  it('records a declined consent', async () => {
    await service.startAuthorization(SERVER);
    w.state.pollStatus = { status: 'declined', error: 'access_denied' };
    await service.pollOnce('zoho');
    expect(await service.view('zoho')).toMatchObject({ status: 'needs_auth', error: 'Access was not granted.' });
    expect((await service.getRecord('zoho'))!.pending).toBeUndefined();
  });

  it('reports a failed exchange to Cloud', async () => {
    await service.startAuthorization(SERVER);
    w.state.pollStatus = { status: 'authorized', code: 'CODE-1' };
    w.state.tokenResponses.push({ status: 400, body: { error: 'invalid_grant' } });
    await service.pollOnce('zoho');
    expect(w.state.results).toEqual([expect.objectContaining({ ok: false })]);
    expect((await service.view('zoho'))!.status).toBe('error');
  });

  it('resumes polling after a restart', async () => {
    await service.startAuthorization(SERVER);
    timers = [];
    const next = make();
    await next.resumePending();
    expect(timers).toHaveLength(1);
    next.stop();
  });
});

describe('refresh', () => {
  it('refreshes before expiry, keeps an unrotated refresh token, and is single-flight', async () => {
    await connect();
    now += 3_600_000 - 60_000; // inside the 5-minute margin
    w.state.tokenResponses.push({ body: { access_token: 'AT-2', expires_in: 3600 } });
    const [a, b] = await Promise.all([service.getAccessToken('zoho'), service.getAccessToken('zoho')]);
    expect([a, b]).toEqual(['AT-2', 'AT-2']);
    expect(w.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2); // exchange + one refresh
    const form = new URLSearchParams(w.calls.filter((c) => c.url === TOKEN_URL)[1].body);
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'RT-1', resource: 'https://crm-600.zohomcp.com' });
    expect((await service.getRecord('zoho'))!.tokens!.refreshToken).toBe('RT-1');
  });

  it('marks the server needs_auth when the refresh token is dead', async () => {
    await connect();
    w.state.tokenResponses.push({ status: 200, body: { error: 'invalid_code' } });
    expect(await service.getAccessToken('zoho', { force: true })).toBeNull();
    expect((await service.view('zoho'))!.status).toBe('needs_auth');
  });

  it('keeps the old token through a network blip', async () => {
    await connect();
    w.state.tokenResponses.push({ status: 503, body: {} });
    expect(await service.getAccessToken('zoho', { force: true })).toBe('AT-1');
  });

  it('asks the owner again after an unrecoverable 401 (once a minute at most)', async () => {
    await connect();
    notifier.postAuthCard.mockClear();
    await service.onUnauthorized(SERVER, 'team-dev-1');
    await service.onUnauthorized(SERVER, 'team-dev-1');
    expect(w.state.sessions).toBe(2);
    expect(notifier.postAuthCard).toHaveBeenCalledTimes(1);
    expect((await service.view('zoho'))!.status).toBe('needs_auth');
  });
});

it('never logs a token, code, verifier, ticket, client id or the server URL', async () => {
  await connect();
  now += 3_600_000;
  w.state.tokenResponses.push({ body: { access_token: 'AT-2', expires_in: 3600 } });
  await service.getAccessToken('zoho');
  const verifier = new URLSearchParams(w.calls.find((c) => c.url === TOKEN_URL)!.body).get('code_verifier')!;
  const logged = JSON.stringify(logs);
  expect(logged).toContain('signed in');
  for (const secret of ['AT-1', 'AT-2', 'RT-1', 'CODE-1', verifier, 'TICKET1', 'st-1', 'cid-1', 'SECRETKEY', 'cloud-token']) expect(logged).not.toContain(secret);
});
