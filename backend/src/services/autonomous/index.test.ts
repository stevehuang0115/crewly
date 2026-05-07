/**
 * Tests for Autonomous Services Index
 *
 * @module services/autonomous/index.test
 */

import { BudgetService, IBudgetService } from './index.js';

describe('Autonomous Services Index', () => {
  // V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
  // AutoAssignService has been retired — its autonomy responsibilities
  // are owned by `services/v3/agent-auto-claim.service.ts` against the
  // V3 task-pool. BudgetService is the only service still exported here.

  describe('BudgetService exports', () => {
    it('should export BudgetService', () => {
      expect(BudgetService).toBeDefined();
      expect(typeof BudgetService.getInstance).toBe('function');
    });

    it('should export IBudgetService interface', () => {
      const interfaceMethods = [
        'initialize',
        'recordUsage',
        'getUsage',
        'getProjectUsage',
        'setBudget',
        'getBudget',
        'checkBudget',
        'isWithinBudget',
        'getRemainingBudget',
        'onBudgetWarning',
        'onBudgetExceeded',
        'generateReport',
      ];

      const instance = BudgetService.getInstance();
      for (const method of interfaceMethods) {
        expect(typeof (instance as any)[method]).toBe('function');
      }

      BudgetService.clearInstance();
    });
  });
});
