/**
 * Tests for Auth Types
 *
 * @module types/auth.types.test
 */

import { describe, it, expect } from 'vitest';
import { isValidUserPlan, isUserProfile } from './auth.types';

describe('Auth Types', () => {
  describe('isValidUserPlan', () => {
    it('should accept "free"', () => {
      expect(isValidUserPlan('free')).toBe(true);
    });

    it('should accept "pro"', () => {
      expect(isValidUserPlan('pro')).toBe(true);
    });

    it('should accept "starter"', () => {
      expect(isValidUserPlan('starter')).toBe(true);
    });

    it('should accept "max"', () => {
      expect(isValidUserPlan('max')).toBe(true);
    });

    it('should reject invalid strings', () => {
      expect(isValidUserPlan('premium')).toBe(false);
      expect(isValidUserPlan('enterprise')).toBe(false);
      expect(isValidUserPlan('')).toBe(false);
    });

    it('should reject non-string values', () => {
      expect(isValidUserPlan(null)).toBe(false);
      expect(isValidUserPlan(undefined)).toBe(false);
      expect(isValidUserPlan(0)).toBe(false);
      expect(isValidUserPlan({})).toBe(false);
    });
  });

  describe('isUserProfile', () => {
    const validProfile = {
      id: 'user-123',
      email: 'test@example.com',
      displayName: 'Test User',
      plan: 'free',
      createdAt: '2026-01-01T00:00:00Z',
    };

    it('should accept a valid profile', () => {
      expect(isUserProfile(validProfile)).toBe(true);
    });

    it('should accept profile with pro plan', () => {
      expect(isUserProfile({ ...validProfile, plan: 'pro' })).toBe(true);
    });

    it('should reject null', () => {
      expect(isUserProfile(null)).toBe(false);
    });

    it('should reject non-object values', () => {
      expect(isUserProfile('string')).toBe(false);
      expect(isUserProfile(42)).toBe(false);
    });

    it('should reject objects with missing fields', () => {
      const { email, ...noEmail } = validProfile;
      expect(isUserProfile(noEmail)).toBe(false);

      const { displayName, ...noName } = validProfile;
      expect(isUserProfile(noName)).toBe(false);
    });

    it('should accept profile with max plan', () => {
      expect(isUserProfile({ ...validProfile, plan: 'max' })).toBe(true);
    });

    it('should accept profile with starter plan', () => {
      expect(isUserProfile({ ...validProfile, plan: 'starter' })).toBe(true);
    });

    it('should reject objects with invalid plan', () => {
      expect(isUserProfile({ ...validProfile, plan: 'premium' })).toBe(false);
    });
  });
});
