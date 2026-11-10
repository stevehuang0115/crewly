import { ORCHESTRATOR_SESSION_NAME, SHARED_CHANNEL_CONSTANTS } from '../../constants.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import { SHARED_SEND_ACTIONS, SHARED_SEND_KEYS, SharedChannelSendService, type SharedSendDeps } from './shared-channel-send.service.js';

const ORC = ORCHESTRATOR_SESSION_NAME;
const TRIAL = SHARED_CHANNEL_CONSTANTS.TRIAL_HELD_SENDS;

function setup(over: Partial<SharedSendDeps> = {}) {
  let n = 0;
  const counts: Record<string, number> = {};
  const open: OwnerDecision[] = [];
  const askPrebuilt = jest.fn(async (ask: Record<string, unknown>) => {
    const d = { id: `D-${open.length + 1}`, status: 'open', ...ask } as unknown as OwnerDecision;
    open.push(d);
    return d;
  });
  const deps = {
    listLinks: jest.fn(async () => [
      { linkId: 'l1', status: 'active' as const, counterpartDisplayName: 'Acme Co', counterpartEmail: 'a@acme.co' },
      { linkId: 'l2', status: 'revoked' as const, counterpartDisplayName: '', counterpartEmail: 'b@beta.co' },
    ]),
    post: jest.fn(async (_linkId: string, body: { id: string }) => ({ ok: true as const, messageId: body.id, createdAt: '2026-11-10T10:00:00.000Z', duplicate: false })),
    recordSent: jest.fn(() => 'row-1'),
    trial: {
      approvedCount: jest.fn((l: string) => counts[l] ?? 0),
      noteApproved: jest.fn((l: string) => (counts[l] = (counts[l] ?? 0) + 1)),
    },
    decisions: jest.fn(() => ({ askPrebuilt, list: jest.fn(async () => open.filter((d) => d.status === 'open')) })),
    agentIdentity: jest.fn(async () => ({ name: 'Orc' })),
    recentPeople: jest.fn(() => [] as string[]),
    newId: jest.fn(() => `msg-0000000${++n}`),
    instanceId: jest.fn(async () => 'inst-1'),
    record: jest.fn(),
    now: () => Date.parse('2026-11-10T10:00:00.000Z'),
    ...over,
  };
  return { svc: new SharedChannelSendService(deps as unknown as SharedSendDeps), deps, askPrebuilt, counts, open };
}

describe('SharedChannelSendService.sendFromAgent', () => {
  it('refuses senders other than the orchestrator', async () => {
    const { svc, deps } = setup();
    const r = await svc.sendFromAgent({ fromSession: 'team-dev-1', linkId: 'l1', text: 'hi' });
    expect(r).toMatchObject({ success: false, code: 'not_allowed' });
    expect(deps.listLinks).not.toHaveBeenCalled();
  });

  it('validates text and link', async () => {
    const { svc } = setup();
    expect(await svc.sendFromAgent({ fromSession: ORC, linkId: 'l1', text: '  ' })).toMatchObject({ code: 'invalid' });
    expect(await svc.sendFromAgent({ fromSession: ORC, linkId: '', text: 'hi' })).toMatchObject({ code: 'invalid' });
    expect(await svc.sendFromAgent({ fromSession: ORC, linkId: 'l1', text: 'x'.repeat(SHARED_CHANNEL_CONSTANTS.MAX_TEXT_LENGTH + 1) })).toMatchObject({ code: 'too_long' });
    expect(await svc.sendFromAgent({ fromSession: ORC, linkId: 'nope', text: 'hi' })).toMatchObject({ code: 'not_found' });
    expect(await svc.sendFromAgent({ fromSession: ORC, linkId: 'l2', text: 'hi' })).toMatchObject({ code: 'link_not_active' });
  });

  it('says Cloud is unreachable when links cannot be listed', async () => {
    const { svc } = setup({ listLinks: jest.fn(async () => null) });
    expect(await svc.sendFromAgent({ fromSession: ORC, linkId: 'l1', text: 'hi' })).toMatchObject({ code: 'cloud_unavailable' });
  });

  it('refuses a secret outright (no card) and logs it', async () => {
    const { svc, deps, askPrebuilt } = setup();
    const r = await svc.sendFromAgent({ fromSession: ORC, linkId: 'l1', text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123' });
    expect(r).toMatchObject({ success: false, code: 'refused' });
    expect(r.error).toContain('cannot be approved');
    expect(askPrebuilt).not.toHaveBeenCalled();
    expect(deps.post).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ action: SHARED_SEND_ACTIONS.REFUSED }));
  });

  it('refuses after another person\'s connector was read', async () => {
    const { svc } = setup({ recentPeople: jest.fn(() => ['p-amy']) });
    expect(await svc.sendFromAgent({ fromSession: ORC, linkId: 'l1', text: 'Thursday works' })).toMatchObject({ code: 'refused' });
  });

  it('holds a plain message during the trial, with a card the owner can read', async () => {
    const { svc, deps, askPrebuilt } = setup();
    const r = await svc.sendFromAgent({ fromSession: ORC, linkId: 'l1', text: 'Happy to meet Thursday.', replyTo: 'their-msg-1' });
    expect(r).toMatchObject({ success: true, status: 'held', decisionId: 'D-1', messageId: 'msg-00000001' });
    expect(deps.post).not.toHaveBeenCalled();
    const ask = askPrebuilt.mock.calls[0]![0] as Record<string, any>;
    expect(ask.kind).toBe('shared_send');
    expect(ask.asker).toBe(ORC);
    expect(ask.question).toBe('Send Orc\'s message to Acme Co? "Happy to meet Thursday."');
    expect(ask.defaultKey).toBe(SHARED_SEND_KEYS.DONT_SEND);
    expect(ask.yesKey).toBe(SHARED_SEND_KEYS.SEND);
    expect(ask.body[1]).toContain(`first ${TRIAL} messages`);
    expect(ask.sharedSend).toMatchObject({ linkId: 'l1', counterpart: 'Acme Co', text: 'Happy to meet Thursday.', replyTo: 'their-msg-1', trialOnly: true });
    expect(new Date(ask.deadline).toISOString()).toBe('2026-11-11T10:00:00.000Z');
  });

  it('reuses an open card for the same message', async () => {
    const { svc, askPrebuilt } = setup();
    await svc.sendFromAgent({ fromSession: ORC, linkId: 'l1', text: 'Same' });
    const again = await svc.sendFromAgent({ fromSession: ORC, linkId: 'l1', text: 'Same' });
    expect(again).toMatchObject({ status: 'held', decisionId: 'D-1' });
    expect(askPrebuilt).toHaveBeenCalledTimes(1);
  });

  it('cannot hold without the decision service: nothing is sent', async () => {
    const { svc, deps } = setup({ decisions: jest.fn(() => null) });
    expect(await svc.sendFromAgent({ fromSession: ORC, linkId: 'l1', text: 'hi' })).toMatchObject({ success: false, code: 'cannot_hold' });
    expect(deps.post).not.toHaveBeenCalled();
  });

  describe('after the trial', () => {
    it('sends a plain message at once and files it in chat under the Cloud id', async () => {
      const { svc, deps, counts } = setup();
      counts['l1'] = TRIAL;
      const r = await svc.sendFromAgent({ fromSession: ORC, linkId: 'l1', text: 'See you then.' });
      expect(r).toMatchObject({ success: true, status: 'sent', messageId: 'msg-00000001', chatMessageId: 'row-1' });
      expect(deps.post).toHaveBeenCalledWith('l1', { id: 'msg-00000001', text: 'See you then.', fromAgentName: 'Orc', instanceId: 'inst-1' });
      expect(deps.recordSent).toHaveBeenCalledWith(expect.objectContaining({ linkId: 'l1', counterpart: 'Acme Co', messageId: 'msg-00000001', direction: 'sent', senderName: 'Orc' }));
    });

    it('still holds a message that looks internal', async () => {
      const { svc, deps, askPrebuilt, counts } = setup();
      counts['l1'] = TRIAL;
      const r = await svc.sendFromAgent({ fromSession: ORC, linkId: 'l1', text: 'Our price is $4,000' });
      expect(r.status).toBe('held');
      expect(deps.post).not.toHaveBeenCalled();
      const ask = askPrebuilt.mock.calls[0]![0] as Record<string, any>;
      expect(ask.sharedSend.trialOnly).toBe(false);
      expect(ask.body[1]).toContain('money');
    });

    it('passes Cloud errors on with our codes', async () => {
      const { svc, counts } = setup({
        post: jest.fn(async () => ({ ok: false as const, status: 429, code: 'rate_limited', error: 'Too many messages on this link.', retryAfterS: 20 })),
      });
      counts['l1'] = TRIAL;
      const r = await svc.sendFromAgent({ fromSession: ORC, linkId: 'l1', text: 'ok' });
      expect(r).toMatchObject({ success: false, code: 'rate_limited', error: 'Too many messages on this link. Try again in 20 s.' });
    });

    it('still reports sent when filing in chat fails', async () => {
      const { svc, counts } = setup({ recordSent: jest.fn(() => { throw new Error('chat down'); }) });
      counts['l1'] = TRIAL;
      expect(await svc.sendFromAgent({ fromSession: ORC, linkId: 'l1', text: 'ok' })).toMatchObject({ success: true, chatMessageId: null });
    });
  });
});

describe('SharedChannelSendService.onSettled', () => {
  async function held() {
    const ctx = setup();
    await ctx.svc.sendFromAgent({ fromSession: ORC, linkId: 'l1', text: 'Happy to meet Thursday.' });
    return { ...ctx, decision: ctx.open[0]! };
  }

  it('Send posts the held message with its fixed id and counts toward the trial', async () => {
    const { svc, deps, decision, counts } = await held();
    const note = await svc.onSettled({ ...decision, status: 'resolved', chosenKey: SHARED_SEND_KEYS.SEND, answeredVia: 'button' });
    expect(deps.post).toHaveBeenCalledWith('l1', expect.objectContaining({ id: 'msg-00000001', text: 'Happy to meet Thursday.', fromAgentName: 'Orc' }));
    expect(deps.recordSent).toHaveBeenCalled();
    expect(counts['l1']).toBe(1);
    expect(note).toBe(`[EXTERNAL] The owner approved your message to Acme Co; it is sent. ${TRIAL - 1} more of your messages on this link will wait for the owner.`);
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ action: SHARED_SEND_ACTIONS.SENT, actor: { type: 'owner', via: 'button' } }));
  });

  it('Don\'t send tells the orchestrator and sends nothing', async () => {
    const { svc, deps, decision } = await held();
    const note = await svc.onSettled({ ...decision, status: 'resolved', chosenKey: SHARED_SEND_KEYS.DONT_SEND });
    expect(note).toContain('The owner declined your message to Acme Co');
    expect(note).toContain('NOT sent');
    expect(deps.post).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ action: SHARED_SEND_ACTIONS.DECLINED }));
  });

  it('no answer by the deadline: not sent, the orchestrator is told', async () => {
    const { svc, deps, decision } = await held();
    const note = await svc.onSettled({ ...decision, status: 'defaulted', chosenKey: SHARED_SEND_KEYS.DONT_SEND, answeredVia: 'deadline' });
    expect(note).toContain('did not answer in time');
    expect(deps.post).not.toHaveBeenCalled();
  });

  it('a withdrawn card says nothing', async () => {
    const { svc, decision } = await held();
    expect(await svc.onSettled({ ...decision, status: 'cancelled' })).toBeNull();
    expect(await svc.onSettled({ ...decision, sharedSend: undefined })).toBeNull();
  });

  it('an approved message that cannot be sent is reported and not counted', async () => {
    const { svc, deps, decision, counts } = await held();
    (deps.post as jest.Mock).mockResolvedValueOnce({ ok: false, status: 409, code: 'link_not_active', error: 'This link has been revoked' } as never);
    const note = await svc.onSettled({ ...decision, status: 'resolved', chosenKey: SHARED_SEND_KEYS.SEND });
    expect(note).toContain('could not be sent: This link has been revoked.');
    expect(counts['l1']).toBeUndefined();
  });
});

describe('SharedChannelSendService.sendFromOwner', () => {
  it('goes straight through, no classifier and no card, even in the trial', async () => {
    const { svc, deps, askPrebuilt } = setup();
    const r = await svc.sendFromOwner({ linkId: 'l1', text: 'Our price is $4,000, write to me at me@x.co' });
    expect(r).toMatchObject({ success: true, status: 'sent', messageId: 'msg-00000001' });
    expect(askPrebuilt).not.toHaveBeenCalled();
    expect(deps.post).toHaveBeenCalledWith('l1', expect.objectContaining({ fromAgentName: SHARED_CHANNEL_CONSTANTS.OWNER_SENDER_NAME }));
    expect(deps.trial.noteApproved).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ actor: { type: 'owner' }, action: SHARED_SEND_ACTIONS.SENT }));
  });

  it('finds the link from its Team Chat channel id', async () => {
    const { svc, deps } = setup();
    expect(await svc.sendFromOwner({ channelId: 'external-l1', text: 'hi' })).toMatchObject({ success: true, linkId: 'l1' });
    expect(deps.post).toHaveBeenCalledWith('l1', expect.anything());
    expect(await svc.sendFromOwner({ channelId: 'external-nope', text: 'hi' })).toMatchObject({ code: 'not_found' });
  });

  it('refuses a revoked link and maps an unreachable Cloud', async () => {
    const { svc } = setup({ post: jest.fn(async () => ({ ok: false as const, status: 0, code: 'network', error: 'offline' })) });
    expect(await svc.sendFromOwner({ linkId: 'l2', text: 'hi' })).toMatchObject({ code: 'link_not_active' });
    expect(await svc.sendFromOwner({ linkId: 'l1', text: 'hi' })).toMatchObject({ code: 'cloud_unavailable', error: 'offline.' });
  });
});

describe('SharedChannelSendService.listLinks', () => {
  it('lists links with their trial state', async () => {
    const { svc, counts } = setup();
    counts['l1'] = 3;
    expect(await svc.listLinks()).toEqual([
      { linkId: 'l1', status: 'active', counterpart: 'Acme Co', approvedSends: 3, trialLeft: TRIAL - 3 },
      { linkId: 'l2', status: 'revoked', counterpart: 'b@beta.co', approvedSends: 0, trialLeft: TRIAL },
    ]);
  });

  it('is null when Cloud cannot be reached', async () => {
    const { svc } = setup({ listLinks: jest.fn(async () => null) });
    expect(await svc.listLinks()).toBeNull();
  });
});
