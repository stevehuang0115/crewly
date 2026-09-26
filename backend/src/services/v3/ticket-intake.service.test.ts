/**
 * Tests for TicketIntakeService (specs/ticket-loop.md, Phase 1 §1).
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  TicketIntakeService,
  suppressTrivialOrShort,
  suppressFileOnly,
  weightedTextLength,
  isDismissText,
  titleText,
  resolveTicketIdForSession,
  setTicketIntakeService,
  getTicketIntakeService,
  type IntakeMessage,
  type TicketReceiptSink,
  type TicketRequestStore,
} from './ticket-intake.service.js';
import {
  createRequest,
  isValidRequestTransition,
  type CreateRequestInput,
  type Request,
  type UpdateRequestInput,
} from '../../types/v2/request.types.js';
import { TICKET_CONSTANTS } from '../../constants.js';
import { RequestService, setRequestServiceEventBus } from './request.service.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';

/** In-memory Request store with a real directory for the counter file. */
class FakeStore implements TicketRequestStore {
  readonly items = new Map<string, Request>();
  created = 0;
  failList = false;
  constructor(private readonly dir: string) {}
  async create(input: CreateRequestInput): Promise<Request> {
    const r = createRequest({ ...input, intentLevel: input.intentLevel ?? 'L1', intentCategory: input.intentCategory ?? 'other' });
    // Distinct, ordered createdAt so listAll's newest-first order is stable.
    r.createdAt = new Date(Date.now() + this.created).toISOString();
    this.created += 1;
    this.items.set(r.id, r);
    return { ...r };
  }
  async getById(id: string): Promise<Request | null> {
    const r = this.items.get(id);
    return r ? { ...r } : null;
  }
  async listAll(): Promise<Request[]> {
    if (this.failList) throw new Error('disk gone');
    return [...this.items.values()].map((r) => ({ ...r })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async update(id: string, updates: UpdateRequestInput): Promise<Request> {
    const r = this.items.get(id);
    if (!r) throw new Error(`Request not found: ${id}`);
    if (updates.status && updates.status !== r.status && !isValidRequestTransition(r.status, updates.status)) {
      throw new Error(`Invalid status transition: ${r.status} -> ${updates.status}`);
    }
    const next: Request = { ...r, ...updates, updatedAt: new Date().toISOString() } as Request;
    this.items.set(id, next);
    return { ...next };
  }
  getRequestsDir(): string {
    return this.dir;
  }
  seed(partial: Partial<Request> & { sourceConversationItemId: string }): Request {
    const r = { ...createRequest({ sourceConversationItemId: partial.sourceConversationItemId, title: 't', description: 'd' }), ...partial };
    this.items.set(r.id, r);
    return r;
  }
}

/** Receipt sink that records calls. */
function fakeSink(): TicketReceiptSink & { posted: Request[]; dismissed: Request[] } {
  const posted: Request[] = [];
  const dismissed: Request[] = [];
  return {
    posted,
    dismissed,
    async post(ticket, target) {
      posted.push(ticket);
      return target.kind === 'slack'
        ? { kind: 'slack', slackChannelId: target.slackChannelId, ts: `r-${posted.length}`, threadTs: target.threadTs }
        : { kind: 'chat-v2', chatChannelId: target.chatChannelId, messageId: `m-${posted.length}` };
    },
    async markDismissed(ticket) {
      dismissed.push(ticket);
    },
  };
}

/** Let fire-and-forget receipt posting settle. */
const flush = () => new Promise((r) => setTimeout(r, 20));

let dir: string;
let store: FakeStore;
let sink: ReturnType<typeof fakeSink>;
let svc: TicketIntakeService;

/**
 * A Slack owner message.
 *
 * @param overrides - Fields to change
 * @returns Intake message
 */
function msg(overrides: Partial<IntakeMessage> & { ts?: string; thread?: string } = {}): IntakeMessage {
  const ts = overrides.ts ?? '100.1';
  const thread = overrides.thread ?? ts;
  return {
    text: 'please add a dark mode toggle to settings',
    isOwner: true,
    origin: {
      channel: 'slack-channel',
      ref: `slackch-C1-${ts}`,
      threadRef: `slack:C1:${thread}`,
      author: 'U-owner',
    },
    conversationRef: 'slack:C1',
    receipt: { kind: 'slack', slackChannelId: 'C1', threadTs: thread },
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ticket-intake-'));
  store = new FakeStore(dir);
  sink = fakeSink();
  svc = new TicketIntakeService({ requests: store, receiptsEnabled: true });
  svc.setReceiptSink('slack', sink);
  svc.setReceiptSink('chat-v2', sink);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('suppression gate', () => {
  it('weights CJK characters double', () => {
    expect(weightedTextLength('abc')).toBe(3);
    expect(weightedTextLength('把首页改成蓝色')).toBe(14);
  });

  it.each([['ok'], ['好的'], ['好的收到'], ['thanks!'], ['👍'], ['hi'], ['a'.repeat(11)]])('suppresses %j', (t) => {
    expect(suppressTrivialOrShort(t)).toBe('trivial_or_short');
  });

  it.each([['fix the build please'], ['把首页改成蓝色'], ['帮我修一下登录']])('lets %j through', (t) => {
    expect(suppressTrivialOrShort(t)).toBeNull();
  });

  it('file-only: a bare file reference, or attachments with no words', () => {
    expect(suppressFileOnly('[Slack File: /tmp/a.png (a.png, image/png, 3KB)]')).toBe('file_only');
    expect(suppressFileOnly('', true)).toBe('file_only');
    expect(suppressFileOnly('[Slack File: /tmp/a.png] please review this mockup')).toBeNull();
    expect(suppressFileOnly('review this', true)).toBeNull();
  });

  it('recognises "不用记" and its variants only as the whole message', () => {
    for (const t of ['不用记', '不用记。', ' 别记 ', "don't track", 'no ticket']) expect(isDismissText(t)).toBe(true);
    expect(isDismissText('不用记这个，但请改一下按钮')).toBe(false);
  });
});

describe('intake — creating tickets', () => {
  it('creates a numbered ticket with origin, kind, assignee and tags, and posts one receipt', async () => {
    const outcome = await svc.intakeWithOutcome(msg({ targetAgent: 'dev-1', tags: ['slack'] }));
    expect(outcome.action).toBe('created');
    if (outcome.action !== 'created') return;
    const t = outcome.ticket;
    expect(t.ticketNumber).toBe(1);
    expect(t.kind).toBe('feature');
    expect(t.assignee).toBe('dev-1');
    expect(t.origin).toMatchObject({ channel: 'slack-channel', ref: 'slackch-C1-100.1', threadRef: 'slack:C1:100.1', author: 'U-owner' });
    expect(t.sourceConversationItemId).toBe('slackch-C1-100.1');
    expect(t.tags).toEqual(expect.arrayContaining([TICKET_CONSTANTS.TAG, 'slack-channel', 'slack']));
    await flush();
    expect(sink.posted).toHaveLength(1);
    expect((await store.getById(t.id))?.receipt).toEqual({ kind: 'slack', slackChannelId: 'C1', ts: 'r-1', threadTs: '100.1' });
  });

  it('numbers tickets monotonically', async () => {
    const a = await svc.intake(msg({ ts: '1.1' }));
    const b = await svc.intake(msg({ ts: '2.2', text: 'please build the export to csv feature' }));
    expect([a?.ticketNumber, b?.ticketNumber]).toEqual([1, 2]);
  });

  it('hands out unique numbers under concurrent intake', async () => {
    const texts = ['implement csv export', 'add a login page please', 'refactor the billing module', 'create a new onboarding flow', 'build the admin dashboard'];
    const results = await Promise.all(texts.map((text, i) => svc.intake(msg({ ts: `${i + 10}.0`, text }))));
    expect(results.map((r) => r?.ticketNumber).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('seeds the counter from the highest number on disk, and never reuses one if the counter file is lost', async () => {
    store.seed({ sourceConversationItemId: 'old', ticketNumber: 41 });
    expect((await svc.intake(msg({ ts: '3.3' })))?.ticketNumber).toBe(42);
    await fs.rm(path.join(dir, TICKET_CONSTANTS.COUNTER_FILENAME));
    expect((await svc.intake(msg({ ts: '4.4', text: 'implement the search page' })))?.ticketNumber).toBe(43);
  });

  it('marks a 🐛 message as an issue', async () => {
    const t = await svc.intake(msg({ text: '🐛 the login button does nothing' }));
    expect(t?.kind).toBe('issue');
  });
});

describe('intake — what does not open a ticket', () => {
  it('agent-authored text never opens a ticket', async () => {
    expect(await svc.intakeWithOutcome(msg({ isOwner: false }))).toEqual({ action: 'ignored', reason: 'not_owner' });
    expect(store.items.size).toBe(0);
  });

  it('trivial acks, file-only messages and questions are ignored', async () => {
    expect(await svc.intakeWithOutcome(msg({ text: '好的' }))).toEqual({ action: 'ignored', reason: 'trivial_or_short' });
    expect(await svc.intakeWithOutcome(msg({ ts: '5.5', text: '[Slack File: /tmp/x.png (x.png, image/png, 1KB)]' }))).toEqual({
      action: 'ignored',
      reason: 'file_only',
    });
    // A question about where things stand is a status ping, not an ask: no
    // ticket. (#827: request-phrased and pure information questions DO open
    // tickets — see "request-phrased questions" below.)
    for (const [i, text] of ['what is the status of the deploy?', 'which agents are working on the billing project right now'].entries()) {
      const outcome = await svc.intakeWithOutcome(msg({ ts: `6.${i}`, text }));
      expect(outcome.action).toBe('ignored');
      expect(['query', 'not_actionable', 'status_ping']).toContain(outcome.action === 'ignored' ? outcome.reason : '');
    }
    expect(store.items.size).toBe(0);
    await flush();
    expect(sink.posted).toHaveLength(0);
  });

  it('the same message twice is a duplicate — no second ticket, no second receipt', async () => {
    const first = await svc.intakeWithOutcome(msg());
    const again = await svc.intakeWithOutcome(msg());
    expect(again.action).toBe('duplicate');
    expect(first.action === 'created' && again.action === 'duplicate' && again.ticket.id === first.ticket.id).toBe(true);
    await flush();
    expect(sink.posted).toHaveLength(1);
  });

  it('never throws — a failing store is reported as ignored', async () => {
    store.failList = true;
    expect(await svc.intakeWithOutcome(msg())).toEqual({ action: 'ignored', reason: 'error' });
  });
});

describe('intake — threads', () => {
  it('a follow-up in the thread appends to the ticket instead of opening a new one', async () => {
    const created = await svc.intake(msg());
    const outcome = await svc.intakeWithOutcome(msg({ ts: '100.2', thread: '100.1', text: 'also make it default for new users' }));
    expect(outcome.action).toBe('appended');
    expect(store.items.size).toBe(1);
    const t = await store.getById(created!.id);
    expect(t?.discussion).toEqual([
      expect.objectContaining({ author: 'U-owner', text: 'also make it default for new users', ref: 'slackch-C1-100.2' }),
    ]);
    await flush();
    expect(sink.posted).toHaveLength(1);
  });

  it('a trivial follow-up belongs to the ticket but is not written to its discussion', async () => {
    const created = await svc.intake(msg());
    const outcome = await svc.intakeWithOutcome(msg({ ts: '100.3', thread: '100.1', text: 'thanks' }));
    expect(outcome.action).toBe('appended');
    expect((await store.getById(created!.id))?.discussion).toBeUndefined();
  });

  it('a thread opened before the ticket loop still counts as a continuation', async () => {
    const legacy = store.seed({ sourceConversationItemId: 'slack-C9-50.0', status: 'running' });
    const outcome = await svc.intakeWithOutcome({
      ...msg({ ts: '50.1', thread: '50.0', text: 'and add tests for it too please' }),
      legacyThreadParentRef: 'slack-C9-50.0',
    });
    expect(outcome.action === 'appended' && outcome.ticket.id === legacy.id).toBe(true);
  });

  it('a finished thread may open a new ticket', async () => {
    const created = await svc.intake(msg());
    await store.update(created!.id, { status: 'done' });
    const outcome = await svc.intakeWithOutcome(msg({ ts: '100.4', thread: '100.1', text: 'now add the same toggle to mobile' }));
    expect(outcome.action).toBe('created');
  });
});

describe('intake — review replies (Phase 2)', () => {
  /** Review handler that records calls and applies them to the store. */
  function fakeReview() {
    const calls: string[] = [];
    return {
      calls,
      async verify(ref: string) {
        calls.push(`verify:${ref}`);
        return { ok: true, ticket: await store.update(ref, { status: 'done' }) };
      },
      async reject(ref: string, reason: string, via: 'thread') {
        calls.push(`reject:${ref}:${reason}:${via}`);
        return { ok: true, ticket: await store.update(ref, { status: 'running' }) };
      },
      async reopenOnFollowUp(id: string) {
        calls.push(`reopen:${id}`);
        return store.update(id, { status: 'running' });
      },
    };
  }

  it('new tickets need review; cron / mission ones do not', async () => {
    const t = await svc.intake(msg());
    expect(t?.requiresConfirmation).toBe(true);
    const cron = await svc.intake(msg({ ts: '200.1', origin: { channel: 'cron', ref: 'cron-1', threadRef: 'slack:C1:200.1', author: 'U-owner' } }));
    expect(cron?.requiresConfirmation).toBe(false);
  });

  it('a message whose answer is the whole deliverable (communication) closes without review', async () => {
    const v3data = await import('./v3-data.service.js');
    const spy = jest.spyOn(v3data, 'classifyIntent').mockReturnValue({ intentLevel: 'L1', intentCategory: 'communication' } as never);
    try {
      const t = await svc.intake(msg({ ts: '300.1' }));
      expect(t?.requiresConfirmation).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('an OK next to a name or mention still reads as the OK', () => {
    const re = TICKET_CONSTANTS.REVIEW.ACK_PATTERN;
    for (const yes of ['可以 Dana', '好的 <@U0C2ZK849ND>', 'Dana 可以', '可以，Dana！', 'ok']) expect(re.test(yes)).toBe(true);
    for (const no of ['可以 不过改一下', '好的 按你说的来', '行吧我再想想']) expect(re.test(no)).toBe(false);
  });

  it('验过了 in a 待验收 thread accepts; 打回 + reason sends back', async () => {
    const review = fakeReview();
    svc.setReviewHandler(review);
    const t = await svc.intake(msg());
    await store.update(t!.id, { status: 'waiting_confirmation' });
    const v = await svc.intakeWithOutcome(msg({ ts: '100.2', thread: '100.1', text: '验过了' }));
    expect(v.action).toBe('verified');

    const t2 = await svc.intake(msg({ ts: '300.1', text: 'please export the weekly report as csv' }));
    await store.update(t2!.id, { status: 'waiting_confirmation' });
    const r = await svc.intakeWithOutcome(msg({ ts: '300.2', thread: '300.1', text: '打回：少了表头' }));
    expect(r.action).toBe('rejected');
    expect(review.calls).toEqual([`verify:${t!.id}`, `reject:${t2!.id}:少了表头:thread`]);
  });

  it('any other owner message in a 待验收 thread reopens it and is appended', async () => {
    const review = fakeReview();
    svc.setReviewHandler(review);
    const t = await svc.intake(msg());
    await store.update(t!.id, { status: 'waiting_confirmation' });
    const o = await svc.intakeWithOutcome(msg({ ts: '100.2', thread: '100.1', text: 'can you also add it to the mobile app' }));
    expect(o.action).toBe('appended');
    expect(review.calls).toEqual([`reopen:${t!.id}`]);
    expect((await store.getById(t!.id))?.status).toBe('running');
  });

  it('a top-level 验过了 (DMs) accepts the newest 待验收 ticket of the conversation', async () => {
    const review = fakeReview();
    svc.setReviewHandler(review);
    const t = await svc.intake(msg());
    await store.update(t!.id, { status: 'waiting_confirmation' });
    const v = await svc.intakeWithOutcome(msg({ ts: '500.1', text: 'lgtm' }));
    expect(v.action).toBe('verified');
    expect(review.calls).toEqual([`verify:${t!.id}`]);
  });

  it('a plain 「好的」 in the thread is the OK the agent asked for', async () => {
    const review = fakeReview();
    svc.setReviewHandler(review);
    const t = await svc.intake(msg());
    await store.update(t!.id, { status: 'waiting_confirmation', submittedAt: new Date().toISOString() });
    expect((await svc.intakeWithOutcome(msg({ ts: '100.2', thread: '100.1', text: '好的' }))).action).toBe('verified');
  });

  it('a top-level 「可以」 counts only while the question is recent', async () => {
    const review = fakeReview();
    svc.setReviewHandler(review);
    const t = await svc.intake(msg());
    await store.update(t!.id, { status: 'waiting_confirmation', submittedAt: new Date(Date.now() - 2 * TICKET_CONSTANTS.REVIEW.NUDGE_AFTER_MS).toISOString() });
    expect((await svc.intakeWithOutcome(msg({ ts: '600.1', text: '可以' }))).action).not.toBe('verified');
    await store.update(t!.id, { lastNudgeAt: new Date().toISOString() });
    expect((await svc.intakeWithOutcome(msg({ ts: '600.2', text: '可以' }))).action).toBe('verified');
  });

  it('posts no receipt by default (tickets are Crewly\'s own record)', async () => {
    const quiet = new TicketIntakeService({ requests: store });
    quiet.setReceiptSink('slack', sink);
    await quiet.intake(msg({ ts: '700.1' }));
    await flush();
    expect(sink.posted).toHaveLength(0);
  });

  it('without a review handler 验过了 is just a (trivial) follow-up', async () => {
    const t = await svc.intake(msg());
    await store.update(t!.id, { status: 'waiting_confirmation' });
    expect((await svc.intakeWithOutcome(msg({ ts: '100.2', thread: '100.1', text: '验过了' }))).action).toBe('appended');
  });

  it('markReceiptDone hands the receipt to its sink', async () => {
    const done: string[] = [];
    svc.setReceiptSink('slack', { ...sink, markDone: async (t) => void done.push(t.id) });
    const t = await svc.intake(msg());
    await flush();
    await svc.markReceiptDone((await store.getById(t!.id))!);
    expect(done).toEqual([t!.id]);
  });
});

describe('dismiss ("不用记")', () => {
  it('a 不用记 reply in the thread cancels the ticket, tags it and edits the receipt', async () => {
    const created = await svc.intake(msg());
    await flush();
    const outcome = await svc.intakeWithOutcome(msg({ ts: '100.5', thread: '100.1', text: '不用记' }));
    expect(outcome.action).toBe('dismissed');
    const t = await store.getById(created!.id);
    expect(t?.status).toBe('cancelled');
    expect(t?.tags).toContain(TICKET_CONSTANTS.DISMISSED_TAG);
    expect(sink.dismissed.map((d) => d.id)).toEqual([created!.id]);
  });

  it('after 不用记 the thread stays quiet', async () => {
    await svc.intake(msg());
    await svc.intakeWithOutcome(msg({ ts: '100.5', thread: '100.1', text: '不用记' }));
    const later = await svc.intakeWithOutcome(msg({ ts: '100.6', thread: '100.1', text: 'actually also rename the page' }));
    expect(later).toEqual({ action: 'ignored', reason: 'thread_dismissed' });
  });

  it('a top-level 不用记 dismisses the newest open ticket of the conversation', async () => {
    await svc.intake(msg({ ts: '1.0', text: 'implement csv export' }));
    const newer = await svc.intake(msg({ ts: '2.0', text: 'add a login page please' }));
    const outcome = await svc.intakeWithOutcome(msg({ ts: '3.0', text: '不用记' }));
    expect(outcome.action === 'dismissed' && outcome.ticket.id === newer!.id).toBe(true);
  });

  it('a top-level 不用记 long after the ticket does nothing', async () => {
    const clock = { now: new Date() };
    svc = new TicketIntakeService({ requests: store, now: () => clock.now });
    await svc.intake(msg({ ts: '1.0' }));
    clock.now = new Date(Date.now() + TICKET_CONSTANTS.DISMISS_LOOKBACK_MS + 60_000);
    expect(await svc.intakeWithOutcome(msg({ ts: '9.0', text: '不用记' }))).toEqual({
      action: 'ignored',
      reason: 'dismiss_without_ticket',
    });
  });

  it('dismiss() resolves TKT-001, 1 and the id; is idempotent; refuses done tickets', async () => {
    const a = await svc.intake(msg({ ts: '1.0', text: 'implement csv export' }));
    const b = await svc.intake(msg({ ts: '2.0', text: 'add a login page please' }));
    const c = await svc.intake(msg({ ts: '3.0', text: 'refactor the billing module' }));
    expect(await svc.dismiss('TKT-001')).toMatchObject({ ok: true, alreadyDismissed: false });
    expect(await svc.dismiss('1')).toMatchObject({ ok: true, alreadyDismissed: true });
    expect(await svc.dismiss(b!.id)).toMatchObject({ ok: true });
    await store.update(c!.id, { status: 'done' });
    expect(await svc.dismiss(c!.id)).toMatchObject({ ok: false, reason: 'already_done' });
    expect(await svc.dismiss('TKT-999')).toEqual({ ok: false, reason: 'not_found' });
    expect((await store.getById(a!.id))?.status).toBe('cancelled');
  });

  it('edits the receipt even when the owner dismissed before it landed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: TicketReceiptSink & { dismissed: number } = {
      dismissed: 0,
      async post(_t, target) {
        await gate;
        return { kind: 'slack', slackChannelId: target.kind === 'slack' ? target.slackChannelId : '', ts: 'late' };
      },
      async markDismissed() {
        slow.dismissed += 1;
      },
    };
    svc.setReceiptSink('slack', slow);
    const t = await svc.intake(msg());
    await svc.dismiss(t!.id);
    release();
    await flush();
    expect(slow.dismissed).toBe(1);
    expect((await store.getById(t!.id))?.receipt).toMatchObject({ ts: 'late' });
  });
});

describe('resolve and list', () => {
  it('resolves by TKT, number and id', async () => {
    const t = await svc.intake(msg());
    for (const ref of ['TKT-001', 'tkt-1', '1', t!.id]) expect((await svc.resolve(ref))?.id).toBe(t!.id);
    expect(await svc.resolve('')).toBeNull();
    expect(await svc.resolve('TKT-5')).toBeNull();
  });

  it('lists board rows with filters, hides cancelled and legacy by default', async () => {
    const wiStatus = new Map<string, string>([['wi-1', 'done']]);
    svc = new TicketIntakeService({ requests: store, findWorkItem: async (id) => (wiStatus.has(id) ? { status: wiStatus.get(id)! } : null) });
    const a = await svc.intake(msg({ ts: '1.0', text: 'implement csv export' }));
    const b = await svc.intake(msg({ ts: '2.0', text: '🐛 login button does nothing' }));
    const c = await svc.intake(msg({ ts: '3.0', text: 'refactor the billing module' }));
    store.seed({ sourceConversationItemId: 'legacy-1' });
    await store.update(b!.id, { status: 'cancelled' });
    await store.update(c!.id, { status: 'ready' });
    await store.update(c!.id, { status: 'running' });
    store.items.set(c!.id, { ...store.items.get(c!.id)!, requiresConfirmation: true, workItemIds: ['wi-1'] });

    const all = await svc.list();
    expect(all.tickets.map((t) => t.tkt).sort()).toEqual(['TKT-001', 'TKT-003']);
    expect(all.columns).toMatchObject({ todo: 1, to_review: 1, cancelled: 1 });
    expect(all.tickets.find((t) => t.id === c!.id)).toMatchObject({ column: 'to_review', priorityLabel: 'P2', kind: 'feature' });

    expect((await svc.list({ column: 'cancelled' })).tickets.map((t) => t.id)).toEqual([b!.id]);
    expect((await svc.list({ kind: 'issue', column: 'cancelled' })).tickets).toHaveLength(1);
    expect((await svc.list({ q: 'csv' })).tickets.map((t) => t.id)).toEqual([a!.id]);
    expect((await svc.list({ q: 'tkt-003' })).tickets.map((t) => t.id)).toEqual([c!.id]);
    expect((await svc.list({ includeLegacy: true })).tickets.some((t) => t.tkt === null)).toBe(true);
  });
});

describe('board — accepted is not verified (#813)', () => {
  it('labels how a done ticket was accepted: owner, silence (field or legacy tag), else null', async () => {
    /** Open a ticket and return its id (fails the test if intake declined). */
    const open = async (ts: string, text: string): Promise<string> => {
      const t = await svc.intake(msg({ ts, text }));
      if (!t) throw new Error(`intake declined: ${text}`);
      return t.id;
    };
    const ownerId = await open('1.0', 'implement csv export');
    const silentId = await open('2.0', 'implement pdf export');
    const legacyId = await open('3.0', 'implement xml export');
    const openId = await open('4.0', 'implement json export');
    const set = (id: string, patch: Record<string, unknown>) => {
      const cur = store.items.get(id);
      if (!cur) throw new Error(`missing ${id}`);
      store.items.set(id, { ...cur, ...patch });
    };
    set(ownerId, { status: 'done', acceptedBy: 'owner' });
    set(silentId, { status: 'done', acceptedBy: 'silence' });
    set(legacyId, { status: 'done', tags: [TICKET_CONSTANTS.REVIEW.AUTO_ACCEPTED_TAG] });

    const byId = new Map((await svc.list({ includeLegacy: true })).tickets.map((t) => [t.id, t]));
    expect(byId.size).toBeGreaterThanOrEqual(4);
    expect(byId.get(ownerId)?.acceptedBy).toBe('owner');
    expect(byId.get(silentId)?.acceptedBy).toBe('silence');
    expect(byId.get(legacyId)?.acceptedBy).toBe('silence');
    expect(byId.get(openId)?.acceptedBy).toBeNull();
  });
});

describe('resolveTicketIdForSession', () => {
  const ID = '11111111-2222-3333-4444-555555555555';
  it('reads the ticket marker of the session’s current turn', () => {
    const tracker = {
      snapshot: () => [
        { sessionName: 'dev-1', messages: [{ text: `[CHAT:c] hi\n[TICKET:TKT-004 ${ID}] …` }] },
        { sessionName: 'dev-2', messages: [{ text: 'no marker' }] },
      ],
    };
    expect(resolveTicketIdForSession(tracker, 'dev-1')).toBe(ID);
    expect(resolveTicketIdForSession(tracker, 'dev-2')).toBeNull();
    expect(resolveTicketIdForSession(tracker, 'nobody')).toBeNull();
  });

  it('also reads the original content the queue annotated', () => {
    const tracker = { snapshot: () => [{ sessionName: 'orc', messages: [{ text: '[CHAT:x] …', originalContent: `do it\n[TICKET:TKT-001 ${ID}]` }] }] };
    expect(resolveTicketIdForSession(tracker, 'orc')).toBe(ID);
  });
});

describe('singleton', () => {
  it('set/get', () => {
    setTicketIntakeService(svc);
    expect(getTicketIntakeService()).toBe(svc);
    setTicketIntakeService(null);
    expect(getTicketIntakeService()).toBeNull();
  });
});

describe('with the real RequestService', () => {
  afterEach(() => {
    setRequestServiceEventBus(null);
    RequestService.resetInstance();
  });

  it('persists the ticket fields and still emits request:created (decompose + SLA keep working)', async () => {
    const published: Array<{ type: string; requestId?: string }> = [];
    setRequestServiceEventBus({ publish: (e: { type: string; requestId?: string }) => published.push(e) } as unknown as EventBusService);
    RequestService.resetInstance();
    const requests = RequestService.getInstance(dir);
    const real = new TicketIntakeService({ requests });
    const t = await real.intake(msg({ tags: ['slack'] }));
    expect(t?.ticketNumber).toBe(1);
    const onDisk = await requests.getById(t!.id);
    expect(onDisk).toMatchObject({ ticketNumber: 1, kind: 'feature', origin: { channel: 'slack-channel' } });
    expect(published).toEqual([expect.objectContaining({ type: 'request:created', requestId: t!.id })]);
    // The counter file lives next to the Request files but is never read as one.
    expect((await requests.listAll()).map((r) => r.id)).toEqual([t!.id]);
  });
});

describe('titleText', () => {
  it('drops Slack mention codes and keeps link labels', () => {
    expect(titleText('<@U0C2ZK849ND> 看看这个 <https://example.com/a|这篇文章>')).toBe('看看这个 这篇文章');
    expect(titleText('see <https://example.com/x>')).toBe('see https://example.com/x');
    expect(titleText('<@U0C2ZK849ND>')).toBe('<@U0C2ZK849ND>');
  });
});

// ---------------------------------------------------------------------------
/**
 * The value, or fail the test here (instead of a non-null assertion).
 *
 * @param v - Possibly-null value
 * @returns The value
 */
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected a value');
  return v;
}

// #827 — every distinct ask becomes its own ticket
// ---------------------------------------------------------------------------

describe('intake — new asks in a ticket thread (#827)', () => {
  it('a new ask in the thread opens its own ticket, linked to the parent and the thread', async () => {
    const parent = await svc.intake(msg({ text: 'please add a dark mode toggle to settings', targetAgent: 'dev-a' }));
    const outcome = await svc.intakeWithOutcome(msg({ ts: '100.2', thread: '100.1', text: '可以去研究一下opus做视频那个吗\n可以怎么加到flopost里' }));
    expect(outcome.action).toBe('created_in_thread');
    if (outcome.action !== 'created_in_thread') return;
    expect(outcome.parent.id).toBe(must(parent).id);
    expect(outcome.ticket).toMatchObject({
      parentTicketId: must(parent).id,
      origin: expect.objectContaining({ threadRef: 'slack:C1:100.1', ref: 'slackch-C1-100.2' }),
      // Named nobody: whoever holds the thread's ticket takes it.
      assignee: 'dev-a',
      ticketNumber: 2,
    });
    expect((await store.getById(must(parent).id))?.discussion).toBeUndefined();
  });

  it('follow-ups in the thread still append — to the newest open ticket there', async () => {
    await svc.intake(msg());
    const second = await svc.intakeWithOutcome(msg({ ts: '100.2', thread: '100.1', text: '可以开issues发给Sam' }));
    expect(second.action).toBe('created_in_thread');
    for (const [i, text] of ['好的 开issue可以的', '把方案通过PDF发给我', '我只是想着和orca对比而已 除非你觉得有必要'].entries()) {
      const o = await svc.intakeWithOutcome(msg({ ts: `100.${3 + i}`, thread: '100.1', text }));
      expect({ text, action: o.action }).toEqual({ text, action: 'appended' });
      if (o.action === 'appended' && second.action === 'created_in_thread') expect(o.ticket.id).toBe(second.ticket.id);
    }
    expect(store.items.size).toBe(2);
  });

  it('a new ask under a 待验收 ticket opens its own and does not reopen the answered one', async () => {
    const reopened: string[] = [];
    svc.setReviewHandler({
      verify: async () => ({ ok: true }),
      reject: async () => ({ ok: true }),
      reopenOnFollowUp: async (id) => {
        reopened.push(id);
        return null;
      },
    });
    const t = await svc.intake(msg());
    await store.update(must(t).id, { status: 'running' });
    await store.update(must(t).id, { status: 'waiting_confirmation' });
    const o = await svc.intakeWithOutcome(msg({ ts: '100.2', thread: '100.1', text: '另外 可以帮我调研一下定价怎么定吗' }));
    expect(o.action).toBe('created_in_thread');
    expect(reopened).toEqual([]);
    expect((await store.getById(must(t).id))?.status).toBe('waiting_confirmation');
    // A plain follow-up still reopens it.
    await svc.intakeWithOutcome(msg({ ts: '100.3', thread: '100.1', text: '还有这个图片需要换一下，颜色不对' }));
  });

  it('a new ticket in a finished thread records the finished one as its parent', async () => {
    const done = await svc.intake(msg());
    await store.update(must(done).id, { status: 'done' });
    const o = await svc.intakeWithOutcome(msg({ ts: '100.4', thread: '100.1', text: 'now add the same toggle to mobile' }));
    expect(o.action).toBe('created');
    if (o.action === 'created') expect(o.ticket.parentTicketId).toBe(must(done).id);
  });
});

describe('intake — request-phrased questions (#827)', () => {
  it('a request phrased as a question opens a ticket (the intent classifier calls it L0)', async () => {
    const o = await svc.intakeWithOutcome(msg({ text: '那个orca和crewly是不是有点像\n可以研究一下他们是怎么做的吗' }));
    expect(o.action).toBe('created');
    // Stored as actionable, whatever the intent classifier said.
    if (o.action === 'created') expect(o.ticket.intentLevel).not.toBe('L0');
  });

  it('a pure information question opens a lightweight question ticket, no acceptance step', async () => {
    const o = await svc.intakeWithOutcome(msg({ text: '这个团队都有几个人' }));
    expect(o.action).toBe('created');
    if (o.action === 'created') expect(o.ticket).toMatchObject({ kind: 'question', requiresConfirmation: false });
  });

  it('pure acks and status pings are still ignored', async () => {
    for (const [i, text] of ['好的', '收到', '现在nova在线了吗', 'what is the status of the deploy?'].entries()) {
      const o = await svc.intakeWithOutcome(msg({ ts: `7.${i}`, text }));
      expect({ text, action: o.action }).toEqual({ text, action: 'ignored' });
    }
    expect(store.items.size).toBe(0);
  });
});

describe('split (#827)', () => {
  /** A ticket with one ask wrongly appended to it. @returns ids */
  async function withAppendedAsk(): Promise<{ id: string; ref: string }> {
    const t = await svc.intake(msg({ targetAgent: 'dev-a' }));
    // A clarification-shaped message that also asks: appended (ties append).
    await svc.intakeWithOutcome(msg({ ts: '100.2', thread: '100.1', text: '我只是想着 你打算怎么做成视频' }));
    return { id: must(t).id, ref: 'slackch-C1-100.2' };
  }

  it('moves a follow-up out into its own ticket that keeps the thread link', async () => {
    const { id, ref } = await withAppendedAsk();
    expect((await store.getById(id))?.discussion).toHaveLength(1);
    const r = await svc.split('TKT-001', { discussionRef: ref, by: 'atlas' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.moved).toBe(true);
    expect(r.ticket).toMatchObject({
      parentTicketId: id,
      description: '我只是想着 你打算怎么做成视频',
      origin: expect.objectContaining({ threadRef: 'slack:C1:100.1', ref }),
      assignee: 'dev-a',
      tags: expect.arrayContaining([TICKET_CONSTANTS.SPLIT_TAG]),
    });
    expect((await store.getById(id))?.discussion).toEqual([]);
    // The thread still resolves to a ticket for the next follow-up.
    const next = await svc.intakeWithOutcome(msg({ ts: '100.9', thread: '100.1', text: '好的 就这样' }));
    expect(next.action).toBe('appended');
  });

  it('splits from text, with title, assignee and question', async () => {
    await svc.intake(msg());
    const r = await svc.split('1', { text: 'Turing 的另一个测试是什么', title: 'other Turing test', assignee: 'atlas', question: true });
    expect(r.ok && r.ticket).toMatchObject({ title: 'other Turing test', assignee: 'atlas', kind: 'question', requiresConfirmation: false });
    expect(r.ok && r.moved).toBe(false);
  });

  it('refuses what it cannot do', async () => {
    await withAppendedAsk();
    expect(await svc.split('TKT-404', { text: 'x' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await svc.split('TKT-001', { discussionRef: 'nope' })).toMatchObject({ ok: false, reason: 'discussion_not_found' });
    expect(await svc.split('TKT-001', {})).toMatchObject({ ok: false, reason: 'invalid' });
    const legacy = store.seed({ sourceConversationItemId: 'legacy-9' });
    expect(await svc.split(legacy.id, { text: 'x' })).toMatchObject({ ok: false, reason: 'no_origin' });
  });
});

describe('replay — thread 1790425131.498609 in #C0C2QCGE9K9, 2026-09-26 (#827)', () => {
  // The owner's messages in that thread, in order, as delivered (Slack gave
  // most of them twice). Agent replies are included as non-owner messages.
  // Before #827 this thread produced 2 tickets (TKT-037, TKT-039) and the
  // other asks were appended or dropped.
  const AGENTS: Record<string, string> = { U0C2ZK849ND: 'atlas', U0C30GRCPT4: 'ella', U0C45AW5G80: 'mia' };
  const THREAD: Array<{ ts: string; owner: boolean; text: string; label?: 'ask' | 'follow' }> = [
    { ts: '1790425131.498609', owner: true, label: 'ask', text: '那个orca和crewly是不是有点像\n可以研究一下他们是怎么做的吗\n\nhindsight那个可以看看' },
    { ts: '1790425132.1', owner: true, label: 'ask', text: '<@U0C30GRCPT4> 这个可以发到crewly博客上' },
    { ts: '1790425132.1', owner: true, text: '<@U0C30GRCPT4> 这个可以发到crewly博客上' },
    { ts: '1790425133.1', owner: false, text: '素材还在做，约 40 分钟后两份研究会发在这个 thread' },
    { ts: '1790425134.1', owner: false, text: '两份都好了，我核过关键数字和代码。要不要开 issue？' },
    { ts: '1790425135.1', owner: true, label: 'follow', text: '好的 开issue可以的' },
    { ts: '1790425136.1', owner: true, label: 'ask', text: '<@U0C2ZK849ND> 那个other turing tests是什么\n可以给我看看文章并告诉我吗' },
    { ts: '1790425136.1', owner: true, text: '<@U0C2ZK849ND> 那个other turing tests是什么\n可以给我看看文章并告诉我吗' },
    { ts: '1790425137.1', owner: false, text: '四个 issue 开好了' },
    { ts: '1790425138.1', owner: true, label: 'ask', text: '<@U0C2ZK849ND> 可以看看有什么值得进wiki值得深挖的吗？\n我们的wiki目前应该有industry相关的vault吧\n都有什么focus吗？\n\n那个plan mode已死什么意思\n\nwhat even is an os是讲什么的' },
    { ts: '1790425139.1', owner: true, label: 'ask', text: '<@U0C45AW5G80> 那个X的动向能不能按theme帮我group' },
    { ts: '1790425140.1', owner: true, label: 'ask', text: '<@U0C2ZK849ND> 可以去研究一下opus做视频那个吗\n可以怎么加到flopost里' },
    { ts: '1790425141.1', owner: true, label: 'follow', text: '<@U0C30GRCPT4> hingsight那个要写到一起吗？\n我只是想着和orca对比而已\n除非你觉得有必要' },
    { ts: '1790425142.1', owner: true, label: 'follow', text: '[Slack File: /path/file (Audio Clip (2026-09-26 11:22:44).m4a, audio/mp4, 119KB)]' },
    { ts: '1790425143.1', owner: true, label: 'ask', text: 'Chit 那个概念挺好的 我们crewly也可以进行总结看看今天做的requesta进行汇总' },
    { ts: '1790425144.1', owner: true, label: 'ask', text: '<@U0C2ZK849ND> 可以开issues发给Sam' },
    { ts: '1790425144.1', owner: true, text: '<@U0C2ZK849ND> 可以开issues发给Sam' },
  ];

  it('yields one ticket per distinct ask and appends the follow-ups', async () => {
    const root = THREAD[0].ts;
    const outcomes: Array<{ label?: string; action: string }> = [];
    for (const m of THREAD) {
      const mention = /<@([A-Z0-9]+)>/.exec(m.text)?.[1];
      const o = await svc.intakeWithOutcome(
        msg({
          ts: m.ts,
          thread: root,
          text: m.text,
          isOwner: m.owner,
          ...(mention && AGENTS[mention] ? { targetAgent: AGENTS[mention] } : {}),
          ...(m.text.startsWith('[Slack File:') ? { attachments: [{ name: 'Audio Clip.m4a' }] } : {}),
        }),
      );
      outcomes.push({ label: m.label, action: o.action });
    }
    const asks = THREAD.filter((m) => m.label === 'ask').length;
    const follows = THREAD.filter((m) => m.label === 'follow').length;
    const tickets = [...store.items.values()].filter((r) => r.origin?.threadRef === `slack:C1:${root}`);

    // Examined: 8 asks and 3 follow-ups (plus duplicates and agent messages).
    expect({ asks, follows }).toEqual({ asks: 8, follows: 3 });
    // The acceptance criterion is >= 5; every labelled ask got its ticket.
    expect(tickets.length).toBeGreaterThanOrEqual(5);
    expect(tickets).toHaveLength(asks);
    expect(outcomes.filter((o) => o.label === 'ask').map((o) => o.action)).toEqual(
      ['created', ...Array(asks - 1).fill('created_in_thread')],
    );
    expect(outcomes.filter((o) => o.label === 'follow').map((o) => o.action)).toEqual(Array(follows).fill('appended'));
    // Slack's second delivery is a duplicate, never a second ticket.
    expect(outcomes.filter((o) => o.label === undefined && o.action !== 'ignored').every((o) => o.action === 'duplicate')).toBe(true);
    // Every ticket after the first points at a ticket in the same thread.
    const ids = new Set(tickets.map((t) => t.id));
    expect(tickets.filter((t) => t.parentTicketId).every((t) => ids.has(t.parentTicketId as string))).toBe(true);
    // The X-theme ask went to the agent it was addressed to.
    expect(tickets.find((t) => t.description.includes('按theme'))?.assignee).toBe('mia');
    // The written follow-ups landed in a discussion (the audio clip is a file).
    const discussed = tickets.flatMap((t) => t.discussion ?? []).map((d) => d.text);
    expect(discussed).toEqual(expect.arrayContaining(['好的 开issue可以的', expect.stringContaining('hingsight那个要写到一起吗')]));
  });
});
