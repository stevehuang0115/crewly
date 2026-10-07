import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ORCHESTRATOR_SESSION_NAME, OWNER_COMPLETION_REPORT_CONSTANTS as C } from '../../constants.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import {
  OwnerCompletionReportService,
  answerKeysOf,
  collectOwnerChains,
  evidenceLines,
  ownerPlaceKey,
  titlesLine,
  type OwnerCompletionReportDeps,
  type OwnerOrigin,
  type ReportPlace,
} from './owner-completion-report.service.js';

const T0 = Date.parse('2026-10-07T13:44:00Z');
const MIN = 60_000;

/** The 2026-10-07 owner request: Lyra got the app comment, Ella ran the tickets. */
const APP_ORIGIN: OwnerOrigin = {
  kind: 'owner',
  receivedBy: 'lyra',
  appComment: { appId: 'upb7se5pfj', commentId: 'QMSjXIhFanDw' },
  slackChannelId: 'C0C2WMFB9EF',
  threadTs: '1791380650.784969',
};
const SLACK_ORIGIN: OwnerOrigin = { kind: 'owner', receivedBy: 'ella', conversationId: 'room-mkt', slackChannelId: 'C0MKT', threadTs: '1791000000.000100' };

const iso = (t: number): string => new Date(t).toISOString();

function item(id: string, over: Partial<WorkItem> & { origin?: OwnerOrigin | null; at?: number; doneAt?: number } = {}): WorkItem {
  const { origin = APP_ORIGIN, at = T0, doneAt, ...rest } = over;
  const status: WorkItemStatus = rest.status ?? 'verified';
  return {
    id,
    type: 'delegate',
    owner: 'agent',
    target: 'sage',
    title: `Task ${id}`,
    status,
    createdAt: iso(at),
    ...(doneAt !== undefined ? { completedAt: iso(doneAt) } : ['verified', 'done', 'done_by_worker'].includes(status) ? { completedAt: iso(at + 10 * MIN) } : {}),
    retryCount: 0,
    maxRetries: 3,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    ...rest,
    metadata: { ...(origin ? { origin } : {}), ...(rest.metadata ?? {}) },
  } as WorkItem;
}

describe('owner chain helpers', () => {
  it('place keys: app comment, Slack thread / DM, chat', () => {
    expect(ownerPlaceKey(APP_ORIGIN)).toBe('app:upb7se5pfj/QMSjXIhFanDw');
    expect(ownerPlaceKey(SLACK_ORIGIN)).toBe('slack:C0MKT:1791000000.000100');
    expect(ownerPlaceKey({ kind: 'owner', slackChannelId: 'D0DM' })).toBe('slack:D0DM');
    expect(ownerPlaceKey({ kind: 'owner', conversationId: 'conv', chatThreadId: 'root' })).toBe('chat:conv:root');
    expect(ownerPlaceKey({ kind: 'owner' })).toBeNull();
  });

  it('an app comment is answered in the app and in its Slack thread', () => {
    expect(answerKeysOf(APP_ORIGIN)).toEqual(['app:upb7se5pfj/QMSjXIhFanDw', 'slack:C0C2WMFB9EF:1791380650.784969']);
  });

  it('groups work by owner place; only agent-created owner work (receivedBy) forms a chain; trigger work never does', () => {
    const items = [
      item('a', { at: T0 }),
      item('a:verify', { at: T0 + 11 * MIN, type: 'review', target: 'ella', metadata: { verifyOf: 'a' } }),
      item('b', { at: T0 + MIN, target: 'kai', status: 'running' }),
      item('cron', { origin: null, metadata: { origin: { kind: 'trigger', topic: 'daily' } } }),
      item('sys', { origin: { kind: 'owner', conversationId: 'x' } }),
    ];
    const chains = collectOwnerChains(items, {});
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({ key: 'app:upb7se5pfj/QMSjXIhFanDw', open: true, responsible: 'lyra' });
    expect(chains[0].items.map((w) => w.id)).toEqual(['a', 'b', 'a:verify']);
  });

  it('a ticket-linked item with a stamped owner origin stays in the owner chain', () => {
    const linked = item('t', { metadata: { projectTicket: { projectPath: '/p', id: 'CREW-305' } } });
    expect(collectOwnerChains([linked], {})[0]?.key).toBe('app:upb7se5pfj/QMSjXIhFanDw');
  });

  it('cancelled / failed count as closed; at least one success is needed', () => {
    const chains = collectOwnerChains([item('x', { status: 'cancelled' }), item('y', { status: 'failed' })], {});
    expect(chains[0]).toMatchObject({ open: false, succeeded: false });
    expect(collectOwnerChains([item('x', { status: 'cancelled' }), item('z')], {})[0]).toMatchObject({ open: false, succeeded: true });
    expect(collectOwnerChains([item('w', { status: 'done_by_worker' })], {})[0].open).toBe(true);
  });

  it('items created at or before handledThrough belong to a handled chain', () => {
    expect(collectOwnerChains([item('old', { at: T0 })], { 'app:upb7se5pfj/QMSjXIhFanDw': T0 })).toHaveLength(0);
  });

  it('titles and evidence', () => {
    const items = [
      item('a', { title: 'Evidence pack', result: { summary: 'Done', files: ['ops/x.md'] } }),
      item('a:v', { title: 'Verify', metadata: { verifyOf: 'a' } }),
    ];
    expect(titlesLine(items)).toBe('"Evidence pack"');
    expect(evidenceLines(items)).toEqual(['Evidence pack: Done — ops/x.md']);
  });
});

describe('OwnerCompletionReportService', () => {
  let dir: string;
  let now: number;
  let items: WorkItem[];
  let deliver: jest.Mock<Promise<boolean>, [string, string]>;
  let postFallback: jest.Mock<Promise<boolean>, [ReportPlace, string, string]>;

  const place = (origin: OwnerOrigin): ReportPlace =>
    origin.appComment
      ? { kind: 'app-comment', appId: origin.appComment.appId, commentId: origin.appComment.commentId, slackChannelId: origin.slackChannelId, threadTs: origin.threadTs, label: 'the owner\'s app comment' }
      : { kind: 'slack', slackChannelId: origin.slackChannelId!, threadTs: origin.threadTs, label: 'Slack thread' };

  const make = (over: Partial<OwnerCompletionReportDeps> = {}): OwnerCompletionReportService =>
    new OwnerCompletionReportService({
      crewlyHome: dir,
      listItems: async () => items,
      deliver,
      resolvePlace: async (o) => place(o),
      postFallback,
      displayNameOf: (s) => (s === 'lyra' ? 'Lyra' : s),
      appCommentsCmd: 'app-comments',
      now: () => now,
      logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as never,
      ...over,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-report-'));
    now = T0 - MIN; // the service starts before the work
    items = [];
    deliver = jest.fn(async (_s: string, _t: string) => true);
    postFallback = jest.fn(async (_p: ReportPlace, _a: string, _t: string) => true);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Sage + Kai delegated by Ella (CREW-309/310), verified; Luna's draft (CREW-305). */
  function incidentChain(status: WorkItemStatus = 'verified'): WorkItem[] {
    return [
      item('sage', { target: 'sage', title: 'Evidence for the three-stage map', at: T0, metadata: { projectTicket: { projectPath: '/p', id: 'CREW-309' } } }),
      item('sage:verify', { target: 'ella', type: 'review', at: T0 + 11 * MIN, metadata: { verifyOf: 'sage' } }),
      item('kai', { target: 'kai', title: 'Case against', at: T0 + MIN }),
      item('luna', { target: 'luna', title: 'Draft for Steve', at: T0 + 2 * MIN, status, result: { summary: 'Draft ready', files: ['ops/marketing/drafts/zengming.md'] } }),
    ];
  }

  it('delegate → verify chain: asks the receiver once after SETTLE_MS, reminds after REPORT_WAIT_MS, then posts the summary itself', async () => {
    const svc = make();
    items = incidentChain('done_by_worker');
    now = T0 + 20 * MIN;
    await svc.tick();
    expect(svc.activeRecords).toHaveLength(0); // Luna's draft still awaits verification

    items = incidentChain('verified');
    await svc.tick();
    expect(svc.activeRecords[0]?.stage).toBe('settling');
    expect(deliver).not.toHaveBeenCalled();

    now += C.SETTLE_MS;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    const [to, text] = deliver.mock.calls[0];
    expect(to).toBe('lyra');
    expect(text).toContain('The work the owner asked for in the owner\'s app comment is finished (');
    expect(text).toContain('"Draft for Steve"');
    expect(text).toContain('app-comments --app upb7se5pfj --reply QMSjXIhFanDw --text "<summary + where the files are>"');

    now += C.REPORT_WAIT_MS - 1;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    now += 1;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][1]).toContain('reminder');

    now += C.REPORT_WAIT_MS;
    await svc.tick();
    expect(postFallback).toHaveBeenCalledTimes(1);
    const [where, agent, summary] = postFallback.mock.calls[0];
    expect(where).toMatchObject({ kind: 'app-comment', commentId: 'QMSjXIhFanDw' });
    expect(agent).toBe('lyra');
    expect(summary).toMatch(/^Lyra finished: /);
    expect(summary).toContain('ops/marketing/drafts/zengming.md');
    expect(summary).toContain('— sent by Crewly because no report was posted.');
    expect(svc.activeRecords).toHaveLength(0);

    // Never again for this chain.
    now += 10 * C.REPORT_WAIT_MS;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(postFallback).toHaveBeenCalledTimes(1);
  });

  it('an agent answer in the owner place after the work finished ends it (before asking, or after the ask)', async () => {
    const svc = make();
    items = incidentChain();
    now = T0 + 20 * MIN;
    await svc.tick();
    svc.noteSlackAnswer('C0C2WMFB9EF', '1791380650.784969'); // Lyra posted in the comment's Slack thread
    now += C.SETTLE_MS;
    await svc.tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(svc.activeRecords).toHaveLength(0);

    // Second place: answered after the ask → no reminder, no fallback.
    items = [item('s1', { origin: SLACK_ORIGIN, target: 'atlas', at: now, doneAt: now + MIN })];
    now += 2 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1]).toContain('reply --work-item s1 ');
    now += MIN;
    svc.noteChatAnswer('room-mkt');
    now += 2 * C.REPORT_WAIT_MS;
    await svc.tick();
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(postFallback).not.toHaveBeenCalled();
  });

  it('progress posted before the work finished does not count as the report', async () => {
    const svc = make();
    now = T0 + 5 * MIN;
    svc.noteAppCommentAnswer('upb7se5pfj', 'QMSjXIhFanDw'); // "draft goes to you first"
    items = incidentChain();
    now = T0 + 20 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('more work joining while settling restarts the wait; nothing is asked while work is open', async () => {
    const svc = make();
    items = [item('kai', { at: T0, doneAt: T0 + 5 * MIN })];
    now = T0 + 6 * MIN;
    await svc.tick();
    expect(svc.activeRecords).toHaveLength(1);
    items = [...items, item('luna', { at: now, status: 'running' })];
    now += C.SETTLE_MS;
    await svc.tick();
    expect(svc.activeRecords).toHaveLength(0);
    expect(deliver).not.toHaveBeenCalled();
    items = [items[0], item('luna', { at: T0 + 6 * MIN, doneAt: now })];
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1]).toContain('"Task luna"');
  });

  it('skips chains the orchestrator received (its own delivery enforcer covers them)', async () => {
    const svc = make();
    items = [item('o', { origin: { ...SLACK_ORIGIN, receivedBy: ORCHESTRATOR_SESSION_NAME } })];
    now = T0 + 20 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    now += 3 * C.REPORT_WAIT_MS;
    await svc.tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(postFallback).not.toHaveBeenCalled();
    expect(svc.activeRecords).toHaveLength(0);
  });

  it('does not report chains that finished before it first started', async () => {
    now = T0 + 60 * MIN;
    const svc = make();
    items = incidentChain();
    await svc.tick();
    now += 3 * C.REPORT_WAIT_MS;
    await svc.tick();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('later work in the same place is a new chain (reported on its own)', async () => {
    const svc = make();
    items = [item('first', { origin: SLACK_ORIGIN, at: T0, doneAt: T0 + MIN })];
    now = T0 + 2 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    svc.noteSlackAnswer('C0MKT', '1791000000.000100');
    now += MIN;
    await svc.tick();
    expect(svc.activeRecords).toHaveLength(0);

    items = [...items, item('second', { origin: SLACK_ORIGIN, at: now, doneAt: now + MIN })];
    now += 2 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][1]).toContain('"Task second"');
    expect(deliver.mock.calls[1][1]).not.toContain('"Task first"');
  });

  it('survives a restart: the step reached is kept and never repeated', async () => {
    const first = make();
    items = incidentChain();
    now = T0 + 20 * MIN;
    await first.tick();
    now += C.SETTLE_MS;
    await first.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    first.stop();

    const second = make();
    expect(second.activeRecords[0]?.stage).toBe('asked');
    await second.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    now += C.REPORT_WAIT_MS;
    await second.tick();
    expect(deliver).toHaveBeenCalledTimes(2);
    now += C.REPORT_WAIT_MS;
    await second.tick();
    expect(postFallback).toHaveBeenCalledTimes(1);

    const third = make();
    now += 5 * C.REPORT_WAIT_MS;
    await third.tick();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(postFallback).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, C.STORE_FILE), 'utf-8')).ended).toEqual({ [`app:upb7se5pfj/QMSjXIhFanDw#${T0}`]: expect.any(Number) });
  });

  it('an unresolvable place is skipped, not retried forever', async () => {
    const svc = make({ resolvePlace: async () => null });
    items = incidentChain();
    now = T0 + 20 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(svc.activeRecords).toHaveLength(0);
  });

  it('a failing pool read never throws out of tick', async () => {
    const svc = make({ listItems: async () => Promise.reject(new Error('disk')) });
    await expect(svc.tick()).resolves.toBeUndefined();
  });
});
