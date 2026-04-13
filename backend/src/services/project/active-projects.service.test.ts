import { ActiveProjectsService, ActiveProject, ActiveProjectsData } from './active-projects.service';
import { StorageService } from '../core/storage.service';
import { ScheduledMessageModel } from '../../models/ScheduledMessage';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock dependencies
jest.mock('fs/promises');
jest.mock('fs', () => ({
  existsSync: jest.fn()
}));
jest.mock('path');
jest.mock('os');
jest.mock('../core/storage.service');
jest.mock('../ai/prompt-template.service');
jest.mock('../../models/ScheduledMessage');

describe('ActiveProjectsService', () => {
  let service: ActiveProjectsService;
  let mockStorageService: jest.Mocked<StorageService>;
  let mockMessageSchedulerService: any;
  const mockActiveProjectsPath = '/mock/home/.crewly/active_projects.json';

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock path.join to return consistent path
    (path.join as jest.Mock).mockReturnValue(mockActiveProjectsPath);
    (os.homedir as jest.Mock).mockReturnValue('/mock/home');

    mockStorageService = new StorageService() as jest.Mocked<StorageService>;
    mockMessageSchedulerService = {
      deleteScheduledMessage: jest.fn(),
      cancelMessage: jest.fn(),
      scheduleMessage: jest.fn()
    };

    service = new ActiveProjectsService(mockStorageService);
  });

  describe('constructor', () => {
    it('should initialize with correct path', () => {
      expect(path.join).toHaveBeenCalledWith('/mock/home', '.crewly', 'active_projects.json');
    });

    it('should work without storage service', () => {
      const serviceWithoutStorage = new ActiveProjectsService();
      expect(serviceWithoutStorage).toBeDefined();
    });
  });

  describe('loadActiveProjectsData', () => {
    it('should create initial data if file does not exist', async () => {
      (fsSync.existsSync as jest.Mock).mockReturnValue(false);
      const mockSaveData = jest.spyOn(service, 'saveActiveProjectsData').mockResolvedValue();

      const result = await service.loadActiveProjectsData();

      expect(result).toEqual({
        activeProjects: [],
        lastUpdated: expect.any(String),
        version: '1.0.0'
      });
      expect(mockSaveData).toHaveBeenCalledWith(result);
    });

    it('should load existing data from file', async () => {
      const mockData: ActiveProjectsData = {
        activeProjects: [
          {
            projectId: 'test-project',
            status: 'running',
            startedAt: '2023-01-01T00:00:00.000Z'
          }
        ],
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      };

      (fsSync.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockData));

      const result = await service.loadActiveProjectsData();

      expect(result).toEqual(mockData);
      expect(fs.readFile).toHaveBeenCalledWith(mockActiveProjectsPath, 'utf-8');
    });

    it('should return default data on error', async () => {
      (fsSync.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFile as jest.Mock).mockRejectedValue(new Error('File read error'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const result = await service.loadActiveProjectsData();

      expect(result).toEqual({
        activeProjects: [],
        lastUpdated: expect.any(String),
        version: '1.0.0'
      });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error loading active projects data'));
    });
  });

  describe('saveActiveProjectsData', () => {
    it('should save data with updated timestamp', async () => {
      const mockData: ActiveProjectsData = {
        activeProjects: [],
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      };

      (path.dirname as jest.Mock).mockReturnValue('/mock/home/.crewly');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      await service.saveActiveProjectsData(mockData);

      expect(mockData.lastUpdated).not.toBe('2023-01-01T00:00:00.000Z');
      expect(fs.mkdir).toHaveBeenCalledWith('/mock/home/.crewly', { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        mockActiveProjectsPath,
        JSON.stringify(mockData, null, 2),
        'utf-8'
      );
    });

    it('should throw error on save failure', async () => {
      const mockData: ActiveProjectsData = {
        activeProjects: [],
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      };

      (path.dirname as jest.Mock).mockReturnValue('/mock/home/.crewly');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockRejectedValue(new Error('Write error'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(service.saveActiveProjectsData(mockData)).rejects.toThrow('Write error');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error saving active projects data'));
    });
  });

  describe('startProject', () => {
    beforeEach(() => {
      jest.spyOn(service, 'loadActiveProjectsData').mockResolvedValue({
        activeProjects: [],
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      });
      jest.spyOn(service, 'saveActiveProjectsData').mockResolvedValue();
    });

    it('should start a new project', async () => {
      const result = await service.startProject('test-project');

      expect(result).toEqual({
        checkInScheduleId: undefined
      });
      expect(service.saveActiveProjectsData).toHaveBeenCalledWith({
        activeProjects: [{
          projectId: 'test-project',
          status: 'running',
          startedAt: expect.any(String)
        }],
        lastUpdated: expect.any(String),
        version: '1.0.0'
      });
    });

    it('should throw error if project is already running', async () => {
      jest.spyOn(service, 'loadActiveProjectsData').mockResolvedValue({
        activeProjects: [{
          projectId: 'test-project',
          status: 'running',
          startedAt: '2023-01-01T00:00:00.000Z'
        }],
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      });

      await expect(service.startProject('test-project')).rejects.toThrow('Project is already running');
    });

    it('should restart stopped project', async () => {
      jest.spyOn(service, 'loadActiveProjectsData').mockResolvedValue({
        activeProjects: [{
          projectId: 'test-project',
          status: 'stopped',
          startedAt: '2023-01-01T00:00:00.000Z',
          stoppedAt: '2023-01-01T01:00:00.000Z'
        }],
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      });

      await service.startProject('test-project');

      expect(service.saveActiveProjectsData).toHaveBeenCalledWith({
        activeProjects: [{
          projectId: 'test-project',
          status: 'running',
          startedAt: expect.any(String)
        }],
        lastUpdated: expect.any(String),
        version: '1.0.0'
      });
    });

    it('should create scheduled messages when messageSchedulerService provided', async () => {
      const mockScheduledMessage = { id: 'mock-schedule-id' };
      (ScheduledMessageModel.create as jest.Mock).mockReturnValue(mockScheduledMessage);
      mockStorageService.saveScheduledMessage.mockResolvedValue();

      const result = await service.startProject('test-project', mockMessageSchedulerService);

      expect(result.checkInScheduleId).toBe('mock-schedule-id');
      expect(mockStorageService.saveScheduledMessage).toHaveBeenCalledTimes(1);
      expect(mockMessageSchedulerService.scheduleMessage).toHaveBeenCalledTimes(1);
    });

    it('should continue without scheduled messages if creation fails', async () => {
      (ScheduledMessageModel.create as jest.Mock).mockImplementation(() => {
        throw new Error('Schedule creation error');
      });

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const result = await service.startProject('test-project', mockMessageSchedulerService);

      expect(result.checkInScheduleId).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to create scheduled messages for project'));
    });
  });

  describe('stopProject', () => {
    const mockActiveProject: ActiveProject = {
      projectId: 'test-project',
      status: 'running',
      startedAt: '2023-01-01T00:00:00.000Z',
      checkInScheduleId: 'checkin-id'
    };

    beforeEach(() => {
      jest.spyOn(service, 'loadActiveProjectsData').mockResolvedValue({
        activeProjects: [mockActiveProject],
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      });
      jest.spyOn(service, 'saveActiveProjectsData').mockResolvedValue();
    });

    it('should stop running project', async () => {
      await service.stopProject('test-project');

      expect(service.saveActiveProjectsData).toHaveBeenCalledWith({
        activeProjects: [{
          projectId: 'test-project',
          status: 'stopped',
          startedAt: '2023-01-01T00:00:00.000Z',
          stoppedAt: expect.any(String)
        }],
        lastUpdated: expect.any(String),
        version: '1.0.0'
      });
    });

    it('should throw error if project not found', async () => {
      jest.spyOn(service, 'loadActiveProjectsData').mockResolvedValue({
        activeProjects: [],
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      });

      await expect(service.stopProject('nonexistent-project')).rejects.toThrow('Project not found in active projects');
    });

    it('should cancel scheduled messages when messageSchedulerService provided', async () => {
      // Reset the mock and ensure proper setup
      mockMessageSchedulerService.cancelMessage.mockClear();

      // Explicitly ensure the mock data has the schedule IDs
      jest.spyOn(service, 'loadActiveProjectsData').mockResolvedValue({
        activeProjects: [{
          projectId: 'test-project',
          status: 'running',
          startedAt: '2023-01-01T00:00:00.000Z',
          checkInScheduleId: 'checkin-id'
        }],
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      });

      await service.stopProject('test-project', mockMessageSchedulerService);

      expect(mockMessageSchedulerService.cancelMessage).toHaveBeenCalledWith('checkin-id');
      expect(mockMessageSchedulerService.cancelMessage).toHaveBeenCalledTimes(1);
    });

    it('should continue if cancelling scheduled messages fails', async () => {
      // Explicitly ensure the mock data has the schedule IDs
      jest.spyOn(service, 'loadActiveProjectsData').mockResolvedValue({
        activeProjects: [{
          projectId: 'test-project',
          status: 'running',
          startedAt: '2023-01-01T00:00:00.000Z',
          checkInScheduleId: 'checkin-id'
        }],
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      });

      mockMessageSchedulerService.cancelMessage.mockImplementation(() => {
        throw new Error('Cancel error');
      });
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      await service.stopProject('test-project', mockMessageSchedulerService);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to cancel scheduled messages for project'));
      expect(service.saveActiveProjectsData).toHaveBeenCalled();
    });
  });

  describe('restartProject', () => {
    it('should stop then start project', async () => {
      const stopSpy = jest.spyOn(service, 'stopProject').mockResolvedValue();
      const startSpy = jest.spyOn(service, 'startProject').mockResolvedValue({
        checkInScheduleId: 'new-checkin-id'
      });

      const result = await service.restartProject('test-project', mockMessageSchedulerService);

      expect(stopSpy).toHaveBeenCalledWith('test-project', mockMessageSchedulerService);
      expect(startSpy).toHaveBeenCalledWith('test-project', mockMessageSchedulerService);
      expect(result).toEqual({
        checkInScheduleId: 'new-checkin-id'
      });
    });

    it('should continue with start if stop fails', async () => {
      const stopSpy = jest.spyOn(service, 'stopProject').mockRejectedValue(new Error('Stop error'));
      const startSpy = jest.spyOn(service, 'startProject').mockResolvedValue({});
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();

      await service.restartProject('test-project', mockMessageSchedulerService);

      expect(stopSpy).toHaveBeenCalled();
      expect(startSpy).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Project was not running, starting fresh'));
    });
  });

  describe('getActiveProjects', () => {
    it('should return only running projects', async () => {
      jest.spyOn(service, 'loadActiveProjectsData').mockResolvedValue({
        activeProjects: [
          { projectId: 'project-1', status: 'running', startedAt: '2023-01-01T00:00:00.000Z' },
          { projectId: 'project-2', status: 'stopped', startedAt: '2023-01-01T00:00:00.000Z', stoppedAt: '2023-01-01T01:00:00.000Z' },
          { projectId: 'project-3', status: 'running', startedAt: '2023-01-01T02:00:00.000Z' }
        ],
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      });

      const result = await service.getActiveProjects();

      expect(result).toHaveLength(2);
      expect(result.map(p => p.projectId)).toEqual(['project-1', 'project-3']);
    });
  });

  describe('getAllProjects', () => {
    it('should return all projects', async () => {
      const mockProjects = [
        { projectId: 'project-1', status: 'running', startedAt: '2023-01-01T00:00:00.000Z' },
        { projectId: 'project-2', status: 'stopped', startedAt: '2023-01-01T00:00:00.000Z', stoppedAt: '2023-01-01T01:00:00.000Z' }
      ] as ActiveProject[];

      jest.spyOn(service, 'loadActiveProjectsData').mockResolvedValue({
        activeProjects: mockProjects,
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      });

      const result = await service.getAllProjects();

      expect(result).toEqual(mockProjects);
    });
  });

  describe('getProjectStatus', () => {
    it('should return project if found', async () => {
      const mockProject: ActiveProject = {
        projectId: 'test-project',
        status: 'running',
        startedAt: '2023-01-01T00:00:00.000Z'
      };

      jest.spyOn(service, 'loadActiveProjectsData').mockResolvedValue({
        activeProjects: [mockProject],
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      });

      const result = await service.getProjectStatus('test-project');

      expect(result).toEqual(mockProject);
    });

    it('should return null if project not found', async () => {
      jest.spyOn(service, 'loadActiveProjectsData').mockResolvedValue({
        activeProjects: [],
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      });

      const result = await service.getProjectStatus('nonexistent-project');

      expect(result).toBeNull();
    });
  });

  describe('isProjectRunning', () => {
    it('should return true for running project', async () => {
      jest.spyOn(service, 'getProjectStatus').mockResolvedValue({
        projectId: 'test-project',
        status: 'running',
        startedAt: '2023-01-01T00:00:00.000Z'
      });

      const result = await service.isProjectRunning('test-project');

      expect(result).toBe(true);
    });

    it('should return false for stopped project', async () => {
      jest.spyOn(service, 'getProjectStatus').mockResolvedValue({
        projectId: 'test-project',
        status: 'stopped',
        startedAt: '2023-01-01T00:00:00.000Z',
        stoppedAt: '2023-01-01T01:00:00.000Z'
      });

      const result = await service.isProjectRunning('test-project');

      expect(result).toBe(false);
    });

    it('should return false for nonexistent project', async () => {
      jest.spyOn(service, 'getProjectStatus').mockResolvedValue(null);

      const result = await service.isProjectRunning('nonexistent-project');

      expect(result).toBe(false);
    });
  });

  describe('cleanupStoppedProjects', () => {
    it('should remove old stopped projects', async () => {
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
      const recentDate = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(); // 6 days ago

      jest.spyOn(service, 'loadActiveProjectsData').mockResolvedValue({
        activeProjects: [
          { projectId: 'old-stopped', status: 'stopped', startedAt: '2023-01-01T00:00:00.000Z', stoppedAt: oldDate },
          { projectId: 'recent-stopped', status: 'stopped', startedAt: '2023-01-01T00:00:00.000Z', stoppedAt: recentDate },
          { projectId: 'running', status: 'running', startedAt: '2023-01-01T00:00:00.000Z' }
        ],
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      });
      jest.spyOn(service, 'saveActiveProjectsData').mockResolvedValue();

      const result = await service.cleanupStoppedProjects(7);

      expect(result).toBe(1); // Only old-stopped should be removed
      expect(service.saveActiveProjectsData).toHaveBeenCalledWith({
        activeProjects: [
          { projectId: 'recent-stopped', status: 'stopped', startedAt: '2023-01-01T00:00:00.000Z', stoppedAt: recentDate },
          { projectId: 'running', status: 'running', startedAt: '2023-01-01T00:00:00.000Z' }
        ],
        lastUpdated: expect.any(String),
        version: '1.0.0'
      });
    });
  });
});
