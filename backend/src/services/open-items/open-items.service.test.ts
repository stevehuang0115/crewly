/**
 * Tests for open-item tracking (specs/2026-10-01-reply-open-items.md) on the
 * real RequestService (file I/O mocked): the ticket stays open, finished
 * child work wakes the promising lead at once, an overdue promise nudges and
 * then tells the owner, a question becomes a card with derived options, an
 * ask-owner question is not carded twice, and the backfill dry-run.
 */
import { RequestService } from '../v3/request.service.js';
import { createWorkItem, type WorkItem } from '../../types/v2/work-item.types.js';
import type { Request } from '../../types/v2/request.types.js';
import type { RequestOpenItem } from '../../types/v2/open-item.types.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import type { ComponentLogger } from '../core/logger.service.js';
import { OpenItemsService, isConcreteInterimPromise, markRestartReminded, owedCommitments, plausiblyFulfils, type OpenItemsDeps, type OpenItemsChatMessage, type QuestionCardInput, type FollowUpInput } from './open-items.service.js';
import { AgentPromptReferenceService } from '../orc/agent-prompt-reference.service.js';
import { backfillOpenItems, formatBackfillReport, isHarnessFlowQuestion, reportsSettled } from './open-items-backfill.js';
import { DecisionService, type DecisionSlackApi } from '../decisions/decision.service.js';
import { DecisionStore } from '../decisions/decision-store.js';
import { TicketThreadStore } from '../decisions/ticket-thread-store.js';
import type { SlackBlock, SlackOutgoingMessage } from '../../types/slack.types.js';

const mockFiles = new Map<string, string>();

jest.mock('fs/promises', () => ({
  readdir: jest.fn().mockImplementation(async () => {
    const entries: string[] = [];
    for (const key of mockFiles.keys()) {
      const filename = key.split('/').pop() || '';
      if (filename.endsWith('.json')) entries.push(filename);
    }
    return entries;
  }),
  rename: jest.fn(),
}));

jest.mock('../../utils/file-io.utils.js', () => ({
  ensureDir: jest.fn().mockResolvedValue(undefined),
  atomicWriteJson: jest.fn().mockImplementation(async (filePath: string, data: unknown) => {
    mockFiles.set(filePath, JSON.stringify(data));
  }),
  safeReadJson: jest.fn().mockImplementation(async (filePath: string, fallback: unknown) => {
    const content = mockFiles.get(filePath);
    if (!content) return fallback;
    return JSON.parse(content);
  }),
}));

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    }),
  },
}));

const quiet = (): ComponentLogger => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as unknown as ComponentLogger;

const ATLAS = 'think-tank-atlas-b4e166f6';
const KAI = 'think-tank-kai-75d30ac6';
const CHANNEL = 'chat-book-publish';
const ROOT = 'root-msg';
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Atlas's TKT-185 reply (the two open items). */
const ATLAS_REPLY =
  'Kai 在把四集逐条过一遍，找出能进书的原话。明天中午给我，我核过以后挑最有用的几条发你。\n' +
  '第 13 章「互评当体检用」这个读法，你同意吗？不同意的话我就删掉，只留事实。';

interface Harness {
  service: OpenItemsService;
  requests: RequestService;
  clock: { now: Date };
  pool: WorkItem[];
  woken: Array<{ session: string; text: string }>;
  ownerNotes: string[];
  followUps: FollowUpInput[];
  closed: Array<{ id: string; outcome: string }>;
  cards: QuestionCardInput[];
  decisions: OwnerDecision[];
}

/**
 * Build the service over the real RequestService.
 *
 * @param over - Dep overrides
 * @returns Harness
 */
function harness(over: Partial<OpenItemsDeps> = {}): Harness {
  RequestService.resetInstance();
  mockFiles.clear();
  const requests = RequestService.getInstance('/tmp/open-items-test');
  const h: Omit<Harness, 'service'> = {
    requests,
    clock: { now: new Date(2026, 9, 1, 18, 0, 29) },
    pool: [],
    woken: [],
    ownerNotes: [],
    followUps: [],
    closed: [],
    cards: [],
    decisions: [],
  };
  const service = new OpenItemsService({
    requests,
    listWorkItems: async () => h.pool,
    createFollowUp: async (fu) => {
      h.followUps.push(fu);
      return `fu-${h.followUps.length}`;
    },
    closeFollowUp: async (id, outcome) => {
      h.closed.push({ id, outcome });
    },
    recentDecisionsBy: async (agent, since) => h.decisions.filter((d) => d.asker === agent && Date.parse(d.createdAt) >= since),
    askQuestion: async (q) => {
      h.cards.push(q);
      return { id: `D-${h.cards.length}` } as OwnerDecision;
    },
    deliverToAgent: async (session, text) => {
      h.woken.push({ session, text });
      return true;
    },
    postOwnerNote: async (_r, text) => {
      h.ownerNotes.push(text);
      return true;
    },
    displayName: async (s) => (s === ATLAS ? 'Atlas' : s === KAI ? 'Kai' : s),
    colleagueNames: async () => ['Kai', 'Rex'],
    now: () => h.clock.now,
    logger: quiet(),
    ...over,
  });
  return { ...h, service };
}

/**
 * A Slack-thread ticket answered by Atlas.
 *
 * @param h - Harness
 * @param status - Status to leave it in
 * @returns The ticket
 */
async function ticket(h: Harness, status: 'running' | 'done' = 'running'): Promise<Request> {
  const t = await h.requests.create({
    sourceConversationItemId: `src-${Math.random()}`,
    title: '第二工位 as book material',
    description: '我第二工位的播客也可以作为素材',
    ticketNumber: 185,
    requiresConfirmation: true,
    origin: { channel: 'slack-channel', ref: 'r', threadRef: 'slack:C0C67371YUC:1790884910.228259', author: 'UOWNER' },
    assignee: ATLAS,
  });
  await h.requests.update(t.id, { status: 'running', chatRef: { channelId: CHANNEL, messageId: ROOT, threadRootId: ROOT } });
  if (status === 'done') return h.requests.update(t.id, { status: 'done', accepted: true });
  return (await h.requests.getById(t.id))!;
}

/**
 * An agent message in the ticket's thread.
 *
 * @param h - Harness
 * @param content - Text
 * @param sender - Agent
 * @param id - Message id
 * @returns Message
 */
function msg(h: Harness, content: string, sender = ATLAS, id = `m-${Math.random().toString(36).slice(2)}`): OpenItemsChatMessage {
  return { id, channelId: CHANNEL, threadId: ROOT, senderType: 'agent', senderId: sender, content, createdAt: h.clock.now.getTime() };
}

/**
 * Kai's delegated work item for the request.
 *
 * @param h - Harness
 * @param requestId - Request
 * @param status - Status
 * @returns The item (in the pool)
 */
function kaiWork(h: Harness, requestId: string, status: WorkItem['status'] = 'running'): WorkItem {
  const wi = createWorkItem({ id: '28b09370-7751-4963-8ba8-4836a2ccc7d0', type: 'delegate', owner: 'team_lead', target: KAI, requestId, title: 'Find his own words in 第二工位 EP1-4' });
  wi.status = status;
  wi.createdAt = new Date(h.clock.now.getTime() - 20_000).toISOString();
  h.pool.push(wi);
  return wi;
}

describe('OpenItemsService — the ticket stays open', () => {
  it('a done ticket whose agent leaves open items moves to awaiting_followup (TKT-185)', async () => {
    const h = harness();
    const t = await ticket(h, 'done');
    kaiWork(h, t.id);
    const updated = await h.service.onAgentMessage(msg(h, ATLAS_REPLY));
    expect(updated?.status).toBe('awaiting_followup');
    expect(updated?.completedAt).toBeUndefined();
    const items = updated!.openItems!;
    expect(items.map((i) => [i.type, i.status])).toEqual([
      ['commitment', 'open'],
      ['question', 'open'],
    ]);
    expect(items[0].childWorkItemIds).toEqual(['28b09370-7751-4963-8ba8-4836a2ccc7d0']);
    expect(items[0].workItemId).toBe('fu-1');
    expect(new Date(items[0].due!).getHours()).toBe(12);
    expect(items[1].decisionId).toBe('D-1');
  });

  it('every close path lands in awaiting_followup while an item is open', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, '明天中午整理好发你。'));
    const closed = await h.requests.update(t.id, { status: 'done', accepted: true });
    expect(closed.status).toBe('awaiting_followup');
    // The reconciler / cascades cannot move it anywhere but done / cancelled.
    await expect(h.requests.update(t.id, { status: 'running' })).rejects.toThrow(/Invalid status transition/);
  });

  it('the same reply recorded twice (reply path + Slack mirror) is tracked once', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, '明天中午整理好发你。', ATLAS, 'm-a'));
    await h.service.onAgentMessage(msg(h, '明天中午整理好发你。', ATLAS, 'm-b'));
    expect((await h.requests.getById(t.id))!.openItems).toHaveLength(1);
    expect(h.followUps).toHaveLength(1);
  });

  it('a reply with nothing open changes nothing', async () => {
    const h = harness();
    await ticket(h);
    expect(await h.service.onAgentMessage(msg(h, '第 11、12 章改好了，PDF 附在下面。'))).toBeNull();
  });
});

describe('OpenItemsService — commitments', () => {
  it('child work finished before the due time wakes the lead at once; the next post delivers it', async () => {
    const h = harness();
    const t = await ticket(h, 'done');
    const wi = kaiWork(h, t.id);
    await h.service.onAgentMessage(msg(h, ATLAS_REPLY));

    // Kai finishes at 18:14 and Atlas verifies it — long before tomorrow noon.
    h.clock.now = new Date(2026, 9, 1, 18, 17, 10);
    wi.status = 'verified';
    wi.completedAt = h.clock.now.toISOString();
    const ready = await h.service.onWorkItemSettled(wi.id);
    expect(ready).toHaveLength(1);
    expect(h.woken).toHaveLength(1);
    expect(h.woken[0].session).toBe(ATLAS);
    expect(h.woken[0].text).toContain('The work you promised the owner is ready ("Find his own words in 第二工位 EP1-4") — deliver it now.');
    // A command naming the ticket, never a raw thread key (spec 2026-10-02 §4).
    expect(h.woken[0].text).toContain('Run: reply --ticket TKT-185 "<your message>"');
    expect(h.woken[0].text).not.toContain('--thread');
    expect(AgentPromptReferenceService.getInstance().get(ATLAS)?.reference).toEqual(expect.objectContaining({ ticket: 'TKT-185' }));
    let r = (await h.requests.getById(t.id))!;
    expect(r.openItems![0].status).toBe('ready');

    // A second settle event does not wake it again.
    await h.service.onWorkItemSettled(wi.id);
    expect(h.woken).toHaveLength(1);

    // Atlas posts the material: delivered, follow-up closed. The question is
    // still open, so the ticket stays awaiting_followup.
    h.clock.now = new Date(2026, 9, 1, 18, 30, 0);
    await h.service.onAgentMessage(msg(h, '四集里能进书的原话挑了 6 条，按章节放在下面。'));
    r = (await h.requests.getById(t.id))!;
    expect(r.openItems![0].status).toBe('delivered');
    expect(h.closed).toEqual([{ id: 'fu-1', outcome: 'delivered' }]);
    expect(r.status).toBe('awaiting_followup');
  });

  it('a post before the child work is finished is not the delivery', async () => {
    const h = harness();
    const t = await ticket(h);
    kaiWork(h, t.id);
    await h.service.onAgentMessage(msg(h, '明天中午给我，我核过以后挑最有用的几条发你。'));
    h.clock.now = new Date(h.clock.now.getTime() + 30 * MIN);
    await h.service.onAgentMessage(msg(h, '另外第 2 章也同步了。'));
    expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('open');
  });

  it('overdue: nudges the agent once, then tells the owner in the thread what is late and why', async () => {
    const h = harness();
    const t = await ticket(h);
    kaiWork(h, t.id);
    await h.service.onAgentMessage(msg(h, '明天中午给我，我核过以后挑最有用的几条发你。'));

    // Before the due time: nothing.
    h.clock.now = new Date(2026, 9, 2, 11, 0, 0);
    expect((await h.service.sweep()).nudged).toBe(0);

    // Past noon, Kai's part still running: one nudge.
    h.clock.now = new Date(2026, 9, 2, 12, 5, 0);
    expect((await h.service.sweep()).nudged).toBe(1);
    expect(h.woken.at(-1)!.text).toContain("You promised the owner: \"明天中午给我，我核过以后挑最有用的几条发你。\"");
    expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('overdue');
    expect((await h.service.sweep()).nudged).toBe(0);
    expect(h.ownerNotes).toEqual([]);

    // Two hours after the nudge, still nothing: the owner is told, once.
    h.clock.now = new Date(2026, 9, 2, 14, 10, 0);
    await h.service.sweep();
    expect(h.ownerNotes).toHaveLength(1);
    expect(h.ownerNotes[0]).toMatch(/^Atlas promised "明天中午给我，我核过以后挑最有用的几条发你。" by 12:00\. It hasn't arrived: Kai's part \("Find his own words in 第二工位 EP1-4"\) is still running\. Atlas has been reminded\.$/);
    await h.service.sweep();
    expect(h.ownerNotes).toHaveLength(1);
  });

  it('without child work: a later post by the agent delivers; the ticket closes when nothing is left', async () => {
    const h = harness();
    const t = await ticket(h, 'done');
    await h.service.onAgentMessage(msg(h, '大约 40 分钟后发你 PDF。'));
    expect((await h.requests.getById(t.id))!.status).toBe('awaiting_followup');
    h.clock.now = new Date(h.clock.now.getTime() + 35 * MIN);
    await h.service.onAgentMessage(msg(h, 'PDF 在这里，第 7、10、14、15 章都改了。'));
    const r = (await h.requests.getById(t.id))!;
    expect(r.openItems![0].status).toBe('delivered');
    expect(r.status).toBe('done');
  });
});

describe('OpenItemsService — Drive mode (specs/2026-10-08-drive-mode.md §7)', () => {
  const drive = (h: Harness, content: string, extra: Record<string, unknown> = {}): OpenItemsChatMessage => ({
    ...msg(h, content),
    metadata: { source: 'reply-tool', via: 'drive-mode', ...extra },
  });

  it('a spoken answer opens nothing; a recap with nothing pending delivers the open promises', async () => {
    const h = harness();
    const t = await ticket(h, 'done');
    expect(await h.service.onAgentMessage(drive(h, '明天中午整理好发你。'))).toBeNull();
    await h.service.onAgentMessage(msg(h, '大约 40 分钟后发你 PDF。'));
    expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('open');
    h.clock.now = new Date(h.clock.now.getTime() + 5 * MIN);
    await h.service.onAgentMessage(drive(h, 'Drive mode recap — you asked for the PDF; I sent it; next: nothing pending.', { driveRecap: true, driveNextStep: false }));
    const r = (await h.requests.getById(t.id))!;
    expect(r.openItems![0]).toMatchObject({ status: 'delivered', closedReason: expect.stringContaining('Drive mode recap') });
  });

  it('a recap that names a next step is read like any reply', async () => {
    const h = harness();
    const t = await ticket(h, 'done');
    await h.service.onAgentMessage(drive(h, 'Drive mode recap — next: 明天中午整理好发你。', { driveRecap: true, driveNextStep: true }));
    expect((await h.requests.getById(t.id))!.openItems?.map((i) => i.type)).toEqual(['commitment']);
  });
});

describe('OpenItemsService — a promise in an interim note (2026-10-02, Eve, TKT-194)', () => {
  /** Eve's reply-channel --interim message, word for word. */
  const EVE = 'evership-eve-398f05df';
  const EVE_INTERIM =
    '明白了：你是随时寄的技术服务商，要一份从经营者角度出发的定期汇报方案。我会写清楚每天、每周、每月分别看什么信号，' +
    '加上行业和政策情报、机会（团长和同行怎么做）、安全和上游渠道商的风险，每个信号都写明数据从哪来、系统里现在有没有。' +
    '我先摸清系统里已有的数据，再查一下行业资料，大约 20–30 分钟后把方案文档发到这里。';

  /**
   * Eve's message as reply-channel records it in chat-v2 (interim flag set).
   *
   * @param h - Harness
   * @param content - Text
   * @param id - Message id
   * @returns Message
   */
  const interim = (h: Harness, content: string, id = 'a81b0422'): OpenItemsChatMessage => ({
    ...msg(h, content, EVE, id),
    metadata: { interim: true },
  });

  it('tracks the commitment, due at +30 min, with a follow-up', async () => {
    const h = harness();
    const t = await ticket(h);
    const posted = h.clock.now.getTime();
    const updated = await h.service.onAgentMessage(interim(h, EVE_INTERIM));
    const items = updated!.openItems!;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'commitment', status: 'open', agent: EVE, sourceMessageId: 'a81b0422', workItemId: 'fu-1' });
    expect(items[0].text).toContain('大约 20–30 分钟后把方案文档发到这里');
    expect(Date.parse(items[0].due!)).toBe(posted + 30 * MIN);
    expect(h.followUps).toHaveLength(1);
    expect((await h.requests.getById(t.id))!.status).toBe('running');
  });

  it('when due and undelivered, nudges her once; the owner hears later if still nothing', async () => {
    const h = harness();
    await ticket(h);
    await h.service.onAgentMessage(interim(h, EVE_INTERIM));
    h.clock.now = new Date(h.clock.now.getTime() + 31 * MIN);
    expect((await h.service.sweep()).nudged).toBe(1);
    expect(h.woken.at(-1)!.session).toBe(EVE);
    expect((await h.service.sweep()).nudged).toBe(0);
    h.clock.now = new Date(h.clock.now.getTime() + 3 * HOUR);
    await h.service.sweep();
    expect(h.ownerNotes).toHaveLength(1);
  });

  it('takes no questions from an interim note, and an interim note never delivers', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(interim(h, '收到。第 13 章这个读法，你同意吗？我先改别的。', 'i-1'));
    expect(h.cards).toHaveLength(0);
    await h.service.onAgentMessage(msg(h, '大约 40 分钟后发你 PDF。', ATLAS, 'p-1'));
    h.clock.now = new Date(h.clock.now.getTime() + 35 * MIN);
    await h.service.onAgentMessage({ ...msg(h, 'PDF 在这里，第 7 章改了。', ATLAS, 'i-2'), metadata: { interim: true } });
    expect((await h.requests.getById(t.id))!.openItems!.find((i) => i.sourceMessageId === 'p-1')!.status).toBe('open');
  });

  it('her next substantive reply in the thread delivers it at once (no 2-minute gap)', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(interim(h, EVE_INTERIM));
    h.clock.now = new Date(h.clock.now.getTime() + 20_000);
    await h.service.onAgentMessage(interim(h, '数据盘点还在跑，我先写政策这一节。', 'i-2'));
    expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('open');
    await h.service.onAgentMessage(msg(h, '方案文档写好了：每天、每周、每月的信号和数据来源都在里面。https://claude.ai/artifact/6RVjSLjKfmMhEmprPCaR8V', EVE, 'final'));
    const item = (await h.requests.getById(t.id))!.openItems![0];
    expect(item.status).toBe('delivered');
    expect(h.closed).toEqual([{ id: 'fu-1', outcome: 'delivered' }]);
  });

  it.each([
    ['on it, I\'ll report back in 30 minutes'],
    ['收到，稍后回复你'],
    ['好的，我看一下，晚点回你一句'],
    ['On it — I\'ll let you know in an hour'],
    ['我先看看系统里的数据'],
  ])('an interim "%s" creates no commitment', async (text) => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(interim(h, text, `x-${text.length}`));
    expect((await h.requests.getById(t.id))!.openItems ?? []).toEqual([]);
    expect(h.followUps).toHaveLength(0);
  });

  it('isConcreteInterimPromise: an explicit time and a concrete deliverable', () => {
    expect(isConcreteInterimPromise({ text: '大约 20–30 分钟后把方案文档发到这里。', dueSource: 'text' })).toBe(true);
    expect(isConcreteInterimPromise({ text: "I'll send the draft in 30 minutes", dueSource: 'text' })).toBe(true);
    expect(isConcreteInterimPromise({ text: "I'll report back in 30 minutes", dueSource: 'text' })).toBe(false);
    expect(isConcreteInterimPromise({ text: '30 分钟后汇报', dueSource: 'text' })).toBe(false);
    expect(isConcreteInterimPromise({ text: "I'll send the draft", dueSource: 'default' })).toBe(false);
  });
});

describe('Open items after a restart (PR #1013 review)', () => {
  const EVE = 'evership-eve-398f05df';

  /**
   * A ticket with one commitment by Eve.
   *
   * @param h - Harness
   * @param item - Overrides for the item
   * @returns The request
   */
  async function withPromise(h: Harness, item: Partial<RequestOpenItem>): Promise<Request> {
    const t = await ticket(h);
    const base: RequestOpenItem = {
      id: 'c-1',
      type: 'commitment',
      text: '大约 20–30 分钟后把方案文档发到这里。',
      agent: EVE,
      sourceMessageId: 'a81b0422',
      createdAt: new Date(h.clock.now.getTime() - HOUR).toISOString(),
      status: 'open',
      due: new Date(h.clock.now.getTime() - 30 * MIN).toISOString(),
      dueSource: 'text',
    };
    return h.requests.update(t.id, { openItems: [{ ...base, ...item }] });
  }

  it('owedCommitments: only past-due, never-nudged, never-reminded promises on live tickets', async () => {
    const h = harness();
    const r = await withPromise(h, {});
    const now = h.clock.now;
    expect(owedCommitments([r], now)).toEqual([
      { sessionName: EVE, ticket: 'TKT-185', text: r.openItems![0].text, requestId: r.id, itemId: 'c-1', due: r.openItems![0].due },
    ]);
    const item = r.openItems![0];
    const variant = (over: Partial<RequestOpenItem>): Request => ({ ...r, openItems: [{ ...item, ...over }] });
    expect(owedCommitments([variant({ due: new Date(now.getTime() + MIN).toISOString() })], now)).toEqual([]); // not yet due
    expect(owedCommitments([variant({ nudgedAt: now.toISOString(), status: 'overdue' })], now)).toEqual([]); // the sweep's
    expect(owedCommitments([variant({ restartRemindedAt: now.toISOString() })], now)).toEqual([]); // reminded once already
    expect(owedCommitments([variant({ status: 'delivered' })], now)).toEqual([]);
    expect(owedCommitments([variant({ status: 'waiting_owner' })], now)).toEqual([]);
    expect(owedCommitments([{ ...r, status: 'cancelled' }], now)).toEqual([]);
  });

  it('markRestartReminded records the reminder as the one nudge, once; the sweep then nudges no more', async () => {
    const h = harness();
    const r = await withPromise(h, {});
    expect(await markRestartReminded(h.requests, r.id, 'c-1', h.clock.now)).toBe(true);
    expect(await markRestartReminded(h.requests, r.id, 'c-1', h.clock.now)).toBe(false);
    const item = (await h.requests.getById(r.id))!.openItems![0];
    expect(item).toMatchObject({ status: 'overdue', nudgedAt: h.clock.now.toISOString(), restartRemindedAt: h.clock.now.toISOString() });
    expect(owedCommitments([(await h.requests.getById(r.id))!], h.clock.now)).toEqual([]);
    expect((await h.service.sweep()).nudged).toBe(0);
    expect(h.woken).toEqual([]);
  });

  it('markRestartReminded refuses a promise the sweep already nudged', async () => {
    const h = harness();
    const r = await withPromise(h, { status: 'overdue', nudgedAt: h.clock.now.toISOString() });
    expect(await markRestartReminded(h.requests, r.id, 'c-1', h.clock.now)).toBe(false);
    expect(await markRestartReminded(h.requests, 'nope', 'c-1', h.clock.now)).toBe(false);
  });

  it('the service markRestartReminded is serialized with the sweep: one nudge or one reminder, never both', async () => {
    const h = harness();
    const r = await withPromise(h, {});
    const [sweep, reminded] = await Promise.all([h.service.sweep(), h.service.markRestartReminded(r.id, 'c-1')]);
    expect(sweep.nudged).toBe(1);
    expect(reminded).toBe(false);
    const h2 = harness();
    const r2 = await withPromise(h2, {});
    const [reminded2, sweep2] = await Promise.all([h2.service.markRestartReminded(r2.id, 'c-1'), h2.service.sweep()]);
    expect(reminded2).toBe(true);
    expect(sweep2.nudged).toBe(0);
    expect((await h2.requests.getById(r2.id))!.openItems![0].restartRemindedAt).toBe(h2.clock.now.toISOString());
  });
});

describe('OpenItemsService — the prompt reference is recorded only once the prompt was delivered (2026-10-02)', () => {
  it('a follow-up that could not reach the agent leaves no reference; a delivered one leaves it with its marker', async () => {
    AgentPromptReferenceService.resetInstance();
    const down = harness({ deliverToAgent: async () => false });
    const t = await ticket(down, 'done');
    const wi = kaiWork(down, t.id);
    await down.service.onAgentMessage(msg(down, ATLAS_REPLY));
    down.clock.now = new Date(2026, 9, 1, 18, 17, 10);
    wi.status = 'verified';
    wi.completedAt = down.clock.now.toISOString();
    await down.service.onWorkItemSettled(wi.id);
    expect(AgentPromptReferenceService.getInstance().get(ATLAS)).toBeUndefined();

    const up = harness();
    const t2 = await ticket(up, 'done');
    const wi2 = kaiWork(up, t2.id);
    await up.service.onAgentMessage(msg(up, ATLAS_REPLY));
    up.clock.now = new Date(2026, 9, 1, 18, 17, 10);
    wi2.status = 'verified';
    wi2.completedAt = up.clock.now.toISOString();
    await up.service.onWorkItemSettled(wi2.id);
    expect(AgentPromptReferenceService.getInstance().get(ATLAS)?.marker).toBe('[FOLLOW-UP TKT-185]');
  });
});

describe('OpenItemsService — a commitment closes only on a post that plausibly fulfils it (2026-10-02)', () => {
  it('an unrelated post does not close a "send the preview" promise; the preview link does', async () => {
    const h = harness();
    const t = await ticket(h, 'done');
    await h.service.onAgentMessage(msg(h, '好，我 40 分钟后把预览发你。'));
    h.clock.now = new Date(h.clock.now.getTime() + 35 * MIN);
    await h.service.onAgentMessage(msg(h, '另外，第三章的排版我也顺手调了一下字号和行距。'));
    expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('open');
    h.clock.now = new Date(h.clock.now.getTime() + 5 * MIN);
    await h.service.onAgentMessage(msg(h, '这里：https://preview.example.com/ch3'));
    expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('delivered');
  });

  it('a post the harness marked as the ticket delivery (reply --ticket) closes it', async () => {
    const h = harness();
    const t = await ticket(h, 'done');
    await h.service.onAgentMessage(msg(h, '好，我 40 分钟后把预览发你。'));
    h.clock.now = new Date(h.clock.now.getTime() + 35 * MIN);
    await h.service.onAgentMessage({ ...msg(h, '在这'), metadata: { deliversTicket: 'TKT-185' } });
    expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('delivered');
  });

  it('plausiblyFulfils', () => {
    expect(plausiblyFulfils('40 分钟后发你 PDF', { content: 'PDF 在这里' })).toBe(true);
    expect(plausiblyFulfils('send you the preview', { content: 'still working on chapter 3' })).toBe(false);
    expect(plausiblyFulfils('send you the preview', { content: 'here', metadata: { attachments: [{ id: 'f' }] } })).toBe(true);
    expect(plausiblyFulfils('明天中午给我，我核过以后挑最有用的几条发你', { content: '收到' })).toBe(false);
    expect(plausiblyFulfils('明天中午给我，我核过以后挑最有用的几条发你', { content: '你要发到哪个频道？' })).toBe(false);
    expect(plausiblyFulfils('明天中午给我，我核过以后挑最有用的几条发你', { content: '四集里能进书的原话挑了 6 条，按章节放在下面。' })).toBe(true);
  });
});

describe('OpenItemsService — questions', () => {
  it('becomes a card in the ticket thread with the derived options and default', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, '第 13 章「互评当体检用」这个读法，你同意吗？不同意的话我就删掉，只留事实。'));
    expect(h.cards).toHaveLength(1);
    const c = h.cards[0];
    expect(c.place).toEqual({ slackChannelId: 'C0C67371YUC', threadTs: '1790884910.228259' });
    expect(c.item.agent).toBe(ATLAS);
    expect(c.card.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(c.card.options[1].detail).toBe('删掉，只留事实');
    expect(c.card.defaultKey).toBe('b');
    expect(c.request.id).toBe(t.id);
  });

  it('D-52: a question that points back carries the context the owner needs', async () => {
    const h = harness();
    const t = await h.requests.create({
      sourceConversationItemId: 'src-d52',
      title: 'codex agent for CE',
      description: '可以在ce的团队下添加一个codex agent吗？',
      ticketNumber: 32,
      requiresConfirmation: true,
      origin: { channel: 'slack-dm', ref: 'r', threadRef: 'slack:D0C381XPD3L:1790392986.498639', author: 'UOWNER' },
      assignee: 'crewly-orc',
    });
    await h.requests.update(t.id, { status: 'running', chatRef: { channelId: CHANNEL, messageId: ROOT, threadRootId: ROOT } });
    await h.service.onAgentMessage(msg(h, '关于在 CE 团队下加一个 codex agent 这件事——你看这样安排行不行？如果 OK 我就让人去建了。', 'crewly-orc'));
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0].card.question).toBe('关于在 CE 团队下加一个 codex agent 这件事——你看这样安排行不行？');
    expect(h.cards[0].card.context).toEqual([
      '*Context:* 可以在ce的团队下添加一个codex agent吗？ — reply in thread to ask crewly-orc for details',
      '_Full message in Crewly chat._',
    ]);
  });

  it('a question with nothing before it still says what it is about', async () => {
    const h = harness();
    await ticket(h);
    await h.service.onAgentMessage(msg(h, '第 13 章「互评当体检用」这个读法，你同意吗？不同意的话我就删掉，只留事实。'));
    expect(h.cards[0].card.context).toEqual(['*Context:* 我第二工位的播客也可以作为素材 — reply in thread to ask Atlas for details', '_Full message in Crewly chat._']);
  });

  describe('TKT-072: a question lifted out of a message stands on its own', () => {
    const T72 = '要不要按这个草稿回，还是你想换个说法？';
    const DRAFT = '给 Mia 的回复草稿：\n\n谢谢提醒，那条帖子是我们的自动化误发的，已经删掉了。\n\n' + T72;

    it('in the ticket thread: About + the draft + a permalink to the Slack message', async () => {
      const h = harness();
      await ticket(h);
      const m = msg(h, DRAFT);
      m.metadata = { slackThreadKey: 'C0C67371YUC:1790884910.228259', slackTs: '1790890000.000200' };
      await h.service.onAgentMessage(m);
      const c = h.cards[0];
      expect(c.place).toEqual({ slackChannelId: 'C0C67371YUC', threadTs: '1790884910.228259' });
      expect(c.card.context).toEqual([
        '*About:* 我第二工位的播客也可以作为素材',
        '_Atlas wrote:_\n> 给 Mia 的回复草稿：\n> 谢谢提醒，那条帖子是我们的自动化误发的，已经删掉了。',
        "<https://slack.com/archives/C0C67371YUC/p1790890000000200?thread_ts=1790884910.228259&cid=C0C67371YUC|Open Atlas's full message>",
      ]);
    });

    /** A top-level post in the ticket's chat channel, mirrored to another Slack thread. */
    const elsewhere = (h: Harness): OpenItemsChatMessage => ({
      id: `m-top-${Math.random().toString(36).slice(2)}`,
      channelId: CHANNEL,
      senderType: 'agent',
      senderId: ATLAS,
      content: DRAFT,
      createdAt: h.clock.now.getTime(),
      metadata: { slackChannelId: 'C0C67371YUC', slackThreadTs: '1791000000.000100' },
    });

    it('asked elsewhere: the card goes where the agent asked, linking the ticket thread', async () => {
      const h = harness();
      await ticket(h);
      await h.service.onAgentMessage(elsewhere(h));
      expect(h.cards).toHaveLength(1);
      const c = h.cards[0];
      expect(c.place).toEqual({ slackChannelId: 'C0C67371YUC', threadTs: '1791000000.000100' });
      expect(c.card.context?.[c.card.context.length - 1]).toBe(
        "<https://slack.com/archives/C0C67371YUC/p1791000000000100|Open Atlas's full message> · <https://slack.com/archives/C0C67371YUC/p1790884910228259|Earlier ticket thread>",
      );
    });

    it('asked elsewhere, not mirrored to Slack: no place (the agent\'s own conversation), never the ticket thread', async () => {
      const h = harness();
      await ticket(h);
      await h.service.onAgentMessage({ ...elsewhere(h), metadata: {} });
      expect(h.cards[0].place).toBeNull();
      expect(h.cards[0].card.context).toContain('_Full message in Crewly chat._ · <https://slack.com/archives/C0C67371YUC/p1790884910228259|Earlier ticket thread>');
    });

    it('asked elsewhere while the ticket thread is still active: the card still goes where the agent asked (2026-10-08: 12 of 17 checkable cards landed in the wrong thread)', async () => {
      const h = harness();
      await ticket(h);
      await h.service.onAgentMessage(elsewhere(h));
      expect(h.cards[0].place).toEqual({ slackChannelId: 'C0C67371YUC', threadTs: '1791000000.000100' });
    });
  });

  it('the answer closes the item and goes to the agent; the ticket then closes', async () => {
    const h = harness();
    const t = await ticket(h, 'done');
    await h.service.onAgentMessage(msg(h, '第 13 章「互评当体检用」这个读法，你同意吗？不同意的话我就删掉，只留事实。'));
    const item = (await h.requests.getById(t.id))!.openItems![0];
    const decision = {
      id: 'D-1',
      question: item.text,
      options: [
        { key: 'a', label: 'Yes' },
        { key: 'b', label: 'No', detail: '删掉，只留事实' },
      ],
      status: 'resolved',
      chosenKey: 'a',
      requestRef: { requestId: t.id, itemId: item.id },
    } as unknown as OwnerDecision;
    const note = await h.service.onDecisionSettled(decision, '[DECISION D-1] The owner chose "Yes" …');
    expect(note).toBe('[DECISION D-1] The owner chose "Yes" …');
    await h.service.sweep(); // let the queued write land
    const r = (await h.requests.getById(t.id))!;
    expect(r.openItems![0]).toMatchObject({ status: 'resolved', answer: 'Yes' });
    expect(r.status).toBe('done');
  });

  it('no second card when the agent already asked the same question with ask-owner', async () => {
    const h = harness();
    await ticket(h);
    h.decisions.push({
      id: 'D-7',
      asker: ATLAS,
      question: '第 13 章「互评当体检用」这个读法你同意吗',
      createdAt: new Date(h.clock.now.getTime() - 2 * MIN).toISOString(),
      status: 'open',
    } as OwnerDecision);
    const r = await h.service.onAgentMessage(msg(h, '第 13 章「互评当体检用」这个读法，你同意吗？'));
    expect(h.cards).toHaveLength(0);
    expect(r!.openItems![0].decisionId).toBe('D-7');
  });

  it('withdrawn (superseded by ask-owner): the agent gets no note', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, '这个读法你同意吗？'));
    const item = (await h.requests.getById(t.id))!.openItems![0];
    const note = await h.service.onDecisionSettled(
      { id: 'D-1', question: item.text, options: [], status: 'cancelled', requestRef: { requestId: t.id, itemId: item.id } } as unknown as OwnerDecision,
      null,
    );
    expect(note).toBeNull();
    await h.service.sweep();
    expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('superseded');
  });
});

describe('backfill (dry run)', () => {
  it('reports the TKT-185 promise (wake now: work ready) and question (card) without changing anything', async () => {
    const h = harness();
    const t = await ticket(h, 'done');
    const wi = kaiWork(h, t.id, 'verified');
    wi.completedAt = new Date(2026, 9, 1, 18, 17, 10).toISOString();
    const promiseAt = h.clock.now.getTime();
    const thread: OpenItemsChatMessage[] = [
      { id: ROOT, channelId: CHANNEL, senderType: 'user', senderId: 'UOWNER', content: '我第二工位的播客也可以作为素材', createdAt: promiseAt - 4 * MIN },
      { id: 'early', channelId: CHANNEL, threadId: ROOT, senderType: 'agent', senderId: ATLAS, content: '大约 40 分钟后发你 PDF。', createdAt: promiseAt - 3 * HOUR },
      { id: 'pdf', channelId: CHANNEL, threadId: ROOT, senderType: 'agent', senderId: ATLAS, content: 'PDF 在下面。', createdAt: promiseAt - 2 * HOUR },
      { id: 'atlas', channelId: CHANNEL, threadId: ROOT, senderType: 'agent', senderId: ATLAS, content: ATLAS_REPLY, createdAt: promiseAt },
    ];
    h.clock.now = new Date(2026, 9, 1, 19, 15, 0);
    const adopt = jest.spyOn(h.service, 'adopt');
    const report = await backfillOpenItems({
      service: h.service,
      listRequests: () => h.requests.listAll(),
      listWorkItems: async () => h.pool,
      listThread: async () => thread,
      now: () => h.clock.now,
    });
    expect(report.dryRun).toBe(true);
    expect(adopt).not.toHaveBeenCalled();
    expect(h.cards).toHaveLength(0);
    expect(h.followUps).toHaveLength(0);
    expect((await h.requests.getById(t.id))!.status).toBe('done');

    const live = report.rows.filter((r) => !r.skipped);
    expect(live.map((r) => r.type)).toEqual(['commitment', 'question']);
    expect(live[0].text).toBe('明天中午给我，我核过以后挑最有用的几条发你。');
    expect(live[0].action).toContain(`wake ${ATLAS} now — the work is ready`);
    expect(live[1].action).toContain('Yes / No (删掉，只留事实); default No');
    expect(report.reopened).toEqual(['TKT-185 (' + t.id.slice(0, 8) + ')']);
    // The early promise was delivered by the PDF post: skipped.
    expect(report.rows.find((r) => r.text === '大约 40 分钟后发你 PDF。')?.skipped).toMatch(/^delivered by/);
    expect(formatBackfillReport(report)).toContain('DRY RUN — nothing changed');
  });
});

describe('Skip (specs/2026-10-01-decision-skip.md)', () => {
  const OWNER = 'UOWNER';
  const QUESTION = '第 13 章「互评当体检用」这个读法，你同意吗？';

  /** Slack Web API double. */
  class FakeSlack implements DecisionSlackApi {
    sent: SlackOutgoingMessage[] = [];
    updates: Array<{ ts: string; text: string; blocks?: SlackBlock[] }> = [];
    private n = 0;
    isConnected(): boolean {
      return true;
    }
    async sendMessage(m: SlackOutgoingMessage): Promise<string> {
      this.sent.push(m);
      this.n += 1;
      return `500.${String(this.n).padStart(4, '0')}`;
    }
    async updateMessage(_c: string, ts: string, text: string, blocks?: SlackBlock[]): Promise<void> {
      this.updates.push({ ts, text, blocks });
    }
  }

  /**
   * Open items over a real DecisionService (fs mocked), wired the way
   * open-items.wiring.ts wires them.
   */
  function wired() {
    const slack = new FakeSlack();
    const toAgents: Array<{ session: string; text: string }> = [];
    const box = {} as { h: Harness };
    const clock = () => box.h.clock.now;
    const decisions = new DecisionService({
      store: new DecisionStore('/tmp/open-items-test/decisions.json', clock),
      threads: TicketThreadStore.inHome('/tmp/open-items-test'),
      slack: () => slack,
      instanceId: () => 'inst',
      isOwner: (u) => u === OWNER,
      ownerUserId: () => OWNER,
      userName: async () => 'Steve',
      identityOf: async () => ({ botToken: 'xoxb-atlas' }),
      teamChannelOf: async () => null,
      teamOf: async () => undefined,
      resolveTicket: async () => {
        throw new Error('no tickets here');
      },
      markTicketAsked: async () => undefined,
      logTicket: async () => undefined,
      deliverToAgent: async (session, text) => (toAgents.push({ session, text }), true),
      now: clock,
      logger: quiet(),
    });
    const h = harness({
      askQuestion: (q) =>
        decisions.askPrebuilt({
          kind: 'reply_question',
          asker: q.item.agent,
          question: q.card.question,
          options: q.card.options,
          defaultKey: q.card.defaultKey,
          deadline: new Date(clock().getTime() + 26 * HOUR),
          ...(q.place ? { place: q.place } : {}),
          requestRef: { requestId: q.request.id, itemId: q.item.id },
          source: q.source ?? 'live',
          askedAt: q.item.createdAt,
        }),
      skippedQuestion: async (requestId, agent, question) => decisions.findSkipped({ requestId, asker: agent }, question),
      skipQuestion: async (id) => {
        const d = await decisions.get(id);
        if (!d || d.status !== 'open') return false;
        await decisions.skipFromDashboard(id);
        return true;
      },
      getDecision: (id) => decisions.get(id),
    });
    box.h = h;
    DecisionService.registerKindHandler('reply_question', { onSettled: (d, fallback) => h.service.onDecisionSettled(d, fallback) });
    return { h, decisions, slack, toAgents };
  }
  afterEach(() => DecisionService.registerKindHandler('reply_question', null));

  it('skipping the card (thread reply 「不用了」) closes the item as skipped, completes the request, tells the agent once; the re-ask is suppressed', async () => {
    const { h, decisions, slack, toAgents } = wired();
    const t = await ticket(h, 'done');
    await h.service.onAgentMessage(msg(h, QUESTION));
    expect((await h.requests.getById(t.id))!.status).toBe('awaiting_followup');
    const card = slack.sent.at(-1)!;
    expect(JSON.stringify(card.blocks)).toContain('decision:skip');
    const item = (await h.requests.getById(t.id))!.openItems![0];
    const d = (await decisions.get(item.decisionId!))!;
    expect(d).toMatchObject({ source: 'live', askedAt: item.createdAt });

    const out = await decisions.handleThreadReply({ channelId: 'C0C67371YUC', threadTs: '1790884910.228259', ts: '600.1', text: '不用了', userId: OWNER });
    expect(out).toMatchObject({ handled: true, reason: 'skipped' });
    await h.service.sweep(); // let the queued write land
    const r = (await h.requests.getById(t.id))!;
    expect(r.openItems![0]).toMatchObject({ status: 'skipped', closedReason: `${d.id} skipped` });
    expect(r.status).toBe('done');
    expect(JSON.stringify(slack.updates.at(-1)!.blocks)).toContain('⤼ Steve skipped this');
    expect(toAgents).toHaveLength(1);
    expect(toAgents[0]).toMatchObject({ session: ATLAS });
    expect(toAgents[0].text).toContain("The owner skipped this — drop it, don't ask again");

    // Atlas asks the same thing again: no new card, tracked as skipped, the ticket stays done.
    const cardsBefore = slack.sent.length;
    h.clock.now = new Date(h.clock.now.getTime() + 3 * HOUR);
    await h.service.onAgentMessage(msg(h, '第 13 章「互评当体检用」这个读法你同意吗？'));
    expect(slack.sent.length).toBe(cardsBefore);
    const again = (await h.requests.getById(t.id))!;
    expect(again.openItems!.at(-1)).toMatchObject({ status: 'skipped', decisionId: d.id });
    expect(again.status).toBe('done');
    expect(toAgents).toHaveLength(1);
  });

  it.each([
    ['要我按这个把晚餐卡改掉吗？还是先按现在的版本试一周再看？', ['按这个把晚餐卡改掉', '先按现在的版本试一周再看'], '还是先按现在的版本试一周再看？'],
    ['Should I ship it today? Or wait for the review?', ['ship it today', 'wait for the review'], 'Or wait for the review?'],
  ])('either/or questions in one reply are ONE card; the agent gets the chosen alternative quoted (%s)', async (reply, labels, secondFull) => {
    const { h, decisions, toAgents } = wired();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, reply));
    const items = (await h.requests.getById(t.id))!.openItems!.filter((i) => i.type === 'question');
    expect(items).toHaveLength(1);
    const d = (await decisions.get(items[0].decisionId!))!;
    expect(d.options.map((o) => o.label)).toEqual([...labels, 'Reply in thread']);
    expect((await decisions.list('open')).filter((x) => x.kind === 'reply_question')).toHaveLength(1);
    await decisions.chooseFromDashboard(d.id, 'b');
    await h.service.sweep();
    expect(toAgents.at(-1)!.text).toContain(`they picked: "${secondFull}"`);
  });

  it('skipping a question item from the Requests UI skips its card (one note to the agent)', async () => {
    const { h, decisions, toAgents } = wired();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, QUESTION));
    const item = (await h.requests.getById(t.id))!.openItems![0];
    const closed = await h.service.skipItem(t.id, item.id);
    expect(closed.status).toBe('skipped');
    expect((await decisions.get(item.decisionId!))!.status).toBe('skipped');
    expect(toAgents).toHaveLength(1);
  });

  it('skipping a promise closes it, cancels its follow-up WorkItem and tells the agent once; the request completes', async () => {
    const h = harness();
    const t = await ticket(h, 'done');
    await h.service.onAgentMessage(msg(h, '明天中午给你最终版 PDF。'));
    const item = (await h.requests.getById(t.id))!.openItems![0];
    expect(item).toMatchObject({ type: 'commitment', workItemId: 'fu-1' });
    expect((await h.requests.getById(t.id))!.status).toBe('awaiting_followup');
    const closed = await h.service.skipItem(t.id, item.id);
    expect(closed).toMatchObject({ status: 'skipped', closedReason: 'skipped by the owner' });
    expect(h.closed).toEqual([{ id: 'fu-1', outcome: 'cancelled' }]);
    expect(h.woken).toHaveLength(1);
    expect(h.woken[0]).toMatchObject({ session: ATLAS });
    expect(h.woken[0].text).toMatch(/^\[FOLLOW-UP TKT-185\] The owner skipped this — drop it, don't ask again\./);
    expect((await h.requests.getById(t.id))!.status).toBe('done');
    // A second skip is refused; unknown ids are 404.
    await expect(h.service.skipItem(t.id, item.id)).rejects.toMatchObject({ status: 409 });
    await expect(h.service.skipItem(t.id, 'c-nope')).rejects.toMatchObject({ status: 404 });
    await expect(h.service.skipItem('nope', item.id)).rejects.toMatchObject({ status: 404 });
  });

  it('a skipped ask-owner decision closes its linked item as skipped on the sweep', async () => {
    const h = harness({ getDecision: async (id) => ({ id, status: 'skipped', options: [] }) as unknown as OwnerDecision });
    const t = await ticket(h);
    h.decisions.push({ id: 'D-7', asker: ATLAS, question: QUESTION, createdAt: h.clock.now.toISOString(), status: 'open' } as OwnerDecision);
    await h.service.onAgentMessage(msg(h, QUESTION));
    await h.service.sweep();
    expect((await h.requests.getById(t.id))!.openItems![0]).toMatchObject({ status: 'skipped', decisionId: 'D-7' });
  });
});

describe('backfill hygiene (specs/2026-10-01-decision-skip.md §4)', () => {
  const ORC = 'crewly-orc';

  it('recognises login prompts and settled reports', () => {
    expect(isHarnessFlowQuestion(ORC, 'Claude Code 的登录链接已经发过去了，你那边登上了吗？')).toBe(true);
    expect(isHarnessFlowQuestion(ORC, 'Did you log in?')).toBe(true);
    expect(isHarnessFlowQuestion(ATLAS, 'Codex needs a re-login — can you sign in on the Mac?')).toBe(true);
    expect(isHarnessFlowQuestion(ATLAS, '这个读法，你同意吗？')).toBe(false);
    expect(isHarnessFlowQuestion(ORC, 'Should I archive the Think Tank team?')).toBe(false);
    expect(reportsSettled('Logged in — Ella is back.')).toBe(true);
    expect(reportsSettled('搞定了，已经登上')).toBe(true);
    expect(reportsSettled('还在跑，等一下')).toBe(false);
  });

  it('skips harness login prompts and questions resolved later in the thread; marks the rest as backfill', async () => {
    const h = harness();
    const t = await ticket(h);
    const at = h.clock.now.getTime() - 2 * HOUR;
    const thread: OpenItemsChatMessage[] = [
      { id: ROOT, channelId: CHANNEL, senderType: 'user', senderId: 'UOWNER', content: '帮我重新登录 claude', createdAt: at - 10 * MIN },
      { id: 'login', channelId: CHANNEL, threadId: ROOT, senderType: 'agent', senderId: ATLAS, content: 'Claude Code 的登录链接已经发过去了，你那边登上了吗？', createdAt: at },
      { id: 'q1', channelId: CHANNEL, threadId: ROOT, senderType: 'agent', senderId: ATLAS, content: '要不要我把旧的 PDF 也删掉？', createdAt: at + MIN },
      { id: 'fixed', channelId: CHANNEL, threadId: ROOT, senderType: 'agent', senderId: KAI, content: '旧 PDF 已经处理好了，删掉了。', createdAt: at + 20 * MIN },
      { id: 'q2', channelId: CHANNEL, threadId: ROOT, senderType: 'agent', senderId: ATLAS, content: QUESTION_13, createdAt: at + 30 * MIN },
    ];
    const deps = {
      service: h.service,
      listRequests: () => h.requests.listAll(),
      listWorkItems: async () => h.pool,
      listThread: async () => thread,
      now: () => h.clock.now,
    };
    const report = await backfillOpenItems(deps);
    const byText = (s: string) => report.rows.find((r) => r.text.includes(s))!;
    expect(byText('登录链接').skipped).toBe('harness flow (a login prompt), not an owner decision');
    expect(byText('旧的 PDF').skipped).toMatch(/^resolved later in the thread \(/);
    expect(byText('互评当体检用').skipped).toBeUndefined();

    await backfillOpenItems(deps, { apply: true });
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]).toMatchObject({ source: 'backfill' });
    expect(h.cards[0].card.question).toContain('互评当体检用');
    expect((await h.requests.getById(t.id))!.openItems!.map((i) => i.text)).toEqual([QUESTION_13]);
  });
});

const QUESTION_13 = '第 13 章「互评当体检用」这个读法，你同意吗？';

describe('already-delivered promises (TKT-186 shape) and restart', () => {
  const SAGE = 'think-tank-sage-2ffacc8f';
  const PROMISE = '好，我请 Sage 去查原文，40 分钟后发你结论。';
  const DELIVERY = 'SpaceX 那条看完了。结论在下面：1,800 次是论文里的一个假设。';

  /** TKT-186: the promise, Sage's verified child, Atlas's delivery posted before the verify stamped completedAt. */
  async function tkt186(h: Harness) {
    const t = await ticket(h, 'done');
    const promiseAt = new Date(2026, 9, 1, 22, 11, 29).getTime();
    const wi = createWorkItem({ type: 'delegate', owner: 'team_lead', target: SAGE, requestId: t.id, title: 'Starship 1,800 launches' });
    wi.status = 'verified';
    wi.createdAt = new Date(2026, 9, 1, 22, 11, 43).toISOString();
    wi.completedAt = new Date(2026, 9, 1, 22, 16, 15).toISOString(); // stamped by the verify, after the post
    h.pool.push(wi);
    const thread: OpenItemsChatMessage[] = [
      { id: ROOT, channelId: CHANNEL, senderType: 'user', senderId: 'UOWNER', content: 'SpaceX 那个可以了解一下吗', createdAt: promiseAt - 10_000 },
      { id: 'promise', channelId: CHANNEL, threadId: ROOT, senderType: 'agent', senderId: ATLAS, content: PROMISE, createdAt: promiseAt },
      { id: 'delivery', channelId: CHANNEL, threadId: ROOT, senderType: 'agent', senderId: ATLAS, content: DELIVERY, createdAt: new Date(2026, 9, 1, 22, 15, 48).getTime() },
    ];
    h.clock.now = new Date(2026, 9, 2, 0, 4, 50);
    return { t, thread };
  }
  const run = (h: Harness, thread: OpenItemsChatMessage[], apply = true) =>
    backfillOpenItems({ service: h.service, listRequests: () => h.requests.listAll(), listWorkItems: async () => h.pool, listThread: async () => thread, now: () => h.clock.now }, { apply });

  it('does not create a follow-up for a promise delivered in the same thread', async () => {
    const h = harness();
    const { t, thread } = await tkt186(h);
    const report = await run(h, thread);
    expect(h.followUps).toHaveLength(0);
    expect(report.rows.find((r) => r.text.includes('40 分钟后'))?.skipped).toMatch(/^delivered by/);
    expect((await h.requests.getById(t.id))!.status).toBe('done');
  });

  it('still creates a follow-up when nothing was posted after the promise (TKT-097)', async () => {
    const h = harness();
    const { t, thread } = await tkt186(h);
    const report = await run(h, thread.slice(0, 2));
    expect(h.followUps).toHaveLength(1);
    expect(report.rows.filter((r) => !r.skipped)).toHaveLength(1);
    expect((await h.requests.getById(t.id))!.status).toBe('awaiting_followup');
  });

  it('does not back-fill a promise older than the cutoff', async () => {
    const h = harness();
    const { thread } = await tkt186(h);
    h.clock.now = new Date(2026, 9, 3, 6, 0, 0); // ~32h later
    await h.requests.update((await h.requests.listAll())[0].id, { updatedAt: h.clock.now.toISOString() } as never).catch(() => undefined);
    const report = await run(h, thread.slice(0, 2));
    expect(h.followUps).toHaveLength(0);
    expect(report.rows).toHaveLength(0);
  });

  it('lets the owning agent close a blocked follow-up, and nobody else', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, PROMISE, ATLAS, 'p1'));
    const item = (await h.requests.getById(t.id))!.openItems![0];
    expect(item.workItemId).toBe('fu-1');
    expect(await h.service.closeByAgent('fu-1', KAI, 'x')).toBe(false);
    expect(await h.service.closeByAgent('fu-1', ATLAS, 'already delivered in the thread')).toBe(true);
    const after = (await h.requests.getById(t.id))!;
    expect(after.openItems![0].status).toBe('delivered');
    expect(h.closed).toContainEqual({ id: 'fu-1', outcome: 'delivered' });
    expect(await h.service.closeByAgent('fu-1', ATLAS, 'again')).toBe(false);
  });

  it('a restart creates no follow-ups for delivered promises, and a second start is idempotent', async () => {
    const h = harness();
    const { thread } = await tkt186(h);
    const listThread = jest.fn(async () => thread);
    for (let boot = 0; boot < 2; boot++) {
      h.service.start();
      h.service.start(); // double start: one timer
      await h.service.sweep();
      h.service.stop();
    }
    expect(h.followUps).toHaveLength(0);
    expect(h.woken).toHaveLength(0);
    expect(h.cards).toHaveLength(0);
    expect(listThread).not.toHaveBeenCalled(); // nothing on start reads threads: no backfill
    expect((await h.requests.listAll())[0].openItems ?? []).toHaveLength(0);
  });
});

describe('a cancelled or done follow-up stops every nudge', () => {
  const cases = [
    { tkt: 'TKT-162', wiId: 'efa71ad6-0000-4000-8000-000000000162', text: '大概 20 分钟后发你结果。', status: 'cancelled' as const },
    { tkt: 'TKT-036', wiId: '6a33d5ba-0000-4000-8000-000000000036', text: '部署完成后大约 30 分钟后发你确认。', status: 'cancelled' as const },
    { tkt: 'done', wiId: 'dddddddd-0000-4000-8000-000000000001', text: '大概 20 分钟后发你结果。', status: 'done' as const },
  ];
  it.each(cases)('$tkt ($status follow-up): the overdue timer fires and nothing is sent', async ({ wiId, text, status }) => {
    const h = harness({
      createFollowUp: async () => wiId,
    });
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, text, ATLAS, 'p'));
    const armed = (await h.requests.getById(t.id))!.openItems![0];
    expect(armed.workItemId).toBe(wiId);
    // The follow-up is finished elsewhere (cancel API / delivered), the open item was never told.
    const fu = createWorkItem({ id: wiId, type: 'delegate', owner: 'system', target: ATLAS, title: 'Follow-up' });
    fu.status = status;
    h.pool.push(fu);
    h.clock.now = new Date(h.clock.now.getTime() + 3 * HOUR);
    const counts = await h.service.sweep();
    h.clock.now = new Date(h.clock.now.getTime() + 4 * HOUR);
    await h.service.sweep();
    expect(h.woken).toHaveLength(0);
    expect(h.ownerNotes).toHaveLength(0);
    expect(counts.nudged).toBe(0);
    const item = (await h.requests.getById(t.id))!.openItems![0];
    expect(['cancelled', 'delivered']).toContain(item.status);
    expect(item.nudgedAt).toBeUndefined();
  });
});

describe('promises closed undelivered are told to the owner (crewly#1015 §10)', () => {
  const FU = 'fu-0000-4000-8000-000000001015';
  async function promised(h: Harness): Promise<Request> {
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, '大概 20 分钟后发你结果。', ATLAS, 'p'));
    expect((await h.requests.getById(t.id))!.openItems![0].workItemId).toBe(FU);
    return t;
  }
  function cancelled(h: Harness, by?: string, reason = 'manual close pending #923'): void {
    const fu = createWorkItem({ id: FU, type: 'delegate', owner: 'system', target: ATLAS, title: 'Follow-up' });
    fu.status = 'cancelled';
    fu.cancelReason = reason;
    if (by) fu.metadata = { ...(fu.metadata ?? {}), cancelledBy: by };
    h.pool.push(fu);
  }

  it('another agent cancelling the follow-up → one note to the owner, once', async () => {
    const h = harness({ createFollowUp: async () => FU, displayName: async (s) => (s === ATLAS ? 'Atlas' : s === 'sam-1' ? 'Sam' : s) });
    const t = await promised(h);
    cancelled(h, 'sam-1');
    await h.service.sweep();
    await h.service.sweep();
    expect(h.ownerNotes).toEqual([
      'Atlas\'s promise "大概 20 分钟后发你结果。" was closed without being delivered: Sam cancelled its follow-up ("manual close pending #923"). If you still want it, ask Atlas again.',
    ]);
    const item = (await h.requests.getById(t.id))!.openItems![0];
    expect(item.status).toBe('cancelled');
    expect(item.ownerNotifiedAt).toBeDefined();
  });

  it('the promising agent cancelling its own follow-up, the orchestrator (on the owner\'s word), or an unknown canceller stays quiet', async () => {
    for (const by of [ATLAS, 'crewly-orc', undefined]) {
      const h = harness({ createFollowUp: async () => FU });
      await promised(h);
      cancelled(h, by);
      await h.service.sweep();
      expect(h.ownerNotes).toEqual([]);
    }
  });

  it('a promise that expires without the owner ever being told is told once', async () => {
    const h = harness({ createFollowUp: async () => FU, postOwnerNote: async (_r, text) => (h.ownerNotes.push(text), true) });
    const t = await promised(h);
    // Keep it from going overdue: due far away (the extractor's default due is soon).
    const r = (await h.requests.getById(t.id))!;
    await h.requests.update(t.id, { openItems: r.openItems!.map((i) => ({ ...i, due: new Date(h.clock.now.getTime() + 30 * 24 * HOUR).toISOString() })) });
    h.clock.now = new Date(h.clock.now.getTime() + 8 * 24 * HOUR);
    await h.service.sweep();
    expect(h.ownerNotes).toHaveLength(1);
    expect(h.ownerNotes[0]).toContain('was closed without being delivered: nothing happened on it for 7 days');
    expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('expired');
  });
});

describe('question cards (2026-10-08 card hygiene)', () => {
  /** Atlas's TKT-xxx reply: interview questions for the owner's clients, then nothing for the owner. */
  const INTERVIEW =
    '收到，先去聊，聊之前我们这边什么都不做。\n\n*每个人都问这四个（10 分钟够了）*\n' +
    '1. 现在招生、接咨询这块是谁在做？一个月花多少钱？\n2. 外包或员工现在怎么跟你汇报：邮件、微信，还是开会？\n' +
    '3. 上一次你想换掉做这块的人，是因为什么？\n4. 上个月进来多少个咨询，最后成了几个？你自己知道吗？\n\n' +
    '问第二个问题时，把他的原话记下来。聊完直接给我发语音就行，不用整理。';

  it('interview questions written for the owner to ask his clients get no card', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, INTERVIEW));
    expect(h.cards).toHaveLength(0);
    expect(((await h.requests.getById(t.id))!.openItems ?? []).filter((i) => i.type === 'question')).toHaveLength(0);
  });

  it("an expired question closes its card (no live buttons on a question nobody tracks)", async () => {
    const cancelled: Array<[string, string | undefined]> = [];
    const h = harness({ cancelQuestion: async (id, note) => void cancelled.push([id, note]) });
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, '这样写可以吗？'));
    expect(h.cards).toHaveLength(1);
    h.clock.now = new Date(h.clock.now.getTime() + 8 * 24 * HOUR);
    await h.service.sweep();
    expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('expired');
    expect(cancelled).toEqual([['D-1', 'no longer needed']]);
  });
});

describe('PR2: restated delivery, waiting on the owner, duplicate promises, TKT-068/017', () => {
  const OWEN = 'ce-owen-ad0320ab';
  const PLAN_15C4EB57 = '前 2、4 条我让 Nova 写成文章补充（中文、繁体、英文三个版本），先给你看预览，你说可以再上线。';
  const REAL_2EA43C4F = '收到，按刚才说的做。Nova 在补体检指南里的三条（验毒和喝酒、中文疫苗本、预约排期），先逐条拿 CDC 指引核对，写完给你预览，你说可以再上线。';
  const GATED_77948B54 = '我倾向 1。你点头后，Sage 先查有多少公司真在这样考、有没有反例，结果发在这里，你看过再决定写不写。';
  const ownerMsg = (h: Harness, content: string, id = 'owner-1'): OpenItemsChatMessage => ({
    id, channelId: CHANNEL, threadId: ROOT, senderType: 'user', senderId: 'UOWNER', content, createdAt: h.clock.now.getTime(),
  });

  it('(a) a delivery that restates the promise does not open a new commitment', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, '好，我请 Sage 去查原文，40 分钟后发你结论。', ATLAS, 'promise'));
    h.clock.now = new Date(h.clock.now.getTime() + 20 * MIN);
    await h.service.onAgentMessage(msg(h, '好，我请 Sage 去查原文，40 分钟后发你结论。\n结论在下面：1,800 次是个假设。', ATLAS, 'delivery'));
    const items = (await h.requests.getById(t.id))!.openItems!;
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('delivered');
    expect(h.followUps).toHaveLength(1);
  });

  it('(a) a delivery that says "之前说…" is past tense, not a promise', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, '好，我请 Sage 去查原文，40 分钟后发你结论。', ATLAS, 'promise'));
    h.clock.now = new Date(h.clock.now.getTime() + 20 * MIN);
    await h.service.onAgentMessage(msg(h, '之前说 40 分钟后发你结论，现在结论在下面：1,800 次是个假设。', ATLAS, 'delivery'));
    const items = (await h.requests.getById(t.id))!.openItems!;
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('delivered');
  });

  it('(b) 15c4eb57 and 2ea43c4f are one promise: the newer one stands, exactly one is active', async () => {
    const h = harness({ createFollowUp: async (fu) => { h.followUps.push(fu); return `fu-${h.followUps.length}`; } });
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, PLAN_15C4EB57, OWEN, 'plan'));
    h.clock.now = new Date(h.clock.now.getTime() + 4 * MIN);
    await h.service.onAgentMessage(msg(h, REAL_2EA43C4F, OWEN, 'real'));
    const items = (await h.requests.getById(t.id))!.openItems!.filter((i) => i.type === 'commitment');
    const active = items.filter((i) => ['open', 'overdue', 'ready'].includes(i.status));
    expect(active).toHaveLength(1);
    expect(active[0].sourceMessageId).toBe('real');
    expect(items.find((i) => i.sourceMessageId === 'plan')!.status).toBe('superseded');
    expect(h.closed).toContainEqual({ id: 'fu-1', outcome: 'cancelled' });
  });

  it('(b) positive control: 2ea43c4f alone stays one active commitment', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, REAL_2EA43C4F, OWEN, 'real'));
    expect((await h.requests.getById(t.id))!.openItems!.filter((i) => i.status === 'open')).toHaveLength(1);
  });

  it('two different promises by one agent are both kept', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, '明天中午发你 PDF。', OWEN, 'a'));
    await h.service.onAgentMessage(msg(h, '周五前把定价对比表发你。', OWEN, 'b'));
    expect((await h.requests.getById(t.id))!.openItems!.filter((i) => i.status === 'open')).toHaveLength(2);
  });

  it('TKT-140 / 77948b54: a promise waiting on the owner creates no follow-up and no nudge until they agree', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, GATED_77948B54, ATLAS, 'gated'));
    const item = (await h.requests.getById(t.id))!.openItems![0];
    expect(item.status).toBe('waiting_owner');
    expect(item.due).toBeUndefined();
    expect(h.followUps).toHaveLength(0);
    // Under the 24h after which a gate-less promise is surfaced to the owner (CREW-440, see the sweep tests below).
    h.clock.now = new Date(h.clock.now.getTime() + 12 * HOUR);
    await h.service.sweep();
    expect(h.woken).toHaveLength(0);
    expect(h.ownerNotes).toHaveLength(0);
    expect((await h.requests.getById(t.id))!.status).not.toBe('done');
  });

  it('the owner saying yes in the thread opens it, due counted from that moment', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, GATED_77948B54, ATLAS, 'gated'));
    h.clock.now = new Date(h.clock.now.getTime() + 5 * HOUR);
    const said = h.clock.now.getTime();
    await h.service.onAgentMessage(ownerMsg(h, '可以，就选 1'));
    const item = (await h.requests.getById(t.id))!.openItems![0];
    expect(item.status).toBe('open');
    expect(Date.parse(item.due!)).toBe(said + 24 * HOUR); // no time in the text: +24h from the yes
    expect(h.followUps).toHaveLength(1);
  });

  it('a no, or a question, from the owner does not open it', async () => {
    const h = harness();
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, GATED_77948B54, ATLAS, 'gated'));
    await h.service.onAgentMessage(ownerMsg(h, '不行，先别做', 'o1'));
    await h.service.onAgentMessage(ownerMsg(h, '为什么是 Sage？', 'o2'));
    expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('waiting_owner');
    expect(h.followUps).toHaveLength(0);
  });

  it('answering the card opens it; declining it closes it', async () => {
    const decision = (status: string, chosenKey?: string) =>
      ({ id: 'D-9', kind: 'topic', asker: ATLAS, createdAt: new Date(2026, 9, 1, 17, 59, 0).toISOString(), status, options: [], defaultKey: 'no', yesKey: 'yes', ...(chosenKey ? { chosenKey } : {}), resolvedAt: new Date(2026, 9, 1, 20, 0, 0).toISOString() }) as unknown as OwnerDecision;
    for (const [status, key, expected] of [['resolved', 'yes', 'open'], ['resolved', 'no', 'superseded']] as const) {
      let current = decision('open');
      const h = harness({ getDecision: async () => current });
      h.decisions.push(current);
      const t = await ticket(h);
      await h.service.onAgentMessage(msg(h, GATED_77948B54, ATLAS, 'gated'));
      expect((await h.requests.getById(t.id))!.openItems![0].gateDecisionId).toBe('D-9');
      await h.service.sweep();
      expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('waiting_owner');
      current = decision(status, key);
      await h.service.sweep();
      expect((await h.requests.getById(t.id))!.openItems![0].status).toBe(expected);
      expect(h.followUps).toHaveLength(expected === 'open' ? 1 : 0);
    }
  });

  it.each([
    ['TKT-068 c-93b4dbfc-1', '我先在手机宽度下查是哪一块把页面撑宽的，大约 10 分钟后回你结论和上线安排。', 'wi-63a070d0'],
    ['TKT-017 c-5c7492e0-1', '所以日历里小红书的比重我会加一点，改完的版本今天发你。', 'wi-ff64e4b1'],
  ])('%s: an already-nudged item whose follow-up was cancelled closes and never nudges or tells the owner again', async (_n, text, wiId) => {
    const h = harness({ createFollowUp: async () => wiId });
    const t = await ticket(h);
    await h.service.onAgentMessage(msg(h, text, ATLAS, 'p'));
    // Pre-fix nudge already happened; Ella then cancelled the follow-up.
    h.clock.now = new Date(h.clock.now.getTime() + 2 * HOUR);
    await h.service.sweep();
    const fu = createWorkItem({ id: wiId, type: 'delegate', owner: 'system', target: ATLAS, title: 'Follow-up' });
    fu.status = 'cancelled';
    h.pool.push(fu);
    const before = h.woken.length;
    h.clock.now = new Date(h.clock.now.getTime() + 6 * HOUR);
    await h.service.sweep();
    h.clock.now = new Date(h.clock.now.getTime() + 24 * HOUR);
    await h.service.sweep();
    expect(h.woken.length).toBe(before);
    expect(h.ownerNotes).toHaveLength(0);
    expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('cancelled');
  });
});

describe('adopt (backfill apply) leaves a trace', () => {
  it('logs who asked and how many items', async () => {
    const logger = quiet();
    const h = harness({ logger });
    const t = await ticket(h);
    const planned = await h.service.plan(t, msg(h, '明天中午发你 PDF。', ATLAS, 'p'), h.clock.now);
    await h.service.adopt(t.id, planned, { caller: 'think-tank-sage-2ffacc8f' });
    expect(logger.info).toHaveBeenCalledWith('Open items adopted (backfill apply)', expect.objectContaining({ count: 1, caller: 'think-tank-sage-2ffacc8f' }));
  });
});

describe('CREW-440: a card tap settles the conditional promise stored beside the question (TKT-374 / D-541)', () => {
  const OWEN_Q10 = '你看这样写行吗？你点头后我就替换线上的问答，再把链接发到群里给 Kathy。';
  const OPTIONS = [
    { key: 'a', label: 'Yes' },
    { key: 'b', label: 'No' },
    { key: 'c', label: 'Reply in thread' },
  ];

  /** The reply_question card the service posted, settled the way the owner tapped it. */
  const settled = (requestId: string, itemId: string, status: string, chosenKey?: string): OwnerDecision =>
    ({
      id: 'D-1',
      kind: 'reply_question',
      question: 'q',
      options: OPTIONS,
      yesKey: 'a',
      defaultKey: 'b',
      status,
      ...(chosenKey ? { chosenKey } : {}),
      resolvedAt: new Date(2026, 9, 1, 21, 0, 0).toISOString(),
      requestRef: { requestId, itemId },
    }) as unknown as OwnerDecision;

  /** Wait for the queued write of onDecisionSettled (without running the sweep, which would settle it too). */
  const flush = (h: Harness): Promise<unknown> => (h.service as unknown as { serial: (f: () => Promise<unknown>) => Promise<unknown> }).serial(async () => undefined);

  const askAndPromise = async (h: Harness, status: 'running' | 'done' = 'done'): Promise<{ t: Request; promise: RequestOpenItem; question: RequestOpenItem }> => {
    const t = await ticket(h, status);
    await h.service.onAgentMessage(msg(h, OWEN_Q10, ATLAS, 'e21ac6f0-aaaa'));
    const items = (await h.requests.getById(t.id))!.openItems!;
    return { t, promise: items.find((i) => i.type === 'commitment')!, question: items.find((i) => i.type === 'question')! };
  };

  it('1. one message → two items; the promise is gated on the question item, then on its card', async () => {
    const h = harness();
    const { promise, question } = await askAndPromise(h);
    expect(promise).toMatchObject({ status: 'waiting_owner', gateItemId: question.id, gateDecisionId: 'D-1' });
    expect(question).toMatchObject({ status: 'open', decisionId: 'D-1' });
    expect(h.followUps).toHaveLength(0);
  });

  it('2. card Yes opens the promise: due set and the follow-up WorkItem created for the agent', async () => {
    const h = harness();
    const { t, question, promise } = await askAndPromise(h);
    await h.service.onDecisionSettled(settled(t.id, question.id, 'resolved', 'a'), 'note');
    await flush(h);
    const after = (await h.requests.getById(t.id))!.openItems!.find((i) => i.id === promise.id)!;
    expect(after.status).toBe('open');
    expect(after.due).toBeDefined();
    expect(h.followUps).toHaveLength(1);
    expect(h.followUps[0].item.agent).toBe(ATLAS);
  });

  it('3. card Skip (the TKT-374 case) closes the promise, drops it once, creates no WorkItem, and the ticket is done', async () => {
    const h = harness();
    const { t, question, promise } = await askAndPromise(h);
    await h.service.onDecisionSettled(settled(t.id, question.id, 'skipped'), 'note');
    await flush(h);
    const r = (await h.requests.getById(t.id))!;
    expect(r.openItems!.find((i) => i.id === promise.id)).toMatchObject({ status: 'skipped' });
    expect(h.woken.filter((w) => w.text.includes('drop it'))).toHaveLength(1);
    expect(h.followUps).toHaveLength(0);
    expect(r.status).toBe('done');
    await h.service.sweep();
    expect(h.woken.filter((w) => w.text.includes('drop it'))).toHaveLength(1); // once
  });

  it.each([
    ['No', 'resolved', 'b'],
    ['cancelled', 'cancelled', undefined],
    ['expired', 'expired', undefined],
  ])('4. card %s supersedes the promise and wakes nobody', async (_n, status, key) => {
    const h = harness();
    const { t, question, promise } = await askAndPromise(h);
    await h.service.onDecisionSettled(settled(t.id, question.id, status, key), null);
    await flush(h);
    expect((await h.requests.getById(t.id))!.openItems!.find((i) => i.id === promise.id)).toMatchObject({ status: 'superseded' });
    expect(h.followUps).toHaveLength(0);
    expect(h.woken).toHaveLength(0);
  });

  it('"Reply in thread" keeps the promise waiting; the typed yes in the thread then opens it', async () => {
    const h = harness();
    const { t, question, promise } = await askAndPromise(h);
    await h.service.onDecisionSettled(settled(t.id, question.id, 'resolved', 'c'), null);
    await flush(h);
    expect((await h.requests.getById(t.id))!.openItems!.find((i) => i.id === promise.id)!.status).toBe('waiting_owner');
    await h.service.onAgentMessage({ id: 'o-yes', channelId: CHANNEL, threadId: ROOT, senderType: 'user', senderId: 'UOWNER', content: '可以', createdAt: h.clock.now.getTime() });
    expect((await h.requests.getById(t.id))!.openItems!.find((i) => i.id === promise.id)!.status).toBe('open');
    expect(h.followUps).toHaveLength(1);
  });

  it('5. a typed approval in the thread still opens the promise while the card is open', async () => {
    const h = harness();
    const { t, promise } = await askAndPromise(h);
    await h.service.onAgentMessage({ id: 'o-yes', channelId: CHANNEL, threadId: ROOT, senderType: 'user', senderId: 'UOWNER', content: '好的', createdAt: h.clock.now.getTime() });
    expect((await h.requests.getById(t.id))!.openItems!.find((i) => i.id === promise.id)!.status).toBe('open');
  });

  describe('6. the sweep', () => {
    it('closes an ungated promise whose sibling question is closed (a promise stored before CREW-440)', async () => {
      const h = harness();
      const { t, promise, question } = await askAndPromise(h);
      const legacy = { ...promise };
      delete legacy.gateItemId;
      delete legacy.gateDecisionId;
      await h.requests.update(t.id, { openItems: [legacy, { ...question, status: 'skipped', closedAt: h.clock.now.toISOString() }] });
      await h.service.sweep();
      expect((await h.requests.getById(t.id))!.openItems!.find((i) => i.id === promise.id)!.status).toBe('skipped');
      expect(h.woken.filter((w) => w.text.includes('drop it'))).toHaveLength(1);
    });

    it('with no resolvable gate for 24h, tells the owner once', async () => {
      const h = harness();
      const { t, promise } = await askAndPromise(h);
      const orphan = { ...promise };
      delete orphan.gateItemId;
      delete orphan.gateDecisionId;
      await h.requests.update(t.id, { openItems: [orphan] });
      h.clock.now = new Date(h.clock.now.getTime() + 23 * HOUR);
      await h.service.sweep();
      expect(h.ownerNotes).toHaveLength(0);
      h.clock.now = new Date(h.clock.now.getTime() + 2 * HOUR);
      await h.service.sweep();
      await h.service.sweep();
      expect(h.ownerNotes).toHaveLength(1);
      expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('waiting_owner');
    });
  });

  it('7. auto-accept by silence does not park the ticket on a promise nobody can open', async () => {
    const h = harness();
    const { t, promise, question } = await askAndPromise(h, 'running');
    await h.requests.update(t.id, { status: 'waiting_confirmation', openItems: [promise, { ...question, status: 'skipped', closedAt: h.clock.now.toISOString() }] });
    const r = await h.requests.update(t.id, { status: 'done', accepted: true, acceptedBy: 'silence', ignoreDeadChildren: true });
    expect(r.status).toBe('done');
    expect(r.openItems!.find((i) => i.id === promise.id)).toMatchObject({ status: 'superseded' });
  });

  it('7b. silence still parks on a promise whose question card is open', async () => {
    const h = harness();
    const { t } = await askAndPromise(h, 'running');
    await h.requests.update(t.id, { status: 'waiting_confirmation' });
    const r = await h.requests.update(t.id, { status: 'done', accepted: true, acceptedBy: 'silence', ignoreDeadChildren: true });
    expect(r.status).toBe('awaiting_followup');
  });

  it('9. replay of tr-20261009-4788bd23: Skip at 19:28, the 04:31 auto-accept ends in done', async () => {
    const h = harness();
    const { t, question } = await askAndPromise(h, 'running');
    await h.requests.update(t.id, { status: 'waiting_confirmation' });
    h.clock.now = new Date(h.clock.now.getTime() + 3 * HOUR);
    await h.service.onDecisionSettled(settled(t.id, question.id, 'skipped'), null);
    await flush(h);
    h.clock.now = new Date(h.clock.now.getTime() + 9 * HOUR);
    const r = await h.requests.update(t.id, { status: 'done', accepted: true, acceptedBy: 'silence', ignoreDeadChildren: true });
    expect(r.status).toBe('done');
    expect(r.openItems!.some((i) => ['waiting_owner', 'open'].includes(i.status))).toBe(false);
  });

  describe('F. backfill of ungated waiting promises', () => {
    it('dry-run counts what it examined and changes nothing; apply settles TKT-374 (Skip → closed, one drop note)', async () => {
      const h = harness();
      const { t, promise, question } = await askAndPromise(h);
      const legacy = { ...promise };
      delete legacy.gateItemId;
      delete legacy.gateDecisionId;
      await h.requests.update(t.id, { openItems: [legacy, { ...question, status: 'skipped', closedAt: h.clock.now.toISOString() }] });
      const dry = await h.service.backfillWaitingPromises();
      expect(dry).toMatchObject({ dryRun: true, examinedRequests: 1, examinedItems: 1 });
      expect(dry.rows).toEqual([expect.objectContaining({ item: promise.id, action: 'skipped' })]);
      expect((await h.requests.getById(t.id))!.openItems![0].status).toBe('waiting_owner');
      expect(h.woken).toHaveLength(0);
      const applied = await h.service.backfillWaitingPromises({ apply: true });
      expect(applied.examinedItems).toBe(1);
      const r = (await h.requests.getById(t.id))!;
      expect(r.openItems![0].status).toBe('skipped');
      expect(r.status).toBe('done');
      expect(h.woken.filter((w) => w.text.includes('drop it'))).toHaveLength(1);
      expect((await h.service.backfillWaitingPromises({ apply: true })).examinedItems).toBe(0);
    });
  });
});
