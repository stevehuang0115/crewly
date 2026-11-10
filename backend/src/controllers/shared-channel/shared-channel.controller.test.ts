import express from 'express';
import request from 'supertest';
import { createSharedChannelRouter } from './shared-channel.controller.js';
import { setSharedChannelSendService } from '../../services/shared-channel/shared-channel.wiring.js';
import type { SharedChannelSendService } from '../../services/shared-channel/shared-channel-send.service.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SharedChannelNormsStore } from '../../services/shared-channel/shared-channel-norms.store.js';
import { agentAuthHeaders, callerIdentityForTests, ownerAuthHeaders } from '../../middleware/caller-identity.testing.js';

let mockOwner = false;
jest.mock('../../utils/agent-caller.utils.js', () => ({
  readAgentSessionHeader: (req: { headers: Record<string, string | undefined> }) => req.headers['x-agent-session'],
  isOwnerCaller: () => mockOwner,
}));

const recordActivity = jest.fn();
jest.mock('../../services/activity/activity-log.service.js', () => ({
  ...jest.requireActual('../../services/activity/activity-log.service.js'),
  recordActivity: (...args: unknown[]) => recordActivity(...args),
}));

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/shared-channels', createSharedChannelRouter());
  return a;
}

function svc(over: Partial<Record<'sendFromAgent' | 'sendFromOwner' | 'listLinks', jest.Mock>> = {}) {
  const s = { sendFromAgent: jest.fn(), sendFromOwner: jest.fn(), listLinks: jest.fn(), ...over };
  setSharedChannelSendService(s as unknown as SharedChannelSendService);
  return s;
}

describe('shared-channel routes', () => {
  afterEach(() => {
    setSharedChannelSendService(null);
    mockOwner = false;
  });

  it('is 503 before the service runs', async () => {
    expect((await request(app()).get('/api/shared-channels')).status).toBe(503);
    expect((await request(app()).post('/api/shared-channels/l1/messages').send({ message: 'hi' })).status).toBe(503);
  });

  it('lists links, or 503 when Cloud is unreachable', async () => {
    const s = svc({ listLinks: jest.fn().mockResolvedValueOnce([{ linkId: 'l1' }]).mockResolvedValueOnce(null) });
    const ok = await request(app()).get('/api/shared-channels');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true, links: [{ linkId: 'l1' }] });
    expect((await request(app()).get('/api/shared-channels')).status).toBe(503);
    expect(s.listLinks).toHaveBeenCalledTimes(2);
  });

  it('sends as the calling agent, taking the sender from identity and not the body', async () => {
    const s = svc({ sendFromAgent: jest.fn().mockResolvedValue({ success: true, status: 'held', decisionId: 'D-1' }) });
    const res = await request(app())
      .post('/api/shared-channels/l1/messages')
      .set('x-agent-session', 'crewly-orc')
      .send({ message: 'hi', replyTo: ' m9 ', fromSession: 'evil' });
    expect(res.status).toBe(200);
    expect(s.sendFromAgent).toHaveBeenCalledWith({ fromSession: 'crewly-orc', linkId: 'l1', text: 'hi', replyTo: 'm9' });
    expect(res.body.decisionId).toBe('D-1');
  });

  it('sends as the owner for an owner caller', async () => {
    mockOwner = true;
    const s = svc({ sendFromOwner: jest.fn().mockResolvedValue({ success: true, status: 'sent' }) });
    const res = await request(app()).post('/api/shared-channels/l1/messages').send({ message: 'hi' });
    expect(res.status).toBe(200);
    expect(s.sendFromOwner).toHaveBeenCalledWith({ linkId: 'l1', text: 'hi' });
  });

  it('refuses a caller that is neither', async () => {
    const s = svc();
    const res = await request(app()).post('/api/shared-channels/l1/messages').send({ message: 'hi' });
    expect(res.status).toBe(403);
    expect(s.sendFromAgent).not.toHaveBeenCalled();
    expect(s.sendFromOwner).not.toHaveBeenCalled();
  });

  it.each([
    ['not_allowed', 403],
    ['refused', 422],
    ['link_not_active', 409],
    ['rate_limited', 429],
    ['cannot_hold', 503],
    ['send_failed', 502],
  ])('maps %s to HTTP %i', async (code, status) => {
    svc({ sendFromAgent: jest.fn().mockResolvedValue({ success: false, code, error: 'x' }) });
    const res = await request(app()).post('/api/shared-channels/l1/messages').set('x-agent-session', 'crewly-orc').send({ message: 'hi' });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });
});

describe('shared-channel norms routes (slice 6)', () => {
  let dir: string;
  let store: SharedChannelNormsStore;
  function normsApp() {
    const a = express();
    a.use(express.json());
    a.use(callerIdentityForTests());
    a.use('/api/shared-channels', createSharedChannelRouter({ norms: () => store }));
    return a;
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-norms-routes-'));
    store = SharedChannelNormsStore.inDir(dir, 'n.json');
    recordActivity.mockClear();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lets the owner read an unset norm with the allowance catalogue', async () => {
    const res = await request(normsApp()).get('/api/shared-channels/l1/norms').set(ownerAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ linkId: 'l1', norm: '', allow: [], updatedAt: null });
    expect(res.body.data.allowances.map((a: { key: string }) => a.key)).toContain('money');
    expect(res.body.data.allowances.map((a: { key: string }) => a.key)).not.toContain('secret');
  });

  it('refuses agents (403) and callers with no credential (401)', async () => {
    const a = normsApp();
    const agentGet = await request(a).get('/api/shared-channels/l1/norms').set(agentAuthHeaders('crewly-orc'));
    expect(agentGet.status).toBe(403);
    expect(agentGet.body.code).toBe('not_allowed');
    const agentPut = await request(a).put('/api/shared-channels/l1/norms').set(agentAuthHeaders('crewly-orc')).send({ allow: ['money'] });
    expect(agentPut.status).toBe(403);
    expect(store.get('l1').allow).toEqual([]);
    expect((await request(a).put('/api/shared-channels/l1/norms').send({ allow: ['money'] })).status).toBe(401);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it('saves the owner\'s change and logs it in the activity log', async () => {
    const res = await request(normsApp()).put('/api/shared-channels/l1/norms').set(ownerAuthHeaders()).send({ norm: 'Our printer.', allow: ['money'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ norm: 'Our printer.', allow: ['money'] });
    expect(store.get('l1')).toMatchObject({ norm: 'Our printer.', allow: ['money'] });
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      action: 'shared_channel.norm.updated',
      actor: expect.objectContaining({ type: 'owner' }),
      target: { type: 'shared_channel', id: 'l1' },
      before: { norm: '', allow: [] },
      after: { norm: 'Our printer.', allow: ['money'] },
    }));
  });

  it('does not log a save that changes nothing', async () => {
    store.set('l1', { allow: ['money'] });
    await request(normsApp()).put('/api/shared-channels/l1/norms').set(ownerAuthHeaders()).send({ allow: ['money'] });
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it('refuses allowing a hard refusal, unknown keys and a bad link id', async () => {
    const a = normsApp();
    const never = await request(a).put('/api/shared-channels/l1/norms').set(ownerAuthHeaders()).send({ allow: ['secret'] });
    expect(never.status).toBe(400);
    expect(never.body.error).toContain('can never be allowed');
    expect((await request(a).put('/api/shared-channels/l1/norms').set(ownerAuthHeaders()).send({ allow: ['nope'] })).status).toBe(400);
    expect((await request(a).get('/api/shared-channels/bad%20id/norms').set(ownerAuthHeaders())).status).toBe(400);
    expect(store.get('l1').allow).toEqual([]);
  });

  it('answers 500 when the norm cannot be saved', async () => {
    const a = express();
    a.use(express.json());
    a.use(callerIdentityForTests());
    a.use('/api/shared-channels', createSharedChannelRouter({ norms: () => ({ get: store.get.bind(store), set: () => { throw new Error('disk'); } }) }));
    const res = await request(a).put('/api/shared-channels/l1/norms').set(ownerAuthHeaders()).send({ allow: ['money'] });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('save_failed');
  });
});
