import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Request, Response } from 'express';
import * as gitHandlers from './git.controller.js';
import type { ApiContext } from '../types.js';
import { StorageService, TmuxService, SchedulerService, MessageSchedulerService } from '../../services/index.js';
import { ActiveProjectsService } from '../../services/index.js';
import { PromptTemplateService } from '../../services/index.js';
import { GitIntegrationService } from '../../services/index.js';

// Mock dependencies
jest.mock('../../services/index.js');

describe('Git Handlers', () => {
  let mockApiContext: ApiContext;
  let mockRequest: Partial<Request>;
  let mockResponse: any;
  let mockStorageService: jest.Mocked<StorageService>;
  let mockGitIntegrationService: jest.Mocked<GitIntegrationService>;
  let responseMock: {
    status: jest.Mock<any>;
    json: jest.Mock<any>;
    send: jest.Mock<any>;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).gitServices = {};

    // Create response mock
    responseMock = {
      status: jest.fn<any>().mockReturnThis(),
      json: jest.fn<any>().mockReturnThis(),
      send: jest.fn<any>().mockReturnThis(),
    };

    // Mock services
    mockStorageService = new StorageService() as jest.Mocked<StorageService>;
    mockGitIntegrationService = new GitIntegrationService('/mock/path') as jest.Mocked<GitIntegrationService>;

    // Mock GitIntegrationService constructor
    (GitIntegrationService as jest.MockedClass<typeof GitIntegrationService>).mockImplementation(() => mockGitIntegrationService);

    // Setup API context
    mockApiContext = {
      storageService: mockStorageService,
      tmuxService: new TmuxService() as jest.Mocked<TmuxService>,
      schedulerService: new SchedulerService(new StorageService()) as jest.Mocked<SchedulerService>,
      messageSchedulerService: {} as jest.Mocked<MessageSchedulerService>,
      activeProjectsService: new ActiveProjectsService() as jest.Mocked<ActiveProjectsService>,
      promptTemplateService: new PromptTemplateService() as jest.Mocked<PromptTemplateService>,
      agentRegistrationService: {} as any,
      taskTrackingService: {} as any,
    };

    mockRequest = {};
    mockResponse = responseMock as any;

    // Setup default mock returns
    mockStorageService.getProjects.mockResolvedValue([
      {
        id: 'project-123',
        name: 'Test Project',
        path: '/test/project/path',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      } as any
    ]);

    mockGitIntegrationService.isGitRepository.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('getGitStatus', () => {
    it('should return git status successfully', async () => {
      const mockStatus = {
        hasChanges: true,
        branch: 'main',
        ahead: 0,
        behind: 0,
        staged: ['file1.js'],
        unstaged: ['file2.js'],
        untracked: ['file3.js']
      };
      const mockStats = {
        totalCommits: 42,
        contributors: 3,
        branches: 5,
      };
      const mockLastCommit = {
        hash: 'abc123',
        message: 'Last commit message',
        author: 'Test Author',
        date: new Date('2024-01-01T00:00:00.000Z'),
      };

      mockRequest.params = { projectId: 'project-123' };
      (mockGitIntegrationService.getGitStatus as jest.Mock<any>).mockResolvedValue(mockStatus);
      (mockGitIntegrationService.getRepositoryStats as jest.Mock<any>).mockResolvedValue(mockStats);
      (mockGitIntegrationService.getLastCommitInfo as jest.Mock<any>).mockResolvedValue(mockLastCommit);

      await gitHandlers.getGitStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.getProjects).toHaveBeenCalled();
      expect(GitIntegrationService).toHaveBeenCalledWith('/test/project/path');
      expect(mockGitIntegrationService.isGitRepository).toHaveBeenCalled();
      expect(mockGitIntegrationService.getGitStatus).toHaveBeenCalled();
      expect(mockGitIntegrationService.getRepositoryStats).toHaveBeenCalled();
      expect(mockGitIntegrationService.getLastCommitInfo).toHaveBeenCalled();

      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: {
            status: mockStatus,
            stats: mockStats,
            lastCommit: mockLastCommit
          }
        })
      );
    });

    it('should return 404 when project not found', async () => {
      mockRequest.params = { projectId: 'nonexistent-project' };

      await gitHandlers.getGitStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(404);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Project not found'
        })
      );
    });

    it('should return 400 when project is not a git repository', async () => {
      mockRequest.params = { projectId: 'project-123' };
      mockGitIntegrationService.isGitRepository.mockResolvedValue(false);

      await gitHandlers.getGitStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Not a git repository'
        })
      );
    });

    it('should handle git service errors', async () => {
      mockRequest.params = { projectId: 'project-123' };
      (mockGitIntegrationService.getGitStatus as jest.Mock<any>).mockRejectedValue(new Error('Git command failed'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation((() => {}) as any);

      await gitHandlers.getGitStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error getting git status'));
      expect(responseMock.status).toHaveBeenCalledWith(500);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to get git status'
        })
      );

      consoleSpy.mockRestore();
    });
  });

  describe('commitChanges', () => {
    it('should commit changes successfully', async () => {
      const mockCommitResult = 'abc123';

      mockRequest.params = { projectId: 'project-123' };
      mockRequest.body = {
        message: 'Test commit message',
        includeUntracked: true,
        dryRun: false
      };

      (mockGitIntegrationService.commit as jest.Mock<any>).mockResolvedValue(mockCommitResult);

      await gitHandlers.commitChanges.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockGitIntegrationService.commit).toHaveBeenCalledWith({
        message: 'Test commit message',
        includeUntracked: true,
        dryRun: false
      });

      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: mockCommitResult
        })
      );
    });

    it('should return 404 when project not found for commit', async () => {
      mockRequest.params = { projectId: 'nonexistent-project' };
      mockRequest.body = { message: 'Test commit' };

      await gitHandlers.commitChanges.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(404);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Project not found'
        })
      );
    });

    it('should return 400 when project is not a git repository for commit', async () => {
      mockRequest.params = { projectId: 'project-123' };
      mockRequest.body = { message: 'Test commit' };
      mockGitIntegrationService.isGitRepository.mockResolvedValue(false);

      await gitHandlers.commitChanges.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Not a git repository'
        })
      );
    });

    it('should handle commit errors', async () => {
      mockRequest.params = { projectId: 'project-123' };
      mockRequest.body = { message: 'Test commit' };
      (mockGitIntegrationService.commit as jest.Mock<any>).mockRejectedValue(new Error('Nothing to commit'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation((() => {}) as any);

      await gitHandlers.commitChanges.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error committing changes'));
      expect(responseMock.status).toHaveBeenCalledWith(500);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to commit changes'
        })
      );

      consoleSpy.mockRestore();
    });
  });

  describe('startAutoCommit', () => {
    it('should start auto commit successfully', async () => {
      mockRequest.params = { projectId: 'project-123' };
      mockRequest.body = { intervalMinutes: 30 };

      (mockGitIntegrationService.startAutoCommitTimer as jest.Mock<any>).mockResolvedValue(undefined);

      await gitHandlers.startAutoCommit.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockGitIntegrationService.startAutoCommitTimer).toHaveBeenCalledWith(30);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should return 404 when project not found for auto commit', async () => {
      mockRequest.params = { projectId: 'nonexistent-project' };
      mockRequest.body = { intervalMinutes: 30 };

      await gitHandlers.startAutoCommit.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(404);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Project not found'
        })
      );
    });

    it('should handle auto commit start errors', async () => {
      mockRequest.params = { projectId: 'project-123' };
      mockRequest.body = { intervalMinutes: 30 };
      (mockGitIntegrationService.startAutoCommitTimer as jest.Mock<any>).mockRejectedValue(new Error('Auto commit setup failed'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation((() => {}) as any);

      await gitHandlers.startAutoCommit.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error starting auto-commit'));
      expect(responseMock.status).toHaveBeenCalledWith(500);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to start auto-commit'
        })
      );

      consoleSpy.mockRestore();
    });
  });

  describe('stopAutoCommit', () => {
    it('should stop auto commit successfully', async () => {
      mockRequest.params = { projectId: 'project-123' };
      (global as any).gitServices = {
        'project-123': { stopAutoCommitTimer: jest.fn() }
      };

      await gitHandlers.stopAutoCommit.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should return success even when project not found for stopping auto commit', async () => {
      mockRequest.params = { projectId: 'nonexistent-project' };

      await gitHandlers.stopAutoCommit.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // stopAutoCommit uses global gitServices, not project lookup
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });
  });

  describe('Error handling', () => {
    it('should handle storage service errors when getting projects', async () => {
      mockRequest.params = { projectId: 'project-123' };
      mockStorageService.getProjects.mockRejectedValue(new Error('Database connection failed'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation((() => {}) as any);

      await gitHandlers.getGitStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error getting git status'));
      expect(responseMock.status).toHaveBeenCalledWith(500);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to get git status'
        })
      );

      consoleSpy.mockRestore();
    });

    it('should handle invalid parameters gracefully', async () => {
      mockRequest.params = {}; // Missing projectId

      await gitHandlers.getGitStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(404);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Project not found'
        })
      );
    });
  });

  describe('Integration', () => {
    it('should properly initialize GitIntegrationService with project path', async () => {
      mockRequest.params = { projectId: 'project-123' };
      (mockGitIntegrationService.getGitStatus as jest.Mock<any>).mockResolvedValue({} as any);
      (mockGitIntegrationService.getRepositoryStats as jest.Mock<any>).mockResolvedValue({} as any);
      (mockGitIntegrationService.getLastCommitInfo as jest.Mock<any>).mockResolvedValue({} as any);

      await gitHandlers.getGitStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(GitIntegrationService).toHaveBeenCalledWith('/test/project/path');
    });

    it('should call all required git operations for status', async () => {
      mockRequest.params = { projectId: 'project-123' };

      // Mock all the promises to resolve
      (mockGitIntegrationService.getGitStatus as jest.Mock<any>).mockResolvedValue({} as any);
      (mockGitIntegrationService.getRepositoryStats as jest.Mock<any>).mockResolvedValue({} as any);
      (mockGitIntegrationService.getLastCommitInfo as jest.Mock<any>).mockResolvedValue({} as any);

      await gitHandlers.getGitStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockGitIntegrationService.getGitStatus).toHaveBeenCalled();
      expect(mockGitIntegrationService.getRepositoryStats).toHaveBeenCalled();
      expect(mockGitIntegrationService.getLastCommitInfo).toHaveBeenCalled();
    });
  });
});
