/**
 * Tests for EscalationService — periodic MissionPolicy escalation rule evaluation.
 *
 * @module services/v3/escalation.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mission, EscalationRule, MissionPolicy, EscalationContext } from '../../types/v2/index.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockGetAllItems,
  mockUpdateItemStatus,
  mockReaddir,
  mockSafeReadJson,
  mockTriggerCreate,
  mockTriggerCancel,
  mockTriggerSetActionHandler,
} = vi.hoisted(() => ({
  mockGetAllItems: vi.fn().mockResolvedValue([]),
  mockUpdateItemStatus: vi.fn().mockResolvedValue(undefined),
  mockReaddir: vi.fn().mockResolvedValue([]),
  mockSafeReadJson: vi.fn().mockResolvedValue(null),
  mockTriggerCreate: vi.fn().mockResolvedValue({ id: 'trigger-esc-001' }),
  mockTriggerCancel: vi.fn().mockResolvedValue(true),
  mockTriggerSetActionHandler: vi.fn(),
}));

vi.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }),
  },
}));

vi.mock('../task-pool/task-pool.service.js', () => ({
  TaskPoolService: {
    getInstance: () => ({
      getAllItems: mockGetAllItems,
      updateItemStatus: mockUpdateItemStatus,
    }),
  },
}));

vi.mock('../../utils/file-io.utils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  safeReadJson: (...args: unknown[]) => mockSafeReadJson(...args),
}));

vi.mock('fs/promises', () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
}));

// Store the action handler passed to TriggerEngine so we can invoke it in tests
let capturedTriggerActionHandler: Function | null = null;

vi.mock('./trigger-engine.service.js', () => ({
  TriggerEngine: {
    getInstance: () => ({
      create: mockTriggerCreate,
      cancel: mockTriggerCancel,
      actionHandler: null,
      setActionHandler: (handler: Function) => {
        capturedTriggerActionHandler = handler;
        mockTriggerSetActionHandler(handler);
      },
    }),
  },
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { EscalationService } from './escalation.service.js';
import { PolicyEnforcementService } from '../policy/policy-enforcement.service.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PROJECT_PATH = '/test/project';

/**
 * Creates a test Mission with the given escalation rules.
 */
function makeMission(opts: {
  id?: string;
  status?: string;
  escalationRules?: EscalationRule[];
  createdAt?: string;
} = {}): Mission {
  const rules = opts.escalationRules ?? [];
  return {
    id: opts.id ?? 'mission-001',
    objective: 'Test objective',
    ownerTeamId: 'team-001',
    successCriteria: ['criterion 1'],
    currentStrategy: 'build it',
    activeProjectTaskIds: [],
    cadence: '0 9 * * 1',
    policy: {
      missionId: opts.id ?? 'mission-001',
      canCreateTasks: true,
      canReprioritizeTasks: true,
      canCloseTasks: true,
      canDeployToStaging: false,
      canDeployToProd: false,
      canSpendMoney: false,
      canChangeUserVisibleBehaviorWithoutReview: false,
      maxParallelExecutions: 3,
      escalationRules: rules,
    },
    status: (opts.status ?? 'active') as any,
    createdAt: opts.createdAt ?? new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
    updatedAt: new Date().toISOString(),
    learnings: [],
  };
}

/**
 * Creates a test WorkItem stub.
 */
function makeWorkItem(opts: {
  id?: string;
  missionId?: string;
  status?: string;
  cost?: number;
}) {
  return {
    id: opts.id ?? 'wi-001',
    missionId: opts.missionId ?? 'mission-001',
    status: opts.status ?? 'running',
    cost: opts.cost ?? 0,
    type: 'delegate',
    owner: 'orchestrator',
    title: 'Test',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EscalationService', () => {
  let service: EscalationService;
  let policyService: PolicyEnforcementService;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedTriggerActionHandler = null;
    policyService = new PolicyEnforcementService();
    service = new EscalationService(PROJECT_PATH, policyService);
  });

  afterEach(async () => {
    await service.stop();
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe('start()', () => {
    it('should register a cron trigger with TriggerEngine', async () => {
      await service.start();

      expect(service.isStarted()).toBe(true);
      expect(mockTriggerCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'time',
          config: expect.objectContaining({
            type: 'time',
            cronExpression: '*/5 * * * *',
          }),
          createdBy: 'system',
        }),
      );
    });

    it('should accept custom cron expression', async () => {
      await service.start('0 */2 * * *');

      expect(mockTriggerCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            cronExpression: '0 */2 * * *',
          }),
        }),
      );
    });

    it('should not start twice', async () => {
      await service.start();
      await service.start();

      expect(mockTriggerCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop()', () => {
    it('should cancel the trigger on stop', async () => {
      await service.start();
      await service.stop();

      expect(service.isStarted()).toBe(false);
      expect(mockTriggerCancel).toHaveBeenCalledWith('trigger-esc-001');
    });
  });

  // -----------------------------------------------------------------------
  // Evaluate
  // -----------------------------------------------------------------------

  describe('evaluate()', () => {
    it('should return empty summary when no active missions exist', async () => {
      mockReaddir.mockResolvedValueOnce([]);

      const summary = await service.evaluate();

      expect(summary.missionsEvaluated).toBe(0);
      expect(summary.escalationsTriggered).toBe(0);
      expect(summary.results).toEqual([]);
    });

    it('should evaluate missions with escalation rules', async () => {
      const mission = makeMission({
        escalationRules: [
          { condition: 'cost_exceeded', threshold: 10, escalateTo: 'user', action: 'notify' },
        ],
      });

      mockReaddir.mockResolvedValueOnce(['mission-001.json']);
      mockSafeReadJson.mockResolvedValueOnce(mission);

      // WorkItems: total cost = 15 (exceeds threshold of 10)
      mockGetAllItems.mockResolvedValue([
        makeWorkItem({ missionId: 'mission-001', cost: 15 }),
      ]);

      const summary = await service.evaluate();

      expect(summary.missionsEvaluated).toBe(1);
      expect(summary.escalationsTriggered).toBe(1);
      expect(summary.results[0].escalation.triggered).toBe(true);
      expect(summary.results[0].actionsExecuted.length).toBeGreaterThan(0);
    });

    it('should not trigger when thresholds are not exceeded', async () => {
      const mission = makeMission({
        escalationRules: [
          { condition: 'cost_exceeded', threshold: 100, escalateTo: 'user', action: 'notify' },
        ],
      });

      mockReaddir.mockResolvedValueOnce(['mission-001.json']);
      mockSafeReadJson.mockResolvedValueOnce(mission);

      // Cost is 5, threshold is 100 — no trigger
      mockGetAllItems.mockResolvedValue([
        makeWorkItem({ missionId: 'mission-001', cost: 5 }),
      ]);

      const summary = await service.evaluate();

      expect(summary.missionsEvaluated).toBe(1);
      expect(summary.escalationsTriggered).toBe(0);
    });

    it('should handle failure_count escalation', async () => {
      const mission = makeMission({
        escalationRules: [
          { condition: 'failure_count', threshold: 2, escalateTo: 'orchestrator', action: 'pause' },
        ],
      });

      mockReaddir.mockResolvedValueOnce(['mission-001.json']);
      mockSafeReadJson.mockResolvedValueOnce(mission);

      // 3 failed WorkItems — exceeds threshold of 2
      mockGetAllItems.mockResolvedValue([
        makeWorkItem({ id: 'wi-1', missionId: 'mission-001', status: 'failed' }),
        makeWorkItem({ id: 'wi-2', missionId: 'mission-001', status: 'failed' }),
        makeWorkItem({ id: 'wi-3', missionId: 'mission-001', status: 'failed' }),
      ]);

      const summary = await service.evaluate();

      expect(summary.escalationsTriggered).toBe(1);
      expect(summary.results[0].escalation.requiredAction).toBe('pause');
    });

    it('should handle time_exceeded escalation', async () => {
      const mission = makeMission({
        createdAt: new Date(Date.now() - 48 * 3600_000).toISOString(), // 48 hours ago
        escalationRules: [
          { condition: 'time_exceeded', threshold: 24, escalateTo: 'user', action: 'block' },
        ],
      });

      mockReaddir.mockResolvedValueOnce(['mission-001.json']);
      mockSafeReadJson.mockResolvedValueOnce(mission);
      mockGetAllItems.mockResolvedValue([]);

      const summary = await service.evaluate();

      expect(summary.escalationsTriggered).toBe(1);
      expect(summary.results[0].escalation.requiredAction).toBe('block');
    });

    it('should call registered action handler for triggered rules', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      service.setActionHandler(handler);

      const mission = makeMission({
        escalationRules: [
          { condition: 'cost_exceeded', threshold: 5, escalateTo: 'user', action: 'notify' },
        ],
      });

      mockReaddir.mockResolvedValueOnce(['mission-001.json']);
      mockSafeReadJson.mockResolvedValueOnce(mission);
      mockGetAllItems.mockResolvedValue([
        makeWorkItem({ missionId: 'mission-001', cost: 10 }),
      ]);

      await service.evaluate();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'mission-001' }),
        expect.objectContaining({ condition: 'cost_exceeded', action: 'notify' }),
        'notify',
      );
    });

    it('should pause mission WorkItems when action is pause', async () => {
      const mission = makeMission({
        escalationRules: [
          { condition: 'failure_count', threshold: 0, escalateTo: 'orchestrator', action: 'pause' },
        ],
      });

      mockReaddir.mockResolvedValueOnce(['mission-001.json']);
      mockSafeReadJson.mockResolvedValueOnce(mission);

      mockGetAllItems.mockResolvedValue([
        makeWorkItem({ id: 'wi-running', missionId: 'mission-001', status: 'failed', cost: 0 }),
        makeWorkItem({ id: 'wi-queued', missionId: 'mission-001', status: 'queued', cost: 0 }),
      ]);

      await service.evaluate();

      // Should attempt to block the queued item
      expect(mockUpdateItemStatus).toHaveBeenCalledWith('wi-queued', 'blocked');
    });

    it('should skip non-active missions', async () => {
      const completedMission = makeMission({
        id: 'completed-001',
        status: 'completed',
        escalationRules: [
          { condition: 'cost_exceeded', threshold: 0, escalateTo: 'user', action: 'notify' },
        ],
      });

      mockReaddir.mockResolvedValueOnce(['completed-001.json']);
      mockSafeReadJson.mockResolvedValueOnce(completedMission);

      const summary = await service.evaluate();

      expect(summary.missionsEvaluated).toBe(0);
    });

    it('should skip missions with no escalation rules', async () => {
      const mission = makeMission({
        escalationRules: [],
      });

      mockReaddir.mockResolvedValueOnce(['mission-001.json']);
      mockSafeReadJson.mockResolvedValueOnce(mission);

      const summary = await service.evaluate();

      expect(summary.missionsEvaluated).toBe(0);
    });

    it('should handle errors gracefully during evaluation', async () => {
      mockReaddir.mockRejectedValueOnce(new Error('ENOENT'));

      const summary = await service.evaluate();

      expect(summary.missionsEvaluated).toBe(0);
      expect(summary.escalationsTriggered).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // buildEscalationContext
  // -----------------------------------------------------------------------

  describe('buildEscalationContext()', () => {
    it('should calculate cost from mission WorkItems', async () => {
      const mission = makeMission();
      mockGetAllItems.mockResolvedValue([
        makeWorkItem({ id: 'wi-1', missionId: 'mission-001', cost: 5 }),
        makeWorkItem({ id: 'wi-2', missionId: 'mission-001', cost: 3 }),
        makeWorkItem({ id: 'wi-3', missionId: 'other-mission', cost: 100 }),
      ]);

      const context = await service.buildEscalationContext(mission);

      expect(context.currentCost).toBe(8); // 5 + 3, not including other-mission
    });

    it('should calculate hours elapsed since creation', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
      const mission = makeMission({ createdAt: twoHoursAgo });
      mockGetAllItems.mockResolvedValue([]);

      const context = await service.buildEscalationContext(mission);

      expect(context.hoursElapsed).toBeGreaterThanOrEqual(1.9);
      expect(context.hoursElapsed).toBeLessThanOrEqual(2.1);
    });

    it('should count failure WorkItems', async () => {
      const mission = makeMission();
      mockGetAllItems.mockResolvedValue([
        makeWorkItem({ id: 'wi-1', missionId: 'mission-001', status: 'failed' }),
        makeWorkItem({ id: 'wi-2', missionId: 'mission-001', status: 'done' }),
        makeWorkItem({ id: 'wi-3', missionId: 'mission-001', status: 'failed' }),
      ]);

      const context = await service.buildEscalationContext(mission);

      expect(context.failureCount).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // loadActiveMissions
  // -----------------------------------------------------------------------

  describe('loadActiveMissions()', () => {
    it('should load only active missions with escalation rules', async () => {
      const activeMission = makeMission({
        id: 'active-001',
        status: 'active',
        escalationRules: [
          { condition: 'cost_exceeded', threshold: 50, escalateTo: 'user', action: 'notify' },
        ],
      });
      const completedMission = makeMission({
        id: 'completed-001',
        status: 'completed',
      });

      mockReaddir.mockResolvedValueOnce(['active-001.json', 'completed-001.json']);
      mockSafeReadJson
        .mockResolvedValueOnce(activeMission)
        .mockResolvedValueOnce(completedMission);

      const missions = await service.loadActiveMissions();

      expect(missions).toHaveLength(1);
      expect(missions[0].id).toBe('active-001');
    });

    it('should return empty array when missions dir is empty', async () => {
      mockReaddir.mockResolvedValueOnce([]);

      const missions = await service.loadActiveMissions();

      expect(missions).toEqual([]);
    });

    it('should skip non-JSON files', async () => {
      mockReaddir.mockResolvedValueOnce(['readme.md', 'notes.txt']);

      const missions = await service.loadActiveMissions();

      expect(missions).toEqual([]);
      expect(mockSafeReadJson).not.toHaveBeenCalled();
    });

    it('should handle malformed JSON files gracefully', async () => {
      mockReaddir.mockResolvedValueOnce(['broken.json']);
      mockSafeReadJson.mockResolvedValueOnce(null);

      const missions = await service.loadActiveMissions();

      expect(missions).toEqual([]);
    });
  });
});
