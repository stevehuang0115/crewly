import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Request, Response } from 'express';
import * as teamsHandlers from './team/team.controller.js';
import type { ApiContext } from './types.js';
import { Team } from '../types/index.js';
import { API_SECURITY_CONSTANTS } from '../constants.js';

/**
 * Headers the dashboard sends when the owner clicks Start (#775). Without the
 * marker the request is treated as an agent/internal wake and is subject to the
 * pool wake gate and the dormant-team commitment-approval gate.
 */
const DASHBOARD_HEADERS = {
  [API_SECURITY_CONSTANTS.CALLER_HEADER]: API_SECURITY_CONSTANTS.DASHBOARD_CALLER,
};

// Mock dependencies used by the team controller
jest.mock('../services/index.js');
jest.mock('../services/agent/agent-heartbeat.service.js', () => ({
  updateAgentHeartbeat: jest.fn<any>().mockResolvedValue(undefined),
}));
jest.mock('../services/session/index.js', () => ({
  getSessionBackendSync: jest.fn(),
  getSessionStatePersistence: jest.fn(),
}));
jest.mock('../websocket/terminal.gateway.js', () => ({
  getTerminalGateway: jest.fn().mockReturnValue(null),
}));
jest.mock('../services/memory/memory.service.js', () => ({
  MemoryService: {
    getInstance: jest.fn().mockReturnValue({
      initializeForSession: jest.fn<any>().mockResolvedValue(undefined),
    }),
  },
}));
jest.mock('../services/messaging/sub-agent-message-queue.service.js', () => ({
  SubAgentMessageQueue: jest.fn(),
}));

describe('Agent Status Workflow Integration', () => {
  let mockApiContext: ApiContext;
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let responseMock: {
    status: jest.Mock;
    json: jest.Mock;
    send: jest.Mock;
  };

  /**
   * Creates a mock team with a single inactive member for testing.
   */
  function createMockTeam(): Team {
    return {
      id: 'team-123',
      name: 'Test Team',
      members: [
        {
          id: 'member-1',
          name: 'Alice',
          sessionName: '',
          role: 'developer',
          systemPrompt: 'Test prompt',
          agentStatus: 'inactive',
          workingStatus: 'idle',
          runtimeType: 'claude-code',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      projectIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    responseMock = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    mockApiContext = {
      storageService: {
        getTeams: jest.fn<any>(),
        saveTeam: jest.fn<any>().mockResolvedValue(undefined),
        getProjects: jest.fn<any>().mockResolvedValue([]),
      } as any,
      tmuxService: {
        listSessions: jest.fn<any>().mockResolvedValue([]),
        killSession: jest.fn<any>().mockResolvedValue(undefined),
      } as any,
      agentRegistrationService: {
        createAgentSession: jest.fn<any>().mockResolvedValue({
          success: true,
          sessionName: 'test-team-alice-member-1',
        }),
        registerMemberStatus: jest.fn<any>().mockResolvedValue(undefined),
        getRegisteredMembers: jest.fn<any>().mockReturnValue(new Map()),
      } as any,
      schedulerService: {} as any,
      activeProjectsService: {} as any,
      promptTemplateService: {} as any,
      taskAssignmentMonitor: {} as any,
      taskTrackingService: {} as any,
    } as ApiContext;

    mockRequest = {
      params: {},
      body: {},
    };

    mockResponse = responseMock as any;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should complete full workflow: start member → agent registers → active', async () => {
    const mockTeam = createMockTeam();

    // getTeams is called multiple times:
    // 1. startTeamMember (find team/member)
    // 2. _startTeamMemberCore (fresh load before session creation)
    // 3. _startTeamMemberCore (fresh load after successful session creation)
    (mockApiContext.storageService.getTeams as jest.Mock<any>).mockResolvedValue([mockTeam]);

    // Track saves to verify state transitions
    const savedTeams: Team[] = [];
    (mockApiContext.storageService.saveTeam as jest.Mock<any>).mockImplementation((team: Team) => {
      savedTeams.push(JSON.parse(JSON.stringify(team)));
      return Promise.resolve();
    });

    // STEP 1: User starts the team member
    mockRequest.headers = DASHBOARD_HEADERS;
    mockRequest.params = { teamId: 'team-123', memberId: 'member-1' };
    mockRequest.body = {};

    await teamsHandlers.startTeamMember.call(
      mockApiContext,
      mockRequest as Request,
      mockResponse as Response
    );

    // Verify the first save set status to 'starting'
    expect(savedTeams.length).toBeGreaterThanOrEqual(1);
    expect(savedTeams[0].members[0].agentStatus).toBe('starting');

    // Verify successful API response
    expect(responseMock.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        message: expect.stringContaining('Alice started successfully'),
      })
    );

    // STEP 2: Agent calls registration endpoint
    jest.clearAllMocks();
    responseMock.status.mockReturnThis();
    responseMock.json.mockReturnThis();

    // For registration, getTeams returns the team with the session name set
    const teamWithSession = createMockTeam();
    teamWithSession.members[0].agentStatus = 'starting';
    teamWithSession.members[0].sessionName = 'test-team-alice-member-1';
    (mockApiContext.storageService.getTeams as jest.Mock<any>).mockResolvedValue([teamWithSession]);

    let registeredTeam: Team | null = null;
    (mockApiContext.storageService.saveTeam as jest.Mock<any>).mockImplementation((team: Team) => {
      registeredTeam = JSON.parse(JSON.stringify(team));
      return Promise.resolve();
    });

    // The agent itself registers (not the dashboard)
    mockRequest.headers = {};
    mockRequest.params = {};
    mockRequest.body = {
      sessionName: 'test-team-alice-member-1',
      role: 'developer',
      status: 'active',
      memberId: 'member-1',
      registeredAt: new Date().toISOString()
    };

    await teamsHandlers.registerMemberStatus.call(
      mockApiContext,
      mockRequest as Request,
      mockResponse as Response
    );

    // Verify member status changed to 'active' after registration
    expect(registeredTeam).not.toBeNull();
    expect(registeredTeam!.members[0].agentStatus).toBe('active');
    expect(registeredTeam!.members[0].workingStatus).toBe('idle');
    expect(registeredTeam!.members[0].readyAt).toBeDefined();

    // Verify registration API response
    expect(responseMock.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        message: expect.stringContaining('registered as active with role developer'),
      })
    );
  });

  it('should handle failed session creation gracefully', async () => {
    const mockTeam = createMockTeam();

    // Override createAgentSession to always fail
    (mockApiContext.agentRegistrationService as any).createAgentSession =
      jest.fn<any>().mockResolvedValue({
        success: false,
        error: 'Session creation failed'
      });

    // getTeams always returns the same team
    (mockApiContext.storageService.getTeams as jest.Mock<any>).mockResolvedValue([mockTeam]);

    // Track the last save to verify final state
    let lastSavedTeam: Team | null = null;
    (mockApiContext.storageService.saveTeam as jest.Mock<any>).mockImplementation((team: Team) => {
      lastSavedTeam = JSON.parse(JSON.stringify(team));
      return Promise.resolve();
    });

    mockRequest.headers = DASHBOARD_HEADERS;
    mockRequest.params = { teamId: 'team-123', memberId: 'member-1' };
    mockRequest.body = {};

    // Start the handler (has retry delays internally)
    const promise = teamsHandlers.startTeamMember.call(
      mockApiContext,
      mockRequest as Request,
      mockResponse as Response
    );

    // Advance past all retry delays (1s + 2s exponential backoff)
    await jest.advanceTimersByTimeAsync(10000);
    await promise;

    // Verify the last save reset member to 'inactive'
    expect(lastSavedTeam).not.toBeNull();
    expect(lastSavedTeam!.members[0].agentStatus).toBe('inactive');
    expect(lastSavedTeam!.members[0].sessionName).toBe('');

    // Verify error response
    expect(responseMock.status).toHaveBeenCalledWith(500);
    expect(responseMock.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Session creation failed'
      })
    );

    // Verify createAgentSession was called 3 times (retries)
    expect(
      (mockApiContext.agentRegistrationService as any).createAgentSession
    ).toHaveBeenCalledTimes(3);
  });

  it('should preserve active status when agent registers during session creation', async () => {
    const mockTeam = createMockTeam();

    // After session creation succeeds, getTeams returns a team where agent is already 'active'
    // (simulating concurrent MCP registration that happened during createAgentSession)
    const teamAfterRegistration: Team = {
      ...createMockTeam(),
      members: [{
        ...createMockTeam().members[0],
        agentStatus: 'active',
        sessionName: 'test-team-alice-member-1',
        readyAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }]
    };

    // getTeams returns original team for first calls, then updated team for the final re-fetch
    (mockApiContext.storageService.getTeams as jest.Mock<any>)
      .mockResolvedValueOnce([mockTeam])           // startTeamMember: find team
      .mockResolvedValueOnce([mockTeam])           // _startTeamMemberCore: fresh load before creation
      .mockResolvedValue([teamAfterRegistration]); // _startTeamMemberCore: fresh load after creation (+ any extra calls)

    (mockApiContext.storageService.saveTeam as jest.Mock<any>).mockResolvedValue(undefined);

    mockRequest.headers = DASHBOARD_HEADERS;
    mockRequest.params = { teamId: 'team-123', memberId: 'member-1' };
    mockRequest.body = {};

    await teamsHandlers.startTeamMember.call(
      mockApiContext,
      mockRequest as Request,
      mockResponse as Response
    );

    // API response should reflect the 'active' status from the re-fetched team data,
    // NOT the stale 'starting' status
    expect(responseMock.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          status: 'active'
        })
      })
    );

    // Verify getTeams was called at least 3 times (initial, pre-creation, post-creation)
    expect(mockApiContext.storageService.getTeams).toHaveBeenCalledTimes(3);
  });
});
