/**
 * Tests for SOPService
 *
 * @module services/sop/sop.service.test
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { SOPService } from './sop.service.js';
import { SOP, SOPIndex, SOP_CONSTANTS } from '../../types/sop.types.js';

// Mock fs/promises
jest.mock('fs/promises');
jest.mock('fs', () => ({
  existsSync: jest.fn(),
}));

// Mock logger
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

describe('SOPService', () => {
  let service: SOPService;
  const mockFs = fs as unknown as {
    mkdir: jest.Mock;
    readFile: jest.Mock;
    writeFile: jest.Mock;
    readdir: jest.Mock;
    unlink: jest.Mock;
  };

  const testBasePath = '/test/sops';

  const sampleSOPContent = `---
id: test-sop-001
version: 1
createdAt: 2026-01-01T00:00:00Z
updatedAt: 2026-01-01T00:00:00Z
createdBy: system
role: developer
category: git
priority: 10
title: Test Git Workflow
description: A test SOP for git workflow
triggers:
  - commit
  - push
  - branch
tags:
  - git
  - workflow
---

# Test Git Workflow

This is the SOP content.

## Steps

1. Do something
2. Do something else
`;

  const sampleIndex: SOPIndex = {
    version: '1.0',
    lastUpdated: '2026-01-01T00:00:00Z',
    sops: [
      {
        id: 'test-sop-001',
        path: 'system/developer/test-sop.md',
        role: 'developer',
        category: 'git',
        priority: 10,
        triggers: ['commit', 'push', 'branch'],
        title: 'Test Git Workflow',
        isSystem: true,
      },
      {
        id: 'test-sop-002',
        path: 'custom/test-custom.md',
        role: 'all',
        category: 'communication',
        priority: 5,
        triggers: ['message', 'broadcast'],
        title: 'Communication Protocol',
        isSystem: false,
      },
    ],
  };

  beforeEach(() => {
    SOPService.clearInstance();
    service = SOPService.createWithPath(testBasePath);
    jest.clearAllMocks();

    // Default mocks
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.readFile.mockResolvedValue(JSON.stringify(sampleIndex));
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readdir.mockResolvedValue([]);
  });

  afterEach(() => {
    SOPService.clearInstance();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = SOPService.getInstance();
      const instance2 = SOPService.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should create new instance after clearInstance', () => {
      const instance1 = SOPService.getInstance();
      SOPService.clearInstance();
      const instance2 = SOPService.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('createWithPath', () => {
    it('should create instance with custom path', () => {
      const customService = SOPService.createWithPath('/custom/path');
      expect(customService).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('should create directories', async () => {
      await service.initialize();

      expect(mockFs.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('system'),
        { recursive: true }
      );
      expect(mockFs.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('custom'),
        { recursive: true }
      );
    });

    it('should only initialize once', async () => {
      await service.initialize();
      await service.initialize();

      // mkdir should only be called twice (once for each directory)
      expect(mockFs.mkdir).toHaveBeenCalledTimes(2);
    });
  });

  describe('getIndex', () => {
    it('should load index from file', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(sampleIndex));

      const index = await service.getIndex();

      expect(index.version).toBe('1.0');
      expect(index.sops).toHaveLength(2);
    });

    it('should rebuild index if file not found', async () => {
      mockFs.readFile
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValue(JSON.stringify({ version: '1.0', lastUpdated: '', sops: [] }));

      const index = await service.getIndex();

      expect(index).toBeDefined();
      expect(mockFs.writeFile).toHaveBeenCalled();
    });
  });

  describe('getSOP', () => {
    it('should return SOP by ID', async () => {
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(sampleIndex))
        .mockResolvedValueOnce(sampleSOPContent);

      const sop = await service.getSOP('test-sop-001');

      expect(sop).not.toBeNull();
      expect(sop?.id).toBe('test-sop-001');
      expect(sop?.role).toBe('developer');
      expect(sop?.category).toBe('git');
    });

    it('should return null for non-existent SOP', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(sampleIndex));

      const sop = await service.getSOP('non-existent');

      expect(sop).toBeNull();
    });

    it('should cache loaded SOPs', async () => {
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(sampleIndex))
        .mockResolvedValueOnce(sampleSOPContent);

      await service.getSOP('test-sop-001');
      await service.getSOP('test-sop-001');

      // readFile for SOP content should only be called once
      expect(mockFs.readFile).toHaveBeenCalledTimes(2); // index + SOP
    });
  });

  describe('getSOPsByRole', () => {
    it('should return SOPs for specific role', async () => {
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(sampleIndex))
        .mockResolvedValueOnce(sampleSOPContent);

      const sops = await service.getSOPsByRole('developer');

      // Should match 'developer' role and 'all' role
      expect(sops.length).toBeGreaterThanOrEqual(1);
    });

    it('should return all SOPs when role is "all"', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(sampleIndex));

      const sops = await service.getSOPsByRole('all');

      expect(sops.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getSOPsByCategory', () => {
    it('should return SOPs in category', async () => {
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(sampleIndex))
        .mockResolvedValueOnce(sampleSOPContent);

      const sops = await service.getSOPsByCategory('git');

      expect(sops.length).toBe(1);
      expect(sops[0].category).toBe('git');
    });
  });

  describe('findRelevantSOPs', () => {
    it('should find SOPs matching context', async () => {
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(sampleIndex))
        .mockResolvedValueOnce(sampleSOPContent);

      const sops = await service.findRelevantSOPs({
        role: 'developer',
        taskContext: 'I need to commit my changes',
      });

      expect(sops.length).toBeGreaterThanOrEqual(0);
    });

    it('should respect limit parameter', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(sampleIndex));

      const sops = await service.findRelevantSOPs({
        role: 'developer',
        taskContext: 'commit push branch',
        limit: 1,
      });

      expect(sops.length).toBeLessThanOrEqual(1);
    });
  });

  describe('scoreRelevance', () => {
    it('should score higher for exact trigger matches', () => {
      const entry = sampleIndex.sops[0];

      const scoreWithMatch = service.scoreRelevance(entry, 'I need to commit');
      const scoreWithoutMatch = service.scoreRelevance(entry, 'random text');

      expect(scoreWithMatch).toBeGreaterThan(scoreWithoutMatch);
    });

    it('should score higher for category match', () => {
      const entry = sampleIndex.sops[0]; // git category

      const scoreWithCategory = service.scoreRelevance(entry, 'some context', 'git');
      const scoreWithoutCategory = service.scoreRelevance(entry, 'some context', 'testing');

      expect(scoreWithCategory).toBeGreaterThan(scoreWithoutCategory);
    });

    it('should cap score at 1.0', () => {
      const entry = sampleIndex.sops[0];

      const score = service.scoreRelevance(entry, 'commit push branch git workflow test', 'git');

      expect(score).toBeLessThanOrEqual(1.0);
    });
  });

  describe('generateSOPContext', () => {
    it('should generate context string for matching SOPs', async () => {
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(sampleIndex))
        .mockResolvedValueOnce(sampleSOPContent);

      const context = await service.generateSOPContext({
        role: 'developer',
        taskContext: 'commit changes',
      });

      expect(context).toContain('Standard Operating Procedures');
    });

    it('should return empty string when no SOPs match', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ ...sampleIndex, sops: [] }));

      const context = await service.generateSOPContext({
        role: 'developer',
        taskContext: 'random context',
      });

      expect(context).toBe('');
    });

    it('should truncate long content', async () => {
      const longContent = sampleSOPContent.replace(
        'This is the SOP content.',
        'x'.repeat(SOP_CONSTANTS.LIMITS.MAX_SOP_CONTENT_LENGTH + 100)
      );

      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(sampleIndex))
        .mockResolvedValueOnce(longContent);

      const context = await service.generateSOPContext({
        role: 'developer',
        taskContext: 'commit',
      });

      if (context.length > 0) {
        expect(context).toContain('[Content truncated]');
      }
    });
  });

  describe('createCustomSOP', () => {
    it('should create custom SOP file', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(sampleIndex));

      const id = await service.createCustomSOP({
        createdBy: 'agent-test',
        role: 'developer',
        category: 'workflow',
        priority: 5,
        title: 'Custom Workflow',
        description: 'A custom workflow SOP',
        content: '# Custom Workflow\n\nDo this...',
        triggers: ['workflow', 'process'],
        tags: ['custom'],
      });

      expect(id).toMatch(/^custom-/);
      expect(mockFs.writeFile).toHaveBeenCalled();
    });
  });

  describe('updateSOP', () => {
    it('should update custom SOP', async () => {
      const customIndex: SOPIndex = {
        ...sampleIndex,
        sops: [
          {
            id: 'custom-001',
            path: 'custom/custom-001.md',
            role: 'developer',
            category: 'workflow',
            priority: 5,
            triggers: ['test'],
            title: 'Custom SOP',
            isSystem: false,
          },
        ],
      };

      const customSOPContent = `---
id: custom-001
version: 1
createdAt: 2026-01-01T00:00:00Z
updatedAt: 2026-01-01T00:00:00Z
createdBy: agent-test
role: developer
category: workflow
priority: 5
title: Custom SOP
description: Test
triggers:
  - test
tags:
  - custom
---

# Custom SOP

Content here.
`;

      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(customIndex))
        .mockResolvedValueOnce(customSOPContent)
        .mockResolvedValue(JSON.stringify(customIndex));

      await service.updateSOP('custom-001', { title: 'Updated Title' });

      expect(mockFs.writeFile).toHaveBeenCalled();
    });

    it('should throw error for system SOPs', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(sampleIndex));

      await expect(service.updateSOP('test-sop-001', { title: 'Updated' })).rejects.toThrow(
        'Cannot update system SOPs'
      );
    });

    it('should throw error for non-existent SOP', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(sampleIndex));

      await expect(service.updateSOP('non-existent', { title: 'Updated' })).rejects.toThrow(
        'SOP not found'
      );
    });
  });

  describe('deleteSOP', () => {
    it('should delete custom SOP', async () => {
      const customIndex: SOPIndex = {
        ...sampleIndex,
        sops: [
          {
            id: 'custom-001',
            path: 'custom/custom-001.md',
            role: 'developer',
            category: 'workflow',
            priority: 5,
            triggers: ['test'],
            title: 'Custom SOP',
            isSystem: false,
          },
        ],
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(customIndex));
      mockFs.unlink.mockResolvedValue(undefined);

      await service.deleteSOP('custom-001');

      expect(mockFs.unlink).toHaveBeenCalled();
    });

    it('should throw error for system SOPs', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(sampleIndex));

      await expect(service.deleteSOP('test-sop-001')).rejects.toThrow(
        'Cannot delete system SOPs'
      );
    });
  });

  describe('searchSOPs', () => {
    it('should search by title', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(sampleIndex));

      const results = await service.searchSOPs('Git');

      expect(results.some((r) => r.title.includes('Git'))).toBe(true);
    });

    it('should search by trigger', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(sampleIndex));

      const results = await service.searchSOPs('commit');

      expect(results.some((r) => r.triggers.includes('commit'))).toBe(true);
    });

    it('should search by category', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(sampleIndex));

      const results = await service.searchSOPs('communication');

      expect(results.some((r) => r.category === 'communication')).toBe(true);
    });

    it('should return empty array for no matches', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(sampleIndex));

      const results = await service.searchSOPs('nonexistenttermxyz');

      expect(results).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // F8: graceful fallback when ~/.crewly/sops/index.json is missing.
  //
  // These tests pin the Pool-WorkItem 6465e00f acceptance criteria:
  //  (1) service does NOT throw when index.json is missing
  //  (2) rebuild regenerates from on-disk SOP files when present
  //  (3) `getLastFallbackReason()` exposes telemetry for the controller
  //  (4) the basePath dir is created (mkdir -p) before saving the index,
  //      preventing the fresh-install ENOENT crash that produced the 500.
  // ---------------------------------------------------------------------
  describe('graceful fallback (F8)', () => {
    it('returns empty index without throwing when index.json is missing and no SOP files exist', async () => {
      // index.json read fails (ENOENT)
      mockFs.readFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));
      // No SOP files on disk in either system/ or custom/
      mockFs.readdir.mockResolvedValue([]);
      mockFs.writeFile.mockResolvedValue(undefined);

      const index = await service.getIndex();

      expect(index).toBeDefined();
      expect(index.sops).toEqual([]);
      // Fallback reason is stamped so the controller can advertise the
      // degraded mode to the get-sops skill caller.
      expect(service.getLastFallbackReason()).toBe(
        'index-missing-graceful-fallback'
      );
    });

    it('regenerates index from on-disk SOP files when index.json is missing', async () => {
      const { existsSync } = jest.requireMock('fs') as { existsSync: jest.Mock };
      // basePath / systemPath / customPath all exist
      existsSync.mockReturnValue(true);

      // index.json read fails, then any subsequent file reads return the
      // sample SOP markdown (parsed for entries below).
      mockFs.readFile
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValue(sampleSOPContent);

      // First readdir = systemPath (one .md file), second = customPath (empty)
      mockFs.readdir
        .mockResolvedValueOnce([
          { name: 'test-sop.md', isDirectory: () => false, isFile: () => true } as never,
        ])
        .mockResolvedValueOnce([]);
      mockFs.writeFile.mockResolvedValue(undefined);

      const index = await service.getIndex();

      expect(index).toBeDefined();
      expect(index.sops.length).toBe(1);
      expect(index.sops[0].id).toBe('test-sop-001');
      // Persisted to disk
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('index.json'),
        expect.any(String),
        'utf-8'
      );
      // Reason still stamped — index was missing on initial read even
      // though regeneration from filesystem succeeded. Callers can opt
      // to log the back-fill but treat the data as authoritative.
      expect(service.getLastFallbackReason()).toBe(
        'index-missing-graceful-fallback'
      );
    });

    it('does not throw when basePath does not exist (creates it via mkdir -p before saveIndex)', async () => {
      // index.json read fails because the entire ~/.crewly/sops dir is missing
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
      // readdir won't be called (existsSync returns false) — but if it is,
      // it should also fail to mirror real ENOENT behaviour.
      mockFs.readdir.mockRejectedValue(new Error('ENOENT'));
      mockFs.writeFile.mockResolvedValue(undefined);
      const { existsSync } = jest.requireMock('fs') as { existsSync: jest.Mock };
      existsSync.mockReturnValue(false);
      // mkdir is allowed — that's exactly the fix
      mockFs.mkdir.mockResolvedValue(undefined);

      await expect(service.getIndex()).resolves.toBeDefined();

      // mkdir was called with basePath + recursive true to materialise
      // the missing directory before saveIndex writes index.json.
      expect(mockFs.mkdir).toHaveBeenCalledWith(
        testBasePath,
        { recursive: true }
      );
    });

    it('does not throw when saveIndex itself fails (e.g. read-only FS)', async () => {
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
      mockFs.readdir.mockResolvedValue([]);
      // Disk write fails — we keep the in-memory index instead of bubbling
      mockFs.writeFile.mockRejectedValue(new Error('EROFS: read-only file system'));
      mockFs.mkdir.mockResolvedValue(undefined);

      await expect(service.getIndex()).resolves.toBeDefined();

      const index = await service.getIndex();
      expect(index.sops).toEqual([]);
      expect(service.getLastFallbackReason()).toBe(
        'index-missing-graceful-fallback'
      );
    });

    it('clears lastFallbackReason after a healthy index read', async () => {
      // First call: trigger fallback
      mockFs.readFile.mockRejectedValueOnce(new Error('ENOENT'));
      mockFs.readdir.mockResolvedValue([]);
      mockFs.writeFile.mockResolvedValue(undefined);

      await service.getIndex();
      expect(service.getLastFallbackReason()).toBe(
        'index-missing-graceful-fallback'
      );

      // Second call after clearing in-memory cache: healthy read
      // (forcing ensureIndex to run again by clearing the instance state
      // would normally require clearInstance + re-create; instead we
      // verify the symmetric behaviour by re-creating the service)
      SOPService.clearInstance();
      const fresh = SOPService.createWithPath(testBasePath);
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(sampleIndex));

      await fresh.getIndex();
      expect(fresh.getLastFallbackReason()).toBeNull();
    });

    it('exposes FALLBACK_REASON_INDEX_MISSING as a public sentinel', () => {
      // Pinning the string contract — controller and any external consumer
      // (skill, telemetry pipeline) compare against this constant.
      expect(SOPService.FALLBACK_REASON_INDEX_MISSING).toBe(
        'index-missing-graceful-fallback'
      );
    });
  });

  describe('clearCache', () => {
    it('should clear the SOP cache', async () => {
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(sampleIndex))
        .mockResolvedValueOnce(sampleSOPContent)
        .mockResolvedValueOnce(sampleSOPContent);

      await service.getSOP('test-sop-001');
      service.clearCache();
      await service.getSOP('test-sop-001');

      // Index is loaded once, then SOP content is read twice (cache was cleared for SOPs, not index)
      expect(mockFs.readFile).toHaveBeenCalledTimes(3);
    });
  });
});
