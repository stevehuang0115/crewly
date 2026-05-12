/**
 * Tests for AgentAutoClaimService — automatic work assignment for idle agents.
 *
 * @module services/v3/agent-auto-claim.service.test
 */

// AgentAutoClaimService tests — auto-claim, recovery, wake via team API, Slack escalation
import { AgentAutoClaimService } from './agent-auto-claim.service.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetAvailableItems = jest.fn().mockResolvedValue([]);
const mockClaimSpecificItem = jest.fn().mockResolvedValue(null);
const mockGetAllItems = jest.fn().mockResolvedValue([]);

jest.mock('../task-pool/task-pool.service.js', () => ({
  TaskPoolService: {
    getInstance: () => ({
      getAvailableItems: mockGetAvailableItems,
      claimSpecificItem: mockClaimSpecificItem,
      getAllItems: mockGetAllItems,
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

jest.mock('../reconciler/reconcile-rules.js', () => ({
  computeAgentScore: jest.fn().mockReturnValue({
    skillMatch: 25,
    urgency: 10,
    contextFamiliarity: 5,
    loadPenalty: 0,
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentAutoClaimService', () => {
  beforeEach(() => {
    AgentAutoClaimService.resetInstance();
    jest.clearAllMocks();
  });

  describe('singleton', () => {
    it('should return same instance', () => {
      const a = AgentAutoClaimService.getInstance();
      const b = AgentAutoClaimService.getInstance();
      expect(a).toBe(b);
    });

    it('should reset instance', () => {
      const a = AgentAutoClaimService.getInstance();
      AgentAutoClaimService.resetInstance();
      const b = AgentAutoClaimService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('tryAutoClaimForAgent', () => {
    it('should return null when no available items', async () => {
      const service = AgentAutoClaimService.getInstance();
      mockGetAvailableItems.mockResolvedValueOnce([]);

      const result = await service.tryAutoClaimForAgent('agent-1');
      expect(result).toBeNull();
    });

    it('should claim best-scoring item for agent', async () => {
      const service = AgentAutoClaimService.getInstance();

      const items = [
        { id: 'wi-1', title: 'Task 1', type: 'delegate', status: 'queued', createdAt: new Date().toISOString() },
        { id: 'wi-2', title: 'Task 2', type: 'delegate', status: 'queued', createdAt: new Date().toISOString() },
      ];
      mockGetAvailableItems.mockResolvedValueOnce(items);
      mockClaimSpecificItem.mockResolvedValueOnce({
        workItem: items[0],
        claim: { id: 'claim-1', agentId: 'agent-1' },
      });

      const result = await service.tryAutoClaimForAgent('agent-1');
      expect(result).not.toBeNull();
      expect(result?.workItemId).toBe('wi-1');
      expect(mockClaimSpecificItem).toHaveBeenCalledWith('agent-1', 'wi-1');
    });

    it('should handle race condition gracefully', async () => {
      const service = AgentAutoClaimService.getInstance();

      mockGetAvailableItems.mockResolvedValueOnce([
        { id: 'wi-1', title: 'Task 1', type: 'delegate', status: 'queued', createdAt: new Date().toISOString() },
      ]);
      // Claim fails — someone else got it
      mockClaimSpecificItem.mockResolvedValueOnce(null);

      const result = await service.tryAutoClaimForAgent('agent-1');
      expect(result).toBeNull();
    });

    // 2026-05-12 dogfood regression: AutoClaim happily claimed
    // `request:<rid>:respond_to_user` tracker WIs for crewly-orc, then
    // `WorkItemDispatchSubscriber.dispatchTo` short-circuited on the
    // SLA tracker pattern — WI stuck `running`, SLA breach in 5/10 min,
    // claim revoked, infinite re-claim loop. User saw "Request never
    // progresses." Filter these out at the source of `availableItems`.
    it('skips SLA tracker WIs (request:*:respond_to_user) — they are not dispatchable', async () => {
      const service = AgentAutoClaimService.getInstance();

      const trackerWI = {
        id: 'request:3e6b984f-80e8-4473-b6c9-a19a4c1240ba:respond_to_user',
        title: 'Respond to user: [Fix] ...',
        type: 'review',
        status: 'queued',
        target: 'crewly-orc',
        createdAt: new Date().toISOString(),
      };
      mockGetAvailableItems.mockResolvedValueOnce([trackerWI]);

      const result = await service.tryAutoClaimForAgent('crewly-orc');

      expect(result).toBeNull();
      expect(mockClaimSpecificItem).not.toHaveBeenCalled();
    });

    it('still claims a real delegate WI when an SLA tracker is also present', async () => {
      // Mixed pool: one tracker (skip), one real work item (claim).
      // Asserts the filter is targeted, not over-broad.
      const service = AgentAutoClaimService.getInstance();

      const tracker = {
        id: 'request:abc:respond_to_user',
        title: 'tracker',
        type: 'review',
        status: 'queued',
        target: 'crewly-orc',
        createdAt: new Date().toISOString(),
      };
      const real = {
        id: 'wi-real-1',
        title: 'Real task',
        type: 'delegate',
        status: 'queued',
        target: 'crewly-orc',
        createdAt: new Date().toISOString(),
      };
      mockGetAvailableItems.mockResolvedValueOnce([tracker, real]);
      mockClaimSpecificItem.mockResolvedValueOnce({
        workItem: real,
        claim: { id: 'claim-real', agentId: 'crewly-orc' },
      });

      const result = await service.tryAutoClaimForAgent('crewly-orc');

      expect(result?.workItemId).toBe('wi-real-1');
      expect(mockClaimSpecificItem).toHaveBeenCalledWith('crewly-orc', 'wi-real-1');
    });

    it('should skip items below score threshold', async () => {
      const service = AgentAutoClaimService.getInstance();

      const { computeAgentScore } = require('../reconciler/reconcile-rules.js');
      computeAgentScore.mockReturnValue({
        skillMatch: 5,
        urgency: 2,
        contextFamiliarity: 0,
        loadPenalty: 0,
      }); // Total = 7, below threshold of 15

      mockGetAvailableItems.mockResolvedValueOnce([
        { id: 'wi-1', title: 'Poor match', type: 'delegate', status: 'queued', createdAt: new Date().toISOString() },
      ]);

      const result = await service.tryAutoClaimForAgent('agent-1');
      expect(result).toBeNull();
      expect(mockClaimSpecificItem).not.toHaveBeenCalled();
    });
  });

  describe('start/stop', () => {
    it('should warn if started without initialization', () => {
      const service = AgentAutoClaimService.getInstance();
      // Should not throw
      service.start();
      service.stop();
    });

    it('should start and stop cleanly', () => {
      const service = AgentAutoClaimService.getInstance();
      const mockEventBus = { on: jest.fn() };
      service.initialize(mockEventBus);
      service.start();

      expect(mockEventBus.on).toHaveBeenCalledWith('event_published', expect.any(Function));

      service.stop();
    });
  });
});
