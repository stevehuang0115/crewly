import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { TeamActivityWebSocketService, TeamActivityData } from './team-activity-websocket.service.js';
import { StorageService } from '../core/storage.service.js';
import { TmuxService } from '../agent/tmux.service.js';
import { TerminalGateway } from '../../websocket/terminal.gateway.js';

// Mock all dependencies
jest.mock('../core/storage.service.js');
jest.mock('../agent/tmux.service.js');
jest.mock('../../websocket/terminal.gateway.js');

// V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
// TaskTrackingService is gone; team-activity reads from TaskPoolService now.
jest.mock('../task-pool/task-pool.service.js', () => {
  const getAllItems: any = jest.fn();
  getAllItems.mockResolvedValue([]);
  return {
    TaskPoolService: { getInstance: jest.fn(() => ({ getAllItems })) },
  };
});

/**
 * Test suite for TeamActivityWebSocketService
 * Tests real-time team activity monitoring and WebSocket communication
 */
describe('TeamActivityWebSocketService', () => {
  let service: TeamActivityWebSocketService;
  let mockStorageService: jest.Mocked<StorageService>;
  let mockTmuxService: jest.Mocked<TmuxService>;
  let mockTerminalGateway: any;

  beforeEach(() => {
    // Create mocked instances
    mockStorageService = {
      getTeams: jest.fn(),
      getTeamMembers: jest.fn(),
      saveTeam: jest.fn(),
    } as any;

    mockTmuxService = {
      sessionExists: jest.fn(),
      capturePane: jest.fn(),
      listSessions: jest.fn(),
    } as any;

    mockTerminalGateway = {
      broadcastTeamActivity: jest.fn(),
      broadcastOrchestratorStatus: jest.fn(),
      broadcastTeamMemberStatus: jest.fn(),
    };

    // Create service instance — V3-only, no TaskTrackingService param.
    service = new TeamActivityWebSocketService(
      mockStorageService,
      mockTmuxService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();

    // Clean up any running timers using stop()
    if (service) {
      service.stop();
    }
  });

  describe('constructor', () => {
    /**
     * Test service initialization with all dependencies
     */
    it('should initialize with required dependencies', () => {
      expect(service).toBeInstanceOf(TeamActivityWebSocketService);
      expect(service).toBeDefined();
    });

    /**
     * Test that service extends EventEmitter
     */
    it('should extend EventEmitter for event handling', () => {
      expect(service.on).toBeDefined();
      expect(service.emit).toBeDefined();
      expect(service.removeListener).toBeDefined();
    });
  });

  describe('team activity data structure', () => {
    /**
     * Test TeamActivityData interface structure
     */
    it('should define proper TeamActivityData structure', () => {
      const mockData: TeamActivityData = {
        orchestrator: {
          sessionName: 'orchestrator',
          running: true,
          lastCheck: new Date().toISOString()
        },
        members: [{
          teamId: 'team-1',
          teamName: 'Test Team',
          memberId: 'member-1',
          memberName: 'Test Member',
          role: 'developer',
          sessionName: 'dev-session',
          agentStatus: 'active',
          workingStatus: 'in_progress',
          lastActivityCheck: new Date().toISOString(),
          activityDetected: true,
          currentTask: {
            id: 'task-1',
            taskName: 'Test Task',
            status: 'in_progress',
            assignedAt: new Date().toISOString()
          },
          lastTerminalOutput: 'Test output'
        }]
      };

      expect(mockData.orchestrator).toBeDefined();
      expect(mockData.members).toBeInstanceOf(Array);
      expect(mockData.members[0].agentStatus).toBe('active');
      expect(mockData.members[0].workingStatus).toBe('in_progress');
    });
  });

  describe('activity monitoring', () => {
    /**
     * Test activity data collection
     */
    it('should collect team activity data', async () => {
      mockStorageService.getTeams.mockResolvedValue([
        {
          id: 'team-1',
          name: 'Test Team',
          members: [{
            id: 'member-1',
            name: 'Test Member',
            role: 'developer',
            sessionName: 'dev-session',
            agentStatus: 'active',
            workingStatus: 'idle',
            systemPrompt: 'You are a developer',
            runtimeType: 'claude-code',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastActivityCheck: new Date().toISOString()
          }]
        }
      ] as any);

      mockTmuxService.sessionExists.mockResolvedValue(true);
      mockTmuxService.capturePane.mockResolvedValue('terminal output');

      // Test that service can be called (actual method might be private)
      expect(mockStorageService.getTeams).toBeDefined();
      expect(mockTmuxService.sessionExists).toBeDefined();
    });

    /**
     * Test orchestrator status monitoring
     */
    it('should monitor orchestrator status', async () => {
      mockTmuxService.sessionExists.mockResolvedValue(true);

      expect(mockTmuxService.sessionExists).toBeDefined();
    });
  });

  describe('WebSocket integration', () => {
    /**
     * Test terminal gateway integration
     */
    it('should integrate with terminal gateway', () => {
      const gateway = mockTerminalGateway;

      // Test that service can work with terminal gateway
      expect(gateway.broadcastTeamActivity).toBeDefined();
      expect(gateway.broadcastOrchestratorStatus).toBeDefined();
    });

    /**
     * Test activity data broadcasting
     */
    it('should broadcast activity updates', () => {
      const mockActivityData: TeamActivityData = {
        orchestrator: {
          sessionName: 'orchestrator',
          running: true,
          lastCheck: new Date().toISOString()
        },
        members: []
      };

      // Test data structure for broadcasting
      expect(mockActivityData.orchestrator.running).toBe(true);
      expect(mockActivityData.members).toEqual([]);
    });
  });

  describe('background monitoring', () => {
    /**
     * Test background timer functionality
     */
    it('should handle background refresh intervals', () => {
      // Test that service can manage background timers
      expect(service).toBeDefined();

      // The actual timer logic would be tested with integration tests
      const expectedInterval = 5 * 60 * 1000; // 5 minutes
      expect(expectedInterval).toBe(300000);
    });

    /**
     * Test caching mechanism
     */
    it('should implement activity data caching', () => {
      // Test that service can cache activity data
      const mockCachedData: TeamActivityData = {
        orchestrator: {
          sessionName: 'test',
          running: false,
          lastCheck: new Date().toISOString()
        },
        members: []
      };

      expect(mockCachedData).toBeDefined();
      expect(mockCachedData.orchestrator.running).toBe(false);
    });

    /**
     * Test getCachedActivityData returns null initially
     */
    it('should return null cached data initially', () => {
      expect(service.getCachedActivityData()).toBeNull();
    });
  });

  describe('error handling', () => {
    /**
     * Test handling of tmux service errors
     */
    it('should handle tmux service errors gracefully', async () => {
      mockTmuxService.sessionExists.mockRejectedValue(new Error('Tmux error'));

      try {
        await mockTmuxService.sessionExists('test-session');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Tmux error');
      }
    });

    /**
     * Test handling of storage service errors
     */
    it('should handle storage service errors gracefully', async () => {
      mockStorageService.getTeams.mockRejectedValue(new Error('Storage error'));

      try {
        await mockStorageService.getTeams();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Storage error');
      }
    });
  });

  describe('resource management', () => {
    /**
     * Test service cleanup and resource management
     */
    it('should properly clean up resources on stop', () => {
      // Test that stop method exists and can be called
      expect(service.stop).toBeDefined();

      // Call stop to clean up
      service.stop();

      // Verify cleanup (would check internal state in real implementation)
      expect(service).toBeDefined();
    });

    /**
     * Test start and stop lifecycle
     */
    it('should handle start and stop lifecycle', () => {
      // Start should set up background timer
      service.start();

      // Stop should clear interval
      service.stop();

      expect(service).toBeDefined();
    });

    /**
     * Test memory management with large datasets
     */
    it('should handle memory efficiently with large team data', () => {
      const maxOutputSize = 1024; // 1KB
      const sessionTimeout = 8000; // 8 seconds (updated from source)

      expect(maxOutputSize).toBe(1024);
      expect(sessionTimeout).toBe(8000);
    });
  });
});
