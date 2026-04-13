/**
 * Tests for EscalationRouterService — routing escalations to agents or humans.
 *
 * @module services/v3/escalation-router.service.test
 */

import { EscalationRouterService } from './escalation-router.service.js';
import type { AlignmentRequest } from '../../types/v2/work-item.types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFiles = new Map<string, string>();

jest.mock('../../utils/file-io.utils.js', () => ({
  ensureDir: jest.fn().mockResolvedValue(undefined),
  atomicWriteJson: jest.fn().mockImplementation(async (filePath: string, data: unknown) => {
    mockFiles.set(filePath, JSON.stringify(data));
  }),
  safeReadJson: jest.fn().mockImplementation(async (filePath: string) => {
    const content = mockFiles.get(filePath);
    if (!content) return null;
    return JSON.parse(content);
  }),
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

const mockUpdateItemStatus = jest.fn().mockResolvedValue(undefined);
jest.mock('../task-pool/task-pool.service.js', () => ({
  TaskPoolService: {
    getInstance: () => ({
      updateItemStatus: mockUpdateItemStatus,
    }),
  },
}));

jest.mock('../slack/slack-orchestrator-bridge.js', () => ({
  getSlackOrchestratorBridge: () => ({
    sendNotification: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../messaging/message-queue.service.js', () => ({
  MessageQueueService: jest.fn().mockImplementation(() => ({
    enqueue: jest.fn(),
  })),
}));

jest.mock('./mission-executor.service.js', () => ({
  MissionExecutorService: {
    getInstance: () => ({
      pauseMission: jest.fn().mockResolvedValue(0),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EscalationRouterService', () => {
  beforeEach(() => {
    EscalationRouterService.resetInstance();
    mockFiles.clear();
    jest.clearAllMocks();
  });

  describe('routeAlignmentRequest', () => {
    const makeRequest = (target: 'team_lead' | 'human'): AlignmentRequest => ({
      currentTask: 'Implement auth',
      discoveredIssue: 'Schema design needs review',
      reason: 'ambiguity_tradeoff',
      whyCannotExecute: 'Multiple valid approaches',
      options: [
        { description: 'JWT tokens', pros: ['Standard'], cons: ['Complex'], impact: 'medium' },
        { description: 'Session cookies', pros: ['Simple'], cons: ['Scaling'], impact: 'low' },
      ],
      recommendation: 'JWT tokens',
      decisionNeeded: 'Which auth approach to use',
      target,
    });

    it('should route human target to persistent escalation + pause', async () => {
      const service = EscalationRouterService.getInstance('/tmp/test');
      const id = await service.routeAlignmentRequest(
        makeRequest('human'),
        'wi-1',
        'worker-session',
      );

      expect(id).not.toBeNull();
      expect(mockUpdateItemStatus).toHaveBeenCalledWith('wi-1', 'blocked');
    });

    it('should route team_lead target to agent message (no persistence)', async () => {
      const service = EscalationRouterService.getInstance('/tmp/test');
      const id = await service.routeAlignmentRequest(
        makeRequest('team_lead'),
        'wi-1',
        'worker-session',
      );

      expect(id).toBeNull();
      expect(mockUpdateItemStatus).not.toHaveBeenCalled();
    });
  });

  describe('routePolicyEscalation', () => {
    it('should route user-targeted policy escalation to human', async () => {
      const service = EscalationRouterService.getInstance('/tmp/test');

      const mission = {
        id: 'mission-1',
        objective: 'Build auth',
        policy: { canCreateTasks: true },
      } as any;

      const rule = {
        condition: 'cost_exceeded' as const,
        threshold: 50,
        escalateTo: 'user' as const,
        action: 'pause' as const,
      };

      const id = await service.routePolicyEscalation(mission, rule, { cost_exceeded: 55 });
      expect(id).not.toBeNull();
    });

    it('should return null for orchestrator-targeted escalation', async () => {
      const service = EscalationRouterService.getInstance('/tmp/test');

      const mission = { id: 'mission-1', objective: 'Build auth' } as any;
      const rule = {
        condition: 'failure_count' as const,
        threshold: 3,
        escalateTo: 'orchestrator' as const,
        action: 'notify' as const,
      };

      const id = await service.routePolicyEscalation(mission, rule, { failure_count: 4 });
      expect(id).toBeNull();
    });
  });

  describe('resolve', () => {
    it('should resolve and resume work item', async () => {
      const service = EscalationRouterService.getInstance('/tmp/test');

      // Create an escalation first
      const id = await service.routeAlignmentRequest(
        {
          currentTask: 'Task',
          discoveredIssue: 'Issue',
          reason: 'high_risk',
          whyCannotExecute: 'Risky',
          options: [],
          recommendation: 'Stop',
          decisionNeeded: 'Continue?',
          target: 'human',
        },
        'wi-2',
        'worker',
      );

      expect(id).not.toBeNull();

      const resolved = await service.resolve(id!, 'Approved, proceed with caution', 'steve');
      expect(resolved).not.toBeNull();
      expect(resolved!.status).toBe('resolved');
      expect(resolved!.resolvedBy).toBe('steve');
      // Should have called resume (queued)
      expect(mockUpdateItemStatus).toHaveBeenCalledWith('wi-2', 'queued');
    });

    it('should return null for non-existent escalation', async () => {
      const service = EscalationRouterService.getInstance('/tmp/test');
      const result = await service.resolve('nonexistent', 'test', 'user');
      expect(result).toBeNull();
    });
  });
});
