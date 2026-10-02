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
import { AgentPromptReferenceService } from '../orc/agent-prompt-reference.service.js';
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
    expect(d.card).toEqual({ slackChannelId: 'C-TEAM', messageTs: '100.0002', threadTs: '100.0001', postedBy: 'dev-ann', ownBot: true, renderRev: DECISION_CONSTANTS.CARD_RENDER_REV });
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
    // A command naming the decision, never a raw thread key (2026-10-02).
    expect(h.delivered[0].text).toContain('run: reply --decision D-1 "<your message>"');
    expect(h.delivered[0].text).not.toContain('--thread');
    expect(AgentPromptReferenceService.getInstance().get('dev-ann')?.reference).toEqual({ decisionId: 'D-1' });
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

describe('system decisions (specs/2026-10-01-runtime-terms-consent.md)', () => {
  const termsAsk = {
    kind: 'runtime_terms' as const,
    system: { key: 'antigravity-cli', defaultIsDecline: true },
    title: 'Antigravity CLI · Terms of Service (mbp)',
    question: 'Antigravity CLI on mbp needs its Terms of Service accepted once. Do you agree?',
    body: ['*Links:* <https://antigravity.google/terms|Terms of Service>'],
    options: ['Agree, no data sharing', 'Agree + share data', "Don't agree"],
    default: "Don't agree",
    sensitive: 'runtime_terms' as const,
  };
  /** Records what the runtime_terms kind handler sees. */
  const listen = (): OwnerDecision[] => {
    const settled: OwnerDecision[] = [];
    DecisionService.registerKindHandler('runtime_terms', { onSettled: async (d) => (settled.push(d), null) });
    return settled;
  };
  afterEach(() => DecisionService.registerKindHandler('runtime_terms', null));

  it("posts in the owner's DM with the orc bot and tells its kind handler, never an agent", async () => {
    const h = await harness({ ownerDmOf: async (identity) => (identity.botToken === 'xoxb-orc' ? 'D-OWNER-DM' : null) });
    const settled = listen();
    const d = await h.service.askSystem({ ...termsAsk, deadline: new Date(h.clock.now.getTime() + 24 * HOUR) });
    expect(d).toMatchObject({ asker: 'crewly-orc', requestedBy: 'crewly', card: { slackChannelId: 'D-OWNER-DM', ownBot: true } });
    expect(h.slack.sent[0]).toMatchObject({ channelId: 'D-OWNER-DM', botToken: 'xoxb-orc' });
    expect(h.slack.sent[0].threadTs).toBeUndefined();

    const out = await h.service.handleInteraction(click(d, 'b'));
    expect(out).toMatchObject({ handled: true, reason: 'resolved' });
    expect(settled.map((x) => [x.id, x.status, x.chosenKey])).toEqual([[d.id, 'resolved', 'b']]);
    expect(h.delivered).toEqual([]);

    expect(await h.service.replyInThread(d.id, 'Accepted.')).toBe(true);
    expect(h.slack.sent.at(-1)).toMatchObject({ channelId: 'D-OWNER-DM', threadTs: d.card!.messageTs, text: 'Accepted.' });
  });

  it('waits (postError) when there is no owner DM', async () => {
    const h = await harness();
    const d = await h.service.askSystem({ ...termsAsk, deadline: new Date(h.clock.now.getTime() + 24 * HOUR) });
    expect(d.card).toBeUndefined();
    expect(d.postError).toMatch(/No Slack DM with the owner/);
  });

  it('applies a declining default at the deadline even though it is sensitive', async () => {
    const h = await harness({ ownerDmOf: async () => 'D-OWNER-DM' });
    const settled = listen();
    const d = await h.service.askSystem({ ...termsAsk, deadline: new Date(h.clock.now.getTime() + 24 * HOUR) });
    h.clock.now = new Date(h.clock.now.getTime() + 25 * HOUR);
    expect(await h.service.tick()).toEqual([d.id]);
    expect(await h.service.get(d.id)).toMatchObject({ status: 'defaulted', chosenKey: 'c' });
    expect(settled).toHaveLength(1);
  });

  it('a withdrawn system decision reaches its kind handler too, and is never snoozed', async () => {
    const h = await harness({ ownerDmOf: async () => 'D-OWNER-DM' });
    const settled = listen();
    const d = await h.service.askSystem({ ...termsAsk, deadline: new Date(h.clock.now.getTime() + 24 * HOUR) });
    const snoozed = await h.service.remindFromDashboard(d.id);
    expect(snoozed.status).toBe('open');
    expect(snoozed.remindAt).toBeUndefined();
    expect(await h.service.cancelWhere((x) => x.id === d.id)).toBe(1);
    expect(settled.map((x) => [x.id, x.kind, x.status])).toEqual([[d.id, 'runtime_terms', 'cancelled']]);
    expect(h.delivered).toEqual([]);
  });

  it('rejects a bad default', async () => {
    const h = await harness();
    await expect(h.service.askSystem({ ...termsAsk, default: 'Maybe', deadline: new Date(h.clock.now.getTime() + HOUR) })).rejects.toThrow(DecisionError);
  });
});


describe('reply questions (specs/2026-10-01-reply-open-items.md)', () => {
  const handled: Array<{ d: OwnerDecision; fallback: string | null | undefined }> = [];
  beforeEach(() => {
    handled.length = 0;
    DecisionService.registerKindHandler('reply_question', {
      onSettled: async (d, fallback) => {
        handled.push({ d, fallback });
        return d.status === 'cancelled' ? null : (fallback ?? null);
      },
    });
  });
  afterEach(() => DecisionService.registerKindHandler('reply_question', null));

  const replyAsk = {
    kind: 'reply_question' as const,
    asker: 'dev-ann',
    question: '第 13 章「互评当体检用」这个读法，你同意吗？',
    options: [
      { key: 'a', label: 'Yes' },
      { key: 'b', label: 'No', detail: '删掉，只留事实' },
    ],
    defaultKey: 'b',
    yesKey: 'a',
    title: 'TKT-185 · Ann asks',
    place: { slackChannelId: 'C-BOOK', threadTs: '1790884910.228259' },
    requestRef: { requestId: 'req-1', itemId: 'q-1' },
  };

  it('is posted by the asker in the thread the question was asked in', async () => {
    const h = await harness();
    const d = await h.service.askPrebuilt({ ...replyAsk, deadline: new Date(h.clock.now.getTime() + 26 * HOUR) });
    expect(d.card).toMatchObject({ slackChannelId: 'C-BOOK', threadTs: '1790884910.228259', postedBy: 'dev-ann', ownBot: true });
    expect(h.slack.sent[0].botToken).toBe('xoxb-ann');
    expect(d.requestRef).toEqual({ requestId: 'req-1', itemId: 'q-1' });
  });

  it('the answer reaches the handler with the generic note, which the asker then gets', async () => {
    const h = await harness();
    const d = await h.service.askPrebuilt({ ...replyAsk, deadline: new Date(h.clock.now.getTime() + 26 * HOUR) });
    await h.service.handleThreadReply({ channelId: 'C-BOOK', threadTs: '1790884910.228259', ts: '300.1', text: '同意', userId: OWNER });
    expect(handled).toHaveLength(1);
    expect(handled[0].d).toMatchObject({ id: d.id, status: 'resolved', chosenKey: 'a' });
    expect(handled[0].fallback).toContain(`[DECISION ${d.id}] The owner chose "Yes"`);
    expect(h.delivered.at(-1)).toMatchObject({ session: 'dev-ann' });
    expect(h.delivered.at(-1)!.text).toContain('The owner chose "Yes"');
  });

  it('an ask-owner of the same question withdraws the reply-question card (no double card)', async () => {
    const h = await harness();
    const first = await h.service.askPrebuilt({ ...replyAsk, deadline: new Date(h.clock.now.getTime() + 26 * HOUR) });
    await h.service.ask('dev-ann', {
      question: '第 13 章「互评当体检用」这个读法你同意吗',
      options: ['Keep it', 'Delete it — keep the facts only'],
      default: 'Delete it',
    });
    expect((await h.service.get(first.id))!.status).toBe('cancelled');
    expect(handled.map((x) => x.d.status)).toEqual(['cancelled']);
    // A different question stays.
    const other = await h.service.askPrebuilt({ ...replyAsk, question: 'Use the short title?', deadline: new Date(h.clock.now.getTime() + 26 * HOUR) });
    await h.service.ask('dev-ann', { question: 'Send the partner email on Monday?', options: ['Send', 'Hold'], default: 'Hold' });
    expect((await h.service.get(other.id))!.status).toBe('open');
  });
});

describe('Skip (specs/2026-10-01-decision-skip.md)', () => {
  const handled: OwnerDecision[] = [];
  beforeEach(() => {
    handled.length = 0;
    DecisionService.registerKindHandler('reply_question', {
      onSettled: async (d, fallback) => {
        handled.push(d);
        return d.status === 'cancelled' ? null : (fallback ?? null);
      },
    });
  });
  afterEach(() => DecisionService.registerKindHandler('reply_question', null));

  const login = {
    kind: 'reply_question' as const,
    asker: 'crewly-orc',
    question: 'Claude Code 的登录链接已经发过去了，你那边登上了吗？',
    options: [
      { key: 'a', label: 'Yes' },
      { key: 'b', label: 'No' },
      { key: 'c', label: 'Reply in thread' },
    ],
    defaultKey: 'wait',
    yesKey: 'a',
    title: 'TKT-042 · Crewly Orc asks',
    place: { slackChannelId: 'D-ORC', threadTs: '1790000000.000100' },
    requestRef: { requestId: 'req-42', itemId: 'q-42' },
  };
  const skipClick = (d: OwnerDecision) => click(d, 'skip');
  const skipNote = /^\[DECISION D-\d+\] The owner skipped this — drop it, don't ask again: ".+"/;

  it('the Skip button: card shows "⤼ <owner> skipped this", the item handler sees `skipped`, the agent is told once', async () => {
    const h = await harness();
    const d = await h.service.askPrebuilt({ ...login, deadline: new Date(h.clock.now.getTime() + 26 * HOUR) });
    const out = await h.service.handleInteraction(skipClick(d));
    expect(out).toMatchObject({ handled: true, reason: 'skipped', decision: { status: 'skipped', answeredVia: 'button', answeredBy: OWNER } });
    expect(h.slack.updates).toHaveLength(1);
    expect(hasActions(h.slack.updates[0].blocks)).toBe(false);
    expect(JSON.stringify(h.slack.updates[0].blocks)).toContain('⤼ Steve skipped this · 10:00');
    expect(h.slack.updates[0].text).toContain('⤼ Steve skipped this');
    expect(handled.map((x) => [x.id, x.status])).toEqual([[d.id, 'skipped']]);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({ session: 'crewly-orc' });
    expect(h.delivered[0].text).toMatch(skipNote);
    expect(h.watchdog).toEqual([['crewly-orc', 'D-ORC', '1790000000.000100']]);
    // A second click changes nothing and tells nobody again.
    expect(await h.service.handleInteraction(skipClick(d))).toMatchObject({ handled: false, reason: 'already skipped' });
    expect(h.delivered).toHaveLength(1);
  });

  it('a ticket ask: the ticket log says it was skipped and needs-owner is cleared', async () => {
    const h = await harness();
    const d = await h.service.ask('dev-ann', ticketAsk);
    await h.service.handleInteraction(skipClick(d));
    expect(h.logged).toEqual([{ ticket: 'APP-12', line: 'owner decision D-1: skipped by the owner (button)', clear: true }]);
    expect(h.delivered[0].text).toContain('(ticket APP-12)');
  });

  it('🚫 / ⏭️ reactions and "skip" / 「不用了」 / 「算了」 / 「不管了」 replies skip', async () => {
    const h = await harness();
    const ask = { question: 'Publish the post this afternoon?', options: ['Publish', 'Not yet'], default: 'Publish' };
    const a = await h.service.ask('dev-ann', ask);
    const b = await h.service.ask('dev-ann', { ...ask, question: 'Add the chart to the post?' });
    const r = (d: OwnerDecision, reaction: string) => h.service.handleReaction({ user: OWNER, reaction, item: { channel: d.card!.slackChannelId, ts: d.card!.messageTs } });
    expect(await r(a, 'no_entry_sign')).toMatchObject({ handled: true, reason: 'skipped', decision: { answeredVia: 'reaction' } });
    expect(await r(b, 'black_right_pointing_double_triangle_with_vertical_bar')).toMatchObject({ handled: true, reason: 'skipped' });

    for (const word of ['skip', '不用了', '算了', '不管了']) {
      const h2 = await harness();
      const requestRef = { requestId: `req-${word}`, itemId: 'q-1' };
      await h2.service.askPrebuilt({ ...login, asker: 'dev-ann', requestRef, deadline: new Date(h2.clock.now.getTime() + 26 * HOUR) });
      const out = await h2.service.handleThreadReply({ channelId: 'D-ORC', threadTs: '1790000000.000100', ts: '300.1', text: word, userId: OWNER });
      expect(out).toMatchObject({ handled: true, reason: 'skipped', decision: { status: 'skipped', answeredVia: 'reply' } });
    }
  });

  it('a sensitive / system card has no Skip: skipping it picks its safe "no"', async () => {
    const h = await harness({ ownerDmOf: async () => 'D-OWNER-DM' });
    const sensitive = await h.service.ask('dev-ann', { question: 'Email the 3 partners now?', options: ['Send', 'Hold'], default: 'wait', sensitive: 'email' });
    expect(JSON.stringify(h.slack.sent.at(-1)!.blocks)).not.toContain('decision:skip');
    const out = await h.service.handleReaction({ user: OWNER, reaction: 'no_entry_sign', item: { channel: sensitive.card!.slackChannelId, ts: sensitive.card!.messageTs } });
    expect(out.decision).toMatchObject({ status: 'resolved', chosenKey: 'b' });
    const terms = await h.service.askSystem({
      kind: 'runtime_terms',
      system: { key: 'agy', defaultIsDecline: true },
      title: 'Terms',
      question: 'Antigravity CLI needs its Terms of Service accepted once. Do you agree?',
      options: ['Agree', "Don't agree"],
      default: "Don't agree",
      sensitive: 'runtime_terms',
      deadline: new Date(h.clock.now.getTime() + 24 * HOUR),
    });
    const t = await h.service.handleThreadReply({ channelId: 'D-OWNER-DM', threadTs: terms.card!.messageTs, ts: '300.2', text: '不管了', userId: OWNER });
    expect(t.decision).toMatchObject({ status: 'resolved', chosenKey: 'b' });
  });

  it('dashboard skip', async () => {
    const h = await harness();
    const d = await h.service.ask('dev-ann', ticketAsk);
    expect(await h.service.skipFromDashboard(d.id)).toMatchObject({ status: 'skipped', answeredVia: 'dashboard', answeredBy: OWNER });
    await expect(h.service.skipFromDashboard(d.id)).rejects.toMatchObject({ status: 409 });
  });

  it('the same question is not asked again in that request / ticket for 30 days', async () => {
    const h = await harness();
    const d = await h.service.askPrebuilt({ ...login, deadline: new Date(h.clock.now.getTime() + 26 * HOUR) });
    await h.service.handleInteraction(skipClick(d));
    // Same request, same words (punctuation and spacing aside): refused.
    await expect(
      h.service.askPrebuilt({ ...login, question: 'Claude Code的登录链接已经发过去了 你那边登上了吗', deadline: new Date(h.clock.now.getTime() + 26 * HOUR) }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("drop it, don't ask again") });
    expect(await h.service.findSkipped({ requestId: 'req-42' }, login.question)).toMatchObject({ id: d.id });
    // Another request, or another question: allowed.
    expect(await h.service.findSkipped({ requestId: 'req-43' }, login.question)).toBeNull();
    expect(await h.service.findSkipped({ requestId: 'req-42' }, 'Should I restart Ella now?')).toBeNull();
    // ask-owner on a skipped ticket question is refused too.
    const t = await h.service.ask('dev-ann', ticketAsk);
    await h.service.skipFromDashboard(t.id);
    await expect(h.service.ask('dev-ann', ticketAsk)).rejects.toMatchObject({ status: 409 });
    // After 30 days it may be asked again.
    h.clock.now = new Date(h.clock.now.getTime() + DECISION_CONSTANTS.SKIP_DEDUPE_MS + HOUR);
    expect(await h.service.findSkipped({ requestId: 'req-42' }, login.question)).toBeNull();
  });
});

describe('bulk skip (specs/2026-10-01-decision-skip.md §3)', () => {
  beforeEach(() => DecisionService.registerKindHandler('reply_question', { onSettled: async (_d, fallback) => fallback ?? null }));
  afterEach(() => DecisionService.registerKindHandler('reply_question', null));

  const reply = (n: number, extra: Record<string, unknown> = {}) => ({
    kind: 'reply_question' as const,
    asker: 'dev-ann',
    question: `Old question number ${n} — still want it?`,
    options: [
      { key: 'a', label: 'Yes' },
      { key: 'b', label: 'No' },
    ],
    defaultKey: 'wait',
    place: { slackChannelId: 'C-BOOK', threadTs: `17900.00${n}` },
    requestRef: { requestId: `req-${n}`, itemId: `q-${n}` },
    ...extra,
  });

  /** Three yesterday's cards (2 backfilled, 1 live) and one of today. */
  async function seed(h: Harness) {
    h.clock.now = new Date(2026, 8, 30, 15, 0, 0);
    const deadline = new Date(2026, 9, 5, 12, 0);
    const b1 = await h.service.askPrebuilt({ ...reply(1, { source: 'backfill' }), deadline });
    const b2 = await h.service.askPrebuilt({ ...reply(2), deadline }); // legacy: no source, asked 3 days before it was carded
    const live = await h.service.ask('dev-ann', { question: 'Use the blue cover?', options: ['Blue', 'Red'], default: 'Blue' });
    const sensitive = await h.service.ask('tl-sam', { question: 'Email the partners now?', options: ['Send', 'Hold'], default: 'wait', sensitive: 'email' });
    h.clock.now = new Date(2026, 9, 1, 10, 0, 0);
    const today = await h.service.askPrebuilt({ ...reply(5, { source: 'backfill' }), deadline });
    return { b1, b2, live, sensitive, today };
  }

  it('dry run: reports what matches (by date and source) and changes nothing', async () => {
    const h = await harness({ openItemAskedAt: async (ref) => (ref.itemId === 'q-2' ? new Date(2026, 8, 27, 9, 0).toISOString() : undefined) });
    const s = await seed(h);
    h.slack.updates.length = 0;
    const startOfToday = new Date(2026, 9, 1, 0, 0, 0);
    const all = await h.service.skipAll({ olderThan: startOfToday, dryRun: true });
    expect(all).toMatchObject({ dryRun: true, matched: 4, settled: [] });
    expect(all.rows.map((r) => [r.id, r.source, r.outcome]).sort()).toEqual(
      [
        [s.b1.id, 'backfill', 'skipped'],
        [s.b2.id, 'backfill', 'skipped'],
        [s.live.id, 'live', 'skipped'],
        [s.sensitive.id, 'live', 'declined'],
      ].sort(),
    );
    const backfill = await h.service.skipAll({ source: 'backfill', dryRun: true });
    expect(backfill.rows.map((r) => r.id).sort()).toEqual([s.b1.id, s.b2.id, s.today.id].sort());
    expect(h.slack.updates).toHaveLength(0);
    expect(h.delivered).toHaveLength(0);
    expect((await h.service.list('open')).length).toBe(5);
  });

  it('apply: skips the matching cards, updates each card, and tells each agent ONCE', async () => {
    const h = await harness({ openItemAskedAt: async (ref) => (ref.itemId === 'q-2' ? new Date(2026, 8, 27, 9, 0).toISOString() : undefined) });
    const s = await seed(h);
    h.slack.updates.length = 0;
    const out = await h.service.skipAll({ olderThan: new Date(2026, 9, 1, 0, 0, 0) });
    expect(out.dryRun).toBe(false);
    expect(out.settled.sort()).toEqual([s.b1.id, s.b2.id, s.live.id, s.sensitive.id].sort());
    for (const id of [s.b1.id, s.b2.id, s.live.id]) expect(await h.service.get(id)).toMatchObject({ status: 'skipped', answeredVia: 'bulk', answeredBy: OWNER });
    expect(await h.service.get(s.sensitive.id)).toMatchObject({ status: 'resolved', chosenKey: 'b', answeredVia: 'bulk' });
    expect(await h.service.get(s.today.id)).toMatchObject({ status: 'open' });
    expect(h.slack.updates).toHaveLength(4);
    expect(h.slack.updates.every((u) => !hasActions(u.blocks))).toBe(true);
    // dev-ann had 3 cards: one combined note. tl-sam: its one note.
    const ann = h.delivered.filter((x) => x.session === 'dev-ann');
    expect(ann).toHaveLength(1);
    expect(ann[0].text).toMatch(/^\[DECISIONS\] The owner cleared 3 old cards of yours\. Drop each of these and don't ask again:/);
    expect(h.delivered.filter((x) => x.session === 'tl-sam')).toHaveLength(1);
    // Running it again finds nothing.
    expect(await h.service.skipAll({ olderThan: new Date(2026, 9, 1, 0, 0, 0) })).toMatchObject({ matched: 0, settled: [] });
  });

  it('source backfill leaves live cards alone', async () => {
    const h = await harness();
    const s = await seed(h);
    const out = await h.service.skipAll({ source: 'backfill' });
    // Without openItemAskedAt the legacy card (no source) is not known to be backfilled.
    expect(out.settled.sort()).toEqual([s.b1.id, s.today.id].sort());
    expect(await h.service.get(s.live.id)).toMatchObject({ status: 'open' });
    expect(await h.service.get(s.b2.id)).toMatchObject({ status: 'open' });
  });
});

describe('stale card redraw (layout revisions)', () => {
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-redraw-'));
  });

  it('redraws open cards drawn before the current layout once, and leaves current/settled ones alone', async () => {
    const h = await harness();
    const asked = await h.service.ask('dev-ann', ticketAsk);
    const fresh = await h.deps.store.get(asked.id);
    expect(fresh?.card?.renderRev).toBe(DECISION_CONSTANTS.CARD_RENDER_REV);
    // Simulate a card posted by an older version (no renderRev).
    await h.deps.store.update(asked.id, (cur) => (cur.card ? { card: { ...cur.card, renderRev: undefined } } : null));
    expect(await h.service.refreshStaleCards(0)).toBe(1);
    expect(h.slack.updates).toHaveLength(1);
    expect((await h.deps.store.get(asked.id))?.card?.renderRev).toBe(DECISION_CONSTANTS.CARD_RENDER_REV);
    // Second pass: nothing left to redraw.
    expect(await h.service.refreshStaleCards(0)).toBe(0);
    expect(h.slack.updates).toHaveLength(1);
  });

  it('does nothing while Slack is disconnected', async () => {
    const h = await harness();
    const asked = await h.service.ask('dev-ann', ticketAsk);
    await h.deps.store.update(asked.id, (cur) => (cur.card ? { card: { ...cur.card, renderRev: undefined } } : null));
    h.slack.connected = false;
    expect(await h.service.refreshStaleCards(0)).toBe(0);
    expect(h.slack.updates).toHaveLength(0);
  });
});

