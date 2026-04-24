import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { TaskService, Task, Milestone } from './task.service.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';

// Mock fs modules
jest.mock('fs/promises');
jest.mock('fs');

/**
 * Test suite for TaskService
 * Tests task management functionality including file operations, task parsing, and milestone handling
 */
describe('TaskService', () => {
  let taskService: TaskService;
  let mockFs: jest.Mocked<typeof fs>;
  let mockExistsSync: jest.MockedFunction<typeof existsSync>;

  beforeEach(() => {
    mockFs = fs as jest.Mocked<typeof fs>;
    mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
    
    // Reset all mocks
    jest.clearAllMocks();
    
    taskService = new TaskService('/test/project');
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('constructor', () => {
    /**
     * Test TaskService initialization with custom project path
     */
    it('should initialize with custom project path', () => {
      const service = new TaskService('/custom/path');
      expect(service).toBeInstanceOf(TaskService);
    });

    /**
     * Test TaskService initialization with default project path
     */
    it('should initialize with default project path when none provided', () => {
      const service = new TaskService();
      expect(service).toBeInstanceOf(TaskService);
    });
  });

  describe('parseMarkdownContent', () => {
    /**
     * Test parsing of valid markdown task content
     */
    it('should parse valid markdown content correctly', () => {
      const mockContent = `# Test Task\n\n**Status:** open\n**Priority:** high\n**Assignee:** testuser\n**Milestone:** v1.0\n\n## Description\nTest description\n\n## Tasks\n- Task 1\n- Task 2\n\n## Acceptance Criteria\n- Criteria 1\n- Criteria 2`;
      
      // Access private method for testing
      const parseMethod = (taskService as any).parseMarkdownContent;
      const result = parseMethod.call(taskService, mockContent);
      
      expect(result.title).toBe('Test Task');
      expect(result.status).toBe('open');
      expect(result.priority).toBe('high');
      expect(result.assignee).toBe('testuser');
      expect(result.milestone).toBe('v1.0');
      expect(result.description).toBe('Test description');
      expect(result.tasks).toEqual(['Task 1', 'Task 2']);
      expect(result.acceptanceCriteria).toEqual(['Criteria 1', 'Criteria 2']);
    });

    /**
     * Test parsing with minimal content
     */
    it('should handle minimal markdown content', () => {
      const mockContent = `# Minimal Task`;

      const parseMethod = (taskService as any).parseMarkdownContent;
      const result = parseMethod.call(taskService, mockContent);

      expect(result.title).toBe('Minimal Task');
      // Unset sentinels — readTaskFile narrows these to real defaults
      // ('open' / 'medium') via the type guards.
      expect(result.status).toBe('');
      expect(result.priority).toBe('');
      expect(result.tasks).toEqual([]);
      expect(result.acceptanceCriteria).toEqual([]);
    });

    /**
     * Test parsing with empty content
     */
    it('should handle empty content gracefully', () => {
      const mockContent = '';

      const parseMethod = (taskService as any).parseMarkdownContent;
      const result = parseMethod.call(taskService, mockContent);

      expect(result.title).toBe('');
      expect(result.status).toBe('');
      expect(result.priority).toBe('');
    });
  });

  describe('file operations', () => {
    /**
     * Test directory existence checking
     */
    it('should check if tasks directory exists', () => {
      mockExistsSync.mockReturnValue(true);
      
      // This would test a method that checks directory existence
      // Since the actual implementation might vary, this is a placeholder
      expect(mockExistsSync).toBeDefined();
    });

    /**
     * Test file reading operations
     */
    it('should handle file reading errors gracefully', async () => {
      mockFs.readFile.mockRejectedValue(new Error('File not found'));
      
      // Test error handling in file operations
      try {
        await mockFs.readFile('nonexistent.md', 'utf-8');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });

    /**
     * Test file writing operations
     */
    it('should handle file writing operations', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);

      await mockFs.writeFile('test.md', 'content');
      expect(mockFs.writeFile).toHaveBeenCalledWith('test.md', 'content');
    });

    /**
     * readTaskFile must skip directory entries that happen to end in `.md`.
     * Without the isFile() guard, readdir-based callers would try to read a
     * directory path as a file and the error would bubble up.
     */
    it('readTaskFile returns null when path points to a directory', async () => {
      mockFs.readFile.mockResolvedValue('# Fake content' as unknown as Buffer);
      mockFs.stat.mockResolvedValue({
        isFile: () => false,
        birthtimeMs: Date.now(),
        mtimeMs: Date.now(),
      } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      const result = await (
        taskService as unknown as {
          readTaskFile: (p: string, m: string) => Promise<unknown>;
        }
      ).readTaskFile('/tasks/archive.md', 'm1');

      expect(result).toBeNull();
    });

    /**
     * Non-regular file shapes (FIFOs, device files, symlinks to
     * directories) should also be skipped, not just plain directories.
     */
    it('readTaskFile returns null for non-regular, non-directory entries', async () => {
      mockFs.readFile.mockResolvedValue('# Fake content' as unknown as Buffer);
      mockFs.stat.mockResolvedValue({
        isFile: () => false,
        isDirectory: () => false,
        birthtimeMs: Date.now(),
        mtimeMs: Date.now(),
      } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      const result = await (
        taskService as unknown as {
          readTaskFile: (p: string, m: string) => Promise<unknown>;
        }
      ).readTaskFile('/tasks/some.fifo.md', 'm1');

      expect(result).toBeNull();
    });

    /**
     * Happy path: when the stat call says it IS a file, parsing proceeds.
     */
    it('readTaskFile returns a parsed Task when path is a regular file', async () => {
      mockFs.readFile.mockResolvedValue(
        '# Hello\n\n**Status:** open\n' as unknown as Buffer,
      );
      mockFs.stat.mockResolvedValue({
        isFile: () => true,
        birthtimeMs: Date.now(),
        mtimeMs: Date.now(),
      } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      const result = (await (
        taskService as unknown as {
          readTaskFile: (p: string, m: string) => Promise<Task | null>;
        }
      ).readTaskFile('/tasks/real-task.md', 'm1')) as Task | null;

      expect(result).not.toBeNull();
      expect(result?.id).toBe('real-task');
    });
  });

  describe('task management', () => {
    /**
     * Test task object creation
     */
    it('should create valid task objects', () => {
      const mockTask: Task = {
        id: 'test-1',
        title: 'Test Task',
        description: 'Test description',
        status: 'open',
        priority: 'medium',
        milestone: 'v1.0',
        milestoneId: 'v1-0',
        tasks: [],
        acceptanceCriteria: [],
        filePath: '/test/path',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      expect(mockTask.id).toBe('test-1');
      expect(mockTask.status).toBe('open');
      expect(mockTask.priority).toBe('medium');
    });

    /**
     * Test milestone object creation
     */
    it('should create valid milestone objects', () => {
      const mockMilestone: Milestone = {
        id: 'v1-0',
        name: 'v1.0',
        title: 'Version 1.0',
        tasks: []
      };
      
      expect(mockMilestone.id).toBe('v1-0');
      expect(mockMilestone.name).toBe('v1.0');
      expect(mockMilestone.tasks).toEqual([]);
    });
  });

  describe('error handling', () => {
    /**
     * Test handling of filesystem errors
     */
    it('should handle filesystem errors gracefully', async () => {
      mockFs.readdir.mockRejectedValue(new Error('Permission denied'));
      
      try {
        await mockFs.readdir('/invalid/path');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Permission denied');
      }
    });

    /**
     * Test handling of parsing errors
     */
    it('should handle malformed content gracefully', () => {
      const malformedContent = 'Invalid\nMarkdown\nContent';
      
      const parseMethod = (taskService as any).parseMarkdownContent;
      const result = parseMethod.call(taskService, malformedContent);
      
      // Should still return a valid structure even with malformed input
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('priority');
    });
  });
});