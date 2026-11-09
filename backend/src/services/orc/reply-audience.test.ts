/**
 * Tests for the reply audience check (issue #969).
 *
 * @module services/orc/reply-audience.test
 */

import { checkReplyAudience, isSharedPlace, privatePeopleOf, recordPrivateShare, PRIVATE_REPLY_ACTIONS, type ReplyAudienceDeps } from './reply-audience.js';
import type { ReplyDestination } from './reply-destination-resolver.js';

type Resolved = Exclude<ReplyDestination, { kind: 'unresolved' }>;

const room: Resolved = { kind: 'conversation', conversationId: 'room-ce', thread: 'C0CE00001:1.1', source: 'ticket', reason: 'ticket thread' };
const dm: Resolved = { kind: 'conversation', conversationId: 'dm-owen', source: 'owner-dm', reason: 'owner dm' };
const slackChannel: Resolved = { kind: 'work', destination: { kind: 'slack', target: 'C0TEAM001', threadTs: '1.2', reason: 'trigger' }, source: 'work-item', reason: 'work' };
const slackDm: Resolved = { kind: 'work', destination: { kind: 'slack', target: 'D0OWNER01', reason: 'dm' }, source: 'work-item', reason: 'work' };
const toAgent: Resolved = { kind: 'work', destination: { kind: 'agent', sessionName: 'pia', reason: 'delegator' }, source: 'agent-message', reason: 'agent' };
const ticket: Resolved = { kind: 'work', destination: { kind: 'ticket-thread', projectPath: '/p', ticketId: 'CE-7', reason: 't' }, source: 'ticket', reason: 'ticket' };

function deps(over: Partial<ReplyAudienceDeps> = {}): ReplyAudienceDeps & { record: jest.Mock } {
  const record = jest.fn();
  const base: ReplyAudienceDeps = {
    recentPeople: () => ['UALICE'],
    conversationKind: (id) => (id === 'dm-owen' ? 'dm' : id === 'room-ce' ? 'shared' : 'unknown'),
    slackChannelOf: (id) => (id === 'slack-dm-alice' ? 'D0ALICE01' : null),
    ownerDm: async () => 'dm-owen',
    personName: (id) => (id === 'UALICE' ? 'Alice' : id === 'UBOB' ? 'Bob' : undefined),
    conversationPlace: (id) => (id === 'room-ce' ? '#ce' : null),
    record,
  };
  return { ...base, ...over, record } as ReplyAudienceDeps & { record: jest.Mock };
}

describe('the DM note', () => {
  it('points at the Share card only when one follows the DM copy', async () => {
    const withCard = await checkReplyAudience('owen', room, deps({ offersCard: () => true }));
    expect(withCard.kind === 'redirect' && withCard.note).toMatch(/Tap \*Share\* on the card below, or say "share it" here/);
    const noCard = await checkReplyAudience('owen', room, deps());
    expect(noCard.kind === 'redirect' && noCard.note).toMatch(/Say "share it" here and I will post it there\._$/);
    const throwing = await checkReplyAudience('owen', room, deps({ offersCard: () => { throw new Error('x'); } }));
    expect(throwing.kind === 'redirect' && throwing.note).toMatch(/Say "share it" here/);
  });
});

describe('isSharedPlace', () => {
  it('owner DMs, Slack DMs and internal agent messages are private; rooms, channels, ticket threads and unknown conversations are shared', () => {
    const d = deps();
    expect(isSharedPlace(dm, d)).toBe(false);
    expect(isSharedPlace(slackDm, d)).toBe(false);
    expect(isSharedPlace(toAgent, d)).toBe(false);
    expect(isSharedPlace({ ...room, conversationId: 'slack-dm-alice' }, d)).toBe(false);
    expect(isSharedPlace(room, d)).toBe(true);
    expect(isSharedPlace(slackChannel, d)).toBe(true);
    expect(isSharedPlace(ticket, d)).toBe(true);
    expect(isSharedPlace({ ...room, conversationId: 'never-seen' }, d)).toBe(true);
  });
});

describe('checkReplyAudience', () => {
  it('is open when the session read nobody\'s grant, or only the owner\'s', async () => {
    expect(await checkReplyAudience('owen', room, deps({ recentPeople: () => [] }))).toEqual({ kind: 'open' });
    expect(await checkReplyAudience('owen', room, deps({ recentPeople: () => ['owner'] }))).toEqual({ kind: 'open' });
  });

  it('is open for a private place even after a private read', async () => {
    const d = deps();
    expect(await checkReplyAudience('owen', dm, d)).toEqual({ kind: 'open' });
    expect(await checkReplyAudience('owen', slackDm, d)).toEqual({ kind: 'open' });
    expect(await checkReplyAudience('owen', toAgent, d)).toEqual({ kind: 'open' });
    expect(d.record).not.toHaveBeenCalled();
  });

  it('moves a shared-place reply to the owner DM with a note naming the place and the person, and logs it', async () => {
    const d = deps();
    const v = await checkReplyAudience('owen', room, d);
    expect(v.kind).toBe('redirect');
    if (v.kind !== 'redirect') return;
    expect(v.destination).toEqual({ kind: 'conversation', conversationId: 'dm-owen', source: 'owner-dm', reason: "held from #ce: it draws on Alice's data" });
    expect(v.note).toMatch(/^_Held from #ce: this draws on Alice's data/);
    expect(v.people).toEqual(['UALICE']);
    expect(d.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: PRIVATE_REPLY_ACTIONS.REDIRECTED,
        actor: { type: 'agent', id: 'owen' },
        target: { type: 'conversation', id: 'dm-owen' },
        after: { people: ['UALICE'], heldFrom: '#ce' },
      }),
    );
  });

  it('names several people and falls back to ids and channel ids', async () => {
    const d = deps({ recentPeople: () => ['UALICE', 'UBOB', 'UCAROL'] });
    const v = await checkReplyAudience('owen', slackChannel, d);
    expect(v.kind).toBe('redirect');
    if (v.kind !== 'redirect') return;
    expect(v.destination.reason).toBe("held from Slack channel C0TEAM001: it draws on Alice, Bob and UCAROL's data");
  });

  it('holds the reply when the agent has no owner DM, telling it why and what to do', async () => {
    const d = deps({ ownerDm: async () => null });
    const v = await checkReplyAudience('owen', ticket, d);
    expect(v.kind).toBe('held');
    if (v.kind !== 'held') return;
    expect(v.reason).toMatch(/draws on Alice's data .* the CE-7 ticket thread has other members/);
    expect(v.fix).toMatch(/owner's DM/);
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ action: PRIVATE_REPLY_ACTIONS.HELD }));
  });

  it('recordPrivateShare logs a shared post only when something private goes to a shared place', () => {
    const d = deps();
    expect(recordPrivateShare('owen', room, d)).toEqual(['UALICE']);
    expect(d.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: PRIVATE_REPLY_ACTIONS.SHARED, target: { type: 'conversation', id: 'room-ce' }, after: { people: ['UALICE'], sharedTo: '#ce' } }),
    );
    expect(recordPrivateShare('owen', dm, d)).toEqual([]);
    expect(recordPrivateShare('owen', room, deps({ recentPeople: () => ['owner'] }))).toEqual([]);
    expect(privatePeopleOf('owen', { recentPeople: () => { throw new Error('boom'); } })).toEqual([]);
  });

  it('never throws: a failing tracker reads as open', async () => {
    const d = deps({ recentPeople: () => { throw new Error('boom'); } });
    expect(await checkReplyAudience('owen', room, d)).toEqual({ kind: 'open' });
  });
});
