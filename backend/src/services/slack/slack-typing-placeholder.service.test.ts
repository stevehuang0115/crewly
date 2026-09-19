/**
 * Tests for SlackTypingPlaceholderService — the "is working on it…" placeholder an
 * agent's bot posts and later edits into its reply.
 */

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
  it('posts a placeholder under the agent bot and edits it into the reply', async () => {
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
    // A reply after the timeout is posted fresh (the placeholder is gone).
    expect(await svc.resolve(key, 'late', ella)).toBe('posted');
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
