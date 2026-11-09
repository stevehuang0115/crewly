jest.mock('../core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) }) },
}));

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  OwnerThreadSentinelService,
  detectPromise,
  getOwnerThreadSentinel,
  onAgentSlackPost,
  owingAgentsOnDisk,
  parsePromisedMinutes,
  reportOwnerThreadAgentPost,
  reportOwnerThreadBlocking,
  setOwnerThreadSentinel,
  statusLineFor,
  threadKey,
  type OwnerThreadSentinelDeps,
  type SlackThreadRef,
} from './owner-thread-sentinel.service.js';

const MIN = 60_000;
const CH = 'C0C30RWA17W';
const TS = '1791476100.000100';
const THREAD: SlackThreadRef = { slackChannelId: CH, threadTs: TS };
const ATLAS = 'think-tank-atlas-b4e166f6';

interface Harness {
  sentinel: OwnerThreadSentinelService;
  posts: Array<{ thread: SlackThreadRef; agent: string; text: string }>;
  nudges: Array<{ agent: string; text: string }>;
  clock: { t: number };
}

function make(overrides: Partial<OwnerThreadSentinelDeps> = {}): Harness {
  const clock = { t: Date.parse('2026-10-08T16:00:00Z') };
  const posts: Harness['posts'] = [];
  const nudges: Harness['nudges'] = [];
  const sentinel = new OwnerThreadSentinelService({
    postAllStates: true,
    postStatus: async (thread, agent, text) => {
      posts.push({ thread, agent, text });
      return true;
    },
    nudgeAgent: async (agent, text) => {
      nudges.push({ agent, text });
      return true;
    },
    displayNameOf: (s) => (s === ATLAS ? 'Atlas' : s),
    now: () => clock.t,
    ...overrides,
  });
  return { sentinel, posts, nudges, clock };
}

/** The owner asked Atlas in the thread; Atlas promised "~15 min". */
function promised(h: Harness, text = "I'll read the attachments via Chrome now, ~15 min"): void {
  h.sentinel.noteOwnerMessage({ ...THREAD, agent: ATLAS, at: h.clock.t });
  h.clock.t += MIN;
  h.sentinel.noteAgentPost({ ...THREAD, agent: ATLAS, text, at: h.clock.t });
}

describe('promise detection', () => {
  it.each([
    ["I'm reading the attachments now, ~15 min", 15],
    ['On it — ETA 10-20 minutes', 20],
    ['I will report back in 1.5h', 90],
    ['马上看，预计十五分钟', 15],
    ['等我一下，半小时内给你', 30],
    ['正在跑，几分钟', 5],
  ])('%s → promise of %s min', (text, minutes) => {
    expect(detectPromise(text)).toEqual({ minutes });
  });

  it.each([["I'm checking the logs"], ['Let me look into it'], ['稍后发你']])('%s → promise without a time', (text) => {
    expect(detectPromise(text)).toEqual({});
  });

  it.each([['Done — the report is attached.'], ['The answer is 42.'], ['Took 15 min but it is finished.'], ['']])('%s → no promise', (text) => {
    expect(detectPromise(text)).toBeNull();
  });

  it('parses minutes without a promise word', () => {
    expect(parsePromisedMinutes('about 2 hours')).toBe(120);
    expect(parsePromisedMinutes('no time here')).toBeUndefined();
  });

  it.each([['收到。视频做好发到 #awesome-videos'], ['上线后告诉你'], ['好了发你'], ['完成后发给你']])('%s → delivery promise (#1240)', (text) => {
    expect(detectPromise(text)).not.toBeNull();
  });

  it('an already-done delivery report is not a promise', () => {
    expect(detectPromise('已经做好，发在这里了')).toBeNull();
  });

  it('does not time promises longer than the cap', () => {
    expect(detectPromise("I'll have it in 20 hours")).toEqual({});
  });
});

describe('status lines', () => {
  it('names the card with a link, and the slot stop in plain words', () => {
    expect(statusLineFor({ kind: 'card_posted', decisionId: 'D-476', question: 'Atlas wants to click "Download"', link: 'https://x' }, 'Atlas')).toBe(
      '⏳ Atlas is waiting for your OK: Atlas wants to click "Download" — <https://x|Approve here>',
    );
    expect(statusLineFor({ kind: 'stopped', why: 'slot' }, 'Atlas')).toBe(
      '⏸ Atlas was paused to free a slot for another agent; it resumes automatically when one frees (your request is kept).',
    );
    expect(statusLineFor({ kind: 'card_settled', decisionId: 'D-1' }, 'Atlas')).toBeNull();
  });
});

describe('triggers', () => {
  it('card posted top-level while the owner waits in a thread → one line in the thread with the card link', async () => {
    const h = make();
    promised(h);
    const n = await h.sentinel.noteBlocking(ATLAS, {
      kind: 'card_posted',
      decisionId: 'D-476',
      question: 'Atlas wants to click "Download" on mail.google.com',
      link: 'https://slack.com/archives/C0C30RWA17W/p1791477541548000',
      place: { slackChannelId: CH, threadTs: '1791477541.548000' },
      browser: true,
    });
    expect(n).toBe(1);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].thread).toEqual(THREAD);
    expect(h.posts[0].text).toContain('⏳ Atlas is waiting for your OK');
    expect(h.posts[0].text).toContain('|Approve here>');
  });

  it('card posted IN the owner thread → no extra line (the card is the status)', async () => {
    const h = make();
    promised(h);
    expect(await h.sentinel.noteBlocking(ATLAS, { kind: 'card_posted', decisionId: 'D-1', question: 'q', place: THREAD })).toBe(0);
    expect(h.posts).toHaveLength(0);
    expect(h.sentinel.list()[0].cards.map((c) => c.id)).toEqual(['D-1']);
  });

  it('browser card expiry → a line, then one re-ask nudge if no new card follows', async () => {
    const h = make();
    promised(h);
    await h.sentinel.noteBlocking(ATLAS, { kind: 'card_posted', decisionId: 'D-476', question: 'q', place: THREAD, browser: true });
    h.clock.t += 12 * MIN;
    await h.sentinel.noteBlocking(ATLAS, { kind: 'card_expired', decisionId: 'D-476', question: 'q', browser: true, why: 'Crewly restarted and the held action was lost' });
    expect(h.posts.map((p) => p.text)).toEqual([
      "⚠️ Atlas's approval request expired before you answered (Crewly restarted and the held action was lost). Atlas is asking again — the new card will show up here.",
    ]);
    h.clock.t += 2 * MIN;
    await h.sentinel.tick();
    expect(h.nudges).toHaveLength(0);
    h.clock.t += 2 * MIN;
    await h.sentinel.tick();
    expect(h.nudges).toHaveLength(1);
    expect(h.nudges[0].text).toContain('approval card D-476 expired');
    // The promise clock waited while the card was open and for 10 min after
    // it closed; still nothing from Atlas → the overdue-promise line, but the
    // re-ask nudge is never repeated.
    h.clock.t += 10 * MIN;
    await h.sentinel.tick();
    expect(h.nudges.filter((n) => n.text.includes('approval card'))).toHaveLength(1);
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1].text.startsWith("⏱ Atlas said ~15 min")).toBe(true);
  });

  it('no re-ask nudge when the agent posts a new card in time', async () => {
    const h = make();
    promised(h);
    await h.sentinel.noteBlocking(ATLAS, { kind: 'card_posted', decisionId: 'D-476', question: 'q', place: THREAD, browser: true });
    await h.sentinel.noteBlocking(ATLAS, { kind: 'card_expired', decisionId: 'D-476', question: 'q', browser: true });
    h.clock.t += MIN;
    await h.sentinel.noteBlocking(ATLAS, { kind: 'card_posted', decisionId: 'D-477', question: 'q', place: THREAD, browser: true });
    h.clock.t += 10 * MIN;
    await h.sentinel.tick();
    expect(h.nudges).toHaveLength(0);
  });

  it('a settled card stops the thread waiting on it, with no line', async () => {
    const h = make();
    h.sentinel.noteOwnerMessage({ ...THREAD, agent: ATLAS, at: h.clock.t });
    await h.sentinel.noteBlocking(ATLAS, { kind: 'card_posted', decisionId: 'D-9', question: 'q', place: THREAD });
    await h.sentinel.noteBlocking(ATLAS, { kind: 'card_settled', decisionId: 'D-9' });
    expect(h.sentinel.list()[0].cards).toEqual([]);
    expect(h.posts).toHaveLength(0);
  });

  it('work blocked in an owner-origin thread → line there, even when it was not watched yet', async () => {
    const h = make();
    await h.sentinel.noteBlocking(ATLAS, { kind: 'work_blocked', reason: 'awaiting owner browser approval', thread: THREAD });
    expect(h.posts).toEqual([{ thread: THREAD, agent: ATLAS, text: '⏸ Atlas is blocked: awaiting owner browser approval Your request is kept.' }]);
  });

  it('work blocked / stopped while a card is open → no line (the card says why)', async () => {
    const h = make();
    promised(h);
    await h.sentinel.noteBlocking(ATLAS, { kind: 'card_posted', decisionId: 'D-1', question: 'q', place: THREAD });
    await h.sentinel.noteBlocking(ATLAS, { kind: 'work_blocked', reason: 'awaiting owner browser approval' });
    await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' });
    expect(h.posts).toHaveLength(0);
  });

  it.each([
    [{ kind: 'stopped', why: 'slot' } as const, '⏸ Atlas was paused to free a slot'],
    [{ kind: 'stopped', why: 'idle' } as const, '⏸ Atlas was stopped to save memory'],
    [{ kind: 'start_failed', detail: 'claude exited 1' } as const, '⚠️ Atlas could not start: claude exited 1'],
    [{ kind: 'start_deferred' } as const, '⏳ Atlas is queued to start'],
    [{ kind: 'delivery_held', why: 'unreadable' } as const, "⚠️ Messages to Atlas are on hold: Crewly can't read its input box"],
  ])('%o → line in the waiting thread', async (event, prefix) => {
    const h = make();
    promised(h);
    expect(await h.sentinel.noteBlocking(ATLAS, event)).toBe(1);
    expect(h.posts[0].thread).toEqual(THREAD);
    expect(h.posts[0].text.startsWith(prefix)).toBe(true);
  });

  it('owner work from a thread makes it watched (ownerWorkThread)', async () => {
    const h = make({ ownerWorkThread: async () => THREAD });
    expect(await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' })).toBe(1);
    expect(h.posts[0].thread).toEqual(THREAD);
  });

  it('nothing is posted for an agent no owner thread waits on', async () => {
    const h = make();
    h.sentinel.noteOwnerMessage({ ...THREAD, agent: ATLAS, at: h.clock.t });
    h.clock.t += MIN;
    h.sentinel.noteAgentPost({ ...THREAD, agent: ATLAS, text: 'Done — both PDFs are summarised above.' });
    expect(await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' })).toBe(0);
    expect(await h.sentinel.noteBlocking('someone-else', { kind: 'stopped', why: 'slot' })).toBe(0);
    expect(h.posts).toHaveLength(0);
  });

  it('a stale owner message (past the active window) is not a waiting thread', async () => {
    const h = make();
    h.sentinel.noteOwnerMessage({ ...THREAD, agent: ATLAS, at: h.clock.t });
    h.clock.t += 7 * 60 * MIN;
    expect(await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' })).toBe(0);
  });

  it('a DM top-level post matches the DM thread the owner wrote in', async () => {
    const h = make();
    h.sentinel.noteOwnerMessage({ slackChannelId: 'D123', threadTs: '1.1', agent: ATLAS, at: h.clock.t });
    h.sentinel.noteAgentPost({ slackChannelId: 'D123', agent: ATLAS, text: 'Working on it, ~10 min' });
    expect(h.sentinel.list()[0].promise?.minutes).toBe(10);
  });

  it('a DM top-level answer settles the owed DM thread even when the top level has its own entry', async () => {
    const h = make();
    // Earlier top-level exchange, already answered.
    h.sentinel.noteOwnerMessage({ slackChannelId: 'D123', agent: ATLAS, at: h.clock.t });
    h.sentinel.noteAgentPost({ slackChannelId: 'D123', agent: ATLAS, text: 'Done.', at: h.clock.t + MIN });
    // The owner asks in a thread; the agent promises there, then answers at the top level.
    h.clock.t += 60 * MIN;
    h.sentinel.noteOwnerMessage({ slackChannelId: 'D123', threadTs: '2.2', agent: ATLAS, at: h.clock.t });
    h.sentinel.noteAgentPost({ slackChannelId: 'D123', threadTs: '2.2', agent: ATLAS, text: 'Looking at the screenshots, ~5 min', at: h.clock.t + 10_000 });
    h.clock.t += MIN;
    h.sentinel.noteAgentPost({ slackChannelId: 'D123', agent: ATLAS, text: 'Conclusion: keep the current plan.', at: h.clock.t });
    h.clock.t += 3 * 60 * MIN;
    expect(h.sentinel.owingAgents()).toEqual([]);
  });
});

describe('dedupe', () => {
  it('the same state twice → one line', async () => {
    const h = make();
    promised(h);
    await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' });
    h.clock.t += 30 * MIN;
    await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' });
    expect(h.posts).toHaveLength(1);
  });

  it('informational lines are 2 min apart; actionable ones are not held', async () => {
    const h = make();
    promised(h);
    await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' });
    h.clock.t += 30_000;
    await h.sentinel.noteBlocking(ATLAS, { kind: 'start_deferred' });
    expect(h.posts).toHaveLength(1);
    await h.sentinel.noteBlocking(ATLAS, { kind: 'start_failed', detail: 'boom' });
    expect(h.posts).toHaveLength(2);
    h.clock.t += 3 * MIN;
    await h.sentinel.noteBlocking(ATLAS, { kind: 'start_deferred' });
    expect(h.posts).toHaveLength(3);
  });

  it('flapping A → B → A within 10 min does not repeat A', async () => {
    const h = make();
    promised(h);
    await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' });
    h.clock.t += 3 * MIN;
    await h.sentinel.noteBlocking(ATLAS, { kind: 'start_deferred' });
    h.clock.t += 3 * MIN;
    await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' });
    expect(h.posts).toHaveLength(2);
    h.clock.t += 6 * MIN;
    await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' });
    expect(h.posts).toHaveLength(3);
  });

  it("an agent post in the thread resets the state", async () => {
    const h = make();
    promised(h);
    await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' });
    h.sentinel.noteAgentPost({ ...THREAD, agent: ATLAS, text: "I'm back, continuing — ~5 min" });
    await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' });
    expect(h.posts).toHaveLength(2);
  });

  it('a failed post is retried on the next event', async () => {
    let ok = false;
    const posts: string[] = [];
    const h = make({ postStatus: async (_t, _a, text) => { if (ok) posts.push(text); return ok; } });
    promised(h);
    await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' });
    ok = true;
    await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' });
    expect(posts).toHaveLength(1);
  });

  it('posts an agent-wide event in only the most recent thread', async () => {
    const h = make();
    for (let i = 0; i < 5; i++) h.sentinel.noteOwnerMessage({ slackChannelId: CH, threadTs: `1.${i}`, agent: ATLAS, at: h.clock.t + i });
    expect(await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' })).toBe(1);
  });
});

describe('promise deadline', () => {
  it('"~15 min" with no post by 22.5 min → one line saying what the agent is doing, and one nudge', async () => {
    const h = make({ currentActivity: async () => 'busy on “Read Michael PDFs” (running)' });
    promised(h);
    h.clock.t += 20 * MIN;
    await h.sentinel.tick();
    expect(h.posts).toHaveLength(0);
    h.clock.t += 3 * MIN;
    await h.sentinel.tick();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].text).toBe(
      "⏱ Atlas said ~15 min, 23 min ago, and hasn't posted since. Right now: busy on “Read Michael PDFs” (running). I've asked Atlas for an update here.",
    );
    expect(h.nudges).toHaveLength(1);
    expect(h.nudges[0].text).toContain(`reply --thread ${CH}:${TS}`);
    h.clock.t += 30 * MIN;
    await h.sentinel.tick();
    expect(h.posts).toHaveLength(1);
    expect(h.nudges).toHaveLength(1);
  });

  it('no deadline line when the agent posted again in time', async () => {
    const h = make();
    promised(h);
    h.clock.t += 10 * MIN;
    h.sentinel.noteAgentPost({ ...THREAD, agent: ATLAS, text: 'Here are both summaries.' });
    h.clock.t += 30 * MIN;
    await h.sentinel.tick();
    expect(h.posts).toHaveLength(0);
    expect(h.nudges).toHaveLength(0);
  });

  it('a promise without a time is timed by silence: nudged once after 45 min, not at 44 (#1240)', async () => {
    const h = make();
    promised(h, '收到。视频做好发到 #awesome-videos');
    h.clock.t += 44 * MIN;
    await h.sentinel.tick();
    expect(h.nudges).toHaveLength(0);
    h.clock.t += 2 * MIN;
    await h.sentinel.tick();
    expect(h.nudges).toHaveLength(1);
    expect(h.nudges[0].text).toContain('you would post the result');
    expect(h.posts[0].text).toContain('said it would post the result');
    h.clock.t += 60 * MIN;
    await h.sentinel.tick();
    expect(h.nudges).toHaveLength(1);
  });

  it('any agent post in the thread resets the silence clock (#1240)', async () => {
    const h = make();
    promised(h, '视频做好发到 #awesome-videos');
    h.clock.t += 40 * MIN;
    h.sentinel.noteAgentPost({ ...THREAD, agent: ATLAS, text: '这是第一版。' });
    h.clock.t += 40 * MIN;
    await h.sentinel.tick();
    expect(h.nudges).toHaveLength(0);
  });

  it('chatter with no promise starts no clock (#1240)', async () => {
    const h = make();
    promised(h, 'The answer is 42.');
    h.clock.t += 120 * MIN;
    await h.sentinel.tick();
    expect(h.nudges).toHaveLength(0);
    expect(h.posts).toHaveLength(0);
  });
});

describe('slot / idle preference and boot restore', () => {
  it('owesRecently: unanswered owner message or promise in the last 30 min', () => {
    const h = make();
    expect(h.sentinel.owesRecently(ATLAS)).toBe(false);
    promised(h);
    expect(h.sentinel.owesRecently(ATLAS)).toBe(true);
    h.clock.t += 31 * MIN;
    expect(h.sentinel.owesRecently(ATLAS)).toBe(false);
    h.sentinel.noteOwnerMessage({ ...THREAD, agent: ATLAS, at: h.clock.t });
    expect(h.sentinel.owesRecently(ATLAS)).toBe(true);
  });

  it('owesOwner: a promise holds for hours, an unanswered owner message for under two (idle stop, 2026-10-10)', () => {
    const h = make();
    promised(h);
    h.clock.t += 31 * MIN;
    expect(h.sentinel.owesRecently(ATLAS)).toBe(false);
    expect(h.sentinel.owesOwner(ATLAS)).toBe(true);
    h.clock.t += 6 * 60 * MIN;
    expect(h.sentinel.owesOwner(ATLAS)).toBe(false);
    h.sentinel.noteOwnerMessage({ ...THREAD, agent: ATLAS, at: h.clock.t });
    h.clock.t += 61 * MIN;
    expect(h.sentinel.owesOwner(ATLAS)).toBe(true);
    h.clock.t += 61 * MIN;
    expect(h.sentinel.owesOwner(ATLAS)).toBe(false);
  });

  it('ownerActiveRecently: the owner wrote to the agent (answered or not) or it promised, within two hours (crewly#1344)', () => {
    const h = make();
    expect(h.sentinel.ownerActiveRecently(ATLAS)).toBe(false);
    h.sentinel.noteOwnerMessage({ ...THREAD, agent: ATLAS, at: h.clock.t });
    h.sentinel.noteAgentPost({ ...THREAD, agent: ATLAS, text: 'Done — the draft is above.' });
    // Answered, so nothing is owed — but the conversation is live.
    expect(h.sentinel.owesOwner(ATLAS)).toBe(false);
    expect(h.sentinel.ownerActiveRecently(ATLAS)).toBe(true);
    h.clock.t += 2 * 60 * MIN + MIN;
    expect(h.sentinel.ownerActiveRecently(ATLAS)).toBe(false);
    expect(h.sentinel.ownerActiveRecently('nobody')).toBe(false);
  });

  it('ownerThreadFor: the thread a card should go into', () => {
    const h = make();
    expect(h.sentinel.ownerThreadFor(ATLAS)).toBeNull();
    promised(h);
    expect(h.sentinel.ownerThreadFor(ATLAS)).toEqual(THREAD);
  });

  describe('persistence', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('a promise or an open card survives a restart: the agent is work in hand, and the thread hears about the restart once', async () => {
      const storePath = path.join(dir, 'owner-thread-sentinel.json');
      const h = make({ storePath });
      promised(h);
      h.sentinel.noteOwnerMessage({ slackChannelId: CH, threadTs: '2.2', agent: 'vera', at: h.clock.t });
      h.sentinel.noteAgentPost({ slackChannelId: CH, threadTs: '2.2', agent: 'vera', text: 'Done, posted the draft.' });
      await h.sentinel.noteBlocking('ella', { kind: 'work_blocked', thread: { slackChannelId: CH, threadTs: '3.3' } });
      await h.sentinel.noteBlocking('ella', { kind: 'card_posted', decisionId: 'D-5', question: 'q', place: { slackChannelId: CH, threadTs: '3.3' } });

      expect(owingAgentsOnDisk(storePath, h.clock.t).sort()).toEqual([ATLAS, 'ella'].sort());

      const after = make({ storePath });
      after.clock.t = h.clock.t + 5 * MIN;
      await after.sentinel.tick();
      expect(after.posts.map((p) => p.text)).toEqual([
        '🔄 Crewly restarted while Atlas was on this. Your request is kept; Atlas picks it up when it is back — reply here if you need it sooner.',
      ]);
      await after.sentinel.tick();
      expect(after.posts).toHaveLength(1);
    });

    it('a corrupt or missing state file means nobody is owed', () => {
      expect(owingAgentsOnDisk(path.join(dir, 'missing.json'))).toEqual([]);
    });

    // crewly#1344: a thread from 10-07 whose owner last wrote on 10-08 was
    // re-stamped "restarted" on every boot and listed as work in hand for ten days.
    it('a thread with no owner activity for three days is dropped at load and never counted as owed', async () => {
      const storePath = path.join(dir, 'owner-thread-sentinel.json');
      const h = make({ storePath });
      promised(h);
      expect(owingAgentsOnDisk(storePath, h.clock.t)).toEqual([ATLAS]);

      const later = h.clock.t + 3 * 24 * 60 * MIN + MIN;
      expect(owingAgentsOnDisk(storePath, later)).toEqual([]);
      // Loaded three days later (the clock is read at load).
      const after = make({ storePath, now: () => later });
      expect(after.sentinel.list()).toEqual([]);
      await after.sentinel.tick();
      expect(after.posts).toEqual([]);
      // The pruned file stays pruned for the next boot too.
      expect(JSON.parse(readFileSync(storePath, 'utf8')).entries).toEqual([]);
    });

    it('a thread whose agent is no longer on this machine (its team moved away) is dropped at load and on a tick', async () => {
      const storePath = path.join(dir, 'owner-thread-sentinel.json');
      const h = make({ storePath });
      promised(h);
      h.sentinel.noteOwnerMessage({ slackChannelId: CH, threadTs: '2.2', agent: 'vera', at: h.clock.t });

      expect(owingAgentsOnDisk(storePath, h.clock.t, (agent) => agent !== ATLAS)).toEqual(['vera']);
      const after = make({ storePath, agentOnThisMachine: (agent) => agent !== ATLAS });
      after.clock.t = h.clock.t + 5 * MIN;
      expect(after.sentinel.list().map((e) => e.agent)).toEqual(['vera']);
      await after.sentinel.tick();
      expect(after.posts.map((p) => p.text)).not.toEqual(expect.arrayContaining([expect.stringContaining('Atlas')]));

      // Vera's team moves away while running: the next tick forgets her thread.
      let present = true;
      const live = make({ storePath, agentOnThisMachine: () => present });
      live.clock.t = after.clock.t;
      expect(live.sentinel.owesOwner('vera')).toBe(true);
      present = false;
      await live.sentinel.tick();
      expect(live.sentinel.owesOwner('vera')).toBe(false);
      expect(live.sentinel.list()).toEqual([]);
    });
  });
});

describe('singleton helpers', () => {
  afterEach(() => setOwnerThreadSentinel(null));

  it('report* are no-ops without a sentinel and forward with one', async () => {
    expect(getOwnerThreadSentinel()).toBeNull();
    reportOwnerThreadBlocking(ATLAS, { kind: 'stopped', why: 'slot' });
    reportOwnerThreadAgentPost({ ...THREAD, agent: ATLAS, text: 'x' });
    const h = make();
    setOwnerThreadSentinel(h.sentinel);
    h.sentinel.noteOwnerMessage({ ...THREAD, agent: ATLAS, at: h.clock.t });
    reportOwnerThreadAgentPost({ ...THREAD, agent: ATLAS, text: 'On it, ~5 min' });
    expect(h.sentinel.list()[0].promise?.minutes).toBe(5);
    reportOwnerThreadBlocking(ATLAS, { kind: 'stopped', why: 'slot' });
    await new Promise((r) => setImmediate(r));
    expect(h.posts).toHaveLength(1);
    expect(threadKey(THREAD)).toBe(`${CH}:${TS}`);
  });

  it('agent post listeners get every post with its author, survive a throwing listener and unsubscribe (crewly#1376)', () => {
    const seen: string[] = [];
    const offBad = onAgentSlackPost(() => {
      throw new Error('boom');
    });
    const off = onAgentSlackPost((p) => seen.push(`${p.agent}@${p.slackChannelId}:${p.threadTs}`));
    reportOwnerThreadAgentPost({ ...THREAD, agent: 'sage', text: 'PDF' });
    off();
    offBad();
    reportOwnerThreadAgentPost({ ...THREAD, agent: 'sage', text: 'again' });
    expect(seen).toEqual([`sage@${CH}:${TS}`]);
  });
});

describe('orchestrator posts', () => {
  it("the orc relaying in an agent's thread neither takes it over nor settles the promise", async () => {
    const h = make();
    promised(h);
    h.sentinel.noteAgentPost({ ...THREAD, agent: 'crewly-orc', text: 'Atlas is on it.' });
    expect(h.sentinel.list()[0]).toMatchObject({ agent: ATLAS, promise: { minutes: 15 } });
    expect(await h.sentinel.noteBlocking(ATLAS, { kind: 'stopped', why: 'slot' })).toBe(1);
  });

  it('a card is placed only in an owner thread active in the last 2 h', () => {
    const h = make();
    promised(h);
    h.clock.t += 3 * 60 * MIN;
    expect(h.sentinel.ownerThreadFor(ATLAS)).toBeNull();
  });
});


describe('owner-facing only (default)', () => {
  it('records a stop silently and posts only a held browser approval', async () => {
    const posted: string[] = [];
    const s = new OwnerThreadSentinelService({
      postStatus: async (_t: unknown, _a: string, text: string) => { posted.push(text); return true; },
      nudgeAgent: async () => true,
      storePath: require('path').join(require('os').tmpdir(), `sentinel-quiet-${process.pid}-${Date.now()}.json`),
    } as never);
    s.noteOwnerMessage({ slackChannelId: 'C1', threadTs: '1.1', agent: 'atlas', at: Date.now() });
    expect(await s.noteBlocking('atlas', { kind: 'stopped', why: 'slot' })).toBe(0);
    await s.noteBlocking('atlas', { kind: 'card_posted', decisionId: 'D-1', question: 'open the attachment?', browser: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('waiting for your OK');
  });
});

describe('a kept promise stays kept (Follow-through duplicates, 2026-10-12)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-kept-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a later agent post settles the promise: nothing left to park, owed or timed', () => {
    const h = make();
    promised(h);
    expect(h.sentinel.parkablePromise(ATLAS)).not.toBeNull();
    h.clock.t += 5 * MIN;
    h.sentinel.noteAgentPost({ ...THREAD, agent: ATLAS, text: 'Done: the cover is in the thread.', at: h.clock.t });
    expect(h.sentinel.parkablePromise(ATLAS)).toBeNull();
    expect(h.sentinel.promiseText(ATLAS)).toBeNull();
    expect(h.sentinel.owesOwner(ATLAS)).toBe(false);
  });

  it('reloading the file after a kept promise (a restart) leaves nothing to park', () => {
    const storePath = path.join(dir, 'owner-thread-sentinel.json');
    const h = make({ storePath });
    promised(h);
    h.clock.t += 5 * MIN;
    h.sentinel.noteAgentPost({ ...THREAD, agent: ATLAS, text: 'Done: the cover is in the thread.', at: h.clock.t });
    const after = make({ storePath });
    expect(after.sentinel.parkablePromise(ATLAS)).toBeNull();
    expect(after.sentinel.owesRecently(ATLAS)).toBe(false);
  });

  it('a file whose entry has a post newer than its promise reads as kept, not open', () => {
    const storePath = path.join(dir, 'owner-thread-sentinel.json');
    const promiseAt = Date.parse('2026-10-08T15:50:00Z');
    writeFileSync(
      storePath,
      JSON.stringify({
        entries: [
          {
            key: threadKey(THREAD),
            slackChannelId: CH,
            threadTs: TS,
            agent: ATLAS,
            cards: [],
            recentStates: {},
            updatedAt: promiseAt + 2 * MIN,
            agentPostAt: promiseAt + 2 * MIN,
            agentPreview: 'On it, checking the logs',
            promise: { at: promiseAt },
          },
        ],
      }),
    );
    const h = make({ storePath });
    expect(h.sentinel.parkablePromise(ATLAS)).toBeNull();
    expect(h.sentinel.owesOwner(ATLAS)).toBe(false);
    expect(h.sentinel.owedAgeMs(ATLAS)).toBeNull();
  });

  it('an unkept promise is offered once, keyed by thread + promise; after it is marked parked, also across a restart, never again', () => {
    const storePath = path.join(dir, 'owner-thread-sentinel.json');
    const h = make({ storePath });
    promised(h);
    const first = h.sentinel.parkablePromise(ATLAS)!;
    expect(first.key).toMatch(new RegExp(`^${CH}:${TS}@\\d+$`));
    expect(h.sentinel.parkablePromise(ATLAS)!.key).toBe(first.key);
    first.markParked('wi-1');
    expect(h.sentinel.parkablePromise(ATLAS)).toBeNull();
    const after = make({ storePath });
    expect(after.sentinel.parkablePromise(ATLAS)).toBeNull();
  });

  it('a new promise in the same thread is a new key', () => {
    const h = make();
    promised(h);
    const first = h.sentinel.parkablePromise(ATLAS)!;
    first.markParked('wi-1');
    h.clock.t += 10 * MIN;
    h.sentinel.noteAgentPost({ ...THREAD, agent: ATLAS, text: "I'll redo it now, ~10 min", at: h.clock.t });
    const second = h.sentinel.parkablePromise(ATLAS)!;
    expect(second.key).not.toBe(first.key);
  });
});
