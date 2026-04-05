/**
 * Tests for V2 Reconcile Type Definitions
 *
 * @module types/v2/reconcile.types.test
 */

import { describe, it, expect } from 'vitest';
import {
  RECONCILE_TYPES,
  DEFAULT_RECONCILER_CONFIG,
  isValidReconcileType,
  isReconcileResult,
  isValidReconcilerConfig,
  createEmptyReconcileResult,
  createCorrection,
} from './reconcile.types.js';
import type { ReconcileResult, ReconcilerConfig } from './reconcile.types.js';

describe('Reconcile Types', () => {
  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  describe('RECONCILE_TYPES', () => {
    it('should contain all 4 types', () => {
      expect(RECONCILE_TYPES).toHaveLength(4);
      expect(RECONCILE_TYPES).toContain('full');
      expect(RECONCILE_TYPES).toContain('targeted_request');
      expect(RECONCILE_TYPES).toContain('targeted_mission');
      expect(RECONCILE_TYPES).toContain('fast');
    });
  });

  describe('DEFAULT_RECONCILER_CONFIG', () => {
    it('should have fastLoopIntervalMs of 10s', () => {
      expect(DEFAULT_RECONCILER_CONFIG.fastLoopIntervalMs).toBe(10_000);
    });
    it('should have fullLoopIntervalMs of 60s', () => {
      expect(DEFAULT_RECONCILER_CONFIG.fullLoopIntervalMs).toBe(60_000);
    });
    it('should have maxReconcileDurationMs of 3s (CEO performance budget)', () => {
      expect(DEFAULT_RECONCILER_CONFIG.maxReconcileDurationMs).toBe(3_000);
    });
    it('should have workItemTimeoutMs of 10 minutes', () => {
      expect(DEFAULT_RECONCILER_CONFIG.workItemTimeoutMs).toBe(600_000);
    });
    it('should have eventTriggeredEnabled true', () => {
      expect(DEFAULT_RECONCILER_CONFIG.eventTriggeredEnabled).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Type Guards
  // -----------------------------------------------------------------------
  describe('isValidReconcileType', () => {
    it('should return true for all valid types', () => {
      for (const t of RECONCILE_TYPES) {
        expect(isValidReconcileType(t)).toBe(true);
      }
    });
    it('should return false for invalid types', () => {
      expect(isValidReconcileType('partial')).toBe(false);
    });
  });

  describe('isReconcileResult', () => {
    it('should return true for valid result', () => {
      const result = createEmptyReconcileResult('full');
      expect(isReconcileResult(result)).toBe(true);
    });
    it('should return false for null', () => {
      expect(isReconcileResult(null)).toBe(false);
    });
    it('should return false for non-object', () => {
      expect(isReconcileResult('string')).toBe(false);
    });
    it('should return false for missing fields', () => {
      expect(isReconcileResult({ requestsUpdated: 1 })).toBe(false);
    });
    it('should return false for invalid type field', () => {
      const result = createEmptyReconcileResult('full');
      expect(isReconcileResult({ ...result, type: 'bogus' })).toBe(false);
    });
  });

  describe('isValidReconcilerConfig', () => {
    it('should return true for default config', () => {
      expect(isValidReconcilerConfig(DEFAULT_RECONCILER_CONFIG)).toBe(true);
    });
    it('should return false for null', () => {
      expect(isValidReconcilerConfig(null)).toBe(false);
    });
    it('should return false for zero interval', () => {
      expect(isValidReconcilerConfig({
        ...DEFAULT_RECONCILER_CONFIG,
        fastLoopIntervalMs: 0,
      })).toBe(false);
    });
    it('should return false for negative values', () => {
      expect(isValidReconcilerConfig({
        ...DEFAULT_RECONCILER_CONFIG,
        workItemTimeoutMs: -1,
      })).toBe(false);
    });
    it('should return false for non-boolean eventTriggeredEnabled', () => {
      expect(isValidReconcilerConfig({
        ...DEFAULT_RECONCILER_CONFIG,
        eventTriggeredEnabled: 'yes' as unknown as boolean,
      })).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------
  describe('createEmptyReconcileResult', () => {
    it('should create result with all counters at 0', () => {
      const result = createEmptyReconcileResult('full');
      expect(result.requestsUpdated).toBe(0);
      expect(result.workItemsTimedOut).toBe(0);
      expect(result.workItemsRequeued).toBe(0);
      expect(result.triggersRebuilt).toBe(0);
      expect(result.staleItemsCleaned).toBe(0);
    });
    it('should set the correct type', () => {
      expect(createEmptyReconcileResult('fast').type).toBe('fast');
      expect(createEmptyReconcileResult('targeted_request').type).toBe('targeted_request');
    });
    it('should set durationMs to 0', () => {
      const result = createEmptyReconcileResult('full');
      expect(result.durationMs).toBe(0);
    });
    it('should initialize empty corrections and errors arrays', () => {
      const result = createEmptyReconcileResult('full');
      expect(result.corrections).toEqual([]);
      expect(result.errors).toEqual([]);
    });
    it('should set ISO8601 reconciledAt', () => {
      const result = createEmptyReconcileResult('full');
      expect(() => new Date(result.reconciledAt)).not.toThrow();
    });
  });

  describe('createCorrection', () => {
    it('should create a correction with all fields', () => {
      const correction = createCorrection({
        entityType: 'work_item',
        entityId: 'wi-001',
        previousState: 'running',
        newState: 'failed',
        reason: 'Agent offline for > 10 minutes',
        evidence: 'Last heartbeat 15 minutes ago',
      });
      expect(correction.entityType).toBe('work_item');
      expect(correction.entityId).toBe('wi-001');
      expect(correction.previousState).toBe('running');
      expect(correction.newState).toBe('failed');
      expect(correction.reason).toBe('Agent offline for > 10 minutes');
      expect(correction.evidence).toBe('Last heartbeat 15 minutes ago');
    });
    it('should set correctedAt timestamp', () => {
      const correction = createCorrection({
        entityType: 'request',
        entityId: 'req-001',
        previousState: 'running',
        newState: 'done',
        reason: 'All WorkItems completed',
        evidence: '3/3 WorkItems in done status',
      });
      expect(() => new Date(correction.correctedAt)).not.toThrow();
    });
  });
});
