/**
 * Tests for LiveReconcilerDataProvider
 *
 * Validates that the live data provider correctly wires to real services
 * and implements the ReconcilerDataProvider interface.
 */


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
  });
});
