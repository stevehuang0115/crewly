/**
 * Tests for ApprovalQueueService
 *
 * @module services/agent/crewly-agent/approval-queue.service.test
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ApprovalQueueService } from './approval-queue.service.js';
import type { ToolSensitivity } from './types.js';

describe('ApprovalQueueService', () => {
  let queue: ApprovalQueueService;

  beforeEach(() => {
    queue = new ApprovalQueueService();
  });

  describe('enqueue', () => {
    it('should create a pending approval with correct fields', () => {
      const approval = queue.enqueue('session-1', 'edit_file', 'destructive', { path: '/foo' });

      expect(approval.id).toMatch(/^approval-/);
      expect(approval.sessionName).toBe('session-1');
      expect(approval.toolName).toBe('edit_file');
      expect(approval.sensitivity).toBe('destructive');
      expect(approval.args).toEqual({ path: '/foo' });
      expect(approval.status).toBe('pending');
      expect(approval.requestedAt).toBeDefined();
      expect(approval.resolvedAt).toBeUndefined();
    });

    it('should generate unique IDs for each approval', () => {
      const a1 = queue.enqueue('s1', 'tool1', 'sensitive', {});
      const a2 = queue.enqueue('s1', 'tool2', 'sensitive', {});

      expect(a1.id).not.toBe(a2.id);
    });

    it('should auto-reject oldest when queue overflows', () => {
      // Use a small queue to test overflow
      const smallQueue = new ApprovalQueueService(60000);
      const ids: string[] = [];

      // Enqueue 101 items (max is 100)
      for (let i = 0; i < 101; i++) {
        const a = smallQueue.enqueue('s1', `tool-${i}`, 'sensitive', {});
        ids.push(a.id);
      }

      // First approval should have been auto-rejected
      const first = smallQueue.getById(ids[0]);
      expect(first?.status).toBe('rejected');
      expect(first?.resolvedBy).toBe('auto-overflow');
    });
  });

  describe('approve', () => {
    it('should approve a pending approval', () => {
      const approval = queue.enqueue('s1', 'edit_file', 'destructive', {});
      const result = queue.approve(approval.id, 'api');

      expect(result.success).toBe(true);
      expect(result.approval?.status).toBe('approved');
      expect(result.approval?.resolvedBy).toBe('api');
      expect(result.approval?.resolvedAt).toBeDefined();
    });

    it('should fail for non-existent approval', () => {
      const result = queue.approve('non-existent', 'api');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail for already resolved approval', () => {
      const approval = queue.enqueue('s1', 'edit_file', 'destructive', {});
      queue.approve(approval.id, 'api');
      const result = queue.approve(approval.id, 'api');

      expect(result.success).toBe(false);
      expect(result.error).toContain('already approved');
    });
  });

  describe('reject', () => {
    it('should reject a pending approval with reason', () => {
      const approval = queue.enqueue('s1', 'edit_file', 'destructive', {});
      const result = queue.reject(approval.id, 'auditor', 'Too risky');

      expect(result.success).toBe(true);
      expect(result.approval?.status).toBe('rejected');
      expect(result.approval?.resolvedBy).toBe('auditor');
      expect(result.approval?.reason).toBe('Too risky');
    });

    it('should fail for non-existent approval', () => {
      const result = queue.reject('non-existent', 'api');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail for already rejected approval', () => {
      const approval = queue.enqueue('s1', 'edit_file', 'destructive', {});
      queue.reject(approval.id, 'api');
      const result = queue.reject(approval.id, 'api');

      expect(result.success).toBe(false);
      expect(result.error).toContain('already rejected');
    });
  });

  describe('getPending', () => {
    it('should return all pending approvals', () => {
      queue.enqueue('s1', 'tool1', 'sensitive', {});
      queue.enqueue('s2', 'tool2', 'destructive', {});
      const a3 = queue.enqueue('s1', 'tool3', 'sensitive', {});
      queue.approve(a3.id, 'api');

      const pending = queue.getPending();
      expect(pending).toHaveLength(2);
    });

    it('should filter by sessionName', () => {
      queue.enqueue('s1', 'tool1', 'sensitive', {});
      queue.enqueue('s2', 'tool2', 'destructive', {});

      const pending = queue.getPending('s1');
      expect(pending).toHaveLength(1);
      expect(pending[0].sessionName).toBe('s1');
    });

    it('should return empty array when no pending approvals', () => {
      expect(queue.getPending()).toHaveLength(0);
    });

    it('should return copies, not references', () => {
      queue.enqueue('s1', 'tool1', 'sensitive', {});
      const pending = queue.getPending();
      pending[0].status = 'approved' as any;

      // Original should be unchanged
      const pendingAgain = queue.getPending();
      expect(pendingAgain[0].status).toBe('pending');
    });
  });

  describe('getById', () => {
    it('should return approval by ID', () => {
      const approval = queue.enqueue('s1', 'tool1', 'sensitive', {});
      const found = queue.getById(approval.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(approval.id);
    });

    it('should return undefined for non-existent ID', () => {
      expect(queue.getById('non-existent')).toBeUndefined();
    });
  });

  describe('getPendingCount', () => {
    it('should return correct count', () => {
      queue.enqueue('s1', 'tool1', 'sensitive', {});
      queue.enqueue('s1', 'tool2', 'sensitive', {});
      expect(queue.getPendingCount()).toBe(2);

      const a = queue.enqueue('s1', 'tool3', 'sensitive', {});
      queue.approve(a.id, 'api');
      expect(queue.getPendingCount()).toBe(2);
    });
  });

  describe('TTL expiration', () => {
    it('should expire stale approvals', () => {
      // Use a very short TTL
      const shortQueue = new ApprovalQueueService(1); // 1ms TTL

      shortQueue.enqueue('s1', 'tool1', 'sensitive', {});

      // Wait a bit for expiry
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }

      const pending = shortQueue.getPending();
      expect(pending).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('should remove all approvals', () => {
      queue.enqueue('s1', 'tool1', 'sensitive', {});
      queue.enqueue('s1', 'tool2', 'sensitive', {});
      queue.clear();

      expect(queue.getPending()).toHaveLength(0);
      expect(queue.getPendingCount()).toBe(0);
    });
  });
});
