/**
 * Tests for the private-share decision cards (crewly#969).
 *
 * @module services/orc/private-share-decisions.test
 */

import type { OwnerDecision } from '../../types/decision.types.js';
import {
  PrivateShareDecisions,
  PRIVATE_SHARE_KEYS,
  getPrivateShareDecisions,
  setPrivateShareDecisions,
  type HeldReply,
  type PrivateShareDecisionsDeps,
  type PrivateShareDecisionService,
} from './private-share-decisions.js';

const held: HeldReply = {
  session: 'owen',
  content: 'Her Q3 invoices total 12k',
  destination: { kind: 'conversation', conversationId: 'room-ce', thread: 'C0CE00001:1.1', source: 'ticket', reason: 'ticket thread' },
  heldFrom: '#ce',
  people: ['UALICE'],
  ownerDm: 'dm-owen',
};

function decisionOf(over: Partial<OwnerDecision> = {}): OwnerDecision {
  return {
    id: 'D-1',
    kind: 'private_share',
    question: 'Share?',
    options: [
      { key: PRIVATE_SHARE_KEYS.SHARE, label: 'Share' },
      { key: PRIVATE_SHARE_KEYS.KEEP, label: 'Keep private' },
    ],
    defaultKey: PRIVATE_SHARE_KEYS.KEEP,
    deadline: new Date(Date.now() + 1000).toISOString(),
    requestedBy: 'owen',
    asker: 'owen',
    status: 'open',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    privateShare: { agentSession: 'owen', agentName: 'Owen', content: held.content, destination: held.destination, heldFrom: '#ce', people: ['UALICE'], ownerDm: 'dm-owen' },
    ...over,
  };
}

function build(over: Partial<PrivateShareDecisionsDeps> = {}, open: OwnerDecision[] = []) {
  const askPrebuilt = jest.fn(async (ask: Parameters<PrivateShareDecisionService['askPrebuilt']>[0]) => decisionOf({ question: ask.question, options: ask.options, place: ask.place, privateShare: ask.privateShare }));
  const decisions: PrivateShareDecisionService = { askPrebuilt, list: async () => open };
  const post = (over.post as jest.Mock | undefined) ?? jest.fn(async () => ({ ok: true, place: '#ce' }) as const);
  const record = jest.fn();
  const service = new PrivateShareDecisions({
    decisions: () => decisions,
    canAsk: () => true,
    post,
    slackChannelOf: (id) => (id === 'dm-owen' ? 'D0OWEN001' : null),
    agentNameOf: async () => 'Owen',
    personName: (id) => (id === 'UALICE' ? 'Alice' : undefined),
    record,
    ...over,
  });
  return { service, askPrebuilt, post, record };
}

describe('PrivateShareDecisions.onHeld', () => {
  it('asks the owner in the agent DM with Share / Keep private, Keep private as the safe default', async () => {
    const { service, askPrebuilt } = build();
    const d = await service.onHeld(held);
    expect(d?.id).toBe('D-1');
    expect(askPrebuilt).toHaveBeenCalledTimes(1);
    const ask = askPrebuilt.mock.calls[0][0];
    expect(ask.kind).toBe('private_share');
    expect(ask.asker).toBe('owen');
    expect(ask.question).toBe("Share Owen's reply in #ce? It draws on Alice's data, which only you and they may see.");
    expect(ask.options.map((o) => o.key)).toEqual([PRIVATE_SHARE_KEYS.SHARE, PRIVATE_SHARE_KEYS.KEEP]);
    expect(ask.defaultKey).toBe(PRIVATE_SHARE_KEYS.KEEP);
    expect(ask.yesKey).toBe(PRIVATE_SHARE_KEYS.SHARE);
    expect(ask.place).toEqual({ slackChannelId: 'D0OWEN001' });
    expect(ask.body).toEqual(['> Her Q3 invoices total 12k']);
    expect(ask.privateShare).toEqual(expect.objectContaining({ agentSession: 'owen', agentName: 'Owen', heldFrom: '#ce', people: ['UALICE'], ownerDm: 'dm-owen', destination: held.destination }));
  });

  it('reuses the open card for the same agent, place and text instead of raising a second one', async () => {
    const { service, askPrebuilt } = build({}, [decisionOf({ id: 'D-7' })]);
    const d = await service.onHeld(held);
    expect(d?.id).toBe('D-7');
    expect(askPrebuilt).not.toHaveBeenCalled();
    // A different text is a new question.
    const d2 = await service.onHeld({ ...held, content: 'Something else' });
    expect(d2?.id).toBe('D-1');
    expect(askPrebuilt).toHaveBeenCalledTimes(1);
  });

  it('raises nothing when Slack is down or the decision service is not up; offersCard says so', async () => {
    const down = build({ canAsk: () => false });
    expect(down.service.offersCard()).toBe(false);
    expect(await down.service.onHeld(held)).toBeNull();
    expect(down.askPrebuilt).not.toHaveBeenCalled();
    const none = build({ decisions: () => null });
    expect(none.service.offersCard()).toBe(false);
    expect(await none.service.onHeld(held)).toBeNull();
    expect(build().service.offersCard()).toBe(true);
  });

  it('places the card at the top of the DM copy when the owner DM mirrors no Slack DM (the service picks the place)', async () => {
    const { service, askPrebuilt } = build({ slackChannelOf: () => null });
    await service.onHeld(held);
    expect(askPrebuilt.mock.calls[0][0].place).toBeUndefined();
  });
});

describe('PrivateShareDecisions.onSettled', () => {
  it('Share: posts the reply where it was going and logs the share from the card', async () => {
    const { service, post, record } = build();
    const note = await service.onSettled(decisionOf({ status: 'resolved', chosenKey: PRIVATE_SHARE_KEYS.SHARE, answeredBy: 'U0OWNER', answeredVia: 'button' }));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ session: 'owen', content: held.content, destination: held.destination }));
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'owner', id: 'U0OWNER', via: 'button' },
        action: 'connector.private_output.shared',
        target: { type: 'conversation', id: 'room-ce' },
        after: { people: ['UALICE'], sharedTo: '#ce', decisionId: 'D-1' },
      }),
    );
    expect(note).toMatch(/shared your reply held from #ce; it is posted there now/);
  });

  it('Share that cannot be posted: nothing is logged as shared and the agent is told to tell the owner', async () => {
    const { service, post, record } = build({ post: jest.fn(async () => ({ ok: false, error: 'channel_not_found' }) as const) });
    const note = await service.onSettled(decisionOf({ status: 'resolved', chosenKey: PRIVATE_SHARE_KEYS.SHARE }));
    expect(post).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
    expect(note).toMatch(/could not be posted there: channel_not_found/);
    const thrown = build({ post: jest.fn(async () => { throw new Error('boom'); }) });
    expect(await thrown.service.onSettled(decisionOf({ status: 'resolved', chosenKey: PRIVATE_SHARE_KEYS.SHARE }))).toMatch(/boom/);
  });

  it('Keep private: nothing is posted, the choice is logged and the agent is told not to post it another way', async () => {
    const { service, post, record } = build();
    const note = await service.onSettled(decisionOf({ status: 'resolved', chosenKey: PRIVATE_SHARE_KEYS.KEEP, answeredVia: 'button' }));
    expect(post).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'connector.private_output.kept', target: { type: 'conversation', id: 'dm-owen' } }));
    expect(note).toMatch(/kept your reply held from #ce in their DM\. Do not post it there another way/);
  });

  it('the deadline default, an expiry or a withdrawn card posts nothing and wakes nobody', async () => {
    const { service, post, record } = build();
    expect(await service.onSettled(decisionOf({ status: 'defaulted', chosenKey: PRIVATE_SHARE_KEYS.KEEP, answeredVia: 'deadline' }))).toBeNull();
    expect(await service.onSettled(decisionOf({ status: 'expired' }))).toBeNull();
    expect(await service.onSettled(decisionOf({ status: 'cancelled' }))).toBeNull();
    expect(await service.onSettled(decisionOf({ status: 'resolved', chosenKey: PRIVATE_SHARE_KEYS.SHARE, privateShare: undefined }))).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('registry', () => {
  afterEach(() => setPrivateShareDecisions(null));

  it('holds the handler the composition root registered', () => {
    expect(getPrivateShareDecisions()).toBeNull();
    const { service } = build();
    setPrivateShareDecisions(service);
    expect(getPrivateShareDecisions()).toBe(service);
  });
});
