/**
 * Tests for the caller-identity classifier (#999).
 */

import express from 'express';
import request from 'supertest';
import {
  classifyCaller,
  classifyCallerSync,
  createCallerIdentityMiddleware,
  getCallerIdentity,
  isOwnerCaller,
  ownerOnly,
  rejectNonOwner,
  requireOwner,
  requireOwnerToken,
  type IdentifiableRequest,
} from './caller-identity.middleware.js';
import { agentAuthHeaders, callerIdentityForTests, markOwner, ownerAuthHeaders, ownerUnlessAgentForTests, relayAuthHeaders } from './caller-identity.testing.js';
import { setAgentOriginCorrection } from './agent-origin-correction.js';
import { internalCredentialHeaders, mintAgentBadge, mintOwnerSession } from '../services/core/owner-auth.service.js';
import { PeerProcessService, type PeerVerdict } from '../services/core/peer-process.service.js';
import { getApiTokenFingerprint, resetApiTokenCache } from '../services/core/api-token.service.js';

const TOKEN = 'caller-identity-test-token';
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

/** A request shape for the classifier. */
function req(headers: Record<string, string>, method = 'POST', remoteAddress = '127.0.0.1'): IdentifiableRequest {
  return { headers, method, socket: { remoteAddress, remotePort: 50000, localPort: 8787 } } as unknown as IdentifiableRequest;
}

/** A process classifier that answers `verdict`. */
function peers(verdict: PeerVerdict): PeerProcessService {
  const svc = new PeerProcessService();
  (svc as unknown as { classify: () => Promise<PeerVerdict> }).classify = async () => verdict;
  return svc;
}

describe('classifyCallerSync', () => {
  it('a valid badge is that agent, whatever else the request carries', () => {
    const id = classifyCallerSync(req({ ...agentAuthHeaders('dev-1'), ...ownerAuthHeaders(), 'x-crewly-token': TOKEN, ...relayAuthHeaders() }));
    expect(id).toMatchObject({ kind: 'agent', via: 'agent-badge', session: 'dev-1' });
  });

  it('the badge names the session even when X-Agent-Session claims another', () => {
    const id = classifyCallerSync(req({ 'x-agent-badge': mintAgentBadge('dev-1'), 'x-agent-session': 'crewly-orc' }));
    expect(id).toMatchObject({ kind: 'agent', session: 'dev-1' });
  });

  it('the process tree overrides a leaked badge (shared Codex daemon)', () => {
    const r = req({ 'x-agent-badge': mintAgentBadge('crewly-orc'), 'x-agent-session': 'crewly-dev-sam' });
    setAgentOriginCorrection(r, { claimed: 'crewly-orc', actual: 'crewly-dev-sam' });
    expect(classifyCallerSync(r)).toMatchObject({ kind: 'agent', session: 'crewly-dev-sam' });
  });

  it('a client-sent X-Agent-Session-Claimed header changes nothing', () => {
    const id = classifyCallerSync(req({ 'x-agent-badge': mintAgentBadge('dev-1'), 'x-agent-session-claimed': 'dev-1', 'x-agent-session': 'crewly-orc' }));
    expect(id.session).toBe('dev-1');
  });

  it('a bare X-Agent-Session is that agent (migration window), never the owner — even with owner credentials', () => {
    expect(classifyCallerSync(req({ 'x-agent-session': 'dev-1' }))).toMatchObject({ kind: 'agent', via: 'legacy-header', session: 'dev-1' });
    expect(classifyCallerSync(req({ 'x-agent-session': 'dev-1', ...ownerAuthHeaders() })).kind).toBe('agent');
    expect(classifyCallerSync(req({ 'x-crewly-agent-session': 'dev-1', 'x-crewly-token': TOKEN })).kind).toBe('agent');
  });

  it('an invalid badge is never the owner', () => {
    expect(classifyCallerSync(req({ 'x-agent-badge': 'cab1.forged.sig', ...ownerAuthHeaders() }))).toMatchObject({ kind: 'anonymous', note: 'invalid agent badge' });
    expect(classifyCallerSync(req({ 'x-agent-badge': 'cab1.forged.sig', 'x-agent-session': 'dev-1' }))).toMatchObject({ kind: 'agent', via: 'legacy-header' });
  });

  it('the relay and cloud credentials', () => {
    expect(classifyCallerSync(req(relayAuthHeaders())).kind).toBe('relay-owner');
    expect(classifyCallerSync(req(internalCredentialHeaders('cloud'))).kind).toBe('cloud');
    expect(classifyCallerSync(req({ 'x-crewly-internal': 'relay.forged' })).kind).toBe('anonymous');
  });

  it('the owner session: reads need no CSRF, writes do', () => {
    const h = ownerAuthHeaders();
    expect(classifyCallerSync(req({ cookie: h.cookie }, 'GET'))).toMatchObject({ kind: 'owner', via: 'owner-session' });
    expect(classifyCallerSync(req(h, 'POST')).kind).toBe('owner');
    expect(classifyCallerSync(req({ cookie: h.cookie }, 'POST'))).toMatchObject({ kind: 'anonymous', note: expect.stringContaining('CSRF') });
    expect(classifyCallerSync(req({ cookie: h.cookie, 'x-crewly-csrf': mintOwnerSession().csrfToken }, 'DELETE')).kind).toBe('anonymous');
  });

  it('accepts the session cookie under any port suffix (the cookie set through a proxy)', () => {
    const s = mintOwnerSession();
    expect(classifyCallerSync(req({ cookie: `other=1; crewly_owner_3000=${s.value}`, 'x-crewly-csrf': s.csrfToken })).kind).toBe('owner');
    expect(classifyCallerSync(req({ cookie: 'crewly_owner_8787=cos1.x.1.y' }, 'GET')).kind).toBe('anonymous');
  });

  it('the API token: owner from another machine; needs the process check from this one', () => {
    expect(classifyCallerSync(req({ 'x-crewly-token': TOKEN }, 'POST', '192.168.1.20'))).toMatchObject({ kind: 'owner', via: 'api-token' });
    expect(classifyCallerSync(req({ authorization: `Bearer ${TOKEN}` }, 'POST', '127.0.0.1')).kind).toBe('anonymous');
    expect(classifyCallerSync(req({ 'x-crewly-token': 'wrong' }, 'POST', '192.168.1.20')).kind).toBe('anonymous');
  });

  it('a token only in the cookie does not authorise a write', () => {
    expect(classifyCallerSync(req({ cookie: `crewly_token=${TOKEN}` }, 'POST', '192.168.1.20'))).toMatchObject({ kind: 'anonymous' });
    expect(classifyCallerSync(req({ cookie: `crewly_token=${TOKEN}` }, 'GET', '192.168.1.20')).kind).toBe('owner');
  });

  it('nothing at all — including the dashboard marker — is anonymous', () => {
    expect(classifyCallerSync(req({})).kind).toBe('anonymous');
    expect(classifyCallerSync(req({ 'x-crewly-caller': 'dashboard' })).kind).toBe('anonymous');
    expect(classifyCallerSync({} as IdentifiableRequest).kind).toBe('anonymous');
  });
});

describe('classifyCaller (with the process check)', () => {
  it('a local token from the owner\'s process is the owner', async () => {
    expect(await classifyCaller(req({ 'x-crewly-token': TOKEN }), peers({ kind: 'not-agent', pid: 9 }))).toMatchObject({ kind: 'owner', via: 'api-token' });
    expect((await classifyCaller(req({ 'x-crewly-token': TOKEN }), peers({ kind: 'self' }))).kind).toBe('owner');
  });

  it('a local token from an agent\'s process is that agent', async () => {
    const id = await classifyCaller(req({ 'x-crewly-token': TOKEN }), peers({ kind: 'agent', pid: 9, signal: 'ancestry', session: 'dev-1' }));
    expect(id).toMatchObject({ kind: 'agent', via: 'process-tree', session: 'dev-1' });
  });

  it('fails CLOSED when the lookup ran and the sender was gone (raw socket + exit, #1010 review)', async () => {
    const id = await classifyCaller(req({ 'x-crewly-token': TOKEN }), peers({ kind: 'gone', reason: 'client process not found' }));
    expect(id).toMatchObject({ kind: 'anonymous', note: expect.stringContaining('vanished') });
  });

  it('a closed socket (no remote address) is never "remote" — the token alone does not make it the owner', () => {
    expect(classifyCallerSync(req({ 'x-crewly-token': TOKEN }, 'POST', '')).kind).toBe('anonymous');
  });

  it('fails open (owner, with a note) when the lookup cannot run', async () => {
    const id = await classifyCaller(req({ 'x-crewly-token': TOKEN }), peers({ kind: 'unknown', reason: 'no lsof' }));
    expect(id).toMatchObject({ kind: 'owner', note: expect.stringContaining('no lsof') });
  });

  it('does not look up anything for other credentials', async () => {
    const svc = peers({ kind: 'agent', pid: 9, signal: 'ancestry', session: null });
    const spy = jest.spyOn(svc, 'classify');
    await classifyCaller(req(ownerAuthHeaders()), svc);
    await classifyCaller(req({}), svc);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the middleware', () => {
  function app(verdict: PeerVerdict = { kind: 'not-agent', pid: 9 }) {
    const a = express();
    a.use(createCallerIdentityMiddleware(peers(verdict)));
    a.all('/who', (r, res) => res.json({ ...getCallerIdentity(r), header: r.headers['x-agent-session'] ?? null, owner: isOwnerCaller(r) }));
    return a;
  }

  it('stores the identity and rewrites a contradicted X-Agent-Session to the badge\'s session', async () => {
    const res = await request(app()).post('/who').set({ 'x-agent-badge': mintAgentBadge('dev-1'), 'x-agent-session': 'crewly-orc' });
    expect(res.body).toMatchObject({ kind: 'agent', session: 'dev-1', header: 'dev-1', owner: false });
  });

  it('never adds X-Agent-Session (remote-browser --no-bind leaves it out on purpose)', async () => {
    const res = await request(app()).post('/who').set({ 'x-agent-badge': mintAgentBadge('dev-1') });
    expect(res.body).toMatchObject({ kind: 'agent', session: 'dev-1', header: null });
  });

  it('applies the process check to a local token', async () => {
    const res = await request(app({ kind: 'agent', pid: 9, signal: 'tty', session: 'dev-1' })).post('/who').set('X-Crewly-Token', TOKEN);
    expect(res.body).toMatchObject({ kind: 'agent', via: 'process-tree', owner: false });
    const ok = await request(app()).post('/who').set('X-Crewly-Token', TOKEN);
    expect(ok.body).toMatchObject({ kind: 'owner', owner: true });
  });
});

describe('rejectNonOwner / requireOwner / ownerOnly', () => {
  function app() {
    const a = express();
    a.use(callerIdentityForTests());
    a.post('/plain', requireOwner, (_r, res) => res.json({ ok: true }));
    a.post('/custom', ownerOnly({ success: false, error: 'Only the owner can test' }), (_r, res) => res.json({ ok: true }));
    a.post('/inline', (r, res) => {
      if (rejectNonOwner(r, res, { success: false, error: 'nope' })) return;
      res.json({ ok: true });
    });
    return a;
  }

  it.each(['/plain', '/custom', '/inline'])('%s: owner 200, relay 200, agent 403, nobody 401', async (path) => {
    const a = app();
    expect((await request(a).post(path).set(ownerAuthHeaders())).status).toBe(200);
    expect((await request(a).post(path).set(relayAuthHeaders())).status).toBe(200);
    expect((await request(a).post(path).set(agentAuthHeaders('dev-1'))).status).toBe(403);
    const anon = await request(a).post(path);
    expect(anon.status).toBe(401);
    expect(anon.body.error).toBe('owner_auth_required');
    // No Crewly-Token challenge: the dashboard must not prompt for the API token.
    expect(anon.headers['www-authenticate']).toBeUndefined();
  });

  it('tells a browser tab without a session to reload (a tab opened before the upgrade, #1010 review)', async () => {
    const a = app();
    const oldTab = await request(a).post('/plain').set({ 'Sec-Fetch-Site': 'same-origin', 'User-Agent': 'Mozilla/5.0', 'X-Crewly-Caller': 'dashboard' });
    expect(oldTab.status).toBe(401);
    expect(oldTab.body).toMatchObject({ error: 'Reload this page — Crewly was updated.', code: 'owner_auth_required', reload: true });
    // A browser whose session cookie is valid but sent no CSRF is not told to reload.
    const { cookie } = ownerAuthHeaders();
    const noCsrf = await request(a).post('/plain').set({ 'Sec-Fetch-Site': 'same-origin', cookie });
    expect(noCsrf.body).toMatchObject({ error: 'owner_auth_required', code: 'owner_auth_required' });
    expect(noCsrf.body.reload).toBeUndefined();
    // A script (no browser headers) keeps the machine-readable error.
    expect((await request(a).post('/plain')).body).toMatchObject({ error: 'owner_auth_required', code: 'owner_auth_required' });
  });

  it('agents get the route\'s own 403 wording', async () => {
    const res = await request(app()).post('/custom').set(agentAuthHeaders('dev-1'));
    expect(res.body).toEqual({ success: false, error: 'Only the owner can test' });
  });
});

describe('requireOwnerToken (OKR approvals, signal digests)', () => {
  function app() {
    const a = express();
    a.use(callerIdentityForTests());
    a.post('/decide', requireOwnerToken, (_r, res) => res.json({ fp: res.locals.ownerTokenFingerprint }));
    return a;
  }

  it('records which owner credential decided', async () => {
    expect((await request(app()).post('/decide').set('X-Crewly-Token', TOKEN)).body.fp).toBe(getApiTokenFingerprint(TOKEN));
    expect((await request(app()).post('/decide').set(ownerAuthHeaders())).body.fp).toMatch(/^session-[0-9a-f]{8}$/);
    expect((await request(app()).post('/decide').set(relayAuthHeaders())).body.fp).toBe('relay');
  });

  it('refuses agents with 403 owner_approval_required (even holding the token) and nobody with 401', async () => {
    const agent = await request(app()).post('/decide').set({ 'x-agent-session': 'crewly-orc', 'x-crewly-token': TOKEN });
    expect(agent.status).toBe(403);
    expect(agent.body.error).toBe('owner_approval_required');
    expect((await request(app()).post('/decide')).status).toBe(401);
  });
});

describe('test helpers', () => {
  it('markOwner and ownerUnlessAgentForTests mark only credential-less requests', async () => {
    expect(isOwnerCaller(markOwner({ headers: {} }))).toBe(true);
    const a = express();
    a.use(ownerUnlessAgentForTests);
    a.post('/who', (r, res) => res.json({ kind: getCallerIdentity(r).kind }));
    expect((await request(a).post('/who')).body.kind).toBe('owner');
    expect((await request(a).post('/who').set('X-Test-Anonymous', '1')).body.kind).toBe('anonymous');
    expect((await request(a).post('/who').set(agentAuthHeaders('dev-1'))).body.kind).toBe('agent');
  });
});
