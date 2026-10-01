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
import type { WorkDestinationDeps } from '../../services/orc/work-item-destination.wiring.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

/** In-memory work-destination collaborators (spec 2026-10-01 §6). */
function makeWorkDeps(over: Partial<WorkDestinationDeps> & { items?: WorkItem[]; teamChannel?: { slackChannelId: string; teamId: string } | null } = {}) {
  const threads = new Map<string, { slackChannelId: string; threadTs: string; teamId?: string }>();
  let ts = 1790100000;
  const post = jest.fn(async (r: { target: string }) => ({ channelId: r.target, messageTs: `${ts++}.000100` }));
  const wd: WorkDestinationDeps = {
    poolItems: async () => over.items ?? [],
    ownerOrigin: (s) => OrcReplyRouteService.getInstance().getLastOrigin(s),
    now: () => Date.now(),
    teamChannelOf: async () => (over.teamChannel === undefined ? { slackChannelId: 'C0TEAM1', teamId: 'team-1' } : over.teamChannel),
    ticketThreads: () => ({
      get: async (p, id) => threads.get(`${p}#${id}`) ?? null,
      set: async (p, id, t) => {
        const k = `${p}#${id}`;
        if (!threads.has(k)) threads.set(k, t);
        return threads.get(k)!;
      },
    }),
    ticketInfo: async (_p, id) => ({ title: `Title of ${id}`, team: null }),
    post: post as unknown as WorkDestinationDeps['post'],
    ...over,
  };
  return { wd, post, threads };
}

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
    workDestination: async () => makeWorkDeps().wd,
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

  it('nothing to reply to (no work, no owner message, no team channel) → 409 with a plain error', async () => {
    const { deps } = makeDeps({ workDestination: async () => makeWorkDeps({ teamChannel: null }).wd });
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

describe('POST /api/chat/reply — work-item destinations (spec 2026-10-01 §6)', () => {
  const HOUR = 60 * 60 * 1000;

  function wi(over: Partial<WorkItem>): WorkItem {
    return {
      id: 'wi-1',
      type: 'cron_run',
      owner: 'orchestrator',
      target: 'atlas',
      title: 'steveswiki quarterly review',
      status: 'running',
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      startedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
      retryCount: 0,
      maxRetries: 3,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      ...over,
    } as WorkItem;
  }

  beforeEach(() => {
    OrcReplyRouteService.resetInstance();
    setOwnerMessageWatchdog(null);
  });

  it('scheduled output with a stale owner thread → a NEW top-level post in the team channel, not the old thread', async () => {
    // The owner last asked Atlas in a #pro-think-tank thread, 3 hours ago.
    OrcReplyRouteService.getInstance().noteDelivery(
      'atlas',
      '[CHAT:room-think] <steve@Atlas>\n[SLACK-THREAD:C0THINK:1790000000.000100]\n\nthoughts?',
      Date.now() - 3 * HOUR,
    );
    const work = makeWorkDeps({
      items: [wi({ triggerId: 'trig-1', metadata: { origin: { kind: 'trigger', triggerId: 'trig-1', topic: 'steveswiki quarterly review' } } })],
    });
    const { deps, deliver } = makeDeps({ workDestination: async () => work.wd });
    const res = mockRes();
    await createAgentReplyHandler(deps)(req({ content: 'Q3 review: 12 notes, 3 stale.' }, 'atlas'), res, next);
    expect(deliver).not.toHaveBeenCalled();
    expect(work.post).toHaveBeenCalledTimes(1);
    expect(work.post).toHaveBeenCalledWith(
      expect.objectContaining({ agentSession: 'atlas', target: 'C0TEAM1', newTopLevel: true, text: '*steveswiki quarterly review*\nQ3 review: 12 notes, 3 stale.' }),
    );
    expect(work.post.mock.calls[0][0]).not.toHaveProperty('threadTs');
    expect(res.statusCode).toBe(201);
    expect((res.body as { data: { destination: string } }).data.destination).toBe('new-top-level');
  });

  it('a fresh owner message newer than the work item → that same thread (existing path)', async () => {
    const work = makeWorkDeps({ items: [wi({ triggerId: 'trig-1' })] });
    OrcReplyRouteService.getInstance().noteDelivery('atlas', '[CHAT:room-think] <steve@Atlas>\n[SLACK-THREAD:C0THINK:1790000000.000100]\n\nhow is it going?');
    const { deps, deliver } = makeDeps({ workDestination: async () => work.wd });
    const res = mockRes();
    await createAgentReplyHandler(deps)(req({ content: 'Halfway.' }, 'atlas'), res, next);
    expect(work.post).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'room-think', thread: 'C0THINK:1790000000.000100' }));
  });

  it('ticket work → the ticket thread, created on first post and reused after', async () => {
    const work = makeWorkDeps({ items: [wi({ type: 'project_task', triggerId: undefined, metadata: { projectTicket: { projectPath: '/p/app', id: 'APP-12' } } })] });
    const { deps } = makeDeps({ workDestination: async () => work.wd });
    await createAgentReplyHandler(deps)(req({ content: 'Draft is ready.' }, 'atlas'), mockRes(), next);
    // Root, then the answer in its thread.
    expect(work.post).toHaveBeenCalledTimes(2);
    expect(work.post.mock.calls[0][0]).toEqual(expect.objectContaining({ target: 'C0TEAM1', text: '*APP-12 · Title of APP-12*', newTopLevel: true }));
    const rootTs = (await work.post.mock.results[0].value).messageTs;
    expect(work.post.mock.calls[1][0]).toEqual(expect.objectContaining({ target: 'C0TEAM1', threadTs: rootTs, text: 'Draft is ready.' }));
    expect(work.threads.get('/p/app#APP-12')).toEqual(expect.objectContaining({ slackChannelId: 'C0TEAM1', threadTs: rootTs }));

    await createAgentReplyHandler(deps)(req({ content: 'Sent for review.' }, 'atlas'), mockRes(), next);
    expect(work.post).toHaveBeenCalledTimes(3);
    expect(work.post.mock.calls[2][0]).toEqual(expect.objectContaining({ threadTs: rootTs, text: 'Sent for review.' }));
  });

  it("a trigger's destination is honoured (thread)", async () => {
    const work = makeWorkDeps({
      items: [wi({ metadata: { origin: { kind: 'trigger', triggerId: 't', destination: 'C0WIKI99:1790000500.000200', topic: 'wiki' } } })],
    });
    const { deps } = makeDeps({ workDestination: async () => work.wd });
    await createAgentReplyHandler(deps)(req({ content: 'Done.' }, 'atlas'), mockRes(), next);
    expect(work.post).toHaveBeenCalledWith(expect.objectContaining({ target: 'C0WIKI99', threadTs: '1790000500.000200', text: 'Done.' }));
  });

  it('explicit ids win over the work item destination', async () => {
    OrcReplyRouteService.getInstance().noteDelivery('ella', '[CHAT:dm-ella] <steve@Ella>\n\nhi', Date.now() - 3 * HOUR);
    const work = makeWorkDeps({ items: [wi({ target: 'ella', triggerId: 't' })] });
    const { deps, deliver } = makeDeps({ workDestination: async () => work.wd });
    const res = mockRes();
    await createAgentReplyHandler(deps)(req({ content: 'answer', conversationId: 'room-1', thread: 'root-3' }, 'ella'), res, next);
    expect(work.post).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'room-1', thread: 'root-3' }));
  });

  it('no current work and no fresh owner message → a new top-level post in the team channel', async () => {
    const work = makeWorkDeps();
    const { deps } = makeDeps({ workDestination: async () => work.wd });
    const res = mockRes();
    await createAgentReplyHandler(deps)(req({ content: 'FYI: the build is green again.' }, 'owen'), res, next);
    expect(work.post).toHaveBeenCalledWith(expect.objectContaining({ target: 'C0TEAM1', newTopLevel: true, text: 'FYI: the build is green again.' }));
    expect(res.statusCode).toBe(201);
  });

  it('--new-thread "<title>" → new top-level post opened with the title', async () => {
    const work = makeWorkDeps();
    const { deps } = makeDeps({ workDestination: async () => work.wd });
    const res = mockRes();
    await createAgentReplyHandler(deps)(req({ content: 'Found 3 broken links.', newThread: 'Wiki link audit' }, 'owen'), res, next);
    expect(work.post).toHaveBeenCalledWith(expect.objectContaining({ target: 'C0TEAM1', newTopLevel: true, text: '*Wiki link audit*\nFound 3 broken links.' }));
    expect(res.statusCode).toBe(201);
  });

  it('--new-thread with no team channel → 409', async () => {
    const { deps } = makeDeps({ workDestination: async () => makeWorkDeps({ teamChannel: null }).wd });
    const res = mockRes();
    await createAgentReplyHandler(deps)(req({ content: 'x', newThread: 'T' }, 'owen'), res, next);
    expect(res.statusCode).toBe(409);
  });

  it('a Slack failure at the work destination falls back to the turn origin', async () => {
    OrcReplyRouteService.getInstance().noteDelivery('atlas', '[CHAT:dm-atlas] <steve@Atlas>\n\nhi', Date.now() - 3 * HOUR);
    const work = makeWorkDeps({ items: [wi({ triggerId: 't' })], post: jest.fn(async () => { throw new Error('not_in_channel'); }) });
    const { deps, deliver } = makeDeps({ workDestination: async () => work.wd });
    await createAgentReplyHandler(deps)(req({ content: 'done' }, 'atlas'), mockRes(), next);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'dm-atlas' }));
  });

  /**
   * 2026-10-01: the owner asked Atlas in the #morning-brief thread; Atlas
   * delegated to Sage and then verified Sage's work. The verify item had no
   * origin, so the answer fell back to another thread. With the origin
   * inherited down the chain, the answer goes to the owner's thread.
   */
  describe('origin inherited by delegate + verify items', () => {
    const briefOrigin = { kind: 'owner', conversationId: 'room-brief', slackChannelId: 'C0BRIEF', threadTs: '1790856242.596149' };

    it('the verify item\'s owner origin wins over the agent\'s own (unrelated) last owner thread', async () => {
      // Atlas's newest owner turn: an unrelated Blender-video thread, 3 h ago.
      OrcReplyRouteService.getInstance().noteDelivery(
        'atlas',
        '[CHAT:room-brief] <steve@Atlas>\n[SLACK-THREAD:C0BRIEF:1790883820.388009]\n\nthis blender video?',
        Date.now() - 3 * HOUR,
      );
      const verify = wi({ id: 'del:verify:del', type: 'review', owner: 'team_lead', title: 'Verify: Starship launches', metadata: { verifyOf: 'del', origin: briefOrigin } });
      const work = makeWorkDeps({ items: [verify] });
      const { deps, deliver } = makeDeps({ workDestination: async () => work.wd });
      const res = mockRes();
      await createAgentReplyHandler(deps)(req({ content: 'Verified: the 1,800 figure is a price model.' }, 'atlas'), res, next);
      expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'room-brief', thread: 'C0BRIEF:1790856242.596149' }));
      expect(work.post).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(201);
    });

    it('when the origin conversation will not take it → a new top-level post with a topic line, not the last thread', async () => {
      OrcReplyRouteService.getInstance().noteDelivery('sage', '[CHAT:room-old] <steve@Sage>\n[SLACK-THREAD:C0OLD:1790000000.000100]\n\nold question', Date.now() - 3 * HOUR);
      const delegate = wi({ id: 'del', type: 'delegate', target: 'sage', owner: 'team_lead', title: 'Starship launches note', metadata: { origin: briefOrigin } });
      const work = makeWorkDeps({ items: [delegate] });
      const deliver = jest.fn(async (_i: { conversationId: string }) => null);
      const { deps } = makeDeps({ workDestination: async () => work.wd, deliver: deliver as unknown as AgentReplyDeps['deliver'] });
      const res = mockRes();
      await createAgentReplyHandler(deps)(req({ content: 'Note is ready.' }, 'sage'), res, next);
      expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'room-brief' }));
      expect(deliver).not.toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'room-old' }));
      expect(work.post).toHaveBeenCalledWith(expect.objectContaining({ target: 'C0TEAM1', newTopLevel: true, text: '*Starship launches note*\nNote is ready.' }));
      expect(res.statusCode).toBe(201);
    });

    it('current work with no origin → a new top-level post, never the last owner thread', async () => {
      OrcReplyRouteService.getInstance().noteDelivery('sage', '[CHAT:room-old] <steve@Sage>\n[SLACK-THREAD:C0OLD:1790000000.000100]\n\nold question', Date.now() - 3 * HOUR);
      const work = makeWorkDeps({ items: [wi({ id: 'x', type: 'delegate', target: 'sage', owner: 'team_lead', title: 'Pricing table' })] });
      const { deps, deliver } = makeDeps({ workDestination: async () => work.wd });
      await createAgentReplyHandler(deps)(req({ content: 'Table done.' }, 'sage'), mockRes(), next);
      expect(deliver).not.toHaveBeenCalled();
      expect(work.post).toHaveBeenCalledWith(expect.objectContaining({ target: 'C0TEAM1', newTopLevel: true, text: '*Pricing table*\nTable done.' }));
    });
  });
});
