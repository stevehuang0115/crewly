/**
 * Tests for ReconcilerService
 *
 * @module services/reconciler/reconciler.service.test
 */

import { ReconcilerService } from './reconciler.service.js';
import type { ReconcilerDataProvider } from './reconciler.service.js';
import { createWorkItem, createRequest, createTaskClaim } from '../../types/v2/index.js';
import type { WorkItem, Request, TaskClaim, ReconcileCorrection, WakeAction } from '../../types/v2/index.js';
import type { AgentHealth } from './reconcile-rules.js';

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
  });

  // -----------------------------------------------------------------------
  // Hybrid Wake (H3)
  // -----------------------------------------------------------------------
  describe('Hybrid Wake', () => {
    const THREE_MIN_AGO = new Date(Date.now() - 3 * 60_000).toISOString();

    it('should execute wake actions for unclaimed tasks with dormant agents', async () => {
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
      const poolItem = makeWorkItem({
        status: 'queued',
        createdAt: THREE_MIN_AGO,
        type: 'delegate',
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
});
