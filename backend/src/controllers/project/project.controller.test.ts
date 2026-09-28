import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Request, Response } from 'express';
import * as projectsHandlers from './project.controller.js';
import type { ApiContext } from '../types.js';
import { StorageService, TmuxService, SchedulerService } from '../../services/index.js';
import { ActiveProjectsService } from '../../services/index.js';
import { PromptTemplateService } from '../../services/index.js';

// Mock dependencies
jest.mock('../../services/index.js');
jest.mock('../../models/index.js');
jest.mock('../utils/file-utils.js');
jest.mock('fs/promises');
jest.mock('fs');
jest.mock('path');
jest.mock('util');
jest.mock('child_process');
jest.mock('node-pty', () => ({ spawn: jest.fn() }));

describe('Projects Handlers', () => {
  let mockApiContext: ApiContext;
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockStorageService: jest.Mocked<StorageService>;
  let mockActiveProjectsService: jest.Mocked<ActiveProjectsService>;
  let responseMock: {
    status: jest.Mock<any>;
    json: jest.Mock<any>;
    send: jest.Mock<any>;
  };

  const mockProject = {
    id: 'project-123',
    name: 'Test Project',
    path: '/test/project/path',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create response mock
    responseMock = {
      status: jest.fn<any>().mockReturnThis(),
      json: jest.fn<any>().mockReturnThis(),
      send: jest.fn<any>().mockReturnThis(),
    };

    // Mock services
    mockStorageService = new StorageService() as jest.Mocked<StorageService>;
    mockActiveProjectsService = new ActiveProjectsService() as jest.Mocked<ActiveProjectsService>;

    // Setup API context
    mockApiContext = {
      storageService: mockStorageService,
      tmuxService: new TmuxService() as jest.Mocked<TmuxService>,
      schedulerService: new SchedulerService(new StorageService()) as jest.Mocked<SchedulerService>,
      activeProjectsService: mockActiveProjectsService,
      promptTemplateService: new PromptTemplateService() as jest.Mocked<PromptTemplateService>,
      agentRegistrationService: {} as any,
      taskTrackingService: {} as any,
    };

    mockRequest = {};
    mockResponse = responseMock as any;

    // Setup default mock returns - controller uses getProjects().find() pattern
    mockStorageService.getProjects.mockResolvedValue([mockProject]);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('createProject', () => {
    it('should create project successfully with path only', async () => {
      mockRequest.body = {
        path: '/new/project/path'
      };

      const newProject = {
        id: 'new-project-id',
        name: 'New Project',
        path: '/new/project/path',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      } as any;

      mockStorageService.addProject.mockResolvedValue(newProject);
      mockStorageService.getOrchestratorStatus.mockResolvedValue(null as any);

      await projectsHandlers.createProject.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.addProject).toHaveBeenCalledWith('/new/project/path');
      expect(responseMock.status).toHaveBeenCalledWith(201);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: newProject,
          message: 'Project added successfully'
        })
      );
    });

    it('should return 400 when project path is missing', async () => {
      mockRequest.body = {
        name: 'No Path Project'
      };

      await projectsHandlers.createProject.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.addProject).not.toHaveBeenCalled();
      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Project path is required'
        })
      );
    });

    it('should handle storage service errors', async () => {
      mockRequest.body = {
        path: '/failing/project'
      };

      mockStorageService.addProject.mockRejectedValue(new Error('Storage failed'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation((() => {}) as any);

      await projectsHandlers.createProject.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error creating project'));
      expect(responseMock.status).toHaveBeenCalledWith(500);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to create project'
        })
      );

      consoleSpy.mockRestore();
    });
  });

  describe('getProjects', () => {
    it('should return all projects successfully', async () => {
      const projects = [
        mockProject,
        {
          id: 'project-456',
          name: 'Second Project',
          path: '/second/project',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as any
      ];

      mockStorageService.getProjects.mockResolvedValue(projects);

      await projectsHandlers.getProjects.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.getProjects).toHaveBeenCalled();
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: projects
        })
      );
    });

    it('should return empty array when no projects exist', async () => {
      mockStorageService.getProjects.mockResolvedValue([]);

      await projectsHandlers.getProjects.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: []
        })
      );
    });

    it('should handle storage service errors when getting projects', async () => {
      mockStorageService.getProjects.mockRejectedValue(new Error('Database connection failed'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation((() => {}) as any);

      await projectsHandlers.getProjects.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error getting projects'));
      expect(responseMock.status).toHaveBeenCalledWith(500);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to retrieve projects'
        })
      );

      consoleSpy.mockRestore();
    });
  });

  describe('getProject', () => {
    it('should return specific project successfully', async () => {
      mockRequest.params = { id: 'project-123' };

      await projectsHandlers.getProject.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.getProjects).toHaveBeenCalled();
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: mockProject
        })
      );
    });

    it('should return 404 when project not found', async () => {
      mockRequest.params = { id: 'nonexistent-project' };

      await projectsHandlers.getProject.call(
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

    it('should handle storage service errors when getting single project', async () => {
      mockRequest.params = { id: 'project-123' };
      mockStorageService.getProjects.mockRejectedValue(new Error('Database query failed'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation((() => {}) as any);

      await projectsHandlers.getProject.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error getting project'));
      expect(responseMock.status).toHaveBeenCalledWith(500);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to retrieve project'
        })
      );

      consoleSpy.mockRestore();
    });
  });

  describe('deleteProject', () => {
    it('should delete project successfully', async () => {
      mockRequest.params = { id: 'project-123' };

      mockStorageService.deleteProject.mockResolvedValue(undefined as any);
      mockStorageService.getTeams.mockResolvedValue([]);
      mockStorageService.getScheduledMessages.mockResolvedValue([]);

      await projectsHandlers.deleteProject.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.getProjects).toHaveBeenCalled();
      expect(mockStorageService.deleteProject).toHaveBeenCalledWith('project-123');
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should return 404 when project not found for deletion', async () => {
      mockRequest.params = { id: 'nonexistent-project' };

      await projectsHandlers.deleteProject.call(
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

  describe('Input validation', () => {
    it('should handle missing parameters gracefully', async () => {
      mockRequest.params = {};

      await projectsHandlers.getProject.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.getProjects).toHaveBeenCalled();
    });

    it('should handle null request body', async () => {
      mockRequest.body = null;

      await projectsHandlers.createProject.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(500);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to create project'
        })
      );
    });

    it('should handle empty project path', async () => {
      mockRequest.body = { path: '' };

      await projectsHandlers.createProject.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Project path is required'
        })
      );
    });
  });

  describe('Integration', () => {
    it('should properly coordinate between storage and active projects services', async () => {
      expect(mockApiContext.storageService).toBe(mockStorageService);
      expect(mockApiContext.activeProjectsService).toBe(mockActiveProjectsService);
    });
  });
});
