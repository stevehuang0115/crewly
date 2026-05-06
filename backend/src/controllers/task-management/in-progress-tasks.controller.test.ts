import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Request, Response } from 'express';
import * as inProgressController from './in-progress-tasks.controller.js';
import { ApiController } from '../api.controller.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

// V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
// The controller now reads from TaskPoolService and projects WorkItems
// to the legacy InProgressTask shape so frontend dashboard widgets
// continue to work.
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
    metadata: { projectId: 'project-1', projectPath: '/test/path' },
    ...over,
  } as WorkItem;
}

describe('InProgressTasksController (V3 task-pool projection)', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let jsonSpy: jest.Mock<any>;
  let statusSpy: jest.Mock<any>;
  let apiController: ApiController;
  let mockPool: { getAllItems: jest.Mock<() => Promise<WorkItem[]>> };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { getAllItems: jest.fn<() => Promise<WorkItem[]>>() };
    (TaskPoolService.getInstance as jest.Mock<() => unknown>).mockReturnValue(mockPool);

    jsonSpy = jest.fn<any>();
    statusSpy = jest.fn<any>(() => ({ json: jsonSpy }));

    mockReq = {};
    mockRes = { json: jsonSpy, status: statusSpy } as any;
    apiController = {} as ApiController;
  });

  describe('getInProgressTasks', () => {
    it('returns active WorkItems projected to legacy shape', async () => {
      mockPool.getAllItems.mockResolvedValue([
        makeWorkItem({ id: 'a', status: 'queued' }),
        makeWorkItem({ id: 'b', status: 'running' }),
        makeWorkItem({ id: 'c', status: 'cancelled' }),  // excluded
        makeWorkItem({ id: 'd', status: 'done' }),       // excluded
      ]);

      await inProgressController.getInProgressTasks.call(
        apiController,
        mockReq as Request,
        mockRes as Response,
      );

      expect(jsonSpy).toHaveBeenCalled();
      const arg = jsonSpy.mock.calls[0][0] as any;
      expect(arg.success).toBe(true);
      expect(arg.version).toBe('3.0.0');
      expect(arg.tasks.map((t: any) => t.id)).toEqual(['a', 'b']);
    });

    it('returns empty tasks array when pool is empty', async () => {
      mockPool.getAllItems.mockResolvedValue([]);

      await inProgressController.getInProgressTasks.call(
        apiController,
        mockReq as Request,
        mockRes as Response,
      );

      const arg = jsonSpy.mock.calls[0][0] as any;
      expect(arg.success).toBe(true);
      expect(arg.tasks).toEqual([]);
    });

    it('handles pool read errors gracefully', async () => {
      mockPool.getAllItems.mockRejectedValue(new Error('pool unavailable'));

      await inProgressController.getInProgressTasks.call(
        apiController,
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusSpy).toHaveBeenCalledWith(500);
      const arg = jsonSpy.mock.calls[0][0] as any;
      expect(arg.success).toBe(false);
      expect(arg.tasks).toEqual([]);
    });
  });
});
