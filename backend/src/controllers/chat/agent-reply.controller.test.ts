import type { Request, Response, NextFunction } from 'express';

jest.mock('./chat.controller.js', () => ({
  agentResponse: jest.fn(),
  deliverAgentReplyToConversation: jest.fn(),
  isAgentsOwnConversation: jest.fn(),
}));

import { OrcReplyRouteService } from '../../services/orc/orc-reply-route.service.js';
import {
  OwnerMessageWatchdogService,
  setOwnerMessageWatchdog,
} from '../../services/messaging/owner-message-watchdog.service.js';
import { createAgentReplyHandler, type AgentReplyDeps } from './agent-reply.controller.js';

function mockRes() {
  const res: Partial<Response> & { statusCode: number; body: unknown } = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  });
  res.json = jest.fn((b: unknown) => {
    res.body = b;
    return res as Response;
  });
  return res as Response & { statusCode: number; body: unknown };
}

function req(body: Record<string, unknown>, session = 'ella'): Request {
  return { body, headers: session ? { 'x-agent-session': session } : {} } as unknown as Request;
}

function makeDeps(over: Partial<AgentReplyDeps> = {}) {
  const deliver = jest.fn(async (input: { conversationId: string }) => (input.conversationId === 'broken' ? null : `msg-${input.conversationId}`));
  const agentResponse = jest.fn(async (_req: Request, res: Response) => {
    res.status(201).json({ success: true, via: 'agent-response' });
  });
  const postOrcSlack = jest.fn(async () => '1790.9');
  const deps: AgentReplyDeps = {
    agentResponse,
    deliver: deliver as unknown as AgentReplyDeps['deliver'],
    ownsConversation: async (_s, c) => c === 'dm-ella' || c === 'room-1' || c === 'broken',
    postOrcSlack,
    ...over,
  };
  return { deps, deliver, agentResponse, postOrcSlack };
}

const next: NextFunction = jest.fn();

describe('POST /api/chat/reply', () => {
  beforeEach(() => {
    OrcReplyRouteService.resetInstance();
    setOwnerMessageWatchdog(null);
    OrcReplyRouteService.getInstance().noteDelivery('ella', '[CHAT:dm-ella] <steve@Ella>\n[SLACK-THREAD:D0DM:1790000000.000100]\n\nupdate the sheet');
  });

  it('no ids → delivered to the conversation and Slack thread the message came from', async () => {
    const { deps, deliver } = makeDeps();
    const res = mockRes();
    await createAgentReplyHandler(deps)(req({ content: 'Done — sheet updated.' }), res, next);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'dm-ella', thread: 'D0DM:1790000000.000100', agentSession: 'ella', content: 'Done — sheet updated.' }),
    );
    expect(res.statusCode).toBe(201);
  });

  it('wrong / legacy conversation id → the origin', async () => {
    const { deps, deliver } = makeDeps();
    const res = mockRes();
    await createAgentReplyHandler(deps)(req({ content: 'answer', conversationId: 'conv-legacy' }), res, next);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'dm-ella' }));
    expect(res.statusCode).toBe(201);
  });

  it('explicit correct ids win', async () => {
    const { deps, deliver } = makeDeps();
    const res = mockRes();
    await createAgentReplyHandler(deps)(req({ content: 'answer', conversationId: 'room-1', thread: 'root-3' }), res, next);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'room-1', thread: 'root-3' }));
  });

  it('explicit ids that cannot be delivered fall back to the origin', async () => {
    const { deps, deliver } = makeDeps();
    const res = mockRes();
    await createAgentReplyHandler(deps)(req({ content: 'answer', conversationId: 'broken' }), res, next);
    expect(deliver).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: 'dm-ella' }));
    expect(res.statusCode).toBe(201);
  });

  it('status markers → the orchestrator status path', async () => {
    const { deps, deliver, agentResponse } = makeDeps();
    const res = mockRes();
    const r = req({ content: '[DONE] sheet updated' });
    await createAgentReplyHandler(deps)(r, res, next);
    expect(deliver).not.toHaveBeenCalled();
    expect(agentResponse).toHaveBeenCalled();
    expect(r.body).toEqual({ content: '[DONE] sheet updated', senderName: 'ella', senderType: 'agent' });
  });

  it('--none closes the watched owner message and posts nothing', async () => {
    const watchdog = new OwnerMessageWatchdogService({ isBusy: () => false, nudge: async () => ({ outcome: 'sent' }), postNote: async () => true });
    watchdog.track({
      surface: 'slack',
      slackChannelId: 'D0DM',
      threadTs: '1790000000.000100',
      sourceTs: '1790000000.000100',
      chatChannelId: 'dm-ella',
      responsible: 'ella',
      recipients: ['ella'],
      required: true,
      text: 'fyi the meeting moved',
    });
    setOwnerMessageWatchdog(watchdog);
    const { deps, deliver } = makeDeps();
    const res = mockRes();
    await createAgentReplyHandler(deps)(req({ none: true }), res, next);
    expect(deliver).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: true, data: { closed: 1 } });
    expect(watchdog.size).toBe(0);
  });

  it('nothing to reply to → 409 with a plain error (not dropped silently)', async () => {
    const { deps } = makeDeps();
    const res = mockRes();
    await createAgentReplyHandler(deps)(req({ content: 'hello' }, 'owen'), res, next);
    expect(res.statusCode).toBe(409);
  });

  it('delivery impossible → 409, never filed as status', async () => {
    const { deps, agentResponse } = makeDeps({ deliver: jest.fn(async () => null) as unknown as AgentReplyDeps['deliver'] });
    const res = mockRes();
    await createAgentReplyHandler(deps)(req({ content: 'answer' }), res, next);
    expect(res.statusCode).toBe(409);
    expect(agentResponse).not.toHaveBeenCalled();
  });

  it('the orchestrator answering a Slack-bridged turn posts in that Slack thread', async () => {
    OrcReplyRouteService.getInstance().noteDelivery('crewly-orc', '[CHAT:conv-orc:abcd1234] hi [SLACK:D0MASTER:1790.5]');
    const { deps, postOrcSlack, deliver } = makeDeps();
    const res = mockRes();
    await createAgentReplyHandler(deps)(req({ content: 'On it.' }, 'crewly-orc'), res, next);
    expect(postOrcSlack).toHaveBeenCalledWith({ channelId: 'D0MASTER', threadTs: '1790.5', text: 'On it.' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('the orchestrator answering a chat turn goes through its own chat routing', async () => {
    OrcReplyRouteService.getInstance().noteDelivery('crewly-orc', '[CHAT:conv-orc:abcd1234] hi');
    const { deps, agentResponse } = makeDeps();
    const res = mockRes();
    const r = req({ content: 'On it.' }, 'crewly-orc');
    await createAgentReplyHandler(deps)(r, res, next);
    expect(agentResponse).toHaveBeenCalled();
    expect(r.body).toEqual(expect.objectContaining({ senderType: 'orchestrator', conversationId: 'conv-orc' }));
  });

  it('rejects anonymous calls and empty text', async () => {
    const { deps } = makeDeps();
    const res1 = mockRes();
    await createAgentReplyHandler(deps)(req({ content: 'x' }, ''), res1, next);
    expect(res1.statusCode).toBe(400);
    const res2 = mockRes();
    await createAgentReplyHandler(deps)(req({ content: '  ' }), res2, next);
    expect(res2.statusCode).toBe(400);
  });
});
