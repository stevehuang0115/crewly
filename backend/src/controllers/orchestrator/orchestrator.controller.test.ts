// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Request, Response } from 'express';
import * as orchestratorHandlers from './orchestrator.controller.js';
import { MemoryService } from '../../services/memory/memory.service.js';

// Mock MemoryService
jest.mock('../../services/memory/memory.service.js', () => ({
  MemoryService: {
    getInstance: jest.fn().mockReturnValue({
      initializeForSession: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

// Mock terminal gateway
jest.mock('../../websocket/terminal.gateway.js', () => ({
  getTerminalGateway: jest.fn().mockReturnValue({
    startOrchestratorChatMonitoring: jest.fn(),
    broadcastOrchestratorStatus: jest.fn(),
  }),
}));

// Mock orchestrator status service
jest.mock('../../services/orchestrator/index.js', () => ({
  getOrchestratorStatus: jest.fn().mockResolvedValue({
    isActive: true,
    agentStatus: 'active',
    message: 'Orchestrator is running',
  }),
  getOrchestratorOfflineMessage: jest.fn().mockReturnValue('Orchestrator is offline'),
}));

// Mock session backend for list_sessions command
jest.mock('../../services/session/index.js', () => ({
  getSessionBackendSync: jest.fn().mockReturnValue({
    listSessions: jest.fn().mockReturnValue(['session-1', 'session-2']),
  }),
}));

import { getOrchestratorStatus as mockGetOrchestratorStatusFn } from '../../services/orchestrator/index.js';
import type { ApiContext } from '../types.js';
import { CREWLY_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

const mockGetOrchestratorStatus = mockGetOrchestratorStatusFn as jest.MockedFunction<typeof mockGetOrchestratorStatusFn>;

describe('Orchestrator Handlers', () => {
  let mockApiContext: Partial<ApiContext>;
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockStorageService: any;
  let mockAgentRegistrationService: any;
  let mockPromptTemplateService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockStorageService = {
      getTeams: jest.fn(),
      getProjects: jest.fn(),
      updateAgentStatus: jest.fn(),
      getOrchestratorStatus: jest.fn().mockResolvedValue({ runtimeType: 'claude-code' }),
    };

    mockAgentRegistrationService = {
      sendMessageToAgent: jest.fn(),
      sendKeyToAgent: jest.fn(),
      createAgentSession: jest.fn(),
      terminateAgentSession: jest.fn(),
      checkAgentHealth: jest.fn(),
    };

    mockPromptTemplateService = {
      getOrchestratorTaskAssignmentPrompt: jest.fn()
    };

    mockApiContext = {
      storageService: mockStorageService,
      agentRegistrationService: mockAgentRegistrationService,
      promptTemplateService: mockPromptTemplateService
    } as any;

    mockRequest = {
      params: { projectId: 'project-1' },
      body: {
        command: 'help',
        message: 'Test message',
        taskId: 'task-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        taskPriority: 'high',
        taskMilestone: 'milestone-1',
        projectName: 'Test Project',
        projectPath: '/test/path'
      },
      query: {}
    };

    mockResponse = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis()
    };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('getOrchestratorCommands', () => {
    it('should return mock orchestrator commands', async () => {
      await orchestratorHandlers.getOrchestratorCommands.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith([
        expect.objectContaining({
          id: '1',
          command: 'get_team_status',
          status: 'completed'
        }),
        expect.objectContaining({
          id: '2',
          command: 'delegate_task dev-alice "Implement user auth"',
          status: 'completed'
        })
      ]);
    });

    it('should handle errors and return empty array', async () => {
      const originalConsoleError = console.error;
      console.error = jest.fn();

      // Force an error by making res.json throw on first call,
      // then work normally for the error handler's res.status().json() call
      const errorResponse = {
        json: jest.fn().mockImplementationOnce(() => { throw new Error('json error'); }),
        status: jest.fn().mockReturnThis(),
      };

      await orchestratorHandlers.getOrchestratorCommands.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        errorResponse as unknown as Response
      );

      expect(errorResponse.status).toHaveBeenCalledWith(500);
      expect(errorResponse.json).toHaveBeenCalledWith([]);

      console.error = originalConsoleError;
    });
  });

  describe('executeOrchestratorCommand', () => {
    it('should execute get_team_status command', async () => {
      const mockTeams = [
        {
          name: 'Dev Team',
          members: [
            { agentStatus: 'active', name: 'Alice' },
            { agentStatus: 'inactive', name: 'Bob' }
          ],
          projectIds: ['Test Project']
        },
        {
          name: 'QA Team',
          members: [
            { agentStatus: 'activating', name: 'Charlie' }
          ],
          projectIds: []
        }
      ];

      mockStorageService.getTeams.mockResolvedValue(mockTeams);
      mockRequest.body = { command: 'get_team_status' };

      await orchestratorHandlers.executeOrchestratorCommand.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.getTeams).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        output: expect.stringContaining('Team Status Report:'),
        timestamp: expect.any(String)
      });
    });

    it('should execute list_projects command', async () => {
      const mockProjects = [
        {
          name: 'Project A',
          status: 'active',
          teams: { development: ['team-1'], testing: ['team-2'] }
        },
        {
          name: 'Project B',
          status: 'completed',
          teams: { development: ['team-3'] }
        }
      ];

      mockStorageService.getProjects.mockResolvedValue(mockProjects);
      mockRequest.body = { command: 'list_projects' };

      await orchestratorHandlers.executeOrchestratorCommand.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.getProjects).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        output: expect.stringContaining('Active Projects:'),
        timestamp: expect.any(String)
      });
    });

    it('should execute broadcast command', async () => {
      mockRequest.body = { command: 'broadcast Hello team' };

      await orchestratorHandlers.executeOrchestratorCommand.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        output: 'Broadcast sent to all active sessions: "Hello team"',
        timestamp: expect.any(String)
      });
    });

    it('should execute help command', async () => {
      mockRequest.body = { command: 'help' };

      await orchestratorHandlers.executeOrchestratorCommand.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        output: expect.stringContaining('Available Orchestrator Commands:'),
        timestamp: expect.any(String)
      });
    });

    it('should handle unknown commands', async () => {
      mockRequest.body = { command: 'unknown_command' };

      await orchestratorHandlers.executeOrchestratorCommand.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        output: expect.stringContaining('Unknown command: unknown_command'),
        timestamp: expect.any(String)
      });
    });

    it('should handle broadcast command without message', async () => {
      mockRequest.body = { command: 'broadcast' };

      await orchestratorHandlers.executeOrchestratorCommand.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        output: 'Error: No message provided for broadcast',
        timestamp: expect.any(String)
      });
    });

    it('should return 400 when command is missing', async () => {
      mockRequest.body = {};

      await orchestratorHandlers.executeOrchestratorCommand.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Command is required'
      });
    });

    it('should return 400 when command is not a string', async () => {
      mockRequest.body = { command: 123 };

      await orchestratorHandlers.executeOrchestratorCommand.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Command is required'
      });
    });

    it('should handle storage service errors', async () => {
      mockStorageService.getTeams.mockRejectedValue(new Error('Storage error'));
      mockRequest.body = { command: 'get_team_status' };

      await orchestratorHandlers.executeOrchestratorCommand.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to execute command',
        output: expect.stringContaining('Error: Storage error')
      });
    });
  });

  describe('sendOrchestratorMessage', () => {
    it('should send message to orchestrator successfully', async () => {
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({
        success: true,
        message: 'Message delivered',
      });

      await orchestratorHandlers.sendOrchestratorMessage.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        ORCHESTRATOR_SESSION_NAME,
        'Test message'
      );
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Message sent to orchestrator successfully',
        messageLength: 12,
        timestamp: expect.any(String)
      });
    });

    it('should return 400 when message sending fails', async () => {
      mockRequest.body = {};
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({
        success: false,
        error: 'Message is required and must be a string',
      });

      await orchestratorHandlers.sendOrchestratorMessage.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Message is required and must be a string',
      });
    });

    it('should return 400 when message is not a string', async () => {
      mockRequest.body = { message: 123 };
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({
        success: false,
        error: 'Message is required and must be a string',
      });

      await orchestratorHandlers.sendOrchestratorMessage.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Message is required and must be a string',
      });
    });

    it('should handle agentRegistrationService errors', async () => {
      mockAgentRegistrationService.sendMessageToAgent.mockRejectedValue(new Error('Service error'));

      await orchestratorHandlers.sendOrchestratorMessage.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Service error'
      });
    });
  });

  describe('sendOrchestratorEnter', () => {
    it('should send Enter key to orchestrator successfully', async () => {
      mockAgentRegistrationService.sendKeyToAgent.mockResolvedValue({
        success: true,
        message: 'Key sent',
      });

      await orchestratorHandlers.sendOrchestratorEnter.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockAgentRegistrationService.sendKeyToAgent).toHaveBeenCalledWith(
        ORCHESTRATOR_SESSION_NAME,
        'Enter'
      );
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Enter key sent to orchestrator',
        timestamp: expect.any(String)
      });
    });

    it('should handle agentRegistrationService errors when sending Enter key', async () => {
      mockAgentRegistrationService.sendKeyToAgent.mockRejectedValue(new Error('Send key error'));

      await orchestratorHandlers.sendOrchestratorEnter.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Send key error'
      });
    });

    it('should return 500 when sendKeyToAgent returns failure', async () => {
      mockAgentRegistrationService.sendKeyToAgent.mockResolvedValue({
        success: false,
        error: 'Session does not exist',
      });

      await orchestratorHandlers.sendOrchestratorEnter.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Session does not exist',
      });
    });
  });

  describe('setupOrchestrator', () => {
    afterEach(() => {
      // Reset in-flight state between tests
      orchestratorHandlers._resetSetupInFlightState();
    });

    it('should skip setup when orchestrator is already healthy and running', async () => {
      // Default mock returns isActive: true
      mockGetOrchestratorStatus.mockResolvedValue({
        isActive: true,
        agentStatus: 'active',
        message: 'Orchestrator is active and ready.',
      });

      await orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Should NOT call createAgentSession since orchestrator is already healthy
      expect(mockAgentRegistrationService.createAgentSession).not.toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Orchestrator is already running (setup skipped)',
        sessionName: ORCHESTRATOR_SESSION_NAME,
      });
    });

    it('should proceed with setup when orchestrator is not active', async () => {
      mockGetOrchestratorStatus.mockResolvedValue({
        isActive: false,
        agentStatus: 'inactive',
        message: 'Orchestrator is not running.',
      });
      mockAgentRegistrationService.createAgentSession.mockResolvedValue({
        success: true,
        sessionName: ORCHESTRATOR_SESSION_NAME,
        message: 'Orchestrator created and registered successfully',
      });

      await orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockAgentRegistrationService.createAgentSession).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Orchestrator created and registered successfully',
        sessionName: ORCHESTRATOR_SESSION_NAME,
      });
    });

    it('should proceed with setup when health check fails', async () => {
      mockGetOrchestratorStatus.mockRejectedValue(new Error('Health check failed'));
      mockAgentRegistrationService.createAgentSession.mockResolvedValue({
        success: true,
        sessionName: ORCHESTRATOR_SESSION_NAME,
        message: 'Orchestrator created',
      });

      await orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Should still create session when health check fails
      expect(mockAgentRegistrationService.createAgentSession).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );
    });

    it('should setup orchestrator successfully via agentRegistrationService', async () => {
      // Orchestrator not active — triggers full setup
      mockGetOrchestratorStatus.mockResolvedValue({
        isActive: false,
        agentStatus: 'inactive',
        message: 'Orchestrator is not running.',
      });
      mockAgentRegistrationService.createAgentSession.mockResolvedValue({
        success: true,
        sessionName: ORCHESTRATOR_SESSION_NAME,
        message: 'Orchestrator created and registered successfully',
      });

      await orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.getOrchestratorStatus).toHaveBeenCalled();
      expect(mockAgentRegistrationService.createAgentSession).toHaveBeenCalledWith({
        sessionName: ORCHESTRATOR_SESSION_NAME,
        role: 'orchestrator',
        projectPath: process.cwd(),
        windowName: expect.any(String),
        runtimeType: 'claude-code',
        forceRecreate: true,
      });
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Orchestrator created and registered successfully',
        sessionName: ORCHESTRATOR_SESSION_NAME,
      });
    });

    it('should handle createAgentSession failure', async () => {
      mockGetOrchestratorStatus.mockResolvedValue({ isActive: false, agentStatus: 'inactive', message: '' });
      mockAgentRegistrationService.createAgentSession.mockResolvedValue({
        success: false,
        error: 'Session creation failed',
      });

      await orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Session creation failed',
      });
    });

    it('should handle unexpected setup errors', async () => {
      mockGetOrchestratorStatus.mockResolvedValue({ isActive: false, agentStatus: 'inactive', message: '' });
      mockAgentRegistrationService.createAgentSession.mockRejectedValue(new Error('Unexpected error'));

      await orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Unexpected error'
      });
    });

    it('should fall back to default runtime type when getOrchestratorStatus fails', async () => {
      mockGetOrchestratorStatus.mockResolvedValue({ isActive: false, agentStatus: 'inactive', message: '' });
      mockStorageService.getOrchestratorStatus.mockRejectedValue(new Error('Storage unavailable'));
      mockAgentRegistrationService.createAgentSession.mockResolvedValue({
        success: true,
        sessionName: ORCHESTRATOR_SESSION_NAME,
        message: 'Orchestrator created',
      });

      await orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Should still succeed with default claude-code runtime type
      expect(mockAgentRegistrationService.createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeType: 'claude-code',
        })
      );
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );
    });

    it('should use runtime type from storage when available', async () => {
      mockGetOrchestratorStatus.mockResolvedValue({ isActive: false, agentStatus: 'inactive', message: '' });
      mockStorageService.getOrchestratorStatus.mockResolvedValue({ runtimeType: 'gemini-cli' });
      mockAgentRegistrationService.createAgentSession.mockResolvedValue({
        success: true,
        sessionName: ORCHESTRATOR_SESSION_NAME,
        message: 'Orchestrator created',
      });
      // Mock getProjects for Gemini allowlist flow
      mockStorageService.getProjects.mockResolvedValue([]);

      await orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockAgentRegistrationService.createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeType: 'gemini-cli',
        })
      );
    });

    it('should deduplicate concurrent setup calls — createAgentSession called only once', async () => {
      mockGetOrchestratorStatus.mockResolvedValue({ isActive: false, agentStatus: 'inactive', message: '' });
      // Use a deferred promise to control when createAgentSession resolves
      let resolveSetup: (value: any) => void;
      const setupPromise = new Promise((resolve) => { resolveSetup = resolve; });
      mockAgentRegistrationService.createAgentSession.mockReturnValue(setupPromise);

      const res1 = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const res2 = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const res3 = { json: jest.fn(), status: jest.fn().mockReturnThis() };

      // Fire 3 concurrent calls
      const call1 = orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext, mockRequest as Request, res1 as any
      );
      const call2 = orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext, mockRequest as Request, res2 as any
      );
      const call3 = orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext, mockRequest as Request, res3 as any
      );

      // Resolve the setup
      resolveSetup!({
        success: true,
        sessionName: ORCHESTRATOR_SESSION_NAME,
        message: 'Orchestrator created',
      });

      await Promise.all([call1, call2, call3]);

      // createAgentSession must be called exactly once (not 3 times)
      expect(mockAgentRegistrationService.createAgentSession).toHaveBeenCalledTimes(1);

      // All 3 responses should get the success result
      expect(res1.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(res3.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('should allow new setup after previous one completes', async () => {
      mockGetOrchestratorStatus.mockResolvedValue({ isActive: false, agentStatus: 'inactive', message: '' });
      mockAgentRegistrationService.createAgentSession.mockResolvedValue({
        success: true,
        sessionName: ORCHESTRATOR_SESSION_NAME,
        message: 'Orchestrator created',
      });

      // First call
      await orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext, mockRequest as Request, mockResponse as Response
      );

      // Reset mock to track new calls
      mockAgentRegistrationService.createAgentSession.mockClear();
      mockAgentRegistrationService.createAgentSession.mockResolvedValue({
        success: true,
        sessionName: ORCHESTRATOR_SESSION_NAME,
        message: 'Orchestrator created again',
      });

      const res2 = { json: jest.fn(), status: jest.fn().mockReturnThis() };

      // Second call after first completed — should trigger a new setup
      await orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext, mockRequest as Request, res2 as any
      );

      expect(mockAgentRegistrationService.createAgentSession).toHaveBeenCalledTimes(1);
      expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('should propagate failure to deduplicated callers', async () => {
      mockGetOrchestratorStatus.mockResolvedValue({ isActive: false, agentStatus: 'inactive', message: '' });
      let resolveSetup: (value: any) => void;
      const setupPromise = new Promise((resolve) => { resolveSetup = resolve; });
      mockAgentRegistrationService.createAgentSession.mockReturnValue(setupPromise);

      const res1 = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const res2 = { json: jest.fn(), status: jest.fn().mockReturnThis() };

      const call1 = orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext, mockRequest as Request, res1 as any
      );
      const call2 = orchestratorHandlers.setupOrchestrator.call(
        mockApiContext as ApiContext, mockRequest as Request, res2 as any
      );

      resolveSetup!({
        success: false,
        error: 'Session creation failed',
      });

      await Promise.all([call1, call2]);

      // Both should get 500 error
      expect(res1.status).toHaveBeenCalledWith(500);
      expect(res2.status).toHaveBeenCalledWith(500);
      expect(res1.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
      expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });
  });

  describe('assignTaskToOrchestrator', () => {
    it('should assign task to orchestrator successfully', async () => {
      mockAgentRegistrationService.checkAgentHealth.mockResolvedValue({
        success: true,
        data: {
          agent: { running: true, status: 'active' },
          timestamp: new Date().toISOString(),
        },
      });
      mockPromptTemplateService.getOrchestratorTaskAssignmentPrompt.mockResolvedValue('Task assignment prompt');
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({
        success: true,
        message: 'Message delivered',
      });

      await orchestratorHandlers.assignTaskToOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockAgentRegistrationService.checkAgentHealth).toHaveBeenCalledWith(
        ORCHESTRATOR_SESSION_NAME,
        'orchestrator'
      );
      expect(mockPromptTemplateService.getOrchestratorTaskAssignmentPrompt).toHaveBeenCalledWith({
        projectName: 'Test Project',
        projectPath: '/test/path',
        taskId: 'task-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        taskPriority: 'high',
        taskMilestone: 'milestone-1'
      });
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        ORCHESTRATOR_SESSION_NAME,
        'Task assignment prompt'
      );
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Task assigned to orchestrator successfully',
        data: {
          taskId: 'task-123',
          taskTitle: 'Test Task',
          sessionName: ORCHESTRATOR_SESSION_NAME,
          assignedAt: expect.any(String)
        }
      });
    });

    it('should return 400 when taskId is missing', async () => {
      mockRequest.body = { taskTitle: 'Test Task' };

      await orchestratorHandlers.assignTaskToOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Task ID and title are required'
      });
    });

    it('should return 400 when taskTitle is missing', async () => {
      mockRequest.body = { taskId: 'task-123' };

      await orchestratorHandlers.assignTaskToOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Task ID and title are required'
      });
    });

    it('should return 400 when orchestrator session is not running', async () => {
      mockAgentRegistrationService.checkAgentHealth.mockResolvedValue({
        success: true,
        data: {
          agent: { running: false, status: 'inactive' },
          timestamp: new Date().toISOString(),
        },
      });

      await orchestratorHandlers.assignTaskToOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Orchestrator session is not running. Please start the orchestrator first.'
      });
    });

    it('should handle template service errors', async () => {
      mockAgentRegistrationService.checkAgentHealth.mockResolvedValue({
        success: true,
        data: {
          agent: { running: true, status: 'active' },
          timestamp: new Date().toISOString(),
        },
      });
      mockPromptTemplateService.getOrchestratorTaskAssignmentPrompt.mockRejectedValue(new Error('Template error'));

      await orchestratorHandlers.assignTaskToOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Template error'
      });
    });

    it('should handle message sending errors', async () => {
      mockAgentRegistrationService.checkAgentHealth.mockResolvedValue({
        success: true,
        data: {
          agent: { running: true, status: 'active' },
          timestamp: new Date().toISOString(),
        },
      });
      mockPromptTemplateService.getOrchestratorTaskAssignmentPrompt.mockResolvedValue('Prompt');
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({
        success: false,
        error: 'Failed to send task assignment to orchestrator',
      });

      await orchestratorHandlers.assignTaskToOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to send task assignment to orchestrator'
      });
    });
  });

  describe('Context preservation', () => {
    it('should preserve context when handling orchestrator operations', async () => {
      const contextAwareController = {
        agentRegistrationService: {
          sendKeyToAgent: jest.fn().mockResolvedValue({ success: true }),
        }
      } as any;

      await orchestratorHandlers.sendOrchestratorEnter.call(
        contextAwareController,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(contextAwareController.agentRegistrationService.sendKeyToAgent).toHaveBeenCalledWith(
        ORCHESTRATOR_SESSION_NAME,
        'Enter'
      );
    });
  });

  describe('stopOrchestrator', () => {
    it('should stop orchestrator successfully when session exists', async () => {
      mockAgentRegistrationService.terminateAgentSession.mockResolvedValue({
        success: true,
        message: 'Agent session terminated successfully',
      });

      await orchestratorHandlers.stopOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockAgentRegistrationService.terminateAgentSession).toHaveBeenCalledWith(
        ORCHESTRATOR_SESSION_NAME,
        'orchestrator'
      );
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Agent session terminated successfully',
        sessionName: ORCHESTRATOR_SESSION_NAME,
      });
    });

    it('should return success when orchestrator is already stopped', async () => {
      mockAgentRegistrationService.terminateAgentSession.mockResolvedValue({
        success: true,
        message: 'Agent session was already terminated',
      });

      await orchestratorHandlers.stopOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockAgentRegistrationService.terminateAgentSession).toHaveBeenCalledWith(
        ORCHESTRATOR_SESSION_NAME,
        'orchestrator'
      );
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Agent session was already terminated',
        sessionName: ORCHESTRATOR_SESSION_NAME,
      });
    });

    it('should handle errors when stopping orchestrator', async () => {
      mockAgentRegistrationService.terminateAgentSession.mockResolvedValue({
        success: false,
        error: 'Failed to kill session',
      });

      await orchestratorHandlers.stopOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to kill session',
      });
    });

    it('should handle unexpected errors when stopping orchestrator', async () => {
      mockAgentRegistrationService.terminateAgentSession.mockRejectedValue(
        new Error('Unexpected termination error')
      );

      await orchestratorHandlers.stopOrchestrator.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Unexpected termination error',
      });
    });
  });

  describe('All handlers availability', () => {
    it('should have all expected handler functions', () => {
      expect(typeof orchestratorHandlers.getOrchestratorCommands).toBe('function');
      expect(typeof orchestratorHandlers.executeOrchestratorCommand).toBe('function');
      expect(typeof orchestratorHandlers.sendOrchestratorMessage).toBe('function');
      expect(typeof orchestratorHandlers.sendOrchestratorEnter).toBe('function');
      expect(typeof orchestratorHandlers.setupOrchestrator).toBe('function');
      expect(typeof orchestratorHandlers.stopOrchestrator).toBe('function');
      expect(typeof orchestratorHandlers.assignTaskToOrchestrator).toBe('function');
    });

    it('should handle async operations properly', async () => {
      mockAgentRegistrationService.sendKeyToAgent.mockResolvedValue({ success: true });

      const result = await orchestratorHandlers.sendOrchestratorEnter.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(result).toBeUndefined();
      expect(mockResponse.json).toHaveBeenCalled();
    });
  });

  describe('Command execution edge cases', () => {
    it('should handle list_sessions command via session backend', async () => {
      mockRequest.body = { command: 'list_sessions' };

      await orchestratorHandlers.executeOrchestratorCommand.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        output: expect.stringContaining('Active terminal sessions:'),
        timestamp: expect.any(String)
      });
    });

    it('should handle empty team status', async () => {
      mockStorageService.getTeams.mockResolvedValue([]);
      mockRequest.body = { command: 'get_team_status' };

      await orchestratorHandlers.executeOrchestratorCommand.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        output: 'Team Status Report:\n',
        timestamp: expect.any(String)
      });
    });
  });

  describe('setupOrchestrator memory initialization', () => {
    afterEach(() => {
      orchestratorHandlers._resetSetupInFlightState();
    });

    it('should initialize orchestrator memory during setup', async () => {
      mockGetOrchestratorStatus.mockResolvedValue({ isActive: false, agentStatus: 'inactive', message: '' });
      // Re-setup mock since clearAllMocks resets the return value
      (MemoryService.getInstance as jest.Mock).mockReturnValue({
        initializeForSession: jest.fn<any>().mockResolvedValue(undefined),
      });

      const mockSetupStorage = {
        getTeams: jest.fn<any>().mockResolvedValue([]),
        getProjects: jest.fn<any>().mockResolvedValue([]),
        getOrchestratorStatus: jest.fn<any>().mockResolvedValue({ runtimeType: 'claude-code' }),
      };
      const mockSetupRegistration = {
        createAgentSession: jest.fn<any>().mockResolvedValue({
          success: true,
          sessionName: 'crewly-orc',
          message: 'Orchestrator created',
        }),
      };
      const setupContext = {
        storageService: mockSetupStorage,
        agentRegistrationService: mockSetupRegistration,
      } as any;

      await orchestratorHandlers.setupOrchestrator.call(
        setupContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Verify MemoryService.getInstance was called
      expect(MemoryService.getInstance).toHaveBeenCalled();

      // Verify initializeForSession was called with orchestrator params
      const memoryInstance = (MemoryService.getInstance as jest.Mock).mock.results[0]?.value as any;
      expect(memoryInstance.initializeForSession).toHaveBeenCalledWith(
        'crewly-orc',
        'orchestrator',
        process.cwd()
      );
    });

    it('should not fail setup if memory initialization fails', async () => {
      mockGetOrchestratorStatus.mockResolvedValue({ isActive: false, agentStatus: 'inactive', message: '' });
      // Make memory initialization throw
      (MemoryService.getInstance as jest.Mock).mockReturnValue({
        initializeForSession: jest.fn<any>().mockRejectedValue(new Error('Memory init failed')),
      });

      const mockFailStorage = {
        getTeams: jest.fn<any>().mockResolvedValue([]),
        getProjects: jest.fn<any>().mockResolvedValue([]),
        getOrchestratorStatus: jest.fn<any>().mockResolvedValue({ runtimeType: 'claude-code' }),
      };
      const mockFailRegistration = {
        createAgentSession: jest.fn<any>().mockResolvedValue({
          success: true,
          sessionName: 'crewly-orc',
          message: 'Orchestrator created',
        }),
      };
      const setupContext = {
        storageService: mockFailStorage,
        agentRegistrationService: mockFailRegistration,
      } as any;

      await orchestratorHandlers.setupOrchestrator.call(
        setupContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Setup should still succeed despite memory init failure
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );
    });
  });

  describe('getOrchestratorStatus', () => {
    it('should have the status endpoint function exported', () => {
      expect(typeof orchestratorHandlers.getOrchestratorStatus).toBe('function');
    });
  });

  /**
   * PUT /api/orchestrator/runtime — extended in P1 (cloud_pro_v2) to accept
   * an optional modelId alongside the existing runtimeType. Tests cover
   * each combination of present/absent/invalid fields.
   */
  describe('updateOrchestratorRuntime', () => {
    beforeEach(() => {
      mockStorageService.updateOrchestratorRuntimeType = jest.fn().mockResolvedValue(undefined);
      mockStorageService.updateOrchestratorModelId = jest.fn().mockResolvedValue(undefined);
    });

    it('updates runtimeType only when modelId is absent', async () => {
      mockRequest.body = { runtimeType: 'crewly-agent' };

      await orchestratorHandlers.updateOrchestratorRuntime.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockStorageService.updateOrchestratorRuntimeType).toHaveBeenCalledWith('crewly-agent');
      expect(mockStorageService.updateOrchestratorModelId).not.toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ runtimeType: 'crewly-agent' }),
        })
      );
    });

    it('updates modelId only when runtimeType is absent', async () => {
      mockRequest.body = { modelId: 'deepseek/deepseek-chat' };

      await orchestratorHandlers.updateOrchestratorRuntime.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockStorageService.updateOrchestratorModelId).toHaveBeenCalledWith('deepseek/deepseek-chat');
      expect(mockStorageService.updateOrchestratorRuntimeType).not.toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ modelId: 'deepseek/deepseek-chat' }),
        })
      );
    });

    it('updates both runtimeType and modelId in a single request', async () => {
      mockRequest.body = {
        runtimeType: 'crewly-agent',
        modelId: 'anthropic/claude-sonnet-4-20250514',
      };

      await orchestratorHandlers.updateOrchestratorRuntime.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockStorageService.updateOrchestratorRuntimeType).toHaveBeenCalledWith('crewly-agent');
      expect(mockStorageService.updateOrchestratorModelId).toHaveBeenCalledWith('anthropic/claude-sonnet-4-20250514');
      const responseBody = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(responseBody.data.runtimeType).toBe('crewly-agent');
      expect(responseBody.data.modelId).toBe('anthropic/claude-sonnet-4-20250514');
    });

    it('rejects with 400 when neither field is provided', async () => {
      mockRequest.body = {};

      await orchestratorHandlers.updateOrchestratorRuntime.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockStorageService.updateOrchestratorRuntimeType).not.toHaveBeenCalled();
      expect(mockStorageService.updateOrchestratorModelId).not.toHaveBeenCalled();
    });

    it('rejects with 400 when both fields are empty strings', async () => {
      mockRequest.body = { runtimeType: '', modelId: '' };

      await orchestratorHandlers.updateOrchestratorRuntime.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('rejects with 400 for invalid runtimeType', async () => {
      mockRequest.body = { runtimeType: 'not-a-real-runtime' };

      await orchestratorHandlers.updateOrchestratorRuntime.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockStorageService.updateOrchestratorRuntimeType).not.toHaveBeenCalled();
    });

    it('rejects with 400 for malformed modelId (no slash)', async () => {
      mockRequest.body = { modelId: 'gibberish' };

      await orchestratorHandlers.updateOrchestratorRuntime.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockStorageService.updateOrchestratorModelId).not.toHaveBeenCalled();
    });

    it('rejects with 400 for modelId with unsupported provider', async () => {
      // Format passes regex (provider/modelId) but provider is not in MODEL_PROVIDERS,
      // so parseModelId() falls back to DEFAULT_MODEL — controller must catch this.
      mockRequest.body = { modelId: 'fakeprovider/some-model' };

      await orchestratorHandlers.updateOrchestratorRuntime.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockStorageService.updateOrchestratorModelId).not.toHaveBeenCalled();
    });

    it('accepts the canonical default modelId without flagging it as invalid', async () => {
      // Edge case: when the input equals provider/modelId of DEFAULT_MODEL,
      // parseModelId() returns the default — but that's correct, not a fallback.
      mockRequest.body = { modelId: 'google/gemini-3-flash-preview' };

      await orchestratorHandlers.updateOrchestratorRuntime.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockResponse.status).not.toHaveBeenCalledWith(400);
      expect(mockStorageService.updateOrchestratorModelId).toHaveBeenCalledWith('google/gemini-3-flash-preview');
    });

    it('returns 500 when storage write fails', async () => {
      mockStorageService.updateOrchestratorModelId.mockRejectedValueOnce(new Error('disk full'));
      mockRequest.body = { modelId: 'deepseek/deepseek-chat' };

      await orchestratorHandlers.updateOrchestratorRuntime.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
    });
  });
});
