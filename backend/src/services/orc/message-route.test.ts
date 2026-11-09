import {
  comparePostPlace,
  describeRoute,
  formatRouteToken,
  isMessageRoute,
  parseRouteToken,
  placeOfOwnerRoute,
  replyCommandFor,
  routeOfTrigger,
  sameRoute,
  type MessageRoute,
} from './message-route.js';
import type { TurnTrigger } from '../trace/turn-trigger.js';

const OWNER: MessageRoute = { kind: 'owner', conversationId: 'room-1', thread: 'C0ROOM001:1790000000.000100' };
const WORK: MessageRoute = { kind: 'work-item', workItemId: 'wi-123456' };

function trig(over: Partial<TurnTrigger>): TurnTrigger {
  return { triggerKind: 'system', rootKind: 'system', viaAgents: [], at: 0, ...over } as TurnTrigger;
}

describe('message-route token', () => {
  it('formats and parses an owner route with a thread', () => {
    const token = formatRouteToken(OWNER);
    expect(token).toBe('{route: owner room-1 thread C0ROOM001:1790000000.000100}');
    expect(parseRouteToken(`[MESSAGE from Atlas … ${token}]\nhello`)).toEqual(OWNER);
  });

  it('formats and parses an owner route without a thread', () => {
    const r: MessageRoute = { kind: 'owner', conversationId: 'dm-ella' };
    expect(parseRouteToken(formatRouteToken(r))).toEqual(r);
  });

  it('formats and parses a work-item route', () => {
    expect(formatRouteToken(WORK)).toBe('{route: work-item wi-123456}');
    expect(parseRouteToken('x {route: work-item wi-123456} y')).toEqual(WORK);
  });

  it('no token → null; non-string input → null', () => {
    expect(parseRouteToken('plain text')).toBeNull();
    expect(parseRouteToken(undefined as unknown as string)).toBeNull();
  });

  it('isMessageRoute rejects malformed shapes', () => {
    expect(isMessageRoute(OWNER)).toBe(true);
    expect(isMessageRoute(WORK)).toBe(true);
    expect(isMessageRoute({ kind: 'owner' })).toBe(false);
    expect(isMessageRoute({ kind: 'owner', conversationId: 'a b' })).toBe(false);
    expect(isMessageRoute({ kind: 'work-item', workItemId: 'x}' })).toBe(false);
    expect(isMessageRoute({ kind: 'agent', sessionName: 'x' })).toBe(false);
    expect(isMessageRoute(null)).toBe(false);
  });

  it('replyCommandFor and describeRoute name the explicit place', () => {
    expect(replyCommandFor(OWNER)).toBe('reply --conversation room-1 --thread C0ROOM001:1790000000.000100 "<message>"');
    expect(replyCommandFor(WORK)).toBe('reply --work-item wi-123456 "<message>"');
    expect(describeRoute(OWNER)).toContain("owner's thread C0ROOM001:1790000000.000100");
    expect(describeRoute(WORK)).toBe('work item wi-123456');
  });

  it('sameRoute compares kind, ids and thread', () => {
    expect(sameRoute(OWNER, { ...OWNER })).toBe(true);
    expect(sameRoute(OWNER, { kind: 'owner', conversationId: 'room-1' })).toBe(false);
    expect(sameRoute(WORK, OWNER)).toBe(false);
    expect(sameRoute(null, OWNER)).toBe(false);
  });
});

describe('comparePostPlace', () => {
  it('Slack thread on both sides decides', () => {
    expect(comparePostPlace(placeOfOwnerRoute(OWNER as Extract<MessageRoute, { kind: 'owner' }>), { slackChannelId: 'C0ROOM001', threadTs: '1790000000.000100' })).toBe('match');
    expect(comparePostPlace(placeOfOwnerRoute(OWNER as Extract<MessageRoute, { kind: 'owner' }>), { slackChannelId: 'C0ROOM001', threadTs: '1790000999.000100' })).toBe('mismatch');
    expect(comparePostPlace(placeOfOwnerRoute(OWNER as Extract<MessageRoute, { kind: 'owner' }>), { slackChannelId: 'C0ROOM001' })).toBe('mismatch');
  });

  it('chat conversation and thread when no Slack place is known on both', () => {
    expect(comparePostPlace({ conversationId: 'a', thread: 'root-1' }, { conversationId: 'a', thread: 'root-1' })).toBe('match');
    expect(comparePostPlace({ conversationId: 'a', thread: 'root-1' }, { conversationId: 'a', thread: 'root-2' })).toBe('mismatch');
    expect(comparePostPlace({ conversationId: 'a' }, { conversationId: 'b' })).toBe('mismatch');
    expect(comparePostPlace({ conversationId: 'a' }, { conversationId: 'a' })).toBe('match');
  });

  it('anything not known on both sides is unknown, never a mismatch', () => {
    expect(comparePostPlace(null, { conversationId: 'a' })).toBe('unknown');
    expect(comparePostPlace({ conversationId: 'a', thread: 'root-1' }, { conversationId: 'a' })).toBe('unknown');
    expect(comparePostPlace({ slackChannelId: 'C0A' }, { conversationId: 'a' })).toBe('unknown');
  });
});

describe('routeOfTrigger', () => {
  it('owner message: its conversation, with the thread the turn origin knows', () => {
    const r = routeOfTrigger(trig({ triggerKind: 'owner_message', conversationId: 'room-1' }), {
      conversationId: 'room-1',
      slackThreadKey: 'C0ROOM001:1790000000.000100',
      receivedAt: 0,
    });
    expect(r).toEqual(OWNER);
  });

  it("owner message: the trigger's own thread wins; another conversation's origin thread is not borrowed", () => {
    expect(routeOfTrigger(trig({ triggerKind: 'owner_message', conversationId: 'room-1', thread: 'C0ROOM001:1.2' }), undefined)).toEqual({
      kind: 'owner',
      conversationId: 'room-1',
      thread: 'C0ROOM001:1.2',
    });
    expect(routeOfTrigger(trig({ triggerKind: 'owner_message', conversationId: 'room-1' }), { conversationId: 'room-9', slackThreadKey: 'C0X:1.1', receivedAt: 0 })).toEqual({
      kind: 'owner',
      conversationId: 'room-1',
    });
  });

  it('agent message and delegated result: the route they carry, else none', () => {
    expect(routeOfTrigger(trig({ triggerKind: 'agent_message', route: OWNER }))).toEqual(OWNER);
    expect(routeOfTrigger(trig({ triggerKind: 'delegated_result', route: WORK }))).toEqual(WORK);
    expect(routeOfTrigger(trig({ triggerKind: 'agent_message' }))).toBeNull();
  });

  it('dispatch: the work item it hands over', () => {
    expect(routeOfTrigger(trig({ triggerKind: 'dispatch', workItemId: 'wi-123456' }))).toEqual(WORK);
    expect(routeOfTrigger(trig({ triggerKind: 'dispatch' }))).toBeNull();
  });

  it('reminders and notices name no route', () => {
    expect(routeOfTrigger(trig({ triggerKind: 'follow_up' }))).toBeNull();
    expect(routeOfTrigger(null)).toBeNull();
  });
});
