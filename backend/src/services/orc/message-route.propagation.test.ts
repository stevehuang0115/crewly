/**
 * The routing invariant end to end (message-routing audit 2026-10-18):
 * every outbound post carries the destination of the message it answers,
 * across every agent hop.
 *
 * Owner asks Atlas in a #brief thread → Atlas delegates to Sage (the item
 * carries Atlas's route as `parentRoute`) → Sage delegates on to Lyra →
 * Lyra's bare `reply` goes to Sage as a [RESULT] → Sage's bare `reply`
 * goes to Atlas as a [RESULT] carrying the owner route → Atlas's bare
 * `reply` lands in the owner's #brief thread, even though the owner wrote
 * to Atlas in another thread in between. The route check counts a match.
 */

import { MESSAGE_ROUTE_CONSTANTS, WORK_ITEM_DESTINATION_CONSTANTS } from '../../constants.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { TurnTriggerTracker } from '../trace/turn-trigger.js';
import { routeOfTrigger, type MessageRoute } from './message-route.js';
import { OrcReplyRouteService } from './orc-reply-route.service.js';
import { latestInputOf, type ReplyResolverDeps } from './reply-destination-resolver.js';
import {
  deliverReply,
  getRouteCheckStats,
  resetReplyDeliveryGuardForTesting,
  resetRouteCheckStatsForTesting,
  type ReplyDeliveryDeps,
} from './reply-destination.wiring.js';
import { AgentPromptReferenceService } from './agent-prompt-reference.service.js';
import type { WorkDestinationDeps } from './work-item-destination.wiring.js';

const ATLAS = 'think-tank-atlas-b4e166f6';
const SAGE = 'think-tank-sage-1a2b3c4d';
const LYRA = 'think-tank-lyra-5e6f7a8b';
const BRIEF_THREAD = 'C0BRIEF01:1790856242.596149';

describe('routing invariant: delegate → result → owner', () => {
  let tracker: TurnTriggerTracker;
  let items: WorkItem[];
  let inbox: Array<{ to: string; text: string }>;
  let deliver: jest.Mock;
  let clock: number;

  function wi(over: Partial<WorkItem>): WorkItem {
    return {
      type: 'delegate',
      owner: 'team_lead',
      status: 'running',
      createdAt: new Date(clock).toISOString(),
      retryCount: 0,
      maxRetries: 3,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      ...over,
    } as WorkItem;
  }

  /** What the harness does at delegation: stamp the delegator's current route. */
  function delegate(from: string, to: string, id: string, title: string): WorkItem {
    const route = routeOfTrigger(tracker.routedTrigger(from, clock), OrcReplyRouteService.getInstance().getLastOrigin(from));
    const item = wi({
      id,
      target: to,
      title,
      metadata: {
        [WORK_ITEM_DESTINATION_CONSTANTS.METADATA_KEY]: { kind: 'agent', sessionName: from },
        ...(route ? { [MESSAGE_ROUTE_CONSTANTS.PARENT_ROUTE_METADATA_KEY]: route } : {}),
      },
    });
    items.push(item);
    tracker.noteDelivery(to, `[CREWLY-DISPATCH] WorkItem ${id} "${title}"`, {}, clock);
    return item;
  }

  function resolver(): ReplyResolverDeps {
    return {
      getMessage: () => null,
      ownsConversation: async (s, c) => s === ATLAS && (c === 'room-brief' || c === 'room-video'),
      slackChannelOfConversation: (c) => (c === 'room-brief' ? 'C0BRIEF01' : c === 'room-video' ? 'C0VIDEO01' : null),
      conversationOfSlackThread: (ch) => (ch === 'C0BRIEF01' ? { conversationId: 'room-brief' } : ch === 'C0VIDEO01' ? { conversationId: 'room-video' } : null),
      requestTicket: async () => null,
      projectTicket: async () => null,
      decision: async () => null,
      workItem: async (id) => items.find((w) => w.id === id) ?? null,
      poolItems: async () => items,
      turnOrigin: (s) => OrcReplyRouteService.getInstance().getLastOrigin(s),
      latestInput: (s) => latestInputOf(tracker.routedTrigger(s, clock)),
      promptReference: () => undefined,
      owesOwner: () => false,
      lastDelivered: () => undefined,
      ownerDm: async () => null,
      now: () => clock,
    };
  }

  function deps(): ReplyDeliveryDeps {
    const wd: WorkDestinationDeps = {
      poolItems: async () => items,
      ownerOrigin: (s) => OrcReplyRouteService.getInstance().getLastOrigin(s),
      now: () => clock,
      teamChannelOf: async () => ({ slackChannelId: 'C0TEAM001', teamId: 't' }),
      ticketThreads: () => null,
      ticketInfo: async () => null,
      post: jest.fn(async () => {
        throw new Error('no Slack post expected in this chain');
      }) as unknown as WorkDestinationDeps['post'],
      messageAgent: async (to, text) => {
        inbox.push({ to, text });
        clock += 1000;
        tracker.noteDelivery(to, text, {}, clock);
        return true;
      },
    };
    return {
      resolver: resolver(),
      deliverToConversation: deliver as unknown as ReplyDeliveryDeps['deliverToConversation'],
      workDestination: async () => wd,
      routedTrigger: (s) => tracker.routedTrigger(s, clock),
    };
  }

  beforeEach(() => {
    clock = Date.now();
    tracker = new TurnTriggerTracker();
    items = [];
    inbox = [];
    deliver = jest.fn(async (i: { conversationId: string }) => `msg-${i.conversationId}`);
    OrcReplyRouteService.resetInstance();
    AgentPromptReferenceService.resetInstance();
    resetReplyDeliveryGuardForTesting();
    resetRouteCheckStatsForTesting();
  });

  it("the final consolidated answer lands in the owner's thread, carried hop by hop", async () => {
    // 1. The owner asks Atlas in the #brief thread.
    const ask = `[CHAT:room-brief] <steve@Atlas>\n[SLACK-THREAD:${BRIEF_THREAD}]\n\nhow many Starship launches this year?`;
    OrcReplyRouteService.getInstance().noteDelivery(ATLAS, ask, clock);
    tracker.noteDelivery(ATLAS, ask, {}, clock);

    // 2. Atlas delegates to Sage; the item carries the owner route.
    const del = delegate(ATLAS, SAGE, 'del-starship', 'Starship launches note');
    const ownerRoute: MessageRoute = { kind: 'owner', conversationId: 'room-brief', thread: BRIEF_THREAD };
    expect((del.metadata as Record<string, unknown>).parentRoute).toEqual(ownerRoute);

    // 3. Sage delegates on to Lyra; that item carries Sage's route (its work item).
    clock += 1000;
    const sub = delegate(SAGE, LYRA, 'sub-figures', 'Launch figures');
    expect((sub.metadata as Record<string, unknown>).parentRoute).toEqual({ kind: 'work-item', workItemId: 'del-starship' });

    // Meanwhile the owner writes to Atlas in an unrelated thread (the old
    // "newest owner turn" guess would answer there).
    clock += 1000;
    const other = '[CHAT:room-video] <steve@Atlas>\n[SLACK-THREAD:C0VIDEO01:1790883820.388009]\n\nthis blender video?';
    OrcReplyRouteService.getInstance().noteDelivery(ATLAS, other, clock - 500);

    // 4. Lyra's bare reply → a [RESULT] to Sage, about her item.
    const d = deps();
    const lyra = await deliverReply({ session: LYRA, content: '12 launches so far.' }, d);
    expect(lyra.ok).toBe(true);
    expect(inbox[0].to).toBe(SAGE);
    expect(inbox[0].text).toMatch(/^\[RESULT\] From think-tank-lyra-5e6f7a8b about WorkItem sub-figures .*\{route: work-item del-starship\}/);

    // 5. Sage's bare reply → a [RESULT] to Atlas carrying the owner route.
    const sage = await deliverReply({ session: SAGE, content: 'Note: 12 launches, 3 failures.' }, d);
    expect(sage.ok).toBe(true);
    expect(inbox[1].to).toBe(ATLAS);
    expect(inbox[1].text).toContain(`{route: owner room-brief thread ${BRIEF_THREAD}}`);
    expect(tracker.routedTrigger(ATLAS, clock)).toEqual(expect.objectContaining({ triggerKind: 'delegated_result', route: ownerRoute }));

    // 6. Atlas's bare reply lands in the owner's #brief thread, not #video.
    const atlas = await deliverReply({ session: ATLAS, content: 'Starship this year: 12 launches, 3 failures.' }, d);
    expect(atlas.ok).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'room-brief', thread: BRIEF_THREAD, agentSession: ATLAS }));

    // The route check saw the landing match the request it answers.
    expect(getRouteCheckStats().match).toBeGreaterThanOrEqual(1);
    expect(getRouteCheckStats().mismatch).toBe(0);
  });

  it('a result with no route behind it is refused, never guessed into the newest owner thread', async () => {
    const other = '[CHAT:room-video] <steve@Atlas>\n[SLACK-THREAD:C0VIDEO01:1790883820.388009]\n\nthis blender video?';
    OrcReplyRouteService.getInstance().noteDelivery(ATLAS, other, clock - 60_000);
    tracker.noteDelivery(ATLAS, `[RESULT] From ${SAGE} (work you delegated; the owner did not ask for it in a thread):\nnote ready`, {}, clock);
    const r = await deliverReply({ session: ATLAS, content: 'Here is the note.' }, deps());
    expect(r.ok).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
});
