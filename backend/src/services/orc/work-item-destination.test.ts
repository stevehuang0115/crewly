import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TurnOrigin } from './orc-reply-route.service.js';
import {
  buildTriggerOrigin,
  currentWorkItemOf,
  inheritedOrigin,
  originOfWorkItem,
  ownerOriginFromTurn,
  parseDestination,
  planWorkDestination,
  shortTopic,
  withTopicLine,
} from './work-item-destination.js';
import { resolveAgentSlackDestination, type WorkDestinationDeps } from './work-item-destination.wiring.js';

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
});
