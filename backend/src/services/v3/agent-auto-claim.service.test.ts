/**
 * Tests for AgentAutoClaimService — automatic work assignment for idle agents.
 *
 * @module services/v3/agent-auto-claim.service.test
 */

// AgentAutoClaimService tests — auto-claim, startup recovery, agent wake via team API
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
