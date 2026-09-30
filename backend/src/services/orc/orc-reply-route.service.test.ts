/**
 * Tests for OrcReplyRouteService — the orchestrator answers where it was asked.
 *
 * The incident block replays 2026-09-26 03:23–03:34 UTC with the real ids and
 * delivered-message shapes taken from service.log / the crewly-orc session log.
 */

import { ORC_REPLY_ROUTE_CONSTANTS } from '../../constants.js';
import {
  OrcReplyRouteService,
  isSlackDm,
  parseInboundOrigin,
} from './orc-reply-route.service.js';

const ORC = 'crewly-orc';
const ORC_DM = 'a721f48d-e161-4dd4-88cb-ad7487d3313a'; // chat-v2 channel of Slack DM D0C381XPD3L
const SLACK_ORC_BOT_DM = 'D0C381XPD3L';
const MASTER_BOT_DM = 'D0AC7NF5N7L';
const THINK_TANK = 'b79a6e4d-3405-40ca-8da5-fd1df3c96dc4';

/** A user message as the chat-v2 dispatcher delivers it (Slack DM → orc). */
const DM_DELIVERY = `[CHAT:${ORC_DM}] <UG94JLNGK@Orchestrator>\n\nA chatgpt账号\n\n---\n回复本频道: 用 \`reply-chat\` skill, 参数 conversationId="${ORC_DM}"`;
/** The reconciler's WorkItem redispatch — a system turn, no [CHAT:] header. */
const DISPATCH_DELIVERY =
  '[CREWLY-DISPATCH] 3 WorkItems are still queued for you — this one message covers all of them; work through them in this turn.\n  1. 8249a788-1ea7-4687';

const T0 = Date.parse('2026-09-26T03:27:45.815Z');
const at = (iso: string): number => Date.parse(`2026-09-26T${iso}Z`);

describe('parseInboundOrigin', () => {
  it('reads the chat-v2 dispatcher header', () => {
    expect(parseInboundOrigin(DM_DELIVERY)).toEqual({ conversationId: ORC_DM });
  });

  it('strips the message-queue fingerprint and reads the Slack marker', () => {
    const queued = '[CHAT:slack-D0AC7NF5N7L-1790395312-519939:58036d6e] hello [SLACK:D0AC7NF5N7L:1790395312.519939]';
    expect(parseInboundOrigin(queued)).toEqual({
      conversationId: 'slack-D0AC7NF5N7L-1790395312-519939',
      slackChannelId: 'D0AC7NF5N7L',
      slackThreadTs: '1790395312.519939',
    });
  });

  it('reads a Google Chat header', () => {
    expect(parseInboundOrigin('[GCHAT:gchat-x:abcd1234 thread=t1] hi')?.conversationId).toBe('gchat-x');
  });

  it('returns null for system deliveries', () => {
    expect(parseInboundOrigin(DISPATCH_DELIVERY)).toBeNull();
    expect(parseInboundOrigin('\n[SYSTEM]\nscheduled check\n[/SYSTEM]\n')).toBeNull();
    // A [CHAT:] quoted mid-message is not a header.
    expect(parseInboundOrigin('see [CHAT:abc] above')).toBeNull();
  });
});

describe('isSlackDm', () => {
  it('distinguishes DMs from channels', () => {
    expect(isSlackDm('D0C381XPD3L')).toBe(true);
    expect(isSlackDm('C0C30RWA17W')).toBe(false);
    expect(isSlackDm('G123')).toBe(false);
  });
});

describe('OrcReplyRouteService', () => {
  let svc: OrcReplyRouteService;

  beforeEach(() => {
    OrcReplyRouteService.resetInstance();
    svc = OrcReplyRouteService.getInstance();
  });

  describe('incident replay (2026-09-26)', () => {
    beforeEach(() => {
      // 03:27:45 the owner's Slack DM reaches the orc.
      svc.noteDelivery(ORC, DM_DELIVERY, T0);
      // 03:32:30 the reconciler redispatches WorkItems — a system turn.
      expect(svc.noteDelivery(ORC, DISPATCH_DELIVERY, at('03:32:30.428'))).toBeNull();
    });

    it('the system turn keeps the DM as its origin', () => {
      expect(svc.getFreshOrigin(ORC, at('03:32:59.330'))?.conversationId).toBe(ORC_DM);
    });

    it('03:32:59 report-status with no conversation → the DM, not "current conversation"', () => {
      const d = svc.resolveConversationReply(ORC, undefined, { now: at('03:32:59.330') });
      expect(d.action).toBe('defaulted-to-origin');
      expect(d.conversationId).toBe(ORC_DM);
    });

    it('03:33:48 reply-chat naming #think-tank → re-routed to the DM', () => {
      const d = svc.resolveConversationReply(ORC, THINK_TANK, { now: at('03:33:48.065') });
      expect(d.action).toBe('rerouted-to-origin');
      expect(d.conversationId).toBe(ORC_DM);
    });

    it('03:33:30 reply-slack to the master-bot DM → re-routed into the DM conversation', () => {
      const { plan, decision } = svc.planSlackReply(
        ORC,
        { channelId: MASTER_BOT_DM },
        (conv) => (conv === ORC_DM ? SLACK_ORC_BOT_DM : undefined),
        at('03:33:30.918'),
      );
      expect(decision.action).toBe('rerouted-to-origin');
      expect(plan).toEqual({ kind: 'conversation', conversationId: ORC_DM });
    });

    it('reply-slack to the DM the owner is in is sent as asked', () => {
      const { plan, decision } = svc.planSlackReply(
        ORC,
        { channelId: SLACK_ORC_BOT_DM, threadTs: '1790392986.498639' },
        () => SLACK_ORC_BOT_DM,
        at('03:33:30.918'),
      );
      expect(decision.action).toBe('as-requested');
      expect(plan).toEqual({ kind: 'slack', channelId: SLACK_ORC_BOT_DM, threadTs: '1790392986.498639' });
    });
  });

  describe('legitimate cross-posting keeps working', () => {
    beforeEach(() => svc.noteDelivery(ORC, DM_DELIVERY, T0));

    it('an explicit cross-post is kept', () => {
      const d = svc.resolveConversationReply(ORC, THINK_TANK, { crossPost: true, now: T0 + 1000 });
      expect(d.action).toBe('as-requested');
      expect(d.conversationId).toBe(THINK_TANK);
    });

    it('a conversation a user wrote to the orc from recently is kept', () => {
      svc.noteDelivery(ORC, `[CHAT:${THINK_TANK}] <UG94JLNGK@#think-tank>\n\n@orc post the plan here`, T0 + 1000);
      // Latest user message is back in the DM…
      svc.noteDelivery(ORC, DM_DELIVERY, T0 + 2000);
      // …but #think-tank was written from 1s before, so posting there is fine.
      const d = svc.resolveConversationReply(ORC, THINK_TANK, { now: T0 + 3000 });
      expect(d.action).toBe('as-requested');
      expect(d.reason).toMatch(/recently/);
    });

    it('Slack channel posts (team notifications, delegation) are never re-routed', () => {
      const { plan, decision } = svc.planSlackReply(ORC, { channelId: 'C0C30RWA17W', threadTs: '1.2' }, () => undefined, T0 + 1000);
      expect(decision.action).toBe('as-requested');
      expect(plan).toEqual({ kind: 'slack', channelId: 'C0C30RWA17W', threadTs: '1.2' });
    });

    it('a Slack DM post with --cross-post is kept', () => {
      const { decision } = svc.planSlackReply(ORC, { channelId: MASTER_BOT_DM, crossPost: true }, () => SLACK_ORC_BOT_DM, T0 + 1000);
      expect(decision.action).toBe('as-requested');
    });
  });

  describe('freshness', () => {
    beforeEach(() => svc.noteDelivery(ORC, DM_DELIVERY, T0));

    it('does not re-route once the origin is older than the TTL', () => {
      const late = T0 + ORC_REPLY_ROUTE_CONSTANTS.ORIGIN_TTL_MS + 1;
      expect(svc.resolveConversationReply(ORC, THINK_TANK, { now: late }).action).toBe('as-requested');
      expect(svc.planSlackReply(ORC, { channelId: MASTER_BOT_DM }, () => SLACK_ORC_BOT_DM, late).decision.action).toBe('as-requested');
    });

    it('an unnamed conversation still defaults to the last origin after the TTL', () => {
      const late = T0 + ORC_REPLY_ROUTE_CONSTANTS.ORIGIN_TTL_MS * 10;
      expect(svc.resolveConversationReply(ORC, undefined, { now: late }).conversationId).toBe(ORC_DM);
    });
  });

  it('with no origin at all, an unnamed reply keeps the caller fallback', () => {
    const d = svc.resolveConversationReply(ORC, undefined);
    expect(d.action).toBe('no-origin');
    expect(d.conversationId).toBeUndefined();
    expect(svc.resolveConversationReply(ORC, THINK_TANK).action).toBe('as-requested');
  });

  it('a queue-delivered Slack thread origin re-routes a stray DM post to that thread', () => {
    svc.noteDelivery(ORC, '[CHAT:slack-D0AC7NF5N7L-1-2:abcd1234] hi [SLACK:D0AC7NF5N7L:1790395312.519939]', T0);
    const { plan } = svc.planSlackReply(ORC, { channelId: 'D0OTHER' }, () => undefined, T0 + 1000);
    expect(plan).toEqual({ kind: 'slack', channelId: 'D0AC7NF5N7L', threadTs: '1790395312.519939' });
  });

  it('tracks sessions independently', () => {
    svc.noteDelivery('agent-a', '[CHAT:conv-a] <u@a>\n\nhi', T0);
    expect(svc.getLastOrigin(ORC)).toBeUndefined();
    expect(svc.getLastOrigin('agent-a')?.conversationId).toBe('conv-a');
  });

  it('bounds the remembered conversations', () => {
    const max = ORC_REPLY_ROUTE_CONSTANTS.MAX_TRACKED_CONVERSATIONS;
    for (let i = 0; i <= max; i++) svc.noteDelivery(ORC, `[CHAT:conv-${i}] <u@x>\n\nhi`, T0 + i);
    // conv-0 fell out of the recent set, so naming it re-routes to the origin.
    expect(svc.resolveConversationReply(ORC, 'conv-0', { now: T0 + max + 1 }).action).toBe('rerouted-to-origin');
    expect(svc.resolveConversationReply(ORC, 'conv-1', { now: T0 + max + 1 }).action).toBe('as-requested');
  });
});

describe('turn origin carries the thread the answer belongs in (owner-message guarantee §B)', () => {
  beforeEach(() => OrcReplyRouteService.resetInstance());

  it('parses the [SLACK-THREAD:<key>] tag every Slack delivery carries', () => {
    const origin = parseInboundOrigin('[CHAT:dm-ella] <steve@Ella>\n[SLACK-THREAD:D0DM:1790000000.000100]\n\nhi');
    expect(origin).toEqual({ conversationId: 'dm-ella', slackThreadKey: 'D0DM:1790000000.000100' });
  });

  it('records the chat thread the dispatcher reports — now, or for a delivery still queued', () => {
    const svc = OrcReplyRouteService.getInstance();
    svc.noteDelivery('ella', '[CHAT:room-1] <steve@room>\n\nq1');
    svc.noteOriginThread('ella', 'room-1', 'root-1');
    expect(svc.getLastOrigin('ella')?.chatThreadId).toBe('root-1');

    // A hint for another conversation arrives before its (queued) delivery.
    svc.noteOriginThread('ella', 'room-2', 'root-2');
    expect(svc.getLastOrigin('ella')?.conversationId).toBe('room-1');
    svc.noteDelivery('ella', '[CHAT:room-2] <steve@room>\n\nq2');
    expect(svc.getLastOrigin('ella')).toEqual(expect.objectContaining({ conversationId: 'room-2', chatThreadId: 'root-2' }));

    // A DM delivery has no thread.
    svc.noteDelivery('ella', '[CHAT:dm-ella] <steve@Ella>\n\nq3');
    svc.noteOriginThread('ella', 'dm-ella', undefined);
    expect(svc.getLastOrigin('ella')?.chatThreadId).toBeUndefined();
  });
});
