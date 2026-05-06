/**
 * Tests for Auto-Assignment Service
 *
 * @module services/autonomous/auto-assign.service.test
 */

import { AutoAssignService, AgentWorkload } from './auto-assign.service.js';
import { TaskService, Task } from '../project/task.service.js';
import {
  AssignmentStrategy,
  QueuedTask,
  TaskQueue,
  FindNextTaskResult,
  AUTO_ASSIGN_CONSTANTS,
  DEFAULT_ASSIGNMENT_STRATEGY,
} from '../../types/auto-assign.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

// V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
// Mock TaskPoolService.getInstance() — the production code now reads
// active tasks from there via dynamic import. The legacy
// TaskTrackingService dependency has been deleted.
jest.mock('../task-pool/task-pool.service.js', () => ({
  TaskPoolService: { getInstance: jest.fn() },
}));
import { TaskPoolService } from '../task-pool/task-pool.service.js';

function makeWi(over: Partial<WorkItem>): WorkItem {
  return {
    id: 'wi-1',
    type: 'delegate',
    owner: 'system',
    title: 'Test',
    status: 'running',
    target: 'test-developer-1',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    metadata: {},
    ...over,
  } as WorkItem;
}

// Mock dependencies
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: jest.fn().mockReturnValue({
      createComponentLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
  mkdir: jest.fn(),
  readdir: jest.fn(),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(),
}));

describe('AutoAssignService', () => {
  let service: AutoAssignService;
  let mockTaskService: jest.Mocked<TaskService>;
  let mockPool: { getAllItems: jest.Mock; findWorkItem: jest.Mock };

  const testProjectPath = '/test/project';
  const testSessionName = 'test-developer-1';

  beforeEach(() => {
    // Clear singleton and caches
    AutoAssignService.clearInstance();
    service = AutoAssignService.getInstance();

    // Create mock services
    mockTaskService = {
      getAllTasks: jest.fn().mockResolvedValue([]),
      getTasksByStatus: jest.fn().mockResolvedValue([]),
      getMilestones: jest.fn().mockResolvedValue([]),
      getTasksByMilestone: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<TaskService>;

    mockPool = {
      getAllItems: jest.fn().mockResolvedValue([] as WorkItem[]),
      findWorkItem: jest.fn(),
    };
    (TaskPoolService.getInstance as jest.Mock).mockReturnValue(mockPool);

    // Inject mock TaskService
    service.setTaskService(mockTaskService);

    // Register test agent
    service.registerAgent(testSessionName, testProjectPath);
  });

  afterEach(() => {
    jest.clearAllMocks();
    service.clearCache();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance', () => {
      const instance1 = AutoAssignService.getInstance();
      const instance2 = AutoAssignService.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should clear instance correctly', () => {
      const instance1 = AutoAssignService.getInstance();
      AutoAssignService.clearInstance();
      const instance2 = AutoAssignService.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('Agent Registration', () => {
    it('should register an agent with a project', () => {
      service.registerAgent('new-agent', '/new/project');
      // Verify registration by checking workload can be retrieved
      expect(async () => {
        await service.getAgentWorkload('new-agent');
      }).not.toThrow();
    });

    it('should unregister an agent', async () => {
      service.unregisterAgent(testSessionName);
      const result = await service.assignNextTask(testSessionName);
      expect(result).toBeNull(); // No project associated
    });
  });

  describe('Configuration', () => {
    beforeEach(() => {
      const fs = require('fs');
      fs.existsSync.mockReturnValue(false);
    });

    it('should return default config when no config file exists', async () => {
      const config = await service.getConfig(testProjectPath);
      expect(config.prioritization).toBe('priority');
      expect(config.loadBalancing.enabled).toBe(true);
      expect(config.dependencies.respectBlocking).toBe(true);
    });

    it('should update config correctly', async () => {
      await service.setConfig(testProjectPath, {
        prioritization: 'fifo',
      });

      const config = await service.getConfig(testProjectPath);
      expect(config.prioritization).toBe('fifo');
    });
  });

  describe('Task Queue Management', () => {
    const mockTasks: Task[] = [
      {
        id: 'task-1',
        title: 'Implement feature',
        description: 'Implement new feature',
        status: 'open',
        priority: 'high',
        milestone: 'M1',
        milestoneId: 'm1',
        tasks: [],
        acceptanceCriteria: [],
        filePath: '/project/tasks/task-1.md',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'task-2',
        title: 'Fix bug',
        description: 'Fix critical bug',
        status: 'open',
        priority: 'critical',
        milestone: 'M1',
        milestoneId: 'm1',
        tasks: [],
        acceptanceCriteria: [],
        filePath: '/project/tasks/task-2.md',
        createdAt: '2026-01-02T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: 'task-3',
        title: 'Write tests',
        description: 'Depends on: task-1',
        status: 'open',
        priority: 'medium',
        milestone: 'M1',
        milestoneId: 'm1',
        tasks: [],
        acceptanceCriteria: [],
        filePath: '/project/tasks/task-3.md',
        createdAt: '2026-01-03T00:00:00Z',
        updatedAt: '2026-01-03T00:00:00Z',
      },
    ];

    beforeEach(() => {
      mockTaskService.getAllTasks.mockResolvedValue(mockTasks);
    });

    it('should build task queue from filesystem', async () => {
      const queue = await service.getTaskQueue(testProjectPath);

      expect(queue.projectPath).toBe(testProjectPath);
      expect(queue.tasks.length).toBe(3);
    });

    it('should refresh queue on request', async () => {
      await service.refreshQueue(testProjectPath);

      expect(mockTaskService.getAllTasks).toHaveBeenCalled();
    });

    it('should calculate blocked tasks correctly', async () => {
      const queue = await service.getTaskQueue(testProjectPath);

      const task3 = queue.tasks.find((t) => t.taskId === 'task-3');
      expect(task3?.blockedBy).toContain('task-1');
    });

    it('should convert priority strings to values', async () => {
      const queue = await service.getTaskQueue(testProjectPath);

      const criticalTask = queue.tasks.find((t) => t.taskId === 'task-2');
      const highTask = queue.tasks.find((t) => t.taskId === 'task-1');

      expect(criticalTask?.priority).toBe(AUTO_ASSIGN_CONSTANTS.PRIORITY.CRITICAL);
      expect(highTask?.priority).toBe(AUTO_ASSIGN_CONSTANTS.PRIORITY.HIGH);
    });
  });

  describe('Task Finding', () => {
    const mockOpenTasks: Task[] = [
      {
        id: 'task-1',
        title: 'Frontend feature',
        description: '',
        status: 'open',
        priority: 'high',
        milestone: 'M1',
        milestoneId: 'm1',
        tasks: [],
        acceptanceCriteria: [],
        filePath: '/project/tasks/task-1.md',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'task-2',
        title: 'Backend API fix',
        description: '',
        status: 'open',
        priority: 'critical',
        milestone: 'M1',
        milestoneId: 'm1',
        tasks: [],
        acceptanceCriteria: [],
        filePath: '/project/tasks/task-2.md',
        createdAt: '2026-01-02T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ];

    beforeEach(() => {
      mockTaskService.getAllTasks.mockResolvedValue(mockOpenTasks);
      mockPool.getAllItems.mockResolvedValue([]);
    });

    it('should find next task based on priority', async () => {
      await service.initialize(testProjectPath);

      const result = await service.findNextTask({
        sessionName: testSessionName,
        role: 'developer',
        projectPath: testProjectPath,
      });

      expect(result.found).toBe(true);
      expect(result.task?.taskId).toBe('task-2'); // Critical priority
    });

    it('should return no_tasks when queue is empty', async () => {
      mockTaskService.getAllTasks.mockResolvedValue([]);

      const result = await service.findNextTask({
        sessionName: testSessionName,
        role: 'developer',
        projectPath: testProjectPath,
      });

      expect(result.found).toBe(false);
      expect(result.reason).toBe('no_tasks');
    });

    it('should respect blocked dependencies', async () => {
      const tasksWithDeps: Task[] = [
        {
          id: 'task-1',
          title: 'First task',
          description: '',
          status: 'in_progress',
          priority: 'high',
          milestone: 'M1',
          milestoneId: 'm1',
          tasks: [],
          acceptanceCriteria: [],
          filePath: '/project/tasks/task-1.md',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'task-2',
          title: 'Dependent task',
          description: 'Depends on: task-1',
          status: 'open',
          priority: 'high',
          milestone: 'M1',
          milestoneId: 'm1',
          tasks: [],
          acceptanceCriteria: [],
          filePath: '/project/tasks/task-2.md',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ];

      mockTaskService.getAllTasks.mockResolvedValue(tasksWithDeps);
      await service.refreshQueue(testProjectPath);

      const result = await service.findNextTask({
        sessionName: testSessionName,
        role: 'developer',
        projectPath: testProjectPath,
      });

      expect(result.found).toBe(false);
      expect(result.reason).toBe('all_blocked');
    });

    it('should filter by role matching', async () => {
      // QA role should not get development tasks
      const devTasks: Task[] = [
        {
          id: 'dev-task',
          title: 'Development task',
          description: '',
          status: 'open',
          priority: 'high',
          assignee: 'developer',
          milestone: 'M1',
          milestoneId: 'm1',
          tasks: [],
          acceptanceCriteria: [],
          filePath: '/project/tasks/dev-task.md',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ];

      mockTaskService.getAllTasks.mockResolvedValue(devTasks);
      service.registerAgent('qa-agent', testProjectPath);

      const result = await service.findNextTask({
        sessionName: 'qa-agent',
        role: 'qa',
        projectPath: testProjectPath,
      });

      expect(result.found).toBe(false);
      expect(result.reason).toBe('role_mismatch');
    });
  });

  describe('Task Assignment', () => {
    const mockTasks: Task[] = [
      {
        id: 'task-1',
        title: 'Test task',
        description: '',
        status: 'open',
        priority: 'high',
        milestone: 'M1',
        milestoneId: 'm1',
        tasks: [],
        acceptanceCriteria: [],
        filePath: '/project/tasks/task-1.md',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];

    beforeEach(() => {
      mockTaskService.getAllTasks.mockResolvedValue(mockTasks);
      mockPool.getAllItems.mockResolvedValue([]);
    });

    it('should assign a specific task to an agent', async () => {
      const result = await service.assignTask(
        '/project/tasks/task-1.md',
        testSessionName
      );

      expect(result.taskId).toBe('task-1');
      expect(result.sessionName).toBe(testSessionName);
      expect(result.assignedAt).toBeDefined();
    });

    it('should emit task_assigned event', async () => {
      const handler = jest.fn();
      service.onTaskAssigned(handler);

      await service.assignTask('/project/tasks/task-1.md', testSessionName);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task_assigned',
          taskId: 'task-1',
          sessionName: testSessionName,
        })
      );
    });

    it('should throw error for non-existent task', async () => {
      await expect(
        service.assignTask('/project/tasks/non-existent.md', testSessionName)
      ).rejects.toThrow('Task not found');
    });

    it('should track daily assignments', async () => {
      await service.assignTask('/project/tasks/task-1.md', testSessionName);

      const workload = await service.getAgentWorkload(testSessionName);
      expect(workload.completedToday).toBe(1);
    });
  });

  describe('Auto-Assignment Flow', () => {
    const mockTasks: Task[] = [
      {
        id: 'task-1',
        title: 'Test task',
        description: '',
        status: 'open',
        priority: 'high',
        milestone: 'M1',
        milestoneId: 'm1',
        tasks: [],
        acceptanceCriteria: [],
        filePath: '/project/tasks/task-1.md',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];

    beforeEach(async () => {
      mockTaskService.getAllTasks.mockResolvedValue(mockTasks);
      mockPool.getAllItems.mockResolvedValue([]);
      await service.initialize(testProjectPath);
    });

    it('should assign next task automatically', async () => {
      const result = await service.assignNextTask(testSessionName);

      expect(result).not.toBeNull();
      expect(result?.taskId).toBe('task-1');
    });

    it('should return null when auto-assign is disabled', async () => {
      await service.pauseAutoAssign(testProjectPath);

      const result = await service.assignNextTask(testSessionName);
      expect(result).toBeNull();
    });

    it('should respect max concurrent tasks', async () => {
      // First assignment
      await service.assignNextTask(testSessionName);

      // Mock agent already has a task
      mockPool.getAllItems.mockResolvedValue([
        makeWi({ id: 'existing-task', title: 'Existing Task', target: testSessionName, status: 'running' }),
      ]);

      const result = await service.assignNextTask(testSessionName);
      expect(result).toBeNull();
    });

    it('should respect cooldown period', async () => {
      // First assignment
      await service.assignTask('/project/tasks/task-1.md', testSessionName);

      // Immediate second assignment should fail due to cooldown
      mockTaskService.getAllTasks.mockResolvedValue([
        {
          id: 'task-2',
          title: 'Another task',
          description: '',
          status: 'open',
          priority: 'high',
          milestone: 'M1',
          milestoneId: 'm1',
          tasks: [],
          acceptanceCriteria: [],
          filePath: '/project/tasks/task-2.md',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]);
      await service.refreshQueue(testProjectPath);

      const result = await service.assignNextTask(testSessionName);
      expect(result).toBeNull();
    });
  });

  describe('Pause/Resume', () => {
    beforeEach(async () => {
      mockTaskService.getAllTasks.mockResolvedValue([]);
      mockPool.getAllItems.mockResolvedValue([]);
      await service.initialize(testProjectPath);
    });

    it('should pause auto-assignment', async () => {
      await service.pauseAutoAssign(testProjectPath);

      const enabled = await service.isAutoAssignEnabled(testProjectPath);
      expect(enabled).toBe(false);
    });

    it('should resume auto-assignment', async () => {
      await service.pauseAutoAssign(testProjectPath);
      await service.resumeAutoAssign(testProjectPath);

      const enabled = await service.isAutoAssignEnabled(testProjectPath);
      expect(enabled).toBe(true);
    });
  });

  describe('Agent Workload', () => {
    it('should return empty workload for new agent', async () => {
      mockPool.getAllItems.mockResolvedValue([]);

      const workload = await service.getAgentWorkload(testSessionName);

      expect(workload.sessionName).toBe(testSessionName);
      expect(workload.currentTasks).toHaveLength(0);
      expect(workload.completedToday).toBe(0);
    });

    it('should track current tasks', async () => {
      mockPool.getAllItems.mockResolvedValue([
        makeWi({ id: 'task-1', title: 'Task 1', target: testSessionName, status: 'running' }),
      ]);

      const workload = await service.getAgentWorkload(testSessionName);

      expect(workload.currentTasks).toContain('task-1');
    });

    it('should infer role from session name', async () => {
      mockPool.getAllItems.mockResolvedValue([]);
      service.registerAgent('project-qa-1', testProjectPath);

      const workload = await service.getAgentWorkload('project-qa-1');

      expect(workload.role).toBe('qa');
    });
  });

  describe('Event Handling', () => {
    it('should register task_assigned handler', () => {
      const handler = jest.fn();
      service.onTaskAssigned(handler);

      // Emit event manually
      service.emit('task_assigned', {
        type: 'task_assigned',
        agentId: 'agent-1',
        sessionName: testSessionName,
        taskId: 'task-1',
        timestamp: new Date().toISOString(),
      });

      expect(handler).toHaveBeenCalled();
    });

    it('should register agent_idle handler', () => {
      const handler = jest.fn();
      service.onAgentIdle(handler);

      service.emit('agent_idle', {
        type: 'agent_idle',
        agentId: 'agent-1',
        sessionName: testSessionName,
        timestamp: new Date().toISOString(),
      });

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('Task Failure Tracking', () => {
    beforeEach(async () => {
      mockTaskService.getAllTasks.mockResolvedValue([
        {
          id: 'task-1',
          title: 'Test task',
          description: '',
          status: 'open',
          priority: 'high',
          milestone: 'M1',
          milestoneId: 'm1',
          tasks: [],
          acceptanceCriteria: [],
          filePath: '/project/tasks/task-1.md',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]);
      mockPool.getAllItems.mockResolvedValue([]);
      await service.initialize(testProjectPath);
    });

    it('should mark task as failed', async () => {
      const handler = jest.fn();
      service.on('task_failed', handler);

      await service.assignTask('/project/tasks/task-1.md', testSessionName);
      await service.markTaskFailed('task-1', testSessionName, 'Quality gate failed');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task_failed',
          taskId: 'task-1',
          metadata: { reason: 'Quality gate failed' },
        })
      );
    });
  });

  describe('Statistics', () => {
    beforeEach(async () => {
      mockTaskService.getAllTasks.mockResolvedValue([
        {
          id: 'task-1',
          title: 'Test task 1',
          description: '',
          status: 'open',
          priority: 'high',
          milestone: 'M1',
          milestoneId: 'm1',
          tasks: [],
          acceptanceCriteria: [],
          filePath: '/project/tasks/task-1.md',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'task-2',
          title: 'Test task 2',
          description: '',
          status: 'open',
          priority: 'medium',
          milestone: 'M1',
          milestoneId: 'm1',
          tasks: [],
          acceptanceCriteria: [],
          filePath: '/project/tasks/task-2.md',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ]);
      mockPool.getAllItems.mockResolvedValue([]);
      await service.initialize(testProjectPath);
    });

    it('should track assignment statistics', async () => {
      await service.assignTask('/project/tasks/task-1.md', testSessionName);

      const stats = service.getStatistics(testProjectPath);

      expect(stats.totalAssigned).toBe(1);
      expect(stats.active).toBe(1);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
    });
  });

  describe('Priority Sorting', () => {
    beforeEach(() => {
      const tasks: Task[] = [
        {
          id: 'low-task',
          title: 'Low priority',
          description: '',
          status: 'open',
          priority: 'low',
          milestone: 'M1',
          milestoneId: 'm1',
          tasks: [],
          acceptanceCriteria: [],
          filePath: '/project/tasks/low.md',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'high-task',
          title: 'High priority',
          description: '',
          status: 'open',
          priority: 'high',
          milestone: 'M1',
          milestoneId: 'm1',
          tasks: [],
          acceptanceCriteria: [],
          filePath: '/project/tasks/high.md',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
        {
          id: 'critical-task',
          title: 'Critical priority',
          description: '',
          status: 'open',
          priority: 'critical',
          milestone: 'M1',
          milestoneId: 'm1',
          tasks: [],
          acceptanceCriteria: [],
          filePath: '/project/tasks/critical.md',
          createdAt: '2026-01-03T00:00:00Z',
          updatedAt: '2026-01-03T00:00:00Z',
        },
      ];

      mockTaskService.getAllTasks.mockResolvedValue(tasks);
      mockPool.getAllItems.mockResolvedValue([]);
    });

    it('should return critical priority task first', async () => {
      await service.initialize(testProjectPath);

      const result = await service.findNextTask({
        sessionName: testSessionName,
        role: 'developer',
        projectPath: testProjectPath,
      });

      expect(result.found).toBe(true);
      expect(result.task?.taskId).toBe('critical-task');
    });
  });

  describe('FIFO Sorting', () => {
    beforeEach(async () => {
      const tasks: Task[] = [
        {
          id: 'new-task',
          title: 'Newer task',
          description: '',
          status: 'open',
          priority: 'medium',
          milestone: 'M1',
          milestoneId: 'm1',
          tasks: [],
          acceptanceCriteria: [],
          filePath: '/project/tasks/new.md',
          createdAt: '2026-01-03T00:00:00Z',
          updatedAt: '2026-01-03T00:00:00Z',
        },
        {
          id: 'old-task',
          title: 'Older task',
          description: '',
          status: 'open',
          priority: 'medium',
          milestone: 'M1',
          milestoneId: 'm1',
          tasks: [],
          acceptanceCriteria: [],
          filePath: '/project/tasks/old.md',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ];

      mockTaskService.getAllTasks.mockResolvedValue(tasks);
      mockPool.getAllItems.mockResolvedValue([]);
      await service.initialize(testProjectPath);
      await service.setConfig(testProjectPath, { prioritization: 'fifo' });
    });

    it('should return oldest task first with FIFO strategy', async () => {
      const result = await service.findNextTask({
        sessionName: testSessionName,
        role: 'developer',
        projectPath: testProjectPath,
      });

      expect(result.found).toBe(true);
      expect(result.task?.taskId).toBe('old-task');
    });
  });

  describe('Preferred Task Types', () => {
    beforeEach(() => {
      const tasks: Task[] = [
        {
          id: 'feature-task',
          title: 'Feature implementation',
          description: '',
          status: 'open',
          priority: 'medium',
          milestone: 'M1',
          milestoneId: 'm1',
          tasks: [],
          acceptanceCriteria: [],
          filePath: '/project/tasks/feature.md',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'fix-task',
          title: 'Bug fix',
          description: '',
          status: 'open',
          priority: 'medium',
          milestone: 'M1',
          milestoneId: 'm1',
          tasks: [],
          acceptanceCriteria: [],
          filePath: '/project/tasks/fix.md',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ];

      mockTaskService.getAllTasks.mockResolvedValue(tasks);
      mockPool.getAllItems.mockResolvedValue([]);
    });

    it('should prefer specified task types', async () => {
      await service.initialize(testProjectPath);

      const result = await service.findNextTask({
        sessionName: testSessionName,
        role: 'developer',
        projectPath: testProjectPath,
        preferredTaskTypes: ['fix'],
      });

      expect(result.found).toBe(true);
      expect(result.task?.taskId).toBe('fix-task');
    });
  });
});
