/**
 * Tests for the decision card service (specs/2026-10-01-decision-cards.md):
 * routing to the asker's own bot in the ticket thread, answers by button /
 * reaction / thread reply, deadlines, sensitive re-ask + park — with a mocked
 * Slack Web API and an injected clock.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DECISION_CONSTANTS } from '../../constants.js';
import { DecisionService, DecisionError, type DecisionServiceDeps, type DecisionSlackApi, type BlockActionsPayload } from './decision.service.js';
import { DecisionStore } from './decision-store.js';
import { TicketThreadStore } from './ticket-thread-store.js';
import type { ComponentLogger } from '../core/logger.service.js';
import type { SlackOutgoingMessage, SlackBlock } from '../../types/slack.types.js';
import type { OwnerDecision } from '../../types/decision.types.js';

const quiet = (): ComponentLogger => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as unknown as ComponentLogger;
const HOUR = 60 * 60 * 1000;
const OWNER = 'U-OWNER';

/** Records every Slack Web API call; returns increasing ts values. */
class FakeSlack implements DecisionSlackApi {
  sent: SlackOutgoingMessage[] = [];
  updates: Array<{ channelId: string; ts: string; text: string; blocks?: SlackBlock[]; botToken?: string }> = [];
  connected = true;
  failTokens = new Set<string>();
  failAll = false;
  private n = 0;
  isConnected(): boolean {
    return this.connected;
  }
  async sendMessage(m: SlackOutgoingMessage): Promise<string> {
    if (this.failAll) throw Object.assign(new Error('An API error occurred: channel_not_found'), { data: { error: 'channel_not_found' } });
    if (m.botToken && this.failTokens.has(m.botToken)) throw Object.assign(new Error('not_in_channel'), { data: { error: 'not_in_channel' } });
    this.sent.push(m);
    this.n += 1;
    return `100.${String(this.n).padStart(4, '0')}`;
  }
  async updateMessage(channelId: string, ts: string, text: string, blocks?: SlackBlock[], botToken?: string): Promise<void> {
    this.updates.push({ channelId, ts, text, blocks, botToken });
  }
}

interface Harness {
  service: DecisionService;
  slack: FakeSlack;
  deps: DecisionServiceDeps;
  clock: { now: Date };
  delivered: Array<{ session: string; text: string }>;
  logged: Array<{ ticket: string; line: string; clear: boolean }>;
  watchdog: Array<[string, string, string]>;
  threads: TicketThreadStore;
}

let dir: string;

async function harness(over: Partial<DecisionServiceDeps> = {}): Promise<Harness> {
  const clock = { now: new Date(2026, 9, 1, 10, 0, 0) };
  const slack = new FakeSlack();
  const delivered: Harness['delivered'] = [];
  const logged: Harness['logged'] = [];
  const watchdog: Harness['watchdog'] = [];
  const threads = TicketThreadStore.inHome(dir);
  const deps: DecisionServiceDeps = {
    store: new DecisionStore(path.join(dir, 'decisions.json'), () => clock.now),
    threads,
    slack: () => slack,
    instanceId: () => 'inst-1',
    isOwner: (u) => u === OWNER,
    ownerUserId: () => OWNER,
    userName: async () => 'Steve',
    identityOf: async (session) => (session === 'crewly-orc' ? { botToken: 'xoxb-orc' } : session === 'dev-ann' ? { botToken: 'xoxb-ann', username: 'Ann' } : { username: session }),
    teamChannelOf: async (teamId) => (teamId === 'team-a' ? 'C-TEAM' : null),
    teamOf: async (session) => (session === 'dev-ann' || session === 'tl-sam' ? 'team-a' : undefined),
    resolveTicket: async (project, id) => {
      if (id === 'APP-404') throw new DecisionError(404, 'Ticket not found');
      return { projectId: project, projectPath: '/proj', projectName: 'Proj', id, title: 'Partner outreach email', asker: 'dev-ann', teamId: 'team-a' };
    },
    markTicketAsked: jest.fn().mockResolvedValue(undefined),
    logTicket: async (ticket, line, clear) => void logged.push({ ticket: ticket.id, line, clear }),
    deliverToAgent: async (session, text) => {
      delivered.push({ session, text });
      return true;
    },
    closeWatchdog: (s, c, t) => void watchdog.push([s, c, t]),
    now: () => clock.now,
    logger: quiet(),
    ...over,
  };
  return { service: new DecisionService(deps), slack, deps, clock, delivered, logged, watchdog, threads };
}

const ticketAsk = {
  question: 'Send the draft to the 3 partners?',
  options: ['Send Monday — after the review call', 'Hold — wait for legal'],
  default: 'Hold',
  ticket: 'APP-12',
  project: 'p1',
};

function click(d: OwnerDecision, option: string, extra: Partial<BlockActionsPayload> = {}, value?: Record<string, string>): BlockActionsPayload {
  return {
    type: 'block_actions',
    user: { id: OWNER, name: 'steve' },
    actions: [{ action_id: `decision:${option}`, value: JSON.stringify(value ?? { d: d.id, o: option, i: 'inst-1' }), action_ts: '200.1' }],
    container: { channel_id: d.card!.slackChannelId, message_ts: d.card!.messageTs },
    ...extra,
  };
}

const hasActions = (blocks?: SlackBlock[]) => (blocks ?? []).some((b) => b.type === ('actions' as never));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-svc-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ask + routing', () => {
  it('a ticket ask is posted by the ASSIGNEE bot in the ticket thread; the first ask creates the thread', async () => {
    const h = await harness();
    const d = await h.service.ask('crewly-orc', ticketAsk);
    expect(d.asker).toBe('dev-ann');
    expect(d.requestedBy).toBe('crewly-orc');
    expect(d.status).toBe('open');
    // root, then the card in its thread — both with Ann's token, none with the orc's
    expect(h.slack.sent).toHaveLength(2);
    expect(h.slack.sent.every((m) => m.botToken === 'xoxb-ann')).toBe(true);
    expect(h.slack.sent[0]).toMatchObject({ channelId: 'C-TEAM', text: '*APP-12 · Partner outreach email*' });
    expect(h.slack.sent[0].threadTs).toBeUndefined();
    expect(h.slack.sent[1]).toMatchObject({ channelId: 'C-TEAM', threadTs: '100.0001' });
    expect(hasActions(h.slack.sent[1].blocks)).toBe(true);
    expect(d.card).toEqual({ slackChannelId: 'C-TEAM', messageTs: '100.0002', threadTs: '100.0001', postedBy: 'dev-ann', ownBot: true });
    expect(await h.threads.get('/proj', 'APP-12')).toMatchObject({ slackChannelId: 'C-TEAM', threadTs: '100.0001' });
    expect(h.deps.markTicketAsked).toHaveBeenCalledWith(expect.objectContaining({ id: 'APP-12', asker: 'dev-ann' }), 'Send the draft to the 3 partners?', 'D-1');

    const second = await h.service.ask('dev-ann', { ...ticketAsk, question: 'Use the short version of the draft?' });
    expect(h.slack.sent).toHaveLength(3);
    expect(h.slack.sent[2]).toMatchObject({ channelId: 'C-TEAM', threadTs: '100.0001' });
    expect(second.card?.threadTs).toBe('100.0001');
  });

  it('rejects a vague ask with a 400 and stores nothing', async () => {
    const h = await harness();
    await expect(h.service.ask('dev-ann', { ...ticketAsk, question: 'thoughts?' })).rejects.toMatchObject({ status: 400 });
    expect(await h.service.list('all')).toEqual([]);
  });

  it('a non-ticket ask goes to the work destination, else the team channel top level', async () => {
    const withWork = await harness({ workDestination: async () => ({ slackChannelId: 'C-OWNERTHREAD', threadTs: '50.5' }) });
    const a = await withWork.service.ask('dev-ann', { question: 'Use the blue logo on the site?', options: ['Blue', 'Green'], default: 'Blue' });
    expect(a.card).toMatchObject({ slackChannelId: 'C-OWNERTHREAD', threadTs: '50.5' });
    const none = await harness({ workDestination: async () => null });
    const b = await none.service.ask('dev-ann', { question: 'Use the blue logo on the site?', options: ['Blue', 'Green'], default: 'Blue' });
    expect(b.card?.slackChannelId).toBe('C-TEAM');
    expect(b.card?.threadTs).toBeUndefined();
    expect(none.slack.sent).toHaveLength(1);
  });

  it('own-bot failure falls back to the shared bot with the name', async () => {
    const h = await harness();
    h.slack.failTokens.add('xoxb-ann');
    const d = await h.service.ask('dev-ann', ticketAsk);
    expect(d.card?.ownBot).toBe(false);
    expect(d.card?.postedBy).toBe('crewly');
    expect(h.slack.sent.every((m) => !m.botToken && m.username === 'Ann')).toBe(true);
  });

  it('a card that cannot be posted keeps postError and is retried on the tick', async () => {
    const h = await harness();
    h.slack.failAll = true;
    const d = await h.service.ask('dev-ann', ticketAsk);
    expect(d.card).toBeUndefined();
    expect(d.postError).toBe('channel_not_found');
    h.slack.failAll = false;
    // Not retried on every tick — only after POST_RETRY_MS.
    expect(await h.service.tick()).toEqual([]);
    h.clock.now = new Date(h.clock.now.getTime() + DECISION_CONSTANTS.POST_RETRY_MS);
    expect(await h.service.tick()).toEqual([d.id]);
    const after = await h.service.get(d.id);
    expect(after?.card).toBeDefined();
    expect(after?.postError).toBeUndefined();
  });

  it('Slack not connected → postError', async () => {
    const h = await harness();
    h.slack.connected = false;
    const d = await h.service.ask('dev-ann', ticketAsk);
    expect(d.postError).toBe('Slack is not connected');
  });
});

describe('button clicks', () => {
  it('resolves: card updated in place with the posting bot token, ticket logged, asker told, watchdog closed', async () => {
    const h = await harness();
    const d = await h.service.ask('dev-ann', ticketAsk);
    const out = await h.service.handleInteraction(click(d, 'a'));
    expect(out).toMatchObject({ handled: true, reason: 'resolved' });
    expect(out.decision).toMatchObject({ status: 'resolved', chosenKey: 'a', answeredBy: OWNER, answeredVia: 'button' });
    expect(h.slack.updates).toHaveLength(1);
    const u = h.slack.updates[0];
    expect(u).toMatchObject({ channelId: 'C-TEAM', ts: d.card!.messageTs, botToken: 'xoxb-ann' });
    expect(hasActions(u.blocks)).toBe(false);
    expect(JSON.stringify(u.blocks)).toContain('✔ Steve chose *Send Monday* · 10:00');
    expect(h.logged).toEqual([{ ticket: 'APP-12', line: 'owner decision D-1: Send Monday (button)', clear: true }]);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].session).toBe('dev-ann');
    expect(h.delivered[0].text).toMatch(/^\[DECISION D-1\] The owner chose "Send Monday" for: "Send the draft to the 3 partners\?" \(ticket APP-12\)\. Act on it now\./);
    expect(h.watchdog).toEqual([['dev-ann', 'C-TEAM', '100.0001']]);

    // a second click is ignored
    const again = await h.service.handleInteraction(click(d, 'b'));
    expect(again).toMatchObject({ handled: false, reason: 'already resolved' });
    expect(h.delivered).toHaveLength(1);
  });

  it('keeps needs-owner while another decision on the ticket is open', async () => {
    const h = await harness();
    const d1 = await h.service.ask('dev-ann', ticketAsk);
    await h.service.ask('dev-ann', { ...ticketAsk, question: 'Use the short version of the draft?' });
    await h.service.handleInteraction(click(d1, 'a'));
    expect(h.logged[0].clear).toBe(false);
  });

  it('ignores non-owners, other instances, wrong messages, foreign actions', async () => {
    const h = await harness();
    const d = await h.service.ask('dev-ann', ticketAsk);
    expect(await h.service.handleInteraction(click(d, 'a', { user: { id: 'U-STRANGER' } }))).toMatchObject({ handled: false, reason: 'not the owner' });
    expect((await h.service.handleInteraction(click(d, 'a', {}, { d: d.id, o: 'a', i: 'inst-2' }))).reason).toMatch(/instance inst-2/);
    expect(await h.service.handleInteraction(click(d, 'a', { container: { channel_id: 'C-TEAM', message_ts: '999.9' } }))).toMatchObject({ handled: false, reason: 'click is not on the stored card' });
    expect(await h.service.handleInteraction({ actions: [{ action_id: 'content_approval_approve', value: 'x' }] })).toMatchObject({ handled: false });
    expect(await h.service.handleInteraction(click(d, 'a', {}, { d: 'D-99', o: 'a', i: 'inst-1' }))).toMatchObject({ handled: false, reason: 'unknown decision D-99' });
    expect(h.delivered).toHaveLength(0);
    expect((await h.service.get(d.id))?.status).toBe('open');
  });

  it('Remind me tomorrow: remindAt 09:00 tomorrow, deadline ≥ remindAt + 24h, card refreshed with buttons', async () => {
    const h = await harness();
    const d = await h.service.ask('dev-ann', ticketAsk);
    const out = await h.service.handleInteraction(click(d, 'remind'));
    expect(out).toMatchObject({ handled: true, reason: 'snoozed' });
    const s = out.decision!;
    expect(new Date(s.remindAt!)).toEqual(new Date(2026, 9, 2, 9, 0, 0));
    expect(Date.parse(s.deadline)).toBeGreaterThanOrEqual(Date.parse(s.remindAt!) + DECISION_CONSTANTS.REMIND_GRACE_MS);
    expect(h.slack.updates).toHaveLength(1);
    expect(hasActions(h.slack.updates[0].blocks)).toBe(true);
    expect(JSON.stringify(h.slack.updates[0].blocks)).toContain('Reminding you tomorrow 09:00');
    expect(h.delivered).toHaveLength(0);
    expect(h.logged[0]).toMatchObject({ line: 'owner decision D-1: remind tomorrow (button)', clear: false });
  });
});

describe('reactions', () => {
  it('✅ = default, ❌ = the no option, ⏰ = remind; others and non-owners ignored', async () => {
    const h = await harness();
    const opts = { question: 'Publish the post this afternoon?', options: ['Publish', 'No'], default: 'Publish' };
    const a = await h.service.ask('dev-ann', opts);
    const b = await h.service.ask('dev-ann', opts);
    const c = await h.service.ask('dev-ann', opts);
    const r = (d: OwnerDecision, reaction: string, user = OWNER) => h.service.handleReaction({ user, reaction, item: { channel: d.card!.slackChannelId, ts: d.card!.messageTs } });
    expect(await r(a, 'white_check_mark', 'U-X')).toMatchObject({ handled: false, reason: 'not the owner' });
    expect(await r(a, 'tada')).toMatchObject({ handled: false });
    expect((await r(a, 'white_check_mark')).decision).toMatchObject({ status: 'resolved', chosenKey: 'a', answeredVia: 'reaction' });
    expect((await r(b, 'x')).decision).toMatchObject({ status: 'resolved', chosenKey: 'b' });
    expect((await r(c, 'alarm_clock')).reason).toBe('snoozed');
    expect(await h.service.handleReaction({ user: OWNER, reaction: 'x', item: { channel: 'C-TEAM', ts: '1.1' } })).toMatchObject({ handled: false, reason: 'not a decision card' });
  });
});

describe('thread replies', () => {
  it('"go with Hold", "yes", free text; agents and top-level messages ignored', async () => {
    const h = await harness();
    const d = await h.service.ask('dev-ann', ticketAsk);
    const reply = (text: string, extra: Record<string, unknown> = {}) =>
      h.service.handleThreadReply({ channelId: 'C-TEAM', threadTs: '100.0001', ts: '300.1', text, userId: OWNER, ...extra });
    expect(await reply('go with Hold', { authorAgentSession: 'dev-bob' })).toMatchObject({ handled: false, reason: 'written by an agent' });
    expect(await h.service.handleThreadReply({ channelId: 'C-TEAM', ts: '300.1', text: 'Hold', userId: OWNER })).toMatchObject({ handled: false });
    expect((await reply('go with Hold')).decision).toMatchObject({ status: 'resolved', chosenKey: 'b', answeredVia: 'reply' });
    expect(await reply('yes')).toMatchObject({ handled: false, reason: 'no open card in this thread' });

    const d2 = await h.service.ask('dev-ann', { ...ticketAsk, question: 'Use the short version of the draft?' });
    expect((await reply('yes')).decision).toMatchObject({ id: d2.id, chosenKey: 'b' });

    const d3 = await h.service.ask('dev-ann', { ...ticketAsk, question: 'Add the pricing table to the draft?' });
    const out = await reply('only to two of them, skip Acme');
    expect(out.decision).toMatchObject({ id: d3.id, status: 'resolved', answerText: 'only to two of them, skip Acme' });
    expect(h.delivered[h.delivered.length - 1].text).toContain('The owner answered in words');
    expect(JSON.stringify(h.slack.updates[h.slack.updates.length - 1].blocks)).toContain('answered: “only to two of them, skip Acme”');
    expect(d.id).toBe('D-1');
  });
});

describe('dashboard', () => {
  it('choose and remind; unknown option 400; settled 409', async () => {
    const h = await harness();
    const d = await h.service.ask('dev-ann', ticketAsk);
    await expect(h.service.chooseFromDashboard(d.id, 'zzz')).rejects.toMatchObject({ status: 400 });
    expect((await h.service.remindFromDashboard(d.id)).remindAt).toBeDefined();
    expect(await h.service.chooseFromDashboard(d.id, 'Hold')).toMatchObject({ status: 'resolved', chosenKey: 'b', answeredVia: 'dashboard' });
    await expect(h.service.chooseFromDashboard(d.id, 'a')).rejects.toMatchObject({ status: 409 });
    await expect(h.service.chooseFromDashboard('D-404', 'a')).rejects.toMatchObject({ status: 404 });
  });
});

describe('deadlines', () => {
  it('non-sensitive: the default is applied and said in the thread', async () => {
    const h = await harness();
    const d = await h.service.ask('dev-ann', ticketAsk);
    expect(await h.service.tick()).toEqual([]);
    h.clock.now = new Date(2026, 9, 2, 12, 1);
    expect(await h.service.tick()).toEqual([d.id]);
    const after = await h.service.get(d.id);
    expect(after).toMatchObject({ status: 'defaulted', chosenKey: 'b', answeredVia: 'deadline' });
    const line = h.slack.sent[h.slack.sent.length - 1];
    expect(line).toMatchObject({ threadTs: '100.0001', botToken: 'xoxb-ann', text: 'No answer by 12:00 — going with Hold.' });
    expect(hasActions(h.slack.updates[h.slack.updates.length - 1].blocks)).toBe(false);
    expect(h.delivered[0].text).toMatch(/Going with the default: "Hold"\. Act on it now\./);
    expect(h.logged[0]).toMatchObject({ clear: true });
    expect(await h.service.tick()).toEqual([]);
  });

  it('wait default: stays open, one notice only', async () => {
    const h = await harness();
    const d = await h.service.ask('dev-ann', { ...ticketAsk, default: 'wait' });
    h.clock.now = new Date(2026, 9, 2, 12, 1);
    expect(await h.service.tick()).toEqual([d.id]);
    const after = await h.service.get(d.id);
    expect(after?.status).toBe('open');
    expect(after?.deadlineNoticeAt).toBeDefined();
    expect(h.slack.sent[h.slack.sent.length - 1].text).toBe("No answer by 12:00 — I'll keep waiting.");
    expect(h.delivered[0].text).toContain('keep this work parked');
    const sentBefore = h.slack.sent.length;
    h.clock.now = new Date(2026, 9, 3, 12, 1);
    expect(await h.service.tick()).toEqual([]);
    expect(h.slack.sent).toHaveLength(sentBefore);
  });

  it('sensitive: never applied; re-ask once at max(deadline, ask + 24h), parked 24h later', async () => {
    const h = await harness();
    const d = await h.service.ask('dev-ann', { ...ticketAsk, default: 'Send Monday', sensitive: 'email', deadline: new Date(2026, 9, 1, 12, 0).toISOString() });
    h.clock.now = new Date(2026, 9, 1, 13, 0); // past the deadline, < 24h after asking
    expect(await h.service.tick()).toEqual([]);
    expect((await h.service.get(d.id))?.status).toBe('open');
    h.clock.now = new Date(2026, 9, 2, 10, 0); // ask + 24h
    expect(await h.service.tick()).toEqual([d.id]);
    const reasked = await h.service.get(d.id);
    expect(reasked).toMatchObject({ status: 'open' });
    expect(reasked?.reaskedAt).toBeDefined();
    expect(h.slack.sent[h.slack.sent.length - 1].text).toMatch(/^<@U-OWNER> Still need your answer: .*needs your OK \(email\)/);
    h.clock.now = new Date(2026, 9, 2, 20, 0);
    expect(await h.service.tick()).toEqual([]);
    h.clock.now = new Date(2026, 9, 3, 10, 0); // re-ask + 24h
    expect(await h.service.tick()).toEqual([d.id]);
    const parked = await h.service.get(d.id);
    expect(parked?.status).toBe('parked');
    expect(parked?.chosenKey).toBeUndefined();
    expect(h.delivered.some((m) => /PARKED: do not do it/.test(m.text))).toBe(true);
    expect(h.delivered.some((m) => /Act on it now/.test(m.text))).toBe(false);
    expect((await h.service.list('open')).map((x) => x.id)).toContain(d.id);
    // the owner can still answer a parked decision from the dashboard
    expect(await h.service.chooseFromDashboard(d.id, 'a')).toMatchObject({ status: 'resolved' });
  });

  it('remindAt due → reminder posted in the thread, card refreshed', async () => {
    const h = await harness();
    const d = await h.service.ask('dev-ann', ticketAsk);
    await h.service.handleInteraction(click(d, 'remind'));
    h.clock.now = new Date(2026, 9, 2, 9, 0, 30);
    expect(await h.service.tick()).toEqual([d.id]);
    const reminder = h.slack.sent[h.slack.sent.length - 1];
    expect(reminder).toMatchObject({ threadTs: '100.0001', text: '<@U-OWNER> Reminder: Send the draft to the 3 partners? (answer on the card above)' });
    expect((await h.service.get(d.id))?.remindAt).toBeUndefined();
    // deadline moved past noon: nothing applied yet
    h.clock.now = new Date(2026, 9, 2, 12, 30);
    expect(await h.service.tick()).toEqual([]);
  });
});

describe('cancel', () => {
  it('withdraws open decisions and updates the card', async () => {
    const h = await harness();
    const d = await h.service.ask('dev-ann', ticketAsk);
    expect(await h.service.cancelWhere((x) => x.id === d.id)).toBe(1);
    expect((await h.service.get(d.id))?.status).toBe('cancelled');
    expect(JSON.stringify(h.slack.updates[0].blocks)).toContain('Withdrawn');
  });
});
