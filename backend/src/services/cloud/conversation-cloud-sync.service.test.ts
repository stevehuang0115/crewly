/**
 * Tests for ConversationCloudSyncService — batching, idempotent ids,
 * backoff, the hour-long pauses (404 / sync_disabled), backfill, account
 * switch, O3 and the one-time owner notice. Runs against a real in-memory
 * chat store and a fake Cloud.
 */

import { gunzipSync } from 'zlib';
import { ChatV2Service } from '../chat-v2/chat-v2.service.js';
import { openChatDatabase } from '../chat-v2/sqlite/chat-db.js';
import { loadChatV2Config } from '../chat-v2/config.js';
import { CONVERSATION_SYNC_CONSTANTS } from '../../constants.js';
import type { ComponentLogger } from '../core/logger.service.js';
import {
  ConversationCloudSyncService,
  accountIdOfToken,
  isConversationSyncDisabled,
  toIngestUpsert,
  type ConversationCloudSyncDeps,
} from './conversation-cloud-sync.service.js';
import type { IngestRequest, IngestUpsert } from './conversation-ingest.contract.js';

const K = CONVERSATION_SYNC_CONSTANTS.STATE_KEYS;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A JWT-shaped token for an account (signature not checked). */
function tokenFor(sub: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none' })}.${b({ sub })}.sig`;
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: IngestRequest;
}

type Reply = { status: number; body?: unknown } | ((req: IngestRequest) => { status: number; body?: unknown });

/** Harness: real chat store, fake Cloud, controllable clock. */
function setup(opts: { env?: NodeJS.ProcessEnv; token?: string | null; notify?: ConversationCloudSyncDeps['notifyOwner']; clock?: number } = {}) {
  let clock = opts.clock ?? 1_000_000_000_000;
  const chat = new ChatV2Service({
    config: loadChatV2Config({}),
    db: openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true }),
    now: () => clock,
  });
  const calls: Call[] = [];
  const replies: Reply[] = [];
  let defaultReply: Reply = (req) => ({
    status: 200,
    body: {
      success: true,
      ackedThroughLocalSeq: req.messages.length ? Math.max(...req.messages.map((m) => m.localSeq)) : null,
      accepted: req.messages.length,
      duplicates: 0,
      retentionDays: 7,
    },
  });
  const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(gunzipSync(init.body as Buffer).toString('utf8')) as IngestRequest;
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    const r = replies.shift() ?? defaultReply;
    const res = typeof r === 'function' ? r(body) : r;
    return new Response(res.body === undefined ? '' : JSON.stringify(res.body), { status: res.status });
  });
  const logs: string[] = [];
  const logger = {
    info: (m: string) => logs.push(`info:${m}`),
    warn: (m: string) => logs.push(`warn:${m}`),
    debug: () => undefined,
    error: (m: string) => logs.push(`error:${m}`),
  } as unknown as ComponentLogger;
  let token: string | null = opts.token === undefined ? tokenFor('acct-1') : opts.token;
  const refresh = jest.fn(async () => true);
  const deps: ConversationCloudSyncDeps = {
    outbox: chat.getCloudOutbox(),
    cloud: { getToken: () => token, getCloudUrl: () => 'https://api.test', tryRefreshToken: refresh },
    identity: async () => ({ instanceId: 'dev-1', deviceName: 'Mac mini' }),
    homeId: 'home-1',
    crewlyVersion: async () => '1.21.0',
    notifyOwner: opts.notify,
    env: opts.env ?? {},
    fetchImpl: fetchImpl as unknown as ConversationCloudSyncDeps['fetchImpl'],
    now: () => clock,
    setTimeout: (() => 0 as unknown as ReturnType<typeof setTimeout>) as ConversationCloudSyncDeps['setTimeout'],
    clearTimeout: () => undefined,
    logger,
  };
  const svc = new ConversationCloudSyncService(deps);
  const dm = chat.ensureDmChannel({ agentSession: 'ella', principal: { userId: 'owner', source: 'oss' } }).channel;
  const say = (content: string, extra: Partial<Parameters<ChatV2Service['recordTurn']>[0]> = {}) =>
    chat.recordTurn({ channelId: dm.id, senderType: 'user', senderId: 'Steve', content, metadata: { source: 'web' }, ...extra }).message;
  return {
    chat,
    svc,
    calls,
    replies,
    logs,
    fetchImpl,
    refresh,
    dm,
    say,
    outbox: chat.getCloudOutbox(),
    tick: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    setToken: (t: string | null) => {
      token = t;
    },
    setDefault: (r: Reply) => {
      defaultReply = r;
    },
    /** Skip the probe + backfill so a test sees only live traffic. */
    liveOnly: () => {
      const o = chat.getCloudOutbox();
      o.setState(K.ACCOUNT_ID, 'acct-1');
      o.setState(K.RETENTION_DAYS, '7');
      o.setState(K.BACKFILL_DONE_AT, '1');
      o.setState(K.BACKFILL_RETENTION_DAYS, '7');
    },
  };
}

describe('ConversationCloudSyncService', () => {
  describe('live upload', () => {
    it('drains the outbox in seq order, in batches of 50, gzip with the bearer token', async () => {
      const h = setup();
      h.liveOnly();
      for (let i = 0; i < 120; i++) h.say(`m${i}`);
      await h.svc.syncNow();

      expect(h.calls.map((c) => c.body.messages.length)).toEqual([50, 50, 20]);
      const first = h.calls[0]!;
      expect(first.url).toBe('https://api.test/api/cloud/conversations/ingest');
      expect(first.headers).toMatchObject({
        Authorization: `Bearer ${tokenFor('acct-1')}`,
        'Content-Encoding': 'gzip',
        'Content-Type': 'application/json',
      });
      expect(first.body).toMatchObject({ instanceId: 'dev-1', homeId: 'home-1', crewlyVersion: '1.21.0', deviceName: 'Mac mini', mode: 'live' });
      const seqs = h.calls.flatMap((c) => c.body.messages.map((m) => m.localSeq));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(h.calls.flatMap((c) => c.body.messages.map((m) => m.localId))).size).toBe(120);
      expect(h.outbox.count()).toBe(0);
    });

    it('sends each message with the fields Cloud requires', async () => {
      const h = setup();
      h.liveOnly();
      h.say('hello', { metadata: { source: 'cloud-talk' }, clientMessageId: 'talk-9' });
      await h.svc.syncNow();
      const m = h.calls[0]!.body.messages[0] as IngestUpsert;
      expect(m).toMatchObject({
        op: 'upsert',
        channel: { localId: h.dm.id, kind: 'dm', name: 'ella' },
        agentSession: 'ella',
        source: 'cloud-talk',
        direction: 'in',
        senderKind: 'owner',
        sender: { id: 'Steve' },
        text: 'hello',
        contentType: 'markdown',
        attachments: [],
        clientMessageId: 'talk-9',
      });
      expect(typeof m.createdAt).toBe('number');
      expect(m.localSeq).toBeGreaterThan(0);
    });

    it('keeps rows it could not deliver and resends only those (idempotent ids)', async () => {
      const h = setup();
      h.liveOnly();
      for (let i = 0; i < 70; i++) h.say(`m${i}`);
      h.replies.push((req) => ({ status: 200, body: { ackedThroughLocalSeq: Math.max(...req.messages.map((m) => m.localSeq)), retentionDays: 7 } }));
      h.replies.push({ status: 502 });
      await h.svc.syncNow();
      expect(h.outbox.count()).toBe(20);

      h.tick(1_000);
      await h.svc.syncNow();
      const firstIds = h.calls[0]!.body.messages.map((m) => m.localId);
      const retried = h.calls[1]!.body.messages.map((m) => m.localId);
      const resent = h.calls[2]!.body.messages.map((m) => m.localId);
      expect(resent).toEqual(retried);
      expect(resent.some((id) => firstIds.includes(id))).toBe(false);
      expect(h.outbox.count()).toBe(0);
    });

    it('advances the outbox only as far as Cloud acknowledged', async () => {
      const h = setup();
      h.liveOnly();
      for (let i = 0; i < 5; i++) h.say(`m${i}`);
      h.replies.push((req) => ({ status: 200, body: { ackedThroughLocalSeq: req.messages[2]!.localSeq } }));
      await h.svc.syncNow();
      expect(h.outbox.count()).toBe(2);
    });

    it('sends a delete for a removed message', async () => {
      const h = setup();
      h.liveOnly();
      const m = h.say('oops');
      await h.svc.syncNow();
      h.chat.clearChannel(h.dm.id, { userId: 'owner', source: 'oss' });
      await h.svc.syncNow();
      expect(h.calls[1]!.body.messages).toEqual([{ localId: m.id, localSeq: expect.any(Number), op: 'delete' }]);
    });

    it('never uploads other people\'s chatter in a shared Slack channel (O3)', async () => {
      const h = setup();
      h.liveOnly();
      h.chat.setOwnerIdentityProvider(() => ({ slackUserId: 'U-owner' }));
      const room = h.chat.createHuddle({ name: 'daily', memberSessions: ['ella'], principal: { userId: 'owner', source: 'oss' } });
      const post = (content: string, slackUserId: string, mentions?: string[]) =>
        h.chat.recordTurn({ channelId: room.id, senderType: 'user', senderId: slackUserId, content, mentions, metadata: { source: 'slack', slackUserId, slackChannelId: 'C1' } });
      post('lunch?', 'U-maya');
      post('@ella status?', 'U-maya', ['ella']);
      post('ship it', 'U-owner');
      await h.svc.syncNow();
      const sent = h.calls.flatMap((c) => c.body.messages) as IngestUpsert[];
      expect(sent.map((m) => m.text)).toEqual(['@ella status?', 'ship it']);
      expect(sent[0]).toMatchObject({ senderKind: 'human', direction: 'in', mentions: ['ella'], sender: { id: 'U-maya' } });
      expect(sent[1]).toMatchObject({ senderKind: 'owner', agentSession: 'ella' });
    });
  });

  describe('failures', () => {
    it('backs off exponentially from 1 s and retries', async () => {
      const h = setup();
      h.liveOnly();
      h.say('x');
      h.setDefault({ status: 500 });
      await h.svc.syncNow();
      expect(h.calls).toHaveLength(1);
      await h.svc.syncNow();
      expect(h.calls).toHaveLength(1);
      h.tick(1_000);
      await h.svc.syncNow();
      expect(h.calls).toHaveLength(2);
      h.tick(1_000);
      await h.svc.syncNow();
      expect(h.calls).toHaveLength(2); // now 2 s
      h.tick(1_000);
      await h.svc.syncNow();
      expect(h.calls).toHaveLength(3);
      expect(h.outbox.count()).toBe(1);
    });

    it('caps the backoff at 5 minutes', async () => {
      const h = setup();
      h.liveOnly();
      h.say('x');
      h.setDefault({ status: 500 });
      for (let i = 0; i < 12; i++) {
        await h.svc.syncNow();
        h.tick(CONVERSATION_SYNC_CONSTANTS.BACKOFF_MAX_MS);
      }
      expect(h.calls).toHaveLength(12);
    });

    it('404 (Cloud not deployed): quiet, logged once, retried hourly', async () => {
      const h = setup();
      h.say('x');
      h.setDefault({ status: 404, body: { error: 'Not found' } });
      await h.svc.syncNow();
      expect(h.calls).toHaveLength(1);
      for (let i = 0; i < 5; i++) {
        h.tick(10 * 60 * 1000 - 1);
        await h.svc.syncNow();
      }
      expect(h.calls).toHaveLength(1);
      h.tick(HOUR);
      await h.svc.syncNow();
      expect(h.calls).toHaveLength(2);
      expect(h.logs.filter((l) => l.includes('no conversation store'))).toHaveLength(1);
      expect(h.logs.filter((l) => l.startsWith('warn:'))).toHaveLength(0);
      expect(h.outbox.count()).toBe(1);
    });

    it('403 sync_disabled pauses for an hour; success resumes', async () => {
      const h = setup();
      h.liveOnly();
      h.say('x');
      h.replies.push({ status: 403, body: { success: false, code: 'sync_disabled', error: 'off' } });
      await h.svc.syncNow();
      h.tick(HOUR - 1);
      await h.svc.syncNow();
      expect(h.calls).toHaveLength(1);
      h.tick(1);
      await h.svc.syncNow();
      expect(h.calls).toHaveLength(2);
      expect(h.outbox.count()).toBe(0);
      expect(h.logs.some((l) => l.includes('taking conversation history again'))).toBe(true);
    });

    it('503 conversations_key_missing and 400 invalid_batch pause for an hour', async () => {
      for (const reply of [
        { status: 503, body: { code: 'conversations_key_missing' } },
        { status: 400, body: { code: 'invalid_batch' } },
      ]) {
        const h = setup();
        h.liveOnly();
        h.say('x');
        h.replies.push(reply);
        await h.svc.syncNow();
        h.tick(30 * 60 * 1000);
        await h.svc.syncNow();
        expect(h.calls).toHaveLength(1);
      }
    });

    it('401 asks the Cloud client to refresh the token and retries', async () => {
      const h = setup();
      h.liveOnly();
      h.say('x');
      h.replies.push({ status: 401 });
      await h.svc.syncNow();
      expect(h.refresh).toHaveBeenCalled();
      h.tick(1_000);
      await h.svc.syncNow();
      expect(h.outbox.count()).toBe(0);
    });

    it('413 halves the batch until Cloud takes it', async () => {
      const h = setup();
      h.liveOnly();
      for (let i = 0; i < 10; i++) h.say(`m${i}`);
      h.replies.push({ status: 413, body: { code: 'payload_too_large' } });
      await h.svc.syncNow();
      expect(h.calls.map((c) => c.body.messages.length)).toEqual([10, 5, 5]);
      expect(h.outbox.count()).toBe(0);
    });

    it('skips a single message Cloud will never take instead of wedging the outbox', async () => {
      const h = setup();
      h.liveOnly();
      h.say('huge');
      h.say('fine');
      h.replies.push({ status: 413 }, { status: 413 });
      await h.svc.syncNow();
      expect(h.calls.map((c) => c.body.messages.map((m) => (m as IngestUpsert).text))).toEqual([['huge', 'fine'], ['huge'], ['fine']]);
      expect(h.outbox.count()).toBe(0);
    });

    it('a network error keeps the outbox for later', async () => {
      const h = setup();
      h.liveOnly();
      h.say('x');
      h.fetchImpl.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await h.svc.syncNow();
      expect(h.outbox.count()).toBe(1);
    });
  });

  describe('switches', () => {
    it('does nothing while signed out; the outbox waits', async () => {
      const h = setup({ token: null });
      h.say('x');
      await h.svc.syncNow();
      expect(h.fetchImpl).not.toHaveBeenCalled();
      expect(h.outbox.count()).toBe(1);
    });

    it.each([
      [{ CREWLY_CONVERSATION_SYNC: '0' }],
      [{ CREWLY_CONVERSATION_SYNC: 'off' }],
      [{ CREWLY_CLOUD_CONVERSATIONS: 'off' }],
    ])('kill switch %j stops uploading; the outbox still fills', async (env) => {
      const h = setup({ env });
      h.say('x');
      await h.svc.syncNow();
      expect(h.fetchImpl).not.toHaveBeenCalled();
      expect(h.outbox.count()).toBe(1);
    });
  });

  describe('backfill (first sign-in)', () => {
    it('asks Cloud for the plan window, then sends the history inside it as backfill after the live rows', async () => {
      const h = setup();
      h.say('too old');
      h.tick(10 * DAY);
      h.say('recent');
      h.outbox.clear(); // pretend both predate the migration
      h.tick(1_000);
      h.say('live');
      h.setDefault((req) => ({
        status: 200,
        body: { ackedThroughLocalSeq: req.messages.length ? Math.max(...req.messages.map((m) => m.localSeq)) : null, retentionDays: 7 },
      }));
      await h.svc.syncNow();

      expect(h.calls[0]!.body.messages).toEqual([]); // retention probe
      expect(h.calls[1]!.body).toMatchObject({ mode: 'live' });
      expect(h.calls[1]!.body.messages.map((m) => (m as IngestUpsert).text)).toEqual(['live']);
      expect(h.calls[2]!.body.mode).toBe('backfill');
      expect(h.calls[2]!.body.messages.map((m) => (m as IngestUpsert).text)).toEqual(['recent', 'live']);
      expect(h.calls[2]!.body.messages.every((m) => m.localSeq === 0)).toBe(true);

      // At most one backfill request a second; the next one finds nothing and finishes.
      await h.svc.syncNow();
      expect(h.calls).toHaveLength(3);
      h.tick(1_000);
      await h.svc.syncNow();
      expect(h.outbox.getState(K.BACKFILL_DONE_AT)).not.toBeNull();
      expect(h.outbox.getState(K.BACKFILL_RETENTION_DAYS)).toBe('7');
      h.tick(1_000);
      await h.svc.syncNow();
      expect(h.calls).toHaveLength(3);
    });

    it('resumes from its cursor and pages history', async () => {
      const h = setup();
      h.liveOnly();
      h.outbox.setState(K.BACKFILL_DONE_AT, null);
      for (let i = 0; i < 3; i++) h.say(`h${i}`);
      h.outbox.clear();
      const first = h.chat.getCloudOutbox().backfillPage(0, null, 10);
      h.outbox.setState(K.BACKFILL_CURSOR, JSON.stringify({ createdAt: first[0]!.createdAt, rowid: first[0]!.rowid }));
      await h.svc.syncNow();
      expect(h.calls[0]!.body.messages.map((m) => (m as IngestUpsert).text)).toEqual(['h1', 'h2']);
    });

    it('re-sends a wider window after an upgrade (7 → 90 days)', async () => {
      const h = setup();
      h.liveOnly();
      h.say('30 days ago');
      h.outbox.clear();
      h.tick(30 * DAY);
      h.setDefault({ status: 200, body: { ackedThroughLocalSeq: null, retentionDays: 90 } });
      h.say('now');
      await h.svc.syncNow();
      h.tick(1_000);
      await h.svc.syncNow();
      const backfilled = h.calls.filter((c) => c.body.mode === 'backfill').flatMap((c) => c.body.messages.map((m) => (m as IngestUpsert).text));
      expect(backfilled).toContain('30 days ago');
    });

    it('starts over for a new account: old queue dropped, history re-sent', async () => {
      const h = setup();
      h.liveOnly();
      h.say('before');
      await h.svc.syncNow();
      h.setToken(tokenFor('acct-2'));
      h.fetchImpl.mockClear();
      h.calls.length = 0;
      h.tick(1_000);
      await h.svc.syncNow();
      expect(h.outbox.getState(K.ACCOUNT_ID)).toBe('acct-2');
      expect(h.calls[0]!.body.messages).toEqual([]); // fresh retention probe
      expect(h.calls.some((c) => c.body.mode === 'backfill' && c.body.messages.some((m) => (m as IngestUpsert).text === 'before'))).toBe(true);
    });

    it('does not treat a token refresh as an account switch', async () => {
      const h = setup();
      h.liveOnly();
      h.say('x');
      h.setToken(tokenFor('acct-1').replace('.sig', '.sig2'));
      await h.svc.syncNow();
      expect(h.outbox.getState(K.BACKFILL_DONE_AT)).toBe('1');
    });
  });

  describe('owner notice (O1)', () => {
    it('DMs the owner once, the first time history reaches Cloud', async () => {
      const notify = jest.fn(async () => true);
      const h = setup({ notify });
      h.liveOnly();
      h.say('a');
      await h.svc.syncNow();
      await new Promise((r) => setImmediate(r));
      h.say('b');
      h.tick(1_000);
      await h.svc.syncNow();
      await new Promise((r) => setImmediate(r));
      expect(notify).toHaveBeenCalledTimes(1);
      expect((notify.mock.calls[0] as unknown as [string])[0]).toContain('Mac mini');
      expect(h.outbox.getState(K.NOTICE_SENT_AT)).not.toBeNull();
    });

    it('sends nothing while Cloud is not deployed (404)', async () => {
      const notify = jest.fn(async () => true);
      const h = setup({ notify });
      h.say('a');
      h.setDefault({ status: 404 });
      await h.svc.syncNow();
      await new Promise((r) => setImmediate(r));
      expect(notify).not.toHaveBeenCalled();
    });

    it('tries again (hourly) when the DM could not be posted', async () => {
      const notify = jest.fn(async () => false);
      const h = setup({ notify });
      h.liveOnly();
      h.say('a');
      await h.svc.syncNow();
      await new Promise((r) => setImmediate(r));
      h.say('b');
      await h.svc.syncNow();
      await new Promise((r) => setImmediate(r));
      expect(notify).toHaveBeenCalledTimes(1);
      h.tick(HOUR);
      h.say('c');
      await h.svc.syncNow();
      await new Promise((r) => setImmediate(r));
      expect(notify).toHaveBeenCalledTimes(2);
      expect(h.outbox.getState(K.NOTICE_SENT_AT)).toBeNull();
    });
  });

  describe('timers', () => {
    it('wakes on a new message and ticks every 10 s', async () => {
      const timers: Array<{ fn: () => void; ms: number }> = [];
      const h = setup();
      h.liveOnly();
      const listeners: Array<() => void> = [];
      const svc = new ConversationCloudSyncService({
        outbox: h.outbox,
        cloud: { getToken: () => tokenFor('acct-1'), getCloudUrl: () => 'https://api.test' },
        identity: async () => ({ instanceId: 'dev-1' }),
        fetchImpl: h.fetchImpl as unknown as ConversationCloudSyncDeps['fetchImpl'],
        env: {},
        onNewMessage: (l) => {
          listeners.push(l);
          return () => listeners.splice(listeners.indexOf(l), 1);
        },
        setTimeout: ((fn: () => void, ms: number) => {
          timers.push({ fn, ms });
          return timers.length as unknown as ReturnType<typeof setTimeout>;
        }) as ConversationCloudSyncDeps['setTimeout'],
        clearTimeout: () => undefined,
        logger: { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined } as unknown as ComponentLogger,
      });
      svc.start();
      expect(timers.map((t) => t.ms)).toEqual([CONVERSATION_SYNC_CONSTANTS.TICK_INTERVAL_MS, 0]);
      timers[1]!.fn();
      await new Promise((r) => setImmediate(r));
      h.say('x');
      listeners.forEach((l) => l());
      expect(timers[timers.length - 1]!.ms).toBe(CONVERSATION_SYNC_CONSTANTS.BATCH_MAX_WAIT_MS);
      svc.stop();
      expect(listeners).toHaveLength(0);
    });
  });
});

describe('helpers', () => {
  it('reads the account from the JWT sub; an opaque token is one constant account', () => {
    expect(accountIdOfToken(tokenFor('g-123'))).toBe('g-123');
    expect(accountIdOfToken('sk-opaque')).toBe(accountIdOfToken('sk-other'));
  });

  it('recognises the kill switch values', () => {
    expect(isConversationSyncDisabled({})).toBe(false);
    expect(isConversationSyncDisabled({ CREWLY_CONVERSATION_SYNC: '1' })).toBe(false);
    expect(isConversationSyncDisabled({ CREWLY_CONVERSATION_SYNC: 'false' })).toBe(true);
  });

  it('maps a Slack row: Slack user id as sender, lead member when nobody is addressed, no stray clientMessageId', () => {
    const upsert = toIngestUpsert(
      {
        rowid: 1,
        id: 'm1',
        channelId: 'huddle-1',
        senderType: 'user',
        senderId: 'Steve',
        content: 'morning',
        contentType: 'markdown',
        createdAt: 5,
        metadata: JSON.stringify({ clientMessageId: 'slack-out-x' }),
        mentions: null,
        threadId: 'root-1',
        source: 'slack',
        direction: 'in',
        senderKind: 'owner',
        agentSession: null,
        extRef: JSON.stringify({ slackChannelId: 'C1', slackUserId: 'U1', ts: '1.1' }),
        cloudSync: 1,
        channelName: 'daily',
        channelType: 'huddle',
        leadMember: 'ella',
        attachments: [{ kind: 'image', mimeType: 'image/png', sizeBytes: 10, originalName: 'shot.png' }],
      },
      7,
    );
    expect(upsert).toEqual({
      localId: 'm1',
      op: 'upsert',
      channel: { localId: 'huddle-1', kind: 'huddle', name: 'daily' },
      agentSession: 'ella',
      source: 'slack',
      direction: 'in',
      senderKind: 'owner',
      sender: { id: 'U1', name: 'Steve' },
      ext: { slackChannelId: 'C1', slackUserId: 'U1', ts: '1.1' },
      threadLocalId: 'root-1',
      text: 'morning',
      contentType: 'markdown',
      attachments: [{ kind: 'image', mime: 'image/png', size: 10, name: 'shot.png' }],
      createdAt: 5,
      localSeq: 7,
    });
  });

  it('refuses a row marked not-for-Cloud', () => {
    expect(
      toIngestUpsert(
        {
          rowid: 1, id: 'm', channelId: 'c', senderType: 'user', senderId: 'x', content: 'x', contentType: 'text', createdAt: 1,
          metadata: null, mentions: null, threadId: null, source: 'slack', direction: 'internal', senderKind: 'human',
          agentSession: null, extRef: null, cloudSync: 0, channelName: 'c', channelType: 'huddle', leadMember: null, attachments: [],
        },
        1,
      ),
    ).toBeNull();
  });
});
