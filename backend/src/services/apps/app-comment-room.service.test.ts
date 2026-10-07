/**
 * Tests for AppCommentRoomService — comments of an app owned by a team or
 * channel go into that room (one thread per comment, mirrored to its Slack
 * channel as one thread), the room rules decide who answers, the owner's
 * Slack replies are not delivered twice, and the room's answers go back to
 * the app.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AppCommentRoomService, type AppCommentRoomDeps, type ResolvedRoom } from './app-comment-room.service.js';
import { AppCommentsSlackService } from './app-comments-slack.service.js';
import type { AppChange, AppCommentThread } from './app-wake-message.js';
import type { ChatChannelDTO, ChatMessageDTO } from '../chat-v2/types.js';
import type { RecordTurnInput } from '../chat-v2/chat-v2.service.js';

const APP = '28au74d9cj';
const ELLA = 'crewly-info-ella-e6a6b8ea';
const KAI = 'crewly-dev-kai-11111111';
const ROOM_REF = { kind: 'channel' as const, id: 'huddle-brief', name: 'daily-brief' };

const thread = (over: Partial<AppCommentThread> = {}): AppCommentThread => ({
  id: 'c1',
  number: 3,
  anchor: { tag: 'h2', text: 'Today' },
  body: '@Kai the date is wrong',
  mentions: [],
  replies: [],
  status: 'open',
  ...over,
});
const change = (op: string, t: AppCommentThread, extra: Partial<AppChange> = {}, replyId?: string): AppChange => ({
  seq: 1,
  kind: 'comment',
  actor: { kind: 'owner' },
  comment: { id: 'c1', op, ...(replyId ? { replyId } : {}), thread: t },
  ...extra,
});

describe('AppCommentRoomService', () => {
  let home: string;
  let links: AppCommentsSlackService;
  let rows: Array<RecordTurnInput & { id: string }>;
  let dispatched: Array<{ message: ChatMessageDTO; options: unknown }>;
  let posts: Array<{ agentSession: string; target: string; text: string; threadTs?: string }>;
  let relayed: Array<[string, string, string, string]>;
  let room: ResolvedRoom | null;
  let running: Set<string>;
  let slackFails: boolean;

  const chat = {
    recordTurn: (input: RecordTurnInput) => {
      const id = `m${rows.length + 1}`;
      rows.push({ ...input, id });
      return { message: { id, channelId: input.channelId, senderType: input.senderType, senderId: input.senderId, content: input.content, threadId: input.threadId, mentions: input.mentions, metadata: input.metadata } as unknown as ChatMessageDTO };
    },
    getChannelForBridge: (id: string) => ({ id, type: 'huddle', name: 'daily-brief' }) as unknown as ChatChannelDTO,
  };

  const make = (over: Partial<AppCommentRoomDeps> = {}) =>
    new AppCommentRoomService({
      resolveRoom: async () => room,
      chat: () => chat,
      dispatch: () => async (_channel, message, options) => {
        dispatched.push({ message, options });
      },
      isRunning: (s) => running.has(s),
      slackPost: async (req) => {
        if (slackFails) throw new Error('slack down');
        posts.push(req);
        return { channelId: req.target, messageTs: `200.${posts.length}` };
      },
      links,
      publisherOf: async () => ELLA,
      instanceId: async () => 'inst-1',
      relayAgentReply: async (...a) => {
        relayed.push(a);
      },
      skillsPath: '/skills/agent',
      appUrl: (id) => `https://apps.test/${id}`,
      ...over,
    });

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'cmtroom-'));
    links = new AppCommentsSlackService({
      homeDir: home,
      post: async () => ({ channelId: 'x', messageTs: '1.1' }),
      dmChannelOf: () => null,
      teamChannelOf: async () => null,
      relayOwnerReply: async () => undefined,
      isOwner: () => true,
    });
    rows = [];
    dispatched = [];
    posts = [];
    relayed = [];
    room = { chatChannelId: 'huddle-brief', label: '#daily-brief', slackChannelId: 'C123', members: [ELLA, KAI] };
    running = new Set([ELLA]);
    slackFails = false;
  });
  afterEach(() => fs.rm(home, { recursive: true, force: true }));

  it('a new comment: one Slack thread root (publisher member\'s bot, inert @), one room thread root linked to it, dispatched with room presence', async () => {
    const svc = make();
    expect(await svc.deliver({ appId: APP, appName: 'Daily brief', room: ROOM_REF, comments: [change('add', thread())] })).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ agentSession: ELLA, target: 'C123' });
    expect(posts[0].threadTs).toBeUndefined();
    expect(posts[0].text).toContain('💬 Comment on Daily brief (#3)');
    expect(posts[0].text).toContain('@​Kai the date is wrong');
    expect(posts[0].text).toContain('<https://apps.test/28au74d9cj|Open app>');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channelId: 'huddle-brief', senderType: 'user', senderId: 'Owner (app comment)' });
    expect(rows[0].threadId).toBeUndefined();
    expect(rows[0].metadata).toMatchObject({ source: 'app-comment', appComment: { appId: APP, commentId: 'c1' }, slackChannelId: 'C123', slackThreadTs: '200.1' });
    expect(rows[0].content).toContain('@Kai the date is wrong');
    expect(rows[0].content).toContain('reply in this thread');
    expect(rows[0].content).toContain('/skills/agent/core/app-comments/execute.sh --app 28au74d9cj --resolve c1');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].options).toEqual({ threadId: 'm1', replyVia: 'reply-channel', room: { awakeHere: [ELLA], awakeElsewhere: false } });
    expect(links.linkOf(APP, 'c1')).toMatchObject({ room: ROOM_REF, chatChannelId: 'huddle-brief', chatRootId: 'm1', channel: 'C123', threadTs: '200.1', agentSession: ELLA });

    // A resend of the same comment is not posted again.
    await svc.deliver({ appId: APP, appName: 'Daily brief', room: ROOM_REF, comments: [change('add', thread())] });
    expect(posts).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it('an @mention of a member addresses it (no presence fan-out); a mention of an agent on another machine does not', async () => {
    const svc = make();
    const t = thread({ mentions: [{ session: KAI, name: 'Kai', instanceId: 'inst-1' }, { session: 'crewly-x-y-00000000', name: 'Y', instanceId: 'inst-2' }] });
    await svc.deliver({ appId: APP, appName: 'Daily brief', room: ROOM_REF, comments: [change('add', t)] });
    expect(rows[0].mentions).toEqual([KAI]);
    expect(dispatched[0].message.mentions).toEqual([KAI]);
    expect(dispatched[0].options).toEqual({ threadId: 'm1', replyVia: 'reply-channel' });
  });

  it('nobody awake: dispatched without presence, so the room\'s lead is woken (dispatcher rule)', async () => {
    running = new Set();
    await make().deliver({ appId: APP, appName: 'A', room: ROOM_REF, comments: [change('add', thread({ body: 'shorter' }))] });
    expect(dispatched[0].options).toEqual({ threadId: 'm1', replyVia: 'reply-channel' });
  });

  it('the owner\'s reply in the app goes into both threads once; a reply written in Slack is not delivered again', async () => {
    const svc = make();
    await svc.deliver({ appId: APP, appName: 'A', room: ROOM_REF, comments: [change('add', thread())] });
    const t = thread({ replies: [{ id: 'r1', body: 'and the title', author: { kind: 'owner', name: 'Owner' } }, { id: 'r2', body: 'from slack', author: { kind: 'owner', name: 'Owner', via: 'slack' } as never }] });
    await svc.deliver({ appId: APP, appName: 'A', room: ROOM_REF, comments: [change('reply', t, {}, 'r1'), change('reply', t, { actor: { kind: 'owner', via: 'slack' } as never }, 'r2')] });
    expect(posts.map((p) => [p.threadTs, p.text])).toEqual([
      [undefined, expect.stringContaining('Comment on A')],
      ['200.1', '💬 *Owner (in the app):* and the title'],
    ]);
    expect(rows.map((r) => [r.threadId ?? null, r.content.split('\n')[0]])).toEqual([
      [null, expect.stringContaining('Comment on A')],
      ['m1', '💬 and the title'],
    ]);
    expect(dispatched.map((d) => (d.options as { threadId: string }).threadId)).toEqual(['m1', 'm1']);
    expect(links.linkOf(APP, 'c1')!.replyIds).toEqual(['r1', 'r2']);
    // Redelivery of the same replies: nothing new.
    await svc.deliver({ appId: APP, appName: 'A', room: ROOM_REF, comments: [change('reply', t, {}, 'r1')] });
    expect(rows).toHaveLength(2);
    expect(posts).toHaveLength(2);
  });

  it('a reply to a comment made before the room owned the app opens the thread quietly first; reopen is posted', async () => {
    const svc = make();
    const t = thread({ replies: [{ id: 'r1', body: 'still wrong', author: { kind: 'owner', name: 'Owner' } }] });
    await svc.deliver({ appId: APP, appName: 'A', room: ROOM_REF, comments: [change('reply', t, {}, 'r1'), change('reopen', t)] });
    expect(rows.map((r) => r.threadId ?? null)).toEqual([null, 'm1', 'm1']);
    expect(rows[2].content).toContain('reopened');
    // The quiet root is not dispatched; the reply and the reopen are.
    expect(dispatched.map((d) => d.message.id)).toEqual(['m2', 'm3']);
  });

  it('a room without Slack (or Slack failing) still gets the comment; the link has no Slack thread', async () => {
    room = { ...room!, slackChannelId: null };
    await make().deliver({ appId: APP, appName: 'A', room: ROOM_REF, comments: [change('add', thread())] });
    expect(posts).toHaveLength(0);
    expect(rows[0].metadata).not.toHaveProperty('slackThreadTs');
    expect(links.linkOf(APP, 'c1')).toMatchObject({ channel: '', threadTs: '', chatRootId: 'm1' });
    slackFails = true;
    room = { ...room!, slackChannelId: 'C123' };
    await make().deliver({ appId: APP, appName: 'A', room: ROOM_REF, comments: [{ ...change('add', thread()), comment: { id: 'c2', op: 'add', thread: thread({ id: 'c2' }) } }] });
    expect(rows).toHaveLength(2);
  });

  it('a room that is not here: nothing is posted and the batch is retried', async () => {
    room = null;
    expect(await make().deliver({ appId: APP, appName: 'A', room: ROOM_REF, comments: [change('add', thread())] })).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it('an agent\'s app-comments reply / resolve is written into the room thread as that agent (the Slack mirror posts it as its bot)', async () => {
    const svc = make();
    expect(await svc.agentReplied(APP, 'c1', KAI, 'no thread yet')).toBe(false);
    await svc.deliver({ appId: APP, appName: 'A', room: ROOM_REF, comments: [change('add', thread())] });
    expect(await svc.agentReplied(APP, 'c1', KAI, 'Fixed the date')).toBe(true);
    expect(await svc.statusChanged(APP, 'c1', KAI, 'resolve')).toBe(true);
    expect(rows.slice(1).map((r) => [r.senderType, r.senderId, r.threadId, r.content, (r.metadata as { source: string }).source])).toEqual([
      ['agent', KAI, 'm1', 'Fixed the date', 'app-comment'],
      ['agent', KAI, 'm1', '✅ Resolved in the app.', 'app-comment'],
    ]);
  });

  it('an agent\'s reply in the room thread is added to the app comment as that agent; its own rows, interim notes and other threads are not', async () => {
    const svc = make();
    await svc.deliver({ appId: APP, appName: 'A', room: ROOM_REF, comments: [change('add', thread())] });
    const dto = (over: Partial<ChatMessageDTO>): ChatMessageDTO => ({ id: 'x', channelId: 'huddle-brief', senderType: 'agent', senderId: KAI, content: 'On it — fixed', threadId: 'm1', metadata: {}, ...over }) as unknown as ChatMessageDTO;
    expect(await svc.onChatMessage(dto({}))).toBe(true);
    expect(relayed).toEqual([[APP, 'c1', KAI, 'On it — fixed']]);
    expect(await svc.onChatMessage(dto({ metadata: { source: 'app-comment' } }))).toBe(false);
    expect(await svc.onChatMessage(dto({ metadata: { interim: true } }))).toBe(false);
    expect(await svc.onChatMessage(dto({ threadId: 'other' }))).toBe(false);
    expect(await svc.onChatMessage(dto({ senderType: 'user' }))).toBe(false);
    expect(await svc.onChatMessage(dto({ channelId: 'elsewhere' }))).toBe(false);
    expect(relayed).toHaveLength(1);
  });
});
