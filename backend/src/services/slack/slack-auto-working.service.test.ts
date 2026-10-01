/**
 * Tests for SlackAutoWorkingService — the harness posting "working on it"
 * for the first recipient of an owner's Slack message that starts on it.
 *
 * Runs against the real SlackTypingPlaceholderService (fake Slack), so the
 * placeholder it posts is the same one `/api/slack/working` posts, and the
 * answer / settle-on-idle rules are exercised on it unchanged.
 */

import {
  SlackAutoWorkingService,
  deliveredSessions,
  isOwnerAuthored,
  getSlackAutoWorkingService,
  setSlackAutoWorkingService,
} from './slack-auto-working.service.js';
import { SlackTypingPlaceholderService, type TypingSlackApi } from './slack-typing-placeholder.service.js';
import { SLACK_TYPING_CONSTANTS } from '../../constants.js';
import type { DispatchMessageResult } from '../chat-v2/chat-v2.dispatcher.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    }),
  },
}));

const OWEN = 'ce-owen-ad0320ab';
const VERA = 'ce-vera-d8f94e9c';
const CHANNEL = 'C-PRO-CE';
const MSG_TS = '1790000823.000100';

function makeSlack() {
  const sent: Array<{ channelId: string; text: string; threadTs?: string; botToken?: string }> = [];
  const deleted: Array<{ channelId: string; ts: string; botToken?: string }> = [];
  const reactions: Array<{ channelId: string; ts: string; emoji: string; botToken?: string }> = [];
  let n = 0;
  const slack: TypingSlackApi = {
    isConnected: () => true,
    sendMessage: async (m) => {
      sent.push(m);
      return `ph-${++n}`;
    },
    updateMessage: async () => undefined,
    deleteMessage: async (channelId, ts, botToken) => {
      deleted.push({ channelId, ts, botToken });
    },
    addReaction: async (channelId, ts, emoji, botToken) => {
      reactions.push({ channelId, ts, emoji, botToken });
    },
  };
  return { slack, sent, deleted, reactions };
}

const identities: Record<string, { botToken: string; displayName: string }> = {
  [OWEN]: { botToken: 'xoxb-owen', displayName: 'Owen' },
  [VERA]: { botToken: 'xoxb-vera', displayName: 'Vera' },
  'mk-ella': { botToken: 'xoxb-ella', displayName: 'Ella' },
};

/** Let fire-and-forget `begin()` calls finish. */
const flush = () => new Promise((r) => setImmediate(r));

function setup(opts: { busy?: string[] } = {}) {
  const fake = makeSlack();
  const typing = new SlackTypingPlaceholderService({
    slack: fake.slack,
    setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => undefined,
    replaceByEdit: false,
  });
  let clock = 1_000_000;
  const busy = new Set(opts.busy ?? []);
  const auto = new SlackAutoWorkingService({
    typing,
    isAgentBusy: (s) => busy.has(s),
    now: () => clock,
  });
  typing.onThreadActivity((ch, th) => auto.noteThreadActivity(ch, th));
  return {
    ...fake,
    typing,
    auto,
    busy,
    advance: (ms: number) => {
      clock += ms;
    },
    working: () => fake.sent.filter((m) => m.text.includes('is working on it')),
  };
}

function channelDelivery(candidates = [OWEN, VERA]) {
  return {
    slackChannelId: CHANNEL,
    threadTs: MSG_TS,
    sourceTs: MSG_TS,
    candidates,
    identityFor: (s: string) => identities[s] ?? null,
  };
}

describe('SlackAutoWorkingService', () => {
  it('channel un-@ broadcast: the first recipient to turn busy gets exactly one placeholder, from its own bot, in the thread', async () => {
    // 2026-09-30 #pro-ce: huddle-broadcast to Owen + Vera, Owen worked 3.5 min, nothing showed.
    const t = setup();
    const w = t.auto.watch(channelDelivery());
    w.delivered([OWEN, VERA]);

    t.auto.noteBusy(OWEN);
    await flush();
    t.auto.noteBusy(OWEN);
    await flush();

    expect(t.working()).toEqual([
      expect.objectContaining({ channelId: CHANNEL, threadTs: MSG_TS, botToken: 'xoxb-owen', text: '⚙️ Owen is working on it…' }),
    ]);
    expect(t.typing.owes({ agentSession: OWEN, slackChannelId: CHANNEL, threadTs: MSG_TS })).toBe(true);
    expect(t.auto.watchCount).toBe(0);
  });

  it('DM: the agent starting on the message posts its placeholder', async () => {
    const t = setup();
    const w = t.auto.watch({
      slackChannelId: 'D-ELLA',
      threadTs: '42.1',
      sourceTs: '42.1',
      candidates: ['mk-ella'],
      identityFor: () => identities['mk-ella'],
    });
    w.delivered(['mk-ella']);
    t.auto.noteBusy('mk-ella');
    await flush();
    expect(t.working()).toEqual([expect.objectContaining({ channelId: 'D-ELLA', threadTs: '42.1', botToken: 'xoxb-ella' })]);
  });

  it('DM whose placeholder is already up at delivery: no second one', async () => {
    const t = setup();
    await t.typing.begin({ agentSession: 'mk-ella', slackChannelId: 'D-ELLA', threadTs: '42.1' }, identities['mk-ella'], 'typing', '42.1');
    const w = t.auto.watch({
      slackChannelId: 'D-ELLA',
      threadTs: '42.1',
      sourceTs: '42.1',
      candidates: ['mk-ella'],
      identityFor: () => identities['mk-ella'],
    });
    w.delivered(['mk-ella']);
    t.auto.noteBusy('mk-ella');
    await flush();
    expect(t.working()).toHaveLength(1);
  });

  it('the agent already called /api/slack/working for the message: no duplicate', async () => {
    const t = setup();
    const w = t.auto.watch(channelDelivery());
    w.delivered([OWEN, VERA]);
    // Vera takes it on herself (reply-channel --working → typing.begin).
    await t.typing.begin({ agentSession: VERA, slackChannelId: CHANNEL, threadTs: MSG_TS }, identities[VERA]);

    t.auto.noteBusy(OWEN);
    t.auto.noteBusy(VERA);
    await flush();

    expect(t.working()).toHaveLength(1);
    expect(t.working()[0].botToken).toBe('xoxb-vera');
  });

  it('a placeholder already showing for another recipient (thread activity missed) still blocks a second one', async () => {
    const t = setup();
    const w = t.auto.watch(channelDelivery());
    w.delivered([OWEN, VERA]);
    // Vera's placeholder is showing but the thread-activity signal never came.
    const owes = jest.spyOn(t.typing, 'owes').mockImplementation((k) => k.agentSession === VERA);
    t.auto.noteBusy(OWEN);
    await flush();
    expect(t.working()).toHaveLength(0);
    owes.mockRestore();
  });

  it('an answer already in the thread: no placeholder after it', async () => {
    const t = setup();
    const w = t.auto.watch(channelDelivery());
    w.delivered([OWEN, VERA]);
    await t.typing.resolve({ agentSession: VERA, slackChannelId: CHANNEL, threadTs: MSG_TS }, 'done', identities[VERA]);
    t.auto.noteBusy(OWEN);
    await flush();
    expect(t.working()).toHaveLength(0);
  });

  it('a recipient already busy before delivery: none, even when it is later seen busy again', async () => {
    const t = setup({ busy: [OWEN] });
    const w = t.auto.watch(channelDelivery([OWEN]));
    w.delivered([OWEN]);
    t.auto.noteBusy(OWEN);
    await flush();
    expect(t.working()).toHaveLength(0);
  });

  it('one recipient busy before delivery, the other idle: only the idle one can trigger', async () => {
    const t = setup({ busy: [VERA] });
    const w = t.auto.watch(channelDelivery());
    w.delivered([OWEN, VERA]);
    t.auto.noteBusy(VERA);
    await flush();
    expect(t.working()).toHaveLength(0);
    t.auto.noteBusy(OWEN);
    await flush();
    expect(t.working().map((m) => m.botToken)).toEqual(['xoxb-owen']);
  });

  it('two recipients busy: one placeholder, from the first', async () => {
    const t = setup();
    const w = t.auto.watch(channelDelivery());
    w.delivered([OWEN, VERA]);
    t.auto.noteBusy(VERA);
    t.auto.noteBusy(OWEN);
    await flush();
    expect(t.working().map((m) => m.botToken)).toEqual(['xoxb-vera']);
  });

  it('busy transitions seen while delivery is still running count, first delivered one wins', async () => {
    // Huddle delivery is sequential (Owen 15:27:07, Vera 15:27:11); a turn
    // that starts before the last delivery finishes must not be lost.
    const t = setup();
    const w = t.auto.watch(channelDelivery());
    t.auto.noteBusy(VERA);
    t.auto.noteBusy(OWEN);
    w.delivered([OWEN]); // Vera's delivery failed
    await flush();
    expect(t.working().map((m) => m.botToken)).toEqual(['xoxb-owen']);
  });

  it('a recipient the message never reached: none', async () => {
    const t = setup();
    const w = t.auto.watch(channelDelivery());
    w.delivered([VERA]);
    t.auto.noteBusy(OWEN);
    await flush();
    expect(t.working()).toHaveLength(0);
    expect(t.auto.watchCount).toBe(1);
  });

  it('busy after the window: none', async () => {
    const t = setup();
    const w = t.auto.watch(channelDelivery());
    w.delivered([OWEN, VERA]);
    t.advance(SLACK_TYPING_CONSTANTS.AUTO_WORKING_WINDOW_MS + 1);
    t.auto.noteBusy(OWEN);
    await flush();
    expect(t.working()).toHaveLength(0);
    expect(t.auto.watchCount).toBe(0);
  });

  it('a cancelled watch (delivery failed) posts nothing', async () => {
    const t = setup();
    const w = t.auto.watch(channelDelivery());
    w.cancel();
    t.auto.noteBusy(OWEN);
    await flush();
    expect(t.working()).toHaveLength(0);
  });

  it('a delivery that never reports back is dropped after AUTO_WORKING_DELIVERY_MAX_MS', () => {
    const t = setup();
    t.auto.watch(channelDelivery());
    t.advance(SLACK_TYPING_CONSTANTS.AUTO_WORKING_DELIVERY_MAX_MS + 1);
    t.auto.noteBusy('someone-else');
    expect(t.auto.watchCount).toBe(0);
  });

  it('no identity for the agent: nothing posted', async () => {
    const t = setup();
    const w = t.auto.watch({ ...channelDelivery(), identityFor: () => null });
    w.delivered([OWEN]);
    t.auto.noteBusy(OWEN);
    await flush();
    expect(t.working()).toHaveLength(0);
  });

  describe('clean-up rules apply to the harness placeholder unchanged', () => {
    it('settle on idle: the agent ends its turn without replying → placeholder deleted and ✅ on the owner message', async () => {
      const t = setup();
      const w = t.auto.watch(channelDelivery());
      w.delivered([OWEN, VERA]);
      t.auto.noteBusy(OWEN);
      await flush();
      const [ph] = t.working();
      expect(ph).toBeDefined();

      const removed = await t.typing.settleTurnWithoutReply(OWEN, Date.now() + SLACK_TYPING_CONSTANTS.SETTLE_MIN_AGE_MS + 1);

      expect(removed).toBe(1);
      expect(t.deleted).toEqual([{ channelId: CHANNEL, ts: 'ph-1', botToken: 'xoxb-owen' }]);
      expect(t.reactions).toEqual([
        { channelId: CHANNEL, ts: MSG_TS, emoji: SLACK_TYPING_CONSTANTS.SETTLED_REACTION, botToken: 'xoxb-owen' },
      ]);
      expect(t.typing.owes({ agentSession: OWEN, slackChannelId: CHANNEL, threadTs: MSG_TS })).toBe(false);
    });

    it('REPLACE_BY_EDIT=false: the answer is posted new and the placeholder deleted', async () => {
      const t = setup();
      const w = t.auto.watch(channelDelivery());
      w.delivered([OWEN, VERA]);
      t.auto.noteBusy(OWEN);
      await flush();

      const outcome = await t.typing.resolve({ agentSession: OWEN, slackChannelId: CHANNEL, threadTs: MSG_TS }, '已改成 $299/月', identities[OWEN]);

      expect(outcome).toBe('replaced');
      expect(t.sent.at(-1)).toMatchObject({ text: '已改成 $299/月', threadTs: MSG_TS, botToken: 'xoxb-owen' });
      expect(t.deleted).toEqual([{ channelId: CHANNEL, ts: 'ph-1', botToken: 'xoxb-owen' }]);
    });
  });
});

describe('isOwnerAuthored', () => {
  it('the owner (or any human when the owner is unknown) — yes', () => {
    expect(isOwnerAuthored({ userId: 'UOWNER' }, 'UOWNER')).toBe(true);
    expect(isOwnerAuthored({ userId: 'U1' }, null)).toBe(true);
  });
  it('another person, an agent (any machine), or no author — no', () => {
    expect(isOwnerAuthored({ userId: 'U-OTHER' }, 'UOWNER')).toBe(false);
    expect(isOwnerAuthored({ userId: 'UOWNER', authorAgentSession: 'mk-atlas' }, 'UOWNER')).toBe(false);
    expect(isOwnerAuthored({ userId: 'UBOT', authorAgentSession: 'mk-atlas' }, null)).toBe(false);
    expect(isOwnerAuthored({ userId: '' }, null)).toBe(false);
  });
});

describe('deliveredSessions', () => {
  it('reads each dispatch strategy', () => {
    const huddle = {
      strategy: 'huddle-broadcast',
      dispatched: true,
      huddleOutcomes: [
        { sessionName: OWEN, responseMode: 'optional', dispatched: true },
        { sessionName: VERA, responseMode: 'optional', dispatched: false },
      ],
    } as DispatchMessageResult;
    expect(deliveredSessions(huddle)).toEqual([OWEN]);
    const mentions = {
      strategy: 'channel-mentions',
      dispatched: true,
      mentionOutcomes: [{ target: { sessionName: VERA }, dispatched: true }],
    } as unknown as DispatchMessageResult;
    expect(deliveredSessions(mentions)).toEqual([VERA]);
    expect(deliveredSessions({ strategy: 'dm', dispatched: true } as DispatchMessageResult, 'mk-ella')).toEqual(['mk-ella']);
    expect(deliveredSessions({ strategy: 'dm', dispatched: true } as DispatchMessageResult)).toEqual([]);
    expect(deliveredSessions({ strategy: 'skip', dispatched: false } as DispatchMessageResult)).toEqual([]);
    expect(deliveredSessions(null)).toEqual([]);
  });
});

describe('singleton', () => {
  it('set / get', () => {
    const t = setup();
    setSlackAutoWorkingService(t.auto);
    expect(getSlackAutoWorkingService()).toBe(t.auto);
    setSlackAutoWorkingService(null);
    expect(getSlackAutoWorkingService()).toBeNull();
  });
});
