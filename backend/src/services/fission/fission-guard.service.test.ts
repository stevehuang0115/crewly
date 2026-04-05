/**
 * FissionGuardService Tests
 *
 * Tests all 6 guardrails: maxDepth, maxTasks, rateLimit,
 * branchingFactor, TTL, and budgetGate. Also tests violation
 * history and configuration updates.
 *
 * @module services/fission/fission-guard.service.test
 */

import { FissionGuardService, type FissionDataProvider, type BudgetChecker } from './fission-guard.service.js';
import { DEFAULT_FISSION_CONFIG } from './fission-guard.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress logger output in tests */
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

/** Stub uuid for deterministic violation IDs */
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-001',
}));

/**
 * Creates a mock WorkItem with sensible defaults.
 *
 * @param overrides - Fields to override
 * @returns A WorkItem suitable for testing
 */
function createMockWorkItem(overrides?: Partial<WorkItem>): WorkItem {
  return {
    id: 'wi-parent',
    type: 'delegate',
    owner: 'agent',
    target: 'agent-leo',
    title: 'Test WorkItem',
    status: 'running',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    ...overrides,
  };
}

/**
 * Creates a mock FissionDataProvider.
 *
 * @returns Mock data provider with spied methods
 */
function createMockDataProvider(): FissionDataProvider {
  return {
    getWorkItemById: jest.fn().mockResolvedValue(null),
    countMissionWorkItems: jest.fn().mockResolvedValue(0),
    countChildWorkItems: jest.fn().mockResolvedValue(0),
  };
}

/**
 * Creates a mock BudgetChecker.
 *
 * @param withinBudget - Whether the agent is within budget
 * @returns Mock budget checker
 */
function createMockBudgetChecker(withinBudget = true): BudgetChecker {
  return {
    isWithinBudget: jest.fn().mockResolvedValue(withinBudget),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FissionGuardService', () => {
  let dataProvider: FissionDataProvider;
  let guard: FissionGuardService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-05T12:00:00.000Z'));
    FissionGuardService.resetInstance();
    dataProvider = createMockDataProvider();
    guard = new FissionGuardService(dataProvider);
  });

  afterEach(() => {
    jest.useRealTimers();
    FissionGuardService.resetInstance();
  });

  // -----------------------------------------------------------------------
  // Guardrail 1: maxDepth
  // -----------------------------------------------------------------------
  describe('maxDepth', () => {
    it('allows creation at depth 0 (root parent)', async () => {
      const parent = createMockWorkItem();
      const result = await guard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(true);
    });

    it('allows creation at depth 2 (child would be depth 3 = max)', async () => {
      // Parent is at depth 2: grandparent -> parent
      const grandparent = createMockWorkItem({ id: 'wi-gp' });
      const parent = createMockWorkItem({ id: 'wi-parent', parentWorkItemId: 'wi-mid' });
      const mid = createMockWorkItem({ id: 'wi-mid', parentWorkItemId: 'wi-gp' });

      (dataProvider.getWorkItemById as jest.Mock)
        .mockImplementation(async (id: string) => {
          if (id === 'wi-mid') return mid;
          if (id === 'wi-gp') return grandparent;
          return null;
        });

      const result = await guard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(true);
    });

    it('blocks creation when depth would exceed maxDepth', async () => {
      // Parent is at depth 3 (already at max) → child would be depth 4
      const root = createMockWorkItem({ id: 'wi-root' });
      const l1 = createMockWorkItem({ id: 'wi-l1', parentWorkItemId: 'wi-root' });
      const l2 = createMockWorkItem({ id: 'wi-l2', parentWorkItemId: 'wi-l1' });
      const parent = createMockWorkItem({ id: 'wi-parent', parentWorkItemId: 'wi-l2' });

      (dataProvider.getWorkItemById as jest.Mock)
        .mockImplementation(async (id: string) => {
          if (id === 'wi-l2') return l2;
          if (id === 'wi-l1') return l1;
          if (id === 'wi-root') return root;
          return null;
        });

      const result = await guard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('max_depth');
      expect(result.reason).toContain('depth');
    });

    it('uses custom maxDepth from config', async () => {
      const customGuard = new FissionGuardService(dataProvider, null, { maxDepth: 1 });
      const parent = createMockWorkItem({ parentWorkItemId: 'wi-root' });
      (dataProvider.getWorkItemById as jest.Mock)
        .mockResolvedValue(createMockWorkItem({ id: 'wi-root' }));

      // Parent is at depth 1, child would be depth 2 > maxDepth=1
      const result = await customGuard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('max_depth');
    });
  });

  // -----------------------------------------------------------------------
  // Guardrail 2: maxTasks
  // -----------------------------------------------------------------------
  describe('maxTasks', () => {
    it('allows creation when mission has few tasks', async () => {
      (dataProvider.countMissionWorkItems as jest.Mock).mockResolvedValue(10);
      const parent = createMockWorkItem();
      const result = await guard.canCreateSubTask(parent, 'agent-1', 'mission-1');
      expect(result.allowed).toBe(true);
    });

    it('blocks when mission reaches maxTasksPerMission', async () => {
      (dataProvider.countMissionWorkItems as jest.Mock).mockResolvedValue(50);
      const parent = createMockWorkItem();
      const result = await guard.canCreateSubTask(parent, 'agent-1', 'mission-1');
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('max_tasks');
    });

    it('blocks at hard limit even with custom config', async () => {
      const customGuard = new FissionGuardService(dataProvider, null, {
        maxTasksPerMission: 300, // Above hard limit
        hardMaxTasksPerMission: 200,
      });
      (dataProvider.countMissionWorkItems as jest.Mock).mockResolvedValue(200);
      const parent = createMockWorkItem();
      const result = await customGuard.canCreateSubTask(parent, 'agent-1', 'mission-1');
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('max_tasks');
      expect(result.reason).toContain('hard limit');
    });

    it('skips maxTasks check when no missionId provided', async () => {
      const parent = createMockWorkItem();
      const result = await guard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(true);
      expect(dataProvider.countMissionWorkItems).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Guardrail 3: Rate limit
  // -----------------------------------------------------------------------
  describe('rateLimit', () => {
    it('allows first creation within window', async () => {
      const parent = createMockWorkItem();
      const result = await guard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(true);
    });

    it('allows up to rateLimitMaxCreations within window', async () => {
      const parent = createMockWorkItem();

      // Create 4 (limit is 5)
      for (let i = 0; i < 4; i++) {
        const r = await guard.canCreateSubTask(parent, 'agent-1');
        expect(r.allowed).toBe(true);
      }

      // 5th should still be allowed (it's the 5th creation at check time,
      // but the rate limiter counts previous creations, and this is the 5th call)
      const r5 = await guard.canCreateSubTask(parent, 'agent-1');
      expect(r5.allowed).toBe(true);
    });

    it('blocks when rate limit is exceeded', async () => {
      const parent = createMockWorkItem();

      // Create 5 (reaches limit)
      for (let i = 0; i < 5; i++) {
        await guard.canCreateSubTask(parent, 'agent-1');
      }

      // 6th should be blocked
      const result = await guard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('rate_limit');
    });

    it('allows again after window expires', async () => {
      const parent = createMockWorkItem();

      // Exhaust rate limit
      for (let i = 0; i < 5; i++) {
        await guard.canCreateSubTask(parent, 'agent-1');
      }

      // Advance time past the window
      jest.advanceTimersByTime(DEFAULT_FISSION_CONFIG.rateLimitWindowMs + 1);

      const result = await guard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(true);
    });

    it('tracks agents independently', async () => {
      const parent = createMockWorkItem();

      // Agent-1 exhausts limit
      for (let i = 0; i < 5; i++) {
        await guard.canCreateSubTask(parent, 'agent-1');
      }

      // Agent-2 should still be allowed
      const result = await guard.canCreateSubTask(parent, 'agent-2');
      expect(result.allowed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Guardrail 4: Branching factor
  // -----------------------------------------------------------------------
  describe('branchingFactor', () => {
    it('allows creation when parent has few children', async () => {
      (dataProvider.countChildWorkItems as jest.Mock).mockResolvedValue(2);
      const parent = createMockWorkItem();
      const result = await guard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(true);
    });

    it('blocks when parent has maxBranchingFactor children', async () => {
      (dataProvider.countChildWorkItems as jest.Mock).mockResolvedValue(5);
      const parent = createMockWorkItem();
      const result = await guard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('branching_factor');
    });

    it('uses custom branching factor', async () => {
      const customGuard = new FissionGuardService(dataProvider, null, { maxBranchingFactor: 2 });
      (dataProvider.countChildWorkItems as jest.Mock).mockResolvedValue(2);
      const parent = createMockWorkItem();
      const result = await customGuard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('branching_factor');
    });
  });

  // -----------------------------------------------------------------------
  // Guardrail 5: TTL
  // -----------------------------------------------------------------------
  describe('TTL', () => {
    it('allows creation when parent is within TTL', async () => {
      const parent = createMockWorkItem({
        createdAt: new Date(Date.now() - 3_600_000).toISOString(), // 1h ago
      });
      const result = await guard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(true);
    });

    it('blocks when parent exceeds max TTL', async () => {
      const parent = createMockWorkItem({
        createdAt: new Date(Date.now() - DEFAULT_FISSION_CONFIG.maxTtlMs - 1).toISOString(),
      });
      const result = await guard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('ttl_exceeded');
    });

    it('allows at exactly max TTL boundary', async () => {
      const parent = createMockWorkItem({
        createdAt: new Date(Date.now() - DEFAULT_FISSION_CONFIG.maxTtlMs + 1000).toISOString(),
      });
      const result = await guard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Guardrail 6: Budget gate
  // -----------------------------------------------------------------------
  describe('budgetGate', () => {
    it('allows when budget checker says within budget', async () => {
      const budgetChecker = createMockBudgetChecker(true);
      const budgetGuard = new FissionGuardService(dataProvider, budgetChecker);
      const parent = createMockWorkItem();
      const result = await budgetGuard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(true);
      expect(budgetChecker.isWithinBudget).toHaveBeenCalledWith('agent-1');
    });

    it('blocks when budget exceeded', async () => {
      const budgetChecker = createMockBudgetChecker(false);
      const budgetGuard = new FissionGuardService(dataProvider, budgetChecker);
      const parent = createMockWorkItem();
      const result = await budgetGuard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('budget_exceeded');
    });

    it('allows when budget gate is disabled', async () => {
      const budgetChecker = createMockBudgetChecker(false);
      const budgetGuard = new FissionGuardService(dataProvider, budgetChecker, {
        budgetGateEnabled: false,
      });
      const parent = createMockWorkItem();
      const result = await budgetGuard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(true);
      expect(budgetChecker.isWithinBudget).not.toHaveBeenCalled();
    });

    it('allows when no budget checker is provided', async () => {
      const guard = new FissionGuardService(dataProvider, null, { budgetGateEnabled: true });
      const parent = createMockWorkItem();
      const result = await guard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(true);
    });

    it('allows on budget check error (non-fatal)', async () => {
      const budgetChecker: BudgetChecker = {
        isWithinBudget: jest.fn().mockRejectedValue(new Error('service down')),
      };
      const budgetGuard = new FissionGuardService(dataProvider, budgetChecker);
      const parent = createMockWorkItem();
      const result = await budgetGuard.canCreateSubTask(parent, 'agent-1');
      expect(result.allowed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Violation History
  // -----------------------------------------------------------------------
  describe('violation history', () => {
    it('records violations on blocked creation', async () => {
      (dataProvider.countChildWorkItems as jest.Mock).mockResolvedValue(5);
      const parent = createMockWorkItem();
      await guard.canCreateSubTask(parent, 'agent-1');

      const violations = guard.getViolations();
      expect(violations).toHaveLength(1);
      expect(violations[0].violationType).toBe('branching_factor');
      expect(violations[0].agentId).toBe('agent-1');
      expect(violations[0].parentWorkItemId).toBe('wi-parent');
    });

    it('does not record violations on allowed creation', async () => {
      const parent = createMockWorkItem();
      await guard.canCreateSubTask(parent, 'agent-1');

      const violations = guard.getViolations();
      expect(violations).toHaveLength(0);
    });

    it('limits violation history to maxViolationHistory', async () => {
      const limitedGuard = new FissionGuardService(dataProvider, null, {
        maxViolationHistory: 3,
        maxBranchingFactor: 0, // Ensure every check fails
      });
      (dataProvider.countChildWorkItems as jest.Mock).mockResolvedValue(1);

      const parent = createMockWorkItem();
      for (let i = 0; i < 5; i++) {
        await limitedGuard.canCreateSubTask(parent, `agent-${i}`);
      }

      expect(limitedGuard.getViolations()).toHaveLength(3);
    });

    it('filters violations by type', async () => {
      // Create one branching factor violation
      (dataProvider.countChildWorkItems as jest.Mock).mockResolvedValue(5);
      const parent = createMockWorkItem();
      await guard.canCreateSubTask(parent, 'agent-1');

      expect(guard.getViolationsByType('branching_factor')).toHaveLength(1);
      expect(guard.getViolationsByType('max_depth')).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------
  describe('configuration', () => {
    it('returns current config', () => {
      const config = guard.getConfig();
      expect(config.maxDepth).toBe(DEFAULT_FISSION_CONFIG.maxDepth);
      expect(config).not.toBe(guard.getConfig()); // Returns copy
    });

    it('updates config at runtime', () => {
      guard.updateConfig({ maxDepth: 5, maxBranchingFactor: 10 });
      const config = guard.getConfig();
      expect(config.maxDepth).toBe(5);
      expect(config.maxBranchingFactor).toBe(10);
    });

    it('caps maxTasksPerMission at hardMaxTasksPerMission', () => {
      guard.updateConfig({ maxTasksPerMission: 999 });
      const config = guard.getConfig();
      expect(config.maxTasksPerMission).toBe(DEFAULT_FISSION_CONFIG.hardMaxTasksPerMission);
    });
  });

  // -----------------------------------------------------------------------
  // Singleton
  // -----------------------------------------------------------------------
  describe('singleton', () => {
    it('throws if getInstance called before init', () => {
      expect(() => FissionGuardService.getInstance()).toThrow('not initialized');
    });

    it('returns initialized instance', () => {
      FissionGuardService.init(dataProvider);
      const instance = FissionGuardService.getInstance();
      expect(instance).toBeInstanceOf(FissionGuardService);
    });

    it('resetInstance clears singleton', () => {
      FissionGuardService.init(dataProvider);
      FissionGuardService.resetInstance();
      expect(() => FissionGuardService.getInstance()).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Guard evaluation order
  // -----------------------------------------------------------------------
  describe('evaluation order', () => {
    it('returns first violation when multiple guardrails would fail', async () => {
      // Setup: depth exceeded AND branching factor exceeded
      const root = createMockWorkItem({ id: 'wi-root' });
      const l1 = createMockWorkItem({ id: 'wi-l1', parentWorkItemId: 'wi-root' });
      const l2 = createMockWorkItem({ id: 'wi-l2', parentWorkItemId: 'wi-l1' });
      const parent = createMockWorkItem({ id: 'wi-parent', parentWorkItemId: 'wi-l2' });

      (dataProvider.getWorkItemById as jest.Mock)
        .mockImplementation(async (id: string) => {
          if (id === 'wi-l2') return l2;
          if (id === 'wi-l1') return l1;
          if (id === 'wi-root') return root;
          return null;
        });
      (dataProvider.countChildWorkItems as jest.Mock).mockResolvedValue(10);

      const result = await guard.canCreateSubTask(parent, 'agent-1');
      // maxDepth is checked first
      expect(result.violationType).toBe('max_depth');
    });
  });
});
