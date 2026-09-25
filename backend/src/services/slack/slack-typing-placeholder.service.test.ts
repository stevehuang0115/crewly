/**
 * Tests for SlackTypingPlaceholderService — the "is working on it…" placeholder an
 * agent's bot posts and later edits into its reply.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { SlackTypingPlaceholderService, type TypingSlackApi } from './slack-typing-placeholder.service.js';

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
  it('posts the reply as a new message and removes the placeholder, so Slack notifies the owner', async () => {
    // An edit raises no unread mark, badge or push: once "working on it…"
    // placeholders were common, the owner could not tell a reply had come.
    const deleted: Array<{ channelId: string; ts: string; botToken?: string }> = [];
    const { slack, sent, updated } = makeSlack({
      deleteMessage: async (channelId, ts, botToken) => { deleted.push({ channelId, ts, botToken }); },
    });
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
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
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
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
    const svc = new SlackTypingPlaceholderService({ slack, setTimer: (fn) => { fire = fn; return 0 as unknown as ReturnType<typeof setTimeout>; }, clearTimer: () => undefined });
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
});
