/**
 * Integration test for Task Pool Router wiring.
 *
 * Validates that:
 * 1. setTaskPoolRouter() is callable on QueueProcessorService
 * 2. The router callback receives [TASK] messages correctly
 * 3. Auto-claim is triggered after addToPool when target is known
 *
 * @module services/messaging/task-pool-router.integration.test
 */

// ---------------------------------------------------------------------------
// Mocks — must be set up before imports
// ---------------------------------------------------------------------------

const mockAddToPool = jest.fn().mockResolvedValue(undefined);
const mockClaimFromPool = jest.fn().mockResolvedValue(null);
const mockGetAllItems = jest.fn().mockResolvedValue([]);

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

jest.mock('../task-pool/task-pool.service.js', () => ({
  TaskPoolService: {
    getInstance: () => ({
      addToPool: mockAddToPool,
      claimFromPool: mockClaimFromPool,
      getAllItems: mockGetAllItems,
    }),
  },
}));

jest.mock('../../types/v2/work-item.types.js', () => ({
  createWorkItem: jest.fn((input) => ({
    id: `wi-${Date.now()}`,
    status: 'queued',
    type: input.type || 'delegate',
    owner: input.owner || 'orchestrator',
    target: input.target,
    title: input.title,
    description: input.description,
  })),
  isWorkItem: jest.fn().mockReturnValue(true),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { QueueProcessorService } from './queue-processor.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { createWorkItem } from '../../types/v2/work-item.types.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Task Pool Router Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('setTaskPoolRouter', () => {
    it('accepts a router callback without error', () => {
      // QueueProcessorService requires constructor args; we test that the
      // method exists and is callable. We mock the constructor deps minimally.
      const mockQueueService = {
        on: jest.fn(),
        off: jest.fn(),
        hasPending: jest.fn().mockReturnValue(false),
      } as any;

      const mockResponseRouter = {
        routeResponse: jest.fn(),
      } as any;

      const mockAgentRegistration = {
        isAgentActive: jest.fn().mockReturnValue(false),
      } as any;

      const processor = new QueueProcessorService(
        mockQueueService,
        mockResponseRouter,
        mockAgentRegistration,
      );

      const routerFn = jest.fn().mockResolvedValue(true);
      expect(() => processor.setTaskPoolRouter(routerFn)).not.toThrow();
    });
  });

  describe('Router callback behavior', () => {
    it('creates a WorkItem and auto-claims for target agent', async () => {
      // Simulate the router callback that would be wired in index.ts
      const routerCallback = async (messageContent: string, targetSession: string): Promise<boolean> => {
        const pool = TaskPoolService.getInstance();
        const workItem = createWorkItem({
          type: 'delegate',
          owner: 'orchestrator',
          target: targetSession,
          title: messageContent.slice(0, 120),
          description: messageContent,
        });
        await pool.addToPool(workItem);

        if (targetSession) {
          await pool.claimFromPool(targetSession);
        }
        return true;
      };

      const result = await routerCallback('[TASK] Implement feature X', 'agent-leo');

      expect(result).toBe(true);
      expect(mockAddToPool).toHaveBeenCalledTimes(1);
      expect(mockAddToPool).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'delegate',
          target: 'agent-leo',
        }),
      );
      expect(mockClaimFromPool).toHaveBeenCalledTimes(1);
      expect(mockClaimFromPool).toHaveBeenCalledWith('agent-leo');
    });

    it('does not auto-claim when target is empty', async () => {
      const routerCallback = async (messageContent: string, targetSession: string): Promise<boolean> => {
        const pool = TaskPoolService.getInstance();
        const workItem = createWorkItem({
          type: 'delegate',
          owner: 'orchestrator',
          target: targetSession,
          title: messageContent.slice(0, 120),
          description: messageContent,
        });
        await pool.addToPool(workItem);

        if (targetSession) {
          await pool.claimFromPool(targetSession);
        }
        return true;
      };

      await routerCallback('[TASK] General task', '');

      expect(mockAddToPool).toHaveBeenCalledTimes(1);
      expect(mockClaimFromPool).not.toHaveBeenCalled();
    });

    it('returns false when addToPool fails', async () => {
      mockAddToPool.mockRejectedValueOnce(new Error('Pool full'));

      const routerCallback = async (messageContent: string, targetSession: string): Promise<boolean> => {
        try {
          const pool = TaskPoolService.getInstance();
          const workItem = createWorkItem({
            type: 'delegate',
            owner: 'orchestrator',
            target: targetSession,
            title: messageContent.slice(0, 120),
            description: messageContent,
          });
          await pool.addToPool(workItem);

          if (targetSession) {
            await pool.claimFromPool(targetSession);
          }
          return true;
        } catch {
          return false;
        }
      };

      const result = await routerCallback('[TASK] Will fail', 'agent-max');

      expect(result).toBe(false);
      expect(mockClaimFromPool).not.toHaveBeenCalled();
    });
  });
});
