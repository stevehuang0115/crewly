/**
 * Tests for SlackThreadContextService — the Slack thread / channel context
 * read at delivery time (2026-09-28 #daily-info incident: a thread post by an
 * agent on another machine never reached this machine).
 */

import {
  SlackThreadContextService,
  contextKindFor,
  renderSlackThreadContext,
  type SlackContextFetch,
  type SlackThreadContext,
} from './slack-thread-context.service.js';
import { SLACK_THREAD_CONTEXT_CONSTANTS } from '../../constants.js';

type Handler = (method: string, params: URLSearchParams, token: string) => {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  throws?: Error;
};

/** A fake Slack Web API; records every call. */
function fakeSlack(handler: Handler) {
  const calls: Array<{ method: string; params: URLSearchParams; token: string }> = [];
  const fetchImpl: SlackContextFetch = async (url, init) => {
    const u = new URL(url);
    const method = u.pathname.split('/').pop() as string;
    const token = init.headers.Authorization.replace('Bearer ', '');
    calls.push({ method, params: u.searchParams, token });
    const r = handler(method, u.searchParams, token);
    if (r.throws) throw r.throws;
    const headers = r.headers ?? {};
    return {
      status: r.status ?? 200,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      json: async () => r.body,
    };
  };
  return { fetchImpl, calls };
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
}

const CH = 'C0C2QCGE9K9';
const ROOT = '1790000000.000100';
const DIGEST = '1790000100.000200';
const TRIGGER = '1790000200.000300';

/** The incident thread: owner's root, Ella's digest from the other machine, then the owner's @Atlas. */
const incidentReplies = {
  ok: true,
  messages: [
    { ts: ROOT, user: 'USTEVE', text: 'daily info thread' },
    {
      ts: DIGEST,
      user: 'UELLABOT',
      bot_id: 'B_ELLA',
      bot_profile: { name: 'Ella (Personal Assistant Team)' },
      text: '📬 Email digest: 1) AWS invoice 2) <@USTEVE> dentist reminder',
    },
    { ts: TRIGGER, user: 'USTEVE', text: '<@UATLASBOT> 看看上面的这些' },
  ],
};

const usersInfo = (params: URLSearchParams) => {
  const names: Record<string, { display_name: string; is_bot?: boolean }> = {
    USTEVE: { display_name: 'Steve' },
    UATLASBOT: { display_name: 'Atlas', is_bot: true },
  };
  const hit = names[params.get('user') as string];
  return hit
    ? { body: { ok: true, user: { name: hit.display_name.toLowerCase(), is_bot: !!hit.is_bot, profile: { display_name: hit.display_name } } } }
    : { body: { ok: false, error: 'user_not_found' } };
};

describe('contextKindFor', () => {
  it('thread reply → thread; top-level channel @ → channel; top-level DM or plain channel message → none', () => {
    expect(contextKindFor({ channelId: CH, ts: TRIGGER, threadTs: ROOT })).toBe('thread');
    expect(contextKindFor({ channelId: 'D123', ts: TRIGGER, threadTs: ROOT })).toBe('thread');
    expect(contextKindFor({ channelId: CH, ts: TRIGGER, text: '<@UATLASBOT> hi' })).toBe('channel');
    expect(contextKindFor({ channelId: 'D123', ts: TRIGGER, text: '<@UATLASBOT> hi' })).toBeNull();
    expect(contextKindFor({ channelId: CH, ts: TRIGGER, text: 'hello' })).toBeNull();
    // A thread root itself (threadTs === ts) is not a reply.
    expect(contextKindFor({ channelId: CH, ts: ROOT, threadTs: ROOT, text: 'x' })).toBeNull();
  });
});

describe('SlackThreadContextService', () => {
  it('includes another machine\'s bot post with its author, excludes the trigger, resolves names', async () => {
    const { fetchImpl, calls } = fakeSlack((method, params) =>
      method === 'conversations.replies' ? { body: incidentReplies } : usersInfo(params),
    );
    const svc = new SlackThreadContextService({ fetchImpl, logger: makeLogger() });
    const ctx = await svc.getContext(
      { channelId: CH, ts: TRIGGER, threadTs: ROOT, text: '<@UATLASBOT> 看看上面的这些' },
      ['xoxb-atlas', 'xoxb-workspace'],
    );
    expect(ctx?.kind).toBe('thread');
    expect(ctx?.messages.map((m) => m.ts)).toEqual([ROOT, DIGEST]);
    expect(ctx?.messages[1]).toMatchObject({ authorName: 'Ella (Personal Assistant Team)', isBot: true, userId: 'UELLABOT' });
    expect(ctx?.messages[1].text).toContain('@Steve dentist');
    expect(ctx?.messages[0].authorName).toBe('Steve');
    const replies = calls.find((c) => c.method === 'conversations.replies');
    expect(replies?.token).toBe('xoxb-atlas');
    expect(replies?.params.get('ts')).toBe(ROOT);

    const block = renderSlackThreadContext(ctx, { botUserId: 'UATLASBOT', name: 'Atlas' });
    expect(block).toContain('Slack thread so far');
    expect(block).toContain('Ella (Personal Assistant Team) [bot]: 📬 Email digest');
    expect(block).not.toContain('看看上面的这些');
  });

  it('marks lines written by the same agent — own bot user id, or a username override with its name', async () => {
    const { fetchImpl } = fakeSlack((method, params) =>
      method === 'conversations.replies'
        ? {
            body: {
              ok: true,
              messages: [
                { ts: '1.1', user: 'UATLASBOT', bot_id: 'B_A', bot_profile: { name: 'Atlas' }, text: 'my earlier answer' },
                { ts: '1.2', bot_id: 'B_MASTER', subtype: 'bot_message', username: 'Atlas', text: 'posted via workspace bot' },
                { ts: '1.3', bot_id: 'B_MASTER', subtype: 'bot_message', username: 'Ella', text: 'someone else' },
                { ts: '1.4', user: 'USTEVE', text: 'follow-up' },
              ],
            },
          }
        : usersInfo(params),
    );
    const svc = new SlackThreadContextService({ fetchImpl, logger: makeLogger() });
    const ctx = await svc.getContext({ channelId: CH, ts: '1.9', threadTs: '1.1' }, ['t']);
    const block = renderSlackThreadContext(ctx, { botUserId: 'UATLASBOT', name: 'Atlas' });
    expect(block).toContain('Atlas [bot] (you): my earlier answer');
    expect(block).toContain('Atlas [bot] (you): posted via workspace bot');
    expect(block).toContain('Ella [bot]: someone else');
    expect(block).toContain('Steve: follow-up');
    // Another agent sees no "(you)" on Atlas's lines.
    expect(renderSlackThreadContext(ctx, { botUserId: 'UELLA', name: 'Ella' })).not.toContain('Atlas [bot] (you)');
  });

  it('leaves out replies posted after the trigger and channel housekeeping', async () => {
    const { fetchImpl } = fakeSlack((method, params) =>
      method === 'conversations.replies'
        ? {
            body: {
              ok: true,
              messages: [
                { ts: '1.1', user: 'USTEVE', text: 'root' },
                { ts: '1.2', user: 'USTEVE', subtype: 'channel_join', text: 'joined' },
                { ts: '1.5', user: 'USTEVE', text: 'trigger' },
                { ts: '1.6', user: 'USTEVE', text: 'later' },
              ],
            },
          }
        : usersInfo(params),
    );
    const svc = new SlackThreadContextService({ fetchImpl, logger: makeLogger() });
    const ctx = await svc.getContext({ channelId: CH, ts: '1.5', threadTs: '1.1' }, ['t']);
    expect(ctx?.messages.map((m) => m.text)).toEqual(['root']);
  });

  it('caps the count and the characters, keeping the newest', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ts: `2.${String(i + 1).padStart(3, '0')}`, username: 'Bot', bot_id: 'B', text: `msg-${i + 1}` }));
    const { fetchImpl } = fakeSlack(() => ({ body: { ok: true, messages: many } }));
    const svc = new SlackThreadContextService({ fetchImpl, logger: makeLogger() });
    const ctx = await svc.getContext({ channelId: CH, ts: '2.999', threadTs: '2.001' }, ['t']);
    expect(ctx?.messages).toHaveLength(SLACK_THREAD_CONTEXT_CONSTANTS.MAX_MESSAGES);
    expect(ctx?.totalBefore).toBe(50);
    expect(ctx?.messages[ctx.messages.length - 1].text).toBe('msg-50');
    const block = renderSlackThreadContext(ctx);
    expect(block).toContain('30 of 50 messages, older ones omitted');
    expect(block).toContain('msg-50');
    expect(block).not.toContain('msg-20');

    // Character budget: the newest message survives, older ones fall off.
    const big: SlackThreadContext = {
      kind: 'thread',
      channelId: CH,
      messages: [
        { ts: '3.1', isBot: false, authorName: 'A', text: 'old '.repeat(100) },
        { ts: '3.2', isBot: false, authorName: 'B', text: 'newest' },
      ],
      totalBefore: 2,
    };
    const small = renderSlackThreadContext(big, undefined, 50);
    expect(small).toContain('B: newest');
    expect(small).not.toContain('A: old');
    expect(small).toContain('1 of 2 messages, older ones omitted');
  });

  it('reuses one fetch per (channel, thread) for a minute', async () => {
    let now = 1_000_000;
    const { fetchImpl, calls } = fakeSlack((method, params) =>
      method === 'conversations.replies' ? { body: incidentReplies } : usersInfo(params),
    );
    const svc = new SlackThreadContextService({ fetchImpl, now: () => now, logger: makeLogger() });
    const req = { channelId: CH, ts: TRIGGER, threadTs: ROOT };
    await svc.getContext(req, ['t']);
    await svc.getContext(req, ['t']);
    expect(calls.filter((c) => c.method === 'conversations.replies')).toHaveLength(1);
    // Names are cached too.
    const lookups = calls.filter((c) => c.method === 'users.info').length;
    now += SLACK_THREAD_CONTEXT_CONSTANTS.CACHE_TTL_MS + 1;
    await svc.getContext(req, ['t']);
    expect(calls.filter((c) => c.method === 'conversations.replies')).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'users.info').length).toBe(lookups);
  });

  it('missing scope: tries the next token, then gives up with no block and logs the scope once per channel', async () => {
    const logger = makeLogger();
    const { fetchImpl, calls } = fakeSlack(() => ({ body: { ok: false, error: 'missing_scope', needed: 'groups:history' } }));
    const svc = new SlackThreadContextService({ fetchImpl, logger, now: (() => { let t = 0; return () => (t += 120_000); })() });
    const req = { channelId: 'G_PRIVATE', ts: TRIGGER, threadTs: ROOT };
    expect(await svc.getContext(req, ['a', 'b'])).toBeNull();
    expect(calls.map((c) => c.token)).toEqual(['a', 'b']);
    expect(await svc.getContext(req, ['a', 'b'])).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ channelId: 'G_PRIVATE', missingScope: 'groups:history' });
  });

  it('not_in_channel with the first token falls back to the next', async () => {
    const { fetchImpl } = fakeSlack((method, params, token) => {
      if (method === 'conversations.replies') {
        return token === 'outsider' ? { body: { ok: false, error: 'not_in_channel' } } : { body: incidentReplies };
      }
      return usersInfo(params);
    });
    const svc = new SlackThreadContextService({ fetchImpl, logger: makeLogger() });
    const ctx = await svc.getContext({ channelId: CH, ts: TRIGGER, threadTs: ROOT }, ['outsider', 'member']);
    expect(ctx?.messages).toHaveLength(2);
  });

  it('429: no block, the token rests for Retry-After, logged once', async () => {
    let now = 5_000_000;
    const logger = makeLogger();
    const { fetchImpl, calls } = fakeSlack(() => ({ status: 429, headers: { 'retry-after': '30' }, body: {} }));
    const svc = new SlackThreadContextService({ fetchImpl, logger, now: () => now });
    expect(await svc.getContext({ channelId: CH, ts: TRIGGER, threadTs: ROOT }, ['t'])).toBeNull();
    // Within Retry-After: the token is not called again.
    now += 10_000;
    expect(await svc.getContext({ channelId: CH, ts: '1790000300.1', threadTs: ROOT }, ['t'])).toBeNull();
    expect(calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ reason: 'rate_limited', retryAfterMs: 30_000 });
  });

  it('getContextWithinRateLimit: waits out a retry-after that fits the budget, gives up at once when it does not (one responder, the one retry)', async () => {
    let now = 5_000_000;
    let limited = true;
    const { fetchImpl, calls } = fakeSlack((method, params) => {
      if (method === 'conversations.replies') {
        if (limited) {
          limited = false;
          return { status: 429, headers: { 'retry-after': '1' }, body: {} };
        }
        return { body: incidentReplies };
      }
      return usersInfo(params);
    });
    const sleep = jest.fn(async (ms: number) => {
      now += ms;
    });
    const svc = new SlackThreadContextService({ fetchImpl, logger: makeLogger(), now: () => now, sleep });
    const req = { channelId: CH, ts: TRIGGER, threadTs: ROOT };
    expect(await svc.getContext(req, ['t'])).toBeNull();
    // A plain retry inside the retry-after would not even call Slack; this one waits it out.
    const ctx = await svc.getContextWithinRateLimit(req, ['t'], 1_600);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(ctx?.messages).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'conversations.replies')).toHaveLength(2);

    // A retry-after longer than the budget: no wait, no call.
    const slow = fakeSlack(() => ({ status: 429, headers: { 'retry-after': '5' }, body: {} }));
    const sleep2 = jest.fn(async () => undefined);
    const svc2 = new SlackThreadContextService({ fetchImpl: slow.fetchImpl, logger: makeLogger(), now: () => now, sleep: sleep2 });
    expect(await svc2.getContext(req, ['t'])).toBeNull();
    expect(await svc2.getContextWithinRateLimit(req, ['t'], 1_600)).toBeNull();
    expect(sleep2).not.toHaveBeenCalled();
    expect(slow.calls).toHaveLength(1);
  });

  it('network error: no block, never throws, logged once', async () => {
    const logger = makeLogger();
    const { fetchImpl } = fakeSlack(() => ({ throws: new Error('ECONNRESET') }));
    const svc = new SlackThreadContextService({ fetchImpl, logger, now: (() => { let t = 0; return () => (t += 120_000); })() });
    await expect(svc.getContext({ channelId: CH, ts: TRIGGER, threadTs: ROOT }, ['a', 'b'])).resolves.toBeNull();
    await expect(svc.getContext({ channelId: CH, ts: TRIGGER, threadTs: ROOT }, ['a', 'b'])).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ reason: 'network', error: 'ECONNRESET' });
  });

  it('a top-level @-mention reads recent channel history before it (oldest→newest)', async () => {
    const { fetchImpl, calls } = fakeSlack((method, params) =>
      method === 'conversations.history'
        ? {
            body: {
              ok: true,
              messages: [
                { ts: '4.3', bot_id: 'B_ELLA', user: 'UELLABOT', bot_profile: { name: 'Ella' }, text: 'newest bot post' },
                { ts: '4.1', user: 'USTEVE', text: 'older human post' },
              ],
            },
          }
        : usersInfo(params),
    );
    const svc = new SlackThreadContextService({ fetchImpl, logger: makeLogger() });
    const ctx = await svc.getContext({ channelId: CH, ts: '4.5', text: '<@UATLASBOT> what do you think?' }, ['t']);
    const history = calls.find((c) => c.method === 'conversations.history');
    expect(history?.params.get('latest')).toBe('4.5');
    expect(history?.params.get('inclusive')).toBe('false');
    expect(history?.params.get('limit')).toBe(String(SLACK_THREAD_CONTEXT_CONSTANTS.CHANNEL_HISTORY_LIMIT));
    expect(ctx?.kind).toBe('channel');
    expect(ctx?.messages.map((m) => m.text)).toEqual(['older human post', 'newest bot post']);
    expect(renderSlackThreadContext(ctx)).toContain('Recent Slack channel messages before this one');
  });

  it('a top-level DM, and a channel message with no mention, fetch nothing', async () => {
    const { fetchImpl, calls } = fakeSlack(() => ({ body: { ok: true, messages: [] } }));
    const svc = new SlackThreadContextService({ fetchImpl, logger: makeLogger() });
    expect(await svc.getContext({ channelId: 'D0C2YLU8F2A', ts: '5.1', text: '<@UX1> hi' }, ['t'])).toBeNull();
    expect(await svc.getContext({ channelId: CH, ts: '5.1', text: 'hi all' }, ['t'])).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('a threaded DM reads the DM thread', async () => {
    const { fetchImpl, calls } = fakeSlack((method, params) =>
      method === 'conversations.replies' ? { body: { ok: true, messages: [{ ts: '6.1', user: 'USTEVE', text: 'root' }] } } : usersInfo(params),
    );
    const svc = new SlackThreadContextService({ fetchImpl, logger: makeLogger() });
    const ctx = await svc.getContext({ channelId: 'D0C2YLU8F2A', ts: '6.2', threadTs: '6.1' }, ['xoxb-ella']);
    expect(calls[0]).toMatchObject({ method: 'conversations.replies', token: 'xoxb-ella' });
    expect(ctx?.messages.map((m) => m.text)).toEqual(['root']);
  });

  it('no tokens → nothing fetched', async () => {
    const { fetchImpl, calls } = fakeSlack(() => ({ body: {} }));
    const svc = new SlackThreadContextService({ fetchImpl, logger: makeLogger() });
    expect(await svc.getContext({ channelId: CH, ts: TRIGGER, threadTs: ROOT }, [])).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('renderSlackThreadContext', () => {
  it('returns an empty string for no context', () => {
    expect(renderSlackThreadContext(null)).toBe('');
    expect(renderSlackThreadContext({ kind: 'thread', channelId: CH, messages: [], totalBefore: 0 })).toBe('');
  });
});
