/**
 * Tests for Payment Types
 *
 * @module controllers/payment/payment.types.test
 */

import {
  PLAN_IDS,
  BILLING_INTERVALS,
  isValidPlanId,
  isValidBillingInterval,
} from './payment.types.js';

describe('payment.types', () => {
  describe('PLAN_IDS', () => {
    it('should contain exactly starter, pro, max', () => {
      expect(PLAN_IDS).toEqual(['starter', 'pro', 'max']);
    });
  });

  describe('BILLING_INTERVALS', () => {
    it('should contain exactly month and year', () => {
      expect(BILLING_INTERVALS).toEqual(['month', 'year']);
    });
  });

  describe('isValidPlanId', () => {
    it.each(['starter', 'pro', 'max'])('should return true for "%s"', (id) => {
      expect(isValidPlanId(id)).toBe(true);
    });

    it.each(['', 'basic', 'premium', 'free', 'enterprise', 'Free', 'PRO'])('should return false for "%s"', (id) => {
      expect(isValidPlanId(id)).toBe(false);
    });
  });

  describe('isValidBillingInterval', () => {
    it.each(['month', 'year'])('should return true for "%s"', (interval) => {
      expect(isValidBillingInterval(interval)).toBe(true);
    });

    it.each(['', 'weekly', 'daily', 'Month', 'YEAR'])('should return false for "%s"', (interval) => {
      expect(isValidBillingInterval(interval)).toBe(false);
    });
  });
});
