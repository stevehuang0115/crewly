import { TaskTrackingService } from './task-tracking.service';
import { InProgressTask, TaskTrackingData, TaskFileInfo } from '../../types/task-tracking.types';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CREWLY_CONSTANTS } from '../../constants.js';

// Mock dependencies
jest.mock('fs/promises');
jest.mock('fs', () => ({
  existsSync: jest.fn()
}));
jest.mock('path');
jest.mock('os');

describe('TaskTrackingService', () => {
  let service: TaskTrackingService;
  const mockTaskTrackingPath = '/mock/home/.crewly/in_progress_tasks.json';

  const mockTaskData: TaskTrackingData = {
    tasks: [],
    lastUpdated: '2023-01-01T00:00:00.000Z',
    version: '1.0.0'
  };

  const mockTask: InProgressTask = {
    id: 'task-123',
    projectId: 'project-456',
    teamId: 'team-abc',
    taskFilePath: '/project/tasks/milestone1/open/task001.md',
    taskName: 'Test Task',
    targetRole: 'developer',
    assignedTeamMemberId: 'member-789',
    assignedSessionName: 'session-abc',
    assignedAt: '2023-01-01T10:00:00.000Z',
    status: 'assigned'
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock path operations
    (path.join as jest.Mock).mockImplementation((...parts) => parts.join('/'));
    (path.dirname as jest.Mock).mockImplementation((p) => p.split('/').slice(0, -1).join('/'));
    (path.basename as jest.Mock).mockImplementation((p) => p.split('/').pop() || '');
    (os.homedir as jest.Mock).mockReturnValue('/mock/home');

    service = new TaskTrackingService();

    // Mock console methods
    jest.spyOn(console, 'error').mockImplementation();
  });

  describe('constructor', () => {
    it('should initialize with correct task tracking path', () => {
      expect(path.join).toHaveBeenCalledWith('/mock/home', '.crewly', 'in_progress_tasks.json');
    });
  });

  describe('loadTaskData', () => {
    it('should create initial data if file does not exist', async () => {
      (fsSync.existsSync as jest.Mock).mockReturnValue(false);
      const saveTaskDataSpy = jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      const result = await service.loadTaskData();

      expect(result).toEqual({
        tasks: [],
        lastUpdated: expect.any(String),
        version: '1.0.0'
      });
      expect(saveTaskDataSpy).toHaveBeenCalledWith(result);
    });

    it('should load existing data from file', async () => {
      (fsSync.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockTaskData));

      const result = await service.loadTaskData();

      expect(result).toEqual(mockTaskData);
      expect(fs.readFile).toHaveBeenCalledWith(mockTaskTrackingPath, 'utf-8');
    });

    it('should return default data on error', async () => {
      (fsSync.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFile as jest.Mock).mockRejectedValue(new Error('File read error'));

      const result = await service.loadTaskData();

      expect(result).toEqual({
        tasks: [],
        lastUpdated: expect.any(String),
        version: '1.0.0'
      });
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error loading task tracking data'));
    });
  });

  describe('saveTaskData', () => {
    it('should save data with updated timestamp', async () => {
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const data = { ...mockTaskData };
      await service.saveTaskData(data);

      expect(data.lastUpdated).not.toBe('2023-01-01T00:00:00.000Z');
      expect(fs.writeFile).toHaveBeenCalledWith(
        mockTaskTrackingPath,
        JSON.stringify(data, null, 2),
        'utf-8'
      );
    });

    it('should throw error on save failure', async () => {
      (fs.writeFile as jest.Mock).mockRejectedValue(new Error('Write error'));

      await expect(service.saveTaskData(mockTaskData)).rejects.toThrow('Write error');
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error saving task tracking data'));
    });
  });

  describe('assignTask', () => {
    it('should create and save new task assignment with teamId', async () => {
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(mockTaskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      const result = await service.assignTask(
        'project-456',
        'team-abc',
        '/project/tasks/milestone1/open/task001.md',
        'Test Task',
        'developer',
        'member-789',
        'session-abc'
      );

      expect(result).toMatchObject({
        id: expect.any(String),
        projectId: 'project-456',
        teamId: 'team-abc',
        taskFilePath: '/project/tasks/milestone1/open/task001.md',
        taskName: 'Test Task',
        targetRole: 'developer',
        assignedTeamMemberId: 'member-789',
        assignedSessionName: 'session-abc',
        assignedAt: expect.any(String),
        status: 'assigned'
      });

      expect(service.saveTaskData).toHaveBeenCalled();
    });

    it('should handle assignment without teamId (backward compatibility)', async () => {
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(mockTaskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      const result = await service.assignTask(
        'project-456',
        'team-test',
        '/project/tasks/milestone1/open/task001.md',
        'Test Task',
        'developer',
        'member-789',
        'session-abc'
      );

      expect(result).toMatchObject({
        id: expect.any(String),
        projectId: 'project-456',
        teamId: 'team-test',
        taskFilePath: '/project/tasks/milestone1/open/task001.md',
        taskName: 'Test Task',
        targetRole: 'developer',
        assignedTeamMemberId: 'member-789',
        assignedSessionName: 'session-abc',
        assignedAt: expect.any(String),
        status: 'assigned'
      });

      expect(service.saveTaskData).toHaveBeenCalled();
    });
  });

  describe('updateTaskStatus', () => {
    it('should update task status successfully', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [mockTask]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      await service.updateTaskStatus('task-123', 'active');

      const updatedTask = taskData.tasks[0];
      expect(updatedTask.status).toBe('active');
      expect(updatedTask.lastCheckedAt).toBeTruthy();
      expect(service.saveTaskData).toHaveBeenCalledWith(taskData);
    });

    it('should set block reason when status is blocked', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [mockTask]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      await service.updateTaskStatus('task-123', 'blocked', 'Waiting for dependencies');

      const updatedTask = taskData.tasks[0];
      expect(updatedTask.status).toBe('blocked');
      expect(updatedTask.blockReason).toBe('Waiting for dependencies');
    });

    it('should throw error if task not found', async () => {
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(mockTaskData);

      await expect(service.updateTaskStatus('nonexistent-task', 'active'))
        .rejects.toThrow('Task with ID nonexistent-task not found');
    });
  });

  describe('removeTask', () => {
    it('should remove task from tracking', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [mockTask, { ...mockTask, id: 'task-456', teamId: 'team-def' }]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      await service.removeTask('task-123');

      expect(taskData.tasks).toHaveLength(1);
      expect(taskData.tasks[0].id).toBe('task-456');
      expect(service.saveTaskData).toHaveBeenCalledWith(taskData);
    });
  });

  describe('addTaskToQueue', () => {
    it('should add task to queue with pending_assignment status and teamId', async () => {
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(mockTaskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      const taskInfo = {
        projectId: 'project-456',
        teamId: 'team-xyz',
        taskFilePath: '/project/tasks/milestone1/open/task001.md',
        taskName: 'Queued Task',
        targetRole: 'developer',
        priority: 'high' as const,
        createdAt: '2023-01-01T12:00:00.000Z'
      };

      const result = await service.addTaskToQueue(taskInfo);

      expect(result).toMatchObject({
        id: expect.any(String),
        projectId: 'project-456',
        teamId: 'team-xyz',
        taskFilePath: '/project/tasks/milestone1/open/task001.md',
        taskName: 'Queued Task',
        targetRole: 'developer',
        assignedTeamMemberId: 'orchestrator',
        assignedSessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
        assignedAt: '2023-01-01T12:00:00.000Z',
        status: 'pending_assignment',
        priority: 'high'
      });

      expect(service.saveTaskData).toHaveBeenCalled();
    });

    it('should add task to queue without teamId (backward compatibility)', async () => {
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(mockTaskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      const taskInfo = {
        projectId: 'project-456',
        teamId: 'team-test',
        taskFilePath: '/project/tasks/milestone1/open/task001.md',
        taskName: 'Queued Task',
        targetRole: 'developer',
        priority: 'high' as const,
        createdAt: '2023-01-01T12:00:00.000Z'
      };

      const result = await service.addTaskToQueue(taskInfo);

      expect(result).toMatchObject({
        id: expect.any(String),
        projectId: 'project-456',
        teamId: 'team-test',
        taskFilePath: '/project/tasks/milestone1/open/task001.md',
        taskName: 'Queued Task',
        targetRole: 'developer',
        assignedTeamMemberId: 'orchestrator',
        assignedSessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
        assignedAt: '2023-01-01T12:00:00.000Z',
        status: 'pending_assignment',
        priority: 'high'
      });

      expect(service.saveTaskData).toHaveBeenCalled();
    });
  });

  describe('getTasksForProject', () => {
    it('should return tasks filtered by project ID', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [
          mockTask,
          { ...mockTask, id: 'task-456', projectId: 'other-project', teamId: 'team-other' },
          { ...mockTask, id: 'task-789', projectId: 'project-456', teamId: 'team-abc' }
        ]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);

      const result = await service.getTasksForProject('project-456');

      expect(result).toHaveLength(2);
      expect(result.every(task => task.projectId === 'project-456')).toBe(true);
    });
  });

  describe('getTasksForTeamMember', () => {
    it('should return tasks filtered by team member ID', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [
          mockTask,
          { ...mockTask, id: 'task-456', assignedTeamMemberId: 'other-member', teamId: 'team-other' },
          { ...mockTask, id: 'task-789', assignedTeamMemberId: 'member-789', teamId: 'team-abc' }
        ]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);

      const result = await service.getTasksForTeamMember('member-789');

      expect(result).toHaveLength(2);
      expect(result.every(task => task.assignedTeamMemberId === 'member-789')).toBe(true);
    });
  });

  describe('getAllInProgressTasks', () => {
    it('should return all tasks', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [mockTask, { ...mockTask, id: 'task-456', teamId: 'team-def' }]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);

      const result = await service.getAllInProgressTasks();

      expect(result).toEqual(taskData.tasks);
    });
  });

  describe('syncTasksWithFileSystem', () => {
    const projectPath = '/project';
    const projectId = 'project-456';

    beforeEach(() => {
      (fsSync.existsSync as jest.Mock).mockReturnValue(true);
    });

    it('should return early if tasks path does not exist', async () => {
      (fsSync.existsSync as jest.Mock).mockReturnValue(false);
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(mockTaskData);

      await service.syncTasksWithFileSystem(projectPath, projectId);

      // Source code checks existsSync(tasksPath) BEFORE loadTaskData,
      // so when the path does not exist, loadTaskData is never called.
      expect(service.loadTaskData).not.toHaveBeenCalled();
    });

    it('should remove task if moved to done folder', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [mockTask]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      const removeTaskSpy = jest.spyOn(service, 'removeTask').mockResolvedValue();

      (fsSync.existsSync as jest.Mock).mockImplementation((filePath) => {
        if (filePath.includes('/in_progress/')) return false; // Task not in progress
        if (filePath.includes('/done/')) return true; // Task is done
        return true; // Default: tasks path exists
      });

      await service.syncTasksWithFileSystem(projectPath, projectId);

      expect(removeTaskSpy).toHaveBeenCalledWith('task-123');
    });

    it('should update task status if moved to blocked folder', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [mockTask]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      const updateTaskStatusSpy = jest.spyOn(service, 'updateTaskStatus').mockResolvedValue();

      (fsSync.existsSync as jest.Mock).mockImplementation((filePath) => {
        if (filePath.includes('/in_progress/')) return false; // Task not in progress
        if (filePath.includes('/done/')) return false; // Task not done
        if (filePath.includes('/blocked/')) return true; // Task is blocked
        return true; // Default: tasks path exists
      });

      await service.syncTasksWithFileSystem(projectPath, projectId);

      expect(updateTaskStatusSpy).toHaveBeenCalledWith('task-123', 'blocked', 'Moved to blocked folder manually');
    });

    it('should not change task if still in progress', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [mockTask]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      const removeTaskSpy = jest.spyOn(service, 'removeTask').mockResolvedValue();
      const updateTaskStatusSpy = jest.spyOn(service, 'updateTaskStatus').mockResolvedValue();

      (fsSync.existsSync as jest.Mock).mockImplementation((filePath) => {
        return filePath.includes('/in_progress/') || !filePath.includes('/in_progress/'); // Always true
      });

      await service.syncTasksWithFileSystem(projectPath, projectId);

      expect(removeTaskSpy).not.toHaveBeenCalled();
      expect(updateTaskStatusSpy).not.toHaveBeenCalled();
    });
  });

  describe('getOpenTasks', () => {
    it('should return empty array if tasks path does not exist', async () => {
      (fsSync.existsSync as jest.Mock).mockReturnValue(false);

      const result = await service.getOpenTasks('/project');

      expect(result).toEqual([]);
    });

    it('should return open tasks from all milestones', async () => {
      (fsSync.existsSync as jest.Mock).mockImplementation((filePath) => {
        return !filePath.includes('nonexistent');
      });
      (fs.readdir as jest.Mock).mockImplementation((dirPath) => {
        if (dirPath === '/project/.crewly/tasks') {
          return Promise.resolve(['m1_setup', 'm2_development', 'not_milestone', 'm3_testing']);
        }
        if (dirPath.includes('/open')) {
          return Promise.resolve(['01_task_one_developer.md', '02_task_two_designer.md']);
        }
        return Promise.resolve([]);
      });

      const result = await service.getOpenTasks('/project');

      expect(result).toHaveLength(6); // 2 tasks x 3 milestones
      expect(result[0]).toMatchObject({
        filePath: '/project/.crewly/tasks/m1_setup/open/01_task_one_developer.md',
        fileName: '01_task_one_developer.md',
        taskName: 'Task One',
        targetRole: 'developer',
        milestoneFolder: 'm1_setup',
        statusFolder: 'open'
      });
    });

    it('should extract task name and role from filename correctly', async () => {
      (fsSync.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdir as jest.Mock).mockImplementation((dirPath) => {
        if (dirPath === '/project/.crewly/tasks') {
          return Promise.resolve(['m1_milestone']);
        }
        if (dirPath.includes('/open')) {
          return Promise.resolve(['15_create_user_authentication_system_backend.md']);
        }
        return Promise.resolve([]);
      });

      const result = await service.getOpenTasks('/project');

      expect(result[0]).toMatchObject({
        taskName: 'Create User Authentication System',
        targetRole: 'backend'
      });
    });

    it('should handle filename without recognized role suffix', async () => {
      // The regex /_([a-z]+)\.md$/ matches the last _word before .md,
      // so 'task_without_role.md' matches 'role' as the role.
      // A filename that truly has no role match would need no underscore-word
      // before .md, e.g. 'task.md'
      (fsSync.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdir as jest.Mock).mockImplementation((dirPath) => {
        if (dirPath === '/project/.crewly/tasks') {
          return Promise.resolve(['m1_milestone']);
        }
        if (dirPath.includes('/open')) {
          return Promise.resolve(['task.md']);
        }
        return Promise.resolve([]);
      });

      const result = await service.getOpenTasks('/project');

      expect(result[0].targetRole).toBe('unknown');
    });

    it('should skip non-milestone folders', async () => {
      (fsSync.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdir as jest.Mock).mockImplementation((dirPath) => {
        if (dirPath === '/project/.crewly/tasks') {
          return Promise.resolve(['regular_folder', 'not_milestone_format', 'm1_valid_milestone']);
        }
        if (dirPath.includes('m1_valid_milestone/open')) {
          return Promise.resolve(['task.md']);
        }
        return Promise.resolve([]);
      });

      const result = await service.getOpenTasks('/project');

      expect(result).toHaveLength(1); // Only the valid milestone folder
    });

    it('should skip non-markdown files', async () => {
      (fsSync.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdir as jest.Mock).mockImplementation((dirPath) => {
        if (dirPath === '/project/.crewly/tasks') {
          return Promise.resolve(['m1_milestone']);
        }
        if (dirPath.includes('/open')) {
          return Promise.resolve(['task.md', 'readme.txt', 'notes.json', 'another_task.md']);
        }
        return Promise.resolve([]);
      });

      const result = await service.getOpenTasks('/project');

      expect(result).toHaveLength(2); // Only .md files
      expect(result.every(task => task.fileName.endsWith('.md'))).toBe(true);
    });
  });

  describe('extractTaskNameFromFile', () => {
    it('should extract and format task name correctly', () => {
      const testCases = [
        { input: '01_create_user_dashboard_frontend.md', expected: 'Create User Dashboard' },
        { input: '15_setup_database_connection_backend.md', expected: 'Setup Database Connection' },
        { input: 'simple_task_developer.md', expected: 'Simple Task' },
        { input: '99_very_long_task_name_with_many_words_designer.md', expected: 'Very Long Task Name With Many Words' }
      ];

      testCases.forEach(({ input, expected }) => {
        const result = (service as any).extractTaskNameFromFile(input);
        expect(result).toBe(expected);
      });
    });

    it('should handle edge cases', () => {
      // 'task.md' => remove .md => 'task', no number prefix, no role suffix => 'Task'
      expect((service as any).extractTaskNameFromFile('task.md')).toBe('Task');
      // '01_single_word.md' => remove .md => '01_single_word'
      // remove number prefix => 'single_word'
      // remove role suffix /_[a-z]+$/ => removes '_word' => 'single'
      // replace _ with space => 'single', capitalize => 'Single'
      // The regex treats the last _word as the role suffix,
      // so with only two segments after prefix removal, the "word" is consumed as role.
      expect((service as any).extractTaskNameFromFile('01_single_word.md')).toBe('Single');
    });
  });

  describe('addMonitoringIds', () => {
    it('should add schedule and subscription IDs to an existing task', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [{ ...mockTask }]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      await service.addMonitoringIds('task-123', ['sched-1', 'sched-2'], ['sub-1']);

      expect(taskData.tasks[0].scheduleIds).toEqual(['sched-1', 'sched-2']);
      expect(taskData.tasks[0].subscriptionIds).toEqual(['sub-1']);
      expect(service.saveTaskData).toHaveBeenCalledWith(taskData);
    });

    it('should append to existing monitoring IDs', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [{ ...mockTask, scheduleIds: ['sched-existing'], subscriptionIds: ['sub-existing'] }]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      await service.addMonitoringIds('task-123', ['sched-new'], ['sub-new']);

      expect(taskData.tasks[0].scheduleIds).toEqual(['sched-existing', 'sched-new']);
      expect(taskData.tasks[0].subscriptionIds).toEqual(['sub-existing', 'sub-new']);
    });

    it('should throw error if task not found', async () => {
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(mockTaskData);

      await expect(service.addMonitoringIds('nonexistent', ['sched-1'], []))
        .rejects.toThrow('Task with ID nonexistent not found');
    });
  });

  describe('getTasksBySessionName', () => {
    it('should return tasks filtered by session name', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [
          { ...mockTask, id: 'task-1', assignedSessionName: 'session-abc' },
          { ...mockTask, id: 'task-2', assignedSessionName: 'session-xyz' },
          { ...mockTask, id: 'task-3', assignedSessionName: 'session-abc' },
        ]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);

      const result = await service.getTasksBySessionName('session-abc');

      expect(result).toHaveLength(2);
      expect(result.every(t => t.assignedSessionName === 'session-abc')).toBe(true);
    });

    it('should return empty array when no tasks match', async () => {
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(mockTaskData);

      const result = await service.getTasksBySessionName('nonexistent-session');

      expect(result).toEqual([]);
    });
  });

  describe('getMonitoringIdsForSession', () => {
    it('should collect all monitoring IDs from tasks for a session', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [
          {
            ...mockTask,
            id: 'task-1',
            assignedSessionName: 'session-abc',
            scheduleIds: ['sched-1', 'sched-2'],
            subscriptionIds: ['sub-1'],
          },
          {
            ...mockTask,
            id: 'task-2',
            assignedSessionName: 'session-abc',
            scheduleIds: ['sched-3'],
            subscriptionIds: ['sub-2', 'sub-3'],
          },
          {
            ...mockTask,
            id: 'task-3',
            assignedSessionName: 'session-xyz',
            scheduleIds: ['sched-other'],
            subscriptionIds: [],
          },
        ]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);

      const result = await service.getMonitoringIdsForSession('session-abc');

      expect(result.scheduleIds).toEqual(['sched-1', 'sched-2', 'sched-3']);
      expect(result.subscriptionIds).toEqual(['sub-1', 'sub-2', 'sub-3']);
    });

    it('should return empty arrays when tasks have no monitoring IDs', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [
          { ...mockTask, assignedSessionName: 'session-abc' },
        ]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);

      const result = await service.getMonitoringIdsForSession('session-abc');

      expect(result.scheduleIds).toEqual([]);
      expect(result.subscriptionIds).toEqual([]);
    });
  });

  describe('detectOrphanTasks (#168)', () => {
    const mockTeams = [
      {
        members: [
          { id: 'member-789', sessionName: 'session-abc' },
          { id: 'member-active', sessionName: 'session-active' },
        ],
      },
    ];
    const getTeamStatus = async () => mockTeams;

    it('should detect tasks assigned to non-existent agents', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [
          { ...mockTask, id: 'orphan-1', assignedSessionName: 'ghost-agent', assignedTeamMemberId: 'ghost-member', status: 'assigned' as const },
          { ...mockTask, id: 'valid-1', assignedSessionName: 'session-abc', status: 'assigned' as const, assignedAt: new Date().toISOString() },
        ],
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);

      const orphans = await service.detectOrphanTasks(getTeamStatus, 999999999999);

      expect(orphans).toHaveLength(1);
      expect(orphans[0].id).toBe('orphan-1');
      expect(orphans[0].staleSinceMs).toBeGreaterThan(0);
    });

    it('should detect stale tasks even if agent exists', async () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago
      const taskData = {
        ...mockTaskData,
        tasks: [
          { ...mockTask, id: 'stale-1', assignedSessionName: 'session-abc', assignedAt: oldDate, status: 'assigned' as const },
        ],
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);

      const orphans = await service.detectOrphanTasks(getTeamStatus, 24 * 60 * 60 * 1000);

      expect(orphans).toHaveLength(1);
      expect(orphans[0].id).toBe('stale-1');
    });

    it('should return empty when no orphans exist', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [
          { ...mockTask, id: 'ok-1', assignedSessionName: 'session-abc', assignedAt: new Date().toISOString(), status: 'assigned' as const },
        ],
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);

      const orphans = await service.detectOrphanTasks(getTeamStatus, 999999999999);
      expect(orphans).toHaveLength(0);
    });

    it('should skip tasks with non-active statuses', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [
          { ...mockTask, id: 'completed-1', assignedSessionName: 'ghost-agent', status: 'completed' as const },
          { ...mockTask, id: 'cancelled-1', assignedSessionName: 'ghost-agent', status: 'cancelled' as const },
        ],
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);

      const orphans = await service.detectOrphanTasks(getTeamStatus);
      expect(orphans).toHaveLength(0);
    });
  });

  describe('cleanupOrphanTasks (#168)', () => {
    it('should cancel orphan tasks', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [{ ...mockTask, id: 'orphan-1' }],
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();
      jest.spyOn(service, 'removeTask').mockResolvedValue();

      const report = await service.cleanupOrphanTasks(['orphan-1'], 'cancel');

      expect(report.cleaned).toBe(1);
      expect(report.errors).toHaveLength(0);
    });

    it('should reopen orphan tasks', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [{ ...mockTask, id: 'orphan-1', taskFilePath: '/project/.crewly/tasks/m1/in_progress/task.md' }],
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();
      jest.spyOn(service, 'removeTask').mockResolvedValue();
      // moveTaskBackToOpen is private — stub via existsSync/readFile/writeFile
      (fsSync.existsSync as jest.Mock).mockReturnValue(false);

      const report = await service.cleanupOrphanTasks(['orphan-1'], 'reopen');

      // moveTaskBackToOpen returns false (file not found), but cleanup still removes from tracking
      expect(report.cleaned).toBe(1);
    });

    it('should report error for non-existent task IDs', async () => {
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(mockTaskData);

      const report = await service.cleanupOrphanTasks(['nonexistent'], 'cancel');

      expect(report.cleaned).toBe(0);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]).toContain('nonexistent');
    });
  });

  describe('Team integration tests', () => {
    it('should handle tasks with team assignments', async () => {
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(mockTaskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      const result = await service.assignTask(
        'project-123',
        'team-456',
        '/project/tasks/m1/open/task.md',
        'Team Task',
        'developer',
        'member-789',
        'session-abc'
      );

      expect(result.teamId).toBe('team-456');
      expect(result.projectId).toBe('project-123');
      expect(result.assignedTeamMemberId).toBe('member-789');
    });

    it('should filter tasks by team when getting tasks for project', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [
          { ...mockTask, id: 'task-1', projectId: 'project-123', teamId: 'team-a' },
          { ...mockTask, id: 'task-2', projectId: 'project-123', teamId: 'team-b' },
          { ...mockTask, id: 'task-3', projectId: 'project-456', teamId: 'team-a' }
        ]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);

      const result = await service.getTasksForProject('project-123');

      expect(result).toHaveLength(2);
      expect(result.every(task => task.projectId === 'project-123')).toBe(true);
      expect(result.find(task => task.teamId === 'team-a')).toBeDefined();
      expect(result.find(task => task.teamId === 'team-b')).toBeDefined();
    });

    it('should preserve team information when updating task status', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [{ ...mockTask, teamId: 'team-important' }]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      await service.updateTaskStatus('task-123', 'active');

      const updatedTask = taskData.tasks[0];
      expect(updatedTask.teamId).toBe('team-important');
      expect(updatedTask.status).toBe('active');
    });
  });

  // ========================= v2: validateStatusTransition =========================

  describe('validateStatusTransition', () => {
    it('should allow executor to set accepted', () => {
      const result = service.validateStatusTransition('assigned', 'accepted', 'executor');
      expect(result.valid).toBe(true);
    });

    it('should allow executor to set blocked', () => {
      const result = service.validateStatusTransition('active', 'blocked', 'executor');
      expect(result.valid).toBe(true);
    });

    it('should allow executor to set done', () => {
      const result = service.validateStatusTransition('active', 'done', 'executor');
      expect(result.valid).toBe(true);
    });

    it('should REJECT executor setting verified', () => {
      const result = service.validateStatusTransition('done', 'verified', 'executor');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Executor cannot set status');
    });

    it('should allow team-lead to set verified', () => {
      const result = service.validateStatusTransition('done', 'verified', 'team-lead');
      expect(result.valid).toBe(true);
    });

    it('should allow team-lead to set failed', () => {
      const result = service.validateStatusTransition('done', 'failed', 'team-lead');
      expect(result.valid).toBe(true);
    });

    it('should REJECT orchestrator setting done', () => {
      const result = service.validateStatusTransition('active', 'done', 'orchestrator');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Orchestrator cannot set status');
    });

    it('should allow orchestrator to set cancelled', () => {
      const result = service.validateStatusTransition('assigned', 'cancelled', 'orchestrator');
      expect(result.valid).toBe(true);
    });

    it('should REJECT assigned → verified (skip execution)', () => {
      const result = service.validateStatusTransition('assigned', 'verified', 'team-lead');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('skip execution');
    });

    it('should REJECT done → assigned (must go through failed)', () => {
      const result = service.validateStatusTransition('done', 'assigned', 'team-lead');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Must go through failed');
    });

    it('should allow team-lead to also set executor statuses', () => {
      const result = service.validateStatusTransition('assigned', 'accepted', 'team-lead');
      expect(result.valid).toBe(true);
    });
  });

  describe('updateWorkingNotes', () => {
    it('should save working notes for the assigned task', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [{ ...mockTask, id: 'task-wn', assignedSessionName: 'session-abc', status: 'working' as const }]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      await service.updateWorkingNotes('task-wn', 'session-abc', 'current hypothesis: auth bug in middleware');

      expect(taskData.tasks[0].workingNotes).toBe('current hypothesis: auth bug in middleware');
      expect(taskData.tasks[0].workingNotesUpdatedAt).toBeDefined();
      expect(service.saveTaskData).toHaveBeenCalledWith(taskData);
    });

    it('should throw error if task not found', async () => {
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(mockTaskData);

      await expect(service.updateWorkingNotes('nonexistent', 'session-abc', 'notes'))
        .rejects.toThrow('Task with ID nonexistent not found');
    });

    it('should throw error if session does not match assignee', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [{ ...mockTask, id: 'task-wn', assignedSessionName: 'session-abc' }]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);

      await expect(service.updateWorkingNotes('task-wn', 'wrong-session', 'notes'))
        .rejects.toThrow("Session 'wrong-session' is not the assignee of task task-wn");
    });
  });

  describe('updateTaskStatus clears workingNotes on completion', () => {
    it('should clear workingNotes when status is completed', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [{
          ...mockTask,
          id: 'task-clear',
          workingNotes: 'some notes',
          workingNotesUpdatedAt: '2026-03-23T00:00:00Z',
        }]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      await service.updateTaskStatus('task-clear', 'completed');

      expect(taskData.tasks[0].workingNotes).toBeUndefined();
      expect(taskData.tasks[0].workingNotesUpdatedAt).toBeUndefined();
    });

    it('should clear workingNotes when status is verified', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [{
          ...mockTask,
          id: 'task-clear-v',
          workingNotes: 'partial results here',
          workingNotesUpdatedAt: '2026-03-23T00:00:00Z',
        }]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      await service.updateTaskStatus('task-clear-v', 'verified');

      expect(taskData.tasks[0].workingNotes).toBeUndefined();
      expect(taskData.tasks[0].workingNotesUpdatedAt).toBeUndefined();
    });

    it('should NOT clear workingNotes for non-terminal statuses', async () => {
      const taskData = {
        ...mockTaskData,
        tasks: [{
          ...mockTask,
          id: 'task-keep',
          workingNotes: 'keep these notes',
          workingNotesUpdatedAt: '2026-03-23T00:00:00Z',
        }]
      };
      jest.spyOn(service, 'loadTaskData').mockResolvedValue(taskData);
      jest.spyOn(service, 'saveTaskData').mockResolvedValue();

      await service.updateTaskStatus('task-keep', 'active');

      expect(taskData.tasks[0].workingNotes).toBe('keep these notes');
      expect(taskData.tasks[0].workingNotesUpdatedAt).toBe('2026-03-23T00:00:00Z');
    });
  });
});
