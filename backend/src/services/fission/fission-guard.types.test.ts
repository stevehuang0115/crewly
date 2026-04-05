/**
 * Fission Guard Types Tests
 *
 * Validates type guards, factory functions, and default config.
 *
 * @module services/fission/fission-guard.types.test
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FISSION_CONFIG,
  FISSION_VIOLATION_TYPES,
  isValidViolationType,
  isGuardResult,
  isFissionViolation,
  isValidFissionGuardConfig,
  createAllowedResult,
  createBlockedResult,
} from './fission-guard.types.js';

describe('FissionGuardTypes', () => {
  // -----------------------------------------------------------------------
  // DEFAULT_FISSION_CONFIG
  // -----------------------------------------------------------------------
  describe('DEFAULT_FISSION_CONFIG', () => {
    it('has correct default values matching CEO requirements', () => {
      expect(DEFAULT_FISSION_CONFIG.maxDepth).toBe(3);
      expect(DEFAULT_FISSION_CONFIG.maxTasksPerMission).toBe(50);
      expect(DEFAULT_FISSION_CONFIG.hardMaxTasksPerMission).toBe(200);
      expect(DEFAULT_FISSION_CONFIG.rateLimitWindowMs).toBe(600_000);
      expect(DEFAULT_FISSION_CONFIG.rateLimitMaxCreations).toBe(5);
      expect(DEFAULT_FISSION_CONFIG.maxBranchingFactor).toBe(5);
      expect(DEFAULT_FISSION_CONFIG.defaultTtlMs).toBe(86_400_000);
      expect(DEFAULT_FISSION_CONFIG.maxTtlMs).toBe(604_800_000);
      expect(DEFAULT_FISSION_CONFIG.budgetThresholdUsd).toBe(10.0);
      expect(DEFAULT_FISSION_CONFIG.budgetGateEnabled).toBe(true);
      expect(DEFAULT_FISSION_CONFIG.maxViolationHistory).toBe(500);
    });

    it('passes its own validation', () => {
      expect(isValidFissionGuardConfig(DEFAULT_FISSION_CONFIG)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // FISSION_VIOLATION_TYPES
  // -----------------------------------------------------------------------
  describe('FISSION_VIOLATION_TYPES', () => {
    it('contains all 6 violation types', () => {
      expect(FISSION_VIOLATION_TYPES).toHaveLength(6);
      expect(FISSION_VIOLATION_TYPES).toContain('max_depth');
      expect(FISSION_VIOLATION_TYPES).toContain('max_tasks');
      expect(FISSION_VIOLATION_TYPES).toContain('rate_limit');
      expect(FISSION_VIOLATION_TYPES).toContain('branching_factor');
      expect(FISSION_VIOLATION_TYPES).toContain('ttl_exceeded');
      expect(FISSION_VIOLATION_TYPES).toContain('budget_exceeded');
    });
  });

  // -----------------------------------------------------------------------
  // isValidViolationType
  // -----------------------------------------------------------------------
  describe('isValidViolationType', () => {
    it('returns true for valid types', () => {
      for (const t of FISSION_VIOLATION_TYPES) {
        expect(isValidViolationType(t)).toBe(true);
      }
    });

    it('returns false for invalid types', () => {
      expect(isValidViolationType('invalid')).toBe(false);
      expect(isValidViolationType('')).toBe(false);
      expect(isValidViolationType('MAX_DEPTH')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // isGuardResult
  // -----------------------------------------------------------------------
  describe('isGuardResult', () => {
    it('validates a minimal allowed result', () => {
      expect(isGuardResult({ allowed: true })).toBe(true);
    });

    it('validates a blocked result with all fields', () => {
      expect(isGuardResult({
        allowed: false,
        reason: 'depth exceeded',
        violationType: 'max_depth',
      })).toBe(true);
    });

    it('rejects non-objects', () => {
      expect(isGuardResult(null)).toBe(false);
      expect(isGuardResult('string')).toBe(false);
      expect(isGuardResult(42)).toBe(false);
    });

    it('rejects missing allowed field', () => {
      expect(isGuardResult({ reason: 'test' })).toBe(false);
    });

    it('rejects invalid violationType', () => {
      expect(isGuardResult({
        allowed: false,
        violationType: 'unknown_type',
      })).toBe(false);
    });

    it('rejects non-string reason', () => {
      expect(isGuardResult({ allowed: false, reason: 123 })).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // isFissionViolation
  // -----------------------------------------------------------------------
  describe('isFissionViolation', () => {
    const validViolation = {
      id: 'v-001',
      violationType: 'max_depth',
      agentId: 'agent-leo',
      parentWorkItemId: 'wi-123',
      reason: 'Depth 4 exceeds max 3',
      currentValue: 4,
      configuredLimit: 3,
      violatedAt: '2026-04-05T03:00:00.000Z',
    };

    it('validates a complete violation', () => {
      expect(isFissionViolation(validViolation)).toBe(true);
    });

    it('validates with optional missionId', () => {
      expect(isFissionViolation({ ...validViolation, missionId: 'm-1' })).toBe(true);
    });

    it('rejects null', () => {
      expect(isFissionViolation(null)).toBe(false);
    });

    it('rejects missing required fields', () => {
      const { id, ...noId } = validViolation;
      expect(isFissionViolation(noId)).toBe(false);
    });

    it('rejects invalid violationType', () => {
      expect(isFissionViolation({ ...validViolation, violationType: 'fake' })).toBe(false);
    });

    it('rejects non-number currentValue', () => {
      expect(isFissionViolation({ ...validViolation, currentValue: '4' })).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // isValidFissionGuardConfig
  // -----------------------------------------------------------------------
  describe('isValidFissionGuardConfig', () => {
    it('validates the default config', () => {
      expect(isValidFissionGuardConfig(DEFAULT_FISSION_CONFIG)).toBe(true);
    });

    it('rejects null', () => {
      expect(isValidFissionGuardConfig(null)).toBe(false);
    });

    it('rejects config with zero maxDepth', () => {
      expect(isValidFissionGuardConfig({ ...DEFAULT_FISSION_CONFIG, maxDepth: 0 })).toBe(false);
    });

    it('rejects config with negative rateLimitWindowMs', () => {
      expect(isValidFissionGuardConfig({ ...DEFAULT_FISSION_CONFIG, rateLimitWindowMs: -1 })).toBe(false);
    });

    it('rejects config with missing field', () => {
      const { maxDepth, ...noMaxDepth } = DEFAULT_FISSION_CONFIG;
      expect(isValidFissionGuardConfig(noMaxDepth)).toBe(false);
    });

    it('rejects config with non-boolean budgetGateEnabled', () => {
      expect(isValidFissionGuardConfig({ ...DEFAULT_FISSION_CONFIG, budgetGateEnabled: 1 })).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Factory Functions
  // -----------------------------------------------------------------------
  describe('createAllowedResult', () => {
    it('returns allowed=true with no reason', () => {
      const result = createAllowedResult();
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.violationType).toBeUndefined();
    });

    it('passes isGuardResult validation', () => {
      expect(isGuardResult(createAllowedResult())).toBe(true);
    });
  });

  describe('createBlockedResult', () => {
    it('returns allowed=false with reason and violationType', () => {
      const result = createBlockedResult('max_depth', 'Too deep');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Too deep');
      expect(result.violationType).toBe('max_depth');
    });

    it('passes isGuardResult validation', () => {
      expect(isGuardResult(createBlockedResult('rate_limit', 'Slow down'))).toBe(true);
    });
  });
});
