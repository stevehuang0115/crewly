import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TurnOrigin } from './orc-reply-route.service.js';
import { WORK_ITEM_DESTINATION_CONSTANTS } from '../../constants.js';
import {
  buildAgentOrigin,
  buildTriggerOrigin,
  currentWorkItemOf,
  delegatorResultNote,
  inheritedOrigin,
  isDelegatedInThread,
  isOwnerRequestTooOld,
  isLeadReport,
  isWorkItemOrigin,
  leadReportOf,
  originOfWorkItem,
  ownerOriginFromConversation,
  ownerOriginFromThreadKey,
  ownerThreadHandover,
  ownerOriginFromTurn,
  parseDestination,
  planWorkDestination,
  shortTopic,
  withTopicLine,
} from './work-item-destination.js';
import { agentResultText, deliverToWorkDestination, resolveAgentSlackDestination, type WorkDestinationDeps } from './work-item-destination.wiring.js';

const NOW = Date.parse('2026-10-01T15:00:00Z');
const HOUR = 60 * 60 * 1000;

function wi(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi-1',
    type: 'delegate',
    owner: 'orchestrator',
    target: 'atlas',
    title: 'Quarterly review',
    status: 'running',
    createdAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
    startedAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
    retryCount: 0,
    maxRetries: 3,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    ...over,
  } as WorkItem;
}

function owner(at: number): TurnOrigin {
  return { conversationId: 'room-x', slackChannelId: 'C0THINK', slackThreadKey: 'C0THINK:1790000000.000100', receivedAt: at };
}

describe('work-item destination planner', () => {
  it('picks the newest running/accepted item of the session', () => {
    const items = [
      wi({ id: 'a', startedAt: new Date(NOW - 3 * HOUR).toISOString() }),
      wi({ id: 'b', startedAt: new Date(NOW - HOUR).toISOString(), status: 'accepted' }),
      wi({ id: 'c', status: 'done', startedAt: new Date(NOW).toISOString() }),
      wi({ id: 'd', target: 'other' }),
    ];
    expect(currentWorkItemOf(items, 'atlas')?.id).toBe('b');
    expect(currentWorkItemOf(items, 'nobody')).toBeNull();
  });

  it('a stale owner thread never wins over scheduled work', () => {
    const d = planWorkDestination({ workItem: wi({ triggerId: 't1' }), ownerOrigin: owner(NOW - 3 * HOUR), now: NOW });
    expect(d).toEqual(expect.objectContaining({ kind: 'new-top-level', topic: 'Quarterly review' }));
  });

  it('an owner message older than the work item (but fresh) does not win either', () => {
    const d = planWorkDestination({ workItem: wi({ triggerId: 't1' }), ownerOrigin: owner(NOW - 30 * 60 * 1000), now: NOW });
    expect(d.kind).toBe('new-top-level');
  });

  it('a fresh owner message newer than the work item → owner origin', () => {
    const d = planWorkDestination({ workItem: wi({ triggerId: 't1' }), ownerOrigin: owner(NOW - 60 * 1000), now: NOW });
    expect(d.kind).toBe('owner-origin');
  });

  it('no work, fresh owner → owner origin; stale owner → new top-level', () => {
    expect(planWorkDestination({ workItem: null, ownerOrigin: owner(NOW - 60 * 1000), now: NOW }).kind).toBe('owner-origin');
    expect(planWorkDestination({ workItem: null, ownerOrigin: owner(NOW - 3 * HOUR), now: NOW }).kind).toBe('new-top-level');
    expect(planWorkDestination({ workItem: null, now: NOW }).kind).toBe('new-top-level');
  });

  it('ticket work → the ticket thread', () => {
    const d = planWorkDestination({ workItem: wi({ metadata: { projectTicket: { projectPath: '/p', id: 'APP-3' }, teamId: 'team-a' } }), now: NOW });
    expect(d).toEqual(expect.objectContaining({ kind: 'ticket-thread', projectPath: '/p', ticketId: 'APP-3', teamId: 'team-a' }));
  });

  it('trigger destination → that Slack place; channel-only destination keeps the topic line', () => {
    const stamped = buildTriggerOrigin({ triggerId: 't', destination: 'C0ABCDEF:1790000000.000001', topic: 'x' });
    expect(planWorkDestination({ workItem: wi({ metadata: { origin: stamped } }), now: NOW })).toEqual(
      expect.objectContaining({ kind: 'slack', target: 'C0ABCDEF', threadTs: '1790000000.000001' }),
    );
    const named = buildTriggerOrigin({ triggerId: 't', destination: '#wiki', topic: 'Wiki review' });
    expect(planWorkDestination({ workItem: wi({ metadata: { origin: named } }), now: NOW })).toEqual(
      expect.objectContaining({ kind: 'slack', target: '#wiki', topic: 'Wiki review' }),
    );
  });

  it('cron work items (metadata.source = cron) are scheduled work', () => {
    const o = originOfWorkItem(wi({ type: 'cron_run', description: 'Weekly digest', metadata: { source: 'cron', cronTaskId: 'c1', targetTeamId: 'team-b' } }));
    expect(o).toEqual({ kind: 'trigger', cronTaskId: 'c1', teamId: 'team-b', topic: 'Weekly digest' });
  });

  it('a work item with no recorded origin → new top-level post titled by the work', () => {
    expect(planWorkDestination({ workItem: wi(), now: NOW })).toEqual(expect.objectContaining({ kind: 'new-top-level', topic: 'Quarterly review' }));
  });

  it('helpers: destinations, topics', () => {
    expect(parseDestination('C0ABCDEF')).toEqual({ target: 'C0ABCDEF' });
    expect(parseDestination('#team-news')).toEqual({ target: '#team-news' });
    expect(parseDestination('nonsense')).toBeNull();
    expect(shortTopic('a\n b')).toBe('a b');
    expect(shortTopic('x'.repeat(500)).length).toBe(120);
    expect(withTopicLine('Topic', 'Body')).toBe('*Topic*\nBody');
    expect(withTopicLine('Topic', '*Topic*\nBody')).toBe('*Topic*\nBody');
    expect(withTopicLine(undefined, 'Body')).toBe('Body');
  });
});

describe('resolveAgentSlackDestination', () => {
  function deps(over: Partial<WorkDestinationDeps> = {}): WorkDestinationDeps {
    return {
      poolItems: async () => [],
      ownerOrigin: () => undefined,
      now: () => NOW,
      teamChannelOf: async () => ({ slackChannelId: 'C0TEAM1', teamId: 'team-1' }),
      ticketThreads: () => ({ get: async () => null, set: async (_p, _i, t) => t }),
      ticketInfo: async () => ({ title: 'T', team: null }),
      post: jest.fn(),
      ...over,
    };
  }

  it('owner Slack thread → that thread', async () => {
    expect(await resolveAgentSlackDestination('atlas', deps({ ownerOrigin: () => owner(NOW - 1000) }))).toEqual({ slackChannelId: 'C0THINK', threadTs: '1790000000.000100' });
  });

  it('owner chat DM → its bridged Slack DM', async () => {
    const d = deps({ ownerOrigin: () => ({ conversationId: 'dm-1', receivedAt: NOW - 1000 }), dmOfConversation: () => ({ slackChannelId: 'D0DM1', threadTs: '1.2' }) });
    expect(await resolveAgentSlackDestination('atlas', d)).toEqual({ slackChannelId: 'D0DM1', threadTs: '1.2' });
  });

  it('ticket with a thread → the thread; without → its team channel (no post)', async () => {
    const items = [wi({ metadata: { projectTicket: { projectPath: '/p', id: 'APP-1' } } })];
    const withThread = deps({ poolItems: async () => items, ticketThreads: () => ({ get: async () => ({ slackChannelId: 'C0TEAM1', threadTs: '9.9', teamId: 'team-1' }), set: jest.fn() }) });
    expect(await resolveAgentSlackDestination('atlas', withThread)).toEqual({ slackChannelId: 'C0TEAM1', threadTs: '9.9', teamId: 'team-1' });
    const without = deps({ poolItems: async () => items });
    expect(await resolveAgentSlackDestination('atlas', without)).toEqual({ slackChannelId: 'C0TEAM1', teamId: 'team-1' });
    expect(without.post).not.toHaveBeenCalled();
  });

  it('scheduled work → team channel (top level); named destination → looked up', async () => {
    expect(await resolveAgentSlackDestination('atlas', deps({ poolItems: async () => [wi({ triggerId: 't' })] }))).toEqual({ slackChannelId: 'C0TEAM1', teamId: 'team-1', topic: 'Quarterly review' });
    const named = deps({
      poolItems: async () => [wi({ metadata: { origin: buildTriggerOrigin({ triggerId: 't', destination: '#wiki', topic: 'w' }) } })],
      findChannelId: async (n) => (n === 'wiki' ? 'C0WIKI11' : null),
    });
    expect(await resolveAgentSlackDestination('atlas', named)).toEqual({ slackChannelId: 'C0WIKI11', topic: 'w' });
  });

  it('no Slack place → null', async () => {
    expect(await resolveAgentSlackDestination('atlas', deps({ teamChannelOf: async () => null }))).toBeNull();
  });
});

/**
 * 2026-10-01: the owner asked Atlas in a #morning-brief thread; Atlas
 * delegated to Sage, Sage's [DONE] made a verify item for Atlas — with no
 * origin, so the answer's file landed in an unrelated thread.
 */
describe('origin chain: request → delegate → verify / retry / subtask', () => {
  const ownerTurn: TurnOrigin = { conversationId: 'room-brief', slackChannelId: 'C0BRIEF', slackThreadKey: 'C0BRIEF:1790856242.596149', chatThreadId: 'root-1', receivedAt: NOW - 5 * 60 * 1000 };

  it('an owner turn becomes an owner origin (thread from the thread key)', () => {
    expect(ownerOriginFromTurn(ownerTurn)).toEqual({ kind: 'owner', conversationId: 'room-brief', slackChannelId: 'C0BRIEF', threadTs: '1790856242.596149', chatThreadId: 'root-1' });
  });

  it('a delegate made while answering the owner inherits the owner origin', () => {
    const creatorDestination = planWorkDestination({ workItem: null, ownerOrigin: ownerTurn, now: NOW });
    const delegate = wi({ id: 'del', target: 'sage', metadata: { delegatedBy: 'atlas' } });
    expect(inheritedOrigin({ workItem: delegate, parent: null, creatorDestination, creatorWorkItem: null })).toEqual(
      expect.objectContaining({ kind: 'owner', slackChannelId: 'C0BRIEF', threadTs: '1790856242.596149' }),
    );
  });

  it('the verify item inherits from the delegate, and its destination is the owner thread', () => {
    const origin = ownerOriginFromTurn(ownerTurn);
    const source = wi({ id: 'del', target: 'sage', metadata: { origin, projectTicket: { projectPath: '/p', id: 'CREW-38' } } });
    const verify = wi({ id: 'del:verify:del', type: 'review', target: 'atlas', parentWorkItemId: 'del', metadata: { verifyOf: 'del' } });
    const inherited = inheritedOrigin({ workItem: verify, parent: source, creatorDestination: null, creatorWorkItem: null });
    expect(inherited).toEqual(origin);

    const stamped = wi({ ...verify, metadata: { ...verify.metadata, origin: inherited } });
    const dest = planWorkDestination({ workItem: stamped, ownerOrigin: owner(NOW - 3 * HOUR), now: NOW });
    expect(dest).toEqual(expect.objectContaining({ kind: 'owner-origin' }));
    expect(dest.kind === 'owner-origin' && dest.origin).toEqual(expect.objectContaining({ conversationId: 'room-brief', slackThreadKey: 'C0BRIEF:1790856242.596149', chatThreadId: 'root-1' }));
  });

  it('a subtask inherits the creator\'s current work item origin (ticket / trigger)', () => {
    const creatorWorkItem = wi({ id: 'tl-work', metadata: { projectTicket: { projectPath: '/p', id: 'CE-9' } } });
    const creatorDestination = planWorkDestination({ workItem: creatorWorkItem, now: NOW });
    expect(inheritedOrigin({ workItem: wi({ id: 'sub' }), parent: null, creatorDestination, creatorWorkItem })).toEqual(
      expect.objectContaining({ kind: 'ticket', ticketId: 'CE-9' }),
    );
  });

  it('an origin already stamped is kept; nothing to inherit → null', () => {
    const stamped = wi({ metadata: { origin: buildTriggerOrigin({ triggerId: 't', topic: 'x' }) } });
    expect(inheritedOrigin({ workItem: stamped, parent: wi({ id: 'p', triggerId: 'other' }), creatorDestination: null, creatorWorkItem: null })).toBeNull();
    expect(inheritedOrigin({ workItem: wi({}), parent: null, creatorDestination: { kind: 'new-top-level', reason: 'no work' }, creatorWorkItem: null })).toBeNull();
  });

  it('stamps who received the owner request (receivedBy) from the creator', () => {
    const creatorDestination = planWorkDestination({ workItem: null, ownerOrigin: ownerTurn, now: NOW });
    const got = inheritedOrigin({ workItem: wi({ id: 'del' }), parent: null, creatorDestination, creatorWorkItem: null, creatorSession: 'atlas' });
    expect(got).toEqual(expect.objectContaining({ kind: 'owner', receivedBy: 'atlas' }));
  });

  it('a sub-delegation from owner-asked work keeps the original receiver, not the sub-delegator', () => {
    const origin = { ...ownerOriginFromTurn(ownerTurn, 'ella') };
    const creatorWorkItem = wi({ id: 'atlas-work', target: 'atlas', metadata: { origin } });
    const creatorDestination = planWorkDestination({ workItem: creatorWorkItem, now: NOW });
    const got = inheritedOrigin({ workItem: wi({ id: 'sage-work' }), parent: null, creatorDestination, creatorWorkItem, creatorSession: 'atlas', now: NOW });
    expect(got).toEqual(origin);
  });

  it('an app-comment / hand-over context counts as the creator\'s owner request; the newer of turn and context wins', () => {
    const appOrigin = { kind: 'owner' as const, receivedBy: 'lyra', appComment: { appId: 'app1', commentId: 'c1' } };
    const ctx = { origin: appOrigin, at: NOW - 60_000 };
    // No chat turn at all (the 2026-10-07 case).
    expect(inheritedOrigin({ workItem: wi({ id: 'n1' }), parent: null, creatorDestination: null, creatorWorkItem: null, creatorOwnerContext: ctx })).toEqual(appOrigin);
    // An older chat turn loses to the newer context…
    const olderTurn = planWorkDestination({ workItem: null, ownerOrigin: { ...ownerTurn, receivedAt: NOW - 10 * 60_000 }, now: NOW });
    expect(inheritedOrigin({ workItem: wi({ id: 'n2' }), parent: null, creatorDestination: olderTurn, creatorWorkItem: null, creatorOwnerContext: ctx, creatorSession: 'ella' })).toEqual(appOrigin);
    // …a newer chat turn wins over it.
    const newerTurn = planWorkDestination({ workItem: null, ownerOrigin: { ...ownerTurn, receivedAt: NOW - 1000 }, now: NOW });
    expect(inheritedOrigin({ workItem: wi({ id: 'n3' }), parent: null, creatorDestination: newerTurn, creatorWorkItem: null, creatorOwnerContext: ctx, creatorSession: 'ella' })).toEqual(
      expect.objectContaining({ slackChannelId: 'C0BRIEF', receivedBy: 'ella' }),
    );
    // A context older than the creator's current work item is not its current request.
    const current = wi({ id: 'cur', startedAt: new Date(NOW - 30_000).toISOString(), metadata: { projectTicket: { projectPath: '/p', id: 'CE-1' } } });
    expect(inheritedOrigin({ workItem: wi({ id: 'n4' }), parent: null, creatorDestination: planWorkDestination({ workItem: current, now: NOW }), creatorWorkItem: current, creatorOwnerContext: ctx })).toEqual(
      expect.objectContaining({ kind: 'ticket', ticketId: 'CE-1' }),
    );
  });
});

describe('owner-thread hand-over (crewly#1083)', () => {
  const ownerOrigin = { kind: 'owner', conversationId: 'room-x', slackChannelId: 'C0THINK', threadTs: '1790000000.000100' };

  it('ownerOriginFromThreadKey reads a key or a tag', () => {
    expect(ownerOriginFromThreadKey('C0THINK:1790000000.000100', 'room-x')).toEqual(ownerOrigin);
    expect(ownerOriginFromThreadKey('[SLACK-THREAD:D0DM:1790000000.000200]')).toEqual({ kind: 'owner', slackChannelId: 'D0DM', threadTs: '1790000000.000200' });
    expect(ownerOriginFromThreadKey('not a key')).toBeNull();
  });

  it('isDelegatedInThread: live work from that thread lets the member post there', () => {
    const live = wi({ target: 'tt-sage', status: 'queued', metadata: { origin: ownerOrigin } });
    expect(isDelegatedInThread([live], 'tt-sage', 'C0THINK', '1790000000.000100', NOW)).toBe(true);
    expect(isDelegatedInThread([live], 'tt-kai', 'C0THINK', '1790000000.000100', NOW)).toBe(false);
    expect(isDelegatedInThread([live], 'tt-sage', 'C0THINK', '1790000000.999999', NOW)).toBe(false);
  });

  it('isDelegatedInThread: done work keeps the thread open for a grace period only', () => {
    const done = (ago: number) => wi({ target: 'tt-sage', status: 'done', completedAt: new Date(NOW - ago).toISOString(), metadata: { origin: ownerOrigin } });
    expect(isDelegatedInThread([done(10 * 60 * 1000)], 'tt-sage', 'C0THINK', '1790000000.000100', NOW)).toBe(true);
    // Verified by the lead 45 min ago (crewly#1496, Sage): still the agent's thread.
    const verified = wi({ target: 'tt-sage', status: 'verified', completedAt: new Date(NOW - 45 * 60 * 1000).toISOString(), metadata: { origin: ownerOrigin } });
    expect(isDelegatedInThread([verified], 'tt-sage', 'C0THINK', '1790000000.000100', NOW)).toBe(true);
    expect(isDelegatedInThread([done(2 * HOUR)], 'tt-sage', 'C0THINK', '1790000000.000100', NOW)).toBe(false);
    const failed = wi({ target: 'tt-sage', status: 'failed', metadata: { origin: ownerOrigin } });
    expect(isDelegatedInThread([failed], 'tt-sage', 'C0THINK', '1790000000.000100', NOW)).toBe(false);
  });

  it('ownerThreadHandover tells the member to answer in the thread', () => {
    const item = wi({ id: 'wi-42', target: 'tt-sage', metadata: { origin: ownerOrigin } });
    const h = ownerThreadHandover(item, 'Atlas');
    expect(h?.key).toBe('C0THINK:1790000000.000100');
    expect(h?.note).toContain('[SLACK-THREAD:C0THINK:1790000000.000100]');
    expect(h?.note).toContain('reply --work-item wi-42');
    expect(h?.note).toContain('Atlas does not relay it for you.');
  });

  it('ownerThreadHandover: nothing for non-owner work, no Slack thread, or self-targeted work', () => {
    expect(ownerThreadHandover(wi({ metadata: { origin: { kind: 'owner', conversationId: 'chat-1' } } }), 'Atlas')).toBeNull();
    expect(ownerThreadHandover(wi({ metadata: {} }), 'Atlas')).toBeNull();
    expect(ownerThreadHandover(wi({ target: 'Atlas', metadata: { origin: ownerOrigin } }), 'Atlas')).toBeNull();
  });
});

describe('agent-initiated delegations (crewly#1357)', () => {
  const ownerTurn: TurnOrigin = { conversationId: 'room-video', slackChannelId: 'C0VIDEO', slackThreadKey: 'C0VIDEO:1792000000.000100', receivedAt: NOW - 60_000 };

  it('an agent origin is a valid origin; its destination is that agent', () => {
    const origin = buildAgentOrigin('ella');
    expect(origin).toEqual({ kind: 'agent', sessionName: 'ella' });
    expect(isWorkItemOrigin(origin)).toBe(true);
    expect(isWorkItemOrigin({ kind: 'agent' })).toBe(false);
    expect(isWorkItemOrigin({ kind: 'agent', sessionName: '' })).toBe(false);
    const item = wi({ id: 'x-prep', target: 'lyra', metadata: { origin } });
    expect(originOfWorkItem(item)).toEqual(origin);
    // Even a fresh owner turn of the member does not redirect the result to the owner once the item is its current work.
    const dest = planWorkDestination({ workItem: item, ownerOrigin: owner(NOW - 3 * HOUR), now: NOW });
    // The destination names the work item, so the result relay is about this one,
    // not the delegate's newest item (message-routing audit 2026-10-18).
    expect(dest).toEqual({ kind: 'agent', sessionName: 'ella', workItemId: 'x-prep', reason: expect.stringContaining('delegated by ella on its own initiative') });
  });

  it('a delegation made while answering the owner does NOT inherit that thread: the origin is the delegator (incident 15:47Z)', () => {
    const creatorDestination = planWorkDestination({ workItem: null, ownerOrigin: ownerTurn, now: NOW });
    const delegate = wi({ id: 'cards', target: 'lyra', metadata: { delegatedBy: 'ella' } });
    expect(inheritedOrigin({ workItem: delegate, parent: null, creatorDestination, creatorWorkItem: null, creatorSession: 'ella', delegation: true, now: NOW })).toEqual(buildAgentOrigin('ella'));
  });

  it('a delegation does not inherit the delegator\'s owner context nor its running work\'s owner origin (incident 12:54Z)', () => {
    const stale = { ...ownerOriginFromTurn({ conversationId: 'slack-D0AC7NF5N7L-1791472064', slackChannelId: 'D0AC7NF5N7L', receivedAt: NOW - 9 * 24 * HOUR }, 'ella') };
    const running = wi({ id: 'ella-standing', target: 'ella', startedAt: new Date(NOW - 9 * 24 * HOUR).toISOString(), metadata: { origin: stale } });
    const ctx = { origin: { kind: 'owner' as const, receivedBy: 'lyra', appComment: { appId: 'app1', commentId: 'c1' } }, at: NOW - 1000 };
    const got = inheritedOrigin({
      workItem: wi({ id: 'x-prep', target: 'lyra' }),
      parent: null,
      creatorDestination: planWorkDestination({ workItem: running, now: NOW }),
      creatorWorkItem: running,
      creatorOwnerContext: ctx,
      creatorSession: 'ella',
      delegation: true,
      now: NOW,
    });
    expect(got).toEqual(buildAgentOrigin('ella'));
  });

  it('a delegation that continues a parent (verify / retry) still takes the parent\'s origin', () => {
    const parentOrigin = ownerOriginFromTurn(ownerTurn, 'ella');
    const parent = wi({ id: 'p', target: 'lyra', metadata: { origin: parentOrigin } });
    expect(inheritedOrigin({ workItem: wi({ id: 'p:retry', target: 'kai' }), parent, creatorDestination: null, creatorWorkItem: null, creatorSession: 'ella', delegation: true, now: NOW })).toEqual(parentOrigin);
  });

  it('a delegation with no known delegator inherits nothing', () => {
    expect(inheritedOrigin({ workItem: wi({ id: 'n' }), parent: null, creatorDestination: null, creatorWorkItem: null, delegation: true, now: NOW })).toBeNull();
  });

  it('self-created work still inherits the creator\'s fresh owner turn, but never an owner origin older than ORIGIN_INHERIT_MAX_AGE_MS from its running work', () => {
    const creatorDestination = planWorkDestination({ workItem: null, ownerOrigin: ownerTurn, now: NOW });
    expect(inheritedOrigin({ workItem: wi({ id: 'self', target: 'ella' }), parent: null, creatorDestination, creatorWorkItem: null, creatorSession: 'ella', now: NOW })).toEqual(
      expect.objectContaining({ kind: 'owner', slackChannelId: 'C0VIDEO', receivedBy: 'ella' }),
    );
    const old = ownerOriginFromTurn({ conversationId: 'dm-old', slackChannelId: 'D0OLD', receivedAt: NOW - 3 * HOUR }, 'ella');
    const running = wi({ id: 'ella-old', target: 'ella', startedAt: new Date(NOW - WORK_ITEM_DESTINATION_CONSTANTS.ORIGIN_INHERIT_MAX_AGE_MS - 60_000).toISOString(), metadata: { origin: old } });
    expect(inheritedOrigin({ workItem: wi({ id: 'sub', target: 'ella' }), parent: null, creatorDestination: planWorkDestination({ workItem: running, now: NOW }), creatorWorkItem: running, creatorSession: 'ella', now: NOW })).toBeNull();
    const recent = wi({ ...running, startedAt: new Date(NOW - HOUR).toISOString() });
    expect(inheritedOrigin({ workItem: wi({ id: 'sub2', target: 'ella' }), parent: null, creatorDestination: planWorkDestination({ workItem: recent, now: NOW }), creatorWorkItem: recent, creatorSession: 'ella', now: NOW })).toEqual(old);
  });

  it('isOwnerRequestTooOld: older than the cap is too old; unknown is not', () => {
    expect(isOwnerRequestTooOld(NOW - WORK_ITEM_DESTINATION_CONSTANTS.ORIGIN_INHERIT_MAX_AGE_MS - 1, NOW)).toBe(true);
    expect(isOwnerRequestTooOld(NOW - HOUR, NOW)).toBe(false);
    expect(isOwnerRequestTooOld(null, NOW)).toBe(false);
    expect(isOwnerRequestTooOld(undefined, NOW)).toBe(false);
  });

  it('ownerOriginFromConversation reads a conversation id (optionally with its thread root)', () => {
    expect(ownerOriginFromConversation(' room-video ')).toEqual({ kind: 'owner', conversationId: 'room-video' });
    expect(ownerOriginFromConversation('room-video', 'root-7')).toEqual({ kind: 'owner', conversationId: 'room-video', chatThreadId: 'root-7' });
    expect(ownerOriginFromConversation('')).toBeNull();
    expect(ownerOriginFromConversation('two words')).toBeNull();
    expect(ownerOriginFromConversation(42)).toBeNull();
  });

  it('delegatorResultNote tells the member the result goes to the delegator, not the owner', () => {
    const item = wi({ id: 'wi-9', target: 'lyra', metadata: { origin: buildAgentOrigin('ella-session') } });
    const note = delegatorResultNote(item, 'Ella');
    expect(note?.to).toBe('ella-session');
    expect(note?.note).toContain('Ella delegated this on their own initiative');
    expect(note?.note).toContain('reply --work-item wi-9');
    expect(note?.note).toContain('Do not post it to the owner.');
    expect(delegatorResultNote(wi({ metadata: { origin: { kind: 'owner', conversationId: 'c' } } }), 'Ella')).toBeNull();
    expect(delegatorResultNote(wi({ metadata: {} }))).toBeNull();
  });

  it('delivering to an agent destination messages the delegator with the tagged result; no Slack place is involved', async () => {
    const messageAgent = jest.fn(async (_to: string, _text: string) => true);
    const item = wi({ id: 'wi-9', target: 'lyra', title: 'Refresh today\'s X reply prep', metadata: { origin: buildAgentOrigin('ella') } });
    const deps = {
      poolItems: async () => [item],
      ownerOrigin: () => undefined,
      now: () => NOW,
      teamChannelOf: async () => ({ slackChannelId: 'C0TEAM1', teamId: 'team-1' }),
      ticketThreads: () => null,
      ticketInfo: async () => null,
      post: jest.fn(async () => ({ channelId: 'C0TEAM1', messageTs: '1.1' })),
      messageAgent,
    } as unknown as WorkDestinationDeps;
    const dest = planWorkDestination({ workItem: item, now: NOW });
    const delivered = await deliverToWorkDestination('lyra', dest, 'Done: 12 replies drafted.', deps);
    expect(delivered).toEqual({ kind: 'agent', agentSession: 'ella', reason: expect.any(String) });
    expect(messageAgent).toHaveBeenCalledWith('ella', agentResultText('lyra', 'Done: 12 replies drafted.', item));
    expect(messageAgent.mock.calls[0][1]).toContain(`${WORK_ITEM_DESTINATION_CONSTANTS.AGENT_RESULT_TAG} From lyra about WorkItem wi-9`);
    expect(messageAgent.mock.calls[0][1]).toContain('decide yourself what, if anything, the owner hears');
    expect((deps.post as jest.Mock)).not.toHaveBeenCalled();
    expect(await resolveAgentSlackDestination('lyra', deps)).toBeNull();
    // No messenger wired → nowhere to deliver (the reply reports it).
    expect(await deliverToWorkDestination('lyra', dest, 'x', { ...deps, messageAgent: undefined })).toBeNull();
    // The messenger refusing → the same.
    expect(await deliverToWorkDestination('lyra', dest, 'x', { ...deps, messageAgent: async () => false })).toBeNull();
  });
});

describe('lead-reported team work (crewly#1371)', () => {
  const ownerOrigin = { kind: 'owner', receivedBy: 'orchestrator', slackChannelId: 'D0ORC', threadTs: '1792000000.000100' };
  const stamp = { lead: 'ella', worker: 'luna', teamId: 'team-mkt', teamName: 'Marketing', slackChannelId: 'C0MKTTEAM', channelName: 'marketing' };

  it('isLeadReport / leadReportOf read only a complete stamp', () => {
    expect(isLeadReport(stamp)).toBe(true);
    expect(isLeadReport({ ...stamp, slackChannelId: '' })).toBe(false);
    expect(isLeadReport(null)).toBe(false);
    expect(leadReportOf(wi({ metadata: { leadReport: stamp } }))).toEqual(stamp);
    expect(leadReportOf(wi({ metadata: { leadReport: { lead: 'ella' } } }))).toBeNull();
    expect(leadReportOf(null)).toBeNull();
  });

  it('reply --work-item on stamped owner work → a new top-level post in the team channel, not the owner thread', () => {
    const item = wi({ target: 'ella', metadata: { origin: ownerOrigin, leadReport: stamp } });
    const d = planWorkDestination({ workItem: item, now: NOW });
    expect(d).toEqual(expect.objectContaining({ kind: 'new-top-level', teamId: 'team-mkt' }));
    expect((d as { topic?: string }).topic).toBeUndefined();
    // Unstamped owner work keeps the owner thread.
    expect(planWorkDestination({ workItem: wi({ metadata: { origin: ownerOrigin } }), now: NOW }).kind).not.toBe('new-top-level');
  });

  it('no owner-thread hand-over for stamped work', () => {
    expect(ownerThreadHandover(wi({ target: 'luna', metadata: { origin: ownerOrigin, leadReport: stamp } }), 'Orc')).toBeNull();
    expect(ownerThreadHandover(wi({ target: 'luna', metadata: { origin: ownerOrigin } }), 'Orc')).not.toBeNull();
  });
});
