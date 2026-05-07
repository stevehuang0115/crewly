/**
 * Tests for MissionExecutorService — lightweight Mission orchestration.
 *
 * @module services/v3/mission-executor.service.test
 */

import { MissionExecutorService, type DecompositionResult } from './mission-executor.service.js';
import type { Mission } from '../../types/v2/mission.types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAddToPool = jest.fn().mockResolvedValue(undefined);
const mockGetAllItems = jest.fn().mockResolvedValue([]);
const mockUpdateItemStatus = jest.fn().mockResolvedValue(undefined);

jest.mock('../task-pool/task-pool.service.js', () => ({
  TaskPoolService: {
    getInstance: () => ({
      addToPool: mockAddToPool,
      getAllItems: mockGetAllItems,
      updateItemStatus: mockUpdateItemStatus,
    }),
  },
}));

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    objective: 'Build auth system',
    ownerTeamId: 'team-1',
    successCriteria: ['All tests pass'],
    currentStrategy: 'Implement incrementally',
    activeProjectTaskIds: [],
    cadence: '0 9 * * 1',
    policy: {
      missionId: 'mission-1',
      canCreateTasks: true,
      canReprioritizeTasks: true,
      canCloseTasks: true,
      canDeployToStaging: false,
      canDeployToProd: false,
      canSpendMoney: false,
      canChangeUserVisibleBehaviorWithoutReview: false,
      maxParallelExecutions: 3,
      escalationRules: [],
    },
    status: 'active',
    learnings: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Mission;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MissionExecutorService', () => {
  beforeEach(() => {
    MissionExecutorService.resetInstance();
    jest.clearAllMocks();
    mockGetAllItems.mockResolvedValue([]);
  });

  describe('processDecomposition', () => {
    it('should create WorkItems from decomposition result', async () => {
      const service = MissionExecutorService.getInstance();
      const mission = makeMission();

      const result: DecompositionResult = {
        missionId: 'mission-1',
        phase: 1,
        tasks: [
          { title: 'Design schema', description: 'Design DB schema', type: 'delegate', priority: 'high' },
          { title: 'Implement API', description: 'Build REST endpoints', type: 'delegate', priority: 'medium' },
        ],
      };

      const ids = await service.processDecomposition(result, mission);
      expect(ids).toHaveLength(2);
      expect(mockAddToPool).toHaveBeenCalledTimes(2);

      // Verify first WorkItem
      const firstCall = mockAddToPool.mock.calls[0][0];
      expect(firstCall.title).toBe('Design schema');
      expect(firstCall.missionId).toBe('mission-1');
      expect(firstCall.status).toBe('queued');
    });

    it('should set blocked status for tasks with dependencies', async () => {
      const service = MissionExecutorService.getInstance();
      const mission = makeMission();

      const result: DecompositionResult = {
        missionId: 'mission-1',
        phase: 1,
        tasks: [
          { title: 'Design schema', description: 'Design DB', type: 'delegate', priority: 'high' },
          { title: 'Implement API', description: 'Build API', type: 'delegate', priority: 'medium', dependsOn: ['Design schema'] },
        ],
      };

      await service.processDecomposition(result, mission);

      const secondCall = mockAddToPool.mock.calls[1][0];
      expect(secondCall.status).toBe('blocked');
      // V3 canonical: deps live on `WorkItem.dependsOn` (resolved IDs),
      // not the dead `metadata._dependsOnTitles` key. The first call's
      // id is what the second item depends on.
      const firstCall = mockAddToPool.mock.calls[0][0];
      expect(secondCall.dependsOn).toContain(firstCall.id);
    });

    it('should reject if policy disallows task creation', async () => {
      const service = MissionExecutorService.getInstance();
      const mission = makeMission({
        policy: {
          ...makeMission().policy,
          canCreateTasks: false,
        },
      });

      const result: DecompositionResult = {
        missionId: 'mission-1',
        phase: 1,
        tasks: [{ title: 'Task', description: 'Desc', type: 'delegate', priority: 'medium' }],
      };

      await expect(service.processDecomposition(result, mission)).rejects.toThrow('policy does not allow');
    });
  });

  describe('checkProgress', () => {
    it('should compute correct progress from WorkItem statuses', async () => {
      const service = MissionExecutorService.getInstance();

      mockGetAllItems.mockResolvedValueOnce([
        { id: 'wi-1', missionId: 'mission-1', status: 'done', cost: 0.5 },
        { id: 'wi-2', missionId: 'mission-1', status: 'running', cost: 0.3 },
        { id: 'wi-3', missionId: 'mission-1', status: 'queued', cost: 0 },
        { id: 'wi-4', missionId: 'mission-1', status: 'blocked', cost: 0 },
        { id: 'wi-other', missionId: 'other', status: 'done', cost: 1 },
      ]);

      const progress = await service.checkProgress('mission-1');
      expect(progress.totalTasks).toBe(4);
      expect(progress.completedTasks).toBe(1);
      expect(progress.runningTasks).toBe(1);
      expect(progress.queuedTasks).toBe(1);
      expect(progress.blockedTasks).toBe(1);
      expect(progress.progressPercent).toBe(25);
      expect(progress.totalCost).toBeCloseTo(0.8);
      expect(progress.status).toBe('executing');
    });

    it('should return planning status for empty mission', async () => {
      const service = MissionExecutorService.getInstance();
      const progress = await service.checkProgress('empty-mission');
      expect(progress.totalTasks).toBe(0);
      expect(progress.status).toBe('planning');
    });

    it('should return completed when all tasks done', async () => {
      const service = MissionExecutorService.getInstance();

      mockGetAllItems.mockResolvedValueOnce([
        { id: 'wi-1', missionId: 'mission-1', status: 'done', cost: 0.5 },
        { id: 'wi-2', missionId: 'mission-1', status: 'done', cost: 0.3 },
      ]);

      const progress = await service.checkProgress('mission-1');
      expect(progress.status).toBe('completed');
      expect(progress.progressPercent).toBe(100);
    });
  });

  describe('pauseMission / resumeMission', () => {
    it('should freeze queued tasks to scheduled', async () => {
      const service = MissionExecutorService.getInstance();

      mockGetAllItems.mockResolvedValueOnce([
        { id: 'wi-1', missionId: 'mission-1', status: 'queued' },
        { id: 'wi-2', missionId: 'mission-1', status: 'running' },
        { id: 'wi-3', missionId: 'mission-1', status: 'queued' },
      ]);

      const count = await service.pauseMission('mission-1');
      expect(count).toBe(2); // Only queued items frozen
      expect(mockUpdateItemStatus).toHaveBeenCalledTimes(2);
      expect(mockUpdateItemStatus).toHaveBeenCalledWith('wi-1', 'scheduled');
      expect(mockUpdateItemStatus).toHaveBeenCalledWith('wi-3', 'scheduled');
    });

    it('should unfreeze scheduled tasks to queued', async () => {
      const service = MissionExecutorService.getInstance();

      mockGetAllItems.mockResolvedValueOnce([
        { id: 'wi-1', missionId: 'mission-1', status: 'scheduled' },
        { id: 'wi-2', missionId: 'mission-1', status: 'running' },
      ]);

      const count = await service.resumeMission('mission-1');
      expect(count).toBe(1);
      expect(mockUpdateItemStatus).toHaveBeenCalledWith('wi-1', 'queued');
    });
  });
});
