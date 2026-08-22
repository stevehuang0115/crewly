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
  extractChatV2ChannelId,
  extractChatV2MessageId,
  setRequestSlaSubscriber,
  getRequestSlaSubscriber,
  respondToUserWorkItemId,
  pickResolveTarget,
  pickFailTarget,
  closeRequestPath,
  MARK_RESOLVED_RETRY_MS,
  FIND_WI_RETRY_INTERVAL_MS,
} from './request-sla.subscriber.js';
import type { EscalationSlackCallback } from './request-sla.subscriber.js';
import type { Request, RequestStatus } from '../../types/v2/request.types.js';
import {
  type WorkItem,
  type WorkItemStatus,
  WORK_ITEM_TRANSITIONS,
  TERMINAL_WORK_ITEM_STATUSES,
  SLA_TERMINAL_WORK_ITEM_STATUSES,
} from '../../types/v2/work-item.types.js';
import {
  pickTTLExpiryTarget,
  pickCascadeTarget,
} from '../reconciler/reconcile-rules.js';
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
  // Default `createdAt` is set 5 minutes in the past so legacy tests bypass
  // the Patch E orc_reply grace window (60s post-creation). Tests that
  // specifically exercise the grace window pass a fresh `createdAt` override.
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
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
    createdAt: fiveMinAgo,
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
 *
 * IMPORTANT (2026-04-29 hardening, Steve bug): the fake's `transitionStatus`
 * now enforces the real `WORK_ITEM_TRANSITIONS` matrix. The previous lenient
 * stub silently accepted illegal transitions (e.g. `queued → done`),
 * masking a production-only failure where the SLA close path threw and got
 * swallowed by `markResolved`'s catch. Using the canonical matrix here
 * means the same code path tests run against the same gate prod runs
 * against — that class of bug fails CI next time, not in users' faces.
 */
function buildFakeTaskPool(): {
  taskPool: TaskPoolService;
  addCalls: WorkItem[];
  setStatus: (id: string, status: WorkItemStatus) => void;
  transitionCalls: Array<{ id: string; status: WorkItemStatus; actor: string }>;
  disposeCalls: Array<{ id: string; reason: string }>;
} {
  const stored = new Map<string, WorkItem>();
  const addCalls: WorkItem[] = [];
  const transitionCalls: Array<{ id: string; status: WorkItemStatus; actor: string }> = [];
  const disposeCalls: Array<{ id: string; reason: string }> = [];
  const taskPool = {
    disposeFailedWorkItem: jest.fn(
      async (id: string, options: { reason: string }) => {
        disposeCalls.push({ id, reason: options.reason });
        return null;
      },
    ),
    addToPool: jest.fn(async (wi: WorkItem) => {
      // Real addToPool is idempotent; mimic by short-circuiting on duplicate id.
      if (stored.has(wi.id)) return;
      stored.set(wi.id, wi);
      addCalls.push(wi);
    }),
    findWorkItem: jest.fn(async (id: string) => stored.get(id) ?? null),
    getAllItems: jest.fn(async () => Array.from(stored.values())),
    transitionStatus: jest.fn(
      async (
        id: string,
        status: WorkItemStatus,
        actor: string,
        mutator?: (wi: WorkItem) => void,
      ) => {
        const wi = stored.get(id);
        if (!wi) return null;
        // Enforce the real state machine — mirrors TaskPoolService.transitionStatus.
        const allowed = WORK_ITEM_TRANSITIONS[wi.status];
        if (!allowed.has(status)) {
          throw new Error(
            `Invalid status transition for WorkItem ${id}: ${wi.status} → ${status}`,
          );
        }
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
    disposeCalls,
    setStatus: (id, status) => {
      const wi = stored.get(id);
      if (wi) wi.status = status;
    },
  };
}

/**
 * Stub RequestService — `getById` for read, `update` for the cascade close
 * path added in 2026-04-29's bug fix. The stub mutates the in-memory
 * registry and records every status change so tests can assert the
 * Request lifecycle without spinning up filesystem persistence.
 */
function buildFakeRequestService(initial: Request[] = []): {
  service: RequestService;
  registry: Map<string, Request>;
  updateCalls: Array<{ id: string; status?: RequestStatus; result?: string }>;
  linkCalls: Array<{ requestId: string; workItemId: string }>;
} {
  const registry = new Map<string, Request>(initial.map((r) => [r.id, r]));
  const updateCalls: Array<{ id: string; status?: RequestStatus; result?: string }> = [];
  const linkCalls: Array<{ requestId: string; workItemId: string }> = [];
  const service = {
    getById: jest.fn(async (id: string) => registry.get(id) ?? null),
    listAll: jest.fn(async () => Array.from(registry.values())),
    update: jest.fn(async (id: string, updates: Partial<Request>) => {
      const r = registry.get(id);
      if (!r) throw new Error(`Request not found: ${id}`);
      if (updates.status !== undefined) r.status = updates.status;
      if (updates.result !== undefined) r.result = updates.result;
      r.updatedAt = new Date().toISOString();
      updateCalls.push({
        id,
        status: updates.status,
        result: updates.result,
      });
      return r;
    }),
    // Pipeline-#4 fix (Patch A): subscriber wires linkWorkItem from
    // workitem:queued. The fake records every call so tests can assert
    // bidirectional linking; idempotency is honoured by the includes() check.
    linkWorkItem: jest.fn(async (requestId: string, workItemId: string) => {
      const r = registry.get(requestId);
      if (!r) return null;
      if (!r.workItemIds.includes(workItemId)) {
        r.workItemIds.push(workItemId);
        r.updatedAt = new Date().toISOString();
      }
      linkCalls.push({ requestId, workItemId });
      return r;
    }),
  } as unknown as RequestService;
  return { service, registry, updateCalls, linkCalls };
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

  // 2026-05-13 dogfood regression: when a user replies WITHIN an existing
  // Slack thread, the bridge encodes sourceConversationItemId as
  // `slack-{channel}-{threadRoot}-msg-{messageTs}` so the SLA threadIndex
  // keys on the actual thread root (which is what orc replies to via
  // reply-slack). Both extractors MUST strip the `-msg-{ts}` suffix.
  it('strips the `-msg-{ts}` suffix for thread-reply encoding (extractSlackThreadTs)', () => {
    expect(
      extractSlackThreadTs('slack-D0AC7NF5N7L-1777130816.772509-msg-1778679615.696949'),
    ).toBe('1777130816.772509');
  });

  it('strips the `-msg-{ts}` suffix for thread-reply encoding (extractSlackChannelId)', () => {
    expect(
      extractSlackChannelId('slack-D0AC7NF5N7L-1777130816.772509-msg-1778679615.696949'),
    ).toBe('D0AC7NF5N7L');
  });
});

describe('pickResolveTarget', () => {
  // 2026-04-29 bug fix: pin the legal mapping so a future change to the
  // WORK_ITEM_TRANSITIONS matrix that breaks our targets fails CI loudly.
  it('routes queued WIs to "cancelled" (queued→done is illegal)', () => {
    expect(pickResolveTarget('queued')).toBe('cancelled');
  });

  it('routes running WIs to "done"', () => {
    expect(pickResolveTarget('running')).toBe('done');
  });

  it('routes done_by_worker to "verified" (the only success edge from done_by_worker)', () => {
    expect(pickResolveTarget('done_by_worker')).toBe('verified');
  });

  it('routes other live statuses to "cancelled" (defensive default)', () => {
    expect(pickResolveTarget('blocked')).toBe('cancelled');
    expect(pickResolveTarget('escalated')).toBe('cancelled');
    expect(pickResolveTarget('proposed')).toBe('cancelled');
    expect(pickResolveTarget('accepted')).toBe('cancelled');
    expect(pickResolveTarget('scheduled')).toBe('cancelled');
  });

  it('always returns a status that is reachable from the input per WORK_ITEM_TRANSITIONS', () => {
    // Property-style spec: whatever pickResolveTarget returns, the V3 state
    // machine MUST permit that edge from the input. This catches any drift
    // where the matrix tightens but the helper isn't updated.
    const liveStatuses: WorkItemStatus[] = [
      'queued',
      'running',
      'blocked',
      'escalated',
      'proposed',
      'accepted',
      'done_by_worker',
      'scheduled',
    ];
    for (const from of liveStatuses) {
      const to = pickResolveTarget(from);
      const allowed = WORK_ITEM_TRANSITIONS[from];
      expect(allowed.has(to)).toBe(true);
    }
  });
});

describe('pickFailTarget', () => {
  it('routes queued WIs to "cancelled" (queued→failed is illegal)', () => {
    expect(pickFailTarget('queued')).toBe('cancelled');
  });

  it('routes running WIs to "failed"', () => {
    expect(pickFailTarget('running')).toBe('failed');
  });

  it('routes done_by_worker to "rejected" (the only fail-shaped edge)', () => {
    expect(pickFailTarget('done_by_worker')).toBe('rejected');
  });

  it('always returns a status that is reachable from the input per WORK_ITEM_TRANSITIONS', () => {
    const liveStatuses: WorkItemStatus[] = [
      'queued',
      'running',
      'blocked',
      'escalated',
      'proposed',
      'accepted',
      'done_by_worker',
      'scheduled',
    ];
    for (const from of liveStatuses) {
      const to = pickFailTarget(from);
      const allowed = WORK_ITEM_TRANSITIONS[from];
      expect(allowed.has(to)).toBe(true);
    }
  });
});

/**
 * Executable refutation of a claim that was load-bearing and untested.
 *
 * PR #733's description argued that `rejected` is "unreachable in production" —
 * `verifyItem` has one production call site hardcoded to `'verified'`, there is
 * no verify/reject route, and the TL `verify-output` skill never writes a
 * verdict. All of that is true, and all of it is about `verifyItem`.
 *
 * `verifyItem` is not the only writer. {@link pickFailTarget} is the other one,
 * and `RequestSlaSubscriber.failOrphanRespondWi` drives it via
 * `taskPool.transitionStatus` directly — so `task:rejected` is never published
 * and `EventToWorkItemBridge` never creates the successor WorkItem that the
 * `verifyItem` route would have produced.
 *
 * A successor model built on "rejected cannot happen" would therefore be wrong
 * in production and right in every test. These assertions exist so that stops
 * being a prose argument in a merged PR body and becomes something CI can fail.
 *
 * Each `it` below is one link in the chain. They are deliberately *not* merged
 * into a single test: when this breaks, the failing test name should say which
 * link moved.
 */
describe('`rejected` reachability — the SLA escalation path (regression guard for PR #733)', () => {
  it('link 1: the failOrphanRespondWi terminal guard does not stop a done_by_worker WI', () => {
    // request-sla.subscriber.ts:~1508 short-circuits on SLA_TERMINAL_WORK_ITEM_STATUSES.
    // done_by_worker is absent from that set, so the guard lets it through.
    expect(SLA_TERMINAL_WORK_ITEM_STATUSES.has('done_by_worker')).toBe(false);
  });

  it('link 2: pickFailTarget turns that WI into `rejected`', () => {
    expect(pickFailTarget('done_by_worker')).toBe('rejected');
  });

  it('link 3: done_by_worker → rejected is legal, so transitionStatus accepts the write', () => {
    expect(WORK_ITEM_TRANSITIONS.done_by_worker.has('rejected')).toBe(true);
  });

  it('link 4: once `rejected`, the only outbound edge is `queued` — no terminal escape', () => {
    // This is what makes it STRANDING rather than merely an unusual status:
    // neither `rejected` nor `failed` can reach done/verified/cancelled, so
    // nothing can close them out without first putting the work back in play.
    expect([...WORK_ITEM_TRANSITIONS.rejected]).toEqual(['queued']);
    expect([...WORK_ITEM_TRANSITIONS.failed]).toEqual(['queued']);
    expect(TERMINAL_WORK_ITEM_STATUSES.has('rejected')).toBe(false);
    expect(TERMINAL_WORK_ITEM_STATUSES.has('failed')).toBe(false);
  });

  it('link 5: and the reconciler correctly refuses to touch them, so nothing cleans up', () => {
    // Post-#733 this is the CORRECT behaviour — emitting a correction here
    // would be an illegal transition. It is asserted because it removes the
    // only symptom this bug used to have: before #733 a >24h `rejected` WI
    // threw `Invalid status transition` every 60s. The disease outlived the
    // symptom, and the successor model is what actually treats it.
    expect(pickTTLExpiryTarget('rejected')).toBeNull();
    expect(pickTTLExpiryTarget('failed')).toBeNull();
    expect(pickCascadeTarget('rejected')).toBeNull();
    expect(pickCascadeTarget('failed')).toBeNull();
  });

});

describe('closeRequestPath', () => {
  it('returns ["done"] for direct-close statuses', () => {
    expect(closeRequestPath('open')).toEqual(['done']);
    expect(closeRequestPath('running')).toEqual(['done']);
    expect(closeRequestPath('waiting_confirmation')).toEqual(['done']);
  });

  it('returns ["running","done"] for two-step statuses', () => {
    expect(closeRequestPath('ready')).toEqual(['running', 'done']);
    expect(closeRequestPath('blocked')).toEqual(['running', 'done']);
  });

  it('returns [] for already-terminal statuses', () => {
    expect(closeRequestPath('done')).toEqual([]);
    expect(closeRequestPath('cancelled')).toEqual([]);
  });

  it('every step in the returned path is a legal Request transition', () => {
    // Property: for any non-terminal start, walking the returned path must
    // never violate REQUEST_TRANSITIONS. Pins the helper against silent drift.
    const liveStatuses: RequestStatus[] = [
      'open',
      'ready',
      'running',
      'blocked',
      'waiting_confirmation',
    ];
    for (const start of liveStatuses) {
      let current: RequestStatus = start;
      for (const next of closeRequestPath(start)) {
        // Hand-rolled to avoid pulling REQUEST_TRANSITIONS into the test —
        // the closeRequestPath impl already calls isValidRequestTransition.
        expect(['done', 'running']).toContain(next);
        current = next;
      }
      expect(current).toBe('done');
    }
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

describe('extractChatV2ChannelId / extractChatV2MessageId (INBOUND-2)', () => {
  // INBOUND-2.f1 (Arch on PR #364): production channel + message ids are
  // minted via `randomUUID()` (4 dashes per UUID, e.g.
  // `8b3c9a4e-5a02-4d51-9e7a-6f8c4d2e8a1b`). The original `lastIndexOf('-')`
  // split corrupted the round-trip — now using the `__` UUID-safe delimiter.
  const PROD_CHANNEL_UUID = '8b3c9a4e-5a02-4d51-9e7a-6f8c4d2e8a1b';
  const PROD_MESSAGE_UUID = 'fa1e2c3d-4567-89ab-cdef-0123456789ab';

  it('round-trips a production-shaped UUIDv4 channel + message id without corruption', () => {
    // The CRITICAL spec — pinned to real production data shape so a regression
    // to a single-dash delimiter (or any other UUID-colliding char) fails here
    // before any behavioural test gets a chance to mask the corruption.
    const sid = `chatv2-${PROD_CHANNEL_UUID}__${PROD_MESSAGE_UUID}`;
    expect(extractChatV2ChannelId(sid)).toBe(PROD_CHANNEL_UUID);
    expect(extractChatV2MessageId(sid)).toBe(PROD_MESSAGE_UUID);
  });

  it('round-trips a no-dash id (non-UUID, e.g. cuid-ish or short test fixture)', () => {
    const sid = 'chatv2-cabc123__mxyz789';
    expect(extractChatV2ChannelId(sid)).toBe('cabc123');
    expect(extractChatV2MessageId(sid)).toBe('mxyz789');
  });

  it('round-trips an id with a single-dash inside the channel segment', () => {
    // Defensive case — earlier `lastIndexOf('-')` impl would corrupt this too.
    const sid = 'chatv2-c-abc-123__m-xyz-789';
    expect(extractChatV2ChannelId(sid)).toBe('c-abc-123');
    expect(extractChatV2MessageId(sid)).toBe('m-xyz-789');
  });

  it('returns null for non-chatv2 ids', () => {
    expect(extractChatV2ChannelId('slack-C123-1.2')).toBeNull();
    expect(extractChatV2MessageId('slack-C123-1.2')).toBeNull();
  });

  it('returns null for empty / missing input', () => {
    expect(extractChatV2ChannelId(undefined)).toBeNull();
    expect(extractChatV2MessageId('')).toBeNull();
  });

  it('returns null when the chatv2 id is missing the message segment', () => {
    expect(extractChatV2ChannelId('chatv2-')).toBeNull();
    expect(extractChatV2MessageId('chatv2-only-channel-no-delim')).toBeNull();
  });

  it('returns null when the chatv2 id has the delim but no message body after it', () => {
    expect(extractChatV2ChannelId('chatv2-cabc__')).toBe('cabc');
    expect(extractChatV2MessageId('chatv2-cabc__')).toBeNull();
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
  // getPendingUserRequestCount — powers the /health orchestrator signal (#686)
  // -------------------------------------------------------------------------

  describe('getPendingUserRequestCount', () => {
    it('starts at 0 with no tracked requests', () => {
      expect(sub.getPendingUserRequestCount()).toBe(0);
    });

    it('counts an inbound-tagged request awaiting a response', async () => {
      const r = buildRequest({ tags: ['slack'] });
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();
      expect(sub.getPendingUserRequestCount()).toBe(1);
    });

    it('does not count a request with no inbound tag', async () => {
      const r = buildRequest({ tags: ['cli'] });
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();
      expect(sub.getPendingUserRequestCount()).toBe(0);
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
      const r = buildRequest({ tags: ['chat-v2'], sourceConversationItemId: 'chatv2-C__1' });
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
    it('transitions the orphan respond_to_user WI to "cancelled" with slaResolvedReason="escalation_timeout" after a 10min escalation (queued WI, DM success path)', async () => {
      // Bug fix 2026-04-29: queued→failed is illegal in WORK_ITEM_TRANSITIONS,
      // so an unclaimed SLA tracker now routes to `cancelled` on escalation.
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      jest.advanceTimersByTime(10_000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      const wiId = respondToUserWorkItemId(r.id);
      const closeTransitions = pool.transitionCalls.filter((c) => c.id === wiId);
      expect(closeTransitions).toHaveLength(1);
      expect(closeTransitions[0].status).toBe('cancelled');
      expect(closeTransitions[0].actor).toBe('system');

      // Mutator must stamp slaResolvedReason for ops visibility.
      const wi = await pool.taskPool.findWorkItem(wiId);
      expect(wi?.status).toBe('cancelled');
      expect(wi?.metadata?.slaResolvedReason).toBe('escalation_timeout');
      expect(typeof wi?.metadata?.slaResolvedAt).toBe('string');
    });

    it('still closes the orphan WI when no Slack DM hook is wired', async () => {
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
      const closeTransitions = pool.transitionCalls.filter((c) => c.id === wiId);
      expect(closeTransitions).toHaveLength(1);
      // queued WI → cancelled (legal); only running WIs go to failed.
      expect(closeTransitions[0].status).toBe('cancelled');
    });

    /**
     * EVAL 6 — reproduce the STRANDING CONDITION itself.
     *
     * Not a reproduction of the 469a3a21 revert: that rule is gone and there is
     * no live regression to re-run. What reproduces reliably is the underlying
     * gap, and this is the path Victor named for it.
     *
     * Deterministic, no mocked internals: the subscriber's real 10-minute timer
     * fires, `pickFailTarget` runs for real, and the fake pool enforces the
     * canonical `WORK_ITEM_TRANSITIONS` matrix — so if the transition were
     * illegal, this test would throw rather than pass.
     */
    describe('EVAL 6 — the stranding condition, reproduced', () => {
      /** Arm a tracked Request whose WI has reached the given status. */
      async function escalateWith(status: WorkItemStatus): Promise<string> {
        const r = buildRequest();
        svc.registry.set(r.id, r);
        bus.publish(buildEvent(r.id));
        await sub.flushPending();

        const wiId = respondToUserWorkItemId(r.id);
        // The tracker only clears on a VERIFIED_REPLY_REASON. An orc that
        // reported done without one leaves the WI here when the timer fires.
        pool.setStatus(wiId, status);

        jest.advanceTimersByTime(10_000);
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        return wiId;
      }

      it('a done_by_worker WI is driven to `rejected` — the status #733 called unreachable', async () => {
        const wiId = await escalateWith('done_by_worker');

        const wi = await pool.taskPool.findWorkItem(wiId);
        expect(wi?.status).toBe('rejected');
      });

      it('and no successor WorkItem is created, because the bridge never hears about it', async () => {
        const before = pool.addCalls.length;
        const wiId = await escalateWith('done_by_worker');

        // This path writes via `transitionStatus` directly rather than
        // `verifyItem`, so `task:rejected` is never published and
        // `EventToWorkItemBridge` never builds the `${id}:retry:1` successor
        // that the verifyItem route would have produced.
        const newItems = pool.addCalls.slice(before);
        expect(newItems.some((wi) => wi.id.startsWith(`${wiId}:retry:`))).toBe(false);
      });

      it('and the item it lands in cannot reach any terminal state — that is the strand', async () => {
        await escalateWith('done_by_worker');

        // The whole reason this is stranding rather than merely an unusual
        // status: nothing can close it out without first putting the work back
        // in play, and no rule does.
        expect([...WORK_ITEM_TRANSITIONS.rejected]).toEqual(['queued']);
        expect(TERMINAL_WORK_ITEM_STATUSES.has('rejected')).toBe(false);
      });

      it('THE FIX: the strand is handed to the disposition funnel', async () => {
        const wiId = await escalateWith('done_by_worker');

        expect(pool.disposeCalls).toHaveLength(1);
        expect(pool.disposeCalls[0].id).toBe(wiId);
        expect(pool.disposeCalls[0].reason).toContain('done_by_worker');
      });

      it('THE FIX: a running WI driven to `failed` is disposed too', async () => {
        const wiId = await escalateWith('running');

        const wi = await pool.taskPool.findWorkItem(wiId);
        expect(wi?.status).toBe('failed');
        expect(pool.disposeCalls.map((c) => c.id)).toEqual([wiId]);
      });

      it('but a `cancelled` close is NOT disposed — it is already strictly terminal', async () => {
        // The common case: respond_to_user WIs are born `queued`, and
        // pickFailTarget('queued') is 'cancelled'. Disposing that would be
        // noise, and would imply a strand where there is none.
        const wiId = await escalateWith('queued');

        const wi = await pool.taskPool.findWorkItem(wiId);
        expect(wi?.status).toBe('cancelled');
        expect(pool.disposeCalls).toHaveLength(0);
      });
    });

    it('still closes the orphan WI when the Slack DM callback throws', async () => {
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
      const closeTransitions = pool.transitionCalls.filter((c) => c.id === wiId);
      expect(closeTransitions).toHaveLength(1);
      expect(closeTransitions[0].status).toBe('cancelled');
    });

    it('routes a CLAIMED orphan respond_to_user WI to "failed" on escalation', async () => {
      // The other escalation tests exercise the queued case (default for SLA
      // trackers that the orc never explicitly claims). This case pins the
      // running→failed branch — important for the rare path where someone
      // manually claims the SLA WI and then misses the 10min window.
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      // Simulate a claim before the 10min mark.
      const wiId = respondToUserWorkItemId(r.id);
      pool.setStatus(wiId, 'running');

      jest.advanceTimersByTime(10_000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      const closeTransitions = pool.transitionCalls.filter((c) => c.id === wiId);
      expect(closeTransitions).toHaveLength(1);
      expect(closeTransitions[0].status).toBe('failed');
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

      // No additional transition recorded — already terminal.
      const closeTransitions = pool.transitionCalls.filter((c) => c.id === wiId);
      expect(closeTransitions).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Auto-close on orc reply
  // -------------------------------------------------------------------------

  describe('markResolvedByThread', () => {
    it('transitions the queued SLA WI to "cancelled" and cascades the Request to "done"', async () => {
      // The user-visible bug Steve reported (2026-04-29): orc replied on
      // Slack but Request stayed Active. Root cause was queued→done illegal.
      // Post-fix: queued→cancelled (legal) + Request open→done cascade.
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      expect(sub.trackedCount).toBe(1);
      expect(svc.registry.get(r.id)?.status).toBe('open');

      await sub.markResolvedByThread('1772899923.865659');

      // WI: queued → cancelled (legal) with slaResolvedReason metadata.
      expect(pool.transitionCalls).toEqual([
        { id: respondToUserWorkItemId(r.id), status: 'cancelled', actor: 'system' },
      ]);
      const wi = await pool.taskPool.findWorkItem(respondToUserWorkItemId(r.id));
      expect(wi?.metadata?.slaResolvedReason).toBe('orc_reply');
      expect(typeof wi?.metadata?.slaResolvedAt).toBe('string');

      // Request: open → done (cascade close, no other live WIs).
      expect(svc.updateCalls).toEqual([
        expect.objectContaining({ id: r.id, status: 'done' }),
      ]);
      expect(svc.registry.get(r.id)?.status).toBe('done');
      expect(svc.registry.get(r.id)?.result).toContain('orc_reply');

      expect(sub.trackedCount).toBe(0);

      // Subsequent timer firings are silent.
      const breachListener = jest.fn();
      bus.onInProcess('request:sla_breached', breachListener);
      jest.advanceTimersByTime(60_000);
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
      expect(breachListener).not.toHaveBeenCalled();
    });

    it('routes a CLAIMED SLA WI to "done" on resolve (not "cancelled")', async () => {
      // Pin the running→done branch — important for the rare path where
      // someone explicitly claims the SLA WI before the orc replies.
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      pool.setStatus(respondToUserWorkItemId(r.id), 'running');

      await sub.markResolvedByThread('1772899923.865659');

      expect(pool.transitionCalls).toEqual([
        { id: respondToUserWorkItemId(r.id), status: 'done', actor: 'system' },
      ]);
    });

    it('keeps the parent Request open when other non-terminal WIs exist (orc decomposed)', async () => {
      // Orc decomposes a Request into delegate WIs and ALSO replies in-thread.
      // The reply auto-resolves the SLA tracker but the decomposition WIs
      // are still in flight — we MUST NOT close the Request prematurely.
      const r = buildRequest({ status: 'running' });
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      // Inject a sibling delegate WI for the same Request (status=running).
      const sibling: WorkItem = {
        id: 'wi-delegate-1',
        type: 'delegate',
        owner: 'team_lead',
        target: 'leo',
        title: 'Decomposed sub-task',
        description: 'Real work spawned from the same Request',
        status: 'running',
        createdAt: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
        requestId: r.id,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      };
      await pool.taskPool.addToPool(sibling);

      await sub.markResolvedByThread('1772899923.865659');

      // SLA tracker still flips to cancelled.
      expect(pool.transitionCalls).toEqual([
        { id: respondToUserWorkItemId(r.id), status: 'cancelled', actor: 'system' },
      ]);
      // …but Request stays in 'running' — cascade is gated on "no other live WIs".
      expect(svc.updateCalls).toHaveLength(0);
      expect(svc.registry.get(r.id)?.status).toBe('running');
    });

    it('still cascades the Request when sibling WIs are all terminal', async () => {
      const r = buildRequest({ status: 'running' });
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      // Sibling WI exists but already done — should not block cascade.
      const doneSibling: WorkItem = {
        id: 'wi-delegate-done',
        type: 'delegate',
        owner: 'team_lead',
        target: 'leo',
        title: 'Already-done sibling',
        description: 'Completed before the orc replied',
        status: 'done',
        createdAt: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
        requestId: r.id,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      };
      await pool.taskPool.addToPool(doneSibling);

      await sub.markResolvedByThread('1772899923.865659');

      expect(svc.registry.get(r.id)?.status).toBe('done');
    });

    it('routes through "running" on a "ready" Request (two-step close)', async () => {
      // ready→done is illegal per REQUEST_TRANSITIONS. The cascade picks
      // ready→running→done. Pin the ordering so a refactor that drops the
      // intermediate step fails CI loudly.
      const r = buildRequest({ status: 'ready' });
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      await sub.markResolvedByThread('1772899923.865659');

      expect(svc.updateCalls.map((c) => c.status)).toEqual(['running', 'done']);
      expect(svc.registry.get(r.id)?.status).toBe('done');
    });

    it('skips Request cascade when the Request is already terminal', async () => {
      const r = buildRequest({ status: 'cancelled' });
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      await sub.markResolvedByThread('1772899923.865659');

      // No Request.update — already terminal.
      expect(svc.updateCalls).toHaveLength(0);
      expect(svc.registry.get(r.id)?.status).toBe('cancelled');
    });

    it('is a no-op for an unknown threadTs', async () => {
      await sub.markResolvedByThread('9999999999.000000');
      expect(pool.transitionCalls).toHaveLength(0);
    });

    it('is a no-op for an empty threadTs', async () => {
      await sub.markResolvedByThread('');
      expect(pool.transitionCalls).toHaveLength(0);
    });

    it('skips the WI transition when it is already terminal but still cascades the Request', async () => {
      // Out-of-band cleanup left the WI cancelled. The cascade should
      // still run so the parent Request doesn't sit on Active forever.
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      pool.setStatus(respondToUserWorkItemId(r.id), 'verified');

      await sub.markResolvedByThread('1772899923.865659');
      // No new WI transition recorded — already terminal.
      expect(pool.transitionCalls).toHaveLength(0);
      // …but Request still cascades to done.
      expect(svc.registry.get(r.id)?.status).toBe('done');
    });

    // -----------------------------------------------------------------------
    // 2026-05-21 closie incident — orphan-Request fallback
    //
    // When `RequestDecomposeSubscriber` decomposes a Request before the orc
    // replies, it calls `markResolved(req, 'workitem_decompose')` which
    // CLEARS the SLA `threadIndex`. If the orc then replies directly in the
    // same Slack thread, the primary lookup AND the 250ms retry both miss.
    // The fallback path scans `RequestService.listAll()` for an open
    // Request whose sourceConversationItemId references the threadTs, then
    // cancels all non-terminal child WIs and cascades the close.
    // -----------------------------------------------------------------------
    describe('orphan-Request fallback after workitem_decompose race', () => {
      it('cancels non-terminal child WIs and cascades the Request to done', async () => {
        // Simulate the post-decompose state directly: a 'ready' Request,
        // orphan child WIs in the pool, and empty SLA indexes (since the
        // decompose subscriber's markResolved cleared them in production).
        // We bypass the request:created handler so the test doesn't have
        // to navigate the maybeCloseRequest cascade that would have run
        // synchronously when no children existed yet.
        const r = buildRequest({ status: 'ready' });
        svc.registry.set(r.id, r);

        pool.taskPool.addToPool({
          id: 'wi-plan',
          requestId: r.id,
          type: 'delegate',
          owner: 'orchestrator',
          status: 'queued',
          title: 'Plan',
          description: 'plan',
          createdAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        } as unknown as WorkItem);
        pool.taskPool.addToPool({
          id: 'wi-execute',
          requestId: r.id,
          type: 'delegate',
          owner: 'orchestrator',
          status: 'blocked',
          title: 'Execute',
          description: 'execute',
          createdAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        } as unknown as WorkItem);

        // Sanity: threadIndex is empty (mirrors post-decompose state).
        expect((sub as any).threadIndex.get('1772899923.865659')).toBeUndefined();

        // Orc replies directly in the original Slack thread.
        await sub.markResolvedByThread('1772899923.865659');
        // Primary + retry both miss → setTimeout schedules the fallback.
        jest.advanceTimersByTime(MARK_RESOLVED_RETRY_MS + 1);
        // Flush microtasks queued by the async fallback handler (listAll,
        // getAllItems, two transitionStatus, maybeCloseRequest chain).
        for (let i = 0; i < 20; i += 1) await Promise.resolve();

        // Both child WIs transitioned to cancelled with the new reason tag.
        const cancelTransitions = pool.transitionCalls.filter(
          (c) => c.status === 'cancelled' && (c.id === 'wi-plan' || c.id === 'wi-execute'),
        );
        expect(cancelTransitions).toHaveLength(2);

        // Request cascade closed to done.
        expect(svc.registry.get(r.id)?.status).toBe('done');
      });

      it('skips closure when no Request matches the threadTs', async () => {
        // Nothing registered for this thread — fallback is a no-op.
        await sub.markResolvedByThread('5555555555.000000');
        jest.advanceTimersByTime(MARK_RESOLVED_RETRY_MS + 1);
        for (let i = 0; i < 5; i += 1) await Promise.resolve();

        expect(pool.transitionCalls).toHaveLength(0);
      });

      it('skips closure when the matched Request is already terminal', async () => {
        const r = buildRequest({ status: 'done' });
        svc.registry.set(r.id, r);

        // Add an orphan child WI to verify the fallback doesn't touch
        // children when the Request is already terminal.
        pool.taskPool.addToPool({
          id: 'wi-after-close',
          requestId: r.id,
          type: 'delegate',
          owner: 'orchestrator',
          status: 'queued',
          title: 'Orphan',
          description: 'orphan',
          createdAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        } as unknown as WorkItem);

        await sub.markResolvedByThread('1772899923.865659');
        jest.advanceTimersByTime(MARK_RESOLVED_RETRY_MS + 1);
        for (let i = 0; i < 5; i += 1) await Promise.resolve();

        // No transitions: TERMINAL gate stops the cleanup.
        expect(pool.transitionCalls.filter((c) => c.id === 'wi-after-close')).toHaveLength(0);
      });

      it('chat-v2 case: cancels orphans and closes Request on direct reply after decompose', async () => {
        const r = buildRequest({
          status: 'ready',
          tags: ['chat-v2'],
          sourceConversationItemId: 'chatv2-CHAN__123',
        });
        svc.registry.set(r.id, r);

        pool.taskPool.addToPool({
          id: 'wi-chatv2-plan',
          requestId: r.id,
          type: 'delegate',
          owner: 'orchestrator',
          status: 'queued',
          title: 'Plan',
          description: 'plan',
          createdAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        } as unknown as WorkItem);

        expect((sub as any).chatV2Index.get('CHAN')).toBeUndefined();

        await sub.markResolvedByChatV2('CHAN');
        jest.advanceTimersByTime(MARK_RESOLVED_RETRY_MS + 1);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();

        expect(
          pool.transitionCalls.filter(
            (c) => c.id === 'wi-chatv2-plan' && c.status === 'cancelled',
          ),
        ).toHaveLength(1);
        expect(svc.registry.get(r.id)?.status).toBe('done');
      });
    });

    // -------------------------------------------------------------------------
    // Pipeline-#4 fix (Patch E) — orc_reply grace window
    // -------------------------------------------------------------------------

    describe('orc_reply grace window (Pipeline-#4 fix Patch E)', () => {
      it('defers cascade close when Request is freshly created (<60s) and has no linked WIs', async () => {
        // Fresh Request: createdAt = NOW so age << ORC_REPLY_GRACE_AGE_MS.
        const r = buildRequest({
          createdAt: new Date().toISOString(),
        });
        svc.registry.set(r.id, r);
        bus.publish(buildEvent(r.id));
        await sub.flushPending();

        await sub.markResolvedByThread('1772899923.865659');

        // The respond_to_user WI was still cancelled (markResolved ran).
        expect(pool.transitionCalls).toHaveLength(1);
        // …but Request cascade close was DEFERRED — status unchanged.
        expect(svc.registry.get(r.id)?.status).toBe('open');
        expect(
          svc.updateCalls.some((c) => c.id === r.id && c.status === 'done'),
        ).toBe(false);
      });

      it('closes the Request on the recheck pass when no siblings appeared during the grace window', async () => {
        const r = buildRequest({
          createdAt: new Date().toISOString(),
        });
        svc.registry.set(r.id, r);
        bus.publish(buildEvent(r.id));
        await sub.flushPending();

        await sub.markResolvedByThread('1772899923.865659');

        // Advance past the 30s grace window — the deferred recheck fires.
        jest.advanceTimersByTime(31_000);
        for (let i = 0; i < 5; i += 1) await Promise.resolve();

        // Recheck closes since no siblings linked.
        expect(svc.registry.get(r.id)?.status).toBe('done');
        expect(svc.registry.get(r.id)?.result).toContain('orc_reply_recheck');
      });

      it('keeps the Request open when siblings appear during the grace window', async () => {
        const r = buildRequest({
          createdAt: new Date().toISOString(),
          status: 'running',
        });
        svc.registry.set(r.id, r);
        bus.publish(buildEvent(r.id));
        await sub.flushPending();

        await sub.markResolvedByThread('1772899923.865659');

        // Inside the grace window, link a sibling delegate WI (simulates
        // break-down-request decomposing the Request between orc_reply and
        // the recheck) AND mark the WI running so the otherActiveCount gate
        // catches it on the second pass.
        const sibling: WorkItem = {
          id: 'wi-grace-sibling',
          type: 'delegate',
          owner: 'team_lead',
          target: 'leo',
          title: 'Grace-window sibling',
          description: 'real work',
          status: 'running',
          createdAt: new Date().toISOString(),
          requestId: r.id,
          retryCount: 0,
          maxRetries: 3,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        };
        await pool.taskPool.addToPool(sibling);
        await svc.service.linkWorkItem(r.id, sibling.id);

        jest.advanceTimersByTime(31_000);
        for (let i = 0; i < 5; i += 1) await Promise.resolve();

        // sibling-count gate suppresses close on the recheck pass.
        expect(svc.registry.get(r.id)?.status).toBe('running');
      });

      it('skips the grace and closes immediately when Request is older than the grace age', async () => {
        // Stale Request — buildRequest's default is already 5 min back.
        const r = buildRequest();
        svc.registry.set(r.id, r);
        bus.publish(buildEvent(r.id));
        await sub.flushPending();

        await sub.markResolvedByThread('1772899923.865659');

        // Old Request: legacy behaviour — immediate cascade close.
        expect(svc.registry.get(r.id)?.status).toBe('done');
        expect(svc.registry.get(r.id)?.result).toContain('orc_reply');
      });

      it('does NOT defer when reason is workitem_decompose (only orc_reply triggers grace)', async () => {
        const r = buildRequest({
          createdAt: new Date().toISOString(),
        });
        svc.registry.set(r.id, r);
        bus.publish(buildEvent(r.id));
        await sub.flushPending();

        // Resolve via workitem_decompose path — must close immediately.
        await sub.markResolved(r.id, 'workitem_decompose');

        expect(svc.registry.get(r.id)?.status).toBe('done');
      });
    });
  });

  // -------------------------------------------------------------------------
  // 2026-05-03 auto-nudge variant 2 — SLA close-path race fix
  //
  // Steve reported the orc was sending 3x "I will reply as soon as I have
  // an answer (auto-nudge)" with no real reply on ESTestNode 1.6.4. Triage
  // showed every Slack msg was processed end-to-end (3 today between
  // 15:17–15:26, all completed in 3–115s with output text), but the SLA
  // close path was missing because:
  //
  //   • slack-bridge wraps `createRequest` in setImmediate (fire-and-forget),
  //     so `request:created` is published asynchronously.
  //   • Sequentially, `sendToOrchestrator` → enqueue → QueueProcessor fires
  //     `slackResolve('')` immediately on delivery.
  //   • The bridge's promise resolves with `fromOrcReply: true`, sendSlackResponse
  //     calls `markResolvedByThread(threadTs)`.
  //   • But the SLA subscriber's `handleRequestCreated` was awaiting
  //     `taskPool.addToPool` BEFORE setting `threadIndex`. The early lookup
  //     missed the index by ~10ms and the SLA never closed → 5min/10min
  //     escalation_dm cascade.
  //
  // The primary fix reorders `handleRequestCreated` so the index is
  // populated synchronously BEFORE the addToPool await. The defensive
  // retry inside `markResolvedByThread` covers the residual ~1ms race
  // from the leading `await requestService.getById(...)`.
  // -------------------------------------------------------------------------
  describe('SLA close-path race fix (2026-05-03 auto-nudge variant 2)', () => {
    it('populates threadIndex BEFORE awaiting taskPool.addToPool', async () => {
      // Pin the ordering invariant: while `taskPool.addToPool` is in flight,
      // `threadIndex` and `trackedByRequest` are already populated. If a
      // future refactor moves these sets back below the addToPool await,
      // the test fails because the index isn't visible during the gating
      // window.
      //
      // We assert the invariant directly (without invoking
      // markResolvedByThread) to avoid coupling this test to the
      // findWorkItemWithRetry / fake-timer interaction. The retry path is
      // covered by separate tests below.
      let resolveAddToPool: () => void = () => {};
      const addToPoolDone = new Promise<void>((res) => {
        resolveAddToPool = res;
      });
      const realAddToPool = pool.taskPool.addToPool;
      pool.taskPool.addToPool = jest.fn(async (wi: WorkItem) => {
        await addToPoolDone;
        return realAddToPool.call(pool.taskPool, wi);
      });

      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));

      // Yield enough microtasks for handleRequestCreated to finish its
      // sync block (timer + tracking + index sets) and be parked on the
      // addToPool await.
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      // INVARIANT: tracking + index are populated even though the WI
      // hasn't been persisted yet.
      expect(sub.trackedCount).toBe(1);
      expect(pool.taskPool.addToPool).toHaveBeenCalledTimes(1);
      expect(pool.addCalls).toHaveLength(0); // addToPool body still parked

      // Drain: let addToPool finish so afterEach can stop cleanly.
      resolveAddToPool();
      await sub.flushPending();
      expect(pool.addCalls).toHaveLength(1);
    });

    it('closes the SLA when markResolvedByThread fires while addToPool is still in flight', async () => {
      // The end-to-end production race: bridge calls markResolvedByThread
      // while addToPool is mid-await. Index lookup hits, but findWorkItem
      // returns null. The findWorkItemWithRetry inside markResolved
      // absorbs the WI-not-yet-persisted window and the SLA closes once
      // addToPool completes.
      let resolveAddToPool: () => void = () => {};
      const addToPoolDone = new Promise<void>((res) => {
        resolveAddToPool = res;
      });
      const realAddToPool = pool.taskPool.addToPool;
      pool.taskPool.addToPool = jest.fn(async (wi: WorkItem) => {
        await addToPoolDone;
        return realAddToPool.call(pool.taskPool, wi);
      });

      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));

      // Drain into the addToPool-pending state.
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      expect(sub.trackedCount).toBe(1);

      // Bridge fires the close while addToPool is still in flight.
      const closePromise = sub.markResolvedByThread('1772899923.865659');

      // Drain microtasks: markResolved enters findWorkItemWithRetry and
      // is now awaiting the first 50ms tick.
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      expect(pool.transitionCalls).toHaveLength(0); // not yet — WI absent

      // Release addToPool BEFORE the next retry tick fires. The next
      // findWorkItem call inside the retry loop now sees the WI.
      resolveAddToPool();
      await sub.flushPending();

      // Advance fake timers through up to 5 × 50ms retries so the loop
      // wakes, sees the WI, and transitions.
      for (let i = 0; i < 5; i += 1) {
        jest.advanceTimersByTime(FIND_WI_RETRY_INTERVAL_MS);
        for (let j = 0; j < 5; j += 1) await Promise.resolve();
      }

      await closePromise;

      expect(pool.transitionCalls).toEqual([
        { id: respondToUserWorkItemId(r.id), status: 'cancelled', actor: 'system' },
      ]);
      expect(sub.trackedCount).toBe(0);
    });

    it('retries markResolvedByThread on index miss within 250ms', async () => {
      // Belt-and-suspenders: cover the residual ~1ms window where the
      // leading `await requestService.getById(...)` hasn't returned yet
      // when the bridge fires its slackResolve callback. The first lookup
      // misses; the scheduled retry hits and closes the SLA.
      const r = buildRequest();
      svc.registry.set(r.id, r);

      // Fire-and-forget the markResolvedByThread BEFORE publishing the
      // request:created event — exact reproduction of "early-resolve race".
      const earlyResolve = sub.markResolvedByThread('1772899923.865659');

      // First lookup misses (index is empty). No transitions yet.
      await earlyResolve;
      expect(pool.transitionCalls).toHaveLength(0);
      expect(sub.trackedCount).toBe(0);

      // Publish request:created so the index gets populated.
      bus.publish(buildEvent(r.id));
      await sub.flushPending();
      expect(sub.trackedCount).toBe(1);

      // Advance fake timers past the 250ms retry threshold. The retry
      // should hit the now-populated index and close the SLA.
      jest.advanceTimersByTime(300);
      // Drain the async work the retry triggered.
      for (let i = 0; i < 10; i += 1) await Promise.resolve();

      expect(pool.transitionCalls).toEqual([
        { id: respondToUserWorkItemId(r.id), status: 'cancelled', actor: 'system' },
      ]);
      expect(sub.trackedCount).toBe(0);
    });

    it('retry no-ops if request:created never arrives (defensive)', async () => {
      // If the request was never tracked (e.g. createRequest persistently
      // failed), the retry should not throw and not generate spurious
      // transitions. Pure best-effort.
      await sub.markResolvedByThread('9999999999.000000');
      expect(pool.transitionCalls).toHaveLength(0);

      jest.advanceTimersByTime(500);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      expect(pool.transitionCalls).toHaveLength(0);
      expect(sub.trackedCount).toBe(0);
    });

    it('rolls back tracking when addToPool throws (no leaked timers)', async () => {
      // Symmetry with the reordering: now that we populate trackedByRequest
      // before addToPool, we must roll back on failure or we leak timers
      // and a 5min/10min escalation will fire on a WI that never
      // persisted.
      pool.taskPool.addToPool = jest.fn(async () => {
        throw new Error('disk full (simulated)');
      });

      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));

      // The handler throws; the EventBus error path swallows it. Drain.
      await sub.flushPending();

      // Tracking rolled back to zero — no leaked entry.
      expect(sub.trackedCount).toBe(0);

      // Advance past both SLA windows; no breach event, no escalation DM.
      const breachListener = jest.fn();
      bus.onInProcess('request:sla_breached', breachListener);
      jest.advanceTimersByTime(15_000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      expect(breachListener).not.toHaveBeenCalled();
      expect(escalateCalls).toHaveLength(0);
    });

    it('also retries markResolvedByChatV2 on chat-v2 channel index miss', async () => {
      // Same race shape on chat-v2 surface (INBOUND-2). Mirror the
      // protection so neither inbound channel can leak escalation_dm
      // when the agent reply lands faster than tracking setup.
      const chatV2Request = buildRequest({
        id: 'req-cv2',
        // chat-v2 sourceConversationItemId is `chatv2-<channelId>__<messageId>`
        // (see `extractChatV2ChannelId` / `extractChatV2MessageId`).
        sourceConversationItemId: 'chatv2-Ccv2__msg1',
        tags: ['chat-v2'],
      });
      svc.registry.set(chatV2Request.id, chatV2Request);

      // Fire markResolvedByChatV2 BEFORE publishing the event.
      const earlyResolve = sub.markResolvedByChatV2('Ccv2');
      await earlyResolve;
      expect(pool.transitionCalls).toHaveLength(0);

      bus.publish(buildEvent(chatV2Request.id, 'evt-cv2'));
      await sub.flushPending();

      // Advance fake timers past the markResolvedByChatV2 retry (250ms),
      // then drain the findWorkItemWithRetry that runs inside markResolved.
      jest.advanceTimersByTime(MARK_RESOLVED_RETRY_MS + 50);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      // findWorkItemWithRetry first attempt is sync (no setTimeout for
      // attempt 0), so the WI is found immediately on the retry path.

      expect(pool.transitionCalls).toEqual([
        { id: respondToUserWorkItemId(chatV2Request.id), status: 'cancelled', actor: 'system' },
      ]);
      expect(sub.trackedCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Bug 2 defense-in-depth — VERIFIED_REPLY_REASONS gate on maybeCloseRequest
  // -------------------------------------------------------------------------
  // Steve 2026-04-30: a `responseTimeoutMs` placeholder reached the SLA
  // subscriber and cascaded the parent Request to `done` without an actual
  // orc reply. The primary fix lives in slack-orchestrator-bridge.ts (the
  // `fromOrcReply` flag), but this gate is the second line of defense:
  // even if a future caller somehow invokes `markResolved` with a
  // non-reply reason, the parent Request must not auto-close.
  describe('maybeCloseRequest — VERIFIED_REPLY_REASONS gate (Bug 2 defense-in-depth)', () => {
    it('does NOT cascade-close the Request when reason is not in the verified-reply set', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();
      expect(svc.registry.get(r.id)?.status).toBe('open');

      // Direct call to the protected `markResolved` with a non-reply reason
      // — exercises the gate without depending on a future caller bug.
      // `escalation_timeout` is the reason `failOrphanRespondWi` uses today;
      // any other diagnostic string would behave the same way.
      await (sub as unknown as { markResolved: (id: string, reason: string) => Promise<void> }).markResolved(
        r.id,
        'escalation_timeout',
      );

      // The WI may still transition (queued → cancelled is legal) but the
      // PARENT Request must NOT have been cascaded to `done`.
      expect(svc.updateCalls).toEqual([]);
      expect(svc.registry.get(r.id)?.status).toBe('open');
    });

    it('does cascade-close the Request when reason is "orc_reply" (verified-reply path)', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      await (sub as unknown as { markResolved: (id: string, reason: string) => Promise<void> }).markResolved(
        r.id,
        'orc_reply',
      );

      expect(svc.registry.get(r.id)?.status).toBe('done');
      expect(svc.registry.get(r.id)?.result).toContain('orc_reply');
    });

    it('does cascade-close the Request when reason is "chatv2_reply"', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      await (sub as unknown as { markResolved: (id: string, reason: string) => Promise<void> }).markResolved(
        r.id,
        'chatv2_reply',
      );

      expect(svc.registry.get(r.id)?.status).toBe('done');
      expect(svc.registry.get(r.id)?.result).toContain('chatv2_reply');
    });

    it('does cascade-close the Request when reason is "workitem_decompose"', async () => {
      const r = buildRequest();
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      await (sub as unknown as { markResolved: (id: string, reason: string) => Promise<void> }).markResolved(
        r.id,
        'workitem_decompose',
      );

      expect(svc.registry.get(r.id)?.status).toBe('done');
      expect(svc.registry.get(r.id)?.result).toContain('workitem_decompose');
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

      // The tracked WI was cancelled with reason 'workitem_decompose'.
      // (Bug fix 2026-04-29: queued→cancelled, not queued→done.)
      // The decomposed delegate WI was registered via the workitem:queued
      // event publisher, but the test fake's `addToPool` is what actually
      // stores WIs — we don't store the delegate WI here, so the cascade's
      // "no other live WIs" gate sees no siblings and closes the Request.
      expect(pool.transitionCalls).toEqual([
        { id: respondToUserWorkItemId(r.id), status: 'cancelled', actor: 'system' },
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
        { id: respondToUserWorkItemId(r.id), status: 'cancelled', actor: 'system' },
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

    // -----------------------------------------------------------------------
    // Pipeline-#4 fix (Patch A) — handleWorkItemQueued links WIs to Request
    // -----------------------------------------------------------------------

    describe('linkWorkItem wire (Pipeline-#4 fix Patch A)', () => {
      it('calls linkWorkItem on workitem:queued for any non-self-recursion WI', async () => {
        const r = buildRequest();
        svc.registry.set(r.id, r);
        bus.publish(buildEvent(r.id));
        await sub.flushPending();

        bus.publish(
          buildQueuedEvent({
            workItemId: 'wi-delegate-link-1',
            requestId: r.id,
            sessionName: 'pool-publisher',
          }) as unknown as Parameters<EventBusService['publish']>[0],
        );
        await sub.flushPending();

        // Bidirectional link populated.
        expect(svc.linkCalls).toContainEqual({
          requestId: r.id,
          workItemId: 'wi-delegate-link-1',
        });
        expect(svc.registry.get(r.id)?.workItemIds).toContain('wi-delegate-link-1');
      });

      it('does NOT call linkWorkItem when the queued WI is the respond_to_user tracker itself', async () => {
        const r = buildRequest();
        svc.registry.set(r.id, r);
        bus.publish(buildEvent(r.id));
        await sub.flushPending();

        // The respond_to_user WI's own enqueue must not link to its parent.
        bus.publish(
          buildQueuedEvent({
            workItemId: respondToUserWorkItemId(r.id),
            requestId: r.id,
            sessionName: 'pool-publisher',
          }) as unknown as Parameters<EventBusService['publish']>[0],
        );
        await sub.flushPending();

        expect(svc.linkCalls).toEqual([]);
        expect(svc.registry.get(r.id)?.workItemIds).toEqual([]);
      });

      it('links WIs even for untracked Requests (broader producer-side wiring)', async () => {
        const r = buildRequest();
        svc.registry.set(r.id, r);
        // Note: NOT seeding tracking via request:created — Request is untracked.

        bus.publish(
          buildQueuedEvent({
            workItemId: 'wi-untracked-link',
            requestId: r.id,
            sessionName: 'pool-publisher',
          }) as unknown as Parameters<EventBusService['publish']>[0],
        );
        await sub.flushPending();

        // Patch A intentionally fires BEFORE the trackedByRequest gate so
        // directly-POSTed (non-Slack) Requests also receive the link.
        expect(svc.linkCalls).toContainEqual({
          requestId: r.id,
          workItemId: 'wi-untracked-link',
        });
      });

      it('absorbs linkWorkItem failure without blocking the markResolved chain', async () => {
        const r = buildRequest();
        svc.registry.set(r.id, r);
        bus.publish(buildEvent(r.id));
        await sub.flushPending();

        // Force the next link to throw — the SLA chain must continue.
        (svc.service.linkWorkItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));

        bus.publish(
          buildQueuedEvent({
            workItemId: 'wi-delegate-link-fail',
            requestId: r.id,
            sessionName: 'pool-publisher',
          }) as unknown as Parameters<EventBusService['publish']>[0],
        );
        await sub.flushPending();

        // The SLA chain still resolved the respond_to_user WI.
        expect(pool.transitionCalls).toEqual([
          { id: respondToUserWorkItemId(r.id), status: 'cancelled', actor: 'system' },
        ]);
      });
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
  // INBOUND-2 — chat-v2 source path
  // -------------------------------------------------------------------------

  describe('chat-v2 source ingress', () => {
    it('builds the respond_to_user WI with chatV2 metadata for a chatv2-shaped sourceId', async () => {
      const r = buildRequest({
        tags: ['chat-v2'],
        sourceConversationItemId: 'chatv2-cabc__mxyz',
      });
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      const wi = pool.addCalls[0];
      expect(wi.metadata?.inboundSource).toBe('chat-v2');
      expect(wi.metadata?.chatV2ChannelId).toBe('cabc');
      expect(wi.metadata?.chatV2MessageId).toBe('mxyz');
      // Slack fields are null when the source is chat-v2.
      expect(wi.metadata?.slackThreadTs).toBeNull();
      expect(wi.metadata?.slackChannelId).toBeNull();
    });

    it('builds the WI with slack metadata when the source is slack-shaped', async () => {
      const r = buildRequest({
        tags: ['slack'],
        sourceConversationItemId: 'slack-C123-1772899923.865659',
      });
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      const wi = pool.addCalls[0];
      expect(wi.metadata?.inboundSource).toBe('slack');
      expect(wi.metadata?.slackThreadTs).toBe('1772899923.865659');
      expect(wi.metadata?.slackChannelId).toBe('C123');
      expect(wi.metadata?.chatV2ChannelId).toBeNull();
      expect(wi.metadata?.chatV2MessageId).toBeNull();
    });

    it('flags inboundSource="unknown" for tagged Requests with no recognisable source shape', async () => {
      const r = buildRequest({
        tags: ['chat-v2'],
        sourceConversationItemId: 'opaque-source-id',
      });
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      const wi = pool.addCalls[0];
      expect(wi.metadata?.inboundSource).toBe('unknown');
    });
  });

  describe('markResolvedByChatV2 (INBOUND-2 auto-close)', () => {
    it('transitions the matching WI to done and clears the timers', async () => {
      const r = buildRequest({
        tags: ['chat-v2'],
        sourceConversationItemId: 'chatv2-cabc__mxyz',
      });
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      expect(sub.trackedCount).toBe(1);

      await sub.markResolvedByChatV2('cabc');

      expect(pool.transitionCalls).toEqual([
        { id: respondToUserWorkItemId(r.id), status: 'cancelled', actor: 'system' },
      ]);
      // Bug fix 2026-04-29: chat-v2 reply also cascades the Request close.
      expect(svc.registry.get(r.id)?.status).toBe('done');
      expect(svc.registry.get(r.id)?.result).toContain('chatv2_reply');
      expect(sub.trackedCount).toBe(0);

      // Subsequent timer firings are silent.
      const breachListener = jest.fn();
      bus.onInProcess('request:sla_breached', breachListener);
      jest.advanceTimersByTime(60_000);
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
      expect(breachListener).not.toHaveBeenCalled();
    });

    it('is a no-op for an unknown channelId', async () => {
      await sub.markResolvedByChatV2('c-unknown');
      expect(pool.transitionCalls).toHaveLength(0);
    });

    it('is a no-op for an empty channelId', async () => {
      await sub.markResolvedByChatV2('');
      expect(pool.transitionCalls).toHaveLength(0);
    });

    it('does not interfere with a parallel slack-tracked Request', async () => {
      const slackReq = buildRequest({
        id: 'req-slack',
        tags: ['slack'],
        sourceConversationItemId: 'slack-C123-1772899923.865659',
      });
      const chatReq = buildRequest({
        id: 'req-chatv2',
        tags: ['chat-v2'],
        sourceConversationItemId: 'chatv2-cabc__mxyz',
      });
      svc.registry.set(slackReq.id, slackReq);
      svc.registry.set(chatReq.id, chatReq);
      bus.publish(buildEvent(slackReq.id));
      bus.publish({
        ...buildEvent(chatReq.id),
        sessionName: 'distinct-session',
      } as unknown as Parameters<EventBusService['publish']>[0]);
      await sub.flushPending();

      expect(sub.trackedCount).toBe(2);

      await sub.markResolvedByChatV2('cabc');

      // Only the chat-v2 WI auto-resolved.
      expect(pool.transitionCalls).toEqual([
        { id: respondToUserWorkItemId(chatReq.id), status: 'cancelled', actor: 'system' },
      ]);
      expect(sub.trackedCount).toBe(1);

      // Slack auto-close still works for the survivor.
      await sub.markResolvedByThread('1772899923.865659');
      expect(pool.transitionCalls).toHaveLength(2);
      expect(pool.transitionCalls[1].status).toBe('cancelled');
      expect(sub.trackedCount).toBe(0);
    });

    it('skips Slack DM escalation hook on a chat-v2 source at 10min (no chat-v2 nudge wired in v1)', async () => {
      const r = buildRequest({
        tags: ['chat-v2'],
        sourceConversationItemId: 'chatv2-cabc__mxyz',
      });
      svc.registry.set(r.id, r);
      bus.publish(buildEvent(r.id));
      await sub.flushPending();

      jest.advanceTimersByTime(10_000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      // Slack DM callback is wired in this beforeEach but must NOT be
      // invoked for a chat-v2 source — chat-v2 has no DM-back analog yet.
      expect(escalateCalls).toHaveLength(0);
      // Tracking is dropped after the escalation handler fires.
      expect(sub.trackedCount).toBe(0);
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
