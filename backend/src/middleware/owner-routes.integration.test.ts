/**
 * Owner-only routes behind the real middleware stack (#999,
 * specs/2026-10-03-owner-auth.md §5).
 *
 * One app with the server's `/api` chain — API-token gate, agent-origin
 * check, caller identity — in front of the real route tree
 * (`createApiRoutes`). For a route of every class #999 lists it checks who
 * gets past the owner gate:
 * - the dashboard's owner session (cookie + CSRF): allowed;
 * - an agent with its badge: 403;
 * - an agent with only the legacy `X-Agent-Session`: 403;
 * - a caller with no credential (the hole: an agent leaving its header out): 401;
 * - the phone / portal relay credential: allowed;
 * - the owner API token from an agent's process: refused; from the owner's: allowed.
 *
 * "Allowed" means the request got past the gate: whatever the handler then
 * answers (404 for a made-up id, 400 for a bad body, 503 for a service that
 * is not running in a test) is fine, as long as it is not the gate's 401/403.
 */

import express, { type Express } from 'express';
import request from 'supertest';
import { apiTokenMiddleware } from './api-token.middleware.js';
import { agentOriginMiddleware } from './agent-origin.middleware.js';
import { createCallerIdentityMiddleware } from './caller-identity.middleware.js';
import { agentAuthHeaders, ownerAuthHeaders, relayAuthHeaders } from './caller-identity.testing.js';
import { PeerProcessService, type PeerVerdict } from '../services/core/peer-process.service.js';
import { resetApiTokenCache } from '../services/core/api-token.service.js';
import { createApiRoutes } from '../routes/api.routes.js';
import type { ApiController } from '../controllers/api.controller.js';

const OWNER_TOKEN = 'owner-token-for-owner-routes-test';

/** What the fake process lookup says about the next local token caller. */
let peerVerdict: PeerVerdict = { kind: 'not-agent', pid: 4242 };

/** Minimal controller: the routes under test never reach these services. */
function fakeController(): ApiController {
  const storageService = {
    getTeams: async () => [],
    getProjects: async () => [],
    findMemberBySessionName: async () => null,
    getOrchestratorStatus: async () => null,
  };
  return {
    storageService,
    tmuxService: {},
    agentRegistrationService: {},
    schedulerService: {},
    messageSchedulerService: {},
    activeProjectsService: {},
    promptTemplateService: {},
  } as unknown as ApiController;
}

/** The server's `/api` chain over the real routes. */
function buildApp(): Express {
  const app = express();
  app.use(express.json());
  const peers = new PeerProcessService({ findPeerPid: async () => 4242 });
  // The lookup itself is unit-tested; here it answers whatever the test set.
  (peers as unknown as { classify: () => Promise<PeerVerdict> }).classify = async () => peerVerdict;
  app.use('/api', apiTokenMiddleware);
  app.use('/api', agentOriginMiddleware);
  app.use('/api', createCallerIdentityMiddleware(peers));
  app.use('/api', createApiRoutes(fakeController()));
  return app;
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** One owner-only route. */
interface RouteCase {
  name: string;
  method: Method;
  path: string;
  body?: unknown;
  /** Status an agent gets (default 403) */
  agentStatus?: number;
  /** Status a caller with no credential gets (default 401) */
  anonymousStatus?: number;
  /** The relay reaches this route (phone / portal) */
  relay?: boolean;
}

const ROUTES: RouteCase[] = [
  // Decisions
  { name: 'decisions choose', method: 'post', path: '/api/decisions/D-404/choose', body: { option: 'a' } },
  { name: 'decisions remind', method: 'post', path: '/api/decisions/D-404/remind' },
  { name: 'decisions skip', method: 'post', path: '/api/decisions/D-404/skip' },
  { name: 'decisions skip-all', method: 'post', path: '/api/decisions/skip-all', body: { dryRun: true } },
  // Tickets and requests
  { name: 'ticket dismiss', method: 'post', path: '/api/tickets/TKT-404/dismiss', relay: true },
  { name: 'ticket verify', method: 'post', path: '/api/tickets/TKT-404/verify', relay: true },
  { name: 'ticket reject', method: 'post', path: '/api/tickets/TKT-404/reject', body: { reason: 'x' }, relay: true },
  { name: 'ticket acceptance', method: 'put', path: '/api/tickets/TKT-404/acceptance', body: { criteria: [] } },
  { name: 'ticket patch', method: 'patch', path: '/api/tickets/TKT-404', body: { priority: 'P1' } },
  { name: 'tickets cleanup', method: 'post', path: '/api/tickets/cleanup', body: {} },
  { name: 'open item skip', method: 'post', path: '/api/requests/R-404/open-items/I-404/skip' },
  // Owner receipt
  { name: 'owner-receipt settings', method: 'put', path: '/api/owner-receipt/settings', body: {} },
  { name: 'owner-receipt send', method: 'post', path: '/api/owner-receipt/send' },
  // Harness
  { name: 'harness install', method: 'post', path: '/api/harness/nope/install', relay: true },
  { name: 'harness orc', method: 'put', path: '/api/harness/orc', body: {} },
  { name: 'harness api-key', method: 'post', path: '/api/harness/nope/api-key', body: {} },
  // Bundles and onboarding
  { name: 'bundles apply', method: 'post', path: '/api/bundles/apply', body: {}, relay: true },
  { name: 'onboarding dismiss', method: 'post', path: '/api/onboarding/checklist/dismiss', body: {}, relay: true },
  // System
  { name: 'update-status', method: 'get', path: '/api/system/update-status', relay: true },
  { name: 'usage caps', method: 'put', path: '/api/system/usage/caps', body: { scope: 'nope' } },
  { name: 'usage boost', method: 'post', path: '/api/system/usage/boost', body: {} },
  { name: 'spend caps', method: 'put', path: '/api/system/spend/caps', body: { scope: 'nope' } },
  { name: 'runtime-terms answer', method: 'post', path: '/api/system/runtime-terms/nope/answer', body: {} },
  { name: 'runtime-fallback settings', method: 'put', path: '/api/system/runtime-fallback/settings', body: { order: 'bad' } },
  { name: 'runtime-fallback accounts', method: 'post', path: '/api/system/runtime-fallback/claude-accounts', body: { name: '' } },
  // Cloud device
  { name: 'cloud device cancel', method: 'post', path: '/api/cloud/device/cancel', relay: true },
  // Connector sharing and management
  { name: 'google sharing', method: 'post', path: '/api/google/sharing', body: {} },
  { name: 'microsoft-todo sharing', method: 'post', path: '/api/microsoft-todo/sharing', body: {} },
  { name: 'canva sharing', method: 'post', path: '/api/canva/sharing', body: {} },
  { name: 'connector access', method: 'put', path: '/api/connectors/access/google-workspace', body: { allowedRoles: 'not-an-array' } },
  // People and teams
  { name: 'people edit', method: 'put', path: '/api/people/U404', body: {} },
  // Browser (the owner's live controls)
  { name: 'browser take-control', method: 'post', path: '/api/browser/sessions/s-404/take-control', relay: true },
  { name: 'browser release-control', method: 'post', path: '/api/browser/sessions/s-404/release-control', relay: true },
  { name: 'browser stop', method: 'post', path: '/api/browser/sessions/s-404/stop', relay: true },
  { name: 'browser input', method: 'post', path: '/api/browser/sessions/s-404/input', body: {}, relay: true },
  { name: 'browser pending', method: 'post', path: '/api/browser/sessions/s-404/pending/p-404', body: { decision: 'reject' }, relay: true },
  // Gmail held send (behind the connector gate)
  { name: 'gmail held', method: 'post', path: '/api/google/gmail/held/h-404', body: { decision: 'discard' } },
  // Approvals answer 403 to anyone who is not the owner
  { name: 'approvals approve', method: 'post', path: '/api/approvals/A-404/approve', anonymousStatus: 403, relay: true },
  // OKR approvals / signal digests (audit fingerprint)
  { name: 'mission approve', method: 'post', path: '/api/missions/M-404/approve' },
  { name: 'signal digest item', method: 'post', path: '/api/signal-digests/SD-404/items/1', body: { choice: 'skip' } },
  // Desktop remote
  { name: 'desktop remote input', method: 'post', path: '/api/desktop/remote/input', body: {}, relay: true },
];

/**
 * Send one case.
 *
 * @param app - App
 * @param c - Route case
 * @param headers - Credential headers
 * @returns Response
 */
function send(app: Express, c: RouteCase, headers: Record<string, string>) {
  const req = request(app)[c.method](c.path).set(headers);
  return c.body !== undefined ? req.send(c.body as object) : req.send();
}

/**
 * Whether a response is the owner gate refusing the caller.
 *
 * @param res - Response
 * @returns True for the gate's 401/403
 */
function gateRefused(res: { status: number; body: Record<string, unknown> }): boolean {
  if (res.status === 401) return true;
  if (res.status !== 403) return false;
  // A handler past the gate can still answer 403 for its own reasons
  // (desktop remote control switched off): only an owner-only refusal counts.
  const reason = String(res.body?.reason ?? '');
  return reason !== 'remote_disabled';
}

describe('owner-only routes (#999)', () => {
  let app: Express;
  const original = process.env.CREWLY_API_TOKEN;

  beforeAll(() => {
    process.env.CREWLY_API_TOKEN = OWNER_TOKEN;
    resetApiTokenCache();
    app = buildApp();
  });

  afterAll(() => {
    if (original === undefined) delete process.env.CREWLY_API_TOKEN;
    else process.env.CREWLY_API_TOKEN = original;
    resetApiTokenCache();
  });

  beforeEach(() => {
    peerVerdict = { kind: 'not-agent', pid: 4242 };
  });

  describe.each(ROUTES)('$name — $method $path', (c) => {
    it('lets the owner session through', async () => {
      const res = await send(app, c, ownerAuthHeaders());
      expect(gateRefused(res)).toBe(false);
    });

    it('refuses an agent with its badge', async () => {
      const res = await send(app, c, agentAuthHeaders('crewly-dev-sam-1234abcd'));
      expect(res.status).toBe(c.agentStatus ?? 403);
    });

    it('refuses an agent with only the legacy session header', async () => {
      const res = await send(app, c, { 'X-Agent-Session': 'crewly-dev-sam-1234abcd' });
      expect(res.status).toBe(c.agentStatus ?? 403);
    });

    it('refuses a caller with no credential (never the owner)', async () => {
      const res = await send(app, c, {});
      expect(res.status).toBe(c.anonymousStatus ?? 401);
    });

    it('refuses the self-set dashboard marker', async () => {
      const res = await send(app, c, { 'X-Crewly-Caller': 'dashboard' });
      expect(res.status).toBe(c.anonymousStatus ?? 401);
    });

    it('refuses the owner session cookie without the CSRF token on a write', async () => {
      if (c.method === 'get') return;
      const { cookie } = ownerAuthHeaders();
      const res = await send(app, c, { cookie });
      expect(res.status).toBe(c.anonymousStatus ?? 401);
    });

    if (c.relay) {
      it('lets the phone / portal relay through', async () => {
        const res = await send(app, c, relayAuthHeaders());
        expect(gateRefused(res)).toBe(false);
      });
    }
  });

  describe('the owner API token from this machine', () => {
    const c = ROUTES.find((r) => r.name === 'decisions choose') as RouteCase;

    it('is the owner when the client process is not an agent (CLI, smoke test)', async () => {
      peerVerdict = { kind: 'not-agent', pid: 4242 };
      const res = await send(app, c, { 'X-Crewly-Token': OWNER_TOKEN });
      expect(gateRefused(res)).toBe(false);
    });

    it('is the agent when the client process descends from the backend (an agent read the token file)', async () => {
      peerVerdict = { kind: 'agent', pid: 4242, signal: 'ancestry', session: 'crewly-dev-sam-1234abcd' };
      const res = await send(app, c, { 'X-Crewly-Token': OWNER_TOKEN });
      expect(res.status).toBe(403);
    });

    it('is refused when the sending process was gone before the lookup (raw socket + exit)', async () => {
      peerVerdict = { kind: 'gone', reason: 'client process not found' };
      const res = await send(app, c, { 'X-Crewly-Token': OWNER_TOKEN });
      expect(res.status).toBe(401);
    });

    it('fails open when the lookup tool is missing or times out', async () => {
      peerVerdict = { kind: 'unknown', reason: 'no lsof' };
      const res = await send(app, c, { 'X-Crewly-Token': OWNER_TOKEN });
      expect(gateRefused(res)).toBe(false);
    });

    it('is refused when it only rides in the cookie on a write', async () => {
      const res = await send(app, c, { cookie: `crewly_token=${OWNER_TOKEN}` });
      expect(res.status).toBe(401);
    });
  });

  describe('the "no agent header means owner" behaviours', () => {
    it('chat/send: no credential is refused; the owner is not', async () => {
      expect((await request(app).post('/api/chat/send').send({ content: 'hi' })).status).toBe(401);
      const owner = await request(app).post('/api/chat/send').set(ownerAuthHeaders()).send({ content: '' });
      expect(owner.status).toBe(400); // past the gate; the empty message is the handler's 400
    });

    it('gmail/send: no credential is refused at the connector gate', async () => {
      expect((await request(app).post('/api/google/gmail/send').send({ to: 'a@b.c', subject: 's', text: 't', dryRun: true })).status).toBe(401);
      const owner = await request(app).post('/api/google/gmail/send').set(ownerAuthHeaders()).send({ to: 'a@b.c', subject: 's', text: 't', dryRun: true });
      expect(owner.status).toBe(200);
    });



    it('project tickets: a write with no credential is refused', async () => {
      const res = await request(app).post('/api/project-tickets/p-404').send({ title: 'x' });
      expect(res.status).toBe(401);
      const owner = await request(app).post('/api/project-tickets/p-404').set(ownerAuthHeaders()).send({ title: 'x' });
      expect(gateRefused(owner)).toBe(false);
    });

    it('team lead: no credential is refused; another agent is refused', async () => {
      expect((await request(app).post('/api/teams/t-404/lead').send({ memberId: 'm' })).status).toBe(401);
      expect((await request(app).post('/api/teams/t-404/lead').set(agentAuthHeaders('crewly-dev-sam-1234abcd')).send({ memberId: 'm' })).status).toBe(403);
      expect((await request(app).post('/api/teams/t-404/lead').set(ownerAuthHeaders()).send({ memberId: 'm' })).status).toBe(404);
    });
  });

  describe('Slack interactivity', () => {
    const envelope = { event: { type: 'block_actions' }, interaction: { type: 'block_actions', actions: [] } };

    it('refuses a Cloud-forwarded envelope from a local caller with no credential', async () => {
      expect((await request(app).post('/api/slack/interactivity').send(envelope)).status).toBe(401);
      expect((await request(app).post('/api/slack/interactivity').set(agentAuthHeaders('crewly-orc')).send(envelope)).status).toBe(401);
    });

    it('accepts it with the cloud credential', async () => {
      const { internalCredentialHeaders } = await import('../services/core/owner-auth.service.js');
      expect((await request(app).post('/api/slack/interactivity').set(internalCredentialHeaders('cloud')).send(envelope)).status).toBe(200);
    });
  });
});
