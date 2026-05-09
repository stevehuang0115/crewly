/**
 * Tests for RequestStatusUpdateSubscriber.
 *
 * @module services/v3/request-status-update.subscriber.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  RequestStatusUpdateSubscriber,
  parseSlackThreadContext,
  type RequestServiceLike,
  type TaskPoolServiceLike,
  type SlackPoster,
} from './request-status-update.subscriber.js';
import type { EventBusService, InProcessUnsubscribe } from '../event-bus/event-bus.service.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import type { Request } from '../../types/v2/request.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { ComponentLogger } from '../core/logger.service.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface BusListener {
  eventType: EventType;
  handler: (e: AgentEvent) => void;
}

function makeFakeBus() {
  const listeners: BusListener[] = [];
  const bus = {
    onInProcess: (eventType: EventType, handler: (e: AgentEvent) => void): InProcessUnsubscribe => {
      const entry: BusListener = { eventType, handler };
      listeners.push(entry);
      return () => {
        const idx = listeners.indexOf(entry);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    publish: (event: AgentEvent) => {
      const matching = listeners.filter((l) => l.eventType === event.type);
      for (const l of matching) {
        try {
          l.handler(event);
        } catch {
          // ignore — the subscriber's safeDispatch handles its own errors
        }
      }
    },
  } as unknown as EventBusService;
  return { bus, listeners };
}

function makeRequest(over: Partial<Request> = {}): Request {
  const now = new Date().toISOString();
  return {
    id: over.id ?? 'req-x',
    sourceConversationItemId:
      over.sourceConversationItemId ?? 'slack-CTEST123-1707000000.123456',
    title: over.title ?? '[Plan] test request',
    description: over.description ?? 'test',
    status: over.status ?? 'running',
    priority: over.priority ?? 'normal',
    requiresConfirmation: over.requiresConfirmation ?? false,
    workItemIds: over.workItemIds ?? [],
    intentLevel: (over.intentLevel ?? 'L2'),
    intentCategory: (over.intentCategory ?? 'planning'),
    tags: over.tags ?? ['slack'],
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
  };
}

function makeWI(over: Partial<WorkItem> = {}): WorkItem {
  const now = new Date().toISOString();
  return {
    id: over.id ?? 'wi-1',
    type: over.type ?? 'delegate',
    owner: over.owner ?? 'orchestrator',
    target: over.target ?? 'crewly-product-leo-21a5477e',
    title: over.title ?? 'Plan: test',
    description: over.description ?? '',
    status: over.status ?? 'running',
    createdAt: over.createdAt ?? now,
    retryCount: 0,
    maxRetries: 3,
    requestId: over.requestId ?? 'req-x',
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
  } as WorkItem;
}

const SILENT_LOGGER: ComponentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as ComponentLogger;

interface PostCall {
  channelId: string;
  text: string;
  threadTs: string;
}

function makeSubscriber(opts: {
  request?: Request;
  pool?: WorkItem[];
  postShouldThrow?: boolean;
  heartbeatMinutes?: number;
} = {}) {
  const { bus } = makeFakeBus();
  const requestStore = new Map<string, Request>();
  if (opts.request) requestStore.set(opts.request.id, opts.request);
  const pool: WorkItem[] = opts.pool ?? [];

  const requestService: RequestServiceLike = {
    getById: async (id: string) => requestStore.get(id) ?? null,
    listAll: async () => Array.from(requestStore.values()),
  };
  const taskPool: TaskPoolServiceLike = {
    findWorkItem: async (id: string) => pool.find((w) => w.id === id),
    getAllItems: async () => pool,
  };

  const posts: PostCall[] = [];
  const slackPoster: SlackPoster = jest.fn(async (params: PostCall) => {
    if (opts.postShouldThrow) throw new Error('slack down');
    posts.push(params);
  }) as unknown as SlackPoster;

  // No-op scheduler so heartbeat doesn't run automatically; tests call
  // runHeartbeat() directly when they want it.
  const scheduler = {
    setInterval: jest.fn(() => 'h-handle'),
    clearInterval: jest.fn(),
  };

  const sub = new RequestStatusUpdateSubscriber({
    eventBus: bus,
    requestService,
    taskPool,
    slackPoster,
    heartbeatMinutes: opts.heartbeatMinutes ?? 30,
    logger: SILENT_LOGGER,
    scheduler,
  });
  return { sub, bus, posts, scheduler, requestStore, pool };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseSlackThreadContext', () => {
  it('parses a dot-separated Slack thread id', () => {
    expect(parseSlackThreadContext('slack-D0AC7NF5N7L-1778268134.953089')).toEqual({
      channelId: 'D0AC7NF5N7L',
      threadTs: '1778268134.953089',
    });
  });

  it('parses a hyphen-separated thread id (the underscore-friendly variant)', () => {
    expect(parseSlackThreadContext('slack-CTEST123-1707000000-123456')).toEqual({
      channelId: 'CTEST123',
      threadTs: '1707000000.123456',
    });
  });

  it('returns null for non-slack ids', () => {
    expect(parseSlackThreadContext('chatv2-foo')).toBeNull();
    expect(parseSlackThreadContext('conv-abc')).toBeNull();
    expect(parseSlackThreadContext(undefined)).toBeNull();
    expect(parseSlackThreadContext('')).toBeNull();
  });
});

describe('RequestStatusUpdateSubscriber — event handling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-09T01:00:00.000Z'));
  });

  it('posts to the originating Slack thread on task:done_by_worker', async () => {
    const wi = makeWI({ id: 'wi-plan', requestId: 'req-x', target: 'crewly-product-leo-21a5477e' });
    const r = makeRequest({ id: 'req-x', workItemIds: ['wi-plan'] });
    const { sub, bus, posts } = makeSubscriber({ request: r, pool: [wi] });

    sub.start();
    bus.publish({
      id: 'task:done_by_worker:wi-plan',
      type: 'task:done_by_worker',
      timestamp: new Date().toISOString(),
      teamId: '',
      teamName: '',
      memberId: '',
      memberName: '',
      sessionName: '',
      previousValue: '',
      newValue: 'done_by_worker',
      changedField: 'taskStatus',
      workItemId: 'wi-plan',
    });
    await sub.flushPending();

    expect(posts).toHaveLength(1);
    expect(posts[0].channelId).toBe('CTEST123');
    expect(posts[0].threadTs).toBe('1707000000.123456');
    // Plain-language: humanised agent name, not the raw sessionName.
    expect(posts[0].text).toContain('Leo');
    expect(posts[0].text).not.toContain('crewly-product-leo-21a5477e');
    sub.stop();
  });

  it('skips when the WI has no requestId', async () => {
    const wi = makeWI({ id: 'wi-orphan' });
    delete (wi as Partial<WorkItem>).requestId;
    const { sub, bus, posts } = makeSubscriber({ pool: [wi] });

    sub.start();
    bus.publish({
      id: 'task:done_by_worker:wi-orphan',
      type: 'task:done_by_worker',
      timestamp: new Date().toISOString(),
      teamId: '', teamName: '', memberId: '', memberName: '',
      sessionName: '', previousValue: '', newValue: 'done_by_worker',
      changedField: 'taskStatus', workItemId: 'wi-orphan',
    });
    await sub.flushPending();

    expect(posts).toHaveLength(0);
    sub.stop();
  });

  it('skips when the Request was not Slack-originated (e.g. chat-v2)', async () => {
    const wi = makeWI({ id: 'wi-cv2', requestId: 'req-cv2' });
    const r = makeRequest({ id: 'req-cv2', sourceConversationItemId: 'chatv2-channel-1-msg-1' });
    const { sub, bus, posts } = makeSubscriber({ request: r, pool: [wi] });

    sub.start();
    bus.publish({
      id: 'task:done_by_worker:wi-cv2',
      type: 'task:done_by_worker',
      timestamp: new Date().toISOString(),
      teamId: '', teamName: '', memberId: '', memberName: '',
      sessionName: '', previousValue: '', newValue: 'done_by_worker',
      changedField: 'taskStatus', workItemId: 'wi-cv2',
    });
    await sub.flushPending();

    expect(posts).toHaveLength(0);
    sub.stop();
  });

  it('coalesces a second event landing inside MIN_INTER_POST_MS', async () => {
    const wi = makeWI({ id: 'wi-1', requestId: 'req-x' });
    const r = makeRequest({ id: 'req-x' });
    const { sub, bus, posts } = makeSubscriber({ request: r, pool: [wi] });

    sub.start();
    const fire = (eventType: EventType) =>
      bus.publish({
        id: `${eventType}:wi-1`,
        type: eventType,
        timestamp: new Date().toISOString(),
        teamId: '', teamName: '', memberId: '', memberName: '',
        sessionName: '', previousValue: '', newValue: '',
        changedField: 'taskStatus', workItemId: 'wi-1',
      });

    fire('task:done_by_worker');
    await sub.flushPending();
    expect(posts).toHaveLength(1);

    // 2 minutes later — inside the 5-min coalesce window.
    jest.setSystemTime(new Date('2026-05-09T01:02:00.000Z'));
    fire('task:verified');
    await sub.flushPending();
    expect(posts).toHaveLength(1); // still 1 — coalesced

    // 6 minutes after the first post — outside the window.
    jest.setSystemTime(new Date('2026-05-09T01:06:30.000Z'));
    fire('task:rejected');
    await sub.flushPending();
    expect(posts).toHaveLength(2);
    sub.stop();
  });

  it('uses different message templates per event type', async () => {
    const wi = makeWI({ id: 'wi-1', requestId: 'req-x' });
    const r = makeRequest({ id: 'req-x' });
    const { sub, bus, posts } = makeSubscriber({ request: r, pool: [wi] });

    sub.start();
    const fire = (eventType: EventType) =>
      bus.publish({
        id: `${eventType}:wi-1`,
        type: eventType,
        timestamp: new Date().toISOString(),
        teamId: '', teamName: '', memberId: '', memberName: '',
        sessionName: '', previousValue: '', newValue: '',
        changedField: 'taskStatus', workItemId: 'wi-1',
      });

    fire('task:blocked');
    await sub.flushPending();
    expect(posts[posts.length - 1].text).toMatch(/卡住|⛔/);

    // Move past coalesce window.
    jest.setSystemTime(new Date('2026-05-09T01:10:00.000Z'));
    fire('task:failed');
    await sub.flushPending();
    expect(posts[posts.length - 1].text).toMatch(/失败|❌/);
    sub.stop();
  });

  it('does not crash when the Slack post throws', async () => {
    const wi = makeWI({ id: 'wi-1', requestId: 'req-x' });
    const r = makeRequest({ id: 'req-x' });
    const { sub, bus } = makeSubscriber({
      request: r,
      pool: [wi],
      postShouldThrow: true,
    });

    sub.start();
    bus.publish({
      id: 'task:done_by_worker:wi-1',
      type: 'task:done_by_worker',
      timestamp: new Date().toISOString(),
      teamId: '', teamName: '', memberId: '', memberName: '',
      sessionName: '', previousValue: '', newValue: '',
      changedField: 'taskStatus', workItemId: 'wi-1',
    });

    await expect(sub.flushPending()).resolves.toBeUndefined();
    sub.stop();
  });
});

describe('RequestStatusUpdateSubscriber — heartbeat sweep', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-09T01:00:00.000Z'));
  });

  it('emits a heartbeat for in-flight Slack Requests with no recent post', async () => {
    const wis = [
      makeWI({ id: 'wi-plan', requestId: 'req-x', status: 'done', target: 'crewly-product-leo' }),
      makeWI({ id: 'wi-exec', requestId: 'req-x', status: 'running', target: 'crewly-product-max' }),
      makeWI({ id: 'wi-rev', requestId: 'req-x', status: 'queued', target: '' }),
    ];
    const r = makeRequest({ id: 'req-x', status: 'running' });
    const { sub, posts } = makeSubscriber({ request: r, pool: wis });

    const posted = await sub.runHeartbeat();
    expect(posted).toBe(1);
    expect(posts[0].text).toContain('1/3');   // 1 done out of 3
    expect(posts[0].text).toContain('1');     // running
  });

  it('skips Requests in terminal status', async () => {
    const r = makeRequest({ id: 'req-done', status: 'done' });
    const { sub, posts } = makeSubscriber({ request: r, pool: [makeWI({ requestId: 'req-done' })] });
    const posted = await sub.runHeartbeat();
    expect(posted).toBe(0);
    expect(posts).toHaveLength(0);
  });

  it('skips Requests with no Slack source', async () => {
    const r = makeRequest({ id: 'req-cv2', sourceConversationItemId: 'chatv2-1' });
    const { sub, posts } = makeSubscriber({ request: r, pool: [makeWI({ requestId: 'req-cv2' })] });
    const posted = await sub.runHeartbeat();
    expect(posted).toBe(0);
    expect(posts).toHaveLength(0);
  });

  it('skips when an event-driven post landed inside the heartbeat window', async () => {
    const wi = makeWI({ id: 'wi-1', requestId: 'req-x' });
    const r = makeRequest({ id: 'req-x' });
    const { sub, bus, posts } = makeSubscriber({ request: r, pool: [wi], heartbeatMinutes: 30 });

    sub.start();
    bus.publish({
      id: 'task:done_by_worker:wi-1',
      type: 'task:done_by_worker',
      timestamp: new Date().toISOString(),
      teamId: '', teamName: '', memberId: '', memberName: '',
      sessionName: '', previousValue: '', newValue: '',
      changedField: 'taskStatus', workItemId: 'wi-1',
    });
    await sub.flushPending();
    expect(posts).toHaveLength(1);

    // 10 minutes later — well inside the 30-min heartbeat window.
    jest.setSystemTime(new Date('2026-05-09T01:10:00.000Z'));
    const posted = await sub.runHeartbeat();
    expect(posted).toBe(0); // event-driven post counted; heartbeat skips
    expect(posts).toHaveLength(1);
    sub.stop();
  });

  it('suppresses identical-content heartbeats (state-fingerprint dedupe regression gate)', async () => {
    // 2026-05-09 dogfood: a Slack thread received 7+ identical "still 3
    // blocked" messages over the day because WI state genuinely hadn't
    // moved (Plan WI was wedged blocked → Execute + Review depend-blocked)
    // but the heartbeat cadence faithfully kept firing. The dedupe must
    // suppress repeat heartbeats while state is unchanged AND emit a
    // fresh heartbeat as soon as state moves.
    const wi1 = makeWI({ id: 'wi-1', requestId: 'req-stuck', status: 'blocked', target: '' });
    const wi2 = makeWI({ id: 'wi-2', requestId: 'req-stuck', status: 'blocked', target: '' });
    const wi3 = makeWI({ id: 'wi-3', requestId: 'req-stuck', status: 'blocked', target: '' });
    const r = makeRequest({ id: 'req-stuck', status: 'running' });

    const pool: WorkItem[] = [wi1, wi2, wi3];
    const { sub, posts } = makeSubscriber({ request: r, pool, heartbeatMinutes: 30 });

    // First sweep — fingerprint not seen before, post.
    let posted = await sub.runHeartbeat();
    expect(posted).toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('卡住 3');

    // Hour later, no state change — fingerprint matches, suppress.
    jest.setSystemTime(new Date('2026-05-09T02:00:00.000Z'));
    posted = await sub.runHeartbeat();
    expect(posted).toBe(0);
    expect(posts).toHaveLength(1);

    // Another hour, still no change — still suppress.
    jest.setSystemTime(new Date('2026-05-09T03:00:00.000Z'));
    posted = await sub.runHeartbeat();
    expect(posted).toBe(0);
    expect(posts).toHaveLength(1);

    // State changes (one WI unblocks → running). Fresh fingerprint, post.
    pool[0].status = 'running';
    jest.setSystemTime(new Date('2026-05-09T04:00:00.000Z'));
    posted = await sub.runHeartbeat();
    expect(posted).toBe(1);
    expect(posts).toHaveLength(2);
    expect(posts[1].text).toContain('进行中 1');

    // Same state again, suppress.
    jest.setSystemTime(new Date('2026-05-09T05:00:00.000Z'));
    posted = await sub.runHeartbeat();
    expect(posted).toBe(0);
    expect(posts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// computeStateFingerprint
// ---------------------------------------------------------------------------

describe('computeStateFingerprint', () => {
  it('produces identical fingerprint when only WI ids change but counts match', () => {
    // Imagine a re-decompose that swaps WI uuids but produces the same
    // 1 done / 0 running / 0 queued / 3 blocked / 0 failed shape. We
    // do NOT want this to look like progress — content fingerprint is
    // counts only.
    const { computeStateFingerprint } = require('./request-status-update.subscriber.js');
    const a = [
      makeWI({ id: 'a-1', status: 'done' }),
      makeWI({ id: 'a-2', status: 'blocked' }),
      makeWI({ id: 'a-3', status: 'blocked' }),
      makeWI({ id: 'a-4', status: 'blocked' }),
    ];
    const b = [
      makeWI({ id: 'b-X', status: 'done' }),
      makeWI({ id: 'b-Y', status: 'blocked' }),
      makeWI({ id: 'b-Z', status: 'blocked' }),
      makeWI({ id: 'b-Q', status: 'blocked' }),
    ];
    expect(computeStateFingerprint(a)).toBe(computeStateFingerprint(b));
  });

  it('produces different fingerprint when a single WI moves status', () => {
    const { computeStateFingerprint } = require('./request-status-update.subscriber.js');
    const before = [makeWI({ status: 'blocked' }), makeWI({ status: 'blocked' })];
    const after = [makeWI({ status: 'blocked' }), makeWI({ status: 'running' })];
    expect(computeStateFingerprint(before)).not.toBe(computeStateFingerprint(after));
  });

  it('treats done/verified/done_by_worker as the same "done" bucket', () => {
    const { computeStateFingerprint } = require('./request-status-update.subscriber.js');
    const a = [makeWI({ status: 'done' }), makeWI({ status: 'done' })];
    const b = [makeWI({ status: 'verified' }), makeWI({ status: 'done_by_worker' })];
    expect(computeStateFingerprint(a)).toBe(computeStateFingerprint(b));
  });
});
