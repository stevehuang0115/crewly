import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Router } from 'express';
import { createProjectRouter } from './project.routes.js';
import type { ApiContext } from '../types.js';

describe('Project Routes', () => {
  let mockContext: ApiContext;
  let router: Router;

  beforeEach(() => {
    mockContext = {
      storageService: {
        getProjects: jest.fn(),
        saveProject: jest.fn(),
        deleteProject: jest.fn(),
        addProject: jest.fn(),
        getTeams: jest.fn(),
        saveTeam: jest.fn(),
        getScheduledMessages: jest.fn()
      },
      tmuxService: {
        sessionExists: jest.fn(),
        createOrchestratorSession: jest.fn(),
        sendMessage: jest.fn(),
        killSession: jest.fn(),
        listSessions: jest.fn(),
        capturePane: jest.fn()
      },
      schedulerService: {
        scheduleDefaultCheckins: jest.fn(),
        cancelAllChecksForSession: jest.fn()
      },
      messageSchedulerService: {
        scheduleMessage: jest.fn(),
        cancelMessage: jest.fn()
      },
      activeProjectsService: {
        startProject: jest.fn(),
        stopProject: jest.fn(),
        restartProject: jest.fn()
      },
      promptTemplateService: {
        getOrchestratorTaskAssignmentPrompt: jest.fn(),
        getAutoAssignmentPrompt: jest.fn(),
        getProjectStartPrompt: jest.fn()
      },
      taskAssignmentMonitor: {
        monitorTask: jest.fn()
      },
      taskTrackingService: {
        getAllInProgressTasks: jest.fn()
      }
    } as any;

    router = createProjectRouter(mockContext);
  });

  it('should create router with project routes', () => {
    expect(router).toBeDefined();
    expect(router.stack).toBeDefined();
    expect(router.stack.length).toBeGreaterThan(0);
  });

  it('should have POST route for creating projects', () => {
    const postRoutes = router.stack.filter(layer =>
      layer.route && (layer.route as any).methods.post
    );
    expect(postRoutes.length).toBeGreaterThan(0);
  });

  it('should have GET routes for retrieving projects', () => {
    const getRoutes = router.stack.filter(layer =>
      layer.route && (layer.route as any).methods.get
    );
    expect(getRoutes.length).toBeGreaterThan(0);
  });

  it('should have DELETE route for project deletion', () => {
    const deleteRoutes = router.stack.filter(layer =>
      layer.route && (layer.route as any).methods.delete
    );
    expect(deleteRoutes.length).toBeGreaterThan(0);
  });
});
