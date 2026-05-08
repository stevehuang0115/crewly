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
  };
  return {
    TaskPoolService: {
      getInstance: () => mockInstance,
      _mockInstance: mockInstance,
    },
  };
});

jest.mock('../core/storage.service.js', () => {
  const mockStorage = {
    getTeams: jest.fn().mockResolvedValue([]),
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

import { LiveReconcilerDataProvider } from './reconciler-data-provider.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { StorageService } from '../core/storage.service.js';
import { AgentSuspendService } from '../agent/agent-suspend.service.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TaskClaim } from '../../types/v2/claim.types.js';
import type { WakeAction } from '../../types/v2/reconcile.types.js';

// Access mock instances via type assertions
const mockPool = (TaskPoolService as any)._mockInstance;
const mockStorage = (StorageService as any)._mockStorage;
const mockSuspend = (AgentSuspendService as any)._mockSuspend;

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

      expect(mockPool.updateItemStatus).toHaveBeenCalledWith('wi-1', 'blocked');
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
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/teams/members/start'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ sessionName: 'agent-idle' }),
        }),
      );

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

    it('should skip wake action under memory pressure (>=90%)', async () => {
      // Simulate >=90% memory usage
      mockTotalmem.mockReturnValue(16_000_000_000); // 16GB
      mockFreemem.mockReturnValue(800_000_000);      // 800MB free = 95% used

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

      // Should return false without calling rehydrate because of memory pressure
      expect(result).toBe(false);
      expect(mockSuspend.rehydrateAgent).not.toHaveBeenCalled();

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
  });
});
