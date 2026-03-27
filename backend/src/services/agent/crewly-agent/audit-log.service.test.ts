/**
 * AuditLogService Tests
 *
 * Tests for the SQLite-backed persistent audit log service.
 *
 * @module services/agent/crewly-agent/audit-log.service.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AuditLogService } from './audit-log.service.js';
import type { AuditEntry } from './types.js';

describe('AuditLogService', () => {
  let service: AuditLogService;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'audit-log-test-'));
    service = new AuditLogService(tempDir);
    service.initialize();
  });

  afterEach(() => {
    service.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Helper to create a valid AuditEntry */
  function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
    return {
      timestamp: new Date().toISOString(),
      sessionName: 'test-session',
      toolName: 'edit_file',
      sensitivity: 'destructive',
      args: { path: '/tmp/test.txt' },
      success: true,
      durationMs: 42,
      ...overrides,
    };
  }

  describe('initialize()', () => {
    it('should create the database and tables', () => {
      expect(service.isInitialized()).toBe(true);
    });

    it('should be idempotent', () => {
      service.initialize(); // second call should not throw
      expect(service.isInitialized()).toBe(true);
    });
  });

  describe('append()', () => {
    it('should insert a tool-call audit entry', () => {
      service.append(makeEntry());
      const rows = service.query({ limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0].toolName).toBe('edit_file');
      expect(rows[0].action).toBe('tool_call');
      expect(rows[0].success).toBe(true);
      expect(rows[0].args.path).toBe('/tmp/test.txt');
    });

    it('should store failed entries', () => {
      service.append(makeEntry({ success: false, error: 'Permission denied' }));
      const rows = service.query({ limit: 10 });
      expect(rows[0].success).toBe(false);
      expect(rows[0].error).toBe('Permission denied');
    });

    it('should throw if not initialized', () => {
      const uninit = new AuditLogService(tempDir, 'other.sqlite');
      expect(() => uninit.append(makeEntry())).toThrow('not initialized');
    });
  });

  describe('logApprovalEvent()', () => {
    it('should log an approval_granted event', () => {
      service.logApprovalEvent(
        'approval-1', 'sess-1', 'rm_file', 'destructive', 'approval_granted', 'api',
      );
      const rows = service.query({ limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('approval_granted');
      expect(rows[0].resolvedBy).toBe('api');
      expect(rows[0].approvalId).toBe('approval-1');
    });

    it('should log an approval_rejected event', () => {
      service.logApprovalEvent(
        'approval-2', 'sess-1', 'git_push', 'destructive', 'approval_rejected', 'auditor',
      );
      const rows = service.query({ limit: 10 });
      expect(rows[0].action).toBe('approval_rejected');
      expect(rows[0].resolvedBy).toBe('auditor');
    });

    it('should log an approval_expired event', () => {
      service.logApprovalEvent(
        'approval-3', 'sess-1', 'curl', 'external', 'approval_expired', 'auto-expire',
      );
      const rows = service.query({ limit: 10 });
      expect(rows[0].action).toBe('approval_expired');
    });
  });

  describe('query()', () => {
    beforeEach(() => {
      // Insert diverse entries
      service.append(makeEntry({ sessionName: 'sess-1', toolName: 'read_file', sensitivity: 'safe', timestamp: '2026-01-01T00:00:00Z' }));
      service.append(makeEntry({ sessionName: 'sess-1', toolName: 'edit_file', sensitivity: 'destructive', timestamp: '2026-01-02T00:00:00Z' }));
      service.append(makeEntry({ sessionName: 'sess-2', toolName: 'git_push', sensitivity: 'destructive', timestamp: '2026-01-03T00:00:00Z' }));
      service.logApprovalEvent('a-1', 'sess-1', 'rm_file', 'destructive', 'approval_granted', 'api');
    });

    it('should return entries in reverse chronological order', () => {
      const rows = service.query({ limit: 100 });
      expect(rows).toHaveLength(4);
      // Most recent (approval event) should be first
      expect(rows[0].action).toBe('approval_granted');
    });

    it('should filter by sessionName', () => {
      const rows = service.query({ limit: 100, sessionName: 'sess-2' });
      expect(rows).toHaveLength(1);
      expect(rows[0].toolName).toBe('git_push');
    });

    it('should filter by sensitivity', () => {
      const rows = service.query({ limit: 100, sensitivity: 'safe' });
      expect(rows).toHaveLength(1);
      expect(rows[0].toolName).toBe('read_file');
    });

    it('should filter by toolName', () => {
      const rows = service.query({ limit: 100, toolName: 'edit_file' });
      expect(rows).toHaveLength(1);
    });

    it('should filter by action', () => {
      const rows = service.query({ limit: 100, action: 'approval_granted' });
      expect(rows).toHaveLength(1);
    });

    it('should filter by since', () => {
      const rows = service.query({ limit: 100, since: '2026-01-02T00:00:00Z' });
      // Should include entries from Jan 2, Jan 3, and the approval event
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter by until', () => {
      const rows = service.query({ limit: 100, until: '2026-01-01T23:59:59Z' });
      expect(rows).toHaveLength(1);
      expect(rows[0].toolName).toBe('read_file');
    });

    it('should respect limit', () => {
      const rows = service.query({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('should support offset for pagination', () => {
      const page1 = service.query({ limit: 2, offset: 0 });
      const page2 = service.query({ limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].id).not.toBe(page2[0].id);
    });
  });

  describe('count()', () => {
    it('should return total entry count', () => {
      service.append(makeEntry());
      service.append(makeEntry());
      service.append(makeEntry());
      expect(service.count()).toBe(3);
    });

    it('should filter count by sessionName', () => {
      service.append(makeEntry({ sessionName: 'a' }));
      service.append(makeEntry({ sessionName: 'b' }));
      service.append(makeEntry({ sessionName: 'a' }));
      expect(service.count({ sessionName: 'a' })).toBe(2);
    });
  });

  describe('close()', () => {
    it('should close the database and reset state', () => {
      service.close();
      expect(service.isInitialized()).toBe(false);
    });

    it('should be safe to call multiple times', () => {
      service.close();
      service.close(); // no throw
    });
  });

  describe('getDbPath()', () => {
    it('should return the database file path', () => {
      expect(service.getDbPath()).toContain('audit-log.sqlite');
    });
  });
});
