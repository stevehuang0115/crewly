/**
 * Tests for SlackTypingPlaceholderService — the "is working on it…" placeholder an
 * agent's bot posts and later edits into its reply.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { SlackTypingPlaceholderService, isPlaceholderOwed, type TypingSlackApi } from './slack-typing-placeholder.service.js';

function makeSlack(overrides: Partial<TypingSlackApi> = {}) {
  const sent: Array<{ channelId: string; text: string; threadTs?: string; botToken?: string }> = [];
  const updated: Array<{ channelId: string; ts: string; text: string; botToken?: string }> = [];
  let n = 0;
  const slack: TypingSlackApi = {
    isConnected: () => true,
    sendMessage: async (m) => { sent.push(m); return `ts-${++n}`; },
    updateMessage: async (channelId, ts, text, _blocks, botToken) => { updated.push({ channelId, ts, text, botToken }); },
    ...overrides,
  };
  return { slack, sent, updated };
}

const key = { agentSession: 'mk-ella', slackChannelId: 'D1', threadTs: undefined };
const ella = { botToken: 'xoxb-ella', displayName: 'Ella' };

describe('SlackTypingPlaceholderService', () => {
  it('REPLACE_BY_EDIT off (2026-09-23 mode): posts the reply as a new message and removes the placeholder', async () => {
    // An edit raises no unread mark, badge or push: once "working on it…"
    // placeholders were common, the owner could not tell a reply had come.
    const deleted: Array<{ channelId: string; ts: string; botToken?: string }> = [];
    const { slack, sent, updated } = makeSlack({
      deleteMessage: async (channelId, ts, botToken) => { deleted.push({ channelId, ts, botToken }); },
    });
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined, replaceByEdit: false });
    await svc.begin({ ...key, threadTs: '9.9' }, ella);

    expect(await svc.resolve({ ...key, threadTs: '9.9' }, '做好了', ella)).toBe('replaced');

    expect(sent[1]).toMatchObject({ channelId: 'D1', text: '做好了', threadTs: '9.9', botToken: 'xoxb-ella' });
    expect(updated).toEqual([]);
    // Removed only after the reply is up, by the bot that posted it.
    expect(deleted).toEqual([{ channelId: 'D1', ts: 'ts-1', botToken: 'xoxb-ella' }]);
    expect(svc.pendingCount).toBe(0);
  });

  it('keeps the reply when the placeholder cannot be removed', async () => {
    const { slack, sent } = makeSlack({ deleteMessage: async () => { throw new Error('message_not_found'); } });
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined, replaceByEdit: false });
    await svc.begin(key, ella);
    expect(await svc.resolve(key, 'reply', ella)).toBe('replaced');
    expect(sent.map((m) => m.text)).toContain('reply');
  });

  it('without a way to delete, edits the placeholder into the reply as before', async () => {
    const { slack, sent, updated } = makeSlack();
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
    const ph = await svc.begin(key, ella);
    expect(ph).toMatchObject({ slackChannelId: 'D1', ts: 'ts-1', botToken: 'xoxb-ella' });
    expect(sent[0]).toMatchObject({ channelId: 'D1', text: '⚙️ Ella is working on it…', botToken: 'xoxb-ella' });
    expect(svc.pendingCount).toBe(1);

    expect(await svc.resolve(key, '你好，我是 Ella。', ella)).toBe('edited');
    expect(updated).toEqual([{ channelId: 'D1', ts: 'ts-1', text: '你好，我是 Ella。', botToken: 'xoxb-ella' }]);
    expect(sent).toHaveLength(1);
    expect(svc.pendingCount).toBe(0);
  });

  it('waking → typing edits the same message; a slow cold start gets an honest note; fail() replaces it with the failure text', async () => {
    const { slack, sent, updated } = makeSlack();
    const timers: Array<() => void> = [];
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: (fn) => { timers.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; }, clearTimer: () => undefined });
    await svc.begin(key, ella, 'waking');
    expect(sent[0].text).toBe('🌙 Ella is waking up…');
    // Two timers armed: overall timeout + slow-wake note. Fire the slow one.
    expect(timers).toHaveLength(2);
    timers[1]();
    await new Promise((r) => setImmediate(r));
    expect(updated.at(-1)?.text).toContain('still starting up');
    await svc.setPhase(key, 'typing');
    expect(updated.at(-1)).toMatchObject({ ts: 'ts-1', text: '⚙️ Ella is working on it…' });
    await svc.setPhase(key, 'typing'); // idempotent
    expect(updated).toHaveLength(2);
    await svc.fail(key);
    expect(updated.at(-1)?.text).toContain('could not be reached');
    expect(svc.pendingCount).toBe(0);
    expect(await svc.resolve(key, 'late reply', ella)).toBe('posted');
  });

  it('posts one placeholder when two copies of a message begin concurrently', async () => {
    const { slack, sent } = makeSlack();
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
    const [a, b] = await Promise.all([svc.begin(key, ella), svc.begin(key, ella)]);
    expect(sent).toHaveLength(1);
    expect(a?.ts).toBe('ts-1');
    expect(b?.ts).toBe('ts-1');
    expect(svc.pendingCount).toBe(1);
  });

  it('posts the reply fresh when nothing is pending, and keeps one placeholder per key', async () => {
    const { slack, sent } = makeSlack();
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
    expect(await svc.resolve({ ...key, threadTs: '1.0' }, 'hi', ella)).toBe('posted');
    expect(sent[0]).toMatchObject({ channelId: 'D1', text: 'hi', threadTs: '1.0' });

    await svc.begin(key, ella);
    await svc.begin(key, ella);
    expect(svc.pendingCount).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it('edits a stale placeholder to the still-working note on timeout', async () => {
    const { slack, updated } = makeSlack();
    let fire: (() => void) | null = null;
    const svc = new SlackTypingPlaceholderService({
      slack,
      timeoutMs: 1,
      setTimer: (fn) => { fire = fn; return 0 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => undefined,
    });
    await svc.begin(key, ella);
    fire!();
    await new Promise((r) => setImmediate(r));
    expect(updated[0]).toMatchObject({ ts: 'ts-1', text: '⏱ Ella is still working on this — the reply will follow.' });
    expect(svc.pendingCount).toBe(0);
    // A reply after the timeout still takes the "still working" note down
    // (here: edited in place, as this fake Slack cannot delete).
    expect(await svc.resolve(key, 'late', ella)).toBe('edited');
  });

  it('falls back to a fresh post when the edit fails, and skips placeholders while disconnected', async () => {
    const { slack, sent } = makeSlack({ updateMessage: async () => { throw new Error('message_not_found'); } });
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
    await svc.begin(key, ella);
    expect(await svc.resolve(key, 'reply', ella)).toBe('posted');
    expect(sent.map((m) => m.text)).toEqual(['⚙️ Ella is working on it…', 'reply']);

    const off = new SlackTypingPlaceholderService({ slack: { ...slack, isConnected: () => false } });
    expect(await off.begin(key, ella)).toBeNull();
  });
});

describe('SlackTypingPlaceholderService — a placeholder that cannot be posted', () => {
  // This was logged at debug, and the running log level emits none. A channel
  // where the placeholder never posts then looked identical to one where the
  // agent never answered, and the owner had nothing to go on (2026-09-21).
  it('warns with the reason instead of failing silently, and still returns null', async () => {
    const { slack, sent } = makeSlack({
      sendMessage: async () => { throw Object.assign(new Error('An API error occurred'), { data: { error: 'not_in_channel' } }); },
    });
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
    const warnings: Array<Record<string, unknown>> = [];
    (svc as unknown as { logger: { warn: unknown } }).logger.warn = (_m: string, ctx: Record<string, unknown>) => {
      warnings.push(ctx);
    };

    expect(await svc.begin(key, ella)).toBeNull();
    expect(sent).toHaveLength(0);
    expect(svc.pendingCount).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]!['error'])).toContain('API error');
  });

  it('a reply that comes after the timeout still removes the "still working" placeholder (2026-09-25)', async () => {
    const deleted: string[] = [];
    const { slack, sent, updated } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); } });
    let fire: () => void = () => undefined;
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: (fn) => { fire = fn; return 0 as unknown as ReturnType<typeof setTimeout>; }, clearTimer: () => undefined, replaceByEdit: false });
    const threaded = { agentSession: 'mk-ella', slackChannelId: 'D1', threadTs: '100.1' };
    await svc.begin(threaded, ella);
    fire();
    await new Promise((r) => setImmediate(r));
    expect(updated.at(-1)?.text).toContain('still working');
    expect(svc.findOwed('mk-ella', 'D1')).toEqual(threaded);
    expect(await svc.resolve(threaded, 'done', ella)).toBe('replaced');
    expect(sent.at(-1)).toMatchObject({ text: 'done', threadTs: '100.1' });
    expect(deleted).toEqual(['ts-1']);
    expect(svc.findOwed('mk-ella', 'D1')).toBeNull();
  });

  it('findOwed prefers a pending placeholder and only matches the agent and channel', async () => {
    const { slack } = makeSlack();
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
    await svc.begin({ agentSession: 'mk-ella', slackChannelId: 'D1', threadTs: '5.0' }, ella);
    expect(svc.findOwed('mk-ella', 'D1')).toEqual({ agentSession: 'mk-ella', slackChannelId: 'D1', threadTs: '5.0' });
    expect(svc.findOwed('mk-ella', 'D2')).toBeNull();
    expect(svc.findOwed('mk-ellab', 'D1')).toBeNull();
  });

  it('findOwed returns the OLDEST owed thread, not the newest (2026-09-28)', async () => {
    // Answers come in the order the questions were asked; newest-first put
    // the answer owed in an earlier thread under the latest question.
    const { slack } = makeSlack();
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
    const realNow = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      await svc.begin({ agentSession: 'mk-ella', slackChannelId: 'D1', threadTs: 'A' }, ella);
      t += 60_000;
      await svc.begin({ agentSession: 'mk-ella', slackChannelId: 'D1', threadTs: 'B' }, ella);
    } finally {
      Date.now = realNow;
    }
    expect(svc.findOwed('mk-ella', 'D1')).toEqual({ agentSession: 'mk-ella', slackChannelId: 'D1', threadTs: 'A' });
    await svc.resolve({ agentSession: 'mk-ella', slackChannelId: 'D1', threadTs: 'A' }, 'EFT done', ella);
    expect(svc.findOwed('mk-ella', 'D1')).toEqual({ agentSession: 'mk-ella', slackChannelId: 'D1', threadTs: 'B' });
  });

  it('findOwed with maxAgeMs ignores placeholders from an earlier turn (#808)', async () => {
    const { slack } = makeSlack();
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
    const realNow = Date.now;
    const t0 = 5_000_000;
    Date.now = () => t0;
    try {
      await svc.begin({ agentSession: 'mk-ella', slackChannelId: 'D1', threadTs: 'OLD' }, ella);
    } finally {
      Date.now = realNow;
    }
    const twoHours = 2 * 60 * 60 * 1000;
    expect(svc.findOwed('mk-ella', 'D1', { maxAgeMs: 30 * 60 * 1000, now: t0 + twoHours })).toBeNull();
    expect(svc.findOwed('mk-ella', 'D1', { maxAgeMs: 30 * 60 * 1000, now: t0 + 60_000 }))
      .toEqual({ agentSession: 'mk-ella', slackChannelId: 'D1', threadTs: 'OLD' });
    // Without a bound the old behaviour holds.
    expect(svc.findOwed('mk-ella', 'D1')).not.toBeNull();
  });

  it('resolve reports the ts of the message that carries the reply (#808)', async () => {
    const posted = makeSlack({ deleteMessage: async () => undefined });
    const a = new SlackTypingPlaceholderService({ slack: posted.slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined, replaceByEdit: false });
    await a.begin({ ...key, threadTs: '7.0' }, ella); // ts-1
    let ts = '';
    await a.resolve({ ...key, threadTs: '7.0' }, 'answer', ella, { onMessageTs: (v) => { ts = v; } });
    expect(ts).toBe('ts-2');

    const edited = makeSlack();
    const b = new SlackTypingPlaceholderService({ slack: edited.slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined, replaceByEdit: true });
    await b.begin({ ...key, threadTs: '8.0' }, ella); // ts-1
    let editedTs = '';
    await b.resolve({ ...key, threadTs: '8.0' }, 'answer', ella, { onMessageTs: (v) => { editedTs = v; } });
    expect(editedTs).toBe('ts-1');
  });

  it('settleTurnWithoutReply takes down pending and timed-out placeholders the agent never answered (2026-09-25)', async () => {
    const deleted: string[] = [];
    const timers: Array<() => void> = [];
    const { slack } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); } });
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: (fn) => { timers.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; }, clearTimer: () => undefined });
    const t0 = Date.now();
    await svc.begin(key, ella); // ts-1, pending
    await svc.begin({ agentSession: 'mk-ella', slackChannelId: 'C9', threadTs: '1.1' }, ella); // ts-2
    timers[1](); // ts-2 times out into "still working"
    await new Promise((r) => setImmediate(r));
    await svc.begin({ agentSession: 'other-agent', slackChannelId: 'D1' }, { displayName: 'Other' }); // ts-3, not Ella's
    // Both of Ella's threads got an answer some other way (2026-10-02: only then).
    svc.noteAnswerPosted('D1', undefined);
    svc.noteAnswerPosted('C9', '1.1');

    // Too young: a turn that ends right after delivery keeps its placeholder.
    expect(await svc.settleTurnWithoutReply('mk-ella', t0 + 1_000)).toBe(1); // only the expired one
    expect(deleted).toEqual(['ts-2']);
    expect(await svc.settleTurnWithoutReply('mk-ella', t0 + 60_000)).toBe(1);
    expect(deleted).toEqual(['ts-2', 'ts-1']);
    expect(svc.findOwed('mk-ella', 'D1')).toBeNull();
    expect(svc.findOwed('other-agent', 'D1')).not.toBeNull();
    // A reply that still comes later posts as a new message.
    expect(await svc.resolve(key, 'late', ella)).toBe('posted');
  });

  it('settleTurnWithoutReply edits the placeholder when Slack cannot delete', async () => {
    const { slack, updated } = makeSlack();
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
    const t0 = Date.now();
    await svc.begin(key, ella);
    svc.noteAnswerPosted(key.slackChannelId, key.threadTs);
    expect(await svc.settleTurnWithoutReply('mk-ella', t0 + 60_000)).toBe(1);
    expect(updated.at(-1)?.text).toBe('✓ Ella read this — no reply needed.');
  });

  it('settling puts ✅ on the person\'s message the placeholder answered', async () => {
    const reactions: Array<{ ts: string; emoji: string; botToken?: string }> = [];
    const { slack } = makeSlack({
      deleteMessage: async () => undefined,
      addReaction: async (_c, ts, emoji, botToken) => { reactions.push({ ts, emoji, botToken }); },
    });
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
    const t0 = Date.now();
    await svc.begin(key, ella, 'typing', '100.1');
    await svc.begin(key, ella, 'typing', '100.2'); // a second message under the same placeholder
    svc.noteAnswerPosted(key.slackChannelId, key.threadTs);
    await svc.settleTurnWithoutReply('mk-ella', t0 + 60_000);
    expect(reactions).toEqual([{ ts: '100.2', emoji: 'white_check_mark', botToken: 'xoxb-ella' }]);
  });

  it('placeholders survive a restart: a late reply still replaces one, the rest are taken down as orphans', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'typing-'));
    const storePath = path.join(dir, 'placeholders.json');
    try {
      const noTimer = { setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined };
      const before = new SlackTypingPlaceholderService({ slack: makeSlack().slack, storePath, ...noTimer });
      await before.begin(key, ella); // ts-1
      await before.begin({ agentSession: 'think-atlas', slackChannelId: 'C2', threadTs: '9.9' }, { botToken: 'xoxb-atlas', displayName: 'Atlas' }); // ts-2

      // Restart: a fresh service loads both as timed out.
      const deleted: string[] = [];
      const orphanTimers: Array<() => void> = [];
      const after = new SlackTypingPlaceholderService({
        slack: makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); } }).slack,
        storePath,
        setTimer: (fn) => { orphanTimers.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; },
        clearTimer: () => undefined,
        replaceByEdit: false,
      });
      expect(after.findOwed('mk-ella', 'D1')).not.toBeNull();
      expect(await after.resolve(key, 'answer after restart', ella)).toBe('replaced');
      expect(deleted).toEqual(['ts-1']);
      // Atlas was never woken again: taken down when the orphan timer fires.
      orphanTimers[0]();
      await new Promise((r) => setImmediate(r));
      expect(deleted).toEqual(['ts-1', 'ts-2']);
      expect(after.findOwed('think-atlas', 'C2')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 2026-09-28: "Ella is working on it…" stayed under a thread whose two
  // back-to-back messages Ella had answered in one new message.
  describe('no placeholder is left behind in an answered thread (edit mode, REPLACE_BY_EDIT on)', () => {
    const T = { agentSession: 'mk-ella', slackChannelId: 'D1', threadTs: '100.1' };
    const noTimer = { setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined };

    it('the answer REPLACES the thread\'s placeholder in place (chat.update), no second message', async () => {
      const deleted: string[] = [];
      const { slack, sent, updated } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); } });
      const svc = new SlackTypingPlaceholderService({ slack, ...noTimer, replaceByEdit: true });
      await svc.begin(T, ella);
      expect(await svc.resolve(T, '收到，按 $145 来…', ella)).toBe('edited');
      expect(updated).toEqual([{ channelId: 'D1', ts: 'ts-1', text: '收到，按 $145 来…', botToken: 'xoxb-ella' }]);
      expect(sent).toHaveLength(1); // only the placeholder itself was ever posted
      expect(deleted).toEqual([]);
      expect(svc.owes(T)).toBe(false);
    });

    it('one answer covering several placeholders in the thread: oldest edited into it, the rest deleted', async () => {
      const deleted: string[] = [];
      const timers: Array<() => void> = [];
      const { slack, updated } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); } });
      const svc = new SlackTypingPlaceholderService({ slack, setTimer: (fn) => { timers.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; }, clearTimer: () => undefined, replaceByEdit: true });
      await svc.begin(T, ella); // ts-1 for "按 $145 来…"
      timers[0](); // times out → "still working"
      await new Promise((r) => setImmediate(r));
      await svc.begin(T, ella); // ts-2 for "那 Iris 如果加到 HSA…"
      expect(await svc.resolve(T, '① Iris 挂了 Kearney… ② $145…', ella)).toBe('edited');
      expect(updated.at(-1)).toMatchObject({ ts: 'ts-1', text: '① Iris 挂了 Kearney… ② $145…' });
      expect(deleted).toEqual(['ts-2']);
      expect(svc.owes(T)).toBe(false);
      expect(svc.findOwed('mk-ella', 'D1')).toBeNull();
    });

    it('an answer arriving while the placeholder is still being posted replaces it instead of leaving it', async () => {
      let release: (ts: string) => void = () => undefined;
      const updated: string[] = [];
      const svc = new SlackTypingPlaceholderService({
        slack: {
          isConnected: () => true,
          sendMessage: () => new Promise<string>((r) => { release = r; }),
          updateMessage: async (_c, ts, text) => { updated.push(`${ts}:${text}`); },
          deleteMessage: async () => undefined,
        },
        ...noTimer,
        replaceByEdit: true,
      });
      const begun = svc.begin(T, ella);
      const answered = svc.resolve(T, 'answer', ella);
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); // let the post start
      release('ts-slow');
      await begun;
      expect(await answered).toBe('edited');
      expect(updated).toEqual(['ts-slow:answer']);
      expect(svc.owes(T)).toBe(false);
    });

    it('an interim note racing the final answer: the re-opened placeholder is replaced by the answer, not left under it', async () => {
      const deleted: string[] = [];
      const { slack, sent, updated } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); } });
      const svc = new SlackTypingPlaceholderService({ slack, ...noTimer, replaceByEdit: true });
      await svc.begin(T, ella); // ts-1
      const interim = svc.resolve(T, '收到，计划：…', ella, { reopen: 'typing' });
      const final = svc.resolve(T, '做好了', ella);
      await Promise.all([interim, final]);
      // ts-1 became the interim note; ts-2 (re-opened placeholder) became the answer.
      expect(updated).toEqual([
        { channelId: 'D1', ts: 'ts-1', text: '收到，计划：…', botToken: 'xoxb-ella' },
        { channelId: 'D1', ts: 'ts-2', text: '做好了', botToken: 'xoxb-ella' },
      ]);
      expect(sent.map((m) => m.text)).toEqual(['⚙️ Ella is working on it…', '⚙️ Ella is working on it…']);
      expect(svc.pendingCount).toBe(0);
    });

    it('a placeholder too young to settle at turn end gets a second look and is removed unless the agent is mid-turn', async () => {
      const deleted: string[] = [];
      const timers: Array<{ fn: () => void; ms: number }> = [];
      let midTurn = true;
      const { slack } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); } });
      const svc = new SlackTypingPlaceholderService({
        slack,
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return 0 as unknown as ReturnType<typeof setTimeout>; },
        clearTimer: () => undefined,
        isAgentMidTurn: () => midTurn,
      });
      await svc.begin(T, ella); // timers[0] = timeout
      svc.noteAnswerPosted(T.slackChannelId, T.threadTs);
      const t0 = Date.now();
      expect(await svc.settleTurnWithoutReply('mk-ella', t0 + 1_000)).toBe(0); // too young
      const recheck = timers.at(-1)!;
      expect(recheck.ms).toBeGreaterThan(0);
      // Only one second look is scheduled per agent.
      await svc.settleTurnWithoutReply('mk-ella', t0 + 2_000);
      expect(timers.filter((t) => t !== timers[0])).toHaveLength(1);

      // Agent busy with a new turn at the second look: kept (that turn's end settles it).
      recheck.fn();
      await new Promise((r) => setImmediate(r));
      expect(deleted).toEqual([]);

      // Next turn end, agent resting at the second look: removed.
      midTurn = false;
      await svc.settleTurnWithoutReply('mk-ella', t0 + 3_000);
      expect(timers.at(-1)).not.toBe(recheck);
      timers.at(-1)!.fn();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(deleted).toEqual(['ts-1']);
      expect(svc.owes(T)).toBe(false);
    });

    it('dropThread: an answer given another way (a file) takes every placeholder in that thread down', async () => {
      const deleted: string[] = [];
      const { slack } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); } });
      const svc = new SlackTypingPlaceholderService({ slack, ...noTimer });
      await svc.begin(T, ella);
      await svc.begin({ ...T, threadTs: 'other' }, ella);
      expect(await svc.dropThread(T)).toBe(1);
      expect(deleted).toEqual(['ts-1']);
      expect(svc.owes(T)).toBe(false);
      expect(svc.owes({ ...T, threadTs: 'other' })).toBe(true);
      expect(await svc.dropThread(T)).toBe(0);
    });
  });

  // Default mode (REPLACE_BY_EDIT off, 2026-09-28 decision): the answer is a
  // NEW message — Slack notifies on new messages, not on edits — and every
  // placeholder in that thread is deleted after it.
  describe('no placeholder is left behind in an answered thread (default: new message + delete)', () => {
    const T = { agentSession: 'mk-ella', slackChannelId: 'D1', threadTs: '100.1' };
    const noTimer = { setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined };

    it('defaults to posting the answer as a new message', async () => {
      const deleted: string[] = [];
      const { slack, sent, updated } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); } });
      const svc = new SlackTypingPlaceholderService({ slack, ...noTimer });
      await svc.begin(T, ella);
      expect(await svc.resolve(T, '收到，按 $145 来…', ella)).toBe('replaced');
      expect(sent.map((m) => m.text)).toEqual(['⚙️ Ella is working on it…', '收到，按 $145 来…']);
      expect(sent[1]).toMatchObject({ threadTs: '100.1', botToken: 'xoxb-ella' });
      expect(updated).toEqual([]);
      expect(deleted).toEqual(['ts-1']);
      expect(svc.owes(T)).toBe(false);
    });

    it('one answer covering several placeholders in the thread: posted once, ALL placeholders deleted', async () => {
      const deleted: string[] = [];
      const timers: Array<() => void> = [];
      const { slack, sent } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); } });
      const svc = new SlackTypingPlaceholderService({ slack, setTimer: (fn) => { timers.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; }, clearTimer: () => undefined, replaceByEdit: false });
      await svc.begin(T, ella); // ts-1 for "按 $145 来…"
      timers[0](); // → "still working"
      await new Promise((r) => setImmediate(r));
      await svc.begin(T, ella); // ts-2 for "那 Iris 如果加到 HSA…"
      expect(await svc.resolve(T, '① Iris 挂了 Kearney… ② $145…', ella)).toBe('replaced');
      expect(sent.map((m) => m.text).filter((t) => t.startsWith('①'))).toHaveLength(1);
      expect(deleted.sort()).toEqual(['ts-1', 'ts-2']);
      expect(svc.owes(T)).toBe(false);
      expect(svc.findOwed('mk-ella', 'D1')).toBeNull();
    });

    it('an answer arriving while the placeholder is still being posted: the placeholder is deleted once its post completes', async () => {
      let release: (ts: string) => void = () => undefined;
      const posted: string[] = [];
      const deleted: string[] = [];
      let n = 0;
      const svc = new SlackTypingPlaceholderService({
        slack: {
          isConnected: () => true,
          sendMessage: (m) => {
            posted.push(m.text);
            if (n++ === 0) return new Promise<string>((r) => { release = r; });
            return Promise.resolve(`ts-${n}`);
          },
          updateMessage: async () => undefined,
          deleteMessage: async (_c, ts) => { deleted.push(ts); },
        },
        ...noTimer,
      });
      const begun = svc.begin(T, ella);
      const answered = svc.resolve(T, 'answer', ella);
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      expect(deleted).toEqual([]); // nothing to delete yet — the answer waits
      release('ts-slow');
      await begun;
      expect(await answered).toBe('replaced');
      expect(posted).toEqual(['⚙️ Ella is working on it…', 'answer']);
      expect(deleted).toEqual(['ts-slow']);
      expect(svc.owes(T)).toBe(false);
    });

    it('an interim note racing the final answer: the re-opened placeholder is deleted after the final answer', async () => {
      const deleted: string[] = [];
      const { slack, sent, updated } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); } });
      const svc = new SlackTypingPlaceholderService({ slack, ...noTimer });
      await svc.begin(T, ella); // ts-1
      const interim = svc.resolve(T, '收到，计划：…', ella, { reopen: 'typing' });
      const final = svc.resolve(T, '做好了', ella);
      await Promise.all([interim, final]);
      // ts-1 placeholder, ts-2 interim note, ts-3 re-opened placeholder, ts-4 the answer.
      expect(sent.map((m) => m.text)).toEqual(['⚙️ Ella is working on it…', '收到，计划：…', '⚙️ Ella is working on it…', '做好了']);
      expect(deleted).toEqual(['ts-1', 'ts-3']);
      expect(updated).toEqual([]);
      expect(svc.pendingCount).toBe(0);
      expect(svc.owes(T)).toBe(false);
    });

    it('upload path: dropThread deletes every placeholder in the thread (pending and timed out)', async () => {
      const deleted: string[] = [];
      const timers: Array<() => void> = [];
      const { slack } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); } });
      const svc = new SlackTypingPlaceholderService({ slack, setTimer: (fn) => { timers.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; }, clearTimer: () => undefined });
      await svc.begin(T, ella); // ts-1
      timers[0]();
      await new Promise((r) => setImmediate(r));
      await svc.begin(T, ella); // ts-2
      expect(await svc.dropThread(T)).toBe(2);
      expect(deleted.sort()).toEqual(['ts-1', 'ts-2']);
      expect(svc.owes(T)).toBe(false);
    });

    it('slack-post path: a post naming the thread (via SlackAgentPostService → resolve) posts new and deletes the placeholder', async () => {
      const { SlackAgentPostService } = await import('./slack-agent-post.service.js');
      const deleted: string[] = [];
      const { slack: typingSlack, sent: typingSent } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); } });
      const typing = new SlackTypingPlaceholderService({ slack: typingSlack, ...noTimer });
      const key = { agentSession: 'mk-ella', slackChannelId: 'C0GENERAL', threadTs: '1790000000.000100' };
      await typing.begin(key, ella); // ts-1
      const posted: Array<Record<string, unknown>> = [];
      const svc = new SlackAgentPostService({
        slack: {
          isConnected: () => true,
          sendMessage: async (m: Record<string, unknown>) => { posted.push(m); return '1.1'; },
          listChannels: async () => [{ id: 'C0GENERAL', name: 'general' }],
        } as never,
        storage: { getTeams: async () => [] },
        identities: null as never,
        typing,
      });
      await svc.post({ agentSession: 'mk-ella', target: 'C0GENERAL', text: 'answer', threadTs: 'C0GENERAL:1790000000.000100' });
      expect(deleted).toEqual(['ts-1']);
      expect(typing.owes(key)).toBe(false);
      // The answer itself went out as a new message in that thread (through the placeholder service).
      expect(typingSent.at(-1)).toMatchObject({ channelId: 'C0GENERAL', text: 'answer', threadTs: '1790000000.000100' });
      expect(posted).toEqual([]);
    });
  });

  it('onThreadActivity: told when a thread gets a placeholder, an answer or is dropped; unsubscribe stops it', async () => {
    const deleted: string[] = [];
    const { slack } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); } });
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined, replaceByEdit: false });
    const seen: Array<[string, string | undefined]> = [];
    const off = svc.onThreadActivity((ch, th) => seen.push([ch, th]));
    await svc.begin({ ...key, threadTs: '1.1' }, ella);
    await svc.resolve({ ...key, threadTs: '1.1' }, 'answer', ella);
    await svc.dropThread({ ...key, threadTs: '2.2' });
    expect(seen).toEqual([['D1', '1.1'], ['D1', '1.1'], ['D1', '2.2']]);
    off();
    await svc.begin({ ...key, threadTs: '3.3' }, ella);
    expect(seen).toHaveLength(3);
  });
});

describe('SlackTypingPlaceholderService — signals for the unanswered-owner-message watchdog', () => {
  const noTimer = { setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined };
  const k = { agentSession: 'mk-ella', slackChannelId: 'D1', threadTs: '9.9' };

  it('flags its own placeholder posts as not an answer', async () => {
    const { slack, sent } = makeSlack();
    const svc = new SlackTypingPlaceholderService({ slack, ...noTimer });
    await svc.begin(k, ella);
    expect(sent[0]).toMatchObject({ notAnAnswer: true });
  });

  it('owesThread sees any agent placeholder in the thread', async () => {
    const { slack } = makeSlack();
    const svc = new SlackTypingPlaceholderService({ slack, ...noTimer });
    expect(svc.owesThread('D1', '9.9')).toBe(false);
    await svc.begin(k, ella);
    expect(svc.owesThread('D1', '9.9')).toBe(true);
    expect(svc.owesThread('D1', '1.1')).toBe(false);
  });

  it('tells listeners when the answer replaced the placeholder — not for an interim note', async () => {
    const { slack } = makeSlack();
    const svc = new SlackTypingPlaceholderService({ slack, ...noTimer });
    const answered: Array<[string, string | undefined]> = [];
    svc.onThreadAnswered((c, t) => answered.push([c, t]));
    await svc.begin(k, ella);
    await svc.resolve(k, 'plan: …', ella, { reopen: 'typing' });
    expect(answered).toEqual([]);
    await svc.resolve(k, 'done', ella);
    expect(answered).toEqual([['D1', '9.9']]);
    await svc.dropThread(k);
    expect(answered).toHaveLength(2);
  });

  it('withdraw takes a placeholder down quietly: no answered / settled listeners, no ✅ (crewly#1015 follow-up L2)', async () => {
    const reactions: string[] = [];
    const deleted: string[] = [];
    const { slack } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); }, addReaction: async (_c, ts) => { reactions.push(ts); } });
    const svc = new SlackTypingPlaceholderService({ slack, ...noTimer });
    const heard: string[] = [];
    svc.onThreadAnswered(() => heard.push('answered'));
    svc.onThreadSettled(() => heard.push('settled'));
    await svc.begin(k, ella, 'typing', '9.9');
    expect(await svc.withdraw(k)).toBe(1);
    expect(deleted).toHaveLength(1);
    expect(reactions).toEqual([]);
    expect(heard).toEqual([]);
    expect(svc.owes(k)).toBe(false);
  });

  it('tells listeners when a placeholder settled without a reply', async () => {
    const { slack } = makeSlack({ deleteMessage: async () => undefined, addReaction: async () => undefined });
    const svc = new SlackTypingPlaceholderService({ slack, ...noTimer });
    const settled: Array<[string, string | undefined, string, string]> = [];
    svc.onThreadSettled((c, t, info) => settled.push([c, t, info.agentSession, info.why]));
    await svc.begin(k, ella, 'typing', '9.9');
    svc.noteAnswerPosted(k.slackChannelId, k.threadTs);
    await svc.settleTurnWithoutReply('mk-ella', Date.now() + 60 * 60 * 1000);
    expect(settled).toEqual([['D1', '9.9', 'mk-ella', 'answered']]);
  });

  // crewly#1015 §3: only an answered thread settles the watchdog. A
  // placeholder taken down because the message was not this agent's, or by
  // `reply --none`, must not read as "the thread was answered".
  it('says why a placeholder was settled: not-owed at turn end, no-reply-needed for reply --none', async () => {
    const { slack } = makeSlack({ deleteMessage: async () => undefined, addReaction: async () => undefined });
    const svc = new SlackTypingPlaceholderService({ slack, ...noTimer, isOwed: () => false });
    const settled: string[] = [];
    svc.onThreadSettled((_c, t, info) => settled.push(`${t}:${info.why}`));
    await svc.begin(k, ella, 'typing', '9.9');
    await svc.begin({ ...k, threadTs: '8.8' }, ella, 'typing', '8.8');
    expect(await svc.settleNoReplyNeeded(k.agentSession, k.slackChannelId, '8.8')).toBe(1);
    expect(await svc.settleTurnWithoutReply('mk-ella', Date.now() + 60 * 60 * 1000)).toBe(1);
    expect(settled).toEqual(['8.8:no-reply-needed', '9.9:not-owed']);
  });

  it('a turn that ends with NO answer to a message the watchdog tracks as owed leaves the placeholder — no ✅ (2026-10-02, TKT-187)', async () => {
    const reactions: string[] = [];
    const deleted: string[] = [];
    const { slack } = makeSlack({ deleteMessage: async (_c, ts) => { deleted.push(ts); }, addReaction: async (_c, ts) => { reactions.push(ts); } });
    const svc = new SlackTypingPlaceholderService({ slack, ...noTimer, isOwed: () => true });
    await svc.begin(k, ella, 'typing', '9.9');
    // An answer in ANOTHER thread does not count.
    svc.noteAnswerPosted(k.slackChannelId, 'some-other-thread');
    expect(await svc.settleTurnWithoutReply('mk-ella', Date.now() + 60 * 60 * 1000)).toBe(0);
    expect(deleted).toEqual([]);
    expect(reactions).toEqual([]);
    expect(svc.owes(k)).toBe(true);
  });

  it('an acknowledgement ("好"/"ok") the agent did not answer still settles at turn end (1.20.136); an owed one does once answered', async () => {
    const reactions: string[] = [];
    const { slack } = makeSlack({ deleteMessage: async () => undefined, addReaction: async (_c, ts) => { reactions.push(ts); } });
    const owed = [{ slackChannelId: 'D1', threadTs: '9.9', sourceTs: '9.9', preview: 'send me the preview' }, { slackChannelId: 'D1', threadTs: '8.8', sourceTs: '8.8', preview: '好' }];
    const svc = new SlackTypingPlaceholderService({ slack, ...noTimer, isOwed: (_a, p) => isPlaceholderOwed(owed, p) });
    await svc.begin(k, ella, 'typing', '9.9'); // owed question
    await svc.begin({ ...k, threadTs: '8.8' }, ella, 'typing', '8.8'); // an ack (tracked text is "好")
    await svc.begin({ ...k, threadTs: '7.7' }, ella, 'typing', '7.7'); // not tracked at all
    const later = Date.now() + 60 * 60 * 1000;
    expect(await svc.settleTurnWithoutReply('mk-ella', later)).toBe(2);
    expect(reactions.sort()).toEqual(['7.7', '8.8']);
    expect(svc.owes(k)).toBe(true);
    svc.noteAnswerPosted('D1', '9.9');
    expect(await svc.settleTurnWithoutReply('mk-ella', later)).toBe(1);
    expect(svc.owes(k)).toBe(false);
  });

  it('isPlaceholderOwed matches the conversation and message, never an acknowledgement', () => {
    const p = { slackChannelId: 'D1', threadTs: '9.9', sourceTs: '9.9' };
    expect(isPlaceholderOwed([{ slackChannelId: 'D1', threadTs: '9.9', sourceTs: '9.9', preview: 'where is it?' }], p)).toBe(true);
    expect(isPlaceholderOwed([{ slackChannelId: 'D1', threadTs: '9.9', sourceTs: '9.9', preview: 'ok' }], p)).toBe(false);
    expect(isPlaceholderOwed([{ slackChannelId: 'D2', threadTs: '9.9', sourceTs: '9.9', preview: 'where is it?' }], p)).toBe(false);
    expect(isPlaceholderOwed([], p)).toBe(false);
  });

  it('answered threads are pruned after 24 h and survive a restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'typing-answered-'));
    const storePath = path.join(dir, 'placeholders.json');
    try {
      const before = new SlackTypingPlaceholderService({ slack: makeSlack().slack, storePath, ...noTimer });
      before.noteAnswerPosted('D1', 'old', Date.now() - 25 * 60 * 60 * 1000);
      before.noteAnswerPosted('D1', '9.9');
      expect(before.answeredCount).toBe(1);
      const after = new SlackTypingPlaceholderService({ slack: makeSlack().slack, storePath, ...noTimer, isOwed: () => true });
      expect(after.answeredCount).toBe(1);
      // A placeholder posted before the restart, answered: the next turn end settles it.
      await after.begin(k, ella, 'typing', '9.9');
      after.noteAnswerPosted('D1', '9.9');
      expect(await after.settleTurnWithoutReply('mk-ella', Date.now() + 60 * 60 * 1000)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reply --none settles that thread\'s placeholder with ✅ (the agent said no answer is needed)', async () => {
    const reactions: string[] = [];
    const { slack } = makeSlack({ deleteMessage: async () => undefined, addReaction: async (_c, ts) => { reactions.push(ts); } });
    const svc = new SlackTypingPlaceholderService({ slack, ...noTimer });
    await svc.begin(k, ella, 'typing', '9.9');
    expect(await svc.settleNoReplyNeeded(k.agentSession, k.slackChannelId, k.threadTs)).toBe(1);
    expect(reactions).toEqual(['9.9']);
    expect(svc.owes(k)).toBe(false);
  });
});

describe('readableAgentName', () => {
  it('turns a session id into the member name and leaves names alone', () => {
    const { readableAgentName } = jest.requireActual('./slack-typing-placeholder.service.js') as typeof import('./slack-typing-placeholder.service.js');
    expect(readableAgentName('think-tank-atlas-b4e166f6')).toBe('Atlas');
    expect(readableAgentName('crewly-orc')).toBe('Orc');
    expect(readableAgentName('Ella')).toBe('Ella');
  });
});
