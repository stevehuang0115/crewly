/**
 * Tests for V2 Claim Type Definitions
 *
 * @module types/v2/claim.types.test
 */

import { describe, it, expect } from 'vitest';
import {
  CLAIM_STATUSES,
  DEFAULT_LEASE_DURATION_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_GRACE_PERIOD_MS,
  DEFAULT_MAX_EXTENSIONS,
  isValidClaimStatus,
  isTaskClaim,
  isLeaseExpired,
  isGracePeriodExceeded,
  canExtendLease,
  validateCreateClaimInput,
  createTaskClaim,
  extendClaim,
} from './claim.types.js';
import type { TaskClaim, CreateClaimInput } from './claim.types.js';

describe('Claim Types', () => {
  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  describe('Constants', () => {
    it('should have DEFAULT_LEASE_DURATION_MS of 10 minutes', () => {
      expect(DEFAULT_LEASE_DURATION_MS).toBe(600_000);
    });
    it('should have DEFAULT_HEARTBEAT_INTERVAL_MS of 2 minutes', () => {
      expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(120_000);
    });
    it('should have DEFAULT_GRACE_PERIOD_MS of 3 minutes', () => {
      expect(DEFAULT_GRACE_PERIOD_MS).toBe(180_000);
    });
    it('should have DEFAULT_MAX_EXTENSIONS of 3', () => {
      expect(DEFAULT_MAX_EXTENSIONS).toBe(3);
    });
  });

  describe('CLAIM_STATUSES', () => {
    it('should contain 4 statuses', () => {
      expect(CLAIM_STATUSES).toHaveLength(4);
      expect(CLAIM_STATUSES).toContain('active');
      expect(CLAIM_STATUSES).toContain('expiring');
      expect(CLAIM_STATUSES).toContain('released');
      expect(CLAIM_STATUSES).toContain('revoked');
    });
  });

  // -----------------------------------------------------------------------
  // Type Guards
  // -----------------------------------------------------------------------
  describe('isValidClaimStatus', () => {
    it('should return true for valid statuses', () => {
      for (const s of CLAIM_STATUSES) {
        expect(isValidClaimStatus(s)).toBe(true);
      }
    });
    it('should return false for invalid statuses', () => {
      expect(isValidClaimStatus('expired')).toBe(false);
    });
  });

  describe('isTaskClaim', () => {
    it('should return true for valid claim', () => {
      const claim = createTaskClaim({ workItemId: 'wi-001', agentId: 'agent-1' });
      expect(isTaskClaim(claim)).toBe(true);
    });
    it('should return false for null', () => {
      expect(isTaskClaim(null)).toBe(false);
    });
    it('should return false for non-object', () => {
      expect(isTaskClaim('string')).toBe(false);
    });
    it('should return false for missing fields', () => {
      expect(isTaskClaim({ id: 'x', workItemId: 'y' })).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Lease Expiry Checks
  // -----------------------------------------------------------------------
  describe('isLeaseExpired', () => {
    it('should return false for a fresh claim', () => {
      const claim = createTaskClaim({ workItemId: 'wi-001', agentId: 'agent-1' });
      expect(isLeaseExpired(claim)).toBe(false);
    });
    it('should return true when past lease expiry', () => {
      const claim = createTaskClaim({ workItemId: 'wi-001', agentId: 'agent-1' });
      const futureTime = Date.now() + DEFAULT_LEASE_DURATION_MS + 1000;
      expect(isLeaseExpired(claim, futureTime)).toBe(true);
    });
    it('should return false when exactly at lease expiry', () => {
      const claim = createTaskClaim({ workItemId: 'wi-001', agentId: 'agent-1' });
      const atExpiry = new Date(claim.leaseExpiresAt).getTime();
      expect(isLeaseExpired(claim, atExpiry)).toBe(false);
    });
  });

  describe('isGracePeriodExceeded', () => {
    it('should return false for a fresh claim', () => {
      const claim = createTaskClaim({ workItemId: 'wi-001', agentId: 'agent-1' });
      expect(isGracePeriodExceeded(claim)).toBe(false);
    });
    it('should return false within grace period after lease expiry', () => {
      const claim = createTaskClaim({ workItemId: 'wi-001', agentId: 'agent-1' });
      const afterLease = new Date(claim.leaseExpiresAt).getTime() + 60_000; // 1 min into grace
      expect(isGracePeriodExceeded(claim, DEFAULT_GRACE_PERIOD_MS, afterLease)).toBe(false);
    });
    it('should return true after grace period exceeded', () => {
      const claim = createTaskClaim({ workItemId: 'wi-001', agentId: 'agent-1' });
      const pastGrace = new Date(claim.leaseExpiresAt).getTime() + DEFAULT_GRACE_PERIOD_MS + 1000;
      expect(isGracePeriodExceeded(claim, DEFAULT_GRACE_PERIOD_MS, pastGrace)).toBe(true);
    });
  });

  describe('canExtendLease', () => {
    it('should return true for active claim with extensions remaining', () => {
      const claim = createTaskClaim({ workItemId: 'wi-001', agentId: 'agent-1' });
      expect(canExtendLease(claim)).toBe(true);
    });
    it('should return false when max extensions reached', () => {
      const claim = createTaskClaim({ workItemId: 'wi-001', agentId: 'agent-1' });
      const exhausted = { ...claim, extensionCount: DEFAULT_MAX_EXTENSIONS };
      expect(canExtendLease(exhausted)).toBe(false);
    });
    it('should return false for non-active claim', () => {
      const claim = createTaskClaim({ workItemId: 'wi-001', agentId: 'agent-1' });
      const released: TaskClaim = { ...claim, status: 'released' };
      expect(canExtendLease(released)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------
  describe('validateCreateClaimInput', () => {
    const validInput: CreateClaimInput = {
      workItemId: 'wi-001',
      agentId: 'crewly-product-leo-member-n',
    };

    it('should return empty array for valid input', () => {
      expect(validateCreateClaimInput(validInput)).toEqual([]);
    });
    it('should error on missing workItemId', () => {
      const errors = validateCreateClaimInput({ ...validInput, workItemId: '' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on missing agentId', () => {
      const errors = validateCreateClaimInput({ ...validInput, agentId: '' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on leaseDurationMs too short', () => {
      const errors = validateCreateClaimInput({ ...validInput, leaseDurationMs: 30_000 });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on leaseDurationMs too long', () => {
      const errors = validateCreateClaimInput({ ...validInput, leaseDurationMs: 5_000_000 });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on negative maxExtensions', () => {
      const errors = validateCreateClaimInput({ ...validInput, maxExtensions: -1 });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should accept valid optional leaseDurationMs', () => {
      const errors = validateCreateClaimInput({ ...validInput, leaseDurationMs: 300_000 });
      expect(errors).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------
  describe('createTaskClaim', () => {
    const input: CreateClaimInput = {
      workItemId: 'wi-001',
      agentId: 'crewly-product-leo-member-n',
    };

    it('should create a claim with status active', () => {
      const claim = createTaskClaim(input);
      expect(claim.status).toBe('active');
    });
    it('should generate a UUID id', () => {
      const claim = createTaskClaim(input);
      expect(claim.id).toMatch(/^[0-9a-f]{8}-/);
    });
    it('should set default lease duration', () => {
      const claim = createTaskClaim(input);
      expect(claim.leaseDurationMs).toBe(DEFAULT_LEASE_DURATION_MS);
    });
    it('should set leaseExpiresAt ~10 minutes from now', () => {
      const before = Date.now();
      const claim = createTaskClaim(input);
      const expiresAt = new Date(claim.leaseExpiresAt).getTime();
      const after = Date.now();
      expect(expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_LEASE_DURATION_MS);
      expect(expiresAt).toBeLessThanOrEqual(after + DEFAULT_LEASE_DURATION_MS);
    });
    it('should initialize extensionCount to 0', () => {
      const claim = createTaskClaim(input);
      expect(claim.extensionCount).toBe(0);
    });
    it('should set default maxExtensions', () => {
      const claim = createTaskClaim(input);
      expect(claim.maxExtensions).toBe(DEFAULT_MAX_EXTENSIONS);
    });
    it('should respect custom leaseDurationMs', () => {
      const claim = createTaskClaim({ ...input, leaseDurationMs: 300_000 });
      expect(claim.leaseDurationMs).toBe(300_000);
    });
    it('should respect custom maxExtensions', () => {
      const claim = createTaskClaim({ ...input, maxExtensions: 5 });
      expect(claim.maxExtensions).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // extendClaim
  // -----------------------------------------------------------------------
  describe('extendClaim', () => {
    it('should extend the lease and increment extensionCount', () => {
      const original = createTaskClaim({ workItemId: 'wi-001', agentId: 'agent-1' });
      const extended = extendClaim(original);
      expect(extended).not.toBeNull();
      expect(extended!.extensionCount).toBe(1);
      expect(new Date(extended!.leaseExpiresAt).getTime())
        .toBeGreaterThanOrEqual(new Date(original.leaseExpiresAt).getTime());
    });
    it('should return null when max extensions reached', () => {
      const claim = createTaskClaim({ workItemId: 'wi-001', agentId: 'agent-1' });
      const exhausted: TaskClaim = { ...claim, extensionCount: DEFAULT_MAX_EXTENSIONS };
      expect(extendClaim(exhausted)).toBeNull();
    });
    it('should return null for non-active claims', () => {
      const claim = createTaskClaim({ workItemId: 'wi-001', agentId: 'agent-1' });
      const revoked: TaskClaim = { ...claim, status: 'revoked' };
      expect(extendClaim(revoked)).toBeNull();
    });
    it('should not mutate the original claim (immutable)', () => {
      const original = createTaskClaim({ workItemId: 'wi-001', agentId: 'agent-1' });
      const originalExpiry = original.leaseExpiresAt;
      extendClaim(original);
      expect(original.leaseExpiresAt).toBe(originalExpiry);
      expect(original.extensionCount).toBe(0);
    });
    it('should allow chaining extensions up to max', () => {
      let claim: TaskClaim | null = createTaskClaim({
        workItemId: 'wi-001',
        agentId: 'agent-1',
        maxExtensions: 2,
      });
      claim = extendClaim(claim!);
      expect(claim).not.toBeNull();
      expect(claim!.extensionCount).toBe(1);

      claim = extendClaim(claim!);
      expect(claim).not.toBeNull();
      expect(claim!.extensionCount).toBe(2);

      claim = extendClaim(claim!);
      expect(claim).toBeNull();
    });
  });
});
