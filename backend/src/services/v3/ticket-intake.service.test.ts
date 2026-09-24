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
  svc = new TicketIntakeService({ requests: store });
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
    // A question is not a task: the classifier calls it a query (or not
    // actionable at all, for a short one) — either way no ticket.
    for (const [i, text] of ['what is the status of the deploy?', 'which agents are working on the billing project right now'].entries()) {
      const outcome = await svc.intakeWithOutcome(msg({ ts: `6.${i}`, text }));
      expect(outcome.action).toBe('ignored');
      expect(['query', 'not_actionable']).toContain(outcome.action === 'ignored' ? outcome.reason : '');
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
