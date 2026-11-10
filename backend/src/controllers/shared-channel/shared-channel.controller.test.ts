import express from 'express';
import request from 'supertest';
import { createSharedChannelRouter } from './shared-channel.controller.js';
import { setSharedChannelSendService } from '../../services/shared-channel/shared-channel.wiring.js';
import type { SharedChannelSendService } from '../../services/shared-channel/shared-channel-send.service.js';

let mockOwner = false;
jest.mock('../../utils/agent-caller.utils.js', () => ({
  readAgentSessionHeader: (req: { headers: Record<string, string | undefined> }) => req.headers['x-agent-session'],
  isOwnerCaller: () => mockOwner,
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
