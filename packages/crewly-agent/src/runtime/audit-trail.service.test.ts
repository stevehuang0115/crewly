import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsPromises } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AuditTrailService } from './audit-trail.service.js';
import type { AuditEntry } from './types.js';

describe('AuditTrailService', () => {
  let service: AuditTrailService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(join(tmpdir(), 'crewly-audit-test-'));
    service = new AuditTrailService(tempDir, 'test-agent-session');
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  const makeEntry = (overrides?: Partial<AuditEntry>): AuditEntry => ({
    timestamp: new Date().toISOString(),
    sessionName: 'test-agent-session',
    toolName: 'get_team_status',
    sensitivity: 'safe',
    args: {},
    success: true,
    durationMs: 15,
    ...overrides,
  });

  describe('initialize', () => {
    it('should create the audit-logs directory', async () => {
      await service.initialize();

      const stat = await fsPromises.stat(join(tempDir, 'audit-logs'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('should set initialized flag', async () => {
      expect(service.isInitialized()).toBe(false);
      await service.initialize();
      expect(service.isInitialized()).toBe(true);
    });

    it('should be idempotent (safe to call multiple times)', async () => {
      await service.initialize();
      await service.initialize();
      expect(service.isInitialized()).toBe(true);
    });
  });

  describe('append', () => {
    it('should throw if not initialized', async () => {
      await expect(service.append(makeEntry())).rejects.toThrow('not initialized');
    });

    it('should write entry as JSONL line', async () => {
      await service.initialize();
      const entry = makeEntry();
      await service.append(entry);

      const content = await fsPromises.readFile(service.getLogFilePath(), 'utf8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.toolName).toBe('get_team_status');
      expect(parsed.sessionName).toBe('test-agent-session');
    });

    it('should append multiple entries on separate lines', async () => {
      await service.initialize();
      await service.append(makeEntry({ toolName: 'tool_a' }));
      await service.append(makeEntry({ toolName: 'tool_b' }));
      await service.append(makeEntry({ toolName: 'tool_c' }));

      const content = await fsPromises.readFile(service.getLogFilePath(), 'utf8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]).toolName).toBe('tool_a');
      expect(JSON.parse(lines[2]).toolName).toBe('tool_c');
    });
  });

  describe('query', () => {
    it('should throw if not initialized', async () => {
      await expect(service.query({ limit: 10 })).rejects.toThrow('not initialized');
    });

    it('should return empty array when log file does not exist', async () => {
      await service.initialize();
      const entries = await service.query({ limit: 50 });
      expect(entries).toEqual([]);
    });

    it('should return entries in reverse chronological order', async () => {
      await service.initialize();
      await service.append(makeEntry({ toolName: 'first', timestamp: '2026-01-01T00:00:00Z' }));
      await service.append(makeEntry({ toolName: 'second', timestamp: '2026-01-01T00:01:00Z' }));
      await service.append(makeEntry({ toolName: 'third', timestamp: '2026-01-01T00:02:00Z' }));

      const entries = await service.query({ limit: 50 });
      expect(entries).toHaveLength(3);
      expect(entries[0].toolName).toBe('third');
      expect(entries[2].toolName).toBe('first');
    });

    it('should respect limit parameter', async () => {
      await service.initialize();
      for (let i = 0; i < 10; i++) {
        await service.append(makeEntry({ toolName: `tool_${i}` }));
      }

      const entries = await service.query({ limit: 3 });
      expect(entries).toHaveLength(3);
      expect(entries[0].toolName).toBe('tool_9');
    });

    it('should filter by sensitivity', async () => {
      await service.initialize();
      await service.append(makeEntry({ toolName: 'safe_tool', sensitivity: 'safe' }));
      await service.append(makeEntry({ toolName: 'sensitive_tool', sensitivity: 'sensitive' }));
      await service.append(makeEntry({ toolName: 'destructive_tool', sensitivity: 'destructive' }));

      const entries = await service.query({ limit: 50, sensitivity: 'sensitive' });
      expect(entries).toHaveLength(1);
      expect(entries[0].toolName).toBe('sensitive_tool');
    });

    it('should filter by toolName', async () => {
      await service.initialize();
      await service.append(makeEntry({ toolName: 'edit_file' }));
      await service.append(makeEntry({ toolName: 'read_file' }));
      await service.append(makeEntry({ toolName: 'edit_file' }));

      const entries = await service.query({ limit: 50, toolName: 'edit_file' });
      expect(entries).toHaveLength(2);
    });

    it('should combine sensitivity and toolName filters', async () => {
      await service.initialize();
      await service.append(makeEntry({ toolName: 'edit_file', sensitivity: 'destructive' }));
      await service.append(makeEntry({ toolName: 'read_file', sensitivity: 'safe' }));
      await service.append(makeEntry({ toolName: 'edit_file', sensitivity: 'safe' }));

      const entries = await service.query({ limit: 50, sensitivity: 'destructive', toolName: 'edit_file' });
      expect(entries).toHaveLength(1);
    });

    it('should skip malformed lines gracefully', async () => {
      await service.initialize();
      await service.append(makeEntry({ toolName: 'valid' }));
      // Manually write a malformed line
      await fsPromises.appendFile(service.getLogFilePath(), 'not-valid-json\n', 'utf8');
      await service.append(makeEntry({ toolName: 'also_valid' }));

      const entries = await service.query({ limit: 50 });
      expect(entries).toHaveLength(2);
      expect(entries[0].toolName).toBe('also_valid');
      expect(entries[1].toolName).toBe('valid');
    });
  });

  describe('getLogFilePath', () => {
    it('should return path under audit-logs directory', () => {
      const path = service.getLogFilePath();
      expect(path).toContain('audit-logs');
      expect(path).toContain('test-agent-session');
      expect(path.endsWith('.jsonl')).toBe(true);
    });

    it('should sanitize special characters in session name', () => {
      const specialService = new AuditTrailService(tempDir, 'agent/with spaces!');
      const path = specialService.getLogFilePath();
      expect(path).not.toContain('/with');
      expect(path).not.toContain(' ');
      expect(path).not.toContain('!');
    });
  });
});
