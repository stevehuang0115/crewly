import { describe, it, expect } from 'vitest';
import {
  LIMIT_COPY,
  PLAN_FEATURES,
  PRO_PRICING,
  getYearlySavingsPercent,
  PAYWALL_STORAGE_PREFIX,
  ESCALATION_THRESHOLD,
  type LimitType,
  type TrialLimitEvent,
  type PlanFeature,
  type EscalationLevel,
  type BillingInterval,
} from './payment-wall.types.js';

describe('payment-wall.types', () => {
  describe('LIMIT_COPY', () => {
    const allLimitTypes: LimitType[] = [
      'limit:teams',
      'limit:agents_per_team',
      'limit:projects',
      'limit:relay_sessions',
      'limit:marketplace',
      'limit:schedules',
    ];

    it('has copy for every limit type', () => {
      for (const lt of allLimitTypes) {
        expect(LIMIT_COPY[lt]).toBeDefined();
        expect(LIMIT_COPY[lt].label).toBeTruthy();
        expect(LIMIT_COPY[lt].bannerCopy).toBeTruthy();
      }
    });

    it('banner copy contains {max} placeholder', () => {
      for (const lt of allLimitTypes) {
        expect(LIMIT_COPY[lt].bannerCopy).toContain('{max}');
      }
    });
  });

  describe('PLAN_FEATURES', () => {
    it('has features for all limit types', () => {
      const coveredTypes = PLAN_FEATURES
        .filter((f): f is PlanFeature & { limitType: LimitType } => !!f.limitType)
        .map(f => f.limitType);
      expect(coveredTypes).toContain('limit:teams');
      expect(coveredTypes).toContain('limit:agents_per_team');
      expect(coveredTypes).toContain('limit:projects');
      expect(coveredTypes).toContain('limit:relay_sessions');
      expect(coveredTypes).toContain('limit:marketplace');
      expect(coveredTypes).toContain('limit:schedules');
    });

    it('every feature has label, freeValue, and proValue', () => {
      for (const f of PLAN_FEATURES) {
        expect(f.label).toBeTruthy();
        expect(f.freeValue).toBeTruthy();
        expect(f.proValue).toBeTruthy();
      }
    });
  });

  describe('PRO_PRICING', () => {
    it('yearly price is less than monthly', () => {
      expect(PRO_PRICING.yearly).toBeLessThan(PRO_PRICING.monthly);
    });

    it('prices are positive numbers', () => {
      expect(PRO_PRICING.monthly).toBeGreaterThan(0);
      expect(PRO_PRICING.yearly).toBeGreaterThan(0);
    });
  });

  describe('getYearlySavingsPercent', () => {
    it('returns a positive savings percentage', () => {
      const pct = getYearlySavingsPercent();
      expect(pct).toBeGreaterThan(0);
      expect(pct).toBeLessThan(100);
    });

    it('returns 20% for Pro plan ($99 monthly / $79 yearly)', () => {
      expect(getYearlySavingsPercent()).toBe(20);
    });

    it('returns correct savings for starter plan', () => {
      expect(getYearlySavingsPercent('starter')).toBe(20);
    });

    it('returns correct savings for max plan', () => {
      expect(getYearlySavingsPercent('max')).toBe(20);
    });
  });

  describe('constants', () => {
    it('PAYWALL_STORAGE_PREFIX starts with crewly_', () => {
      expect(PAYWALL_STORAGE_PREFIX).toBe('crewly_paywall_');
    });

    it('ESCALATION_THRESHOLD is 3', () => {
      expect(ESCALATION_THRESHOLD).toBe(3);
    });
  });

  describe('type guards (compile-time checks)', () => {
    it('TrialLimitEvent has required shape', () => {
      const event: TrialLimitEvent = {
        limitType: 'limit:teams',
        current: 2,
        max: 2,
        plan: 'free',
      };
      expect(event.limitType).toBe('limit:teams');
      expect(event.current).toBe(2);
      expect(event.max).toBe(2);
      expect(event.plan).toBe('free');
    });

    it('EscalationLevel accepts banner and modal', () => {
      const levels: EscalationLevel[] = ['banner', 'modal'];
      expect(levels).toHaveLength(2);
    });

    it('BillingInterval accepts monthly and yearly', () => {
      const intervals: BillingInterval[] = ['monthly', 'yearly'];
      expect(intervals).toHaveLength(2);
    });
  });
});
