import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Request, Response } from 'express';
import * as tasksHandlers from './tasks.controller.js';
import type { ApiContext } from '../types.js';

jest.mock('../../services/index.js', () => ({
  TaskService: jest.fn().mockImplementation(() => ({
    getAllTasks: jest.fn(),
    getMilestones: jest.fn(),
    getTasksByStatus: jest.fn(),
    getTasksByMilestone: jest.fn()
  }))
}));

describe('Tasks Handlers', () => {
  let mockApiContext: Partial<ApiContext>;
  let mockRequest: Partial<Request>;
  let mockResponse: any;
  let mockStorageService: any;
  let mockTaskService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTaskService = {
      getAllTasks: jest.fn(),
      getMilestones: jest.fn(),
      getTasksByStatus: jest.fn(),
      getTasksByMilestone: jest.fn()
    };
    const { TaskService } = require('../../services/index.js');
    (TaskService as jest.Mock).mockImplementation(() => mockTaskService);

    mockStorageService = {
      getProjects: jest.fn<any>()
    };

    mockApiContext = {
      storageService: mockStorageService
    } as any;

    mockRequest = {
      params: {
        projectId: 'project-1',
        status: 'in-progress',
        milestoneId: 'milestone-1'
      },
      body: {},
      query: {}
    };

    mockResponse = {
      json: jest.fn<any>(),
      status: jest.fn<any>().mockReturnThis()
    };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('getAllTasks', () => {
    it('should get all tasks successfully', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };
      const mockTasks = [
        { id: 'task-1', title: 'Task 1', status: 'todo' },
        { id: 'task-2', title: 'Task 2', status: 'in-progress' }
      ];

      mockStorageService.getProjects.mockResolvedValue([mockProject]);
      mockTaskService.getAllTasks.mockResolvedValue(mockTasks);

      await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.getProjects).toHaveBeenCalled();
      expect(mockTaskService.getAllTasks).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: mockTasks
      });
    });

    it('should return 400 when project ID is missing', async () => {
      mockRequest.params = {};

      await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Project ID is required'
      });
    });

    it('should return 404 when project not found', async () => {
      mockStorageService.getProjects.mockResolvedValue([]);

      await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Project not found'
      });
    });

    it('should gracefully degrade to 200 + warning when TaskService.getAllTasks throws', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };
      mockStorageService.getProjects.mockResolvedValue([mockProject]);
      mockTaskService.getAllTasks.mockRejectedValue(new Error('Filesystem permission denied'));

      await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).not.toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: [],
        warning: expect.stringContaining('Filesystem permission denied')
      });
    });

    it('should still return 500 when storage layer (projects.json) fails', async () => {
      mockStorageService.getProjects.mockRejectedValue(new Error('projects.json corrupt'));

      await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to fetch tasks'
      });
    });
  });

  describe('getMilestones', () => {
    it('should get milestones successfully', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };
      const mockMilestones = [
        { id: 'milestone-1', title: 'Milestone 1', dueDate: '2024-12-31' },
        { id: 'milestone-2', title: 'Milestone 2', dueDate: '2025-06-30' }
      ];

      mockStorageService.getProjects.mockResolvedValue([mockProject]);
      mockTaskService.getMilestones.mockResolvedValue(mockMilestones);

      await tasksHandlers.getMilestones.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockTaskService.getMilestones).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: mockMilestones
      });
    });

    it('should return 400 when project ID is missing', async () => {
      mockRequest.params = {};

      await tasksHandlers.getMilestones.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Project ID is required'
      });
    });

    it('should return 404 when project not found', async () => {
      mockStorageService.getProjects.mockResolvedValue([]);

      await tasksHandlers.getMilestones.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Project not found'
      });
    });

    it('should gracefully degrade to 200 + warning when TaskService.getMilestones throws', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };
      mockStorageService.getProjects.mockResolvedValue([mockProject]);
      mockTaskService.getMilestones.mockRejectedValue(new Error('milestone read failed'));

      await tasksHandlers.getMilestones.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).not.toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: [],
        warning: expect.stringContaining('milestone read failed')
      });
    });
  });

  describe('getTasksByStatus', () => {
    it('should get tasks by status successfully', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };
      const mockTasks = [
        { id: 'task-1', title: 'Task 1', status: 'in-progress' },
        { id: 'task-2', title: 'Task 2', status: 'in-progress' }
      ];

      mockStorageService.getProjects.mockResolvedValue([mockProject]);
      mockTaskService.getTasksByStatus.mockResolvedValue(mockTasks);

      await tasksHandlers.getTasksByStatus.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockTaskService.getTasksByStatus).toHaveBeenCalledWith('in-progress');
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: mockTasks
      });
    });

    it('should return 400 when project ID is missing', async () => {
      mockRequest.params = { status: 'in-progress' };

      await tasksHandlers.getTasksByStatus.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Project ID is required'
      });
    });

    it('should return 404 when project not found', async () => {
      mockStorageService.getProjects.mockResolvedValue([]);

      await tasksHandlers.getTasksByStatus.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Project not found'
      });
    });

    it('should gracefully degrade to 200 + warning when TaskService.getTasksByStatus throws', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };
      mockStorageService.getProjects.mockResolvedValue([mockProject]);
      mockTaskService.getTasksByStatus.mockRejectedValue(new Error('Service error'));

      await tasksHandlers.getTasksByStatus.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).not.toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: [],
        warning: expect.stringContaining('Service error')
      });
    });
  });

  describe('getTasksByMilestone', () => {
    it('should get tasks by milestone successfully', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };
      const mockTasks = [
        { id: 'task-1', title: 'Task 1', milestoneId: 'milestone-1' },
        { id: 'task-2', title: 'Task 2', milestoneId: 'milestone-1' }
      ];

      mockStorageService.getProjects.mockResolvedValue([mockProject]);
      mockTaskService.getTasksByMilestone.mockResolvedValue(mockTasks);

      await tasksHandlers.getTasksByMilestone.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockTaskService.getTasksByMilestone).toHaveBeenCalledWith('milestone-1');
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: mockTasks
      });
    });

    it('should return 400 when project ID is missing', async () => {
      mockRequest.params = { milestoneId: 'milestone-1' };

      await tasksHandlers.getTasksByMilestone.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Project ID is required'
      });
    });

    it('should return 404 when project not found', async () => {
      mockStorageService.getProjects.mockResolvedValue([]);

      await tasksHandlers.getTasksByMilestone.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Project not found'
      });
    });

    it('should gracefully degrade to 200 + warning when TaskService.getTasksByMilestone throws', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };
      mockStorageService.getProjects.mockResolvedValue([mockProject]);
      mockTaskService.getTasksByMilestone.mockRejectedValue(new Error('Service error'));

      await tasksHandlers.getTasksByMilestone.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).not.toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: [],
        warning: expect.stringContaining('Service error')
      });
    });
  });

  describe('getProjectTasksStatus', () => {
    it('should get project task status summary successfully', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };
      const mockTasks = [
        { id: 'task-1', title: 'Task 1', status: 'todo' },
        { id: 'task-2', title: 'Task 2', status: 'in-progress' },
        { id: 'task-3', title: 'Task 3', status: 'done' },
        { id: 'task-4', title: 'Task 4', status: 'done' }
      ];
      const mockMilestones = [
        { id: 'milestone-1', title: 'Milestone 1' }
      ];

      mockStorageService.getProjects.mockResolvedValue([mockProject]);
      mockTaskService.getAllTasks.mockResolvedValue(mockTasks);
      mockTaskService.getMilestones.mockResolvedValue(mockMilestones);

      await tasksHandlers.getProjectTasksStatus.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockTaskService.getAllTasks).toHaveBeenCalled();
      expect(mockTaskService.getMilestones).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          totals: {
            all: 4,
            todo: 1,
            'in-progress': 1,
            done: 2
          },
          milestones: mockMilestones
        }
      });
    });

    it('should return 400 when project ID is missing', async () => {
      mockRequest.params = {};

      await tasksHandlers.getProjectTasksStatus.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Project ID is required'
      });
    });

    it('should return 404 when project not found', async () => {
      mockStorageService.getProjects.mockResolvedValue([]);

      await tasksHandlers.getProjectTasksStatus.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Project not found'
      });
    });

    it('should handle empty task lists', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };

      mockStorageService.getProjects.mockResolvedValue([mockProject]);
      mockTaskService.getAllTasks.mockResolvedValue([]);
      mockTaskService.getMilestones.mockResolvedValue([]);

      await tasksHandlers.getProjectTasksStatus.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          totals: { all: 0 },
          milestones: []
        }
      });
    });

    it('should gracefully degrade to 200 + warning when TaskService throws (status-summary shape)', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };
      mockStorageService.getProjects.mockResolvedValue([mockProject]);
      mockTaskService.getAllTasks.mockRejectedValue(new Error('Service error'));

      await tasksHandlers.getProjectTasksStatus.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).not.toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: { totals: { all: 0 }, milestones: [] },
        warning: expect.stringContaining('Service error')
      });
    });
  });

  describe('Error handling', () => {
    it('should still 500 when storage layer throws synchronously (catastrophic projects.json failure)', async () => {
      mockStorageService.getProjects.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to fetch tasks'
      });
    });

    it('should gracefully degrade when TaskService constructor throws', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };
      mockStorageService.getProjects.mockResolvedValue([mockProject]);

      const { TaskService } = require('../../services/index.js');
      TaskService.mockImplementation(() => {
        throw new Error('Service initialization error');
      });

      await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Constructor failures are part of the TaskService boundary — they
      // should also be treated as graceful degradation, not 500.
      expect(mockResponse.status).not.toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: [],
        warning: expect.stringContaining('Service initialization error')
      });
    });
  });

  describe('Context preservation', () => {
    it('should preserve context when handling tasks', async () => {
      const contextAwareController = {
        storageService: {
          getProjects: jest.fn<any>().mockResolvedValue([{ id: 'project-1', path: '/test/path' }])
        }
      } as any;

      mockTaskService.getAllTasks.mockResolvedValue([]);

      await tasksHandlers.getAllTasks.call(
        contextAwareController,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(contextAwareController.storageService.getProjects).toHaveBeenCalled();
    });
  });

  describe('All handlers availability', () => {
    it('should have all expected handler functions', () => {
      expect(typeof tasksHandlers.getAllTasks).toBe('function');
      expect(typeof tasksHandlers.getMilestones).toBe('function');
      expect(typeof tasksHandlers.getTasksByStatus).toBe('function');
      expect(typeof tasksHandlers.getTasksByMilestone).toBe('function');
      expect(typeof tasksHandlers.getProjectTasksStatus).toBe('function');
    });

    it('should handle async operations properly', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };
      mockStorageService.getProjects.mockResolvedValue([mockProject]);
      mockTaskService.getAllTasks.mockResolvedValue([]);

      const result = await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(result).toBeUndefined();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: []
      });
    });
  });

  describe('Parameter validation', () => {
    it('should handle null or undefined project ID consistently', async () => {
      for (const projectId of [null, undefined, '']) {
        jest.clearAllMocks();
        mockRequest.params = { projectId: projectId as any };

        await tasksHandlers.getAllTasks.call(
          mockApiContext as ApiContext,
          mockRequest as Request,
          mockResponse as Response
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: 'Project ID is required'
        });
      }
    });

    it('should handle valid project IDs that do not exist', async () => {
      mockStorageService.getProjects.mockResolvedValue([
        { id: 'other-project', path: '/other/path' }
      ]);

      await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Project not found'
      });
    });
  });

  describe('Failure-mode coverage (P0 fix)', () => {
    it('warning message includes the project ID for log correlation', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };
      mockStorageService.getProjects.mockResolvedValue([mockProject]);
      mockTaskService.getAllTasks.mockRejectedValue(new Error('ENOENT: no such file'));

      await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      const callArg = mockResponse.json.mock.calls[0][0];
      expect(callArg.warning).toContain('project-1');
      expect(callArg.warning).toContain('ENOENT');
    });

    it('graceful degradation handles a non-Error thrown value (string) without crashing', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };
      mockStorageService.getProjects.mockResolvedValue([mockProject]);
      // simulate a non-Error rejection
      mockTaskService.getAllTasks.mockRejectedValue('not-an-error-instance');

      await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).not.toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: [],
        warning: expect.stringContaining('not-an-error-instance')
      });
    });

    it('all five handlers route to graceful degradation on TaskService failure', async () => {
      const mockProject = { id: 'project-1', path: '/test/path' };

      const failingHandlers: Array<[string, (req: Request, res: Response) => Promise<void>]> = [
        ['getAllTasks', tasksHandlers.getAllTasks as any],
        ['getMilestones', tasksHandlers.getMilestones as any],
        ['getTasksByStatus', tasksHandlers.getTasksByStatus as any],
        ['getTasksByMilestone', tasksHandlers.getTasksByMilestone as any],
        ['getProjectTasksStatus', tasksHandlers.getProjectTasksStatus as any],
      ];

      for (const [name, handler] of failingHandlers) {
        jest.clearAllMocks();
        mockStorageService.getProjects.mockResolvedValue([mockProject]);
        mockTaskService.getAllTasks.mockRejectedValue(new Error(`${name} boom`));
        mockTaskService.getMilestones.mockRejectedValue(new Error(`${name} boom`));
        mockTaskService.getTasksByStatus.mockRejectedValue(new Error(`${name} boom`));
        mockTaskService.getTasksByMilestone.mockRejectedValue(new Error(`${name} boom`));

        await handler.call(mockApiContext, mockRequest as Request, mockResponse as Response);

        // All five must NOT 500
        expect(mockResponse.status).not.toHaveBeenCalledWith(500);
        // All five must respond success: true with a warning string
        const lastCall = mockResponse.json.mock.calls[mockResponse.json.mock.calls.length - 1][0];
        expect(lastCall.success).toBe(true);
        expect(typeof lastCall.warning).toBe('string');
        expect(lastCall.warning).toContain(`${name} boom`);
      }
    });
  });
});
