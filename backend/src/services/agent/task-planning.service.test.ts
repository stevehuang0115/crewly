/**
 * Task Planning Service Tests
 *
 * Tests for file-based planning (plan.md, findings.md, progress.md)
 * creation, context injection, progress tracking, and phase checking.
 *
 * @module services/agent/task-planning.service.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { TaskPlanningService } from './task-planning.service.js';
import type { TaskPlanInfo } from './task-planning.service.js';
jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
  appendFile: jest.fn(),
  mkdir: jest.fn(),
}));
jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
}));

const { existsSync } = jest.requireMock('fs') as { existsSync: jest.Mock };
const { readFile: mockedReadFile, writeFile: mockedWriteFile, appendFile: mockedAppendFile, mkdir: mockedMkdir } =
  jest.requireMock('fs/promises') as {
    readFile: jest.Mock<any>;
    writeFile: jest.Mock<any>;
    appendFile: jest.Mock<any>;
    mkdir: jest.Mock<any>;
  };

// =============================================================================
// Fixtures
// =============================================================================

const mockTaskInfo: TaskPlanInfo = {
  taskFilePath: '/project/.crewly/tasks/delegated/in_progress/build_feature_123.md',
  taskTitle: 'Build user registration form',
  priority: 'high',
  sessionName: 'crewly-product-max-118c0421',
};

const expectedPlanDir = '/project/.crewly/tasks/delegated/in_progress/build_feature_123';

// =============================================================================
// Tests
// =============================================================================

describe('TaskPlanningService', () => {
  let service: TaskPlanningService;

  beforeEach(() => {
    jest.clearAllMocks();
    TaskPlanningService.resetInstance();
    service = TaskPlanningService.getInstance();
    existsSync.mockReturnValue(true);
    mockedWriteFile.mockResolvedValue(undefined);
    mockedAppendFile.mockResolvedValue(undefined);
    mockedMkdir.mockResolvedValue(undefined);
  });

  // ── Singleton ──────────────────────────────────────────────────────

  describe('singleton', () => {
    it('should return same instance', () => {
      const a = TaskPlanningService.getInstance();
      const b = TaskPlanningService.getInstance();
      expect(a).toBe(b);
    });

    it('should reset cleanly', () => {
      const a = TaskPlanningService.getInstance();
      TaskPlanningService.resetInstance();
      const b = TaskPlanningService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  // ── getPlanDir ─────────────────────────────────────────────────────

  describe('getPlanDir', () => {
    it('should strip .md and return directory path', () => {
      const dir = service.getPlanDir('/path/to/task_abc_123.md');
      expect(dir).toBe('/path/to/task_abc_123');
    });

    it('should handle paths without .md extension', () => {
      const dir = service.getPlanDir('/path/to/task_abc_123');
      expect(dir).toBe('/path/to/task_abc_123');
    });
  });

  // ── createPlanningFiles ────────────────────────────────────────────

  describe('createPlanningFiles', () => {
    beforeEach(() => {
      existsSync.mockReturnValue(false);
    });

    it('should create planning directory', async () => {
      await service.createPlanningFiles(mockTaskInfo);

      expect(mockedMkdir).toHaveBeenCalledWith(expectedPlanDir, { recursive: true });
    });

    it('should create plan.md with task title and phases', async () => {
      await service.createPlanningFiles(mockTaskInfo);

      const planCall = (mockedWriteFile as jest.Mock).mock.calls.find(
        (call: any[]) => String(call[0]).endsWith('plan.md')
      );
      expect(planCall).toBeDefined();

      const content = planCall![1] as string;
      expect(content).toContain('# Task Plan: Build user registration form');
      expect(content).toContain('## Goal');
      expect(content).toContain('## Phases');
      expect(content).toContain('### Phase 1');
      expect(content).toContain('### Phase 2');
      expect(content).toContain('### Phase 3');
      expect(content).toContain('**Status:** in_progress');
      expect(content).toContain('**Status:** pending');
    });

    it('should create findings.md with template', async () => {
      await service.createPlanningFiles(mockTaskInfo);

      const findingsCall = (mockedWriteFile as jest.Mock).mock.calls.find(
        (call: any[]) => String(call[0]).endsWith('findings.md')
      );
      expect(findingsCall).toBeDefined();

      const content = findingsCall![1] as string;
      expect(content).toContain('# Findings: Build user registration form');
      expect(content).toContain('## Research Discoveries');
      expect(content).toContain('## Key Decisions');
    });

    it('should create progress.md with creation entry', async () => {
      await service.createPlanningFiles(mockTaskInfo);

      const progressCall = (mockedWriteFile as jest.Mock).mock.calls.find(
        (call: any[]) => String(call[0]).endsWith('progress.md')
      );
      expect(progressCall).toBeDefined();

      const content = progressCall![1] as string;
      expect(content).toContain('# Progress: Build user registration form');
      expect(content).toContain('Task assigned to crewly-product-max-118c0421');
      expect(content).toContain('Planning files created');
    });

    it('should return the plan directory path', async () => {
      const result = await service.createPlanningFiles(mockTaskInfo);
      expect(result).toBe(expectedPlanDir);
    });

    it('should not recreate directory if it exists', async () => {
      existsSync.mockReturnValue(true);
      await service.createPlanningFiles(mockTaskInfo);
      expect(mockedMkdir).not.toHaveBeenCalled();
    });
  });

  // ── getPlanContext ─────────────────────────────────────────────────

  describe('getPlanContext', () => {
    it('should return null if plan directory does not exist', async () => {
      existsSync.mockReturnValue(false);
      const result = await service.getPlanContext(mockTaskInfo.taskFilePath);
      expect(result).toBeNull();
    });

    it('should read plan header (first 30 lines)', async () => {
      const planLines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
      mockedReadFile.mockImplementation((path: any) => {
        if (String(path).endsWith('plan.md')) {
          return Promise.resolve(planLines.join('\n'));
        }
        return Promise.reject(new Error('not found'));
      });

      const result = await service.getPlanContext(mockTaskInfo.taskFilePath);

      expect(result).not.toBeNull();
      expect(result!.planHeader).toContain('Line 1');
      expect(result!.planHeader).toContain('Line 30');
      expect(result!.planHeader).not.toContain('Line 31');
    });

    it('should read progress tail (last 15 lines)', async () => {
      const progressLines = Array.from({ length: 30 }, (_, i) => `Progress ${i + 1}`);
      mockedReadFile.mockImplementation((path: any) => {
        if (String(path).endsWith('progress.md')) {
          return Promise.resolve(progressLines.join('\n'));
        }
        return Promise.reject(new Error('not found'));
      });

      const result = await service.getPlanContext(mockTaskInfo.taskFilePath);

      expect(result).not.toBeNull();
      expect(result!.recentProgress).toContain('Progress 30');
      expect(result!.recentProgress).toContain('Progress 16');
      expect(result!.recentProgress).not.toContain('Progress 15');
    });

    it('should combine plan and progress in context', async () => {
      mockedReadFile.mockImplementation((path: any) => {
        if (String(path).endsWith('plan.md')) return Promise.resolve('# Plan');
        if (String(path).endsWith('progress.md')) return Promise.resolve('- Progress entry');
        return Promise.reject(new Error('not found'));
      });

      const result = await service.getPlanContext(mockTaskInfo.taskFilePath);

      expect(result!.combined).toContain('[TASK PLAN]');
      expect(result!.combined).toContain('[RECENT PROGRESS]');
    });

    it('should return null if both files are missing', async () => {
      mockedReadFile.mockRejectedValue(new Error('not found'));
      const result = await service.getPlanContext(mockTaskInfo.taskFilePath);
      expect(result).toBeNull();
    });
  });

  // ── appendProgress ─────────────────────────────────────────────────

  describe('appendProgress', () => {
    it('should append timestamped entry to progress.md', async () => {
      await service.appendProgress(
        mockTaskInfo.taskFilePath,
        'edit_file',
        '/src/components/Form.tsx'
      );

      expect(mockedAppendFile).toHaveBeenCalledWith(
        expect.stringContaining('progress.md'),
        expect.stringMatching(/- \d{4}-\d{2}-\d{2}T.*: edit_file — \/src\/components\/Form\.tsx\n/)
      );
    });

    it('should truncate long summaries to 150 chars', async () => {
      const longSummary = 'a'.repeat(300);
      await service.appendProgress(mockTaskInfo.taskFilePath, 'write_file', longSummary);

      const call = mockedAppendFile.mock.calls[0];
      const entry = call[1] as string;
      // 150 chars of 'a' + timestamp prefix + tool name
      expect(entry.length).toBeLessThan(300);
    });

    it('should not throw if directory does not exist', async () => {
      existsSync.mockReturnValue(false);
      await expect(
        service.appendProgress(mockTaskInfo.taskFilePath, 'edit_file', 'test')
      ).resolves.not.toThrow();
    });
  });

  // ── appendFinding ──────────────────────────────────────────────────

  describe('appendFinding', () => {
    it('should insert finding after Research Discoveries header', async () => {
      mockedReadFile.mockResolvedValue(
        '# Findings\n\n## Research Discoveries\n<!-- Add discoveries -->\n\n## Key Decisions'
      );

      await service.appendFinding(mockTaskInfo.taskFilePath, 'Found API endpoint at /api/users');

      expect(mockedWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('findings.md'),
        expect.stringContaining('Found API endpoint at /api/users'),
        'utf8'
      );
    });
  });

  // ── checkPhaseStatus ───────────────────────────────────────────────

  describe('checkPhaseStatus', () => {
    it('should count total and completed phases', async () => {
      mockedReadFile.mockResolvedValue(`
### Phase 1: Analysis
- **Status:** complete

### Phase 2: Implementation
- **Status:** complete

### Phase 3: Verification
- **Status:** pending
      `);

      const status = await service.checkPhaseStatus(mockTaskInfo.taskFilePath);

      expect(status).not.toBeNull();
      expect(status!.totalPhases).toBe(3);
      expect(status!.completedPhases).toBe(2);
      expect(status!.allComplete).toBe(false);
    });

    it('should return allComplete=true when all phases done', async () => {
      mockedReadFile.mockResolvedValue(`
### Phase 1: Analysis
- **Status:** complete

### Phase 2: Implementation
- **Status:** complete
      `);

      const status = await service.checkPhaseStatus(mockTaskInfo.taskFilePath);
      expect(status!.allComplete).toBe(true);
    });

    it('should return null if plan file does not exist', async () => {
      mockedReadFile.mockRejectedValue(new Error('ENOENT'));
      const status = await service.checkPhaseStatus(mockTaskInfo.taskFilePath);
      expect(status).toBeNull();
    });
  });
});
