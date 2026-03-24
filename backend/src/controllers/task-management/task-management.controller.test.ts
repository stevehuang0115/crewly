import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Request, Response } from 'express';
import { existsSync } from 'fs';
import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { join, basename, dirname } from 'path';
import * as taskManagementHandlers from './task-management.controller.js';
import { assignTask, completeTask, completeTasksBySession, blockTask, takeNextTask, syncTaskStatus, getTeamProgress, createTask, getTaskOutput, addMonitoring, setEventBusServiceForTaskCleanup, scoreTask, saveWorkingNotes } from './task-management.controller.js';
import type { ApiController } from '../api.controller.js';
import { TASK_OUTPUT_CONSTANTS } from '../../types/task-output.types.js';

// Mock filesystem modules
jest.mock('fs');
jest.mock('fs/promises');
jest.mock('path');
jest.mock('../../utils/prompt-resolver.js', () => ({
  resolveStepConfig: jest.fn<any>(),
}));
jest.mock('../../services/agent/agent-heartbeat.service.js', () => ({
  updateAgentHeartbeat: jest.fn<any>().mockResolvedValue(undefined),
}));

// Mock the TaskOutputValidatorService
const mockValidate = jest.fn<any>();
const mockExtractSchemaFromMarkdown = jest.fn<any>();
const mockExtractRetryInfoFromMarkdown = jest.fn<any>();
const mockGenerateSchemaMarkdown = jest.fn<any>();
const mockGenerateRetryMarkdown = jest.fn<any>();
const mockValidateOutputSize = jest.fn<any>();

jest.mock('../../services/quality/task-output-validator.service.js', () => ({
  TaskOutputValidatorService: {
    getInstance: () => ({
      validate: mockValidate,
      extractSchemaFromMarkdown: mockExtractSchemaFromMarkdown,
      extractRetryInfoFromMarkdown: mockExtractRetryInfoFromMarkdown,
      generateSchemaMarkdown: mockGenerateSchemaMarkdown,
      generateRetryMarkdown: mockGenerateRetryMarkdown,
      validateOutputSize: mockValidateOutputSize,
    }),
  },
}));

describe('Task Management Handlers', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: any;

  // Mock ApiController dependencies
  const mockStorageService = {
    getProjects: jest.fn<any>(),
    getTeams: jest.fn<any>(),
  };

  const mockTaskTrackingService = {
    assignTask: jest.fn<any>(),
    getAllInProgressTasks: jest.fn<any>(),
    removeTask: jest.fn<any>(),
    recoverAbandonedTasks: jest.fn<any>(),
    addMonitoringIds: jest.fn<any>(),
    getTasksBySessionName: jest.fn<any>(),
    loadTaskData: jest.fn<any>(),
    saveTaskData: jest.fn<any>(),
    updateWorkingNotes: jest.fn<any>(),  };

  const mockSchedulerService = {
    cancelCheck: jest.fn<any>(),
  };

  const fullMockApiController = {
    storageService: mockStorageService,
    taskTrackingService: mockTaskTrackingService,
    schedulerService: mockSchedulerService,
  } as unknown as ApiController;

  beforeEach(() => {
    jest.clearAllMocks();

    mockRequest = {
      body: { taskPath: '/test/open/task.md', sessionName: 'session-123' },
      params: { id: 'test-id' }
    };

    mockResponse = {
      json: jest.fn<any>(),
      status: jest.fn<any>().mockReturnThis()
    };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('All handlers availability', () => {
    it('should have all expected handler functions', () => {
      expect(typeof taskManagementHandlers.assignTask).toBe('function');
      expect(typeof taskManagementHandlers.completeTask).toBe('function');
      expect(typeof taskManagementHandlers.blockTask).toBe('function');
      expect(typeof taskManagementHandlers.takeNextTask).toBe('function');
      expect(typeof taskManagementHandlers.syncTaskStatus).toBe('function');
      expect(typeof taskManagementHandlers.getTeamProgress).toBe('function');
      expect(typeof taskManagementHandlers.createTasksFromConfig).toBe('function');
      expect(typeof taskManagementHandlers.createTask).toBe('function');
      expect(typeof taskManagementHandlers.getTaskOutput).toBe('function');
      expect(typeof taskManagementHandlers.completeTasksBySession).toBe('function');
    });
  });

  // Tests for the actual assignTask function logic
  describe('assignTask Function Logic', () => {
    let mockReq: Partial<Request>;
    let mockRes: any;
    let jsonSpy: jest.Mock<any>;
    let statusSpy: jest.Mock<any>;

    const validTaskPath = '/Users/yellowsunhy/Desktop/projects/justslash/gas-vibe-coder/.crewly/tasks/m0_initial_tasks/open/01_create_project_requirements_document.md';
    const validSessionName = 'session-123';

    beforeEach(() => {
      jsonSpy = jest.fn<any>();
      statusSpy = jest.fn<any>().mockReturnValue({ json: jsonSpy });

      mockRes = {
        status: statusSpy,
        json: jsonSpy,
      };

      mockReq = {
        body: {
          taskPath: validTaskPath,
          sessionName: validSessionName,
        },
      };

      // Reset all mocks
      jest.clearAllMocks();
    });

    describe('Request validation', () => {
      it('should return 400 when taskPath is missing', async () => {
        mockReq.body!.taskPath = undefined;

        await assignTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(400);
        expect(jsonSpy).toHaveBeenCalledWith({
          success: false,
          error: 'taskPath is required',
        });
      });

      it('should return 400 when taskPath is empty string', async () => {
        mockReq.body!.taskPath = '';

        await assignTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(400);
        expect(jsonSpy).toHaveBeenCalledWith({
          success: false,
          error: 'taskPath is required',
        });
      });

      it('should return 400 when sessionName is missing', async () => {
        mockReq.body!.sessionName = undefined;

        await assignTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(400);
        expect(jsonSpy).toHaveBeenCalledWith({
          success: false,
          error: 'sessionName is required',
        });
      });

      it('should return 400 when sessionName is empty string', async () => {
        mockReq.body!.sessionName = '';

        await assignTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(400);
        expect(jsonSpy).toHaveBeenCalledWith({
          success: false,
          error: 'sessionName is required',
        });
      });
    });

    describe('File validation', () => {
      it('should return 200 with success=false when task file does not exist', async () => {
        (existsSync as jest.Mock<any>).mockReturnValue(false);

        await assignTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(200);
        expect(jsonSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: 'Task file does not exist at the specified path',
          })
        );
      });

      it('should return 200 with success=false when task is not in open folder', async () => {
        const invalidPath = '/Users/test/project/.crewly/tasks/m0_initial_tasks/in_progress/task.md';
        mockReq.body!.taskPath = invalidPath;
        (existsSync as jest.Mock<any>).mockReturnValue(true);

        await assignTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(200);
        expect(jsonSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: 'Task is not in the correct folder for assignment',
          })
        );
      });
    });

    describe('Path parsing - REGEX TESTS', () => {
      it('should correctly match gas-vibe-coder path with regex and return 404 when project not found', async () => {
        const taskPathWithDashes = '/Users/yellowsunhy/Desktop/projects/justslash/gas-vibe-coder/.crewly/tasks/m0_initial_tasks/open/01_create_project_requirements_document.md';
        mockReq.body!.taskPath = taskPathWithDashes;
        (existsSync as jest.Mock<any>).mockReturnValue(true);
        (readFile as jest.Mock<any>).mockResolvedValue('# Test Task\n## Task Information\n- **Target Role**: developer');
        (basename as jest.Mock<any>).mockReturnValue('01_create_project_requirements_document.md');
        (dirname as jest.Mock<any>).mockReturnValue('/Users/yellowsunhy/Desktop/projects/justslash/gas-vibe-coder');
        mockStorageService.getProjects.mockResolvedValue([]);

        await assignTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        // The regex /\/([^/]+)\/\.crewly/ correctly matches gas-vibe-coder,
        // so the controller proceeds past regex validation to project lookup.
        // With no projects returned, it returns 404.
        expect(statusSpy).toHaveBeenCalledWith(404);
        expect(jsonSpy).toHaveBeenCalledWith({
          success: false,
          error: 'Project not found',
        });
      });

      it('should return 400 when cannot determine project from task path - no .crewly', async () => {
        const invalidPath = '/Users/test/project/tasks/open/task.md';
        mockReq.body!.taskPath = invalidPath;
        (existsSync as jest.Mock<any>).mockReturnValue(true);

        await assignTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        // Without /open/ in path it fails at the open folder check
        // Let's use a path that has /open/ but no .crewly
        mockReq.body!.taskPath = '/Users/test/project/open/task.md';
        (readFile as jest.Mock<any>).mockResolvedValue('# Test Task\n## Task Information\n- **Target Role**: developer');

        await assignTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(400);
        expect(jsonSpy).toHaveBeenCalledWith({
          success: false,
          error: 'Cannot determine project from task path',
        });
      });
    });

    describe('Project and team validation', () => {
      beforeEach(() => {
        (existsSync as jest.Mock<any>).mockReturnValue(true);
        (readFile as jest.Mock<any>).mockResolvedValue('# Test Task\n## Task Information\n- **Target Role**: developer');
        // Mock path functions so that the controller can resolve the project path correctly
        (basename as jest.Mock<any>).mockReturnValue('01_create_project_requirements_document.md');
        (dirname as jest.Mock<any>).mockReturnValue('/Users/yellowsunhy/Desktop/projects/justslash/gas-vibe-coder');
      });

      it('should return 404 when project is not found', async () => {
        mockStorageService.getProjects.mockResolvedValue([]);

        await assignTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(404);
        expect(jsonSpy).toHaveBeenCalledWith({
          success: false,
          error: 'Project not found',
        });
      });

      it('should return 404 when team member is not found for sessionName', async () => {
        mockStorageService.getProjects.mockResolvedValue([{
          id: 'project1',
          path: '/Users/yellowsunhy/Desktop/projects/justslash/gas-vibe-coder',
        }]);
        mockStorageService.getTeams.mockResolvedValue([{
          id: 'team1',
          members: [{ id: 'other-member', name: 'Other Member', sessionName: 'other-session' }],
        }]);

        await assignTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(404);
        expect(jsonSpy).toHaveBeenCalledWith({
          success: false,
          error: 'Team member not found for sessionName',
        });
      });
    });
  });

  describe('createTask Function Logic', () => {
    let mockReq: Partial<Request>;
    let mockRes: any;
    let jsonSpy: jest.Mock<any>;
    let statusSpy: jest.Mock<any>;

    beforeEach(() => {
      jsonSpy = jest.fn<any>();
      statusSpy = jest.fn<any>().mockReturnValue({ json: jsonSpy });

      mockRes = {
        status: statusSpy,
        json: jsonSpy,
      };

      mockReq = {
        body: {
          projectPath: '/test/project',
          task: 'Implement feature X',
          priority: 'high',
          sessionName: 'dev-session-1',
          milestone: 'delegated',
        },
      };

      jest.clearAllMocks();
    });

    describe('Request validation', () => {
      it('should return 400 when projectPath is missing', async () => {
        mockReq.body!.projectPath = undefined;

        await createTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(400);
        expect(jsonSpy).toHaveBeenCalledWith({
          success: false,
          error: 'projectPath is required',
        });
      });

      it('should return 400 when task is missing', async () => {
        mockReq.body!.task = undefined;

        await createTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(400);
        expect(jsonSpy).toHaveBeenCalledWith({
          success: false,
          error: 'task is required',
        });
      });

      it('should return 400 when task is empty string', async () => {
        mockReq.body!.task = '';

        await createTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(400);
        expect(jsonSpy).toHaveBeenCalledWith({
          success: false,
          error: 'task is required',
        });
      });
    });

    describe('Task file creation', () => {
      it('should create task file with sessionName in in_progress folder', async () => {
        (existsSync as jest.Mock<any>).mockReturnValue(false);
        (mkdir as jest.Mock<any>).mockResolvedValue(undefined);
        (writeFile as jest.Mock<any>).mockResolvedValue(undefined);
        mockStorageService.getProjects.mockResolvedValue([]);

        await createTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(mkdir).toHaveBeenCalled();
        expect(writeFile).toHaveBeenCalled();
        expect(jsonSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            status: 'in_progress',
            milestone: 'delegated',
          })
        );
      });

      it('should create task file without sessionName in open folder', async () => {
        mockReq.body!.sessionName = undefined;
        (existsSync as jest.Mock<any>).mockReturnValue(false);
        (mkdir as jest.Mock<any>).mockResolvedValue(undefined);
        (writeFile as jest.Mock<any>).mockResolvedValue(undefined);

        await createTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(jsonSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            status: 'open',
          })
        );
      });

      it('should use default priority when not provided', async () => {
        mockReq.body!.priority = undefined;
        (existsSync as jest.Mock<any>).mockReturnValue(false);
        (mkdir as jest.Mock<any>).mockResolvedValue(undefined);
        (writeFile as jest.Mock<any>).mockResolvedValue(undefined);
        mockStorageService.getProjects.mockResolvedValue([]);

        await createTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(jsonSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
          })
        );
      });

      it('should use default milestone when not provided', async () => {
        mockReq.body!.milestone = undefined;
        (existsSync as jest.Mock<any>).mockReturnValue(false);
        (mkdir as jest.Mock<any>).mockResolvedValue(undefined);
        (writeFile as jest.Mock<any>).mockResolvedValue(undefined);
        mockStorageService.getProjects.mockResolvedValue([]);

        await createTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(jsonSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            milestone: 'delegated',
          })
        );
      });
    });

    describe('Error handling', () => {
      it('should return 500 when file creation fails', async () => {
        (existsSync as jest.Mock<any>).mockReturnValue(false);
        (mkdir as jest.Mock<any>).mockRejectedValue(new Error('Disk full'));

        await createTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(500);
        expect(jsonSpy).toHaveBeenCalledWith({
          success: false,
          error: 'Failed to create task',
        });
      });
    });
  });

  describe('Helper function tests', () => {
    describe('Path regex validation', () => {
      const testCases = [
        {
          name: 'should NOT match project with dashes using CURRENT BROKEN regex',
          path: '/Users/yellowsunhy/Desktop/projects/justslash/gas-vibe-coder/.crewly/tasks/m0_initial_tasks/open/01_create_project_requirements_document.md',
          expectedMatch: null,
          shouldMatch: false,
          regex: /\/([^\/]+)\.crewly/, // Current broken regex
        },
        {
          name: 'should match project with dashes using FIXED regex',
          path: '/Users/yellowsunhy/Desktop/projects/justslash/gas-vibe-coder/.crewly/tasks/m0_initial_tasks/open/01_create_project_requirements_document.md',
          expectedMatch: 'gas-vibe-coder',
          shouldMatch: true,
          regex: /\/([^\/]+)\/\.crewly/, // Fixed regex
        },
        {
          name: 'should match project with underscores using FIXED regex',
          path: '/Users/test/project_name_test/.crewly/tasks/open/task.md',
          expectedMatch: 'project_name_test',
          shouldMatch: true,
          regex: /\/([^\/]+)\/\.crewly/,
        },
        {
          name: 'should match simple project name using FIXED regex',
          path: '/Users/test/myproject/.crewly/tasks/open/task.md',
          expectedMatch: 'myproject',
          shouldMatch: true,
          regex: /\/([^\/]+)\/\.crewly/,
        },
        {
          name: 'should not match when .crewly is missing',
          path: '/Users/test/project/tasks/open/task.md',
          expectedMatch: null,
          shouldMatch: false,
          regex: /\/([^\/]+)\/\.crewly/,
        },
        {
          name: 'should match project with numbers using FIXED regex',
          path: '/Users/test/project123/.crewly/tasks/open/task.md',
          expectedMatch: 'project123',
          shouldMatch: true,
          regex: /\/([^\/]+)\/\.crewly/,
        },
        {
          name: 'should match project with mixed characters using FIXED regex',
          path: '/Users/test/my-project_v2/.crewly/tasks/open/task.md',
          expectedMatch: 'my-project_v2',
          shouldMatch: true,
          regex: /\/([^\/]+)\/\.crewly/,
        },
      ];

      testCases.forEach(({ name, path, expectedMatch, shouldMatch, regex }) => {
        it(name, () => {
          const match = path.match(regex);

          if (shouldMatch) {
            expect(match).not.toBeNull();
            expect(match![1]).toBe(expectedMatch);
          } else {
            expect(match).toBeNull();
          }
        });
      });
    });

    describe('parseTaskInfo function simulation', () => {
      it('should extract title from markdown content', () => {
        const content = '# Test Task Title\n## Task Information\n- **Target Role**: developer';
        const fileName = 'test.md';

        // Simulate parseTaskInfo logic
        const lines = content.split('\n');
        const info: any = { fileName };

        const titleMatch = lines.find((line) => line.startsWith('# '));
        if (titleMatch) {
          info.title = titleMatch.substring(2).trim();
        }

        expect(info.title).toBe('Test Task Title');
        expect(info.fileName).toBe(fileName);
      });

      it('should extract target role from task information', () => {
        const content = '# Test Task\n## Task Information\n- **Target Role**: frontend-developer\n- **Estimated Delay**: 30 minutes';
        const lines = content.split('\n');
        const info: any = {};

        const targetRoleMatch = lines.find((line) => line.includes('**Target Role**:'));
        if (targetRoleMatch) {
          info.targetRole = targetRoleMatch.split('**Target Role**:')[1]?.trim();
        }

        expect(info.targetRole).toBe('frontend-developer');
      });

      it('should extract estimated delay from task information', () => {
        const content = '# Test Task\n## Task Information\n- **Target Role**: developer\n- **Estimated Delay**: 45 minutes';
        const lines = content.split('\n');
        const info: any = {};

        const delayMatch = lines.find((line) => line.includes('**Estimated Delay**:'));
        if (delayMatch) {
          const delayText = delayMatch.split('**Estimated Delay**:')[1]?.trim();
          info.estimatedDelay = delayText;
        }

        expect(info.estimatedDelay).toBe('45 minutes');
      });

      it('should handle missing information gracefully', () => {
        const content = 'Some content without proper headers';
        const fileName = 'test.md';
        const lines = content.split('\n');
        const info: any = { fileName };

        const titleMatch = lines.find((line) => line.startsWith('# '));
        if (titleMatch) {
          info.title = titleMatch.substring(2).trim();
        }

        expect(info.title).toBeUndefined();
        expect(info.fileName).toBe(fileName);
      });
    });
  });

  describe('completeTask with output validation', () => {
    let mockReq: Partial<Request>;
    let mockRes: any;
    let jsonSpy: jest.Mock<any>;
    let statusSpy: jest.Mock<any>;

    const validTaskPath = '/project/.crewly/tasks/delegated/in_progress/task.md';

    beforeEach(() => {
      jsonSpy = jest.fn<any>();
      statusSpy = jest.fn<any>().mockReturnValue({ json: jsonSpy });
      mockRes = { status: statusSpy, json: jsonSpy };
      mockReq = {
        body: {
          taskPath: validTaskPath,
          sessionName: 'dev-1',
        },
      };
      jest.clearAllMocks();

      // Default: task exists and is in in_progress
      (existsSync as jest.Mock<any>).mockReturnValue(true);
      mockTaskTrackingService.getAllInProgressTasks.mockResolvedValue([]);
    });

    it('should complete task without schema (backward compatible)', async () => {
      (readFile as jest.Mock<any>).mockResolvedValue('# Task\n\nNo schema here');
      mockExtractSchemaFromMarkdown.mockReturnValue(null);
      (basename as jest.Mock<any>).mockReturnValue('task.md');
      (dirname as jest.Mock<any>).mockReturnValue('/project/.crewly/tasks/delegated/done');
      (writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      await completeTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          status: 'done',
        })
      );
    });

    it('should reject completion when schema exists but no output provided', async () => {
      const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
      (readFile as jest.Mock<any>).mockResolvedValue('# Task\n\n## Output Schema\n\n```json\n{}\n```');
      mockExtractSchemaFromMarkdown.mockReturnValue(schema);

      await completeTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(statusSpy).toHaveBeenCalledWith(200);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Task requires structured output but none was provided',
        })
      );
    });

    it('should reject completion when output size exceeds limit', async () => {
      const schema = { type: 'object', properties: { summary: { type: 'string' } } };
      mockReq.body!.output = { summary: 'too big' };
      (readFile as jest.Mock<any>).mockResolvedValue('# Task with schema');
      mockExtractSchemaFromMarkdown.mockReturnValue(schema);
      mockValidateOutputSize.mockReturnValue({ valid: false, sizeBytes: 2_000_000, error: 'Output size 2000000 bytes exceeds maximum' });

      await completeTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(statusSpy).toHaveBeenCalledWith(200);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Output size exceeds maximum',
        })
      );
    });

    it('should return validation errors with retry count when output is invalid', async () => {
      const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
      mockReq.body!.output = { wrong: 'field' };
      (readFile as jest.Mock<any>).mockResolvedValue('# Task with schema');
      mockExtractSchemaFromMarkdown.mockReturnValue(schema);
      mockValidateOutputSize.mockReturnValue({ valid: true, sizeBytes: 50 });
      mockValidate.mockReturnValue({ valid: false, errors: ['Missing: summary'] });
      mockExtractRetryInfoFromMarkdown.mockReturnValue(null);
      mockGenerateRetryMarkdown.mockReturnValue('\n\n## Output Validation Retry Info\n\n```json\n{}\n```\n');
      (writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      await completeTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(statusSpy).toHaveBeenCalledWith(200);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          validationFailed: true,
          retryCount: 1,
          maxRetries: TASK_OUTPUT_CONSTANTS.MAX_RETRIES,
        })
      );
    });

    it('should move task to blocked when max retries exceeded', async () => {
      const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
      mockReq.body!.output = { wrong: 'field' };
      (readFile as jest.Mock<any>).mockResolvedValue('# Task with schema');
      mockExtractSchemaFromMarkdown.mockReturnValue(schema);
      mockValidateOutputSize.mockReturnValue({ valid: true, sizeBytes: 50 });
      mockValidate.mockReturnValue({ valid: false, errors: ['Missing: summary'] });
      // Already at max retries
      mockExtractRetryInfoFromMarkdown.mockReturnValue({
        retryCount: TASK_OUTPUT_CONSTANTS.MAX_RETRIES,
        maxRetries: TASK_OUTPUT_CONSTANTS.MAX_RETRIES,
        lastErrors: ['Previous error'],
        lastAttemptAt: '2026-01-01T00:00:00.000Z',
      });
      (dirname as jest.Mock<any>).mockReturnValue('/project/.crewly/tasks/delegated/blocked');
      (writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      await completeTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(statusSpy).toHaveBeenCalledWith(200);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          validationFailed: true,
          maxRetriesExceeded: true,
        })
      );
    });

    it('should complete with validated output and store output file', async () => {
      const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
      mockReq.body!.output = { summary: 'Done' };
      (readFile as jest.Mock<any>).mockResolvedValue('# Task with schema');
      mockExtractSchemaFromMarkdown.mockReturnValue(schema);
      mockValidateOutputSize.mockReturnValue({ valid: true, sizeBytes: 50 });
      mockValidate.mockReturnValue({ valid: true, errors: [] });
      (dirname as jest.Mock<any>).mockReturnValue('/project/.crewly/tasks/delegated/done');
      (basename as jest.Mock<any>).mockReturnValue('task.md');
      (writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      await completeTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          status: 'done',
          outputPath: expect.stringContaining('.output.json'),
        })
      );
      // Should have written both the task file and the output file
      expect(writeFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('getTaskOutput', () => {
    let mockReq: Partial<Request>;
    let mockRes: any;
    let jsonSpy: jest.Mock<any>;
    let statusSpy: jest.Mock<any>;

    beforeEach(() => {
      jsonSpy = jest.fn<any>();
      statusSpy = jest.fn<any>().mockReturnValue({ json: jsonSpy });
      mockRes = { status: statusSpy, json: jsonSpy };
      mockReq = {
        body: {
          taskPath: '/project/.crewly/tasks/delegated/done/task.md',
        },
      };
      jest.clearAllMocks();
    });

    it('should return 400 when taskPath is missing', async () => {
      mockReq.body!.taskPath = undefined;

      await getTaskOutput.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(jsonSpy).toHaveBeenCalledWith({
        success: false,
        error: 'taskPath is required',
      });
    });

    it('should return success=false when output file does not exist', async () => {
      (existsSync as jest.Mock<any>).mockReturnValue(false);

      await getTaskOutput.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(statusSpy).toHaveBeenCalledWith(200);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'No output file found for this task',
        })
      );
    });

    it('should return output data when file exists', async () => {
      const outputData = { output: { summary: 'Done' }, producedAt: '2026-01-01T00:00:00.000Z', sessionName: 'dev-1' };
      (existsSync as jest.Mock<any>).mockReturnValue(true);
      (readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(outputData));

      await getTaskOutput.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: outputData,
        })
      );
    });
  });

  describe('addMonitoring', () => {
    it('should return 400 when sessionName is missing', async () => {
      mockRequest.body = { scheduleIds: ['sched-1'], subscriptionIds: [] };

      await addMonitoring.call(fullMockApiController, mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: 'sessionName is required' })
      );
    });

    it('should return 400 when no monitoring IDs are provided', async () => {
      mockRequest.body = { sessionName: 'agent-joe', scheduleIds: [], subscriptionIds: [] };

      await addMonitoring.call(fullMockApiController, mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: 'At least one scheduleId or subscriptionId is required' })
      );
    });

    it('should link monitoring IDs to the most recent task for the session', async () => {
      const tasks = [
        { id: 'task-old', taskName: 'Old Task', assignedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'task-new', taskName: 'New Task', assignedAt: '2026-01-02T00:00:00.000Z' },
      ];
      mockTaskTrackingService.getTasksBySessionName.mockResolvedValue(tasks);
      mockTaskTrackingService.addMonitoringIds.mockResolvedValue(undefined);
      mockRequest.body = {
        sessionName: 'agent-joe',
        scheduleIds: ['sched-1'],
        subscriptionIds: ['sub-1'],
      };

      await addMonitoring.call(fullMockApiController, mockRequest as Request, mockResponse as Response);

      expect(mockTaskTrackingService.addMonitoringIds).toHaveBeenCalledWith(
        'task-new', ['sched-1'], ['sub-1']
      );
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, taskId: 'task-new' })
      );
    });

    it('should handle no tracked tasks gracefully', async () => {
      mockTaskTrackingService.getTasksBySessionName.mockResolvedValue([]);
      mockRequest.body = {
        sessionName: 'agent-joe',
        scheduleIds: ['sched-1'],
        subscriptionIds: [],
      };

      await addMonitoring.call(fullMockApiController, mockRequest as Request, mockResponse as Response);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, message: expect.stringContaining('No tracked task found') })
      );
    });
  });

  describe('completeTask with monitoring cleanup', () => {
    const mockEventBus = {
      unsubscribe: jest.fn<any>(),
    };

    beforeEach(() => {
      setEventBusServiceForTaskCleanup(mockEventBus as any);
    });

    afterEach(() => {
      setEventBusServiceForTaskCleanup(null as any);
    });

    it('should clean up schedules and subscriptions when completing a task', async () => {
      const trackedTask = {
        id: 'tracked-1',
        taskFilePath: '/project/.crewly/tasks/delegated/in_progress/test_task.md',
        scheduleIds: ['sched-1', 'sched-2'],
        subscriptionIds: ['sub-1'],
      };

      mockRequest.body = {
        taskPath: '/project/.crewly/tasks/delegated/in_progress/test_task.md',
        sessionName: 'session-123',
      };

      (existsSync as jest.Mock<any>).mockReturnValue(true);
      (readFile as jest.Mock<any>).mockResolvedValue('# Task\nSome content');
      (writeFile as jest.Mock<any>).mockResolvedValue(undefined);
      (mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (basename as jest.Mock<any>).mockReturnValue('test_task.md');
      (dirname as jest.Mock<any>).mockReturnValue('/project/.crewly/tasks/delegated/done');
      mockExtractSchemaFromMarkdown.mockReturnValue(null);
      mockTaskTrackingService.getAllInProgressTasks.mockResolvedValue([trackedTask]);
      mockTaskTrackingService.removeTask.mockResolvedValue(undefined);

      await completeTask.call(fullMockApiController, mockRequest as Request, mockResponse as Response);

      expect(mockSchedulerService.cancelCheck).toHaveBeenCalledWith('sched-1');
      expect(mockSchedulerService.cancelCheck).toHaveBeenCalledWith('sched-2');
      expect(mockEventBus.unsubscribe).toHaveBeenCalledWith('sub-1');
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          monitoringCleanup: { cancelledSchedules: 2, unsubscribedEvents: 1 },
        })
      );
    });

    it('should complete task even when no monitoring IDs exist', async () => {
      const trackedTask = {
        id: 'tracked-1',
        taskFilePath: '/project/.crewly/tasks/delegated/in_progress/test_task.md',
      };

      mockRequest.body = {
        taskPath: '/project/.crewly/tasks/delegated/in_progress/test_task.md',
        sessionName: 'session-123',
      };

      (existsSync as jest.Mock<any>).mockReturnValue(true);
      (readFile as jest.Mock<any>).mockResolvedValue('# Task\nSome content');
      (writeFile as jest.Mock<any>).mockResolvedValue(undefined);
      (mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (basename as jest.Mock<any>).mockReturnValue('test_task.md');
      (dirname as jest.Mock<any>).mockReturnValue('/project/.crewly/tasks/delegated/done');
      mockExtractSchemaFromMarkdown.mockReturnValue(null);
      mockTaskTrackingService.getAllInProgressTasks.mockResolvedValue([trackedTask]);
      mockTaskTrackingService.removeTask.mockResolvedValue(undefined);

      await completeTask.call(fullMockApiController, mockRequest as Request, mockResponse as Response);

      expect(mockSchedulerService.cancelCheck).not.toHaveBeenCalled();
      expect(mockEventBus.unsubscribe).not.toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          monitoringCleanup: { cancelledSchedules: 0, unsubscribedEvents: 0 },
        })
      );
    });

    it('should handle cleanup errors gracefully without failing completion', async () => {
      const trackedTask = {
        id: 'tracked-1',
        taskFilePath: '/project/.crewly/tasks/delegated/in_progress/test_task.md',
        scheduleIds: ['sched-bad'],
        subscriptionIds: ['sub-bad'],
      };

      mockRequest.body = {
        taskPath: '/project/.crewly/tasks/delegated/in_progress/test_task.md',
        sessionName: 'session-123',
      };

      (existsSync as jest.Mock<any>).mockReturnValue(true);
      (readFile as jest.Mock<any>).mockResolvedValue('# Task\nSome content');
      (writeFile as jest.Mock<any>).mockResolvedValue(undefined);
      (mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (basename as jest.Mock<any>).mockReturnValue('test_task.md');
      (dirname as jest.Mock<any>).mockReturnValue('/project/.crewly/tasks/delegated/done');
      mockExtractSchemaFromMarkdown.mockReturnValue(null);
      mockTaskTrackingService.getAllInProgressTasks.mockResolvedValue([trackedTask]);
      mockTaskTrackingService.removeTask.mockResolvedValue(undefined);
      mockSchedulerService.cancelCheck.mockImplementation(() => { throw new Error('Schedule not found'); });
      mockEventBus.unsubscribe.mockImplementation(() => { throw new Error('Subscription not found'); });

      await completeTask.call(fullMockApiController, mockRequest as Request, mockResponse as Response);

      // Task should still complete successfully even if cleanup fails
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );
    });
  });

  describe('completeTasksBySession', () => {
    let mockReq: Partial<Request>;
    let mockRes: any;
    let jsonSpy: jest.Mock<any>;
    let statusSpy: jest.Mock<any>;

    beforeEach(() => {
      jsonSpy = jest.fn<any>();
      statusSpy = jest.fn<any>().mockReturnValue({ json: jsonSpy });

      mockRes = {
        status: statusSpy,
        json: jsonSpy,
      };
    });

    it('returns 400 when sessionName is missing', async () => {
      mockReq = { body: {} };

      await completeTasksBySession.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: 'sessionName is required' })
      );
    });

    it('returns success with 0 completed when no tasks found', async () => {
      mockReq = { body: { sessionName: 'dev-agent-1' } };
      mockTaskTrackingService.getTasksBySessionName.mockResolvedValue([]);

      await completeTasksBySession.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          completedCount: 0,
          completedTasks: [],
        })
      );
    });

    it('completes assigned tasks and removes them from tracking', async () => {
      const tasks = [
        {
          id: 'task-1',
          taskName: 'Implement auth',
          assignedSessionName: 'dev-agent-1',
          status: 'assigned',
          assignedAt: '2026-02-27T00:00:00Z',
        },
        {
          id: 'task-2',
          taskName: 'Write tests',
          assignedSessionName: 'dev-agent-1',
          status: 'active',
          assignedAt: '2026-02-27T01:00:00Z',
        },
      ];

      mockReq = { body: { sessionName: 'dev-agent-1' } };
      mockTaskTrackingService.getTasksBySessionName.mockResolvedValue(tasks);
      mockTaskTrackingService.removeTask.mockResolvedValue(undefined);

      await completeTasksBySession.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(mockTaskTrackingService.removeTask).toHaveBeenCalledTimes(2);
      expect(mockTaskTrackingService.removeTask).toHaveBeenCalledWith('task-1');
      expect(mockTaskTrackingService.removeTask).toHaveBeenCalledWith('task-2');
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          completedCount: 2,
          completedTasks: ['Implement auth', 'Write tests'],
        })
      );
    });

    it('skips tasks that are not assigned or active', async () => {
      const tasks = [
        {
          id: 'task-1',
          taskName: 'Active task',
          assignedSessionName: 'dev-agent-1',
          status: 'assigned',
          assignedAt: '2026-02-27T00:00:00Z',
        },
        {
          id: 'task-2',
          taskName: 'Blocked task',
          assignedSessionName: 'dev-agent-1',
          status: 'blocked',
          assignedAt: '2026-02-27T01:00:00Z',
        },
        {
          id: 'task-3',
          taskName: 'Completed task',
          assignedSessionName: 'dev-agent-1',
          status: 'completed',
          assignedAt: '2026-02-27T02:00:00Z',
        },
      ];

      mockReq = { body: { sessionName: 'dev-agent-1' } };
      mockTaskTrackingService.getTasksBySessionName.mockResolvedValue(tasks);
      mockTaskTrackingService.removeTask.mockResolvedValue(undefined);

      await completeTasksBySession.call(fullMockApiController, mockReq as Request, mockRes as Response);

      // Only task-1 (assigned) should be completed
      expect(mockTaskTrackingService.removeTask).toHaveBeenCalledTimes(1);
      expect(mockTaskTrackingService.removeTask).toHaveBeenCalledWith('task-1');
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          completedCount: 1,
          completedTasks: ['Active task'],
        })
      );
    });

    it('cleans up monitoring resources for completed tasks', async () => {
      const mockEventBus = {
        unsubscribe: jest.fn<any>(),
      };
      setEventBusServiceForTaskCleanup(mockEventBus as any);

      const tasks = [
        {
          id: 'task-1',
          taskName: 'Monitored task',
          assignedSessionName: 'dev-agent-1',
          status: 'assigned',
          assignedAt: '2026-02-27T00:00:00Z',
          scheduleIds: ['sched-1'],
          subscriptionIds: ['sub-1'],
        },
      ];

      mockReq = { body: { sessionName: 'dev-agent-1' } };
      mockTaskTrackingService.getTasksBySessionName.mockResolvedValue(tasks);
      mockTaskTrackingService.removeTask.mockResolvedValue(undefined);

      await completeTasksBySession.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(mockSchedulerService.cancelCheck).toHaveBeenCalledWith('sched-1');
      expect(mockEventBus.unsubscribe).toHaveBeenCalledWith('sub-1');
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          monitoringCleanup: {
            cancelledSchedules: 1,
            unsubscribedEvents: 1,
          },
        })
      );

      // Clean up
      setEventBusServiceForTaskCleanup(null as any);
    });

    it('moves task file from in_progress/ to done/ when completing', async () => {
      const tasks = [
        {
          id: 'task-move',
          taskName: 'Move me',
          assignedSessionName: 'dev-agent-1',
          status: 'assigned',
          assignedAt: '2026-02-27T00:00:00Z',
          taskFilePath: '/project/.crewly/tasks/sprint-1/in_progress/task-1.md',
        },
      ];

      mockReq = { body: { sessionName: 'dev-agent-1' } };
      mockTaskTrackingService.getTasksBySessionName.mockResolvedValue(tasks);
      mockTaskTrackingService.removeTask.mockResolvedValue(undefined);
      (existsSync as jest.Mock<any>).mockReturnValue(true);
      (readFile as jest.Mock<any>).mockResolvedValue('# Task 1\nSome content');
      (writeFile as jest.Mock<any>).mockResolvedValue(undefined);
      (mkdir as jest.Mock<any>).mockResolvedValue(undefined);

      await completeTasksBySession.call(fullMockApiController, mockReq as Request, mockRes as Response);

      // Should write to done/ path
      expect(writeFile).toHaveBeenCalledWith(
        '/project/.crewly/tasks/sprint-1/done/task-1.md',
        expect.any(String),
        'utf-8'
      );

      // Should delete from in_progress/
      const { unlink } = await import('fs/promises');
      expect(unlink).toHaveBeenCalledWith(
        '/project/.crewly/tasks/sprint-1/in_progress/task-1.md'
      );

      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          completedCount: 1,
        })
      );
    });

    it('continues completing other tasks when one fails', async () => {
      const tasks = [
        {
          id: 'task-1',
          taskName: 'Failing task',
          assignedSessionName: 'dev-agent-1',
          status: 'assigned',
          assignedAt: '2026-02-27T00:00:00Z',
        },
        {
          id: 'task-2',
          taskName: 'Success task',
          assignedSessionName: 'dev-agent-1',
          status: 'assigned',
          assignedAt: '2026-02-27T01:00:00Z',
        },
      ];

      mockReq = { body: { sessionName: 'dev-agent-1' } };
      mockTaskTrackingService.getTasksBySessionName.mockResolvedValue(tasks);
      mockTaskTrackingService.removeTask
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce(undefined);

      await completeTasksBySession.call(fullMockApiController, mockReq as Request, mockRes as Response);

      // Second task should still complete
      expect(mockTaskTrackingService.removeTask).toHaveBeenCalledTimes(2);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          completedCount: 1,
          completedTasks: ['Success task'],
        })
      );
    });
  });

  describe('#174: scoreTask', () => {
    it('should score a task successfully', async () => {
      const taskData = {
        tasks: [{ id: 'task-1', status: 'completed', taskName: 'Test' }],
        lastUpdated: '2026-01-01',
        version: '1.0.0',
      };
      mockTaskTrackingService.loadTaskData.mockResolvedValue(taskData);
      mockTaskTrackingService.saveTaskData.mockResolvedValue(undefined);

      const mockReq = { body: { taskId: 'task-1', qualityScore: 85, scoredBy: 'auditor-session' } } as Partial<Request>;
      const jsonSpy = jest.fn<any>();
      const mockRes = { status: jest.fn<any>().mockReturnThis(), json: jsonSpy } as Partial<Response>;

      await scoreTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, qualityScore: 85 })
      );
      expect(mockTaskTrackingService.saveTaskData).toHaveBeenCalled();
      expect(taskData.tasks[0]).toHaveProperty('qualityScore', 85);
    });

    it('should reject invalid qualityScore', async () => {
      const mockReq = { body: { taskId: 'task-1', qualityScore: 150 } } as Partial<Request>;
      const statusSpy = jest.fn<any>().mockReturnThis();
      const jsonSpy = jest.fn<any>();
      const mockRes = { status: statusSpy, json: jsonSpy } as Partial<Response>;

      await scoreTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('qualityScore') })
      );
    });

    it('should reject missing taskId', async () => {
      const mockReq = { body: { qualityScore: 80 } } as Partial<Request>;
      const statusSpy = jest.fn<any>().mockReturnThis();
      const jsonSpy = jest.fn<any>();
      const mockRes = { status: statusSpy, json: jsonSpy } as Partial<Response>;

      await scoreTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('should handle task not found gracefully', async () => {
      mockTaskTrackingService.loadTaskData.mockResolvedValue({
        tasks: [],
        lastUpdated: '2026-01-01',
        version: '1.0.0',
      });

      const mockReq = { body: { taskId: 'nonexistent', qualityScore: 70 } } as Partial<Request>;
      const jsonSpy = jest.fn<any>();
      const mockRes = { status: jest.fn<any>().mockReturnThis(), json: jsonSpy } as Partial<Response>;

      await scoreTask.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, message: expect.stringContaining('already completed') })
      );
    });
  });

  describe('saveWorkingNotes', () => {
    it('should save working notes successfully', async () => {
      mockTaskTrackingService.updateWorkingNotes.mockResolvedValue(undefined);

      const mockReq = { body: { taskId: 'task-1', sessionName: 'session-abc', notes: 'current state of work' } } as Partial<Request>;
      const jsonSpy = jest.fn<any>();
      const mockRes = { status: jest.fn<any>().mockReturnThis(), json: jsonSpy } as Partial<Response>;

      await saveWorkingNotes.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, message: 'Working notes saved' })
      );
      expect(mockTaskTrackingService.updateWorkingNotes).toHaveBeenCalledWith('task-1', 'session-abc', 'current state of work');
    });

    it('should reject missing taskId', async () => {
      const mockReq = { body: { sessionName: 'session-abc', notes: 'notes' } } as Partial<Request>;
      const statusSpy = jest.fn<any>().mockReturnThis();
      const jsonSpy = jest.fn<any>();
      const mockRes = { status: statusSpy, json: jsonSpy } as Partial<Response>;

      await saveWorkingNotes.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: 'taskId is required' })
      );
    });

    it('should reject missing sessionName', async () => {
      const mockReq = { body: { taskId: 'task-1', notes: 'notes' } } as Partial<Request>;
      const statusSpy = jest.fn<any>().mockReturnThis();
      const jsonSpy = jest.fn<any>();
      const mockRes = { status: statusSpy, json: jsonSpy } as Partial<Response>;

      await saveWorkingNotes.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('should reject missing notes', async () => {
      const mockReq = { body: { taskId: 'task-1', sessionName: 'session-abc' } } as Partial<Request>;
      const statusSpy = jest.fn<any>().mockReturnThis();
      const jsonSpy = jest.fn<any>();
      const mockRes = { status: statusSpy, json: jsonSpy } as Partial<Response>;

      await saveWorkingNotes.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('should handle service errors gracefully', async () => {
      mockTaskTrackingService.updateWorkingNotes.mockRejectedValue(new Error('Task not found'));

      const mockReq = { body: { taskId: 'bad-task', sessionName: 'session-abc', notes: 'notes' } } as Partial<Request>;
      const statusSpy = jest.fn<any>().mockReturnThis();
      const jsonSpy = jest.fn<any>();
      const mockRes = { status: statusSpy, json: jsonSpy } as Partial<Response>;

      await saveWorkingNotes.call(fullMockApiController, mockReq as Request, mockRes as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: 'Task not found' })
      );
    });
  });
});
