import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Request, Response } from 'express';
import * as teamsHandlers from './team.controller.js';
import { setTeamControllerEventBusService } from './team.controller.js';
import type { ApiContext } from '../types.js';
import { StorageService, TmuxService, SchedulerService, MessageSchedulerService } from '../../services/index.js';
import { ActiveProjectsService } from '../../services/index.js';
import { PromptTemplateService } from '../../services/index.js';
import { Team, TeamMember } from '../../types/index.js';
import { CREWLY_CONSTANTS } from '../../constants.js';

// Mock dependencies
jest.mock('../../services/index.js');
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-123')
}));
jest.mock('fs/promises');
jest.mock('fs');
jest.mock('path');

const mockUpdateSessionId = jest.fn<any>();
jest.mock('../../services/session/index.js', () => ({
  getSessionBackendSync: jest.fn(),
  getSessionStatePersistence: jest.fn(() => ({
    updateSessionId: mockUpdateSessionId,
  })),
}));

const mockGetTeamWorkingStatus = jest.fn<any>();
jest.mock('../../services/monitoring/activity-monitor.service.js', () => ({
  ActivityMonitorService: {
    getInstance: jest.fn(() => ({
      getTeamWorkingStatus: mockGetTeamWorkingStatus,
    })),
  },
}));

const mockGetSettings = jest.fn<any>();
jest.mock('../../services/settings/settings.service.js', () => ({
  getSettingsService: jest.fn(() => ({
    getSettings: mockGetSettings,
  })),
}));

describe('Teams Handlers', () => {
  let mockApiContext: ApiContext;
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockStorageService: any;
  let mockTmuxService: any;
  let mockSchedulerService: any;
  let mockMessageSchedulerService: any;
  let mockActiveProjectsService: any;
  let mockPromptTemplateService: any;
  let responseMock: {
    status: jest.Mock<any>;
    json: jest.Mock<any>;
    send: jest.Mock<any>;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Re-setup the session mock implementation after clearAllMocks
    const { getSessionStatePersistence } = require('../../services/session/index.js');
    (getSessionStatePersistence as jest.Mock).mockReturnValue({
      updateSessionId: mockUpdateSessionId,
    });

    // Re-setup the ActivityMonitorService mock implementation after clearAllMocks
    const { ActivityMonitorService } = require('../../services/monitoring/activity-monitor.service.js');
    (ActivityMonitorService.getInstance as jest.Mock).mockReturnValue({
      getTeamWorkingStatus: mockGetTeamWorkingStatus,
    });

    // Re-setup the SettingsService mock implementation after clearAllMocks
    const { getSettingsService } = require('../../services/settings/settings.service.js');
    (getSettingsService as jest.Mock).mockReturnValue({
      getSettings: mockGetSettings,
    });

    // Default: settings return claude-code as defaultRuntime
    mockGetSettings.mockResolvedValue({
      general: { defaultRuntime: 'claude-code' },
    });

    // Create response mock
    responseMock = {
      status: jest.fn<any>().mockReturnThis(),
      json: jest.fn<any>().mockReturnThis(),
      send: jest.fn<any>().mockReturnThis(),
    };

    // Mock services using any to avoid TypeScript strict type checking
    mockStorageService = {
      getTeams: jest.fn<any>(),
      saveTeam: jest.fn<any>(),
      deleteTeam: jest.fn<any>(),
      getProjects: jest.fn<any>(),
      saveProject: jest.fn<any>(),
      getOrchestratorStatus: jest.fn<any>(),
      updateOrchestratorStatus: jest.fn<any>(),
    };

    mockTmuxService = {
      sessionExists: jest.fn<any>(),
      createTeamMemberSession: jest.fn<any>(),
      killSession: jest.fn<any>(),
      sendMessage: jest.fn<any>(),
      listSessions: jest.fn<any>(),
    };

    mockSchedulerService = {
      scheduleDefaultCheckins: jest.fn<any>(),
      cancelAllChecksForSession: jest.fn<any>()
    };

    mockMessageSchedulerService = {
      scheduleMessage: jest.fn<any>(),
      cancelMessage: jest.fn<any>()
    };

    mockActiveProjectsService = {
      startProject: jest.fn<any>()
    };

    mockPromptTemplateService = {
      getOrchestratorTaskAssignmentPrompt: jest.fn<any>()
    };

    // Setup API context
    mockApiContext = {
      storageService: mockStorageService,
      tmuxService: mockTmuxService,
      schedulerService: mockSchedulerService,
      messageSchedulerService: mockMessageSchedulerService,
      activeProjectsService: mockActiveProjectsService,
      promptTemplateService: mockPromptTemplateService,
      agentRegistrationService: { createAgentSession: jest.fn<any>() } as any,
      taskAssignmentMonitor: { monitorTask: jest.fn<any>() } as any,
      taskTrackingService: { getAllInProgressTasks: jest.fn<any>() } as any,
    };

    mockRequest = {};
    mockResponse = responseMock as any;

    // Setup default mock returns
    mockStorageService.getTeams.mockResolvedValue([]);
    mockStorageService.saveTeam.mockResolvedValue(undefined);
    mockGetTeamWorkingStatus.mockResolvedValue({
      orchestrator: { sessionName: 'crewly-orc', workingStatus: 'idle', lastActivityCheck: '', updatedAt: '' },
      teamMembers: {},
      metadata: { lastUpdated: '', version: '1' },
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('createTeam', () => {
    it('should create a team successfully with valid data', async () => {
      mockRequest.body = {
        name: 'Test Team',
        description: 'Test team description',
        members: [
          {
            name: 'John Doe',
            role: 'developer',
            systemPrompt: 'You are a developer'
          },
          {
            name: 'Jane Smith',
            role: 'tester',
            systemPrompt: 'You are a tester'
          }
        ],
        projectPath: '/test/project',
        projectIds: ['test-project']
      };

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.getTeams).toHaveBeenCalled();
      expect(mockStorageService.saveTeam).toHaveBeenCalled();
      expect(responseMock.status).toHaveBeenCalledWith(201);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should return 400 error when name is missing', async () => {
      mockRequest.body = {
        members: [
          {
            name: 'John Doe',
            role: 'developer',
            systemPrompt: 'You are a developer'
          }
        ]
      };

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Missing required fields: name and members array'
      });
    });

    it('should return 400 error when members array is empty', async () => {
      mockRequest.body = {
        name: 'Test Team',
        members: []
      };

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Missing required fields: name and members array'
      });
    });

    it('should return 400 error when member data is incomplete', async () => {
      mockRequest.body = {
        name: 'Test Team',
        members: [
          {
            name: 'John Doe',
            role: 'developer'
            // missing systemPrompt
          }
        ]
      };

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'All team members must have name, role, and systemPrompt'
      });
    });

    it('should return error when team name already exists', async () => {
      const existingTeam = {
        id: 'existing-team-id',
        name: 'Test Team',
        description: 'Existing team',
        members: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      mockStorageService.getTeams.mockResolvedValue([existingTeam]);

      mockRequest.body = {
        name: 'Test Team',
        members: [
          {
            name: 'John Doe',
            role: 'developer',
            systemPrompt: 'You are a developer'
          }
        ]
      };

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(409);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Team with name "Test Team" already exists'
      });
    });

    it('should handle storage service errors', async () => {
      mockStorageService.getTeams.mockRejectedValue(new Error('Database error'));

      mockRequest.body = {
        name: 'Test Team',
        members: [
          {
            name: 'John Doe',
            role: 'developer',
            systemPrompt: 'You are a developer'
          }
        ]
      };

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(500);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Database error'
      });
    });
  });

  describe('getTeams', () => {
    it('should return all teams successfully', async () => {
      const mockTeams = [
        {
          id: 'team-1',
          name: 'Team 1',
          description: 'First team',
          members: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        {
          id: 'team-2',
          name: 'Team 2',
          description: 'Second team',
          members: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ];

      mockStorageService.getTeams.mockResolvedValue(mockTeams);
      mockStorageService.getOrchestratorStatus.mockResolvedValue(null);

      await teamsHandlers.getTeams.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.getTeams).toHaveBeenCalled();
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should merge workingStatus from ActivityMonitorService', async () => {
      const mockTeams = [
        {
          id: 'team-1',
          name: 'Team 1',
          description: 'First team',
          members: [
            {
              id: 'member-1',
              name: 'Alice',
              sessionName: 'team-1-alice',
              role: 'developer',
              runtimeType: 'claude-code',
              systemPrompt: 'Test',
              agentStatus: 'active',
              workingStatus: 'idle',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ];

      mockStorageService.getTeams.mockResolvedValue(mockTeams);
      mockStorageService.getOrchestratorStatus.mockResolvedValue(null);
      mockGetTeamWorkingStatus.mockResolvedValue({
        orchestrator: { sessionName: 'crewly-orc', workingStatus: 'idle', lastActivityCheck: '', updatedAt: '' },
        teamMembers: {
          'team-1-alice': { sessionName: 'team-1-alice', teamMemberId: 'member-1', workingStatus: 'in_progress', lastActivityCheck: '', updatedAt: '' }
        },
        metadata: { lastUpdated: '', version: '1' },
      });

      await teamsHandlers.getTeams.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      const responseData = responseMock.json.mock.calls[0][0] as any;
      // The second team (index 1) is the regular team (index 0 is orchestrator)
      const regularTeam = responseData.data[1];
      expect(regularTeam.members[0].workingStatus).toBe('in_progress');
    });

    it('should handle storage service errors when getting teams', async () => {
      mockStorageService.getTeams.mockRejectedValue(new Error('Database connection failed'));

      await teamsHandlers.getTeams.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(500);
    });
  });

  describe('getTeam', () => {
    it('should return specific team successfully', async () => {
      const mockTeam = {
        id: 'team-123',
        name: 'Test Team',
        description: 'Test description',
        members: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      mockRequest.params = { id: 'team-123' };
      mockStorageService.getTeams.mockResolvedValue([mockTeam]);

      await teamsHandlers.getTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.getTeams).toHaveBeenCalled();
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should return 404 when team not found', async () => {
      mockRequest.params = { id: 'nonexistent-team' };
      mockStorageService.getTeams.mockResolvedValue([]);

      await teamsHandlers.getTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(404);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Team not found'
      });
    });

    it('should merge workingStatus from ActivityMonitorService for single team', async () => {
      const mockTeam = {
        id: 'team-123',
        name: 'Test Team',
        description: 'Test description',
        members: [
          {
            id: 'member-1',
            name: 'Alice',
            sessionName: 'team-123-alice',
            role: 'developer',
            runtimeType: 'claude-code',
            systemPrompt: 'Test',
            agentStatus: 'active',
            workingStatus: 'idle',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      mockRequest.params = { id: 'team-123' };
      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockGetTeamWorkingStatus.mockResolvedValue({
        orchestrator: { sessionName: 'crewly-orc', workingStatus: 'idle', lastActivityCheck: '', updatedAt: '' },
        teamMembers: {
          'team-123-alice': { sessionName: 'team-123-alice', teamMemberId: 'member-1', workingStatus: 'in_progress', lastActivityCheck: '', updatedAt: '' }
        },
        metadata: { lastUpdated: '', version: '1' },
      });

      // Mock session backend so the backend block executes and merges working status
      const { getSessionBackendSync } = require('../../services/session/index.js');
      (getSessionBackendSync as jest.Mock).mockReturnValue({
        sessionExists: jest.fn<any>().mockReturnValue(true),
      });

      await teamsHandlers.getTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      const responseData = responseMock.json.mock.calls[0][0] as any;
      expect(responseData.data.members[0].workingStatus).toBe('in_progress');
    });

    it('should handle storage service errors when getting single team', async () => {
      mockRequest.params = { id: 'team-123' };
      mockStorageService.getTeams.mockRejectedValue(new Error('Database query failed'));

      await teamsHandlers.getTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(500);
    });
  });

  describe('deleteTeam', () => {
    it('should delete team successfully', async () => {
      const mockTeam = {
        id: 'team-123',
        name: 'Test Team',
        members: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      mockRequest.params = { id: 'team-123' };
      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockStorageService.deleteTeam.mockResolvedValue(undefined);
      mockTmuxService.sessionExists.mockResolvedValue(false);

      await teamsHandlers.deleteTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.deleteTeam).toHaveBeenCalledWith('team-123');
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should return 404 when trying to delete non-existent team', async () => {
      mockRequest.params = { id: 'nonexistent-team' };
      mockStorageService.getTeams.mockResolvedValue([]);

      await teamsHandlers.deleteTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(404);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Team not found'
      });
    });

    it('should handle storage service errors when deleting team', async () => {
      const mockTeam = {
        id: 'team-123',
        name: 'Test Team',
        members: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      mockRequest.params = { id: 'team-123' };
      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockTmuxService.sessionExists.mockResolvedValue(false);
      mockStorageService.deleteTeam.mockRejectedValue(new Error('Delete operation failed'));

      await teamsHandlers.deleteTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(500);
    });
  });

  describe('Context binding', () => {
    it('should have access to all services through context', async () => {
      mockRequest.body = {
        name: 'Context Test Team',
        members: [
          {
            name: 'Test Member',
            role: 'developer',
            systemPrompt: 'Test prompt'
          }
        ]
      };

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Verify that the handler can access all context services
      expect(mockStorageService.getTeams).toHaveBeenCalled();
      expect(mockStorageService.saveTeam).toHaveBeenCalled();
    });

    it('should work with optional messageSchedulerService when available', async () => {
      // Test that handlers can work with or without optional services
      const contextWithoutScheduler = {
        ...mockApiContext,
        messageSchedulerService: undefined
      };

      mockRequest.body = {
        name: 'Test Team',
        members: [
          {
            name: 'Test Member',
            role: 'developer',
            systemPrompt: 'Test prompt'
          }
        ]
      };

      await teamsHandlers.createTeam.call(
        contextWithoutScheduler,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(201);
      expect(mockStorageService.saveTeam).toHaveBeenCalled();
    });
  });

  describe('Input validation', () => {
    it('should handle null request body by returning 500 due to destructuring error', async () => {
      // createTeam destructures req.body directly: const { name, ... } = req.body as CreateTeamRequestBody
      // When body is null, destructuring throws, caught by catch block returning 500
      mockRequest.body = null;

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(500);
    });

    it('should handle members that is not an array', async () => {
      mockRequest.body = {
        name: 'Test Team',
        members: 'not an array'
      };

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Missing required fields: name and members array'
      });
    });

    it('should validate each member in the array', async () => {
      mockRequest.body = {
        name: 'Test Team',
        members: [
          {
            name: 'Valid Member',
            role: 'developer',
            systemPrompt: 'Valid prompt'
          },
          {
            name: 'Invalid Member',
            role: 'tester'
            // missing systemPrompt
          }
        ]
      };

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'All team members must have name, role, and systemPrompt'
      });
    });
  });

  describe('createTeam - hierarchical teams', () => {
    let uuidCounter: number;

    beforeEach(() => {
      // Override uuid to return unique IDs for hierarchy wiring tests
      uuidCounter = 0;
      const { v4 } = require('uuid');
      (v4 as jest.Mock).mockImplementation(() => `hier-uuid-${++uuidCounter}`);
    });

    it('should create a hierarchical team with team-leader and workers', async () => {
      mockRequest.body = {
        name: 'Hierarchical Team',
        description: 'A team with hierarchy',
        hierarchical: true,
        members: [
          {
            name: 'Team Lead',
            role: 'team-leader',
            systemPrompt: 'You are a team leader',
          },
          {
            name: 'Worker 1',
            role: 'developer',
            systemPrompt: 'You are a developer',
          },
          {
            name: 'Worker 2',
            role: 'tester',
            systemPrompt: 'You are a tester',
          },
        ],
        projectPath: '/test/project',
      };

      let savedTeam: Team;
      mockStorageService.saveTeam.mockImplementation((team: Team) => {
        savedTeam = JSON.parse(JSON.stringify(team));
        return Promise.resolve();
      });

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(201);

      // Verify team-level hierarchy fields
      expect(savedTeam!.hierarchical).toBe(true);
      expect(savedTeam!.leaderId).toBeDefined();

      // Verify leader member
      const leader = savedTeam!.members.find(m => m.role === 'team-leader');
      expect(leader).toBeDefined();
      expect(leader!.hierarchyLevel).toBe(1);
      expect(leader!.canDelegate).toBe(true);
      expect(leader!.subordinateIds).toHaveLength(2);

      // Verify workers point to leader
      const workers = savedTeam!.members.filter(m => m.role !== 'team-leader');
      for (const worker of workers) {
        expect(worker.parentMemberId).toBe(leader!.id);
        expect(worker.hierarchyLevel).toBe(2);
      }

      // Verify leader's subordinateIds contain worker IDs
      expect(leader!.subordinateIds).toContain(workers[0].id);
      expect(leader!.subordinateIds).toContain(workers[1].id);
    });

    it('should reject hierarchical team without team-leader or canDelegate member', async () => {
      mockRequest.body = {
        name: 'Bad Hierarchical Team',
        hierarchical: true,
        members: [
          {
            name: 'Worker 1',
            role: 'developer',
            systemPrompt: 'You are a developer',
          },
          {
            name: 'Worker 2',
            role: 'tester',
            systemPrompt: 'You are a tester',
          },
        ],
      };

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Hierarchical teams require at least one team-leader or member with canDelegate=true',
      });
    });

    it('should accept canDelegate member as leader alternative', async () => {
      mockRequest.body = {
        name: 'Delegate Team',
        hierarchical: true,
        members: [
          {
            name: 'Senior Dev',
            role: 'developer',
            systemPrompt: 'You are a senior developer',
            canDelegate: true,
          },
          {
            name: 'Junior Dev',
            role: 'developer',
            systemPrompt: 'You are a junior developer',
          },
        ],
      };

      let savedTeam: Team;
      mockStorageService.saveTeam.mockImplementation((team: Team) => {
        savedTeam = JSON.parse(JSON.stringify(team));
        return Promise.resolve();
      });

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(201);

      const delegator = savedTeam!.members.find(m => m.canDelegate);
      expect(delegator).toBeDefined();
      expect(delegator!.subordinateIds).toHaveLength(1);
      expect(savedTeam!.leaderId).toBe(delegator!.id);
    });

    it('should store templateId on the team', async () => {
      mockRequest.body = {
        name: 'Template Team',
        hierarchical: true,
        templateId: 'core-engineering-v1',
        members: [
          {
            name: 'TL',
            role: 'team-leader',
            systemPrompt: 'You are a TL',
          },
          {
            name: 'Dev',
            role: 'developer',
            systemPrompt: 'You are a dev',
          },
        ],
      };

      let savedTeam: Team;
      mockStorageService.saveTeam.mockImplementation((team: Team) => {
        savedTeam = JSON.parse(JSON.stringify(team));
        return Promise.resolve();
      });

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(201);
      expect(savedTeam!.templateId).toBe('core-engineering-v1');
    });

    it('should NOT set hierarchy fields on non-hierarchical teams', async () => {
      mockRequest.body = {
        name: 'Flat Team',
        members: [
          {
            name: 'Dev 1',
            role: 'developer',
            systemPrompt: 'You are a developer',
          },
          {
            name: 'Dev 2',
            role: 'developer',
            systemPrompt: 'You are a developer',
          },
        ],
      };

      let savedTeam: Team;
      mockStorageService.saveTeam.mockImplementation((team: Team) => {
        savedTeam = JSON.parse(JSON.stringify(team));
        return Promise.resolve();
      });

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(201);
      expect(savedTeam!.hierarchical).toBeUndefined();
      expect(savedTeam!.leaderId).toBeUndefined();

      for (const member of savedTeam!.members) {
        expect(member.hierarchyLevel).toBeUndefined();
        expect(member.canDelegate).toBeUndefined();
        expect(member.subordinateIds).toBeUndefined();
        expect(member.parentMemberId).toBeUndefined();
      }
    });
  });

  describe('createTeam - parentTeamId', () => {
    it('should create a team with parentTeamId', async () => {
      const parentTeam = {
        id: 'parent-team-id',
        name: 'Parent Org',
        members: [],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockStorageService.getTeams.mockResolvedValue([parentTeam]);

      mockRequest.body = {
        name: 'Child Team',
        parentTeamId: 'parent-team-id',
        members: [
          {
            name: 'Dev',
            role: 'developer',
            systemPrompt: 'You are a developer',
          },
        ],
      };

      let savedTeam: any;
      mockStorageService.saveTeam.mockImplementation((team: any) => {
        savedTeam = JSON.parse(JSON.stringify(team));
        return Promise.resolve();
      });

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(201);
      expect(savedTeam.parentTeamId).toBe('parent-team-id');
    });

    it('should reject parentTeamId referencing non-existent team', async () => {
      mockStorageService.getTeams.mockResolvedValue([]);

      mockRequest.body = {
        name: 'Orphan Team',
        parentTeamId: 'non-existent-parent',
        members: [
          {
            name: 'Dev',
            role: 'developer',
            systemPrompt: 'You are a developer',
          },
        ],
      };

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Parent team with id "non-existent-parent" not found',
      });
    });

    it('should create top-level team without parentTeamId', async () => {
      mockRequest.body = {
        name: 'Standalone Team',
        members: [
          {
            name: 'Dev',
            role: 'developer',
            systemPrompt: 'You are a developer',
          },
        ],
      };

      let savedTeam: any;
      mockStorageService.saveTeam.mockImplementation((team: any) => {
        savedTeam = JSON.parse(JSON.stringify(team));
        return Promise.resolve();
      });

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(201);
      expect(savedTeam.parentTeamId).toBeUndefined();
    });
  });

  describe('updateTeam - parentTeamId', () => {
    it('should update parentTeamId on a team', async () => {
      const parentTeam = {
        id: 'parent-id',
        name: 'Parent Org',
        members: [],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const childTeam = {
        id: 'child-id',
        name: 'Child Team',
        members: [],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockStorageService.getTeams.mockResolvedValue([parentTeam, childTeam]);
      mockRequest.params = { id: 'child-id' };
      mockRequest.body = { parentTeamId: 'parent-id' };

      let savedTeam: any;
      mockStorageService.saveTeam.mockImplementation((team: any) => {
        savedTeam = JSON.parse(JSON.stringify(team));
        return Promise.resolve();
      });

      await teamsHandlers.updateTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );
      expect(savedTeam.parentTeamId).toBe('parent-id');
    });

    it('should remove parentTeamId when set to null', async () => {
      const childTeam = {
        id: 'child-id',
        name: 'Child Team',
        members: [],
        projectIds: [],
        parentTeamId: 'old-parent',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockStorageService.getTeams.mockResolvedValue([childTeam]);
      mockRequest.params = { id: 'child-id' };
      mockRequest.body = { parentTeamId: null };

      let savedTeam: any;
      mockStorageService.saveTeam.mockImplementation((team: any) => {
        savedTeam = JSON.parse(JSON.stringify(team));
        return Promise.resolve();
      });

      await teamsHandlers.updateTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );
      expect(savedTeam.parentTeamId).toBeUndefined();
    });

    it('should reject self-referencing parentTeamId', async () => {
      const team = {
        id: 'team-1',
        name: 'Self Ref',
        members: [],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockStorageService.getTeams.mockResolvedValue([team]);
      mockRequest.params = { id: 'team-1' };
      mockRequest.body = { parentTeamId: 'team-1' };

      await teamsHandlers.updateTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'A team cannot be its own parent',
      });
    });

    it('should reject circular parent reference', async () => {
      const teamA = {
        id: 'team-a',
        name: 'Team A',
        members: [],
        projectIds: [],
        parentTeamId: 'team-b',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const teamB = {
        id: 'team-b',
        name: 'Team B',
        members: [],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockStorageService.getTeams.mockResolvedValue([teamA, teamB]);
      mockRequest.params = { id: 'team-b' };
      mockRequest.body = { parentTeamId: 'team-a' };

      await teamsHandlers.updateTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // teamA.parentTeamId === 'team-b' and we're trying to set teamB.parentTeamId = 'team-a'
      // This should be rejected as circular
      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Circular parent reference detected',
      });
    });
  });

  describe('orchestrator team system protection', () => {
    it('should reject creating a team with parentTeamId=orchestrator', async () => {
      mockStorageService.getTeams.mockResolvedValue([]);

      mockRequest.body = {
        name: 'Bad Child',
        parentTeamId: 'orchestrator',
        members: [
          {
            name: 'Dev',
            role: 'developer',
            systemPrompt: 'You are a developer',
          },
        ],
      };

      await teamsHandlers.createTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Cannot use Orchestrator Team as parent — it is a system team',
      });
    });

    it('should reject updating parentTeamId to orchestrator', async () => {
      const team = {
        id: 'team-1',
        name: 'Some Team',
        members: [],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockStorageService.getTeams.mockResolvedValue([team]);
      mockRequest.params = { id: 'team-1' };
      mockRequest.body = { parentTeamId: 'orchestrator' };

      await teamsHandlers.updateTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Cannot use Orchestrator Team as parent — it is a system team',
      });
    });

    it('should reject setting parentTeamId on the orchestrator team itself', async () => {
      mockStorageService.getOrchestratorStatus.mockResolvedValue({
        agentStatus: 'active',
        sessionName: 'crewly-orc',
      });

      mockRequest.params = { id: 'orchestrator' };
      mockRequest.body = { parentTeamId: 'some-team' };

      await teamsHandlers.updateTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Cannot set parentTeamId on Orchestrator Team — it is a system team',
      });
    });
  });

  describe('deleteTeam - parentTeamId cascade', () => {
    it('should unset parentTeamId on child teams when parent is deleted', async () => {
      const parentTeam = {
        id: 'parent-id',
        name: 'Parent Org',
        members: [],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const childTeam = {
        id: 'child-id',
        name: 'Child Team',
        members: [],
        projectIds: [],
        parentTeamId: 'parent-id',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockStorageService.getTeams.mockResolvedValue([parentTeam, childTeam]);
      mockStorageService.deleteTeam.mockResolvedValue(undefined);
      mockTmuxService.sessionExists.mockResolvedValue(false);

      mockRequest.params = { id: 'parent-id' };

      const savedTeams: any[] = [];
      mockStorageService.saveTeam.mockImplementation((team: any) => {
        savedTeams.push(JSON.parse(JSON.stringify(team)));
        return Promise.resolve();
      });

      await teamsHandlers.deleteTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.deleteTeam).toHaveBeenCalledWith('parent-id');
      // Child team should have parentTeamId cleared
      const savedChild = savedTeams.find(t => t.id === 'child-id');
      expect(savedChild).toBeDefined();
      expect(savedChild.parentTeamId).toBeUndefined();
    });
  });

  describe('getDefaultRuntime (via createTeam and addTeamMember)', () => {
    it('should return configured default runtime from settings', async () => {
      // Configure settings to return gemini-cli as the default runtime
      mockGetSettings.mockResolvedValue({
        general: { defaultRuntime: 'gemini-cli' },
      });

      // Use addTeamMember which always calls getDefaultRuntime() (no runtimeType in body)
      const existingTeam: Team = {
        id: 'team-rt-1',
        name: 'Runtime Test Team',
        description: 'Team for runtime testing',
        members: [],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockStorageService.getTeams.mockResolvedValue([existingTeam]);
      mockRequest.params = { id: 'team-rt-1' };
      mockRequest.body = {
        name: 'New Agent',
        role: 'developer',
      };

      await teamsHandlers.addTeamMember.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            runtimeType: 'gemini-cli',
          }),
        })
      );
      expect(mockGetSettings).toHaveBeenCalled();
    });

    it('should fall back to claude-code when settings has no defaultRuntime', async () => {
      // Configure settings to return an empty/falsy defaultRuntime
      mockGetSettings.mockResolvedValue({
        general: { defaultRuntime: '' },
      });

      const existingTeam: Team = {
        id: 'team-rt-2',
        name: 'Fallback Test Team',
        description: 'Team for fallback testing',
        members: [],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockStorageService.getTeams.mockResolvedValue([existingTeam]);
      mockRequest.params = { id: 'team-rt-2' };
      mockRequest.body = {
        name: 'Fallback Agent',
        role: 'developer',
      };

      await teamsHandlers.addTeamMember.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            runtimeType: 'claude-code',
          }),
        })
      );
    });

    it('should fall back to claude-code when getSettings throws an error', async () => {
      // Configure settings to throw an error
      mockGetSettings.mockRejectedValue(new Error('Settings file not found'));

      const existingTeam: Team = {
        id: 'team-rt-3',
        name: 'Error Fallback Team',
        description: 'Team for error fallback testing',
        members: [],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockStorageService.getTeams.mockResolvedValue([existingTeam]);
      mockRequest.params = { id: 'team-rt-3' };
      mockRequest.body = {
        name: 'Error Agent',
        role: 'developer',
      };

      await teamsHandlers.addTeamMember.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Should still succeed with claude-code fallback
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            runtimeType: 'claude-code',
          }),
        })
      );
    });
  });

  describe('startTeam', () => {
    it('should set team members agentStatus to starting when starting', async () => {
      const mockTeam: Team = {
        id: 'team-123',
        name: 'Test Team',
        members: [
          {
            id: 'member-1',
            name: 'Alice',
            sessionName: 'crewly_alice',
            role: 'developer',
            runtimeType: 'claude-code',
            systemPrompt: 'Test prompt',
            agentStatus: 'inactive',
            workingStatus: 'idle',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: 'member-2',
            name: 'Bob',
            sessionName: 'crewly_bob',
            role: 'tester',
            runtimeType: 'claude-code',
            systemPrompt: 'Test prompt',
            agentStatus: 'inactive',
            workingStatus: 'idle',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      mockRequest.params = { id: 'team-123' };
      mockRequest.body = { projectId: 'project-1' };
      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockStorageService.getProjects.mockResolvedValue([{
        id: 'project-1',
        path: '/test/project',
        name: 'Test Project',
      }]);
      mockTmuxService.createTeamMemberSession.mockResolvedValue({ success: true, sessionName: 'test-session' });
      mockStorageService.saveTeam.mockResolvedValue(undefined);
      // Mock agentRegistrationService for startTeam
      mockApiContext.agentRegistrationService = {
        createAgentSession: jest.fn<any>().mockResolvedValue({ success: true, sessionName: 'test-session' })
      } as any;

      await teamsHandlers.startTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Verify team members were saved
      expect(mockStorageService.saveTeam).toHaveBeenCalled();
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should return 404 when team not found', async () => {
      mockRequest.params = { id: 'non-existent-team' };
      mockRequest.body = {};
      mockStorageService.getTeams.mockResolvedValue([]);

      await teamsHandlers.startTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(404);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Team not found'
      });
    });

    it('should skip already-active members instead of restarting them (#133)', async () => {
      const mockTeam: Team = {
        id: 'team-456',
        name: 'SteamFun',
        members: [
          {
            id: 'member-active',
            name: 'Nick',
            sessionName: 'steamfun-nick-38e207cb',
            role: 'developer',
            runtimeType: 'claude-code',
            systemPrompt: 'Test prompt',
            agentStatus: 'active',
            workingStatus: 'in_progress',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: 'member-inactive',
            name: 'Leo',
            sessionName: '',
            role: 'tester',
            runtimeType: 'claude-code',
            systemPrompt: 'Test prompt',
            agentStatus: 'inactive',
            workingStatus: 'idle',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      mockRequest.params = { id: 'team-456' };
      mockRequest.body = { projectId: 'project-1' };
      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockStorageService.getProjects.mockResolvedValue([{
        id: 'project-1',
        path: '/test/project',
        name: 'Test Project',
      }]);
      // Nick's session exists in tmux
      mockTmuxService.listSessions.mockResolvedValue([
        { sessionName: 'steamfun-nick-38e207cb' }
      ]);
      mockStorageService.saveTeam.mockResolvedValue(undefined);
      mockApiContext.agentRegistrationService = {
        createAgentSession: jest.fn<any>().mockResolvedValue({ success: true, sessionName: 'steamfun-leo-inactive1' })
      } as any;

      await teamsHandlers.startTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // createAgentSession should only be called for Leo (inactive), NOT for Nick (active)
      expect((mockApiContext.agentRegistrationService as any).createAgentSession).toHaveBeenCalledTimes(1);

      // Verify response includes Nick as already_running and Leo as started
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );

      // Nick's agentStatus should NOT have been changed to 'starting'
      const firstSave = (mockStorageService.saveTeam as jest.Mock).mock.calls[0]?.[0] as Team;
      const nickAfterSave = firstSave?.members.find(m => m.id === 'member-active');
      expect(nickAfterSave?.agentStatus).toBe('active');
    });
  });

  describe('registerMemberStatus', () => {
    it('should update team member agentStatus to active when agent registers', async () => {
      const mockTeam: Team = {
        id: 'team-123',
        name: 'Test Team',
        members: [
          {
            id: 'member-1',
            name: 'Alice',
            sessionName: 'crewly_alice',
            role: 'developer',
            runtimeType: 'claude-code',
            systemPrompt: 'Test prompt',
            agentStatus: 'activating',
            workingStatus: 'idle',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      mockRequest.body = {
        sessionName: 'crewly_alice',
        role: 'developer',
        status: 'active',
        registeredAt: new Date().toISOString(),
        memberId: 'member-1'
      };

      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockStorageService.saveTeam.mockResolvedValue(undefined);

      await teamsHandlers.registerMemberStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Verify member status was updated to 'active'
      expect(mockStorageService.saveTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          members: expect.arrayContaining([
            expect.objectContaining({
              id: 'member-1',
              agentStatus: 'active',
              workingStatus: 'idle',
              readyAt: expect.any(String)
            })
          ])
        })
      );

      expect(responseMock.json).toHaveBeenCalledWith({
        success: true,
        message: 'Agent crewly_alice registered as active with role developer',
        data: expect.objectContaining({
          sessionName: 'crewly_alice',
          role: 'developer',
          status: 'active'
        })
      });
    });

    it('should handle orchestrator registration correctly', async () => {
      mockRequest.body = {
        sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
        role: 'orchestrator',
        status: 'active',
        registeredAt: new Date().toISOString()
      };

      mockStorageService.updateOrchestratorStatus.mockResolvedValue(undefined);

      await teamsHandlers.registerMemberStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockStorageService.updateOrchestratorStatus).toHaveBeenCalledWith('active');
      expect(responseMock.json).toHaveBeenCalledWith({
        success: true,
        message: `Orchestrator ${CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME} registered as active`,
        sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME
      });
    });

    it('should find member by memberId when provided', async () => {
      const mockTeam: Team = {
        id: 'team-123',
        name: 'Test Team',
        members: [
          {
            id: 'member-1',
            name: 'Alice',
            sessionName: 'crewly_alice',
            role: 'developer',
            runtimeType: 'claude-code',
            systemPrompt: 'Test prompt',
            agentStatus: 'activating',
            workingStatus: 'idle',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      mockRequest.body = {
        sessionName: 'different_session_name',
        role: 'developer',
        status: 'active',
        memberId: 'member-1'
      };

      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockStorageService.saveTeam.mockResolvedValue(undefined);

      await teamsHandlers.registerMemberStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Should find member by ID; sessionName is preserved because freshMember.sessionName
      // already has a value ('crewly_alice'), so the controller does not overwrite it
      expect(mockStorageService.saveTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          members: expect.arrayContaining([
            expect.objectContaining({
              id: 'member-1',
              sessionName: 'crewly_alice',
              agentStatus: 'active'
            })
          ])
        })
      );
    });

    it('should return 400 when sessionName or role is missing', async () => {
      mockRequest.body = {
        role: 'developer'
        // missing sessionName
      };

      await teamsHandlers.registerMemberStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'sessionName and role are required'
      });
    });

    it('should return 404 when member is not found in any team', async () => {
      mockRequest.body = {
        sessionName: 'non_existent_session',
        role: 'developer',
        status: 'active'
      };

      mockStorageService.getTeams.mockResolvedValue([]);

      await teamsHandlers.registerMemberStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Controller returns 404 when agent is not found in any team
      expect(responseMock.status).toHaveBeenCalledWith(404);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: "Agent with sessionName 'non_existent_session' not found in any team"
      });
    });

    it('should handle storage service errors', async () => {
      mockRequest.body = {
        sessionName: 'crewly_alice',
        role: 'developer',
        status: 'active'
      };

      mockStorageService.getTeams.mockRejectedValue(new Error('Storage error'));

      await teamsHandlers.registerMemberStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(500);
      expect(responseMock.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to register member status'
      });
    });
  });

  describe('Status Update Workflow Integration', () => {
    it('should handle complete user workflow: start member (starting) then agent registers (active)', async () => {
      // Setup: Create a team with an inactive member
      const mockTeam: Team = {
        id: 'team-123',
        name: 'Test Team',
        members: [
          {
            id: 'member-1',
            name: 'Alice',
            sessionName: '',
            role: 'developer',
            runtimeType: 'claude-code',
            systemPrompt: 'Test prompt',
            agentStatus: 'inactive',
            workingStatus: 'idle',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const mockProjects = [
        {
          id: 'project-1',
          name: 'Test Project',
          path: '/test/project',
          teams: {},
          status: 'active' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ];

      // Mock services for startTeamMember
      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockStorageService.getProjects.mockResolvedValue(mockProjects);
      mockTmuxService.listSessions.mockResolvedValue([]);
      mockTmuxService.createTeamMemberSession.mockResolvedValue({
        success: true,
        sessionName: 'test-team-alice-member-1'
      });

      let savedTeamAfterStart: Team | null = null;
      let savedTeamAfterRegistration: Team | null = null;

      // Track team saves to verify state transitions
      mockStorageService.saveTeam
        .mockImplementationOnce((team: Team) => {
          savedTeamAfterStart = team;
          return Promise.resolve();
        })
        .mockImplementationOnce((team: Team) => {
          savedTeamAfterRegistration = team;
          return Promise.resolve();
        });

      // STEP 1: User starts the team member
      mockRequest.params = { teamId: 'team-123', memberId: 'member-1' };
      mockRequest.body = {};

      // Use agentRegistrationService for starting
      (mockApiContext.agentRegistrationService as any).createAgentSession = jest.fn<any>().mockResolvedValue({
        success: true,
        sessionName: 'test-team-alice-member-1'
      });

      await teamsHandlers.startTeamMember.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Verify member status changed to 'starting' after starting
      // The controller sets agentStatus to STARTING (line 1054) for instant UI feedback
      expect(savedTeamAfterStart).not.toBeNull();
      expect(savedTeamAfterStart!.members[0].agentStatus).toBe('starting');
      expect(savedTeamAfterStart!.members[0].workingStatus).toBe('idle');
      expect(savedTeamAfterStart!.members[0].sessionName).toBe('test-team-alice-member-1');

      // STEP 2: Agent calls MCP registration
      mockRequest.params = {};
      mockRequest.body = {
        sessionName: 'test-team-alice-member-1',
        role: 'developer',
        status: 'active',
        memberId: 'member-1',
        registeredAt: new Date().toISOString()
      };

      // Setup for registration - return the updated team with starting status
      mockStorageService.getTeams.mockResolvedValue([savedTeamAfterStart!]);

      await teamsHandlers.registerMemberStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Verify member status changed to 'active' after registration
      expect(savedTeamAfterRegistration).not.toBeNull();
      expect(savedTeamAfterRegistration!.members[0].agentStatus).toBe('active');
      expect(savedTeamAfterRegistration!.members[0].workingStatus).toBe('idle');
      expect(savedTeamAfterRegistration!.members[0].sessionName).toBe('test-team-alice-member-1');
      expect(savedTeamAfterRegistration!.members[0].readyAt).toBeDefined();

      // Verify API responses
      expect(responseMock.json).toHaveBeenCalledTimes(2);
    });

    it('should complete the full status lifecycle from inactive to starting to active', async () => {
      // Step 1: Create team with inactive members (empty sessionName since not yet started)
      const mockTeam: Team = {
        id: 'team-123',
        name: 'Test Team',
        members: [
          {
            id: 'member-1',
            name: 'Alice',
            sessionName: '',
            role: 'developer',
            runtimeType: 'claude-code',
            systemPrompt: 'Test prompt',
            agentStatus: 'inactive',
            workingStatus: 'idle',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Step 2: Start team (should set to starting)
      mockRequest.params = { id: 'team-123' };
      mockRequest.body = { projectId: 'project-1' };
      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockStorageService.getProjects.mockResolvedValue([{
        id: 'project-1',
        path: '/test/project',
        name: 'Test Project',
      }]);
      mockTmuxService.listSessions.mockResolvedValue([]);
      mockTmuxService.createTeamMemberSession.mockResolvedValue({ success: true, sessionName: 'test-team-alice-member-1' });
      mockApiContext.agentRegistrationService = {
        createAgentSession: jest.fn<any>().mockResolvedValue({ success: true, sessionName: 'test-team-alice-member-1' })
      } as any;

      // Track all saves to capture intermediate states
      const allSaves: Team[] = [];
      mockStorageService.saveTeam.mockImplementation((team: Team) => {
        // Deep clone to capture the state at this point in time
        allSaves.push(JSON.parse(JSON.stringify(team)));
        return Promise.resolve();
      });

      await teamsHandlers.startTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // The second save (index 1) sets all members to 'starting' for instant UI feedback
      // Save 0: projectIds update, Save 1: members set to 'starting'
      expect(allSaves.length).toBeGreaterThanOrEqual(2);
      expect(allSaves[1].members[0].agentStatus).toBe(CREWLY_CONSTANTS.AGENT_STATUSES.STARTING);

      // Step 3: Agent registers (should set to active)
      jest.clearAllMocks();

      // Re-setup the session mock implementation after clearAllMocks
      const { getSessionStatePersistence } = require('../../services/session/index.js');
      (getSessionStatePersistence as jest.Mock).mockReturnValue({
        updateSessionId: mockUpdateSessionId,
      });

      mockRequest.body = {
        sessionName: 'test-team-alice-member-1',
        role: 'developer',
        status: 'active',
        memberId: 'member-1'
      };

      // Use the last saved state as the current team state
      const lastSavedTeam = allSaves[allSaves.length - 1];
      mockStorageService.getTeams.mockResolvedValue([lastSavedTeam]);

      let registeredTeam: Team;
      mockStorageService.saveTeam.mockImplementation((team: Team) => {
        registeredTeam = JSON.parse(JSON.stringify(team));
        return Promise.resolve();
      });

      await teamsHandlers.registerMemberStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Verify member is now 'active'
      expect(registeredTeam!.members[0].agentStatus).toBe('active');
      expect(registeredTeam!.members[0].readyAt).toBeDefined();
    });

    it('should not have deprecated status field in any operations', async () => {
      const mockTeam: Team = {
        id: 'team-123',
        name: 'Test Team',
        members: [
          {
            id: 'member-1',
            name: 'Alice',
            sessionName: '',
            role: 'developer',
            runtimeType: 'claude-code',
            systemPrompt: 'Test prompt',
            agentStatus: 'inactive',
            workingStatus: 'idle',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      mockRequest.params = { id: 'team-123' };
      mockRequest.body = { projectId: 'project-1' };
      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockStorageService.getProjects.mockResolvedValue([{
        id: 'project-1',
        path: '/test/project',
        name: 'Test Project',
      }]);
      mockTmuxService.listSessions.mockResolvedValue([]);
      mockTmuxService.createTeamMemberSession.mockResolvedValue({ success: true, sessionName: 'test-team-alice-member-1' });
      mockApiContext.agentRegistrationService = {
        createAgentSession: jest.fn<any>().mockResolvedValue({ success: true, sessionName: 'test-team-alice-member-1' })
      } as any;

      let savedTeam: Team;
      mockStorageService.saveTeam.mockImplementation((team: Team) => {
        savedTeam = JSON.parse(JSON.stringify(team));
        return Promise.resolve();
      });

      await teamsHandlers.startTeam.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Verify no deprecated 'status' field exists
      expect(savedTeam!.members[0]).not.toHaveProperty('status');
      expect(savedTeam!.members[0]).toHaveProperty('agentStatus');
      expect(savedTeam!.members[0]).toHaveProperty('workingStatus');
    });
  });

  describe('orchestrator auto-subscription to agent events', () => {
    let mockEventBusService: {
      subscribe: jest.Mock<any>;
      unsubscribe: jest.Mock<any>;
      listSubscriptions: jest.Mock<any>;
    };

    beforeEach(() => {
      mockEventBusService = {
        subscribe: jest.fn<any>().mockReturnValue({ id: 'sub-1' }),
        unsubscribe: jest.fn<any>().mockReturnValue(true),
        listSubscriptions: jest.fn<any>().mockReturnValue([]),
      };
      setTeamControllerEventBusService(mockEventBusService as any);
    });

    afterEach(() => {
      // Reset module-level state by setting to null
      setTeamControllerEventBusService(null as any);
    });

    it('should auto-subscribe orchestrator to agent events on registration', async () => {
      mockRequest.body = {
        sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
        role: 'orchestrator',
        status: 'active',
        registeredAt: new Date().toISOString(),
      };

      mockStorageService.updateOrchestratorStatus = jest.fn<any>().mockResolvedValue(undefined);

      await teamsHandlers.registerMemberStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockEventBusService.listSubscriptions).toHaveBeenCalledWith(
        CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME
      );
      expect(mockEventBusService.subscribe).toHaveBeenCalledWith({
        eventType: ['agent:status_changed', 'agent:idle', 'agent:busy', 'agent:active', 'agent:inactive'],
        filter: {},
        subscriberSession: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
        oneShot: false,
        ttlMinutes: 1440,
      });
    });

    it('should clear existing subscriptions before re-subscribing', async () => {
      mockEventBusService.listSubscriptions.mockReturnValue([
        { id: 'old-sub-1' },
        { id: 'old-sub-2' },
      ]);

      mockRequest.body = {
        sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
        role: 'orchestrator',
        status: 'active',
      };

      mockStorageService.updateOrchestratorStatus = jest.fn<any>().mockResolvedValue(undefined);

      await teamsHandlers.registerMemberStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockEventBusService.unsubscribe).toHaveBeenCalledWith('old-sub-1');
      expect(mockEventBusService.unsubscribe).toHaveBeenCalledWith('old-sub-2');
      expect(mockEventBusService.subscribe).toHaveBeenCalledTimes(1);
    });

    it('should gracefully handle missing eventBusService', async () => {
      // Reset to null
      setTeamControllerEventBusService(null as any);

      mockRequest.body = {
        sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
        role: 'orchestrator',
        status: 'active',
      };

      mockStorageService.updateOrchestratorStatus = jest.fn<any>().mockResolvedValue(undefined);

      // Should not throw
      await teamsHandlers.registerMemberStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );
      // subscribe should not be called since eventBusService is null
      expect(mockEventBusService.subscribe).not.toHaveBeenCalled();
    });

    it('should NOT subscribe for non-orchestrator agents', async () => {
      const mockTeam: Team = {
        id: 'team-123',
        name: 'Test Team',
        members: [{
          id: 'member-1',
          name: 'Alice',
          sessionName: 'crewly_alice',
          role: 'developer',
          systemPrompt: 'Test',
          agentStatus: 'activating',
          workingStatus: 'idle',
          runtimeType: 'claude-code',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockRequest.body = {
        sessionName: 'crewly_alice',
        role: 'developer',
        status: 'active',
        memberId: 'member-1',
      };

      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockStorageService.saveTeam.mockResolvedValue(undefined);

      await teamsHandlers.registerMemberStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockEventBusService.subscribe).not.toHaveBeenCalled();
    });

    it('should persist claudeSessionId when provided in registration', async () => {
      const mockTeam: Team = {
        id: 'team-123',
        name: 'Test Team',
        members: [
          {
            id: 'member-1',
            name: 'Alice',
            sessionName: 'crewly_alice',
            role: 'developer',
            runtimeType: 'claude-code',
            systemPrompt: 'Test prompt',
            agentStatus: 'activating',
            workingStatus: 'idle',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      mockRequest.body = {
        sessionName: 'crewly_alice',
        role: 'developer',
        status: 'active',
        registeredAt: new Date().toISOString(),
        memberId: 'member-1',
        claudeSessionId: 'abc-123-session-uuid'
      };

      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockStorageService.saveTeam.mockResolvedValue(undefined);

      await teamsHandlers.registerMemberStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockUpdateSessionId).toHaveBeenCalledWith('crewly_alice', 'abc-123-session-uuid');
    });

    it('should not call updateSessionId when claudeSessionId is not provided', async () => {
      const mockTeam: Team = {
        id: 'team-123',
        name: 'Test Team',
        members: [
          {
            id: 'member-1',
            name: 'Alice',
            sessionName: 'crewly_alice',
            role: 'developer',
            runtimeType: 'claude-code',
            systemPrompt: 'Test prompt',
            agentStatus: 'activating',
            workingStatus: 'idle',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      mockRequest.body = {
        sessionName: 'crewly_alice',
        role: 'developer',
        status: 'active',
        registeredAt: new Date().toISOString(),
        memberId: 'member-1'
      };

      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockStorageService.saveTeam.mockResolvedValue(undefined);

      await teamsHandlers.registerMemberStatus.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockUpdateSessionId).not.toHaveBeenCalled();
    });
  });

  describe('startTeamMember with retry logic', () => {
    beforeEach(() => {
      mockRequest = {
        params: { teamId: 'team-1', memberId: 'member-1' },
        body: {}
      };
      mockResponse = responseMock as any;

      const mockTeam: Team = {
        id: 'team-1',
        name: 'Test Team',
        description: 'Test Description',
        members: [{
          id: 'member-1',
          name: 'Test Member',
          sessionName: '',
          role: 'tpm',
          systemPrompt: 'Test prompt',
          agentStatus: 'inactive',
          workingStatus: 'idle',
          runtimeType: 'claude-code',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }],
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockStorageService.getProjects.mockResolvedValue([]);
    });

    it('should succeed on first attempt', async () => {
      const mockCreateResult = {
        success: true,
        sessionName: 'test-session',
        message: 'Session created successfully'
      };

      // Mock agentRegistrationService
      mockApiContext.agentRegistrationService = {
        createAgentSession: jest.fn<any>().mockResolvedValue(mockCreateResult)
      } as any;

      await teamsHandlers.startTeamMember.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect((mockApiContext.agentRegistrationService as any).createAgentSession).toHaveBeenCalledTimes(1);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            memberId: 'member-1',
            sessionName: 'test-session'
          })
        })
      );
    });

    it('should retry on failure and succeed on second attempt', async () => {
      const mockFailResult = {
        success: false,
        error: 'can\'t find pane: test-session'
      };
      const mockSuccessResult = {
        success: true,
        sessionName: 'test-session',
        message: 'Session created successfully'
      };

      // Mock agentRegistrationService to fail first, succeed second
      let callCount = 0;
      mockApiContext.agentRegistrationService = {
        createAgentSession: jest.fn<any>().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve(mockFailResult);
          } else {
            return Promise.resolve(mockSuccessResult);
          }
        })
      } as any;

      await teamsHandlers.startTeamMember.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect((mockApiContext.agentRegistrationService as any).createAgentSession).toHaveBeenCalledTimes(2);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            memberId: 'member-1',
            sessionName: 'test-session'
          })
        })
      );
    });

    it('should fail after all retry attempts', async () => {
      const mockFailResult = {
        success: false,
        error: 'can\'t find pane: test-session'
      };

      // Mock agentRegistrationService to always fail
      mockApiContext.agentRegistrationService = {
        createAgentSession: jest.fn<any>().mockResolvedValue(mockFailResult)
      } as any;

      await teamsHandlers.startTeamMember.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Should retry 3 times total
      expect((mockApiContext.agentRegistrationService as any).createAgentSession).toHaveBeenCalledTimes(3);
      expect(responseMock.status).toHaveBeenCalledWith(500);
      // Controller returns lastError directly (not the "after N attempts" message)
      // because lastError is set before the fallback message in the || chain
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "can't find pane: test-session"
        })
      );
    });

    it('should reset member status to inactive after failure', async () => {
      const mockFailResult = {
        success: false,
        error: 'Session creation failed'
      };

      mockApiContext.agentRegistrationService = {
        createAgentSession: jest.fn<any>().mockResolvedValue(mockFailResult)
      } as any;

      let savedTeam: Team;
      mockStorageService.saveTeam.mockImplementation((team: Team) => {
        savedTeam = team;
        return Promise.resolve();
      });

      await teamsHandlers.startTeamMember.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Verify member status was reset to inactive
      expect(savedTeam!.members[0].agentStatus).toBe(CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE);
      expect(savedTeam!.members[0].sessionName).toBe('');
    });

    it('should handle retry with delays correctly', async () => {
      // This test verifies that the retry logic calls createAgentSession
      // the expected number of times when the first call fails and the second succeeds.
      // The controller uses real setTimeout delays between retries.
      const mockFailResult = {
        success: false,
        error: 'can\'t find pane: test-session'
      };
      const mockSuccessResult = {
        success: true,
        sessionName: 'test-session',
        message: 'Session created successfully'
      };

      let callCount = 0;
      mockApiContext.agentRegistrationService = {
        createAgentSession: jest.fn<any>().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve(mockFailResult);
          } else {
            return Promise.resolve(mockSuccessResult);
          }
        })
      } as any;

      await teamsHandlers.startTeamMember.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Verify retry happened: first call failed, second succeeded
      expect((mockApiContext.agentRegistrationService as any).createAgentSession).toHaveBeenCalledTimes(2);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should skip already-active members with a live session (#133)', async () => {
      const mockTeam: Team = {
        id: 'team-1',
        name: 'Test Team',
        members: [{
          id: 'member-1',
          name: 'Nick',
          sessionName: 'steamfun-nick-38e207cb',
          role: 'developer',
          systemPrompt: 'Test prompt',
          agentStatus: 'active',
          workingStatus: 'in_progress',
          runtimeType: 'claude-code',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }],
        projectIds: ['project-1'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      // Session exists in tmux
      mockTmuxService.listSessions.mockResolvedValue([
        { sessionName: 'steamfun-nick-38e207cb' }
      ]);

      mockApiContext.agentRegistrationService = {
        createAgentSession: jest.fn<any>()
      } as any;

      await teamsHandlers.startTeamMember.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // createAgentSession should NOT be called since the member is already active
      expect((mockApiContext.agentRegistrationService as any).createAgentSession).not.toHaveBeenCalled();

      // Should return success with already-active info
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: expect.stringContaining('already active'),
        })
      );
    });
  });
});
