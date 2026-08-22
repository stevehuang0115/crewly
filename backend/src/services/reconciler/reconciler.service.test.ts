/**
 * Tests for ReconcilerService
 *
 * @module services/reconciler/reconciler.service.test
 */

import { ReconcilerService } from './reconciler.service.js';
import type { ReconcilerDataProvider } from './reconciler.service.js';
import { createWorkItem, createRequest, createTaskClaim, isValidWorkItemTransition } from '../../types/v2/index.js';
import type { WorkItem, WorkItemStatus, Request, TaskClaim, ReconcileCorrection, WakeAction } from '../../types/v2/index.js';
import type { AgentHealth } from './reconcile-rules.js';
import {
  WORK_ITEM_STATUSES,
  WORK_ITEM_TRANSITIONS,
  DISPOSITION_METADATA_KEY,
} from '../../types/v2/work-item.types.js';

// ---------------------------------------------------------------------------
// Mock settings service for maxConcurrentAgents tests
// ---------------------------------------------------------------------------

const mockGetSettings = jest.fn().mockResolvedValue({
  general: { maxConcurrentAgents: 10 },
});

jest.mock('../settings/index.js', () => ({
  getSettingsService: () => ({
    getSettings: mockGetSettings,
  }),
}));

// ---------------------------------------------------------------------------
// Mock escalation router
//
// `enforceVerification` dynamically imports EscalationRouterService to escalate
// overdue `done_by_worker` items. Stub it so the verification-enforcement
// invariant is observable (and so the real singleton is never constructed).
// ---------------------------------------------------------------------------

const mockEscalateUnverified = jest.fn().mockResolvedValue(undefined);

jest.mock('../v3/escalation-router.service.js', () => ({
  EscalationRouterService: {
    getInstance: () => ({
      escalateUnverifiedWorkItem: mockEscalateUnverified,
    }),
  },
}));

// `disposeStrandedWorkItems` dynamically imports TaskPoolService to run the
// disposition funnel. Stub it so the safety net is observable without standing
// up the real pool singleton.
const mockDisposeFailedWorkItem = jest.fn().mockResolvedValue({ kind: 'terminal' });

jest.mock('../task-pool/task-pool.service.js', () => ({
  TaskPoolService: {
    getInstance: () => ({
      disposeFailedWorkItem: mockDisposeFailedWorkItem,
    }),
  },
}));

// ---------------------------------------------------------------------------
// Mock Data Provider
// ---------------------------------------------------------------------------

function createMockProvider(overrides: Partial<ReconcilerDataProvider> = {}): ReconcilerDataProvider {
  return {
    getActiveWorkItems: jest.fn().mockResolvedValue([]),
    getActiveRequests: jest.fn().mockResolvedValue([]),
    getActiveClaims: jest.fn().mockResolvedValue([]),
    getAgentHealthMap: jest.fn().mockResolvedValue(new Map()),
    getWorkItemsForRequest: jest.fn().mockResolvedValue([]),
    applyCorrection: jest.fn().mockResolvedValue(undefined),
    releaseToPool: jest.fn().mockResolvedValue(undefined),
    requeueWorkItem: jest.fn().mockResolvedValue(undefined),
    markClaimExpiring: jest.fn().mockResolvedValue(undefined),
    revokeClaimAndRelease: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    ...createWorkItem({ type: 'delegate', owner: 'agent', title: 'Test', target: 'agent-1' }),
    ...overrides,
  };
}

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    ...createRequest({ sourceConversationItemId: 'conv-1', title: 'Test', description: 'Test desc' }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ReconcilerService', () => {
  let service: ReconcilerService;
  let provider: ReconcilerDataProvider;

  beforeEach(() => {
    jest.useFakeTimers();
    provider = createMockProvider();
    service = new ReconcilerService(provider, {
      fastLoopIntervalMs: 10_000,
      fullLoopIntervalMs: 60_000,
    });
    // Reset settings mock to default
    mockGetSettings.mockResolvedValue({
      general: { maxConcurrentAgents: 10 },
    });
    mockEscalateUnverified.mockClear();
    mockDisposeFailedWorkItem.mockClear();
  });

  afterEach(() => {
    service.stop();
    jest.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------
  describe('start / stop', () => {
    it('should start and stop without error', () => {
      expect(() => service.start()).not.toThrow();
      expect(() => service.stop()).not.toThrow();
    });

    it('should stop previous loops when starting again', () => {
      service.start();
      expect(() => service.start()).not.toThrow();
      service.stop();
    });
  });

  // -----------------------------------------------------------------------
  // runFull
  // -----------------------------------------------------------------------
  describe('runFull', () => {
    it('should return a ReconcileResult with type full', async () => {
      const result = await service.runFull();
      expect(result.type).toBe('full');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should detect stuck WorkItems with dead agents', async () => {
      const wi = makeWorkItem({
        status: 'running',
        target: 'agent-dead',
        startedAt: new Date().toISOString(),
      });
      const agentMap = new Map<string, AgentHealth>([
        ['agent-dead', { sessionName: 'agent-dead', status: 'inactive' }],
      ]);

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([wi]),
        getAgentHealthMap: jest.fn().mockResolvedValue(agentMap),
      });
      service = new ReconcilerService(provider);

      const result = await service.runFull();
      expect(result.workItemsTimedOut).toBe(1);
      expect(result.corrections.length).toBeGreaterThan(0);
      expect(provider.applyCorrection).toHaveBeenCalled();
    });

    it('should reconcile Request status when all WorkItems done', async () => {
      const request = makeRequest({ status: 'running', workItemIds: ['wi-1'] });
      const wi = makeWorkItem({ id: 'wi-1', status: 'done' });

      provider = createMockProvider({
        getActiveRequests: jest.fn().mockResolvedValue([request]),
        getWorkItemsForRequest: jest.fn().mockResolvedValue([wi]),
      });
      service = new ReconcilerService(provider);

      const result = await service.runFull();
      expect(result.requestsUpdated).toBe(1);
    });

    it('should detect orphan WorkItems', async () => {
      const parent = makeWorkItem({ id: 'parent-1', status: 'cancelled' });
      const child = makeWorkItem({ id: 'child-1', status: 'running', parentWorkItemId: 'parent-1' });

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([parent, child]),
      });
      service = new ReconcilerService(provider);

      const result = await service.runFull();
      expect(result.staleItemsCleaned).toBeGreaterThan(0);
    });

    it('counts a TTL-cancelled item in staleItemsCleaned but NOT a TTL auto-verified one', async () => {
      // `staleItemsCleaned` must mean exactly one thing: work that was
      // DISCARDED. The TTL rule produces two opposite outcomes —
      // `running → cancelled` (discarded) and `done_by_worker → verified`
      // (the 24h implicit-acceptance fallback, i.e. ACCEPTED). Summing the
      // old combined `ttlExpiredCount` reported the accepted item to
      // operators as thrown away.
      const now = Date.now();
      const accepted = makeWorkItem({
        id: 'ttl-accepted',
        status: 'done_by_worker',
        createdAt: new Date(now - 25 * 3600000).toISOString(),
      });
      const discarded = makeWorkItem({
        id: 'ttl-discarded',
        status: 'running',
        createdAt: new Date(now - 25 * 3600000).toISOString(),
      });

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([accepted, discarded]),
      });
      service = new ReconcilerService(provider);

      const result = await service.runFull();

      // Exactly one cleaned item: the cancelled one. The auto-verified one
      // is outside this metric.
      expect(result.staleItemsCleaned).toBe(1);

      // ...but it is NOT silently dropped — the acceptance is still in the
      // audit trail with its true semantics.
      const acceptedCorrection = result.corrections.find(
        (c) => c.entityId === 'ttl-accepted' && c.newState === 'verified',
      );
      expect(acceptedCorrection).toBeDefined();
      expect(result.corrections.find((c) => c.entityId === 'ttl-discarded' && c.newState === 'cancelled'))
        .toBeDefined();
    });

    it('should detect recoverable blocked WorkItems', async () => {
      const wi = makeWorkItem({
        status: 'blocked',
        target: 'agent-1',
        retryCount: 0,
        maxRetries: 3,
      });
      const agentMap = new Map<string, AgentHealth>([
        ['agent-1', { sessionName: 'agent-1', status: 'active', lastSeenAt: new Date().toISOString() }],
      ]);

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([wi]),
        getAgentHealthMap: jest.fn().mockResolvedValue(agentMap),
      });
      service = new ReconcilerService(provider);

      const result = await service.runFull();
      expect(result.workItemsRequeued).toBe(1);
      expect(provider.requeueWorkItem).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockRejectedValue(new Error('DB connection failed')),
      });
      service = new ReconcilerService(provider);

      const result = await service.runFull();
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('DB connection failed');
    });

    it('should not run concurrently', async () => {
      // Make the data provider slow
      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockImplementation(
          () => new Promise(resolve => setTimeout(() => resolve([]), 100)),
        ),
      });
      service = new ReconcilerService(provider);

      // Start two concurrent runs
      jest.useRealTimers();
      const [result1, result2] = await Promise.all([
        service.runFull(),
        service.runFull(),
      ]);
      jest.useFakeTimers();

      // One should be empty (skipped)
      const totalCorrections = result1.corrections.length + result2.corrections.length;
      // At least one ran; the second got skipped (empty result)
      expect(result1.type).toBe('full');
      expect(result2.type).toBe('full');
    });
  });

  // -----------------------------------------------------------------------
  // runFast
  // -----------------------------------------------------------------------
  describe('runFast', () => {
    it('should return a ReconcileResult with type fast', async () => {
      const result = await service.runFast();
      expect(result.type).toBe('fast');
    });

    it('should detect expired claims', async () => {
      const claim = createTaskClaim({ workItemId: 'wi-1', agentId: 'agent-1' });
      const expiredClaim: TaskClaim = {
        ...claim,
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      };

      provider = createMockProvider({
        getActiveClaims: jest.fn().mockResolvedValue([expiredClaim]),
      });
      service = new ReconcilerService(provider);

      const result = await service.runFast();
      expect(result.corrections.length).toBeGreaterThan(0);
    });

    it('should check running WorkItems for stuck agents', async () => {
      const wi = makeWorkItem({
        status: 'running',
        target: 'agent-dead',
        startedAt: new Date().toISOString(),
      });
      const agentMap = new Map<string, AgentHealth>([
        ['agent-dead', { sessionName: 'agent-dead', status: 'inactive' }],
      ]);

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([wi]),
        getAgentHealthMap: jest.fn().mockResolvedValue(agentMap),
      });
      service = new ReconcilerService(provider);

      const result = await service.runFast();
      expect(result.workItemsTimedOut).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // reconcileRequest
  // -----------------------------------------------------------------------
  describe('reconcileRequest', () => {
    it('should reconcile a specific request', async () => {
      const request = makeRequest({ id: 'req-1', status: 'running' });
      const wi = makeWorkItem({ id: 'wi-1', status: 'done' });

      provider = createMockProvider({
        getActiveRequests: jest.fn().mockResolvedValue([request]),
        getWorkItemsForRequest: jest.fn().mockResolvedValue([wi]),
      });
      service = new ReconcilerService(provider);

      const result = await service.reconcileRequest('req-1');
      expect(result.type).toBe('targeted_request');
      expect(result.requestsUpdated).toBe(1);
    });

    it('should do nothing if request not found', async () => {
      provider = createMockProvider({
        getActiveRequests: jest.fn().mockResolvedValue([]),
      });
      service = new ReconcilerService(provider);

      const result = await service.reconcileRequest('nonexistent');
      expect(result.requestsUpdated).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // getStatus
  // -----------------------------------------------------------------------
  describe('getStatus', () => {
    it('should return correct initial status', () => {
      const status = service.getStatus();
      expect(status.isRunning).toBe(false);
      expect(status.totalPasses).toBe(0);
      expect(status.totalCorrections).toBe(0);
      expect(status.lastResult).toBeUndefined();
    });

    it('should update after a reconcile pass', async () => {
      await service.runFull();
      const status = service.getStatus();
      expect(status.totalPasses).toBe(1);
      expect(status.lastResult).toBeDefined();
      expect(status.lastResult!.type).toBe('full');
    });

    it('should show next reconcile times when started', () => {
      service.start();
      const status = service.getStatus();
      expect(status.nextFullReconcileAt).toBeDefined();
      expect(status.nextFastReconcileAt).toBeDefined();
    });

    it('should not show next reconcile times when stopped', () => {
      const status = service.getStatus();
      expect(status.nextFullReconcileAt).toBeUndefined();
      expect(status.nextFastReconcileAt).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // getHistory
  // -----------------------------------------------------------------------
  describe('getHistory', () => {
    it('should return empty array initially', () => {
      expect(service.getHistory()).toEqual([]);
    });

    it('should return results newest first', async () => {
      await service.runFull();
      await service.runFast();

      const history = service.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].type).toBe('fast');  // newest first
      expect(history[1].type).toBe('full');
    });

    it('should respect limit parameter', async () => {
      await service.runFull();
      await service.runFull();
      await service.runFull();

      const history = service.getHistory(2);
      expect(history).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // updateConfig
  // -----------------------------------------------------------------------
  describe('updateConfig', () => {
    it('should update config values', () => {
      service.updateConfig({ workItemTimeoutMs: 300_000 });
      const status = service.getStatus();
      expect(status.config.workItemTimeoutMs).toBe(300_000);
    });

    it('should restart loops when interval changes', () => {
      service.start();
      const stopSpy = jest.spyOn(service, 'stop');
      const startSpy = jest.spyOn(service, 'start');

      service.updateConfig({ fastLoopIntervalMs: 5_000 });

      expect(stopSpy).toHaveBeenCalled();
      expect(startSpy).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Correction Application
  // -----------------------------------------------------------------------
  describe('correction application', () => {
    it('should revoke claims via ClaimService when grace period exceeded', async () => {
      const claim = createTaskClaim({ workItemId: 'wi-1', agentId: 'agent-1' });
      const expiringClaim: TaskClaim = {
        ...claim,
        status: 'expiring',
        leaseExpiresAt: new Date(Date.now() - 200_000).toISOString(),
      };

      provider = createMockProvider({
        getActiveClaims: jest.fn().mockResolvedValue([expiringClaim]),
      });
      service = new ReconcilerService(provider);

      const result = await service.runFast();
      expect(provider.revokeClaimAndRelease).toHaveBeenCalledWith(
        expiringClaim.id,
        expect.stringContaining('Grace period exceeded'),
      );
      expect(result.claimsRevoked).toBe(1);
    });

    it('should mark claims as expiring when lease expired', async () => {
      const claim = createTaskClaim({ workItemId: 'wi-1', agentId: 'agent-1' });
      const expiredClaim: TaskClaim = {
        ...claim,
        status: 'active',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      };

      provider = createMockProvider({
        getActiveClaims: jest.fn().mockResolvedValue([expiredClaim]),
      });
      service = new ReconcilerService(provider);

      await service.runFast();
      expect(provider.markClaimExpiring).toHaveBeenCalledWith(expiredClaim.id);
    });

    it('should requeue recovered blocked WorkItems', async () => {
      const wi = makeWorkItem({
        status: 'blocked',
        target: 'agent-1',
        retryCount: 0,
        maxRetries: 3,
      });
      const agentMap = new Map<string, AgentHealth>([
        ['agent-1', { sessionName: 'agent-1', status: 'active', lastSeenAt: new Date().toISOString() }],
      ]);

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([wi]),
        getAgentHealthMap: jest.fn().mockResolvedValue(agentMap),
      });
      service = new ReconcilerService(provider);

      await service.runFull();
      expect(provider.requeueWorkItem).toHaveBeenCalledWith(wi.id);
      // Steve 2026-05-15 dogfood: applyCorrection MUST NOT also run for
      // blocked→queued corrections, otherwise the WI is flipped to
      // queued first and requeueWorkItem's call to `releaseBack` throws
      // "Cannot release WorkItem: status must be 'running' or 'blocked',
      // got 'queued'". requeueWorkItem owns the full lifecycle (claim
      // release + status flip + retryCount bump + startedAt clear).
      expect(provider.applyCorrection).not.toHaveBeenCalled();
    });

    it('dedupes corrections sharing entity+newState in one tick (Steve 2026-05-15)', async () => {
      // Repro: WI 5afef18f at 21:55:49 — both `detectRecoverableWorkItems`
      // (agent back online) AND `detectDependencyResolvedWorkItems`
      // (dependencies satisfied) emitted blocked→queued for the same
      // WI in the same tick. First requeueWorkItem succeeded; second
      // threw "Cannot release ... got 'queued'" because the WI was no
      // longer in `blocked`. Dedup must skip the second.
      provider = createMockProvider({});
      service = new ReconcilerService(provider);

      const correction = {
        entityType: 'work_item' as const,
        entityId: 'wi-1',
        previousState: 'blocked',
        newState: 'queued',
        reason: 'agent back online',
        evidence: '',
        timestamp: new Date().toISOString(),
        id: 'c1',
      };
      const duplicate = { ...correction, id: 'c2', reason: 'deps resolved' };

      await (service as any).applyCorrections([correction, duplicate], {
        corrections: [],
        workItemsRequeued: 0,
        claimsRevoked: 0,
        errors: [],
        staleItemsCleaned: 0,
        workItemsTimedOut: 0,
      });

      // Only ONE requeueWorkItem call despite two corrections — dedup wins.
      expect(provider.requeueWorkItem).toHaveBeenCalledTimes(1);
      expect(provider.requeueWorkItem).toHaveBeenCalledWith('wi-1');
    });

    it('should handle correction application errors gracefully', async () => {
      const wi = makeWorkItem({
        status: 'running',
        target: 'agent-dead',
        startedAt: new Date().toISOString(),
      });
      const agentMap = new Map<string, AgentHealth>([
        ['agent-dead', { sessionName: 'agent-dead', status: 'inactive' }],
      ]);

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([wi]),
        getAgentHealthMap: jest.fn().mockResolvedValue(agentMap),
        applyCorrection: jest.fn().mockRejectedValue(new Error('Write failed')),
      });
      service = new ReconcilerService(provider);

      const result = await service.runFull();
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Write failed');
    });

    // ---------------------------------------------------------------------
    // Request 13548bd5 (2026-08-20) — full-loop-cycle guard.
    //
    // The unit tests in reconcile-rules.test.ts prove the TTL picker never
    // NAMES an illegal target. This proves the assembled loop never ATTEMPTS
    // one: the provider below enforces the real WORK_ITEM_TRANSITIONS matrix
    // and throws the exact error string TaskPoolService.transitionStatus
    // throws, so any illegal correction surfaces in `result.errors`.
    //
    // Before the fix, the `rejected` and `failed` items in this pool each
    // produced `Invalid status transition ... → cancelled` on EVERY pass,
    // forever.
    // ---------------------------------------------------------------------
    it('applies a full reconcile cycle with zero Invalid status transition errors', async () => {
      const staleAt = new Date(Date.now() - 96 * 3600 * 1000).toISOString();
      const pool = [
        makeWorkItem({ id: 'wi-rejected', status: 'rejected', createdAt: staleAt }),
        // Retry-EXHAUSTED: detectRetryableFailedWorkItems deliberately
        // ignores it, so this item reaches the TTL rule — the exact case that
        // used to throw on every pass and strand the item forever.
        makeWorkItem({
          id: 'wi-failed', status: 'failed', createdAt: staleAt,
          retryCount: 3, maxRetries: 3,
        }),
        makeWorkItem({ id: 'wi-dbw', status: 'done_by_worker', createdAt: staleAt }),
        makeWorkItem({ id: 'wi-queued', status: 'queued', createdAt: staleAt }),
        makeWorkItem({ id: 'wi-running', status: 'running', createdAt: staleAt }),
        makeWorkItem({ id: 'wi-blocked', status: 'blocked', createdAt: staleAt }),
        makeWorkItem({ id: 'wi-escalated', status: 'escalated', createdAt: staleAt }),
        makeWorkItem({ id: 'wi-proposed', status: 'proposed', createdAt: staleAt }),
        makeWorkItem({ id: 'wi-accepted', status: 'accepted', createdAt: staleAt }),
        makeWorkItem({ id: 'wi-scheduled', status: 'scheduled', createdAt: staleAt }),
      ];
      const byId = new Map(pool.map((wi) => [wi.id, wi]));

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue(pool),
        // Enforce the real state machine, exactly as TaskPoolService does.
        applyCorrection: jest.fn(async (correction: ReconcileCorrection) => {
          if (correction.entityType !== 'work_item') return;
          const item = byId.get(correction.entityId);
          if (!item) return;
          // `ReconcileCorrection.newState` is typed `string`, not
          // `WorkItemStatus` — a weak spot that lets an illegal status reach
          // the pool untyped. Narrow explicitly here so this fake enforces
          // the same contract TaskPoolService.transitionStatus does.
          const next = correction.newState as WorkItemStatus;
          if (!isValidWorkItemTransition(item.status, next)) {
            throw new Error(
              `Invalid status transition for WorkItem ${correction.entityId}: ` +
              `${item.status} → ${next}`,
            );
          }
          item.status = next;
        }),
      });
      service = new ReconcilerService(provider);

      const result = await service.runFull();

      expect(result.errors.filter((e) => e.includes('Invalid status transition')))
        .toEqual([]);
      expect(result.errors).toEqual([]);

      // The two audit-record statuses are left untouched by the sweeper...
      expect(byId.get('wi-rejected')!.status).toBe('rejected');
      expect(byId.get('wi-failed')!.status).toBe('failed');
      // (a retry-ELIGIBLE failed item is a different path — the retry rule
      // legally requeues it; see the dedicated case below.)
      // ...while the genuinely stale in-flight work is still cleaned up.
      expect(byId.get('wi-dbw')!.status).toBe('verified');
    });

    // ---------------------------------------------------------------------
    // The `runFull` step-3d invariant, asserted rather than commented.
    //
    // reconciler.service.ts orders `enforceVerification` BEFORE the pruning
    // pass so unverified work gets a real verdict opportunity and is never
    // silently auto-accepted. That ordering was load-bearing but untested:
    // commit 469a3a21 let the pruning pass auto-`verified` a `done_by_worker`
    // item via the shared TTL picker, which bypassed the guard entirely and
    // no test noticed.
    // ---------------------------------------------------------------------
    describe('unverified work is never silently auto-accepted (runFull step 3d)', () => {
      /** Reads a WorkItem's current status without a non-null assertion. */
      function statusOf(byId: Map<string, WorkItem>, id: string): WorkItemStatus | undefined {
        return byId.get(id)?.status;
      }

      /** Builds a provider that enforces the real WORK_ITEM_TRANSITIONS matrix. */
      function strictProvider(pool: WorkItem[], byId: Map<string, WorkItem>): ReconcilerDataProvider {
        return createMockProvider({
          getActiveWorkItems: jest.fn().mockResolvedValue(pool),
          applyCorrection: jest.fn(async (correction: ReconcileCorrection) => {
            if (correction.entityType !== 'work_item') return;
            const item = byId.get(correction.entityId);
            if (!item) return;
            const next = correction.newState as WorkItemStatus;
            if (!isValidWorkItemTransition(item.status, next)) {
              throw new Error(
                `Invalid status transition for WorkItem ${correction.entityId}: ` +
                `${item.status} → ${next}`,
              );
            }
            item.status = next;
          }),
        });
      }

      it('REGRESSION: a ~1s-old done_by_worker child under a permanently-failed parent is not verified', async () => {
        const parent = makeWorkItem({
          id: 'parent-dead', status: 'failed', retryCount: 3, maxRetries: 3,
        });
        const child = makeWorkItem({
          id: 'child-unreviewed',
          status: 'done_by_worker',
          parentWorkItemId: 'parent-dead',
          createdAt: new Date(Date.now() - 1000).toISOString(),
        });
        const pool = [parent, child];
        const byId = new Map(pool.map((wi) => [wi.id, wi]));

        provider = strictProvider(pool, byId);
        service = new ReconcilerService(provider);

        const result = await service.runFull();

        expect(result.errors).toEqual([]);
        // The whole point: TL-unreviewed output must survive the pass intact.
        expect(statusOf(byId, 'child-unreviewed')).toBe('done_by_worker');
        expect(result.corrections.filter((c) => c.entityId === 'child-unreviewed'))
          .toEqual([]);
        expect(result.corrections.map((c) => c.newState)).not.toContain('verified');
      });

      it('escalates for a verdict BEFORE the pruning pass can touch the item', async () => {
        // 3h old: past DEFAULT_VERIFY_ESCALATE_MS (2h) so the guard fires,
        // but nowhere near the 24h TTL, so nothing may legitimately expire it.
        const child = makeWorkItem({
          id: 'wi-awaiting',
          status: 'done_by_worker',
          createdAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
        });
        const pool = [child];
        const byId = new Map(pool.map((wi) => [wi.id, wi]));

        provider = strictProvider(pool, byId);
        service = new ReconcilerService(provider);

        const result = await service.runFull();

        expect(result.errors).toEqual([]);
        // Guard ran and asked for a real verdict...
        expect(mockEscalateUnverified).toHaveBeenCalledTimes(1);
        expect(mockEscalateUnverified.mock.calls[0][0]).toMatchObject({ id: 'wi-awaiting' });
        // ...and the item is still awaiting one, not auto-accepted.
        expect(statusOf(byId, 'wi-awaiting')).toBe('done_by_worker');
        expect(provider.applyCorrection).not.toHaveBeenCalled();
      });

      it('the escalation guard runs before any correction is applied', async () => {
        // Ordering is the invariant. Assert it on the call graph, not by
        // reading the source.
        const stale = new Date(Date.now() - 96 * 3600 * 1000).toISOString();
        const pool = [
          makeWorkItem({ id: 'wi-dbw', status: 'done_by_worker', createdAt: stale }),
          makeWorkItem({ id: 'wi-running', status: 'running', createdAt: stale }),
        ];
        const byId = new Map(pool.map((wi) => [wi.id, wi]));

        provider = strictProvider(pool, byId);
        service = new ReconcilerService(provider);

        await service.runFull();

        expect(mockEscalateUnverified).toHaveBeenCalled();
        const applyMock = provider.applyCorrection as jest.Mock;
        expect(applyMock).toHaveBeenCalled();
        expect(mockEscalateUnverified.mock.invocationCallOrder[0])
          .toBeLessThan(applyMock.mock.invocationCallOrder[0]);
      });

      it('only the 24h TTL rule may produce a `verified` correction', async () => {
        // Liveness half: TTL's implicit-acceptance fallback is intentional and
        // must still work. Soundness half is the test above — a fresh item
        // under a dead ancestor gets nothing.
        const stale = new Date(Date.now() - 96 * 3600 * 1000).toISOString();
        const pool = [makeWorkItem({ id: 'wi-ancient', status: 'done_by_worker', createdAt: stale })];
        const byId = new Map(pool.map((wi) => [wi.id, wi]));

        provider = strictProvider(pool, byId);
        service = new ReconcilerService(provider);

        const result = await service.runFull();

        const verified = result.corrections.filter((c) => c.newState === 'verified');
        expect(verified).toHaveLength(1);
        expect(verified[0].entityId).toBe('wi-ancient');
        expect(verified[0].reason).toContain('TTL');
        expect(statusOf(byId, 'wi-ancient')).toBe('verified');
      });
    });

    it('stays error-free across repeated passes (the bug recurred every pass)', async () => {
      const staleAt = new Date(Date.now() - 96 * 3600 * 1000).toISOString();
      const pool = [
        makeWorkItem({ id: 'wi-rejected', status: 'rejected', createdAt: staleAt }),
        makeWorkItem({
          id: 'wi-failed', status: 'failed', createdAt: staleAt,
          retryCount: 3, maxRetries: 3,
        }),
      ];
      const byId = new Map(pool.map((wi) => [wi.id, wi]));

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue(pool),
        applyCorrection: jest.fn(async (correction: ReconcileCorrection) => {
          const item = byId.get(correction.entityId);
          if (!item) return;
          // `ReconcileCorrection.newState` is typed `string`, not
          // `WorkItemStatus` — a weak spot that lets an illegal status reach
          // the pool untyped. Narrow explicitly here so this fake enforces
          // the same contract TaskPoolService.transitionStatus does.
          const next = correction.newState as WorkItemStatus;
          if (!isValidWorkItemTransition(item.status, next)) {
            throw new Error(
              `Invalid status transition for WorkItem ${correction.entityId}: ` +
              `${item.status} → ${next}`,
            );
          }
          item.status = next;
        }),
      });
      service = new ReconcilerService(provider);

      for (let pass = 0; pass < 3; pass++) {
        const result = await service.runFull();
        expect(result.errors).toEqual([]);
      }
      // Nothing to correct: both are terminal-for-practical-purposes audit
      // records with no legal terminal edge. Previously each pass produced
      // one doomed correction per item — 6 thrown errors across 3 passes.
      expect(provider.applyCorrection).not.toHaveBeenCalled();
    });

    it('still auto-retries a retry-ELIGIBLE failed item (legal failed → queued)', async () => {
      // Guard against over-correcting the fix: skipping `failed` in the TTL
      // rule must not disable the genuine retry path.
      const staleAt = new Date(Date.now() - 96 * 3600 * 1000).toISOString();
      const wi = makeWorkItem({
        id: 'wi-retryable', status: 'failed', createdAt: staleAt,
        retryCount: 0, maxRetries: 3,
      });
      const byId = new Map([[wi.id, wi]]);

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([wi]),
        applyCorrection: jest.fn(async (correction: ReconcileCorrection) => {
          const item = byId.get(correction.entityId);
          if (!item) return;
          // `ReconcileCorrection.newState` is typed `string`, not
          // `WorkItemStatus` — a weak spot that lets an illegal status reach
          // the pool untyped. Narrow explicitly here so this fake enforces
          // the same contract TaskPoolService.transitionStatus does.
          const next = correction.newState as WorkItemStatus;
          if (!isValidWorkItemTransition(item.status, next)) {
            throw new Error(
              `Invalid status transition for WorkItem ${correction.entityId}: ` +
              `${item.status} → ${next}`,
            );
          }
          item.status = next;
        }),
      });
      service = new ReconcilerService(provider);

      const result = await service.runFull();

      expect(result.errors).toEqual([]);
      expect(provider.applyCorrection).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: 'wi-retryable',
          previousState: 'failed',
          newState: 'queued',
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Hybrid Wake (H3)
  // -----------------------------------------------------------------------
  describe('Hybrid Wake', () => {
    const THREE_MIN_AGO = new Date(Date.now() - 3 * 60_000).toISOString();

    it('should execute wake actions for unclaimed tasks with dormant agents', async () => {
      // 2026-05-17 strict-target policy: wake only when wi.target matches a
      // wakable agent. Override the makeWorkItem default ('agent-1') to
      // point at the actual suspended agent in the map.
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: THREE_MIN_AGO,
        type: 'delegate',
        target: 'agent-suspended',
      });
      const agentMap = new Map<string, AgentHealth>([
        ['agent-suspended', {
          sessionName: 'agent-suspended',
          status: 'suspended',
          role: 'developer',
        }],
      ]);

      const executeWakeAction = jest.fn().mockResolvedValue(true);

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([wi]),
        getAgentHealthMap: jest.fn().mockResolvedValue(agentMap),
        executeWakeAction,
      });
      service = new ReconcilerService(provider);

      const result = await service.runFast();
      expect(executeWakeAction).toHaveBeenCalled();
      expect(result.agentsWoken).toBe(1);
      expect(result.wakeActions).toHaveLength(1);
      expect(result.wakeActions[0].strategy).toBe('rehydrate');
    });

    it('should not run wake logic when provider lacks executeWakeAction', async () => {
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: THREE_MIN_AGO,
        type: 'delegate',
      });
      const agentMap = new Map<string, AgentHealth>([
        ['agent-suspended', {
          sessionName: 'agent-suspended',
          status: 'suspended',
          role: 'developer',
        }],
      ]);

      // Default provider has no executeWakeAction
      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([wi]),
        getAgentHealthMap: jest.fn().mockResolvedValue(agentMap),
      });
      service = new ReconcilerService(provider);

      const result = await service.runFast();
      expect(result.agentsWoken).toBe(0);
      expect(result.wakeActions).toHaveLength(0);
    });

    it('should use getAvailablePoolItems when provided', async () => {
      // target-strict policy: WI must explicitly name the wakable agent.
      const poolItem = makeWorkItem({
        status: 'queued',
        createdAt: THREE_MIN_AGO,
        type: 'delegate',
        target: 'agent-off',
      });
      const agentMap = new Map<string, AgentHealth>([
        ['agent-off', {
          sessionName: 'agent-off',
          status: 'inactive',
          role: 'developer',
        }],
      ]);

      const getAvailablePoolItems = jest.fn().mockResolvedValue([poolItem]);
      const executeWakeAction = jest.fn().mockResolvedValue(true);

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([]),
        getAgentHealthMap: jest.fn().mockResolvedValue(agentMap),
        getAvailablePoolItems,
        executeWakeAction,
      });
      service = new ReconcilerService(provider);

      const result = await service.runFast();
      expect(getAvailablePoolItems).toHaveBeenCalled();
      expect(result.agentsWoken).toBe(1);
      expect(result.wakeActions[0].strategy).toBe('start');
    });

    it('should record error when wake action fails', async () => {
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: THREE_MIN_AGO,
        type: 'delegate',
      });
      const agentMap = new Map<string, AgentHealth>([
        ['agent-1', {
          sessionName: 'agent-1',
          status: 'suspended',
          role: 'developer',
        }],
      ]);

      const executeWakeAction = jest.fn().mockResolvedValue(false);

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([wi]),
        getAgentHealthMap: jest.fn().mockResolvedValue(agentMap),
        executeWakeAction,
      });
      service = new ReconcilerService(provider);

      const result = await service.runFast();
      expect(result.agentsWoken).toBe(0);
      expect(result.errors.some(e => e.includes('Wake action failed'))).toBe(true);
    });

    it('should handle wake action exceptions gracefully', async () => {
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: THREE_MIN_AGO,
        type: 'delegate',
      });
      const agentMap = new Map<string, AgentHealth>([
        ['agent-1', {
          sessionName: 'agent-1',
          status: 'suspended',
          role: 'developer',
        }],
      ]);

      const executeWakeAction = jest.fn().mockRejectedValue(new Error('Connection timeout'));

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([wi]),
        getAgentHealthMap: jest.fn().mockResolvedValue(agentMap),
        executeWakeAction,
      });
      service = new ReconcilerService(provider);

      const result = await service.runFast();
      expect(result.agentsWoken).toBe(0);
      expect(result.errors.some(e => e.includes('Connection timeout'))).toBe(true);
    });

    it('should skip Hybrid Wake when active agents >= maxConcurrentAgents', async () => {
      // Set maxConcurrentAgents to 2
      mockGetSettings.mockResolvedValue({
        general: { maxConcurrentAgents: 2 },
      });

      const wi = makeWorkItem({
        status: 'queued',
        createdAt: THREE_MIN_AGO,
        type: 'delegate',
      });

      // Two active agents already at capacity
      const agentMap = new Map<string, AgentHealth>([
        ['agent-1', {
          sessionName: 'agent-1',
          status: 'active',
          role: 'developer',
        }],
        ['agent-2', {
          sessionName: 'agent-2',
          status: 'active',
          role: 'developer',
        }],
        ['agent-suspended', {
          sessionName: 'agent-suspended',
          status: 'suspended',
          role: 'developer',
        }],
      ]);

      const executeWakeAction = jest.fn().mockResolvedValue(true);

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([wi]),
        getAgentHealthMap: jest.fn().mockResolvedValue(agentMap),
        executeWakeAction,
      });
      service = new ReconcilerService(provider);

      const result = await service.runFast();

      // executeWakeAction should NOT have been called because we are at capacity
      expect(executeWakeAction).not.toHaveBeenCalled();
      expect(result.agentsWoken).toBe(0);
      expect(result.wakeActions).toHaveLength(0);
    });

    it('should allow Hybrid Wake when active agents < maxConcurrentAgents', async () => {
      // Set maxConcurrentAgents to 5 (plenty of room)
      mockGetSettings.mockResolvedValue({
        general: { maxConcurrentAgents: 5 },
      });

      // Item must be older than 5 min when active agents exist (effectiveThreshold)
      const TEN_MIN_AGO = new Date(Date.now() - 10 * 60_000).toISOString();
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: TEN_MIN_AGO,
        type: 'delegate',
      });

      // Only 1 active agent, well under the limit
      const agentMap = new Map<string, AgentHealth>([
        ['agent-1', {
          sessionName: 'agent-1',
          status: 'active',
          role: 'developer',
          teamId: 'team-1',
          memberId: 'member-1',
        } as AgentHealth],
        ['agent-suspended', {
          sessionName: 'agent-suspended',
          status: 'suspended',
          role: 'developer',
          teamId: 'team-1',
          memberId: 'member-2',
        } as AgentHealth],
      ]);

      const executeWakeAction = jest.fn().mockResolvedValue(true);

      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([wi]),
        getAvailablePoolItems: jest.fn().mockResolvedValue([wi]),
        getAgentHealthMap: jest.fn().mockResolvedValue(agentMap),
        executeWakeAction,
      });
      service = new ReconcilerService(provider);

      const result = await service.runFast();

      // executeWakeAction should be called because we have capacity
      expect(executeWakeAction).toHaveBeenCalled();
      expect(result.agentsWoken).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Self-heal fix #2 (2026-05-20): stale-queued WI broadcast
  // ---------------------------------------------------------------------------
  describe('stale-queued broadcast (task:queued_too_long)', () => {
    it('invokes broadcastStaleQueuedWIs for each WI past the staleness threshold', async () => {
      // Two stale WIs (>1h queued) and one fresh WI (just enqueued).
      const stale1 = makeWorkItem({
        id: 'wi-stale-1',
        status: 'queued',
        target: 'crewly-product-ella',
        owner: 'orchestrator',
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      });
      const stale2 = makeWorkItem({
        id: 'wi-stale-2',
        status: 'queued',
        target: 'crewly-support-sora',
        owner: 'orchestrator',
        createdAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      });
      const fresh = makeWorkItem({
        id: 'wi-fresh',
        status: 'queued',
        target: 'crewly-product-ella',
        owner: 'orchestrator',
        createdAt: new Date().toISOString(),
      });

      const broadcastStaleQueuedWIs = jest.fn();
      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([stale1, stale2, fresh]),
        broadcastStaleQueuedWIs,
      });
      service = new ReconcilerService(provider);

      await service.runFull();

      expect(broadcastStaleQueuedWIs).toHaveBeenCalledTimes(1);
      const broadcastArg = broadcastStaleQueuedWIs.mock.calls[0]![0] as Array<{
        id: string;
        target?: string;
        owner?: string;
        createdAt: string;
      }>;
      // Both stale WIs are included; fresh is not.
      const ids = broadcastArg.map((w) => w.id).sort();
      expect(ids).toEqual(['wi-stale-1', 'wi-stale-2']);
      // Target + owner are propagated so the subscriber can route.
      const stale1Entry = broadcastArg.find((w) => w.id === 'wi-stale-1');
      expect(stale1Entry?.target).toBe('crewly-product-ella');
      expect(stale1Entry?.owner).toBe('orchestrator');
    });

    it('skips broadcast when no WIs are stale', async () => {
      const fresh = makeWorkItem({
        id: 'wi-fresh',
        status: 'queued',
        target: 'agent-1',
        createdAt: new Date().toISOString(),
      });

      const broadcastStaleQueuedWIs = jest.fn();
      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([fresh]),
        broadcastStaleQueuedWIs,
      });
      service = new ReconcilerService(provider);

      await service.runFull();

      expect(broadcastStaleQueuedWIs).not.toHaveBeenCalled();
    });

    it('calls clearResolvedStuckWiDedup with the current queued-WI id set', async () => {
      const stale = makeWorkItem({
        id: 'wi-stale',
        status: 'queued',
        target: 'agent-1',
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      });
      const running = makeWorkItem({
        id: 'wi-running',
        status: 'running',
        target: 'agent-2',
        createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      });

      const clearResolvedStuckWiDedup = jest.fn();
      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([stale, running]),
        broadcastStaleQueuedWIs: jest.fn(),
        clearResolvedStuckWiDedup,
      });
      service = new ReconcilerService(provider);

      await service.runFull();

      expect(clearResolvedStuckWiDedup).toHaveBeenCalledTimes(1);
      const queuedIds = clearResolvedStuckWiDedup.mock.calls[0]![0] as Set<string>;
      expect(queuedIds.has('wi-stale')).toBe(true);
      // Running WI is NOT in the queued set — its presence would falsely
      // keep stuck-WI dedup state alive.
      expect(queuedIds.has('wi-running')).toBe(false);
    });

    it('falls back gracefully when the provider does not implement broadcast hooks', async () => {
      const stale = makeWorkItem({
        id: 'wi-stale',
        status: 'queued',
        target: 'agent-1',
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      });

      // No broadcastStaleQueuedWIs / clearResolvedStuckWiDedup on the provider.
      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([stale]),
      });
      service = new ReconcilerService(provider);

      // Must not throw.
      await expect(service.runFull()).resolves.toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // EVAL 5 — full-cycle invariant
  // -----------------------------------------------------------------------
  /**
   * One complete `runFull` over a pool holding every `WorkItemStatus` must
   * produce zero illegal transitions AND must not leave a strand behind.
   *
   * The per-rule invariant tests in `reconcile-rules.test.ts` already derive
   * their expectations from `WORK_ITEM_TRANSITIONS` and assert liveness plus
   * soundness. This is the cycle-level counterpart: rules that are individually
   * sound can still combine badly — #733 found exactly that, where the TTL rule
   * legitimately emitted `done_by_worker → verified` and the pruning pass then
   * treated the just-ACCEPTED parent as a dead ancestor.
   *
   * Both halves are asserted deliberately. Soundness alone passes just as
   * happily if every rule is gutted to do nothing, and "do nothing" is exactly
   * the state the reverted 469a3a21 rule left the codebase in.
   */
  describe('EVAL 5 — one full cycle produces no illegal transition and no surviving strand', () => {
    const HOUR = 3600 * 1000;

    /** One WorkItem in each status, all old enough to be actionable. */
    function seedEveryStatus(): WorkItem[] {
      const old = new Date(Date.now() - 48 * HOUR).toISOString();
      return WORK_ITEM_STATUSES.map((status) =>
        makeWorkItem({
          status,
          target: undefined, // no agent → no stuck-rule corrections to reason about
          createdAt: old,
          completedAt: old,
        }),
      );
    }

    it('soundness: every applied correction is a legal edge for the status it came from', async () => {
      const workItems = seedEveryStatus();
      const byId = new Map(workItems.map((wi) => [wi.id, wi]));
      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue(workItems),
      });
      service = new ReconcilerService(provider, {
        fastLoopIntervalMs: 10_000,
        fullLoopIntervalMs: 60_000,
      });

      const result = await service.runFull();

      const workItemCorrections = result.corrections.filter(
        (c) => c.entityType === 'work_item',
      );
      for (const c of workItemCorrections) {
        const source = byId.get(c.entityId);
        if (!source) continue;
        expect(
          WORK_ITEM_TRANSITIONS[source.status].has(c.newState as WorkItemStatus),
        ).toBe(true);
      }
    });

    it('liveness: the stranding statuses are handed to the funnel, and only those', async () => {
      const workItems = seedEveryStatus();
      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue(workItems),
      });
      service = new ReconcilerService(provider, {
        fastLoopIntervalMs: 10_000,
        fullLoopIntervalMs: 60_000,
      });

      await service.runFull();

      const disposedIds = mockDisposeFailedWorkItem.mock.calls.map(
        (call) => call[0] as string,
      );
      const expected = workItems
        .filter((wi) => wi.status === 'rejected' || wi.status === 'failed')
        .map((wi) => wi.id);

      expect(disposedIds.sort()).toEqual(expected.sort());
      // Non-empty, so "the rule did nothing" cannot pass this.
      expect(disposedIds).toHaveLength(2);
    });

    it('a strand that is already disposed is left alone on subsequent cycles', async () => {
      // Re-entrancy at cycle level: the funnel is idempotent, but the rule must
      // not keep handing the same item back to it every 60s either.
      const disposed = makeWorkItem({
        status: 'rejected',
        target: undefined,
        completedAt: new Date(Date.now() - 48 * HOUR).toISOString(),
        metadata: {
          [DISPOSITION_METADATA_KEY]: {
            kind: 'terminal',
            at: new Date().toISOString(),
            by: 'system',
            reason: 'already handled',
          },
        },
      });
      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue([disposed]),
      });
      service = new ReconcilerService(provider, {
        fastLoopIntervalMs: 10_000,
        fullLoopIntervalMs: 60_000,
      });

      await service.runFull();
      await service.runFull();

      expect(mockDisposeFailedWorkItem).not.toHaveBeenCalled();
    });

    it('a disposition failure does not abort the rest of the cycle', async () => {
      mockDisposeFailedWorkItem.mockRejectedValueOnce(new Error('pool down'));
      const workItems = seedEveryStatus();
      provider = createMockProvider({
        getActiveWorkItems: jest.fn().mockResolvedValue(workItems),
      });
      service = new ReconcilerService(provider, {
        fastLoopIntervalMs: 10_000,
        fullLoopIntervalMs: 60_000,
      });

      const result = await service.runFull();

      // Both strands still attempted; the throw is contained.
      expect(mockDisposeFailedWorkItem).toHaveBeenCalledTimes(2);
      expect(result).toBeDefined();
    });
  });
});
