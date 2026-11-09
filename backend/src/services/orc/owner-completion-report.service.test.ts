import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ORCHESTRATOR_SESSION_NAME, OWNER_COMPLETION_REPORT_CONSTANTS as C } from '../../constants.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import {
  OwnerCompletionReportService,
  answerKeysOf,
  collectOwnerChains,
  deliverableTexts,
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

  it('titles and deliverables (summary preferred over title; verify items and failures left out)', () => {
    const items = [
      item('a', { title: 'Evidence pack', result: { summary: 'Done', files: ['ops/x.md'] } }),
      item('a:v', { title: 'Verify', metadata: { verifyOf: 'a' } }),
      item('b', { title: 'Card copy' }),
      item('c', { title: 'Nope', status: 'failed' }),
    ];
    expect(titlesLine(items)).toBe('"Evidence pack", "Card copy"');
    expect(deliverableTexts(items)).toEqual(['Done', 'Card copy']);
  });

  it('work an agent delegated on its own initiative (agent origin) never forms a chain (crewly#1357)', () => {
    const items = [item('x', { origin: null, metadata: { origin: { kind: 'agent', sessionName: 'ella' }, delegatedBy: 'ella' } })];
    expect(collectOwnerChains(items, {})).toHaveLength(0);
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

  it('delegate → verify chain: nudges the receiver once after SETTLE_MS, then after NUDGE_GRACE_MS posts one plain line itself', async () => {
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
    expect(text).toContain('in plain words');
    expect(text).toContain('app-comments --app upb7se5pfj --reply QMSjXIhFanDw --text "<what the owner got>"');
    expect(text).toContain(`within ${Math.round(C.NUDGE_GRACE_MS / 60_000)} minutes, Crewly posts one line`);

    // One nudge only: no reminder during the grace period.
    now += C.NUDGE_GRACE_MS - 1;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(postFallback).not.toHaveBeenCalled();
    now += 1;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(postFallback).toHaveBeenCalledTimes(1);
    const [where, agent, line] = postFallback.mock.calls[0];
    expect(where).toMatchObject({ kind: 'app-comment', commentId: 'QMSjXIhFanDw' });
    expect(agent).toBe('lyra');
    expect(line).toBe('Lyra finished Evidence for the three-stage map, Case against and Draft ready.\n— sent by Crewly');
    expect(line).not.toContain('ops/marketing/drafts/zengming.md');
    expect(line).not.toContain('Results:');
    expect(svc.activeRecords).toHaveLength(0);

    // Never again for this chain.
    now += 10 * C.NUDGE_GRACE_MS;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(postFallback).toHaveBeenCalledTimes(1);
  });

  it('the nudge carries attempt and age, and never asks the agent to re-post what the owner has', async () => {
    const svc = make();
    items = incidentChain('verified');
    now = T0 + 20 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1]).toContain('Automatic reminder 1 of 2');
    expect(deliver.mock.calls[0][1]).toContain('send NOTHING to the owner');
    expect(deliver.mock.calls[0][1]).toContain('no work item ids, no internal links, file paths, codecs, sizes or logs');
  });

  it('the fallback line is written in the owner\'s language, names the deliverable in plain words and carries nothing internal (incident 15:47Z)', async () => {
    const ownerLanguage = jest.fn(async () => 'zh' as const);
    const svc = make({ ownerLanguage, displayNameOf: (s) => (s === 'ella' ? 'Ella' : s) });
    items = [
      item('cards', { origin: SLACK_ORIGIN, target: 'lyra', title: '排期里 5 张卡的文案（见 ops/marketing/cards.md）', at: T0, doneAt: T0 + 10 * MIN }),
      item('rec', {
        origin: SLACK_ORIGIN,
        target: 'kai',
        title: 'Two-accounts screen recording',
        at: T0 + MIN,
        doneAt: T0 + 12 * MIN,
        result: { summary: '教程页的录屏 — https://github.com/x/y/pull/12 (h264, 1920x1080, 42 MB) /Users/me/Movies/two-accounts.mp4', files: ['/Users/me/Movies/two-accounts.mp4'] },
      }),
    ];
    now = T0 + 13 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    now += C.NUDGE_GRACE_MS;
    await svc.tick();
    expect(ownerLanguage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner', slackChannelId: 'C0MKT' }), expect.objectContaining({ kind: 'slack' }));
    const line = postFallback.mock.calls[0][2];
    expect(line).toBe('Ella 做完了排期里 5 张卡的文案和教程页的录屏。\n— 由 Crewly 代发');
    expect(line).not.toMatch(/https?:|\.md|\.mp4|MB|h264|Results:|cards|rec\b/);
  });

  it('a language lookup that fails or knows nothing → English', async () => {
    const svc = make({ ownerLanguage: async () => Promise.reject(new Error('no chat')) });
    items = [item('s1', { origin: SLACK_ORIGIN, target: 'atlas', title: 'Weekly numbers', at: now, doneAt: now + MIN })];
    now += 2 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    now += C.NUDGE_GRACE_MS;
    await svc.tick();
    expect(postFallback.mock.calls[0][2]).toBe('ella finished Weekly numbers.\n— sent by Crewly');
  });

  it('a record written before crewly#1357 at stage "reminded" still ends with the one plain line', async () => {
    const svc = make();
    items = incidentChain('verified');
    now = T0 + 20 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    svc.stop();
    const file = path.join(dir, C.STORE_FILE);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const [key, record] = Object.entries(raw.active)[0] as [string, Record<string, unknown>];
    raw.active[key] = { ...record, stage: 'reminded', remindedAt: now, deliverables: undefined };
    fs.writeFileSync(file, JSON.stringify(raw));
    const second = make();
    now += C.NUDGE_GRACE_MS - 1;
    await second.tick();
    expect(postFallback).not.toHaveBeenCalled();
    now += 1;
    await second.tick();
    expect(postFallback).toHaveBeenCalledTimes(1);
    expect(postFallback.mock.calls[0][2]).toMatch(/^Lyra finished .*\.\n— sent by Crewly$/);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('finished work discovered past the cutoff (outage): no ask, no cover post; the team lead is told once', async () => {
    const notifyLead = jest.fn(async (_a: string, _t: string) => true);
    const svc = make({ notifyLead });
    items = incidentChain('verified');
    now = T0 + 20 * MIN;
    await svc.tick();
    now += 3 * 24 * 60 * MIN; // the backend was down for three days
    await svc.tick();
    await svc.tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(postFallback).not.toHaveBeenCalled();
    expect(notifyLead).toHaveBeenCalledTimes(1);
    expect(notifyLead.mock.calls[0][0]).toBe('lyra');
    expect(svc.activeRecords).toHaveLength(0);
  });

  it('reply --work-item settles the chain wherever it was posted: no reminder, no cover message (CREW-503)', async () => {
    const svc = make();
    items = [item('s1', { origin: SLACK_ORIGIN, target: 'atlas', at: now, doneAt: now + MIN })];
    now += 2 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(svc.noteWorkItemReply('s1')).toBe(1); // posted elsewhere: no answer key matched
    now += 3 * C.NUDGE_GRACE_MS;
    await svc.tick();
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(postFallback).not.toHaveBeenCalled();
    expect(svc.activeRecords).toHaveLength(0);
  });

  it('a reply naming another work item leaves the chain to be reported (negative)', async () => {
    const svc = make();
    items = [item('s1', { origin: SLACK_ORIGIN, target: 'atlas', at: now, doneAt: now + MIN })];
    now += 2 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    expect(svc.noteWorkItemReply('other')).toBe(0);
    expect(svc.noteWorkItemReply('')).toBe(0);
    expect(svc.activeRecords).toHaveLength(1);
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
    now += 2 * C.NUDGE_GRACE_MS;
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

  it('a result posted while verifying (before the item is marked verified) is the report (#1330)', async () => {
    const svc = make();
    // Worker hands over at T0+10 (verify item created), lead posts at T0+10.5, verifies at T0+11.
    items = [
      item('w', { origin: SLACK_ORIGIN, target: 'sam', at: T0, doneAt: T0 + 11 * MIN }),
      item('w:verify', { origin: SLACK_ORIGIN, target: 'ella', type: 'review', at: T0 + 10 * MIN, doneAt: T0 + 11 * MIN, metadata: { verifyOf: 'w' } }),
    ];
    now = T0 + 10 * MIN + 30_000;
    svc.noteSlackAnswer('C0MKT', '1791000000.000100');
    now = T0 + 12 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    now += 3 * C.NUDGE_GRACE_MS;
    await svc.tick();
    await svc.tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(postFallback).not.toHaveBeenCalled();
    expect(svc.activeRecords).toHaveLength(0);
  });

  it('progress posted before the work was handed over still does not count (#1330 negative)', async () => {
    const svc = make();
    items = [
      item('w', { origin: SLACK_ORIGIN, target: 'sam', at: T0, doneAt: T0 + 11 * MIN }),
      item('w:verify', { origin: SLACK_ORIGIN, target: 'ella', type: 'review', at: T0 + 10 * MIN, doneAt: T0 + 11 * MIN, metadata: { verifyOf: 'w' } }),
    ];
    now = T0 + 5 * MIN;
    svc.noteSlackAnswer('C0MKT', '1791000000.000100'); // "on it"
    now = T0 + 12 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  describe('a teammate or delegatee posted the work in the owner thread before closing its item (crewly#1376)', () => {
    /** Atlas received the owner's request; Sage built the PDF, posted it at T0+20 and closed its item at T0+30. */
    const ATLAS_ORIGIN: OwnerOrigin = { kind: 'owner', receivedBy: 'atlas', slackChannelId: 'C0C30RWA17W', threadTs: '1792277474.023779' };
    const chain = (): WorkItem[] => [
      item('pdf', { origin: ATLAS_ORIGIN, target: 'sage', title: 'Website-plan PDF built and posted in Steve thread with summary', at: T0, startedAt: iso(T0 + MIN), doneAt: T0 + 30 * MIN }),
    ];
    const runOut = async (svc: OwnerCompletionReportService): Promise<void> => {
      now = T0 + 31 * MIN;
      await svc.tick();
      now += C.SETTLE_MS;
      await svc.tick();
      now += C.NUDGE_GRACE_MS;
      await svc.tick();
    };

    it('the delegatee\'s post (also when made as the shared Crewly app on its behalf) is the report: no nudge, no fallback', async () => {
      const svc = make();
      items = chain();
      now = T0 + 20 * MIN;
      svc.noteSlackAnswer('C0C30RWA17W', '1792277474.023779', 'sage');
      await runOut(svc);
      expect(deliver).not.toHaveBeenCalled();
      expect(postFallback).not.toHaveBeenCalled();
      expect(svc.activeRecords).toHaveLength(0);
    });

    it('a teammate of the responsible agent counts too, from the work start', async () => {
      const svc = make({ teammatesOf: async (s) => (s === 'atlas' ? ['atlas', 'sage', 'mira'] : []) });
      items = chain();
      now = T0 + 20 * MIN;
      svc.noteSlackAnswer('C0C30RWA17W', '1792277474.023779', 'mira');
      await runOut(svc);
      expect(deliver).not.toHaveBeenCalled();
      expect(postFallback).not.toHaveBeenCalled();
    });

    it('a chat-v2 row by the delegatee counts as well', async () => {
      const svc = make();
      items = [item('c', { origin: { kind: 'owner', receivedBy: 'atlas', conversationId: 'conv-1' }, target: 'sage', at: T0, startedAt: iso(T0), doneAt: T0 + 30 * MIN })];
      now = T0 + 20 * MIN;
      svc.noteChatAnswer('conv-1', undefined, 'sage');
      await runOut(svc);
      expect(deliver).not.toHaveBeenCalled();
    });

    it('the responsible agent\'s own post well after the work started was its delivery: no empty "done" line (Owen, 2026-10-19)', async () => {
      const svc = make();
      items = chain();
      now = T0 + 20 * MIN;
      svc.noteSlackAnswer('C0C30RWA17W', '1792277474.023779', 'atlas');
      await runOut(svc);
      expect(postFallback).not.toHaveBeenCalled();
      expect(svc.activeRecords).toHaveLength(0);
    });

    it('negative: the responsible agent\'s own "on it", an outsider\'s post, or a post before the work started do not count', async () => {
      const svc = make({ teammatesOf: () => ['atlas', 'sage'] });
      items = chain();
      now = T0 + 30_000; // before Sage started
      svc.noteSlackAnswer('C0C30RWA17W', '1792277474.023779', 'sage');
      now = T0 + 5 * MIN;
      svc.noteSlackAnswer('C0C30RWA17W', '1792277474.023779', 'atlas');
      svc.noteSlackAnswer('C0C30RWA17W', '1792277474.023779', 'rex'); // another team, another machine
      await runOut(svc);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(postFallback).toHaveBeenCalledTimes(1);
      expect(postFallback.mock.calls[0][2]).not.toMatch(/details/);
    });

    it('a zh owner gets one plain zh line without the English title or "details later"', async () => {
      const svc = make({ ownerLanguage: async () => 'zh' });
      items = chain();
      await runOut(svc);
      const line = postFallback.mock.calls[0][2];
      expect(line).toBe('atlas 把你要的事做完了。\n— 由 Crewly 代发');
      expect(line).not.toMatch(/Website-plan|细节稍后/);
    });

    it('authors survive a restart', async () => {
      const first = make();
      items = chain();
      now = T0 + 20 * MIN;
      first.noteSlackAnswer('C0C30RWA17W', '1792277474.023779', 'sage');
      first.stop();
      await runOut(make());
      expect(postFallback).not.toHaveBeenCalled();
    });
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
    now += 3 * C.NUDGE_GRACE_MS;
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
    now += 3 * C.NUDGE_GRACE_MS;
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
    now += C.NUDGE_GRACE_MS;
    await second.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(postFallback).toHaveBeenCalledTimes(1);

    const third = make();
    now += 5 * C.NUDGE_GRACE_MS;
    await third.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
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

describe('team work the orchestrator delegated is reported by the team lead (crewly#1371)', () => {
  const ORC_DM: OwnerOrigin = { kind: 'owner', receivedBy: ORCHESTRATOR_SESSION_NAME, slackChannelId: 'D0ORC', threadTs: '1792000000.000100' };
  const MKT = { lead: 'ella', leadName: 'Ella', worker: 'luna', workerName: 'Luna', teamId: 'team-mkt', teamName: 'Marketing', slackChannelId: 'C0MKTTEAM', channelName: 'marketing' };
  const OPS = { lead: 'atlas', leadName: 'Atlas', worker: 'atlas', workerName: 'Atlas', teamId: 'team-ops', teamName: 'Ops', slackChannelId: 'C0OPSTEAM', channelName: 'ops' };

  let dir: string;
  let now: number;
  let items: WorkItem[];
  let deliver: jest.Mock<Promise<boolean>, [string, string]>;
  let postFallback: jest.Mock<Promise<boolean>, [ReportPlace, string, string]>;

  const make = (over: Partial<OwnerCompletionReportDeps> = {}): OwnerCompletionReportService =>
    new OwnerCompletionReportService({
      crewlyHome: dir,
      listItems: async () => items,
      deliver,
      resolvePlace: async (o) => ({ kind: 'slack', slackChannelId: o.slackChannelId!, threadTs: o.threadTs, label: 'Slack thread' }),
      postFallback,
      now: () => now,
      logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as never,
      ...over,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-report-lead-'));
    now = T0 - MIN;
    deliver = jest.fn(async (_s: string, _t: string) => true);
    postFallback = jest.fn(async (_p: ReportPlace, _a: string, _t: string) => true);
    // One orc DM thread, four items across two teams (the 2026-10-17 incident).
    items = [
      item('tut', { origin: ORC_DM, target: 'luna', title: 'Re-word the tutorial', at: T0, doneAt: T0 + 5 * MIN, metadata: { leadReport: MKT } }),
      item('tut:verify', { origin: ORC_DM, target: 'ella', type: 'review', at: T0 + 4 * MIN, doneAt: T0 + 5 * MIN, metadata: { verifyOf: 'tut', leadReport: MKT } }),
      item('backup', { origin: ORC_DM, target: 'atlas', title: 'Rotate backups', at: T0 + MIN, doneAt: T0 + 6 * MIN, metadata: { leadReport: OPS } }),
    ];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('one owner thread splits into one chain per team, each the lead\'s', () => {
    const chains = collectOwnerChains(items, {});
    expect(chains.map((c) => [c.key, c.responsible])).toEqual([
      ['slack:D0ORC:1792000000.000100#team:team-mkt', 'ella'],
      ['slack:D0ORC:1792000000.000100#team:team-ops', 'atlas'],
    ]);
    expect(chains[0].leadReport).toMatchObject({ channelName: 'marketing' });
  });

  it('unstamped orc work in the same thread stays the orchestrator\'s (existing behaviour)', () => {
    items.push(item('own', { origin: ORC_DM, target: 'sam', at: T0 + 2 * MIN }));
    const chains = collectOwnerChains(items, {});
    expect(chains.find((c) => c.key === 'slack:D0ORC:1792000000.000100')?.responsible).toBe(ORCHESTRATOR_SESSION_NAME);
  });

  it('nudges the lead (not the orc) to post in the team channel, then posts the fallback there as the lead', async () => {
    const svc = make({ ownerLanguage: async () => 'zh' as const });
    now = T0 + 7 * MIN;
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    expect(deliver.mock.calls.map((c) => c[0]).sort()).toEqual(['atlas', 'ella']);
    const ask = deliver.mock.calls.find((c) => c[0] === 'ella')![1];
    expect(ask).toContain('[OWNER REPORT DUE] Luna finished work the owner approved');
    expect(ask).toContain('in #marketing; the orchestrator does not relay it');
    expect(ask).toContain('(Chinese)');
    expect(ask).toContain('https://slack.com/archives/D0ORC/p1792000000000100');
    expect(ask).toContain('No ticket or work item ids, no status lines');
    expect(ask).toContain('reply --work-item tut ');
    const own = deliver.mock.calls.find((c) => c[0] === 'atlas')![1];
    expect(own).toContain('[OWNER REPORT DUE] You finished work');

    now += C.NUDGE_GRACE_MS;
    await svc.tick();
    expect(postFallback).toHaveBeenCalledTimes(2);
    const [where, as, line] = postFallback.mock.calls.find((c) => c[1] === 'ella')!;
    expect(where).toEqual({ kind: 'slack', slackChannelId: 'C0MKTTEAM', label: '#marketing' });
    expect(as).toBe('ella');
    expect(line).toBe('Luna 把你批准的事做完了。\n批准的对话：https://slack.com/archives/D0ORC/p1792000000000100\n— 由 Crewly 代发');
    expect(postFallback.mock.calls.every((c) => (c[0] as { slackChannelId: string }).slackChannelId !== 'D0ORC')).toBe(true);
  });

  it('a post in the orc thread does not count; the lead\'s reply --work-item does — even before its record exists', async () => {
    const svc = make();
    now = T0 + 6 * MIN + 30_000;
    expect(svc.noteWorkItemReply('backup')).toBe(0); // Atlas reported before the scan picked the chain up
    now = T0 + 7 * MIN;
    svc.noteSlackAnswer('D0ORC', '1792000000.000100'); // the orc posted in its thread
    await svc.tick();
    now += C.SETTLE_MS;
    await svc.tick();
    expect(deliver.mock.calls.map((c) => c[0])).toEqual(['ella']);
  });
});
