import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Request, Response } from 'express';
import * as tasksHandlers from './tasks.controller.js';
import type { ApiContext } from '../types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

// V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
// The handlers now read from TaskPoolService and project to the legacy
// InProgressTask shape. Tests mock TaskPoolService.getInstance().
jest.mock('../../services/task-pool/task-pool.service.js', () => ({
  TaskPoolService: { getInstance: jest.fn() },
}));

import { TaskPoolService } from '../../services/task-pool/task-pool.service.js';

function makeWorkItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi-1',
    type: 'delegate',
    owner: 'system',
    title: 'Test Task',
    status: 'queued',
    createdAt: new Date('2026-05-06T00:00:00.000Z').toISOString(),
    retryCount: 0,
    maxRetries: 3,
    metadata: { projectId: 'project-1', projectPath: '/test/path', milestone: 'sprint-1' },
    ...over,
  } as WorkItem;
}

describe('Tasks Handlers (V3 task-pool projection)', () => {
  let mockApiContext: Partial<ApiContext>;
  let mockRequest: Partial<Request>;
  let mockResponse: any;
  let mockStorageService: any;
  let mockPool: { getAllItems: jest.Mock<() => Promise<WorkItem[]>> };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { getAllItems: jest.fn<() => Promise<WorkItem[]>>() };
    (TaskPoolService.getInstance as jest.Mock<() => unknown>).mockReturnValue(mockPool);

    mockStorageService = {
      getProjects: jest.fn<() => Promise<Array<{ id: string; path: string }>>>(),
    };
    mockApiContext = { storageService: mockStorageService } as any;

    mockRequest = {
      params: { projectId: 'project-1', status: 'pending_assignment', milestoneId: 'sprint-1' },
      body: {},
      query: {},
    };

    mockResponse = {
      json: jest.fn<any>(),
      status: jest.fn<any>().mockReturnThis(),
    };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('getAllTasks', () => {
    it('returns projected WorkItems for the project', async () => {
      mockStorageService.getProjects.mockResolvedValue([{ id: 'project-1', path: '/test/path' }]);
      mockPool.getAllItems.mockResolvedValue([
        makeWorkItem({ id: 'a', title: 'A' }),
        makeWorkItem({ id: 'b', title: 'B', metadata: { projectId: 'project-2' } }),
        makeWorkItem({ id: 'c', title: 'C' }),
      ]);

      await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockPool.getAllItems).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalled();
      const arg = mockResponse.json.mock.calls[0][0];
      expect(arg.success).toBe(true);
      // Only the two items with projectId === 'project-1' survive the filter.
      expect(arg.data.map((t: any) => t.id)).toEqual(['a', 'c']);
      // Projected to legacy shape — taskName field is set from WorkItem.title.
      expect(arg.data[0].taskName).toBe('A');
    });

    it('returns 400 when projectId is missing', async () => {
      mockRequest.params = {};
      await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('returns 404 when project not found', async () => {
      mockStorageService.getProjects.mockResolvedValue([]);
      await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(404);
    });

    it('gracefully degrades when the pool throws', async () => {
      mockStorageService.getProjects.mockResolvedValue([{ id: 'project-1', path: '/test/path' }]);
      mockPool.getAllItems.mockRejectedValue(new Error('pool unavailable'));
      await tasksHandlers.getAllTasks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );
      const arg = mockResponse.json.mock.calls[0][0];
      expect(arg.success).toBe(true);
      expect(arg.data).toEqual([]);
      expect(typeof arg.warning).toBe('string');
    });
  });

  describe('getMilestones', () => {
    it('returns distinct milestones derived from metadata.milestone', async () => {
      mockStorageService.getProjects.mockResolvedValue([{ id: 'project-1', path: '/test/path' }]);
      mockPool.getAllItems.mockResolvedValue([
        makeWorkItem({ id: 'a', metadata: { projectId: 'project-1', milestone: 'sprint-1' } }),
        makeWorkItem({ id: 'b', metadata: { projectId: 'project-1', milestone: 'sprint-2' } }),
        makeWorkItem({ id: 'c', metadata: { projectId: 'project-1', milestone: 'sprint-1' } }),
      ]);
      await tasksHandlers.getMilestones.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );
      const arg = mockResponse.json.mock.calls[0][0];
      expect(arg.success).toBe(true);
      expect(new Set(arg.data.map((m: any) => m.id))).toEqual(new Set(['sprint-1', 'sprint-2']));
    });
  });

  describe('getTasksByStatus', () => {
    it('filters projected items by mapped legacy status', async () => {
      mockStorageService.getProjects.mockResolvedValue([{ id: 'project-1', path: '/test/path' }]);
      mockPool.getAllItems.mockResolvedValue([
        makeWorkItem({ id: 'a', status: 'queued' }),  // → pending_assignment
        makeWorkItem({ id: 'b', status: 'running' }), // → active
      ]);
      mockRequest.params = { projectId: 'project-1', status: 'pending_assignment' };
      await tasksHandlers.getTasksByStatus.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );
      const arg = mockResponse.json.mock.calls[0][0];
      expect(arg.data.map((t: any) => t.id)).toEqual(['a']);
    });
  });

  describe('getTasksByMilestone', () => {
    it('filters by metadata.milestone', async () => {
      mockStorageService.getProjects.mockResolvedValue([{ id: 'project-1', path: '/test/path' }]);
      mockPool.getAllItems.mockResolvedValue([
        makeWorkItem({ id: 'a', metadata: { projectId: 'project-1', milestone: 'sprint-1' } }),
        makeWorkItem({ id: 'b', metadata: { projectId: 'project-1', milestone: 'sprint-2' } }),
      ]);
      mockRequest.params = { projectId: 'project-1', milestoneId: 'sprint-1' };
      await tasksHandlers.getTasksByMilestone.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );
      const arg = mockResponse.json.mock.calls[0][0];
      expect(arg.data.map((t: any) => t.id)).toEqual(['a']);
    });
  });

  describe('getProjectTasksStatus', () => {
    it('aggregates totals + milestones', async () => {
      mockStorageService.getProjects.mockResolvedValue([{ id: 'project-1', path: '/test/path' }]);
      mockPool.getAllItems.mockResolvedValue([
        makeWorkItem({ id: 'a', status: 'queued' }),
        makeWorkItem({ id: 'b', status: 'running' }),
        makeWorkItem({ id: 'c', status: 'done' }),
      ]);
      await tasksHandlers.getProjectTasksStatus.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );
      const arg = mockResponse.json.mock.calls[0][0];
      expect(arg.success).toBe(true);
      expect(arg.data.totals.all).toBe(3);
      expect(arg.data.milestones.length).toBeGreaterThanOrEqual(1);
    });
  });
});
