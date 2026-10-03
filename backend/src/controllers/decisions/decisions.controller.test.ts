/**
 * Tests for the decisions API and POST /api/slack/interactivity
 * (specs/2026-10-01-decision-cards.md §5, §8).
 */
import { createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';
import { createDecisionsRouter, createSlackInteractivityHandler, parseSkipAllBody, verifySlackSignature, type DecisionsControllerDeps } from './decisions.controller.js';
import { DecisionError, type DecisionService } from '../../services/decisions/decision.service.js';
import { ownerUnlessAgentForTests } from '../../middleware/caller-identity.testing.js';
import { agentAuthHeaders } from '../../middleware/caller-identity.testing.js';
import { internalCredentialHeaders } from '../../services/core/owner-auth.service.js';

const SECRET = 'shh-signing-secret';
const NOW_MS = Date.parse('2026-10-01T12:00:00Z');
const NOW_S = Math.floor(NOW_MS / 1000);

function fakeService() {
  return {
    ask: jest.fn(async (caller: string | undefined, input: Record<string, unknown>) => {
      if (input.question === 'thoughts?') throw new DecisionError(400, '"thoughts?" is too vague to answer from a phone. Example: ask-owner …');
      return { id: 'D-1', asker: caller, status: 'open' };
    }),
    list: jest.fn(async (which: string) => [{ id: 'D-1', status: 'open', which }]),
    get: jest.fn(async (id: string) => (id === 'D-1' ? { id: 'D-1', asker: 'dev-ann', requestedBy: 'tl-sam', status: 'open' } : null)),
    chooseFromDashboard: jest.fn(async (id: string, option: string) => ({ id, chosenKey: option, status: 'resolved' })),
    remindFromDashboard: jest.fn(async (id: string) => ({ id, remindAt: 'x' })),
    cancelWhere: jest.fn(async () => 1),
    skipFromDashboard: jest.fn(async (id: string) => ({ id, status: 'skipped' })),
    skipAll: jest.fn(async (input: Record<string, unknown>) => ({ dryRun: input.dryRun === true, matched: 2, settled: input.dryRun ? [] : ['D-1', 'D-2'], rows: [] })),
  };
}

function app(service: ReturnType<typeof fakeService> | null, secret: string | undefined = SECRET) {
  const emitted: Array<{ payload: unknown; source: string; eventId?: string }> = [];
  const deps: DecisionsControllerDeps = {
    service: () => service as unknown as DecisionService,
    emitInteraction: (payload, source, eventId) => void emitted.push({ payload, source, eventId }),
    signingSecret: () => secret,
    now: () => NOW_MS,
  };
  const a = express();
  a.use(ownerUnlessAgentForTests);
  a.use(express.json());
  a.use(
    express.urlencoded({
      extended: true,
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );
  a.use('/api/decisions', createDecisionsRouter(deps));
  a.post('/api/slack/interactivity', createSlackInteractivityHandler(deps));
  return { app: a, emitted, deps };
}

const payload = { type: 'block_actions', user: { id: 'U1' }, actions: [{ action_id: 'decision:a', value: '{"d":"D-1","o":"a","i":"x"}' }] };
const formBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
const sign = (body: string, ts = String(NOW_S), secret = SECRET) => `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;

describe('decisions API', () => {
  it('POST / asks as the calling agent; a vague ask is a 400 with the fix', async () => {
    const svc = fakeService();
    const { app: a } = app(svc);
    const ok = await request(a).post('/api/decisions').set('X-Agent-Session', 'dev-ann').send({ question: 'Send it Monday?', options: ['Yes', 'No'], default: 'No' });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ success: true, data: { id: 'D-1', asker: 'dev-ann', status: 'open' } });
    expect(svc.ask).toHaveBeenCalledWith('dev-ann', expect.objectContaining({ default: 'No' }));
    const bad = await request(a).post('/api/decisions').set('X-Agent-Session', 'dev-ann').send({ question: 'thoughts?' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/too vague.*Example/);
  });

  it('GET / lists open by default, all on request; GET /:id 404', async () => {
    const svc = fakeService();
    const { app: a } = app(svc);
    expect((await request(a).get('/api/decisions')).body.data[0].which).toBe('open');
    expect((await request(a).get('/api/decisions?status=all')).body.data[0].which).toBe('all');
    expect((await request(a).get('/api/decisions/D-1')).status).toBe(200);
    expect((await request(a).get('/api/decisions/D-9')).status).toBe(404);
  });

  it('choose / remind are owner-only (agent header → 403)', async () => {
    const svc = fakeService();
    const { app: a } = app(svc);
    expect((await request(a).post('/api/decisions/D-1/choose').set('X-Agent-Session', 'dev-ann').send({ option: 'a' })).status).toBe(403);
    expect((await request(a).post('/api/decisions/D-1/remind').set('X-Agent-Session', 'dev-ann')).status).toBe(403);
    // A badge-carrying agent, and a caller with no credential at all (#999).
    expect((await request(a).post('/api/decisions/D-1/choose').set(agentAuthHeaders('dev-ann')).send({ option: 'a' })).status).toBe(403);
    const anon = await request(a).post('/api/decisions/D-1/choose').set('X-Test-Anonymous', '1').send({ option: 'a' });
    expect(anon.status).toBe(401);
    expect(anon.body.error).toBe('owner_auth_required');
    expect(svc.chooseFromDashboard).not.toHaveBeenCalled();
    expect((await request(a).post('/api/decisions/D-1/choose').send({})).status).toBe(400);
    const ok = await request(a).post('/api/decisions/D-1/choose').send({ option: 'a' });
    expect(ok.status).toBe(200);
    expect(svc.chooseFromDashboard).toHaveBeenCalledWith('D-1', 'a');
    expect((await request(a).post('/api/decisions/D-1/remind')).status).toBe(200);
  });

  it('cancel: the asker yes, a stranger no', async () => {
    const svc = fakeService();
    const { app: a } = app(svc);
    expect((await request(a).post('/api/decisions/D-1/cancel').set('X-Agent-Session', 'dev-bob')).status).toBe(403);
    expect((await request(a).post('/api/decisions/D-1/cancel').set('X-Agent-Session', 'dev-ann')).status).toBe(200);
    expect(svc.cancelWhere).toHaveBeenCalledTimes(1);
  });

  it('cancel: the reason is kept, sent as `note` or `reason` (D-52: the orc sent `reason`)', async () => {
    const svc = fakeService();
    const { app: a } = app(svc);
    await request(a).post('/api/decisions/D-1/cancel').set('X-Agent-Session', 'dev-ann').send({ reason: 'already answered in the thread' });
    expect((svc.cancelWhere as jest.Mock).mock.calls[0][1]).toBe('already answered in the thread');
    await request(a).post('/api/decisions/D-1/cancel').set('X-Agent-Session', 'dev-ann').send({ note: 'ticket done' });
    expect((svc.cancelWhere as jest.Mock).mock.calls[1][1]).toBe('ticket done');
    await request(a).post('/api/decisions/D-1/cancel').set('X-Agent-Session', 'dev-ann').send({});
    expect((svc.cancelWhere as jest.Mock).mock.calls[2][1]).toBeUndefined();
  });

  it('503 before the service is wired', async () => {
    const { app: a } = app(null);
    expect((await request(a).get('/api/decisions')).status).toBe(503);
  });
});

describe('POST /api/slack/interactivity', () => {
  const post = (a: express.Express, body: string, headers: Record<string, string>) =>
    request(a).post('/api/slack/interactivity').set('Content-Type', 'application/x-www-form-urlencoded').set(headers).send(body);

  it('a correctly signed payload= form is emitted and answered 200', async () => {
    const { app: a, emitted } = app(fakeService());
    const res = await post(a, formBody, { 'X-Slack-Request-Timestamp': String(NOW_S), 'X-Slack-Signature': sign(formBody) });
    expect(res.status).toBe(200);
    expect(emitted).toEqual([{ payload, source: 'http', eventId: undefined }]);
  });

  it('wrong, missing or stale signatures are 401', async () => {
    const { app: a, emitted } = app(fakeService());
    expect((await post(a, formBody, { 'X-Slack-Request-Timestamp': String(NOW_S), 'X-Slack-Signature': sign(formBody, String(NOW_S), 'other') })).status).toBe(401);
    expect((await post(a, formBody, {})).status).toBe(401);
    const old = String(NOW_S - 10 * 60);
    expect((await post(a, formBody, { 'X-Slack-Request-Timestamp': old, 'X-Slack-Signature': sign(formBody, old) })).status).toBe(401);
    const tampered = formBody.replace('decision%3Aa', 'decision%3Ab');
    expect((await post(a, tampered, { 'X-Slack-Request-Timestamp': String(NOW_S), 'X-Slack-Signature': sign(formBody) })).status).toBe(401);
    expect(emitted).toHaveLength(0);
  });

  it('no signing secret configured → 401', async () => {
    const { app: a, emitted } = app(fakeService(), '');
    expect((await post(a, formBody, { 'X-Slack-Request-Timestamp': String(NOW_S), 'X-Slack-Signature': sign(formBody) })).status).toBe(401);
    expect(emitted).toHaveLength(0);
  });

  it('a Cloud envelope with the Cloud forwarder\'s credential is emitted; junk is 400', async () => {
    const { app: a, emitted } = app(fakeService());
    const env = { eventId: 'interaction:T1:1.2:3.4', event: { type: 'block_actions', channel: 'C1' }, interaction: payload };
    expect((await request(a).post('/api/slack/interactivity').set(internalCredentialHeaders('cloud')).send(env)).status).toBe(200);
    expect(emitted).toEqual([{ payload, source: 'cloud', eventId: 'interaction:T1:1.2:3.4' }]);
    expect((await request(a).post('/api/slack/interactivity').send({ hello: 1 })).status).toBe(400);
  });

  it('a Cloud envelope from this machine without the credential is 401 — being local is not enough (#999)', async () => {
    const { app: a, emitted } = app(fakeService());
    const env = { event: { type: 'block_actions', channel: 'C1' }, interaction: payload };
    expect((await request(a).post('/api/slack/interactivity').set('X-Test-Anonymous', '1').send(env)).status).toBe(401);
    expect((await request(a).post('/api/slack/interactivity').set(agentAuthHeaders('dev-1')).send(env)).status).toBe(401);
    expect(emitted).toHaveLength(0);
  });

  it('a Cloud envelope from another machine is 401', () => {
    const emitted: unknown[] = [];
    const handler = createSlackInteractivityHandler({ service: () => null, emitInteraction: (p) => void emitted.push(p), signingSecret: () => SECRET });
    const res = { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; }, end() { return this; } };
    const req = { body: { event: { type: 'block_actions' }, interaction: payload }, socket: { remoteAddress: '203.0.113.5' }, header: () => undefined } as unknown as express.Request;
    handler(req, res as unknown as express.Response);
    expect(res.statusCode).toBe(401);
    expect(emitted).toHaveLength(0);
  });

  it('verifySlackSignature', () => {
    expect(verifySlackSignature(SECRET, String(NOW_S), sign('abc'), 'abc', NOW_S)).toBe(true);
    expect(verifySlackSignature(SECRET, 'nope', sign('abc'), 'abc', NOW_S)).toBe(false);
    expect(verifySlackSignature('', String(NOW_S), sign('abc'), 'abc', NOW_S)).toBe(false);
  });
});

describe('skip (specs/2026-10-01-decision-skip.md)', () => {
  it('POST /:id/skip is owner-only', async () => {
    const svc = fakeService();
    const { app: a } = app(svc);
    const ok = await request(a).post('/api/decisions/D-1/skip').send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ id: 'D-1', status: 'skipped' });
    expect((await request(a).post('/api/decisions/D-1/skip').set('X-Agent-Session', 'dev-ann').send({})).status).toBe(403);
    expect(svc.skipFromDashboard).toHaveBeenCalledTimes(1);
  });

  it('POST /skip-all passes the filters; dry run; owner-only; bad input is a 400', async () => {
    const svc = fakeService();
    const { app: a } = app(svc);
    const dry = await request(a).post('/api/decisions/skip-all').send({ olderThan: '2026-10-01T00:00:00.000Z', source: 'backfill', dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.data).toMatchObject({ dryRun: true, matched: 2, settled: [] });
    expect(svc.skipAll).toHaveBeenLastCalledWith({ olderThan: new Date('2026-10-01T00:00:00.000Z'), source: 'backfill', dryRun: true });
    const all = await request(a).post('/api/decisions/skip-all').send({});
    expect(all.body.data.settled).toEqual(['D-1', 'D-2']);
    expect(svc.skipAll).toHaveBeenLastCalledWith({});
    expect((await request(a).post('/api/decisions/skip-all').set('X-Agent-Session', 'crewly-orc').send({})).status).toBe(403);
    expect((await request(a).post('/api/decisions/skip-all').send({ olderThan: 'yesterday-ish' })).status).toBe(400);
    expect((await request(a).post('/api/decisions/skip-all').send({ source: 'old' })).status).toBe(400);
    expect((await request(a).post('/api/decisions/skip-all').send({ dryRun: 'yes' })).status).toBe(400);
    expect(svc.skipAll).toHaveBeenCalledTimes(2);
  });

  it('parseSkipAllBody', () => {
    expect(parseSkipAllBody(undefined)).toEqual({});
    expect(parseSkipAllBody({ olderThan: '', source: 'all', dryRun: false })).toEqual({ source: 'all', dryRun: false });
    expect(() => parseSkipAllBody({ olderThan: {} })).toThrow('olderThan must be an ISO date-time');
  });
});
