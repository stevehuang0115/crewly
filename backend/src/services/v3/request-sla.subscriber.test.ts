/**
 * Tests for RequestSlaSubscriber (INBOUND-1).
 *
 * Covers:
 *   - filter: only inbound-tagged Requests get a respond_to_user WI
 *   - WI creation contract: deterministic id, idempotencyKey, target=orc,
 *     SLA metadata, threadTs/channelId derived from sourceConversationItemId
 *   - V1 idempotency on event replay (TaskPool.addToPool dedup)
 *   - 5min breach: emits request:sla_breached with level=5
 *   - 10min escalation: emits level=10 + invokes Slack DM callback
 *   - timer self-check: terminal WI status silences both breach + escalation
 *   - markResolvedByThread: orc reply auto-resolves the WI to 'done'
 *   - lifecycle: start/stop is idempotent; stop clears all timers
 *   - error isolation: throwing handler logged + isolated
 *
 * @module services/v3/request-sla.subscriber.test
 */

import { EventBusService } from '../event-bus/event-bus.service.js';
import {
  RequestSlaSubscriber,
  REQUEST_SLA_SUBSCRIBED_EVENTS,
  DEFAULT_INBOUND_TAGS,
  extractSlackThreadTs,
  extractSlackChannelId,
  setRequestSlaSubscriber,
  getRequestSlaSubscriber,
  respondToUserWorkItemId,
} from './request-sla.subscriber.js';
import type { EscalationSlackCallback } from './request-sla.subscriber.js';
import type { Request } from '../../types/v2/request.types.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import type { TaskPoolService } from '../task-pool/task-pool.service.js';
import type { RequestService } from './request.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildRequest(overrides: Partial<Request> = {}): Request {
  const now = new Date().toISOString();
  return {
    id: 'req-1',
    sourceConversationItemId: 'slack-C123-1772899923.865659',
    title: 'Help with deploy',
    description: 'A user message',
    status: 'open',
    priority: 'normal',
    requiresConfirmation: false,
    workItemIds: [],
    intentLevel: 'L1',
    intentCategory: 'other',
    tags: ['slack'],
    createdAt: now,
    updatedAt: now,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    ...overrides,
  };
}

/**
 * Stub TaskPoolService — captures addToPool + transitionStatus calls and
 * lets each test set the WI's status for findWorkItem so terminal-status
 * branches can be exercised.
 */
function buildFakeTaskPool(): {
  taskPool: TaskPoolService;
  addCalls: WorkItem[];
  setStatus: (id: string, status: WorkItemStatus) => void;
  transitionCalls: Array<{ id: string; status: WorkItemStatus; actor: string }>;
} {
  const stored = new Map<string, WorkItem>();
  const addCalls: WorkItem[] = [];
  const transitionCalls: Array<{ id: string; status: WorkItemStatus; actor: string }> = [];
  const taskPool = {
    addToPool: jest.fn(async (wi: WorkItem) => {
      // Real addToPool is idempotent; mimic by short-circuiting on duplicate id.
      if (stored.has(wi.id)) return;
      stored.set(wi.id, wi);
      addCalls.push(wi);
    }),
    findWorkItem: jest.fn(async (id: string) => stored.get(id) ?? null),
    transitionStatus: jest.fn(
      async (
        id: string,
        status: WorkItemStatus,
        actor: string,
        mutator?: (wi: WorkItem) => void,
      ) => {
        const wi = stored.get(id);
        if (!wi) return null;
        wi.status = status;
        if (mutator) mutator(wi);
        transitionCalls.push({ id, status, actor });
        return wi;
      },
    ),
  } as unknown as TaskPoolService;

  return {
    taskPool,
    addCalls,
    transitionCalls,
    setStatus: (id, status) => {
      const wi = stored.get(id);
      if (wi) wi.status = status;
    },
  };
}

/**
 * Stub RequestService — only `getById` is touched.
 */
function buildFakeRequestService(initial: Request[] = []): {
  service: RequestService;
  registry: Map<string, Request>;
} {
  const registry = new Map<string, Request>(initial.map((r) => [r.id, r]));
  const service = {
    getById: jest.fn(async (id: string) => registry.get(id) ?? null),
  } as unknown as RequestService;
  return { service, registry };
}

/**
 * Build a fake `request:created` AgentEvent.
 */
function buildEvent(requestId: string, eventId = `evt-${requestId}`) {
  return {
    id: eventId,
    type: 'request:created' as const,
    timestamp: new Date().toISOString(),
    teamId: '',
    teamName: '',
    memberId: '',
    memberName: '',
    sessionName: '',
    previousValue: '',
    newValue: 'open',
    changedField: 'taskStatus' as const,
    requestId,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('extractSlackThreadTs / extractSlackChannelId', () => {
  it('extracts threadTs and channelId from a real-shaped slack id', () => {
    const sid = 'slack-C0AC7NF5N7L-1772899923.865659';
    expect(extractSlackThreadTs(sid)).toBe('1772899923.865659');
    expect(extractSlackChannelId(sid)).toBe('C0AC7NF5N7L');
  });

  it('returns null for non-slack ids', () => {
    expect(extractSlackThreadTs('chatv2-C123-msg-9')).toBeNull();
    expect(extractSlackChannelId('chatv2-C123-msg-9')).toBeNull();
  });

  it('returns null for slack ids without a dotted-decimal ts segment', () => {
    expect(extractSlackThreadTs('slack-C123-not-a-ts')).toBeNull();
  });

  it('returns null for empty / missing input', () => {
    expect(extractSlackThreadTs(undefined)).toBeNull();
    expect(extractSlackChannelId('')).toBeNull();
  });
});

describe('respondToUserWorkItemId', () => {
  // Negative spec (INBOUND-1.f1.f3): pin the helper output format. If the
  // template ever drifts, every caller (including the workitem:queued
  // self-recursion guard) silently misroutes — this assertion fails loudly
  // first, before any behavioural test gets a chance to mask the change.
  it('returns the canonical respond_to_user WorkItem id format', () => {
    expect(respondToUserWorkItemId('foo')).toBe('request:foo:respond_to_user');
    expect(respondToUserWorkItemId('req-99')).toBe('request:req-99:respond_to_user');
  });

  it('preserves the requestId verbatim (no escaping or trimming)', () => {
    expect(respondToUserWorkItemId('with spaces')).toBe('request:with spaces:respond_to_user');
    expect(respondToUserWorkItemId('a:b:c')).toBe('request:a:b:c:respond_to_user');
  });
});

// ---------------------------------------------------------------------------
// Subscriber behaviour
// ---------------------------------------------------------------------------

describe('RequestSlaSubscriber', () => {
  let bus: EventBusService;
  let pool: ReturnType<typeof buildFakeTaskPool>;
  let svc: ReturnType<typeof buildFakeRequestService>;
  let escalateCalls: Parameters<EscalationSlackCallback>[0][];
  let escalate: EscalationSlackCallback;
  let sub: RequestSlaSubscriber;

  beforeEach(() => {
    jest.useFakeTimers();
    bus = new EventBusService();
    pool = buildFakeTaskPool();
    svc = buildFakeRequestService();
    escalateCalls = [];
    escalate = jest.fn(async (args) => {
      escalateCalls.push(args);
    });
    sub = new RequestSlaSubscriber({
      eventBus: bus,
      taskPool: pool.taskPool,
      requestService: svc.service,
      sendEscalationDm: escalate,
      slaMs: 5_000, // tighten for fake-timer ergonomics
      escalationMs: 10_000,
    });
    sub.start();
  });

  afterEach(() => {
    sub.stop();
    bus.cleanup();
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Subscription contract
  // -------------------------------------------------------------------------

  describe('subscription contract', () => {
    it('subscribes to request:created and workitem:queued (INBOUND-1 + INBOUND-1.f1)', () => {
      expect(REQUEST_SLA_SUBSCRIBED_EVENTS).toEqual([
        'request:created',
        'workitem:queued',
      ]);
    });

    it('start() is idempotent — calling twice does not double-subscribe', async () => {
      sub.start();
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();
      // One Request → one WI, even if start() ran twice.
      expect(pool.addCalls).toHaveLength(1);
    });

    it('stop() detaches subscriptions and clears timers', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      sub.stop();
      jest.advanceTimersByTime(60_000);
      // No breach event published — timers cleared on stop().
      expect(pool.transitionCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Inbound tag filter
  // -------------------------------------------------------------------------

  describe('inbound tag filter', () => {
    it('creates a respond_to_user WI for slack-tagged Requests', async () => {
      const r = buildRequest({ tags: ['slack'] });
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();
      expect(pool.addCalls).toHaveLength(1);
      expect(pool.addCalls[0].id).toBe(respondToUserWorkItemId(r.id));
    });

    it('also triggers for chat-v2-tagged Requests (default inbound list)', async () => {
      expect(DEFAULT_INBOUND_TAGS).toContain('chat-v2');
      const r = buildRequest({ tags: ['chat-v2'], sourceConversationItemId: 'chatv2-C-1' });
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();
      expect(pool.addCalls).toHaveLength(1);
    });

    it('skips Requests with no inbound tag', async () => {
      const r = buildRequest({ tags: ['cli'] });
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();
      expect(pool.addCalls).toHaveLength(0);
    });

    it('skips events whose Request cannot be resolved (race / deletion)', async () => {
      bus.publish(buildEvent('req-missing'));
      await sub.flushPending();
      expect(pool.addCalls).toHaveLength(0);
    });

    it('skips events with no requestId field', async () => {
      // Synthesised event with explicit requestId removed.
      bus.publish({
        ...buildEvent('req-X'),
        requestId: undefined,
      } as unknown as Parameters<EventBusService['publish']>[0]);
      await sub.flushPending();
      expect(pool.addCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // WI shape
  // -------------------------------------------------------------------------

  describe('respond_to_user WorkItem shape', () => {
    it('has deterministic id, idempotencyKey, orchestrator target, and SLA metadata', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      const wi = pool.addCalls[0];
      expect(wi.id).toBe(respondToUserWorkItemId(r.id));
      expect(wi.metadata?.idempotencyKey).toBe(wi.id);
      expect(wi.type).toBe('review');
      expect(wi.owner).toBe('orchestrator');
      expect(wi.target).toBe('crewly-orc');
      expect(wi.requestId).toBe(r.id);
      expect(wi.metadata?.slaSource).toBe('inbound-1');
      expect(wi.metadata?.slaBreachLevel).toBe(0);
      expect(wi.metadata?.slackThreadTs).toBe('1772899923.865659');
      expect(wi.metadata?.slackChannelId).toBe('C123');
      expect(typeof wi.metadata?.slaDeadline).toBe('string');
    });

    it('ignores a redelivered request:created event (V1 idempotency via addToPool)', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      // Replay with a different envelope id — same requestId.
      // sessionName is empty so the bus-level (type,session) debounce does
      // suppress the second; we use a non-empty session to bypass.
      bus.publish({
        ...buildEvent(r.id, 'evt-replay'),
        sessionName: 'replay-session',
      } as unknown as Parameters<EventBusService['publish']>[0]);
      await sub.flushPending();
      // addToPool has dedup on id — only 1 stored.
      expect(pool.addCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // SLA timers — breach + escalation
  // -------------------------------------------------------------------------

  describe('SLA timers', () => {
    it('emits request:sla_breached at 5min when WI is still queued', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);

      const breachListener = jest.fn();
      bus.onInProcess('request:sla_breached', breachListener);

      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      jest.advanceTimersByTime(5_000);
      // Allow the timer's microtasks to settle.
      await Promise.resolve();
      await Promise.resolve();

      expect(breachListener).toHaveBeenCalledTimes(1);
      const breachEvent = breachListener.mock.calls[0][0];
      expect(breachEvent.type).toBe('request:sla_breached');
      expect(breachEvent.requestId).toBe(r.id);
      expect(breachEvent.newValue).toBe('breached_5m');
      expect(breachEvent.workItemId).toBe(respondToUserWorkItemId(r.id));
    });

    it('emits a second breach (level=10) and invokes the Slack DM callback at 10min', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);

      const breachListener = jest.fn();
      bus.onInProcess('request:sla_breached', breachListener);

      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();

      jest.advanceTimersByTime(5_000); // total 10_000
      // The escalation handler awaits findWorkItem + sendEscalationDm.
      // Drain microtasks until the dispatch settles.
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }

      // 2 breach events: one at 5m, one at 10m (level 10 re-emit).
      expect(breachListener).toHaveBeenCalledTimes(2);
      expect(breachListener.mock.calls[1][0].newValue).toBe('breached_10m');

      // Slack DM callback fired with the right context.
      expect(escalateCalls).toHaveLength(1);
      expect(escalateCalls[0].channelId).toBe('C123');
      expect(escalateCalls[0].threadTs).toBe('1772899923.865659');
      expect(escalateCalls[0].request.id).toBe(r.id);
    });

    it('does NOT emit breach when the WI is already in a terminal status by 5min', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);

      const breachListener = jest.fn();
      bus.onInProcess('request:sla_breached', breachListener);

      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      // Mark the WI done before the timer fires.
      pool.setStatus(respondToUserWorkItemId(r.id), 'done');

      jest.advanceTimersByTime(5_000);
      for (let i = 0; i < 3; i += 1) await Promise.resolve();

      expect(breachListener).not.toHaveBeenCalled();
    });

    it('escalation logs a warning when no Slack DM hook is wired (no crash)', async () => {
      sub.stop();
      sub = new RequestSlaSubscriber({
        eventBus: bus,
        taskPool: pool.taskPool,
        requestService: svc.service,
        // sendEscalationDm intentionally omitted
        slaMs: 5_000,
        escalationMs: 10_000,
      });
      sub.start();

      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      jest.advanceTimersByTime(10_000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      // No callback wired → no crash, escalateCalls empty.
      expect(escalateCalls).toHaveLength(0);
    });

    // ---------------------------------------------------------------------
    // Arch N3 on PR #357 — orphan respond_to_user WI close on escalation
    // ---------------------------------------------------------------------
    it('transitions the orphan respond_to_user WI to "failed" with slaResolvedReason="escalation_timeout" after a 10min escalation (DM success path)', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      jest.advanceTimersByTime(10_000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      // The respond_to_user WI must be transitioned to 'failed' after the DM.
      const wiId = respondToUserWorkItemId(r.id);
      const failTransitions = pool.transitionCalls.filter((c) => c.id === wiId);
      expect(failTransitions).toHaveLength(1);
      expect(failTransitions[0].status).toBe('failed');
      expect(failTransitions[0].actor).toBe('system');

      // Mutator must stamp slaResolvedReason for ops visibility.
      const wi = await pool.taskPool.findWorkItem(wiId);
      expect(wi?.status).toBe('failed');
      expect(wi?.metadata?.slaResolvedReason).toBe('escalation_timeout');
      expect(typeof wi?.metadata?.slaResolvedAt).toBe('string');
    });

    it('still transitions the orphan WI to "failed" when no Slack DM hook is wired', async () => {
      sub.stop();
      sub = new RequestSlaSubscriber({
        eventBus: bus,
        taskPool: pool.taskPool,
        requestService: svc.service,
        // sendEscalationDm intentionally omitted — exercises the no-hook return path.
        slaMs: 5_000,
        escalationMs: 10_000,
      });
      sub.start();

      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      jest.advanceTimersByTime(10_000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      const wiId = respondToUserWorkItemId(r.id);
      const failTransitions = pool.transitionCalls.filter((c) => c.id === wiId);
      expect(failTransitions).toHaveLength(1);
      expect(failTransitions[0].status).toBe('failed');
    });

    it('still transitions the orphan WI to "failed" when the Slack DM callback throws', async () => {
      sub.stop();
      const throwingEscalate: EscalationSlackCallback = jest.fn(async () => {
        throw new Error('slack 503');
      });
      sub = new RequestSlaSubscriber({
        eventBus: bus,
        taskPool: pool.taskPool,
        requestService: svc.service,
        sendEscalationDm: throwingEscalate,
        slaMs: 5_000,
        escalationMs: 10_000,
      });
      sub.start();

      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      jest.advanceTimersByTime(10_000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      const wiId = respondToUserWorkItemId(r.id);
      const failTransitions = pool.transitionCalls.filter((c) => c.id === wiId);
      expect(failTransitions).toHaveLength(1);
      expect(failTransitions[0].status).toBe('failed');
    });

    it('does NOT transition the WI when it is already terminal at escalation time', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      // Out-of-band cleanup: WI manually closed before the 10min mark.
      const wiId = respondToUserWorkItemId(r.id);
      pool.setStatus(wiId, 'cancelled');

      jest.advanceTimersByTime(10_000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      // No transition to 'failed' because the WI is already terminal.
      const failTransitions = pool.transitionCalls.filter(
        (c) => c.id === wiId && c.status === 'failed',
      );
      expect(failTransitions).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Auto-close on orc reply
  // -------------------------------------------------------------------------

  describe('markResolvedByThread', () => {
    it('transitions the matching WI to done and clears the timers', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      expect(sub.trackedCount).toBe(1);

      await sub.markResolvedByThread('1772899923.865659');

      expect(pool.transitionCalls).toEqual([
        { id: respondToUserWorkItemId(r.id), status: 'done', actor: 'system' },
      ]);
      expect(sub.trackedCount).toBe(0);

      // Subsequent timer firings are silent.
      const breachListener = jest.fn();
      bus.onInProcess('request:sla_breached', breachListener);
      jest.advanceTimersByTime(60_000);
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
      expect(breachListener).not.toHaveBeenCalled();
    });

    it('is a no-op for an unknown threadTs', async () => {
      await sub.markResolvedByThread('9999999999.000000');
      expect(pool.transitionCalls).toHaveLength(0);
    });

    it('is a no-op for an empty threadTs', async () => {
      await sub.markResolvedByThread('');
      expect(pool.transitionCalls).toHaveLength(0);
    });

    it('is a no-op when the WI is already terminal', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      // Externally transition first.
      pool.setStatus(respondToUserWorkItemId(r.id), 'verified');

      await sub.markResolvedByThread('1772899923.865659');
      // No transition recorded — already terminal.
      expect(pool.transitionCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // INBOUND-1.f1: Auto-close path b — workitem:queued decompose hook
  // -------------------------------------------------------------------------

  describe('handleWorkItemQueued — auto-close path b (INBOUND-1.f1)', () => {
    /**
     * Helper: build a `workitem:queued` AgentEvent (for direct bus.publish).
     * Mirrors the publisher contract in TaskPoolService.publishWorkItemQueued.
     */
    function buildQueuedEvent(args: {
      workItemId: string;
      requestId?: string;
      missionId?: string;
      sessionName?: string;
    }) {
      return {
        id: `workitem:queued:${args.workItemId}`,
        type: 'workitem:queued' as const,
        timestamp: new Date().toISOString(),
        teamId: '',
        teamName: '',
        memberId: '',
        memberName: '',
        sessionName: args.sessionName ?? '',
        previousValue: '',
        newValue: 'queued',
        changedField: 'taskStatus' as const,
        workItemId: args.workItemId,
        requestId: args.requestId,
        missionId: args.missionId,
      };
    }

    it('resolves the tracked respond_to_user WI when the orc decomposes the Request into a delegate WI', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);

      // Seed: respond_to_user WI tracked for this Request.
      bus.publish(buildEvent(r.id));
      await sub.flushPending();
      expect(sub.trackedCount).toBe(1);

      // Orc decomposes the Request → addToPool fires workitem:queued for
      // a delegate WI. The id is NOT the respond_to_user shape, so the
      // self-recursion guard does not match.
      bus.publish(
        buildQueuedEvent({
          workItemId: 'wi-delegate-1',
          requestId: r.id,
          sessionName: 'pool-publisher', // bypass the bus's per-(type,session) debounce
        }) as unknown as Parameters<EventBusService['publish']>[0],
      );
      await sub.flushPending();

      // The tracked WI was transitioned to 'done' with reason 'workitem_decompose'.
      expect(pool.transitionCalls).toEqual([
        { id: respondToUserWorkItemId(r.id), status: 'done', actor: 'system' },
      ]);
      expect(sub.trackedCount).toBe(0);

      // Subsequent timers are silent — the chain is closed.
      const breachListener = jest.fn();
      bus.onInProcess('request:sla_breached', breachListener);
      jest.advanceTimersByTime(60_000);
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
      expect(breachListener).not.toHaveBeenCalled();
    });

    it('writes slaResolvedReason="workitem_decompose" into the WI metadata', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      bus.publish(
        buildQueuedEvent({
          workItemId: 'wi-delegate-1',
          requestId: r.id,
          sessionName: 'pool-publisher',
        }) as unknown as Parameters<EventBusService['publish']>[0],
      );
      await sub.flushPending();

      // The fake taskPool's transitionStatus runs the mutator — we can read
      // the resulting metadata via findWorkItem.
      const wi = await pool.taskPool.findWorkItem(respondToUserWorkItemId(r.id));
      expect(wi?.metadata?.slaResolvedReason).toBe('workitem_decompose');
      expect(typeof wi?.metadata?.slaResolvedAt).toBe('string');
    });

    it('id-shape self-recursion guard: the respond_to_user WI\'s own enqueue does NOT trigger its own resolution', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);

      // The handleRequestCreated path itself fires addToPool — in production
      // the publisher would emit workitem:queued for the respond_to_user WI.
      // We seed the tracker AND simulate the self-emit.
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      // Self-emit — same id as the respond_to_user WI.
      bus.publish(
        buildQueuedEvent({
          workItemId: respondToUserWorkItemId(r.id),
          requestId: r.id,
          sessionName: 'pool-publisher',
        }) as unknown as Parameters<EventBusService['publish']>[0],
      );
      await sub.flushPending();

      // No transition — the guard short-circuits.
      expect(pool.transitionCalls).toHaveLength(0);
      // Still tracked.
      expect(sub.trackedCount).toBe(1);
    });

    it('no-op when workitem:queued event is missing requestId (orphan WI)', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      bus.publish(
        buildQueuedEvent({
          workItemId: 'wi-orphan',
          // requestId intentionally omitted
          sessionName: 'pool-publisher',
        }) as unknown as Parameters<EventBusService['publish']>[0],
      );
      await sub.flushPending();

      expect(pool.transitionCalls).toHaveLength(0);
      expect(sub.trackedCount).toBe(1);
    });

    it('no-op when workitem:queued references an untracked Request (already resolved or non-inbound)', async () => {
      // No request:created seeded — the requestId is unknown to the subscriber.
      bus.publish(
        buildQueuedEvent({
          workItemId: 'wi-strange-1',
          requestId: 'req-unknown',
          sessionName: 'pool-publisher',
        }) as unknown as Parameters<EventBusService['publish']>[0],
      );
      await sub.flushPending();

      expect(pool.transitionCalls).toHaveLength(0);
    });

    it('no regression on path a (markResolvedByThread still works after path b is wired)', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      await sub.markResolvedByThread('1772899923.865659');

      expect(pool.transitionCalls).toEqual([
        { id: respondToUserWorkItemId(r.id), status: 'done', actor: 'system' },
      ]);
      expect(sub.trackedCount).toBe(0);

      // A subsequent decompose event finds nothing tracked → no-op.
      bus.publish(
        buildQueuedEvent({
          workItemId: 'wi-late-1',
          requestId: r.id,
          sessionName: 'pool-publisher',
        }) as unknown as Parameters<EventBusService['publish']>[0],
      );
      await sub.flushPending();
      // Still only 1 transition (the path-a one) — path b is a clean no-op.
      expect(pool.transitionCalls).toHaveLength(1);
    });

    it('no regression on path c (timer self-check still silences breach when WI is terminal)', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      // Externally mark the WI done (e.g. via taskPool.completeItem).
      pool.setStatus(respondToUserWorkItemId(r.id), 'done');

      const breachListener = jest.fn();
      bus.onInProcess('request:sla_breached', breachListener);

      jest.advanceTimersByTime(5_000);
      for (let i = 0; i < 3; i += 1) await Promise.resolve();

      // path c: terminal WI silences breach via the timer self-check.
      expect(breachListener).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Module-level singleton accessor (INBOUND-1.4 hook)
  // -------------------------------------------------------------------------

  describe('module-level singleton accessor', () => {
    afterEach(() => {
      // Always reset so the next describe block starts with a clean slate.
      setRequestSlaSubscriber(null);
    });

    it('getRequestSlaSubscriber returns null until setRequestSlaSubscriber wires one', () => {
      setRequestSlaSubscriber(null);
      expect(getRequestSlaSubscriber()).toBeNull();
    });

    it('setRequestSlaSubscriber publishes the live instance to slack-bridge consumers', () => {
      setRequestSlaSubscriber(sub);
      expect(getRequestSlaSubscriber()).toBe(sub);
    });

    it('setRequestSlaSubscriber(null) clears the wired instance', () => {
      setRequestSlaSubscriber(sub);
      setRequestSlaSubscriber(null);
      expect(getRequestSlaSubscriber()).toBeNull();
    });
  });
});
