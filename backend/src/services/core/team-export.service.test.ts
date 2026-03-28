/**
 * Team Export/Import Service Tests
 *
 * Tests for exporting and importing complete team bundles including
 * config, prompts, norms, and cron tasks.
 *
 * @module services/core/team-export.service.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { TeamExportService, generateCronId } from './team-export.service.js';
import type { TeamExport } from './team-export.service.js';
import type { Team } from '../../types/index.js';
import type { CronTask } from '../../types/cron-task.types.js';
import fs from 'fs/promises';

jest.mock('fs/promises');
jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
}));

const { existsSync } = jest.requireMock('fs') as { existsSync: jest.Mock };
const mockedFs = fs as jest.Mocked<typeof fs>;

// =============================================================================
// Test Fixtures
// =============================================================================

const mockTeam: Team = {
  id: 'team-abc',
  name: 'Test Team',
  description: 'A test team',
  members: [
    {
      id: 'member-1',
      name: 'Sam',
      role: 'developer',
      status: 'active',
      sessionName: 'crewly-test-sam',
    } as any,
  ],
  projectIds: ['proj-1'],
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-28T00:00:00Z',
};

const mockCronTasks: CronTask[] = [
  {
    id: 'cron-old1',
    cronExpression: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    targetAgent: 'crewly-orc',
    targetTeamId: 'team-abc',
    taskDescription: 'Daily standup',
    createdBy: 'user',
    createdAt: '2026-03-01T00:00:00Z',
    enabled: true,
    lastRunAt: null,
    nextRunAt: '2026-03-28T01:00:00Z',
  },
  {
    id: 'cron-old2',
    cronExpression: '0 17 * * 5',
    timezone: 'Asia/Shanghai',
    targetAgent: 'crewly-test-sam',
    targetTeamId: 'team-abc',
    taskDescription: 'Weekly report',
    createdBy: 'orchestrator',
    createdAt: '2026-03-10T00:00:00Z',
    enabled: true,
    lastRunAt: '2026-03-21T09:00:00Z',
    nextRunAt: '2026-03-28T09:00:00Z',
  },
];

const mockStorageService = {
  getTeams: jest.fn<any>().mockResolvedValue([mockTeam]),
  getTeamDir: jest.fn<any>((id: string) => `/mock/.crewly/teams/${id}`),
  saveTeam: jest.fn<any>().mockResolvedValue(undefined),
  saveMemberPrompt: jest.fn<any>().mockResolvedValue(undefined),
};

// =============================================================================
// Tests
// =============================================================================

describe('TeamExportService', () => {
  let service: TeamExportService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TeamExportService(mockStorageService as any);
    existsSync.mockReturnValue(true);
  });

  // ── Export ──────────────────────────────────────────────────────────────

  describe('exportTeam', () => {
    beforeEach(() => {
      // Mock readdir for prompts and norms
      mockedFs.readdir.mockImplementation((dirPath: any) => {
        const dir = String(dirPath);
        if (dir.includes('prompts')) {
          return Promise.resolve(['member-1.md'] as any);
        }
        if (dir.includes('norms')) {
          return Promise.resolve(['code-commit-sop.md', 'quality-gates.md'] as any);
        }
        return Promise.resolve([] as any);
      });

      // Mock readFile for prompts, norms, and cron tasks
      (mockedFs.readFile as jest.Mock).mockImplementation((filePath: any) => {
        const fp = String(filePath);
        if (fp.includes('member-1.md')) {
          return Promise.resolve('You are a developer...');
        }
        if (fp.includes('code-commit-sop.md')) {
          return Promise.resolve('# Code Commit SOP\n...');
        }
        if (fp.includes('quality-gates.md')) {
          return Promise.resolve('# Quality Gates\n...');
        }
        if (fp.includes('cron-tasks.json')) {
          return Promise.resolve(JSON.stringify({ tasks: mockCronTasks }));
        }
        return Promise.reject(new Error('File not found'));
      });
    });

    it('should export team config', async () => {
      const result = await service.exportTeam('team-abc');

      expect(result.version).toBe('1.0');
      expect(result.exportedAt).toBeDefined();
      expect(result.team).toEqual(mockTeam);
    });

    it('should export prompts keyed by memberId', async () => {
      const result = await service.exportTeam('team-abc');

      expect(result.prompts).toEqual({
        'member-1': 'You are a developer...',
      });
    });

    it('should export norms keyed by filename', async () => {
      const result = await service.exportTeam('team-abc');

      expect(result.norms).toEqual({
        'code-commit-sop.md': '# Code Commit SOP\n...',
        'quality-gates.md': '# Quality Gates\n...',
      });
    });

    it('should export cron tasks', async () => {
      const result = await service.exportTeam('team-abc');

      expect(result.cronTasks).toHaveLength(2);
      expect(result.cronTasks[0].id).toBe('cron-old1');
      expect(result.cronTasks[1].id).toBe('cron-old2');
    });

    it('should throw if team not found', async () => {
      await expect(service.exportTeam('nonexistent'))
        .rejects.toThrow('Team not found: nonexistent');
    });

    it('should handle missing prompts directory', async () => {
      (existsSync as jest.Mock).mockImplementation((p: any) => !String(p).includes('prompts'));
      const result = await service.exportTeam('team-abc');

      expect(result.prompts).toEqual({});
    });

    it('should handle missing norms directory', async () => {
      (existsSync as jest.Mock).mockImplementation((p: any) => !String(p).includes('norms'));
      const result = await service.exportTeam('team-abc');

      expect(result.norms).toEqual({});
    });

    it('should handle missing cron tasks file', async () => {
      (mockedFs.readFile as jest.Mock).mockImplementation((filePath: any) => {
        const fp = String(filePath);
        if (fp.includes('cron-tasks.json')) {
          return Promise.reject(new Error('ENOENT'));
        }
        if (fp.includes('.md')) return Promise.resolve('content');
        return Promise.reject(new Error('not found'));
      });
      mockedFs.readdir.mockResolvedValue([] as any);

      const result = await service.exportTeam('team-abc');
      expect(result.cronTasks).toEqual([]);
    });
  });

  // ── Import ──────────────────────────────────────────────────────────────

  describe('importTeam', () => {
    const mockExport: TeamExport = {
      version: '1.0',
      exportedAt: '2026-03-28T00:00:00Z',
      team: mockTeam,
      prompts: {
        'member-1': 'You are a developer...',
      },
      norms: {
        'code-commit-sop.md': '# Code Commit SOP',
      },
      cronTasks: mockCronTasks,
    };

    beforeEach(() => {
      mockedFs.writeFile.mockResolvedValue(undefined);
    });

    it('should save the team via storageService', async () => {
      await service.importTeam(mockExport);

      expect(mockStorageService.saveTeam).toHaveBeenCalledWith(mockTeam);
    });

    it('should write prompts via saveMemberPrompt', async () => {
      await service.importTeam(mockExport);

      expect(mockStorageService.saveMemberPrompt).toHaveBeenCalledWith(
        'team-abc', 'member-1', 'You are a developer...'
      );
    });

    it('should write norms to team norms directory', async () => {
      await service.importTeam(mockExport);

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('norms/code-commit-sop.md'),
        '# Code Commit SOP',
        'utf8'
      );
    });

    it('should generate new IDs for cron tasks', async () => {
      await service.importTeam(mockExport);

      const writeCall = mockedFs.writeFile.mock.calls.find(
        (call) => String(call[0]).includes('cron-tasks.json')
      );
      expect(writeCall).toBeDefined();

      const written = JSON.parse(writeCall![1] as string);
      expect(written.tasks).toHaveLength(2);

      // New IDs should be different from originals
      expect(written.tasks[0].id).not.toBe('cron-old1');
      expect(written.tasks[1].id).not.toBe('cron-old2');

      // IDs should follow the cron-xxxxxxxx format
      expect(written.tasks[0].id).toMatch(/^cron-[a-f0-9]{8}$/);
      expect(written.tasks[1].id).toMatch(/^cron-[a-f0-9]{8}$/);
    });

    it('should remap targetTeamId to the imported team ID', async () => {
      await service.importTeam(mockExport);

      const writeCall = mockedFs.writeFile.mock.calls.find(
        (call) => String(call[0]).includes('cron-tasks.json')
      );
      const written = JSON.parse(writeCall![1] as string);

      expect(written.tasks[0].targetTeamId).toBe('team-abc');
      expect(written.tasks[1].targetTeamId).toBe('team-abc');
    });

    it('should return import result with counts', async () => {
      const result = await service.importTeam(mockExport);

      expect(result.team).toEqual(mockTeam);
      expect(result.promptsImported).toBe(1);
      expect(result.normsImported).toBe(1);
      expect(result.cronTasksImported).toBe(2);
    });

    it('should handle empty prompts/norms/cron', async () => {
      const emptyExport: TeamExport = {
        version: '1.0',
        exportedAt: '2026-03-28T00:00:00Z',
        team: mockTeam,
        prompts: {},
        norms: {},
        cronTasks: [],
      };

      const result = await service.importTeam(emptyExport);

      expect(result.promptsImported).toBe(0);
      expect(result.normsImported).toBe(0);
      expect(result.cronTasksImported).toBe(0);
      expect(mockStorageService.saveMemberPrompt).not.toHaveBeenCalled();
    });

    it('should throw on invalid export format', async () => {
      await expect(service.importTeam({} as any))
        .rejects.toThrow('Invalid team export format');
    });

    it('should throw on missing team data', async () => {
      await expect(service.importTeam({ version: '1.0' } as any))
        .rejects.toThrow('Invalid team export format');
    });
  });

  // ── Round-trip ─────────────────────────────────────────────────────────

  describe('round-trip (export → import → export)', () => {
    it('should produce equivalent data after round-trip', async () => {
      // Setup: export reads from mock FS
      mockedFs.readdir.mockImplementation((dirPath: any) => {
        const dir = String(dirPath);
        if (dir.includes('prompts')) return Promise.resolve(['member-1.md'] as any);
        if (dir.includes('norms')) return Promise.resolve(['sop.md'] as any);
        return Promise.resolve([] as any);
      });
      (mockedFs.readFile as jest.Mock).mockImplementation((filePath: any) => {
        const fp = String(filePath);
        if (fp.includes('member-1.md')) return Promise.resolve('prompt content');
        if (fp.includes('sop.md')) return Promise.resolve('# SOP');
        if (fp.includes('cron-tasks.json')) {
          return Promise.resolve(JSON.stringify({ tasks: mockCronTasks }));
        }
        return Promise.reject(new Error('not found'));
      });
      mockedFs.writeFile.mockResolvedValue(undefined);

      // Step 1: Export
      const exported = await service.exportTeam('team-abc');

      // Step 2: Import
      const importResult = await service.importTeam(exported);

      // Verify team was saved
      expect(mockStorageService.saveTeam).toHaveBeenCalledWith(mockTeam);

      // Step 3: Export again (re-reading what was "imported")
      // The cron tasks written during import should have new IDs
      const cronWriteCall = mockedFs.writeFile.mock.calls.find(
        (call) => String(call[0]).includes('cron-tasks.json')
      );
      const importedCronStore = JSON.parse(cronWriteCall![1] as string);

      // Verify structural equivalence (ignoring cron task IDs)
      expect(exported.version).toBe('1.0');
      expect(importResult.team.id).toBe(exported.team.id);
      expect(importResult.team.name).toBe(exported.team.name);
      expect(importResult.promptsImported).toBe(Object.keys(exported.prompts).length);
      expect(importResult.normsImported).toBe(Object.keys(exported.norms).length);
      expect(importResult.cronTasksImported).toBe(exported.cronTasks.length);

      // Cron task data is preserved (minus IDs and targetTeamId remap)
      expect(importedCronStore.tasks).toHaveLength(exported.cronTasks.length);
      expect(importedCronStore.tasks[0].cronExpression).toBe(exported.cronTasks[0].cronExpression);
      expect(importedCronStore.tasks[0].taskDescription).toBe(exported.cronTasks[0].taskDescription);
      expect(importedCronStore.tasks[0].targetTeamId).toBe(exported.team.id);
    });
  });

  // ── generateCronId ─────────────────────────────────────────────────────

  describe('generateCronId', () => {
    it('should generate IDs in cron-xxxxxxxx format', () => {
      const id = generateCronId();
      expect(id).toMatch(/^cron-[a-f0-9]{8}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateCronId()));
      expect(ids.size).toBe(100);
    });
  });
});
