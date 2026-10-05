import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AppCommentsSlackService, type CommentSlackDeps } from './app-comments-slack.service.js';
import type { AppChange } from './app-wake-message.js';

const thread = (replies: unknown[] = []) => ({
  id: 'c1',
  number: 3,
  body: 'Make it green',
  anchor: { text: 'Save', tag: 'button' },
  replies,
});
const addChange = (): AppChange => ({ seq: 1, kind: 'comment', actor: { kind: 'owner' }, comment: { id: 'c1', op: 'add', thread: thread() as never } });
const replyChange = (id: string, body: string, author: Record<string, unknown> = { kind: 'owner' }): AppChange => ({
  seq: 2,
  kind: 'comment',
  actor: { kind: 'owner' },
  comment: { id: 'c1', op: 'reply', replyId: id, thread: thread([{ id, body, author }]) as never },
});

describe('AppCommentsSlackService', () => {
  let home: string;
  let env: string | undefined;
  let posts: Array<{ agentSession: string; target: string; text: string; threadTs?: string }>;
  let relayed: Array<[string, string, string, string]>;
  let handled: string[];
  let relayFails: boolean;

  const make = (over: Partial<CommentSlackDeps> = {}) =>
    new AppCommentsSlackService({
      homeDir: home,
      post: async (req) => {
        posts.push(req);
        return { channelId: req.target, messageTs: `100.${posts.length}` };
      },
      dmChannelOf: (s) => (s === 'ella' ? 'D1' : null),
      teamChannelOf: async (s) => (s === 'kai' ? 'C9' : null),
      nameOf: (s) => s.toUpperCase(),
      appUrl: (id) => `https://apps.test/${id}`,
      relayOwnerReply: async (...a) => {
        if (relayFails) throw new Error('cloud down');
        relayed.push(a);
      },
      isOwner: (u) => u === 'UOWNER',
      noteHandled: (c, t) => handled.push(`${c}:${t}`),
      env: () => env,
      ...over,
    });

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'cmtslack-'));
    env = undefined;
    posts = [];
    relayed = [];
    handled = [];
    relayFails = false;
  });
  afterEach(() => fs.rm(home, { recursive: true, force: true }));

  it('posts a new comment as a thread root in the agent DM, with the app link', async () => {
    const svc = make();
    await svc.mirrorOwnerComments('ella', 'app1', 'Todo <list>', [addChange()]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ agentSession: 'ella', target: 'D1' });
    expect(posts[0].threadTs).toBeUndefined();
    expect(posts[0].text).toContain('💬 Comment on Todo &lt;list&gt; — ');
    expect(posts[0].text).toContain('Make it green');
    expect(posts[0].text).toContain('<https://apps.test/app1|Open app>');
  });

  it('falls back to the team channel, and skips when the agent has neither', async () => {
    const svc = make();
    await svc.mirrorOwnerComments('kai', 'app1', 'A', [addChange()]);
    expect(posts[0].target).toBe('C9');
    await svc.mirrorOwnerComments('nobody', 'app2', 'B', [addChange()]);
    expect(posts).toHaveLength(1);
  });

  it('persists the mapping across restarts', async () => {
    await make().mirrorOwnerComments('ella', 'app1', 'A', [addChange()]);
    const again = make();
    await again.load();
    expect(again.linkOf('app1', 'c1')).toMatchObject({ channel: 'D1', threadTs: '100.1', agentSession: 'ella' });
    // An owner reply now lands in the mapped thread, not a new root.
    await again.mirrorOwnerComments('ella', 'app1', 'A', [replyChange('r1', 'darker')]);
    expect(posts[1]).toMatchObject({ target: 'D1', threadTs: '100.1', text: '💬 darker' });
  });

  it('never double-posts: a second recipient of the same comment or a resent reply', async () => {
    const svc = make();
    await svc.mirrorOwnerComments('ella', 'app1', 'A', [addChange()]);
    await svc.mirrorOwnerComments('kai', 'app1', 'A', [addChange()]);
    await svc.mirrorOwnerComments('ella', 'app1', 'A', [replyChange('r1', 'x')]);
    await svc.mirrorOwnerComments('kai', 'app1', 'A', [replyChange('r1', 'x')]);
    expect(posts).toHaveLength(2);
  });

  it('does not echo a reply the owner wrote in Slack', async () => {
    const svc = make();
    await svc.mirrorOwnerComments('ella', 'app1', 'A', [addChange()]);
    await svc.mirrorOwnerComments('ella', 'app1', 'A', [replyChange('r2', 'from slack', { kind: 'owner', via: 'slack' })]);
    expect(posts).toHaveLength(1);
  });

  it('agent reply, resolve and reopen go into the thread; unknown comments are ignored', async () => {
    const svc = make();
    await svc.mirrorOwnerComments('ella', 'app1', 'A', [addChange()]);
    await svc.agentReplied('app1', 'c1', 'ella', 'Done in v5 <b>');
    await svc.agentReplied('app1', 'c1', 'kai', 'me too');
    await svc.statusChanged('app1', 'c1', 'ella', 'resolve');
    await svc.statusChanged('app1', 'c1', 'ella', 'reopen');
    await svc.agentReplied('app1', 'nope', 'ella', 'x');
    expect(posts.slice(1).map((p) => [p.agentSession, p.threadTs, p.text])).toEqual([
      ['ella', '100.1', 'Done in v5 &lt;b&gt;'],
      ['ella', '100.1', '*KAI:* me too'],
      ['ella', '100.1', '✅ Resolved by ELLA.'],
      ['ella', '100.1', '↩️ Reopened by ELLA.'],
    ]);
  });

  describe('Slack -> app', () => {
    const msg = (over = {}) => ({ channelId: 'D1', ts: '200.1', threadTs: '100.1', userId: 'UOWNER', text: 'ok, darker', ...over });
    const flush = () => new Promise((r) => setTimeout(r, 20));

    it('consumes the owner reply in a mapped thread and relays it once', async () => {
      const svc = make();
      await svc.mirrorOwnerComments('ella', 'app1', 'A', [addChange()]);
      expect(svc.interceptInbound(msg())).toBe(true);
      expect(svc.interceptInbound(msg())).toBe(true); // Slack redelivery: consumed, not relayed twice
      await flush();
      expect(relayed).toEqual([['app1', 'c1', 'ok, darker', 'UOWNER']]);
      expect(handled).toContain('D1:100.1');
    });

    it('leaves everything else to normal routing', async () => {
      const svc = make();
      await svc.mirrorOwnerComments('ella', 'app1', 'A', [addChange()]);
      expect(svc.interceptInbound(msg({ threadTs: '999.9' }))).toBe(false); // unmapped thread
      expect(svc.interceptInbound(msg({ threadTs: undefined }))).toBe(false); // top-level
      expect(svc.interceptInbound(msg({ userId: 'USOMEONE' }))).toBe(false); // not the owner
      expect(svc.interceptInbound(msg({ authorAgentSession: 'kai' }))).toBe(false); // a bot
      expect(svc.interceptInbound(msg({ text: '  ' }))).toBe(false);
      await flush();
      expect(relayed).toHaveLength(0);
    });

    it('tells the owner in the thread when Cloud refuses', async () => {
      const svc = make();
      await svc.mirrorOwnerComments('ella', 'app1', 'A', [addChange()]);
      relayFails = true;
      expect(svc.interceptInbound(msg())).toBe(true);
      await flush();
      expect(posts.at(-1)?.text).toContain("couldn't add that reply");
    });
  });

  it('is fully off with CREWLY_APP_COMMENTS_SLACK=off', async () => {
    const svc = make();
    await svc.mirrorOwnerComments('ella', 'app1', 'A', [addChange()]);
    env = 'off';
    await svc.mirrorOwnerComments('ella', 'app2', 'A', [addChange()]);
    await svc.agentReplied('app1', 'c1', 'ella', 'x');
    await svc.statusChanged('app1', 'c1', 'ella', 'resolve');
    expect(svc.interceptInbound({ channelId: 'D1', ts: '3', threadTs: '100.1', userId: 'UOWNER', text: 'hi' })).toBe(false);
    expect(posts).toHaveLength(1);
    expect(relayed).toHaveLength(0);
  });
});
