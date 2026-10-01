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
import type { OwnerDecision } from '../../types/decision.types.js';
import type { ComponentLogger } from '../core/logger.service.js';
import { OpenItemsService, type OpenItemsDeps, type OpenItemsChatMessage, type QuestionCardInput, type FollowUpInput } from './open-items.service.js';
import { backfillOpenItems, formatBackfillReport } from './open-items-backfill.js';

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
    expect(h.woken[0].text).toContain('--thread C0C67371YUC:1790884910.228259');
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
