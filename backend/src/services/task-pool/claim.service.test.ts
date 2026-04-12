/**
 * ClaimService Tests
 *
 * Tests claim creation, heartbeat, lease extension, release, revocation,
 * and expiry detection.
 *
 * @module services/task-pool/claim.service.test
 */

import { ClaimService } from './claim.service.js';
import { PoolStorage } from './pool-storage.js';
import {
  DEFAULT_LEASE_DURATION_MS,
  DEFAULT_GRACE_PERIOD_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_EXTENSIONS,
} from '../../types/v2/claim.types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock LoggerService
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'claim-service-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaimService', () => {
  let service: ClaimService;
  let storage: PoolStorage;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    storage = new PoolStorage({ dataDir: tempDir });
    service = new ClaimService(storage);
  });

  afterEach(async () => {
    await storage.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // createClaim
  // -----------------------------------------------------------------------

  describe('createClaim', () => {
    it('should create a claim with default parameters', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      expect(claim.id).toBeDefined();
      expect(claim.workItemId).toBe('wi-1');
      expect(claim.agentId).toBe('agent-leo');
      expect(claim.status).toBe('active');
      expect(claim.extensionCount).toBe(0);
      expect(claim.maxExtensions).toBe(DEFAULT_MAX_EXTENSIONS);
      expect(claim.leaseDurationMs).toBe(DEFAULT_LEASE_DURATION_MS);
    });

    it('should create a claim with custom lease duration', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-2',
        agentId: 'agent-max',
        leaseDurationMs: 300_000, // 5 min
        maxExtensions: 5,
      });

      expect(claim.leaseDurationMs).toBe(300_000);
      expect(claim.maxExtensions).toBe(5);
    });

    it('should reject duplicate claim on same work item', async () => {
      await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      await expect(
        service.createClaim({ workItemId: 'wi-1', agentId: 'agent-max' }),
      ).rejects.toThrow(/already has an active claim/);
    });

    it('should reject if agent already has an active claim', async () => {
      await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      await expect(
        service.createClaim({ workItemId: 'wi-2', agentId: 'agent-leo' }),
      ).rejects.toThrow(/already has an active claim/);
    });

    it('should reject invalid input', async () => {
      await expect(
        service.createClaim({ workItemId: '', agentId: 'agent-leo' }),
      ).rejects.toThrow(/Invalid claim input/);
    });

    it('should reject lease duration below minimum', async () => {
      await expect(
        service.createClaim({
          workItemId: 'wi-1',
          agentId: 'agent-leo',
          leaseDurationMs: 10_000, // 10s, below 1min minimum
        }),
      ).rejects.toThrow(/Invalid claim input/);
    });
  });

  // -----------------------------------------------------------------------
  // heartbeat
  // -----------------------------------------------------------------------

  describe('heartbeat', () => {
    it('should accept heartbeat from claim owner', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      const result = await service.heartbeat(claim.id, 'agent-leo');
      expect(result.success).toBe(true);
      expect(result.claim).toBeDefined();
    });

    it('should reject heartbeat from wrong agent', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      const result = await service.heartbeat(claim.id, 'agent-max');
      expect(result.success).toBe(false);
      expect(result.reason).toContain('does not own');
    });

    it('should reject heartbeat for non-existent claim', async () => {
      const result = await service.heartbeat('nonexistent', 'agent-leo');
      expect(result.success).toBe(false);
      expect(result.reason).toContain('not found');
    });

    it('should reject heartbeat for released claim', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      await service.release(claim.id, 'done');

      const result = await service.heartbeat(claim.id, 'agent-leo');
      expect(result.success).toBe(false);
      expect(result.reason).toContain('released');
    });

    it('should restore expiring claim to active on heartbeat', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      // Manually mark as expiring
      await storage.updateClaim(claim.id, (c) => {
        c.status = 'expiring';
      });

      const result = await service.heartbeat(claim.id, 'agent-leo');
      expect(result.success).toBe(true);
      expect(result.claim?.status).toBe('active');
    });
  });

  // -----------------------------------------------------------------------
  // extendLease
  // -----------------------------------------------------------------------

  describe('extendLease', () => {
    it('should extend lease successfully', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      const result = await service.extendLease(claim.id, 'agent-leo');
      expect(result.success).toBe(true);
      expect(result.claim?.extensionCount).toBe(1);
      // New expiry should be later than original
      expect(
        new Date(result.claim!.leaseExpiresAt).getTime(),
      ).toBeGreaterThanOrEqual(
        new Date(claim.leaseExpiresAt).getTime(),
      );
    });

    it('should reject extension from wrong agent', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      const result = await service.extendLease(claim.id, 'agent-max');
      expect(result.success).toBe(false);
      expect(result.reason).toContain('does not own');
    });

    it('should reject extension when max extensions reached', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
        maxExtensions: 1,
      });

      // First extension: OK
      const r1 = await service.extendLease(claim.id, 'agent-leo');
      expect(r1.success).toBe(true);

      // Second extension: rejected
      const r2 = await service.extendLease(claim.id, 'agent-leo');
      expect(r2.success).toBe(false);
      expect(r2.reason).toContain('Max extensions reached');
    });

    it('should allow up to DEFAULT_MAX_EXTENSIONS', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      for (let i = 0; i < DEFAULT_MAX_EXTENSIONS; i++) {
        const result = await service.extendLease(claim.id, 'agent-leo');
        expect(result.success).toBe(true);
        expect(result.claim?.extensionCount).toBe(i + 1);
      }

      // One more should fail
      const result = await service.extendLease(claim.id, 'agent-leo');
      expect(result.success).toBe(false);
    });

    it('should reject extension on non-active claim', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      await service.release(claim.id, 'done');

      const result = await service.extendLease(claim.id, 'agent-leo');
      expect(result.success).toBe(false);
      expect(result.reason).toContain('released');
    });
  });

  // -----------------------------------------------------------------------
  // release
  // -----------------------------------------------------------------------

  describe('release', () => {
    it('should release an active claim', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      await service.release(claim.id, 'completed');

      const updated = await service.getClaimById(claim.id);
      expect(updated?.status).toBe('released');
      expect(updated?.endedAt).toBeDefined();
      expect(updated?.endReason).toBe('completed');
    });

    it('should be idempotent for already-released claims', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      await service.release(claim.id, 'completed');
      // Second release should not throw
      await service.release(claim.id, 'completed again');

      const updated = await service.getClaimById(claim.id);
      expect(updated?.status).toBe('released');
    });

    it('should throw for non-existent claim', async () => {
      await expect(service.release('nonexistent', 'done')).rejects.toThrow(/not found/);
    });
  });

  // -----------------------------------------------------------------------
  // revoke
  // -----------------------------------------------------------------------

  describe('revoke', () => {
    it('should revoke an active claim', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      await service.revoke(claim.id, 'grace period exceeded');

      const updated = await service.getClaimById(claim.id);
      expect(updated?.status).toBe('revoked');
      expect(updated?.endedAt).toBeDefined();
      expect(updated?.endReason).toBe('grace period exceeded');
    });

    it('should be idempotent for already-revoked claims', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      await service.revoke(claim.id, 'expired');
      await service.revoke(claim.id, 'expired again'); // should not throw

      const updated = await service.getClaimById(claim.id);
      expect(updated?.status).toBe('revoked');
    });

    it('should throw for non-existent claim', async () => {
      await expect(service.revoke('nonexistent', 'expired')).rejects.toThrow(/not found/);
    });
  });

  // -----------------------------------------------------------------------
  // scanExpiredClaims
  // -----------------------------------------------------------------------

  describe('scanExpiredClaims', () => {
    it('should return empty when no claims exist', async () => {
      const result = await service.scanExpiredClaims();
      expect(result.expiring).toHaveLength(0);
      expect(result.graceExceeded).toHaveLength(0);
    });

    it('should detect lease-expired claims in grace period', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
        leaseDurationMs: 60_000, // 1 min
      });

      // Simulate time after lease expiry but within grace period
      const leaseExpiry = new Date(claim.leaseExpiresAt).getTime();
      const afterLease = leaseExpiry + 1000; // 1s after lease expiry

      const result = await service.scanExpiredClaims(afterLease);
      expect(result.expiring).toHaveLength(1);
      expect(result.expiring[0].id).toBe(claim.id);
      expect(result.graceExceeded).toHaveLength(0);
    });

    it('should detect grace-exceeded claims', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
        leaseDurationMs: 60_000, // 1 min
      });

      // Simulate time after grace period
      const leaseExpiry = new Date(claim.leaseExpiresAt).getTime();
      const afterGrace = leaseExpiry + DEFAULT_GRACE_PERIOD_MS + 1000;

      const result = await service.scanExpiredClaims(afterGrace);
      expect(result.graceExceeded).toHaveLength(1);
      expect(result.graceExceeded[0].id).toBe(claim.id);
      expect(result.expiring).toHaveLength(0);
    });

    it('should not flag active non-expired claims', async () => {
      await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      // Use current time (claim just created, lease not expired)
      const result = await service.scanExpiredClaims();
      expect(result.expiring).toHaveLength(0);
      expect(result.graceExceeded).toHaveLength(0);
    });

    it('should not flag released or revoked claims', async () => {
      const c1 = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
        leaseDurationMs: 60_000,
      });
      await service.release(c1.id, 'done');

      // Create and release another to allow agent-leo to claim again
      // Use a different agent for the second claim
      const c2 = await service.createClaim({
        workItemId: 'wi-2',
        agentId: 'agent-max',
        leaseDurationMs: 60_000,
      });
      await service.revoke(c2.id, 'expired');

      // Even far in the future, released/revoked claims should not appear
      const farFuture = Date.now() + 10 * 60 * 60 * 1000;
      const result = await service.scanExpiredClaims(farFuture);
      expect(result.expiring).toHaveLength(0);
      expect(result.graceExceeded).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // markExpiring
  // -----------------------------------------------------------------------

  describe('markExpiring', () => {
    it('should mark active claims as expiring', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      await service.markExpiring([claim.id]);

      const updated = await service.getClaimById(claim.id);
      expect(updated?.status).toBe('expiring');
    });

    it('should not change non-active claims', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });
      await service.release(claim.id, 'done');

      await service.markExpiring([claim.id]);

      const updated = await service.getClaimById(claim.id);
      expect(updated?.status).toBe('released');
    });
  });

  // -----------------------------------------------------------------------
  // isHeartbeatStale
  // -----------------------------------------------------------------------

  describe('isHeartbeatStale', () => {
    it('should return false for fresh heartbeat', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      expect(service.isHeartbeatStale(claim)).toBe(false);
    });

    it('should return true for stale heartbeat', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      // Simulate heartbeat from 3 minutes ago (stale with 2min interval + 30s tolerance)
      const staleTime = Date.now() + DEFAULT_HEARTBEAT_INTERVAL_MS + 31_000;
      expect(service.isHeartbeatStale(claim, undefined, undefined, staleTime)).toBe(true);
    });

    it('should respect custom interval and tolerance', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      // With 5min interval + 1min tolerance, fresh claim should not be stale
      expect(service.isHeartbeatStale(claim, 300_000, 60_000)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  describe('queries', () => {
    it('getActiveClaimByAgent should return active claim', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });

      const found = await service.getActiveClaimByAgent('agent-leo');
      expect(found?.id).toBe(claim.id);
    });

    it('getActiveClaimByAgent should return undefined after release', async () => {
      const claim = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });
      await service.release(claim.id, 'done');

      const found = await service.getActiveClaimByAgent('agent-leo');
      expect(found).toBeUndefined();
    });

    it('getActiveClaims should return all active and expiring claims', async () => {
      const c1 = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });
      const c2 = await service.createClaim({
        workItemId: 'wi-2',
        agentId: 'agent-max',
      });

      // Mark c2 as expiring
      await storage.updateClaim(c2.id, (c) => { c.status = 'expiring'; });

      const active = await service.getActiveClaims();
      expect(active).toHaveLength(2);
    });

    it('getActiveClaims should exclude released claims', async () => {
      const c1 = await service.createClaim({
        workItemId: 'wi-1',
        agentId: 'agent-leo',
      });
      await service.release(c1.id, 'done');

      const active = await service.getActiveClaims();
      expect(active).toHaveLength(0);
    });
  });
});
