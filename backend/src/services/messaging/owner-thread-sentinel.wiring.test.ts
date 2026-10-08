jest.mock('../core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) }) },
}));

import { mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DECISION_CONSTANTS, OWNER_THREAD_SENTINEL_CONSTANTS } from '../../constants.js';
import { DecisionStore } from '../decisions/decision-store.js';
import { markOwnerStopped, resetOwnerStoppedForTesting } from '../agent/owner-stopped.registry.js';
import { OwnerThreadSentinelService } from './owner-thread-sentinel.service.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { OwnerMessageEntry } from './owner-message-watchdog.service.js';
import {
  describeAgentActivity,
  nudgeSentinelAgent,
  onOwnerMessageTracked,
  ownerThreadOfAgentWork,
  ownerThreadSessionsAtBoot,
  ownerThreadOfWorkItem,
  postSentinelStatus,
  sentinelEventForDecision,
  slackMessageLink,
  type OwnerThreadSentinelWiringDeps,
} from './owner-thread-sentinel.wiring.js';

const CH = 'C0C30RWA17W';

function decision(over: Partial<OwnerDecision> = {}): OwnerDecision {
  return {
    id: 'D-476',
    question: 'Atlas wants to click "Download" on mail.google.com',
    options: [],
    defaultKey: 'b',
    deadline: '2026-10-08T18:39:01.000Z',
    requestedBy: 'atlas',
    asker: 'atlas',
    status: 'open',
    createdAt: '2026-10-08T16:39:01.000Z',
    updatedAt: '2026-10-08T16:39:01.000Z',
    kind: 'browser_action',
    card: { slackChannelId: CH, messageTs: '1791477541.790000', postedBy: 'atlas', ownBot: true },
    ...over,
  } as OwnerDecision;
}

function workItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi-1',
    title: 'Read Michael PDFs',
    status: 'running',
    target: 'atlas',
    createdAt: '2026-10-08T16:00:00.000Z',
    metadata: { origin: { kind: 'owner', slackChannelId: CH, threadTs: '1.1' } },
    ...over,
  } as WorkItem;
}

function deps(over: Partial<OwnerThreadSentinelWiringDeps> = {}): OwnerThreadSentinelWiringDeps & { sent: unknown[]; delivered: string[] } {
  const sent: unknown[] = [];
  const delivered: string[] = [];
  return {
    crewlyHome: '/tmp/x',
    slack: () => ({
      isConnected: () => true,
      sendMessage: async (m) => {
        sent.push(m);
        return 'ts';
      },
    }),
    agentDmBotToken: () => undefined,
    botTokenOf: () => undefined,
    sendToAgent: async (_s, text) => {
      delivered.push(text);
      return { success: true };
    },
    sessionExists: () => true,
    activate: async () => ({ success: true }),
    listItems: async () => [],
    sent,
    delivered,
    ...over,
  };
}

describe('slackMessageLink', () => {
  it('links a top-level message and a thread reply', () => {
    expect(slackMessageLink(CH, '1791477541.790000')).toBe(`https://slack.com/archives/${CH}/p1791477541790000`);
    expect(slackMessageLink(CH, '2.000200', '1.000100')).toBe(`https://slack.com/archives/${CH}/p2000200?thread_ts=1.000100&cid=${CH}`);
  });
});

describe('sentinelEventForDecision', () => {
  it('a posted card carries its link and where it can be seen', () => {
    expect(sentinelEventForDecision(decision(), 'posted')).toEqual({
      kind: 'card_posted',
      decisionId: 'D-476',
      question: 'Atlas wants to click "Download" on mail.google.com',
      link: `https://slack.com/archives/${CH}/p1791477541790000`,
      place: { slackChannelId: CH, threadTs: '1791477541.790000' },
      browser: true,
    });
  });

  it('a card posted in a thread is seen in that thread', () => {
    const ev = sentinelEventForDecision(decision({ card: { slackChannelId: CH, messageTs: '2.2', threadTs: '1.1', postedBy: 'atlas', ownBot: true } }), 'posted');
    expect(ev).toMatchObject({ place: { slackChannelId: CH, threadTs: '1.1' } });
  });

  it('maps end states', () => {
    expect(sentinelEventForDecision(decision({ status: 'expired' }), 'settled')).toMatchObject({ kind: 'card_expired', browser: true });
    expect(sentinelEventForDecision(decision({ status: 'parked' }), 'settled')).toMatchObject({ kind: 'card_parked' });
    for (const status of ['resolved', 'defaulted', 'cancelled', 'skipped'] as const) {
      expect(sentinelEventForDecision(decision({ status }), 'settled')).toEqual({ kind: 'card_settled', decisionId: 'D-476' });
    }
    expect(sentinelEventForDecision(decision({ status: 'open' }), 'settled')).toBeNull();
  });

  it('ignores harness-owned decisions and unposted cards', () => {
    expect(sentinelEventForDecision(decision({ system: { key: 'k' } as OwnerDecision['system'] }), 'posted')).toBeNull();
    expect(sentinelEventForDecision(decision({ card: undefined }), 'posted')).toBeNull();
  });
});

describe('owner work threads', () => {
  it('reads the owner origin of a work item; other origins are not owner threads', () => {
    expect(ownerThreadOfWorkItem(workItem())).toEqual({ slackChannelId: CH, threadTs: '1.1' });
    expect(ownerThreadOfWorkItem(workItem({ metadata: { origin: { kind: 'ticket', projectPath: '/p', ticketId: 'CE-1' } } }))).toBeNull();
  });

  it("picks the agent's newest open owner work, blocked included", () => {
    const items = [
      workItem({ id: 'old', createdAt: '2026-10-08T10:00:00.000Z', metadata: { origin: { kind: 'owner', slackChannelId: CH, threadTs: '0.1' } } }),
      workItem({ id: 'new', status: 'blocked', createdAt: '2026-10-08T16:30:00.000Z' }),
      workItem({ id: 'done', status: 'done', createdAt: '2026-10-08T17:00:00.000Z', metadata: { origin: { kind: 'owner', slackChannelId: CH, threadTs: '9.9' } } }),
      workItem({ id: 'other', target: 'kai', createdAt: '2026-10-08T18:00:00.000Z' }),
    ];
    expect(ownerThreadOfAgentWork(items, 'atlas')).toEqual({ slackChannelId: CH, threadTs: '1.1' });
    expect(ownerThreadOfAgentWork(items, 'nobody')).toBeNull();
  });
});

describe('onOwnerMessageTracked', () => {
  it('feeds Slack owner messages (thread or the message itself) and skips chat ones', () => {
    const noteOwnerMessage = jest.fn();
    const base: Omit<OwnerMessageEntry, 'surface'> = { key: 'k', responsible: 'atlas', recipients: ['atlas'], required: true, preview: 'p', receivedAt: 5, stage: 'waiting' };
    onOwnerMessageTracked({ noteOwnerMessage }, { ...base, surface: 'slack', slackChannelId: CH, sourceTs: '3.3' } as OwnerMessageEntry);
    onOwnerMessageTracked({ noteOwnerMessage }, { ...base, surface: 'chat', chatChannelId: 'c' } as OwnerMessageEntry);
    expect(noteOwnerMessage).toHaveBeenCalledTimes(1);
    expect(noteOwnerMessage).toHaveBeenCalledWith({ slackChannelId: CH, threadTs: '3.3', agent: 'atlas', at: 5 });
  });
});

describe('postSentinelStatus', () => {
  it('posts as Crewly, flagged as not an answer and not mirrored', async () => {
    const d = deps();
    expect(await postSentinelStatus(d, { slackChannelId: CH, threadTs: '1.1' }, 'atlas', 'line')).toBe(true);
    expect(d.sent).toEqual([{ channelId: CH, text: 'line', threadTs: '1.1', notAnAnswer: true, skipChatV2Mirror: true, unfurlLinks: false, unfurlMedia: false }]);
  });

  it("uses the agent's bot in its own DM, and falls back to it when the master bot is refused", async () => {
    const d = deps({ agentDmBotToken: (c) => (c === 'D1' ? 'xoxb-dm' : undefined) });
    await postSentinelStatus(d, { slackChannelId: 'D1' }, 'atlas', 'x');
    expect(d.sent[0]).toMatchObject({ botToken: 'xoxb-dm' });

    const tries: unknown[] = [];
    const f = deps({
      botTokenOf: () => 'xoxb-agent',
      slack: () => ({
        isConnected: () => true,
        sendMessage: async (m) => {
          tries.push(m);
          if (!m.botToken) throw new Error('not_in_channel');
          return 'ts';
        },
      }),
    });
    expect(await postSentinelStatus(f, { slackChannelId: CH, threadTs: '1.1' }, 'atlas', 'x')).toBe(true);
    expect(tries[1]).toMatchObject({ botToken: 'xoxb-agent' });
  });

  it('is false while Slack is down', async () => {
    expect(await postSentinelStatus(deps({ slack: () => null }), { slackChannelId: CH }, 'atlas', 'x')).toBe(false);
  });
});

describe('nudgeSentinelAgent', () => {
  afterEach(() => resetOwnerStoppedForTesting());

  it('wakes a stopped agent, then delivers', async () => {
    const activate = jest.fn(async () => ({ success: true }));
    const d = deps({ sessionExists: () => false, activate });
    expect(await nudgeSentinelAgent(d, 'atlas', 'hi')).toBe(true);
    expect(activate).toHaveBeenCalledWith('atlas');
    expect(d.delivered).toEqual(['hi']);
  });

  it('never wakes an agent the owner stopped', async () => {
    markOwnerStopped('atlas');
    const d = deps();
    expect(await nudgeSentinelAgent(d, 'atlas', 'hi')).toBe(false);
    expect(d.delivered).toEqual([]);
  });

  it('is false when the agent cannot be started', async () => {
    expect(await nudgeSentinelAgent(deps({ sessionExists: () => false, activate: async () => ({ success: false }) }), 'atlas', 'hi')).toBe(false);
  });
});

describe('describeAgentActivity', () => {
  it('says whether it runs, is busy, and on what', async () => {
    const items = [workItem({ status: 'blocked', blockedReason: 'awaiting owner approval' } as Partial<WorkItem>)];
    expect(await describeAgentActivity(deps({ listItems: async () => items, sessionExists: () => false }), 'atlas')).toBe(
      'not running; its open work is “Read Michael PDFs” (blocked: awaiting owner approval)',
    );
    expect(await describeAgentActivity(deps({ listItems: async () => [workItem()], workingStatusOf: () => 'in_progress' }), 'atlas')).toBe(
      'busy on “Read Michael PDFs” (running)',
    );
    expect(await describeAgentActivity(deps(), 'atlas')).toBe('idle, with no work item');
  });
});

describe('ownerThreadSessionsAtBoot (boot restore rule)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'sentinel-boot-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('an agent with a promised follow-up or an open owner card is work in hand; the orc and old / system cards are not', async () => {
    const now = Date.parse('2026-10-08T16:49:00Z');
    const sentinel = new OwnerThreadSentinelService({
      postStatus: async () => true,
      nudgeAgent: async () => true,
      storePath: path.join(home, OWNER_THREAD_SENTINEL_CONSTANTS.STORE_FILENAME),
      now: () => now - 20 * 60_000,
    });
    sentinel.noteOwnerMessage({ slackChannelId: CH, threadTs: '1.1', agent: 'atlas' });
    sentinel.noteAgentPost({ slackChannelId: CH, threadTs: '1.1', agent: 'atlas', text: "I'll read the attachments via Chrome, ~15 min" });
    sentinel.noteOwnerMessage({ slackChannelId: CH, threadTs: '2.2', agent: 'vera' });
    sentinel.noteAgentPost({ slackChannelId: CH, threadTs: '2.2', agent: 'vera', text: 'Done — the draft is above.' });

    let clock = new Date(now - 10 * 60_000);
    const store = new DecisionStore(path.join(home, DECISION_CONSTANTS.STORE_FILENAME), () => clock);
    const card = { slackChannelId: CH, messageTs: '3.3', postedBy: 'x', ownBot: true };
    const base = { question: 'q', options: [], defaultKey: 'b', deadline: new Date(now + 3_600_000).toISOString(), status: 'open' as const, card };
    await store.create({ ...base, requestedBy: 'ella', asker: 'ella' });
    await store.create({ ...base, requestedBy: 'crewly-orc', asker: 'crewly-orc' });
    await store.create({ ...base, requestedBy: 'crewly', asker: 'kai', system: { key: 'k' } as OwnerDecision['system'] });
    await store.create({ ...base, requestedBy: 'sage', asker: 'sage', status: 'resolved' });
    clock = new Date(now - 30 * 60 * 60_000);
    await store.create({ ...base, requestedBy: 'nova', asker: 'nova' });

    expect((await ownerThreadSessionsAtBoot(home, now)).sort()).toEqual(['atlas', 'ella']);
  });

  it('an empty CREWLY_HOME restores nobody', async () => {
    expect(await ownerThreadSessionsAtBoot(home)).toEqual([]);
  });
});

describe('sentinelEventForDecision (only browser approvals get a line)', () => {
  it('a question card gets no status line; a browser approval does', () => {
    const base = { id: 'D-1', question: 'q?', status: 'open', card: { slackChannelId: 'C1', messageTs: '2.2', threadTs: '1.1' } };
    expect(sentinelEventForDecision({ ...base, kind: 'reply_question' } as never, 'posted')).toBeNull();
    expect(sentinelEventForDecision({ ...base, kind: 'browser_action' } as never, 'posted')).toMatchObject({ kind: 'card_posted', browser: true });
  });
});
