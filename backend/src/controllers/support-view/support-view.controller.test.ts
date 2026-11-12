/**
 * Tests for the support view routes (crewly#1558): caller identity, what each
 * route asks the service for, and how failures are answered.
 */

import express from 'express';
import request from 'supertest';
import { SUPPORT_VIEW_CONSTANTS } from '../../constants.js';
import { SupportViewError } from '../../services/support/support-client.types.js';
import { setSupportViewService } from '../../services/support/support.wiring.js';
import type { SupportViewService } from '../../services/support/support-view.service.js';
import { createSupportViewRouter } from './support-view.controller.js';

jest.mock('../../services/core/logger.service.js', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { LoggerService: { getInstance: () => ({ createComponentLogger: () => log }) } };
});

jest.mock('../../utils/agent-caller.utils.js', () => ({
  readAgentSessionHeader: (req: { headers: Record<string, string | undefined> }) => req.headers['x-agent-session'] || undefined,
}));

const F = SUPPORT_VIEW_CONSTANTS.FAILURES;
const RESULT = { grant: { id: 'g1', grantorEmail: 'steve@example.com', includePrivate: false }, machine: { instanceId: 'i1', deviceName: 'Studio Mac' }, data: { rows: [1] } };

function make() {
  const service = {
    grants: jest.fn(async (_session: string) => [{ id: 'g1' }]),
    read: jest.fn(async (_session: string, _selector: { grant?: string; machine?: string }, _read: unknown) => RESULT),
  };
  setSupportViewService(service as unknown as SupportViewService);
  const app = express();
  app.use('/api/support-view', createSupportViewRouter());
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: 'unexpected' });
  });
  return { app, service };
}

const AGENT = { 'X-Agent-Session': 'crewly-nova' };

afterEach(() => setSupportViewService(null));

describe('support view routes: who may call', () => {
  it('answers 503 when the service is not running', async () => {
    const { app } = make();
    setSupportViewService(null);
    const res = await request(app).get('/api/support-view/agents').set(AGENT);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, code: F.NOT_CONNECTED });
  });

  it.each(['/grants', '/agents', '/conversations', '/conversations/c1/messages', '/errors'])('refuses %s without an agent caller', async (path) => {
    const { app, service } = make();
    const res = await request(app).get(`/api/support-view${path}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: F.INVALID });
    expect(service.grants).not.toHaveBeenCalled();
    expect(service.read).not.toHaveBeenCalled();
  });

  it('has no route that writes', async () => {
    const { app, service } = make();
    for (const call of [request(app).post('/api/support-view/agents'), request(app).post('/api/support-view/agents/a-dev/restart'), request(app).delete('/api/support-view/conversations/c1'), request(app).get('/api/support-view/settings')]) {
      expect((await call.set(AGENT)).status).toBe(404);
    }
    expect(service.read).not.toHaveBeenCalled();
  });
});

describe('support view routes: reads', () => {
  it('lists the grants for the calling agent', async () => {
    const { app, service } = make();
    const res = await request(app).get('/api/support-view/grants').set(AGENT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, grants: [{ id: 'g1' }] });
    expect(service.grants).toHaveBeenCalledWith('crewly-nova');
  });

  it('reads agents, naming the caller from its identity and the grant and machine from the query', async () => {
    const { app, service } = make();
    const res = await request(app).get('/api/support-view/agents').query({ grant: 'steve@example.com', machine: 'Studio Mac', session: 'someone-else' }).set(AGENT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ...RESULT });
    expect(service.read).toHaveBeenCalledWith('crewly-nova', { grant: 'steve@example.com', machine: 'Studio Mac' }, { area: 'agents' });
  });

  it('reads conversations and errors with a limit', async () => {
    const { app, service } = make();
    await request(app).get('/api/support-view/conversations').query({ limit: '5' }).set(AGENT);
    await request(app).get('/api/support-view/conversations').set(AGENT);
    await request(app).get('/api/support-view/errors').query({ limit: '80' }).set(AGENT);
    expect(service.read.mock.calls.map((c) => c[2])).toEqual([{ area: 'conversations', limit: 5 }, { area: 'conversations' }, { area: 'errors', limit: 80 }]);
    expect(service.read.mock.calls[1][1]).toEqual({ grant: undefined, machine: undefined });
  });

  it('reads the messages of one conversation, with the older cursor', async () => {
    const { app, service } = make();
    await request(app).get('/api/support-view/conversations/slack-C1/messages').query({ older: 'eyJzZXEiOjF9', limit: '10' }).set(AGENT);
    expect(service.read).toHaveBeenCalledWith('crewly-nova', { grant: undefined, machine: undefined }, { area: 'messages', conversationId: 'slack-C1', limit: 10, older: 'eyJzZXEiOjF9' });
  });

  it.each(['0', '-1', 'ten', '5x', '1.5'])('refuses the limit %p', async (limit) => {
    const { app, service } = make();
    const res = await request(app).get('/api/support-view/conversations').query({ limit }).set(AGENT);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: F.INVALID });
    expect(service.read).not.toHaveBeenCalled();
  });

  it('ignores a repeated grant or machine parameter instead of guessing', async () => {
    const { app, service } = make();
    await request(app).get('/api/support-view/agents?grant=a&grant=b').set(AGENT);
    expect(service.read.mock.calls[0][1]).toEqual({ grant: undefined, machine: undefined });
  });
});

describe('support view routes: failures', () => {
  it.each([
    [F.ACCESS_ENDED, 403],
    [F.AGENT_ACCESS_OFF, 403],
    [F.READ_ONLY, 403],
    [F.NOT_ALLOWED, 403],
    [F.RATE_LIMITED, 429],
    [F.OFFLINE, 504],
    [F.DISABLED, 403],
    [F.NOT_FOUND, 404],
    [F.NOT_CONNECTED, 503],
    [F.TURNED_OFF_HERE, 403],
    [F.OWNER_ONLY, 403],
    [F.CLOUD_UNSUPPORTED, 501],
    [F.INVALID, 400],
    [F.FAILED, 502],
  ] as const)('answers %s with %i, its code and plain words', async (code, status) => {
    const { app, service } = make();
    service.read.mockRejectedValueOnce(new SupportViewError(code));
    const res = await request(app).get('/api/support-view/errors').set(AGENT);
    expect(res.status).toBe(status);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe(code);
    expect(typeof res.body.error).toBe('string');
    expect(res.body).not.toHaveProperty('choices');
  });

  it('lists what may be named when the agent has to choose', async () => {
    const { app, service } = make();
    service.read.mockRejectedValueOnce(new SupportViewError(F.CHOOSE, 'Name one with --grant.', ['a (grant g1)', 'b (grant g2)']));
    const res = await request(app).get('/api/support-view/agents').set(AGENT);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, code: F.CHOOSE, error: 'Name one with --grant.', choices: ['a (grant g1)', 'b (grant g2)'] });
  });

  it('answers a refused grants listing the same way', async () => {
    const { app, service } = make();
    service.grants.mockRejectedValueOnce(new SupportViewError(F.TURNED_OFF_HERE));
    const res = await request(app).get('/api/support-view/grants').set(AGENT);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(F.TURNED_OFF_HERE);
  });

  it('hands an unexpected error to the error handler', async () => {
    const { app, service } = make();
    service.read.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/support-view/agents').set(AGENT);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });
});
