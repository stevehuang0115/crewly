import express from 'express';
import request from 'supertest';
import { createColleagueRouter } from './colleague.controller.js';
import { setColleagueMessageService } from '../../services/colleague/colleague.wiring.js';
import type { ColleagueMessageService } from '../../services/colleague/colleague-message.service.js';

jest.mock('../../utils/agent-caller.utils.js', () => ({
  readAgentSessionHeader: (req: { headers: Record<string, string | undefined> }) => req.headers['x-agent-session'],
}));

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/colleagues', createColleagueRouter());
  return a;
}

describe('POST /api/colleagues/message', () => {
  afterEach(() => setColleagueMessageService(null));

  it('is 503 before the service runs', async () => {
    const res = await request(app()).post('/api/colleagues/message').send({ to: 'Pia', message: 'hi' });
    expect(res.status).toBe(503);
  });

  it('refuses a caller that is not an agent', async () => {
    setColleagueMessageService({ send: jest.fn() } as unknown as ColleagueMessageService);
    const res = await request(app()).post('/api/colleagues/message').send({ to: 'Pia', message: 'hi' });
    expect(res.status).toBe(403);
  });

  it('sends as the calling agent, taking the sender from identity and not the body', async () => {
    const send = jest.fn().mockResolvedValue({ success: true, messageId: 'm1', route: 'remote' });
    setColleagueMessageService({ send } as unknown as ColleagueMessageService);
    const res = await request(app())
      .post('/api/colleagues/message')
      .set('x-agent-session', 'steamfun-fern')
      .send({ to: 'Pia', message: 'hi', replyTo: 'r1', team: 'Flopost', fromSession: 'evil' });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ fromSession: 'steamfun-fern', to: 'Pia', text: 'hi', replyTo: 'r1', team: 'Flopost' });
    expect(res.body.messageId).toBe('m1');
  });

  it.each([
    ['not_found', 404],
    ['ambiguous', 409],
    ['loop_cap', 429],
    ['send_failed', 502],
  ])('maps %s to HTTP %i', async (code, status) => {
    setColleagueMessageService({ send: jest.fn().mockResolvedValue({ success: false, code, error: 'x' }) } as unknown as ColleagueMessageService);
    const res = await request(app()).post('/api/colleagues/message').set('x-agent-session', 'a').send({ to: 'P', message: 'hi' });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });
});
