/**
 * Tests for the dashboard's owner session (#999).
 */

import express, { type Express } from 'express';
import request from 'supertest';
import { createOwnerSessionPageMiddleware, createOwnerSessionRouter, isDashboardPageLoad } from './owner-session.controller.js';
import { createCallerIdentityMiddleware, getCallerIdentity } from '../../middleware/caller-identity.middleware.js';
import { agentAuthHeaders } from '../../middleware/caller-identity.testing.js';
import { PeerProcessService, type PeerVerdict } from '../../services/core/peer-process.service.js';
import { csrfTokenFor, verifyOwnerSession } from '../../services/core/owner-auth.service.js';
import { resetApiTokenCache } from '../../services/core/api-token.service.js';

const TOKEN = 'owner-session-test-token';
const ORIGINAL = process.env.CREWLY_API_TOKEN;
beforeAll(() => {
  process.env.CREWLY_API_TOKEN = TOKEN;
  resetApiTokenCache();
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.CREWLY_API_TOKEN;
  else process.env.CREWLY_API_TOKEN = ORIGINAL;
  resetApiTokenCache();
});

/** The server's wiring: page middleware + /api identity + session route + a write that needs the owner. */
function buildApp(verdict: PeerVerdict): Express {
  const peers = new PeerProcessService();
  (peers as unknown as { classify: () => Promise<PeerVerdict> }).classify = async () => verdict;
  const app = express();
  app.use(express.json());
  app.use('/api', createCallerIdentityMiddleware(peers));
  app.use('/api', createOwnerSessionRouter(peers));
  app.post('/api/owner-thing', (req, res) => res.json({ kind: getCallerIdentity(req).kind }));
  app.use(createOwnerSessionPageMiddleware(peers));
  app.get('*', (_req, res) => res.type('html').send('<!doctype html><title>Crewly</title>'));
  return app;
}

/** The `name=value` of the owner session Set-Cookie, and its flags. */
function sessionCookie(res: request.Response): { pair: string; flags: string } | null {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('crewly_owner_'));
  if (!raw) return null;
  const [pair, ...flags] = raw.split(';');
  return { pair: pair.trim(), flags: flags.join(';') };
}

describe('owner session', () => {
  it('a page load from the owner\'s browser sets an HttpOnly, SameSite=Strict session cookie', async () => {
    const res = await request(buildApp({ kind: 'not-agent', pid: 7 })).get('/').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).not.toBeNull();
    expect(cookie!.flags).toMatch(/HttpOnly/);
    expect(cookie!.flags).toMatch(/SameSite=Strict/);
    expect(cookie!.flags).toMatch(/Path=\//);
    expect(verifyOwnerSession(cookie!.pair.split('=')[1])).not.toBeNull();
  });

  it('a page load from an agent\'s process gets the page but no cookie', async () => {
    const res = await request(buildApp({ kind: 'agent', pid: 7, signal: 'ancestry', session: 'dev-1' })).get('/').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBeNull();
  });

  it('GET /api/auth/session returns the CSRF token, and that cookie + token make a write the owner\'s', async () => {
    const app = buildApp({ kind: 'not-agent', pid: 7 });
    const res = await request(app).get('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const cookie = sessionCookie(res)!;
    const csrf = res.body.data.csrfToken as string;
    expect(res.body.data.csrfHeader).toBe('x-crewly-csrf');

    const write = await request(app).post('/api/owner-thing').set('Cookie', cookie.pair).set('X-Crewly-CSRF', csrf);
    expect(write.body.kind).toBe('owner');
    const noCsrf = await request(app).post('/api/owner-thing').set('Cookie', cookie.pair);
    expect(noCsrf.body.kind).toBe('anonymous');
  });

  it('a valid session gets its own CSRF token back without a new cookie', async () => {
    const app = buildApp({ kind: 'not-agent', pid: 7 });
    const first = await request(app).get('/api/auth/session');
    const cookie = sessionCookie(first)!;
    const again = await request(app).get('/api/auth/session').set('Cookie', cookie.pair);
    expect(again.status).toBe(200);
    expect(sessionCookie(again)).toBeNull();
    const id = verifyOwnerSession(cookie.pair.split('=')[1])!.id;
    expect(again.body.data.csrfToken).toBe(csrfTokenFor(id));
  });

  it('refuses agents (badge or header) and agent processes with 403', async () => {
    const ok = buildApp({ kind: 'not-agent', pid: 7 });
    expect((await request(ok).get('/api/auth/session').set(agentAuthHeaders('dev-1'))).status).toBe(403);
    expect((await request(ok).get('/api/auth/session').set('X-Agent-Session', 'dev-1')).status).toBe(403);
    expect((await request(ok).get('/api/auth/session').set('X-Agent-Badge', 'cab1.forged.sig')).status).toBe(403);
    const agentProcess = buildApp({ kind: 'agent', pid: 7, signal: 'tty', session: 'dev-1' });
    const res = await request(agentProcess).get('/api/auth/session');
    expect(res.status).toBe(403);
    expect(sessionCookie(res)).toBeNull();
  });

  it('a remote caller needs the API token; with it, it gets a session', async () => {
    const remote = buildApp({ kind: 'remote' });
    expect((await request(remote).get('/api/auth/session')).status).toBe(401);
    const withToken = await request(remote).get('/api/auth/session').set('X-Crewly-Token', TOKEN);
    expect(withToken.status).toBe(200);
    expect(sessionCookie(withToken)).not.toBeNull();
  });

  it('fails open when the client process cannot be looked up', async () => {
    const res = await request(buildApp({ kind: 'unknown', reason: 'no lsof' })).get('/api/auth/session');
    expect(res.status).toBe(200);
  });
});

describe('isDashboardPageLoad', () => {
  const r = (method: string, path: string, accepts = 'html') => ({ method, path, accepts: () => accepts }) as never;
  it('is true for HTML navigations only', () => {
    expect(isDashboardPageLoad(r('GET', '/'))).toBe(true);
    expect(isDashboardPageLoad(r('GET', '/teams/abc'))).toBe(true);
    expect(isDashboardPageLoad(r('GET', '/index.html'))).toBe(true);
    expect(isDashboardPageLoad(r('GET', '/assets/app.js'))).toBe(false);
    expect(isDashboardPageLoad(r('GET', '/api/teams'))).toBe(false);
    expect(isDashboardPageLoad(r('GET', '/health'))).toBe(false);
    expect(isDashboardPageLoad(r('POST', '/'))).toBe(false);
    expect(isDashboardPageLoad(r('GET', '/', 'json' as never))).toBe(false);
  });
});
