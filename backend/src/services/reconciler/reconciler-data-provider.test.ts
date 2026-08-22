/**
 * Tests for LiveReconcilerDataProvider
 *
 * Validates that the live data provider correctly wires to real services
 * and implements the ReconcilerDataProvider interface.
 */


// Mock os module (non-configurable in Node.js, so jest.spyOn doesn't work)
const mockTotalmem = jest.fn(() => 16_000_000_000); // 16GB
const mockFreemem = jest.fn(() => 8_000_000_000);   // 8GB (50% used)
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  totalmem: () => mockTotalmem(),
  freemem: () => mockFreemem(),
}));

// Mock the platform-aware memory probe so the test's mockTotalmem/mockFreemem
// fully control isUnderMemoryPressure(). Without this jest.mock, on Darwin
// the production code routes through `readMacFreeMemBytes` (spawnSync vm_stat)
// instead of os.freemem, leaving the test mocks ineffective and these
// memory-pressure suites silently failing on Mac dev machines.
jest.mock('../core/system-health.util.js', () => {
  const os = jest.requireActual('os');
  const total = () => mockTotalmem();
  const free = () => mockFreemem();
  return {
    // Same constants as production (avoid magic numbers diverging).
    MEMORY_PRESSURE_SPAWN_THRESHOLD: 90,
    MEMORY_PRESSURE_MIN_FREE_MB: 300,
    getAvailableMemoryBytes: () => free(),
    isUnderMemoryPressure: () => {
      const t = total();
      const f = free();
      if (t === 0) return false;
      const usedPercent = ((t - f) / t) * 100;
      const freeMB = f / 1024 / 1024;
      return usedPercent >= 90 && freeMB < 300;
    },
    getMemoryStats: () => {
      const t = total();
      const f = free();
      return {
        totalMB: t / 1024 / 1024,
        freeMB: f / 1024 / 1024,
        usedPercent: t === 0 ? 0 : ((t - f) / t) * 100,
        // Best-effort fields the production stats object also carries.
        platform: os.platform(),
      };
    },
  };
});

// Mock all service dependencies before importing
jest.mock('../task-pool/task-pool.service.js', () => {
  const mockInstance = {
    getAllItems: jest.fn().mockResolvedValue([]),
    getAvailableItems: jest.fn().mockResolvedValue([]),
    getActiveClaims: jest.fn().mockResolvedValue([]),
    updateItemStatus: jest.fn().mockResolvedValue(undefined),
    markClaimExpiring: jest.fn().mockResolvedValue(undefined),
    releaseBack: jest.fn().mockResolvedValue(undefined),
    revokeAndRelease: jest.fn().mockResolvedValue(undefined),
    findWorkItem: jest.fn().mockResolvedValue(null),
    requeueAfterFailure: jest.fn().mockResolvedValue(undefined),
  };
  return {
    TaskPoolService: {
      getInstance: () => mockInstance,
      _mockInstance: mockInstance,
    },
  };
});

jest.mock('../v3/workitem-dispatch.subscriber.js', () => {
  const mockSubscriber = {
    redispatch: jest.fn().mockResolvedValue(true),
  };
  return {
    WorkItemDispatchSubscriber: {
      getInstance: () => mockSubscriber,
      _mockSubscriber: mockSubscriber,
    },
  };
});

jest.mock('../core/storage.service.js', () => {
  const mockStorage = {
    getTeams: jest.fn().mockResolvedValue([]),
    getOrchestratorStatus: jest.fn().mockResolvedValue(null),
  };
  return {
    StorageService: {
      getInstance: () => mockStorage,
      _mockStorage: mockStorage,
    },
  };
});

jest.mock('../agent/agent-suspend.service.js', () => {
  const mockSuspend = {
    isSuspended: jest.fn().mockReturnValue(false),
    rehydrateAgent: jest.fn().mockResolvedValue(true),
  };
  return {
    AgentSuspendService: {
      getInstance: () => mockSuspend,
      _mockSuspend: mockSuspend,
    },
  };
});

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

const mockRequestService = {
  listAll: jest.fn().mockResolvedValue([]),
  update: jest.fn().mockResolvedValue(undefined),
  getInstance: () => mockRequestService,
};

jest.mock('../v3/request.service.js', () => ({
  RequestService: {
    getInstance: () => mockRequestService,
  },
}));

// Mock the escalation router so applyCorrection's reconciler-driven failure
// hook (lazy-imported) can be asserted against without filesystem side effects.
const mockEscalationRouter = {
  escalateFailedWorkItem: jest.fn().mockResolvedValue('esc-1'),
};
jest.mock('../v3/escalation-router.service.js', () => ({
  EscalationRouterService: {
    getInstance: () => mockEscalationRouter,
  },
}));

import { LiveReconcilerDataProvider } from './reconciler-data-provider.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { StorageService } from '../core/storage.service.js';
import { AgentSuspendService } from '../agent/agent-suspend.service.js';
import { WorkItemDispatchSubscriber } from '../v3/workitem-dispatch.subscriber.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TaskClaim } from '../../types/v2/claim.types.js';
import type { WakeAction } from '../../types/v2/reconcile.types.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

// Access mock instances via type assertions
const mockPool = (TaskPoolService as any)._mockInstance;
const mockStorage = (StorageService as any)._mockStorage;
const mockSuspend = (AgentSuspendService as any)._mockSuspend;
const mockSubscriber = (WorkItemDispatchSubscriber as any)._mockSubscriber;

describe('LiveReconcilerDataProvider', () => {
  let provider: LiveReconcilerDataProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTotalmem.mockReturnValue(16_000_000_000);
    mockFreemem.mockReturnValue(8_000_000_000);
    provider = new LiveReconcilerDataProvider();
  });

  // -----------------------------------------------------------------------
  // getActiveWorkItems
  // -----------------------------------------------------------------------

  describe('getActiveWorkItems', () => {
    it('returns non-terminal work items', async () => {
      const items: Partial<WorkItem>[] = [
        { id: 'wi-1', status: 'queued' },
        { id: 'wi-2', status: 'running' },
        { id: 'wi-3', status: 'done' },
        { id: 'wi-4', status: 'cancelled' },
        { id: 'wi-5', status: 'blocked' },
      ];
      mockPool.getAllItems.mockResolvedValue(items);

      const result = await provider.getActiveWorkItems();

      expect(result).toHaveLength(3);
      expect(result.map((r: WorkItem) => r.id)).toEqual(['wi-1', 'wi-2', 'wi-5']);
    });

    it('returns empty on error', async () => {
      mockPool.getAllItems.mockRejectedValue(new Error('Pool unavailable'));

      const result = await provider.getActiveWorkItems();

      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getActiveRequests
  // -----------------------------------------------------------------------

  describe('getActiveRequests', () => {
    it('returns non-terminal requests from RequestService', async () => {
      const requests = [
        { id: 'req-1', status: 'open' },
        { id: 'req-2', status: 'running' },
        { id: 'req-3', status: 'done' },
        { id: 'req-4', status: 'cancelled' },
        { id: 'req-5', status: 'ready' },
      ];
      mockRequestService.listAll.mockResolvedValue(requests);

      const result = await provider.getActiveRequests();

      expect(result).toHaveLength(3);
      expect(result.map(r => r.id)).toEqual(['req-1', 'req-2', 'req-5']);
    });

    it('returns empty on error', async () => {
      mockRequestService.listAll.mockRejectedValue(new Error('Storage error'));
      const result = await provider.getActiveRequests();
      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getActiveClaims
  // -----------------------------------------------------------------------

  describe('getActiveClaims', () => {
    it('delegates to TaskPoolService', async () => {
      const claims: Partial<TaskClaim>[] = [
        { id: 'claim-1', status: 'active', agentId: 'agent-1' },
      ];
      mockPool.getActiveClaims.mockResolvedValue(claims);

      const result = await provider.getActiveClaims();

      expect(result).toEqual(claims);
      expect(mockPool.getActiveClaims).toHaveBeenCalledTimes(1);
    });

    // F-CYCLE7-3 (2026-05-07) — post-restart hydration safety.
    // Reproduces the prod 11:19→11:21Z error storm: when storage was
    // not yet hydrated, the inner pool method threw "Cannot read
    // properties of undefined (reading 'filter')" every 10s.
    describe('F-CYCLE7-3: post-restart null-safety', () => {
      it('returns [] without throwing when pool returns undefined (pre-hydration)', async () => {
        mockPool.getActiveClaims.mockResolvedValue(undefined as any);

        const result = await provider.getActiveClaims();

        expect(result).toEqual([]);
      });

      it('returns [] without throwing when pool returns null', async () => {
        mockPool.getActiveClaims.mockResolvedValue(null as any);

        const result = await provider.getActiveClaims();

        expect(result).toEqual([]);
      });

      it('returns [] when pool throws TypeError("Cannot read properties of undefined (reading filter)")', async () => {
        // Exact V8 error shape from the prod log storm.
        mockPool.getActiveClaims.mockRejectedValue(
          new TypeError("Cannot read properties of undefined (reading 'filter')"),
        );

        const result = await provider.getActiveClaims();

        expect(result).toEqual([]);
      });

      it('demotes storage-not-ready error to debug log (no error log)', async () => {
        // Capture the logger this provider was given.
        const errorSpy = jest.spyOn((provider as any).logger, 'error');
        const debugSpy = jest.spyOn((provider as any).logger, 'debug');

        mockPool.getActiveClaims.mockRejectedValue(
          new TypeError("Cannot read properties of undefined (reading 'filter')"),
        );

        await provider.getActiveClaims();

        expect(errorSpy).not.toHaveBeenCalled();
        expect(debugSpy).toHaveBeenCalled();
      });

      it('still logs at error level for genuine failures (non-hydration errors)', async () => {
        const errorSpy = jest.spyOn((provider as any).logger, 'error');

        mockPool.getActiveClaims.mockRejectedValue(new Error('Database connection refused'));

        const result = await provider.getActiveClaims();

        expect(result).toEqual([]);
        expect(errorSpy).toHaveBeenCalled();
      });
    });

    // F-CYCLE7-3-FU (2026-05-07) — structural-shape coverage.
    //
    // The original classifier whitelisted method names
    // (`filter|find|map|forEach|length`); a future consumer reaching
    // for `.some()` / `.every()` / `.reduce()` / `.includes()` /
    // `.indexOf()` / `.slice()` would re-introduce the noise pattern
    // because its V8 shape would not match. The structural classifier
    // (instanceof TypeError + "cannot read … of undefined") covers
    // every method/property access on `undefined` in one rule and
    // future-proofs the demotion against consumer drift.
    describe('F-CYCLE7-3-FU: structural classifier (post-whitelist)', () => {
      // Methods that adjacent reconciler code reaches for today + the
      // ones likely to land via future audits. Each must be DEMOTED to
      // debug, not logged at error.
      const v8MethodShapes = [
        "Cannot read properties of undefined (reading 'filter')",
        "Cannot read properties of undefined (reading 'find')",
        "Cannot read properties of undefined (reading 'map')",
        "Cannot read properties of undefined (reading 'forEach')",
        "Cannot read properties of undefined (reading 'length')",
        "Cannot read properties of undefined (reading 'some')",
        "Cannot read properties of undefined (reading 'every')",
        "Cannot read properties of undefined (reading 'reduce')",
        "Cannot read properties of undefined (reading 'includes')",
        "Cannot read properties of undefined (reading 'indexOf')",
        "Cannot read properties of undefined (reading 'slice')",
        "Cannot read properties of undefined (reading 'flat')",
        // Property access (no method call), e.g. `claims.id` on an
        // undefined slot — same V8 shape, no enclosing parens needed.
        "Cannot read properties of undefined (reading 'id')",
        "Cannot read properties of undefined (reading 'status')",
      ];

      for (const shape of v8MethodShapes) {
        it(`demotes to debug: ${shape}`, async () => {
          const errorSpy = jest.spyOn((provider as any).logger, 'error');
          const debugSpy = jest.spyOn((provider as any).logger, 'debug');

          mockPool.getActiveClaims.mockRejectedValue(new TypeError(shape));

          const result = await provider.getActiveClaims();

          expect(result).toEqual([]);
          expect(errorSpy).not.toHaveBeenCalled();
          expect(debugSpy).toHaveBeenCalled();
        });
      }

      it('matches the older Node V8 shape ("Cannot read property X of undefined")', async () => {
        // Node ≤ 14 emits the singular "property" form. The classifier
        // must accept both the modern "properties of undefined (reading
        // X)" and the older "property 'X' of undefined" — both share
        // the readonly anchors `cannot read` + `of undefined`.
        const errorSpy = jest.spyOn((provider as any).logger, 'error');
        const debugSpy = jest.spyOn((provider as any).logger, 'debug');

        mockPool.getActiveClaims.mockRejectedValue(
          new TypeError("Cannot read property 'filter' of undefined"),
        );

        await provider.getActiveClaims();

        expect(errorSpy).not.toHaveBeenCalled();
        expect(debugSpy).toHaveBeenCalled();
      });

      // ---------------------- Negative cases -------------------------
      // The classifier MUST NOT silence genuine bugs. Each of the
      // following is a different bug class from hydration-not-ready
      // and deserves its `error`-level log.

      it('does NOT silence "Cannot read properties of NULL" (different bug class)', async () => {
        // null != undefined in V8 error messages. A null pointer is a
        // "we lost a reference" bug, not "storage warming up".
        const errorSpy = jest.spyOn((provider as any).logger, 'error');
        const debugSpy = jest.spyOn((provider as any).logger, 'debug');

        mockPool.getActiveClaims.mockRejectedValue(
          new TypeError("Cannot read properties of null (reading 'filter')"),
        );

        await provider.getActiveClaims();

        expect(errorSpy).toHaveBeenCalled();
        expect(debugSpy).not.toHaveBeenCalled();
      });

      it('does NOT silence "X is not a function" TypeErrors (missing API, not hydration)', async () => {
        const errorSpy = jest.spyOn((provider as any).logger, 'error');

        mockPool.getActiveClaims.mockRejectedValue(
          new TypeError("pool.someUnknownMethod is not a function"),
        );

        await provider.getActiveClaims();

        expect(errorSpy).toHaveBeenCalled();
      });

      it('does NOT silence non-TypeError throws even if the message matches', async () => {
        // The instanceof TypeError narrow guards against accidental
        // matches by message-content alone (e.g. an Error subclass
        // whose author included the V8 phrase verbatim in a wrapper).
        const errorSpy = jest.spyOn((provider as any).logger, 'error');

        mockPool.getActiveClaims.mockRejectedValue(
          new Error("Cannot read properties of undefined (reading 'filter')"),
        );

        await provider.getActiveClaims();

        expect(errorSpy).toHaveBeenCalled();
      });

      it('does NOT silence "Database connection refused" or other genuine downstream failures', async () => {
        const errorSpy = jest.spyOn((provider as any).logger, 'error');

        mockPool.getActiveClaims.mockRejectedValue(new Error('Database connection refused'));

        await provider.getActiveClaims();

        expect(errorSpy).toHaveBeenCalled();
      });

      it('does NOT silence non-Error throws (string thrown, etc.)', async () => {
        const errorSpy = jest.spyOn((provider as any).logger, 'error');

        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        mockPool.getActiveClaims.mockRejectedValue('string-thrown' as any);

        await provider.getActiveClaims();

        expect(errorSpy).toHaveBeenCalled();
      });
    });
  });

  // -----------------------------------------------------------------------
  // getAgentHealthMap
  // -----------------------------------------------------------------------

  describe('getAgentHealthMap', () => {
    it('builds health map from teams', async () => {
      mockStorage.getTeams.mockResolvedValue([
        {
          id: 'team-1',
          members: [
            {
              id: 'mem-1',
              sessionName: 'agent-leo',
              agentStatus: 'active',
              role: 'developer',
              capabilities: ['typescript', 'rust'],
              updatedAt: '2026-04-01T00:00:00Z',
            },
            {
              id: 'mem-2',
              sessionName: 'agent-max',
              agentStatus: 'suspended',
              role: 'developer',
              capabilities: ['python'],
              updatedAt: '2026-04-01T00:00:00Z',
            },
          ],
        },
      ]);
      mockPool.getActiveClaims.mockResolvedValue([
        { agentId: 'agent-leo' },
      ]);

      const result = await provider.getAgentHealthMap();

      expect(result.size).toBe(2);

      const leo = result.get('agent-leo')!;
      expect(leo.status).toBe('active');
      expect(leo.role).toBe('developer');
      expect(leo.activeWorkItemCount).toBe(1);

      const max = result.get('agent-max')!;
      expect(max.status).toBe('suspended');
      expect(max.activeWorkItemCount).toBe(0);
    });

    it('includes the orchestrator (virtual member) in the health map', async () => {
      // Regression: orc is a virtual team member that does NOT live in
      // teams.json. Without explicit injection, getAgentHealthMap omits it
      // and detectStuckWorkItems treats every orc-claimed running WI as
      // "missing agent" → demotes to blocked → infinite re-claim loop.
      mockStorage.getTeams.mockResolvedValue([]);
      mockStorage.getOrchestratorStatus.mockResolvedValue({
        sessionName: 'crewly-orc',
        agentStatus: 'active',
        workingStatus: 'idle',
        runtimeType: 'tmux',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-09T01:19:00Z',
      });
      mockPool.getActiveClaims.mockResolvedValue([]);

      const result = await provider.getAgentHealthMap();

      const orc = result.get('crewly-orc');
      expect(orc).toBeDefined();
      expect(orc!.status).toBe('active');
      expect(orc!.role).toBe('orchestrator');
      expect(orc!.activeWorkItemCount).toBe(0);
    });

    it('counts active claims against the orchestrator', async () => {
      mockStorage.getTeams.mockResolvedValue([]);
      mockStorage.getOrchestratorStatus.mockResolvedValue({
        sessionName: 'crewly-orc',
        agentStatus: 'active',
        workingStatus: 'in_progress',
        runtimeType: 'tmux',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-09T01:19:00Z',
      });
      mockPool.getActiveClaims.mockResolvedValue([{ agentId: 'crewly-orc' }]);

      const result = await provider.getAgentHealthMap();

      expect(result.get('crewly-orc')!.activeWorkItemCount).toBe(1);
    });

    it('omits the orchestrator if status persistence is empty (degrades gracefully)', async () => {
      mockStorage.getTeams.mockResolvedValue([]);
      mockStorage.getOrchestratorStatus.mockResolvedValue(null);
      mockPool.getActiveClaims.mockResolvedValue([]);

      const result = await provider.getAgentHealthMap();

      expect(result.has('crewly-orc')).toBe(false);
      expect(result.size).toBe(0);
    });

    it('does not throw if orchestrator status lookup fails', async () => {
      mockStorage.getTeams.mockResolvedValue([]);
      mockStorage.getOrchestratorStatus.mockRejectedValue(new Error('disk full'));
      mockPool.getActiveClaims.mockResolvedValue([]);

      const result = await provider.getAgentHealthMap();

      expect(result.has('crewly-orc')).toBe(false);
    });

    it('maps agent statuses correctly', async () => {
      mockStorage.getTeams.mockResolvedValue([
        {
          id: 'team-1',
          members: [
            { id: 'm1', sessionName: 's1', agentStatus: 'active', role: 'dev', updatedAt: '' },
            { id: 'm2', sessionName: 's2', agentStatus: 'starting', role: 'dev', updatedAt: '' },
            { id: 'm3', sessionName: 's3', agentStatus: 'inactive', role: 'dev', updatedAt: '' },
            { id: 'm4', sessionName: 's4', agentStatus: 'suspended', role: 'dev', updatedAt: '' },
            { id: 'm5', sessionName: 's5', agentStatus: 'unknown_status', role: 'dev', updatedAt: '' },
          ],
        },
      ]);
      mockPool.getActiveClaims.mockResolvedValue([]);

      const result = await provider.getAgentHealthMap();

      expect(result.get('s1')!.status).toBe('active');
      expect(result.get('s2')!.status).toBe('started');
      expect(result.get('s3')!.status).toBe('inactive');
      expect(result.get('s4')!.status).toBe('suspended');
      expect(result.get('s5')!.status).toBe('unknown');
    });
  });

  // -----------------------------------------------------------------------
  // applyCorrection
  // -----------------------------------------------------------------------

  describe('applyCorrection', () => {
    it('updates work item status', async () => {
      await provider.applyCorrection({
        entityType: 'work_item',
        entityId: 'wi-1',
        previousState: 'running',
        newState: 'blocked',
        reason: 'Agent dead',
        evidence: 'status=inactive',
        correctedAt: new Date().toISOString(),
      });

      // updateItemStatus now carries actor + reason for the audit trail
      // (system-initiated correction during reconcile).
      expect(mockPool.updateItemStatus).toHaveBeenCalledWith(
        'wi-1',
        'blocked',
        'system',
        expect.stringContaining('Agent dead'),
      );
    });

    it('updates request status via RequestService', async () => {
      await provider.applyCorrection({
        entityType: 'request',
        entityId: 'req-1',
        previousState: 'running',
        newState: 'done',
        reason: 'All tasks completed',
        evidence: 'cascade=done',
        correctedAt: new Date().toISOString(),
      });

      expect(mockRequestService.update).toHaveBeenCalledWith('req-1', { status: 'done' });
    });

    it('escalates reconciler-driven work_item failures', async () => {
      // Reconciler flips a stuck WI to failed → applyCorrection must
      // route through EscalationRouter so ORC/the user are told. Without
      // this hook the failure was silent (see Closie GA4 incident
      // 2026-05-27, WI 8087d8e5).
      const failedWi: Partial<WorkItem> = {
        id: 'wi-stuck-1',
        title: 'Stuck WI',
        type: 'delegate',
        status: 'failed',
        retryCount: 0,
        maxRetries: 0,
      };
      mockEscalationRouter.escalateFailedWorkItem.mockClear();
      (TaskPoolService as unknown as { _mockInstance: { findWorkItem: jest.Mock } })._mockInstance.findWorkItem.mockResolvedValueOnce(failedWi);

      await provider.applyCorrection({
        entityType: 'work_item',
        entityId: 'wi-stuck-1',
        previousState: 'running',
        newState: 'failed',
        reason: 'Agent crewly-orc is inactive',
        evidence: 'lastSeen=10m_ago',
        correctedAt: new Date().toISOString(),
      });

      expect(mockEscalationRouter.escalateFailedWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'wi-stuck-1' }),
        expect.stringContaining('Agent crewly-orc is inactive'),
      );
    });

    // WI ece797e7 — a reconciler-driven `failed` is not automatically
    // terminal. `detectStuckWorkItems`' TIMEOUT branch sets `failed`
    // unconditionally (unlike its agent-dead sibling, which respects the
    // budget), so a first-attempt timeout reached this code with
    // retryCount=0 and escalated claiming its retries were spent — while
    // `detectRetryableFailedWorkItems` re-queued the same item as
    // "attempt 1/3" on the next sweep.
    it('does NOT escalate a reconciler-driven failure while retry budget remains', async () => {
      const retryableWi: Partial<WorkItem> = {
        id: 'wi-timeout-1',
        title: 'Timed out on first attempt',
        type: 'delegate',
        status: 'failed',
        retryCount: 0,
        maxRetries: 3,
      };
      mockEscalationRouter.escalateFailedWorkItem.mockClear();
      (TaskPoolService as unknown as { _mockInstance: { findWorkItem: jest.Mock } })._mockInstance.findWorkItem.mockResolvedValueOnce(retryableWi);

      await provider.applyCorrection({
        entityType: 'work_item',
        entityId: 'wi-timeout-1',
        previousState: 'running',
        newState: 'failed',
        reason: 'WorkItem (type=delegate) exceeded timeout of 14400000ms',
        evidence: 'running for 5h (limit 4h)',
        correctedAt: new Date().toISOString(),
      });

      expect(mockEscalationRouter.escalateFailedWorkItem).not.toHaveBeenCalled();
    });

    it('DOES escalate once the retry budget is genuinely spent', async () => {
      // The gate must not become "never escalate" — that would trade a
      // false alarm for a silent failure, which is worse.
      const spentWi: Partial<WorkItem> = {
        id: 'wi-timeout-2',
        title: 'Out of retries',
        type: 'delegate',
        status: 'failed',
        retryCount: 3,
        maxRetries: 3,
      };
      mockEscalationRouter.escalateFailedWorkItem.mockClear();
      (TaskPoolService as unknown as { _mockInstance: { findWorkItem: jest.Mock } })._mockInstance.findWorkItem.mockResolvedValueOnce(spentWi);

      await provider.applyCorrection({
        entityType: 'work_item',
        entityId: 'wi-timeout-2',
        previousState: 'running',
        newState: 'failed',
        reason: 'WorkItem (type=delegate) exceeded timeout of 14400000ms',
        evidence: 'running for 5h (limit 4h)',
        correctedAt: new Date().toISOString(),
      });

      expect(mockEscalationRouter.escalateFailedWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'wi-timeout-2' }),
        expect.stringContaining('exceeded timeout'),
      );
    });

    it('does not escalate when work_item transitions to a non-failed state', async () => {
      // blocked / cancelled / queued corrections must NOT trip escalation;
      // they're not terminal failures and have their own surfacing paths.
      mockEscalationRouter.escalateFailedWorkItem.mockClear();

      await provider.applyCorrection({
        entityType: 'work_item',
        entityId: 'wi-1',
        previousState: 'running',
        newState: 'blocked',
        reason: 'Agent dead',
        evidence: 'status=inactive',
        correctedAt: new Date().toISOString(),
      });

      expect(mockEscalationRouter.escalateFailedWorkItem).not.toHaveBeenCalled();
    });

    it('routes failed → queued through requeueAfterFailure (NOT updateItemStatus) — #607 regression', async () => {
      // The reconciler's `detectRetryableFailedWorkItems` rule generates
      // `failed → queued` corrections for WIs whose `retryCount < maxRetries`.
      // The plain `updateItemStatus` path leaves retryCount untouched →
      // the cap never trips → indefinite loop (observed 2026-05-23 with
      // 4 misrouted WIs). The correction MUST flow through
      // `requeueAfterFailure`, which bumps retryCount.
      const poolMock = (TaskPoolService as unknown as {
        _mockInstance: { updateItemStatus: jest.Mock; requeueAfterFailure: jest.Mock };
      })._mockInstance;
      poolMock.updateItemStatus.mockClear();
      poolMock.requeueAfterFailure.mockClear();

      await provider.applyCorrection({
        entityType: 'work_item',
        entityId: 'wi-retry-1',
        previousState: 'failed',
        newState: 'queued',
        reason: 'Auto-retry failed WorkItem (attempt 1/3)',
        evidence: 'status=failed, retryCount=0, maxRetries=3',
        correctedAt: new Date().toISOString(),
      });

      expect(poolMock.requeueAfterFailure).toHaveBeenCalledWith(
        'wi-retry-1',
        expect.stringContaining('Auto-retry failed WorkItem'),
      );
      // The plain status setter MUST NOT be called for failed→queued —
      // it would leave retryCount frozen and re-introduce the loop.
      expect(poolMock.updateItemStatus).not.toHaveBeenCalled();
    });

    it('still uses updateItemStatus for non-retry transitions (queued → blocked etc.)', async () => {
      // Regression guard for the prior test: only the specific
      // `failed → queued` path should divert to requeueAfterFailure.
      // Everything else stays on the generic setter.
      const poolMock = (TaskPoolService as unknown as {
        _mockInstance: { updateItemStatus: jest.Mock; requeueAfterFailure: jest.Mock };
      })._mockInstance;
      poolMock.updateItemStatus.mockClear();
      poolMock.requeueAfterFailure.mockClear();

      await provider.applyCorrection({
        entityType: 'work_item',
        entityId: 'wi-1',
        previousState: 'queued',
        newState: 'blocked',
        reason: 'Dep stuck',
        evidence: 'parent failed',
        correctedAt: new Date().toISOString(),
      });

      expect(poolMock.updateItemStatus).toHaveBeenCalled();
      expect(poolMock.requeueAfterFailure).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // releaseToPool / requeueWorkItem
  // -----------------------------------------------------------------------

  describe('releaseToPool', () => {
    it('calls releaseBack on pool', async () => {
      await provider.releaseToPool('wi-1', 'expired');

      expect(mockPool.releaseBack).toHaveBeenCalledWith('wi-1', 'expired');
    });
  });

  describe('requeueWorkItem', () => {
    it('calls releaseBack with reconciler reason', async () => {
      await provider.requeueWorkItem('wi-1');

      expect(mockPool.releaseBack).toHaveBeenCalledWith('wi-1', 'reconciler_requeue');
    });
  });

  // -----------------------------------------------------------------------
  // Claim operations
  // -----------------------------------------------------------------------

  describe('markClaimExpiring', () => {
    it('delegates to pool service', async () => {
      await provider.markClaimExpiring('claim-1');

      expect(mockPool.markClaimExpiring).toHaveBeenCalledWith('claim-1');
    });
  });

  describe('revokeClaimAndRelease', () => {
    it('delegates to pool service', async () => {
      await provider.revokeClaimAndRelease('claim-1', 'grace exceeded');

      expect(mockPool.revokeAndRelease).toHaveBeenCalledWith('claim-1', 'grace exceeded');
    });
  });

  // -----------------------------------------------------------------------
  // getAvailablePoolItems
  // -----------------------------------------------------------------------

  describe('getAvailablePoolItems', () => {
    it('returns available items from pool', async () => {
      const items: Partial<WorkItem>[] = [
        { id: 'wi-1', status: 'queued' },
      ];
      mockPool.getAvailableItems.mockResolvedValue(items);

      const result = await provider.getAvailablePoolItems();

      expect(result).toEqual(items);
    });

    // F-CYCLE7-3 (2026-05-07) — post-restart hydration safety.
    describe('F-CYCLE7-3: post-restart null-safety', () => {
      it('returns [] without throwing when pool returns undefined', async () => {
        mockPool.getAvailableItems.mockResolvedValue(undefined as any);

        const result = await provider.getAvailablePoolItems();

        expect(result).toEqual([]);
      });

      it('returns [] when pool throws "Cannot read properties of undefined (reading filter)"', async () => {
        mockPool.getAvailableItems.mockRejectedValue(
          new TypeError("Cannot read properties of undefined (reading 'filter')"),
        );

        const result = await provider.getAvailablePoolItems();

        expect(result).toEqual([]);
      });

      it('demotes storage-not-ready error to debug log', async () => {
        const errorSpy = jest.spyOn((provider as any).logger, 'error');
        const debugSpy = jest.spyOn((provider as any).logger, 'debug');

        mockPool.getAvailableItems.mockRejectedValue(
          new TypeError("Cannot read properties of undefined (reading 'filter')"),
        );

        await provider.getAvailablePoolItems();

        expect(errorSpy).not.toHaveBeenCalled();
        expect(debugSpy).toHaveBeenCalled();
      });

      it('still logs error for genuine failures', async () => {
        const errorSpy = jest.spyOn((provider as any).logger, 'error');

        mockPool.getAvailableItems.mockRejectedValue(new Error('Disk full'));

        await provider.getAvailablePoolItems();

        expect(errorSpy).toHaveBeenCalled();
      });
    });

    // F-CYCLE7-3-FU (2026-05-07) — confirm both call sites
    // (`getActiveClaims` and `getAvailablePoolItems`) share the same
    // structural classifier behavior. Smaller smoke than the
    // exhaustive block on getActiveClaims, just verifying the second
    // call site doesn't drift.
    describe('F-CYCLE7-3-FU: structural classifier (post-whitelist) — second call site', () => {
      it.each([
        ["Cannot read properties of undefined (reading 'some')"],
        ["Cannot read properties of undefined (reading 'reduce')"],
        ["Cannot read properties of undefined (reading 'indexOf')"],
        ["Cannot read property 'filter' of undefined"], // older V8 shape
      ])('demotes %s to debug', async (shape: string) => {
        const errorSpy = jest.spyOn((provider as any).logger, 'error');
        const debugSpy = jest.spyOn((provider as any).logger, 'debug');

        mockPool.getAvailableItems.mockRejectedValue(new TypeError(shape));

        const result = await provider.getAvailablePoolItems();

        expect(result).toEqual([]);
        expect(errorSpy).not.toHaveBeenCalled();
        expect(debugSpy).toHaveBeenCalled();
      });

      it('does NOT silence "Cannot read properties of null" on second call site', async () => {
        const errorSpy = jest.spyOn((provider as any).logger, 'error');

        mockPool.getAvailableItems.mockRejectedValue(
          new TypeError("Cannot read properties of null (reading 'filter')"),
        );

        await provider.getAvailablePoolItems();

        expect(errorSpy).toHaveBeenCalled();
      });
    });
  });

  // -----------------------------------------------------------------------
  // executeWakeAction
  // -----------------------------------------------------------------------

  describe('executeWakeAction', () => {
    it('rehydrates suspended agent', async () => {
      mockSuspend.isSuspended.mockReturnValue(true);
      mockSuspend.rehydrateAgent.mockResolvedValue(true);

      const action: WakeAction = {
        workItemId: 'wi-1',
        agentSessionName: 'agent-max',
        strategy: 'rehydrate',
        score: 75,
        scoreBreakdown: { skillMatch: 40, urgency: 15, contextFamiliarity: 20, loadPenalty: 0 },
        triggeredAt: new Date().toISOString(),
      };

      const result = await provider.executeWakeAction(action);

      expect(result).toBe(true);
      expect(mockSuspend.rehydrateAgent).toHaveBeenCalledWith('agent-max');
    });

    it('returns false if agent not in suspended map', async () => {
      mockSuspend.isSuspended.mockReturnValue(false);

      const action: WakeAction = {
        workItemId: 'wi-1',
        agentSessionName: 'agent-unknown',
        strategy: 'rehydrate',
        score: 50,
        scoreBreakdown: { skillMatch: 20, urgency: 10, contextFamiliarity: 20, loadPenalty: 0 },
        triggeredAt: new Date().toISOString(),
      };

      const result = await provider.executeWakeAction(action);

      expect(result).toBe(false);
    });

    it('starts inactive agent via API', async () => {
      // Mock fetch for start agent
      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const action: WakeAction = {
        workItemId: 'wi-1',
        agentSessionName: 'agent-idle',
        strategy: 'start',
        score: 60,
        scoreBreakdown: { skillMatch: 30, urgency: 20, contextFamiliarity: 10, loadPenalty: 0 },
        triggeredAt: new Date().toISOString(),
      };

      const result = await provider.executeWakeAction(action);

      expect(result).toBe(true);
      // Wake request now also carries workItemId so the wake gate on the
      // server can match the call back to the queued WI it's intended to
      // fulfil (avoids the "orphan wake" failure mode where the server
      // refuses because pool has no matching WI).
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/teams/members/start'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"sessionName":"agent-idle"'),
        }),
      );
      const bodyArg = (globalThis.fetch as jest.Mock).mock.calls[0][1].body as string;
      expect(JSON.parse(bodyArg)).toMatchObject({ sessionName: 'agent-idle', workItemId: 'wi-1' });

      globalThis.fetch = originalFetch;
    });

    // #679 / #686: the orchestrator is a virtual member with undefined
    // teamId/memberId. The old fallback URL `/api/teams/members/start`
    // misrouted to `startTeam` → 404 "Team not found" (retried every ~10s),
    // and the orchestrator could never be (re)started by the reconciler — so
    // after a backend restart it stayed inactive and inbound work sat queued.
    // It must be routed to the dedicated, idempotent /api/orchestrator/setup.
    it('starts the orchestrator via /api/orchestrator/setup, not the member-start path (#679, #686)', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const action: WakeAction = {
        workItemId: 'wi-orc-1',
        agentSessionName: ORCHESTRATOR_SESSION_NAME, // 'crewly-orc'
        strategy: 'start',
        // teamId/memberId intentionally absent — orc is a virtual member.
        score: 90,
        scoreBreakdown: { skillMatch: 40, urgency: 40, contextFamiliarity: 10, loadPenalty: 0 },
        triggeredAt: new Date().toISOString(),
      };

      const result = await provider.executeWakeAction(action);

      expect(result).toBe(true);
      const calledUrl = (globalThis.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/orchestrator/setup');
      // Must NOT hit the misrouting member-start fallback.
      expect(calledUrl).not.toContain('/api/teams/members/start');

      globalThis.fetch = originalFetch;
    });

    it('returns false on fetch error for start strategy', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const action: WakeAction = {
        workItemId: 'wi-1',
        agentSessionName: 'agent-dead',
        strategy: 'start',
        score: 40,
        scoreBreakdown: { skillMatch: 20, urgency: 10, contextFamiliarity: 10, loadPenalty: 0 },
        triggeredAt: new Date().toISOString(),
      };

      const result = await provider.executeWakeAction(action);

      expect(result).toBe(false);

      globalThis.fetch = originalFetch;
    });

    // 2026-05-20 follow-up — redeliver strategy for active-but-idle targets
    describe('redeliver strategy', () => {
      const buildAction = (): WakeAction => ({
        workItemId: 'wi-sora-1',
        agentSessionName: 'sora',
        strategy: 'redeliver',
        score: 0,
        scoreBreakdown: { skillMatch: 0, urgency: 0, contextFamiliarity: 0, loadPenalty: 0 },
        triggeredAt: new Date().toISOString(),
      });

      const queuedWi: WorkItem = {
        id: 'wi-sora-1',
        type: 'delegate',
        status: 'queued',
        target: 'sora',
        owner: 'orc',
        priority: 'normal',
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        title: 'redeliver case',
        description: 'redeliver case',
      } as unknown as WorkItem;

      beforeEach(() => {
        mockSubscriber.redispatch.mockReset();
        mockSubscriber.redispatch.mockResolvedValue(true);
      });

      it('redelivers a queued WI via WorkItemDispatchSubscriber', async () => {
        mockPool.findWorkItem.mockResolvedValueOnce(queuedWi);

        const result = await provider.executeWakeAction(buildAction());

        expect(result).toBe(true);
        expect(mockPool.findWorkItem).toHaveBeenCalledWith('wi-sora-1');
        expect(mockSubscriber.redispatch).toHaveBeenCalledWith(queuedWi);
      });

      it('skips redeliver when the WI has moved past queued', async () => {
        mockPool.findWorkItem.mockResolvedValueOnce({ ...queuedWi, status: 'running' });

        const result = await provider.executeWakeAction(buildAction());

        expect(result).toBe(false);
        expect(mockSubscriber.redispatch).not.toHaveBeenCalled();
      });

      it('redelivers a queued WI once, then suppresses repeats within the cooldown (anti-flood)', async () => {
        // The fast loop re-emits redeliver every ~10s; the per-WI cooldown
        // must cap re-POSTs so a queued-but-unclaimed WI cannot flood the PTY.
        mockPool.findWorkItem.mockResolvedValue(queuedWi);

        const first = await provider.executeWakeAction(buildAction());
        const second = await provider.executeWakeAction(buildAction());
        const third = await provider.executeWakeAction(buildAction());

        expect(first).toBe(true);
        expect(second).toBe(false);
        expect(third).toBe(false);
        expect(mockSubscriber.redispatch).toHaveBeenCalledTimes(1);
      });

      it('returns false when the WI no longer exists', async () => {
        mockPool.findWorkItem.mockResolvedValueOnce(null);

        const result = await provider.executeWakeAction(buildAction());

        expect(result).toBe(false);
        expect(mockSubscriber.redispatch).not.toHaveBeenCalled();
      });

      it('bypasses the memory-pressure gate (cheap repost to live agent)', async () => {
        // 95% used — would block rehydrate/start at the floor, but redeliver
        // adds no new agent so it must proceed.
        mockTotalmem.mockReturnValue(16_000_000_000);
        mockFreemem.mockReturnValue(200_000_000);
        mockStorage.getTeams.mockResolvedValue([
          {
            id: 't1',
            members: [
              { id: 'm1', sessionName: 's1', agentStatus: 'active', role: 'dev', updatedAt: '' },
              { id: 'm2', sessionName: 's2', agentStatus: 'active', role: 'dev', updatedAt: '' },
              { id: 'm3', sessionName: 's3', agentStatus: 'active', role: 'dev', updatedAt: '' },
            ],
          },
        ]);
        mockPool.findWorkItem.mockResolvedValueOnce(queuedWi);

        const result = await provider.executeWakeAction(buildAction());

        expect(result).toBe(true);
        expect(mockSubscriber.redispatch).toHaveBeenCalledWith(queuedWi);
      });

      it('returns false when redispatch itself fails', async () => {
        mockPool.findWorkItem.mockResolvedValueOnce(queuedWi);
        mockSubscriber.redispatch.mockResolvedValueOnce(false);

        const result = await provider.executeWakeAction(buildAction());

        expect(result).toBe(false);
      });
    });

    // 2026-05-13 dogfood: previously this gate UNCONDITIONALLY blocked
    // every wake action whenever memory pressure tripped (>=90%), which
    // wedged the entire system for hours when free RAM stayed low.
    // New behaviour: allow wakes up to WAKE_FLOOR_UNDER_PRESSURE
    // concurrent active agents so something keeps making progress;
    // block additional wakes beyond that floor. Tests now pin both
    // halves of the contract.
    it('skips wake under memory pressure when active-agent count is at/above the floor', async () => {
      // 95% used
      mockTotalmem.mockReturnValue(16_000_000_000);
      mockFreemem.mockReturnValue(200_000_000);

      // 3 active agents = floor reached
      mockStorage.getTeams.mockResolvedValue([
        {
          id: 't1',
          members: [
            { id: 'm1', sessionName: 's1', agentStatus: 'active', role: 'dev', updatedAt: '' },
            { id: 'm2', sessionName: 's2', agentStatus: 'active', role: 'dev', updatedAt: '' },
            { id: 'm3', sessionName: 's3', agentStatus: 'started', role: 'dev', updatedAt: '' },
          ],
        },
      ]);

      mockSuspend.isSuspended.mockReturnValue(true);
      mockSuspend.rehydrateAgent.mockResolvedValue(true);

      const action: WakeAction = {
        workItemId: 'wi-1',
        agentSessionName: 'agent-max',
        strategy: 'rehydrate',
        score: 75,
        scoreBreakdown: { skillMatch: 40, urgency: 15, contextFamiliarity: 20, loadPenalty: 0 },
        triggeredAt: new Date().toISOString(),
      };

      const result = await provider.executeWakeAction(action);

      expect(result).toBe(false);
      expect(mockSuspend.rehydrateAgent).not.toHaveBeenCalled();
    });

    it('allows wake under memory pressure when active-agent count is BELOW the floor', async () => {
      // 95% used (would have skipped pre-fix)
      mockTotalmem.mockReturnValue(16_000_000_000);
      mockFreemem.mockReturnValue(200_000_000);

      // Only 1 active agent → 2 slots under floor → wake should go through
      mockStorage.getTeams.mockResolvedValue([
        {
          id: 't1',
          members: [
            { id: 'm1', sessionName: 's1', agentStatus: 'active', role: 'dev', updatedAt: '' },
            { id: 'm2', sessionName: 's2', agentStatus: 'inactive', role: 'dev', updatedAt: '' },
            { id: 'm3', sessionName: 's3', agentStatus: 'suspended', role: 'dev', updatedAt: '' },
          ],
        },
      ]);

      mockSuspend.isSuspended.mockReturnValue(true);
      mockSuspend.rehydrateAgent.mockResolvedValue(true);

      const action: WakeAction = {
        workItemId: 'wi-1',
        agentSessionName: 'agent-max',
        strategy: 'rehydrate',
        score: 75,
        scoreBreakdown: { skillMatch: 40, urgency: 15, contextFamiliarity: 20, loadPenalty: 0 },
        triggeredAt: new Date().toISOString(),
      };

      const result = await provider.executeWakeAction(action);

      expect(result).toBe(true);
      expect(mockSuspend.rehydrateAgent).toHaveBeenCalledWith('agent-max');
    });

    it('counts `starting` and `started` toward the floor (in-flight wakes consume RAM too)', async () => {
      mockTotalmem.mockReturnValue(16_000_000_000);
      mockFreemem.mockReturnValue(200_000_000);

      // 3 in-flight = floor reached even though none are fully active yet
      mockStorage.getTeams.mockResolvedValue([
        {
          id: 't1',
          members: [
            { id: 'm1', sessionName: 's1', agentStatus: 'starting', role: 'dev', updatedAt: '' },
            { id: 'm2', sessionName: 's2', agentStatus: 'started', role: 'dev', updatedAt: '' },
            { id: 'm3', sessionName: 's3', agentStatus: 'starting', role: 'dev', updatedAt: '' },
          ],
        },
      ]);

      mockSuspend.isSuspended.mockReturnValue(true);
      const action: WakeAction = {
        workItemId: 'wi-1',
        agentSessionName: 'agent-max',
        strategy: 'rehydrate',
        score: 75,
        scoreBreakdown: { skillMatch: 40, urgency: 15, contextFamiliarity: 20, loadPenalty: 0 },
        triggeredAt: new Date().toISOString(),
      };

      const result = await provider.executeWakeAction(action);

      expect(result).toBe(false);
      expect(mockSuspend.rehydrateAgent).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Eviction-under-pressure path (issue surfaced 2026-05-16: queued WI
    // for inactive Atlas couldn't get woken because idle marketing/product
    // agents held the floor. Fix: terminate one idle, non-always-on, no-WI
    // agent to free a slot for the incoming wake.)
    // -----------------------------------------------------------------------

    describe('eviction under memory pressure', () => {
      const mockTerminate = jest.fn().mockResolvedValue({ success: true });
      const mockUpdateAgentStatus = jest.fn().mockResolvedValue(undefined);

      beforeEach(() => {
        mockTerminate.mockClear();
        mockUpdateAgentStatus.mockClear();
        mockStorage.updateAgentStatus = mockUpdateAgentStatus;
        provider.setAgentRegistrationService({ terminateAgentSession: mockTerminate });
        // Memory pressure: BOTH >=90% used AND <300MB free.
        // 16GB total, 100MB free = 99.4% used + 100MB free → pressure triggers.
        mockTotalmem.mockReturnValue(16_000_000_000);
        mockFreemem.mockReturnValue(100_000_000);
        // Default rehydrate path: agent is suspended → rehydrate succeeds.
        mockSuspend.isSuspended.mockReturnValue(true);
        mockSuspend.rehydrateAgent.mockResolvedValue(true);
      });

      const wakeFor = (sessionName: string): WakeAction => ({
        workItemId: 'wi-incoming',
        agentSessionName: sessionName,
        strategy: 'rehydrate',
        score: 50,
        scoreBreakdown: { skillMatch: 30, urgency: 10, contextFamiliarity: 10, loadPenalty: 0 },
        triggeredAt: new Date().toISOString(),
      });

      it('evicts the longest-idle non-always-on agent then proceeds with wake', async () => {
        mockStorage.getTeams.mockResolvedValue([
          {
            id: 't1',
            members: [
              { id: 'mFresh', sessionName: 'fresh', agentStatus: 'active', workingStatus: 'idle', role: 'developer', updatedAt: '2026-05-16T18:50:00Z' },
              { id: 'mStale', sessionName: 'stale', agentStatus: 'active', workingStatus: 'idle', role: 'developer', updatedAt: '2026-05-16T17:00:00Z' },
              { id: 'mOrc',   sessionName: 'orc',   agentStatus: 'active', workingStatus: 'idle', role: 'orchestrator', updatedAt: '2026-05-16T17:00:00Z' },
            ],
          },
        ]);
        mockSuspend.isSuspended.mockReturnValue(true);
        mockSuspend.rehydrateAgent.mockResolvedValue(true);
        // No queued WIs targeting any of these agents.
        mockPool.getAllItems.mockResolvedValue([]);

        const result = await provider.executeWakeAction(wakeFor('atlas'));

        expect(mockTerminate).toHaveBeenCalledTimes(1);
        // Longest-idle eligible candidate is `stale` (17:00 < 18:50).
        expect(mockTerminate).toHaveBeenCalledWith('stale', 'developer');
        expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
          'stale',
          'inactive',
          'idle_exit_pressure',
        );
        expect(result).toBe(true);
        expect(mockSuspend.rehydrateAgent).toHaveBeenCalledWith('atlas');
      });

      it('refuses to evict an idle agent that has a non-terminal WorkItem targeting it', async () => {
        mockStorage.getTeams.mockResolvedValue([
          {
            id: 't1',
            members: [
              { id: 'mIdle', sessionName: 'idle-with-wi', agentStatus: 'active', workingStatus: 'idle', role: 'developer', updatedAt: '2026-05-16T17:00:00Z' },
              { id: 'm2', sessionName: 'a2', agentStatus: 'active', workingStatus: 'in_progress', role: 'developer', updatedAt: '' },
              { id: 'm3', sessionName: 'a3', agentStatus: 'active', workingStatus: 'in_progress', role: 'developer', updatedAt: '' },
            ],
          },
        ]);
        mockPool.getAllItems.mockResolvedValue([
          { id: 'wi-self', status: 'queued', target: 'idle-with-wi' },
        ]);

        const result = await provider.executeWakeAction(wakeFor('atlas'));

        expect(mockTerminate).not.toHaveBeenCalled();
        expect(result).toBe(false);
      });

      it('refuses to evict always-on roles (orchestrator/auditor) even when idle', async () => {
        mockStorage.getTeams.mockResolvedValue([
          {
            id: 't1',
            members: [
              { id: 'mOrc', sessionName: 'orc',     agentStatus: 'active', workingStatus: 'idle', role: 'orchestrator', updatedAt: '2026-05-16T10:00:00Z' },
              { id: 'mAud', sessionName: 'auditor', agentStatus: 'active', workingStatus: 'idle', role: 'auditor',      updatedAt: '2026-05-16T10:00:00Z' },
              { id: 'mBusy', sessionName: 'busy',   agentStatus: 'active', workingStatus: 'in_progress', role: 'developer', updatedAt: '' },
            ],
          },
        ]);
        mockPool.getAllItems.mockResolvedValue([]);

        const result = await provider.executeWakeAction(wakeFor('atlas'));
        expect(mockTerminate).not.toHaveBeenCalled();
        expect(result).toBe(false);
      });

      it('refuses to evict an agent in workingStatus=in_progress', async () => {
        mockStorage.getTeams.mockResolvedValue([
          {
            id: 't1',
            members: [
              { id: 'mA', sessionName: 'a1', agentStatus: 'active', workingStatus: 'in_progress', role: 'developer', updatedAt: '2026-05-16T10:00:00Z' },
              { id: 'mB', sessionName: 'a2', agentStatus: 'active', workingStatus: 'in_progress', role: 'developer', updatedAt: '2026-05-16T10:00:00Z' },
              { id: 'mC', sessionName: 'a3', agentStatus: 'active', workingStatus: 'in_progress', role: 'developer', updatedAt: '2026-05-16T10:00:00Z' },
            ],
          },
        ]);
        mockPool.getAllItems.mockResolvedValue([]);

        const result = await provider.executeWakeAction(wakeFor('atlas'));
        expect(mockTerminate).not.toHaveBeenCalled();
        expect(result).toBe(false);
      });

      it('refuses to evict the agent we are trying to wake (no self-eviction)', async () => {
        // Edge case — `atlas` itself shows up as active+idle in the team
        // file (race between status updates). We must NOT evict our own
        // target.
        mockStorage.getTeams.mockResolvedValue([
          {
            id: 't1',
            members: [
              { id: 'mA', sessionName: 'atlas', agentStatus: 'active', workingStatus: 'idle', role: 'developer', updatedAt: '2026-05-16T10:00:00Z' },
              { id: 'mB', sessionName: 'b', agentStatus: 'active', workingStatus: 'in_progress', role: 'developer', updatedAt: '' },
              { id: 'mC', sessionName: 'c', agentStatus: 'active', workingStatus: 'in_progress', role: 'developer', updatedAt: '' },
            ],
          },
        ]);
        mockPool.getAllItems.mockResolvedValue([]);

        const result = await provider.executeWakeAction(wakeFor('atlas'));
        expect(mockTerminate).not.toHaveBeenCalled();
        expect(result).toBe(false);
      });

      it('falls back to skip when eviction itself fails (termination throws)', async () => {
        mockStorage.getTeams.mockResolvedValue([
          {
            id: 't1',
            members: [
              { id: 'mIdle', sessionName: 'idle1', agentStatus: 'active', workingStatus: 'idle', role: 'developer', updatedAt: '2026-05-16T10:00:00Z' },
              { id: 'mB', sessionName: 'b', agentStatus: 'active', workingStatus: 'in_progress', role: 'developer', updatedAt: '' },
              { id: 'mC', sessionName: 'c', agentStatus: 'active', workingStatus: 'in_progress', role: 'developer', updatedAt: '' },
            ],
          },
        ]);
        mockPool.getAllItems.mockResolvedValue([]);
        mockTerminate.mockRejectedValueOnce(new Error('tmux gone'));
        mockSuspend.rehydrateAgent.mockResolvedValue(true);

        const result = await provider.executeWakeAction(wakeFor('atlas'));
        expect(mockTerminate).toHaveBeenCalledTimes(1);
        expect(result).toBe(false); // skip, don't wake (floor invariant)
        expect(mockSuspend.rehydrateAgent).not.toHaveBeenCalled();
      });

      it('disables eviction when AgentRegistrationService is not wired (and falls back to skip)', async () => {
        const unwired = new LiveReconcilerDataProvider();
        mockStorage.getTeams.mockResolvedValue([
          {
            id: 't1',
            members: [
              { id: 'mIdle', sessionName: 'idle1', agentStatus: 'active', workingStatus: 'idle', role: 'developer', updatedAt: '2026-05-16T10:00:00Z' },
              { id: 'mB', sessionName: 'b', agentStatus: 'active', workingStatus: 'in_progress', role: 'developer', updatedAt: '' },
              { id: 'mC', sessionName: 'c', agentStatus: 'active', workingStatus: 'in_progress', role: 'developer', updatedAt: '' },
            ],
          },
        ]);
        mockPool.getAllItems.mockResolvedValue([]);

        const result = await unwired.executeWakeAction(wakeFor('atlas'));
        expect(mockTerminate).not.toHaveBeenCalled();
        expect(result).toBe(false);
      });
    });

    it('should proceed with wake action when memory usage is below 90%', async () => {
      // Simulate normal memory usage (75% used)
      mockTotalmem.mockReturnValue(16_000_000_000); // 16GB
      mockFreemem.mockReturnValue(4_000_000_000);    // 4GB free = 75% used

      mockSuspend.isSuspended.mockReturnValue(true);
      mockSuspend.rehydrateAgent.mockResolvedValue(true);

      const action: WakeAction = {
        workItemId: 'wi-1',
        agentSessionName: 'agent-max',
        strategy: 'rehydrate',
        score: 75,
        scoreBreakdown: { skillMatch: 40, urgency: 15, contextFamiliarity: 20, loadPenalty: 0 },
        triggeredAt: new Date().toISOString(),
      };

      const result = await provider.executeWakeAction(action);

      // Should proceed and call rehydrate
      expect(result).toBe(true);
      expect(mockSuspend.rehydrateAgent).toHaveBeenCalledWith('agent-max');

    });

    describe('system:memory_pressure broadcast', () => {
      // Sustained memory pressure should reach orc via EventBus so the
      // user gets a "system memory critical" notice instead of silent
      // stall (2026-05-14 incident: 20h, zero user-facing signal).

      const buildAtFloorTeams = () => [
        {
          id: 't1',
          members: [
            { id: 'm1', sessionName: 's1', agentStatus: 'active', role: 'dev', updatedAt: '' },
            { id: 'm2', sessionName: 's2', agentStatus: 'active', role: 'dev', updatedAt: '' },
            { id: 'm3', sessionName: 's3', agentStatus: 'active', role: 'dev', updatedAt: '' },
          ],
        },
      ];

      const buildAction = (): WakeAction => ({
        workItemId: 'wi-1',
        agentSessionName: 'agent-max',
        strategy: 'rehydrate',
        score: 75,
        scoreBreakdown: { skillMatch: 40, urgency: 15, contextFamiliarity: 20, loadPenalty: 0 },
        triggeredAt: new Date().toISOString(),
      });

      it('does NOT publish on the first few skips (transient pressure is silenced)', async () => {
        mockTotalmem.mockReturnValue(16_000_000_000);
        mockFreemem.mockReturnValue(200_000_000); // 95% used
        mockStorage.getTeams.mockResolvedValue(buildAtFloorTeams());

        const publish = jest.fn();
        provider.setEventBus({ publish } as any);

        // Below the FIRST_FIRE_THRESHOLD (5)
        for (let i = 0; i < 4; i++) {
          await provider.executeWakeAction(buildAction());
        }

        expect(publish).not.toHaveBeenCalled();
      });

      it('publishes once sustained pressure crosses the threshold', async () => {
        mockTotalmem.mockReturnValue(16_000_000_000);
        mockFreemem.mockReturnValue(200_000_000);
        mockStorage.getTeams.mockResolvedValue(buildAtFloorTeams());

        const publish = jest.fn();
        provider.setEventBus({ publish } as any);

        for (let i = 0; i < 5; i++) {
          await provider.executeWakeAction(buildAction());
        }

        expect(publish).toHaveBeenCalledTimes(1);
        const event = publish.mock.calls[0][0];
        expect(event.type).toBe('system:memory_pressure');
        expect(event.sessionName).toBe('system');
        expect(event.newValue).toBe('critical');
      });

      it('throttles re-fire — does not republish within the refire window', async () => {
        mockTotalmem.mockReturnValue(16_000_000_000);
        mockFreemem.mockReturnValue(200_000_000);
        mockStorage.getTeams.mockResolvedValue(buildAtFloorTeams());

        const publish = jest.fn();
        provider.setEventBus({ publish } as any);

        // Cross the threshold, then keep skipping — only one event fires
        for (let i = 0; i < 50; i++) {
          await provider.executeWakeAction(buildAction());
        }

        expect(publish).toHaveBeenCalledTimes(1);
      });

      it('resets state when pressure clears, allowing a fresh first-fire on re-entry', async () => {
        const publish = jest.fn();
        provider.setEventBus({ publish } as any);

        // Episode 1: pressure on, cross threshold → one event
        mockTotalmem.mockReturnValue(16_000_000_000);
        mockFreemem.mockReturnValue(200_000_000);
        mockStorage.getTeams.mockResolvedValue(buildAtFloorTeams());
        for (let i = 0; i < 5; i++) {
          await provider.executeWakeAction(buildAction());
        }
        expect(publish).toHaveBeenCalledTimes(1);

        // Pressure clears
        mockFreemem.mockReturnValue(8_000_000_000); // 50% used
        mockSuspend.isSuspended.mockReturnValue(true);
        await provider.executeWakeAction(buildAction());

        // Episode 2: pressure returns, must cross threshold again before firing
        mockFreemem.mockReturnValue(200_000_000);
        for (let i = 0; i < 4; i++) {
          await provider.executeWakeAction(buildAction());
        }
        expect(publish).toHaveBeenCalledTimes(1); // still only episode 1

        await provider.executeWakeAction(buildAction()); // 5th skip
        expect(publish).toHaveBeenCalledTimes(2);
      });

      it('is a no-op when no EventBus has been wired', async () => {
        mockTotalmem.mockReturnValue(16_000_000_000);
        mockFreemem.mockReturnValue(200_000_000);
        mockStorage.getTeams.mockResolvedValue(buildAtFloorTeams());

        // No setEventBus call
        for (let i = 0; i < 10; i++) {
          await provider.executeWakeAction(buildAction());
        }
        // No throw, no crash — pure no-op observable only via the
        // absence of additional logger warnings, which we don't assert
        // here. The contract is "must not throw".
      });

      it('clears the skip counter on a successful wake under pressure (skip→wake→skip cannot accumulate)', async () => {
        // Follow-up #6 from PR #543 review. Without this contract, a
        // pressure episode that oscillates between "at floor → wake →
        // back at floor" would let `consecutivePressureSkips` keep
        // climbing across the wake events, producing an extra event
        // each time the throttle window opens.
        const publish = jest.fn();
        provider.setEventBus({ publish } as any);

        mockTotalmem.mockReturnValue(16_000_000_000);
        mockFreemem.mockReturnValue(200_000_000);

        // Phase 1: 4 skips at floor — below threshold, no fire yet.
        mockStorage.getTeams.mockResolvedValue(buildAtFloorTeams());
        for (let i = 0; i < 4; i++) {
          await provider.executeWakeAction(buildAction());
        }
        expect(publish).not.toHaveBeenCalled();

        // Phase 2: active count drops below floor → one successful
        // wake — this MUST reset the skip counter.
        mockStorage.getTeams.mockResolvedValueOnce([
          {
            id: 't1',
            members: [
              { id: 'm1', sessionName: 's1', agentStatus: 'active', role: 'dev', updatedAt: '' },
            ],
          },
        ]);
        mockSuspend.isSuspended.mockReturnValue(true);
        mockSuspend.rehydrateAgent.mockResolvedValue(true);
        await provider.executeWakeAction(buildAction());

        // Phase 3: back at floor, 4 more skips. Pre-fix this would
        // bring the running total to 8 (≥ threshold of 5) and trigger
        // a publish. With the fix it's only 4 — still below threshold.
        mockStorage.getTeams.mockResolvedValue(buildAtFloorTeams());
        for (let i = 0; i < 4; i++) {
          await provider.executeWakeAction(buildAction());
        }
        expect(publish).not.toHaveBeenCalled();

        // Phase 4: 5th skip after the reset finally crosses threshold.
        await provider.executeWakeAction(buildAction());
        expect(publish).toHaveBeenCalledTimes(1);
      });

      it('survives an EventBus publish failure without breaking the reconciler', async () => {
        mockTotalmem.mockReturnValue(16_000_000_000);
        mockFreemem.mockReturnValue(200_000_000);
        mockStorage.getTeams.mockResolvedValue(buildAtFloorTeams());

        const publish = jest.fn(() => {
          throw new Error('bus down');
        });
        provider.setEventBus({ publish } as any);

        for (let i = 0; i < 5; i++) {
          await provider.executeWakeAction(buildAction());
        }

        // We attempted to publish (the throw was thrown) but the wake
        // path still returned cleanly without surfacing the error.
        expect(publish).toHaveBeenCalled();
      });
    });
  });
});
