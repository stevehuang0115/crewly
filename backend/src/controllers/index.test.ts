import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Router } from 'express';
import { createApiRouter } from './index.js';
import type { ApiContext } from './types.js';

describe('Main Controller Router', () => {
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
        deleteTeam: jest.fn(),
        getScheduledMessages: jest.fn(),
        saveScheduledMessage: jest.fn(),
        getOrchestratorStatus: jest.fn(),
        updateOrchestratorStatus: jest.fn()
      },
      tmuxService: {
        sessionExists: jest.fn(),
        createOrchestratorSession: jest.fn(),
        sendMessage: jest.fn(),
        sendKey: jest.fn(),
        killSession: jest.fn(),
        listSessions: jest.fn(),
        capturePane: jest.fn(),
        createTeamMemberSession: jest.fn(),
        initializeAgentWithRegistration: jest.fn(),
        initializeOrchestrator: jest.fn()
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
      },
      agentRegistrationService: {
        getRegisteredAgents: jest.fn(),
        sendMessageToAgent: jest.fn()
      }
    } as any;

    router = createApiRouter(mockContext);
  });

  it('should create main API router', () => {
    expect(router).toBeDefined();
    expect(router.stack).toBeDefined();
    expect(router.stack.length).toBeGreaterThan(0);
  });

  it('should mount project routes at /projects', () => {
    const projectRoute = router.stack.find(layer => 
      layer.regexp.test('/projects')
    );
    expect(projectRoute).toBeDefined();
  });

  it('should mount team routes at /teams', () => {
    const teamRoute = router.stack.find(layer => 
      layer.regexp.test('/teams')
    );
    expect(teamRoute).toBeDefined();
  });

  it('should mount orchestrator routes at /orchestrator', () => {
    const orchestratorRoute = router.stack.find(layer => 
      layer.regexp.test('/orchestrator')
    );
    expect(orchestratorRoute).toBeDefined();
  });

  it('should mount monitoring routes at /monitoring', () => {
    const monitoringRoute = router.stack.find(layer => 
      layer.regexp.test('/monitoring')
    );
    expect(monitoringRoute).toBeDefined();
  });

  it('should mount system routes at /system', () => {
    const systemRoute = router.stack.find(layer =>
      layer.regexp.test('/system')
    );
    expect(systemRoute).toBeDefined();
  });

  it('should mount settings routes at /settings', () => {
    const settingsRoute = router.stack.find(layer =>
      layer.regexp.test('/settings')
    );
    expect(settingsRoute).toBeDefined();
  });

  it('should mount chat routes at /chat', () => {
    const chatRoute = router.stack.find(layer =>
      layer.regexp.test('/chat')
    );
    expect(chatRoute).toBeDefined();
  });

  it('should mount skill routes at /skills', () => {
    const skillRoute = router.stack.find(layer =>
      layer.regexp.test('/skills')
    );
    expect(skillRoute).toBeDefined();
  });
});