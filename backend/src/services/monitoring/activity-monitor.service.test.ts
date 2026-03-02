import { ActivityMonitorService, TeamWorkingStatusFile } from './activity-monitor.service';
import { StorageService } from '../core/storage.service.js';
import * as sessionModule from '../session/index.js';
import { AgentHeartbeatService } from '../agent/agent-heartbeat.service.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { readFile, writeFile, rename, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { CREWLY_CONSTANTS, CONTINUATION_CONSTANTS, PTY_CONSTANTS } from '../../constants.js';
import { stripAnsiCodes } from '../../utils/terminal-output.utils.js';

// Mock dependencies
jest.mock('node-pty', () => ({ spawn: jest.fn() }));
jest.mock('../core/storage.service.js');
jest.mock('../session/index.js');
jest.mock('../agent/agent-heartbeat.service.js');
jest.mock('../core/logger.service.js');
jest.mock('../orchestrator/orchestrator-restart.service.js', () => ({
  OrchestratorRestartService: {
    getInstance: () => ({
      attemptRestart: jest.fn().mockResolvedValue(true),
    }),
  },
}));
jest.mock('../../utils/terminal-output.utils.js', () => ({
  stripAnsiCodes: jest.fn((s: string) => s),
}));
jest.mock('fs/promises');
jest.mock('fs');
jest.mock('path');
jest.mock('os');

describe('ActivityMonitorService', () => {
  let service: ActivityMonitorService;
  let mockLogger: jest.Mocked<ComponentLogger>;
  let mockStorageService: jest.Mocked<StorageService>;
  let mockSessionBackend: jest.Mocked<sessionModule.ISessionBackend>;
  let mockAgentHeartbeatService: jest.Mocked<AgentHeartbeatService>;
  let mockLoggerService: jest.Mocked<LoggerService>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset singleton instance
    (ActivityMonitorService as any).instance = undefined;

    // Setup mocks
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    } as any;

    mockLoggerService = {
      createComponentLogger: jest.fn().mockReturnValue(mockLogger)
    } as any;

    (LoggerService.getInstance as jest.Mock).mockReturnValue(mockLoggerService);

    mockStorageService = {
      getTeams: jest.fn().mockResolvedValue([]),
      getProjects: jest.fn().mockResolvedValue([]),
      updateAgentStatus: jest.fn().mockResolvedValue(undefined),
      saveTeam: jest.fn().mockResolvedValue(undefined),
    } as any;
    (StorageService.getInstance as jest.Mock).mockReturnValue(mockStorageService);

    mockSessionBackend = {
      sessionExists: jest.fn().mockReturnValue(true),
      captureOutput: jest.fn().mockReturnValue('some terminal output'),
      getRawHistory: jest.fn().mockReturnValue('raw history'),
      listSessions: jest.fn().mockReturnValue([]),
      getSession: jest.fn().mockReturnValue(undefined),
      killSession: jest.fn().mockResolvedValue(undefined),
      createSession: jest.fn().mockResolvedValue({} as any),
      getTerminalBuffer: jest.fn().mockReturnValue(''),
      destroy: jest.fn().mockResolvedValue(undefined),
    } as any;
    mockAgentHeartbeatService = {
      detectStaleAgents: jest.fn().mockResolvedValue([]),
      getAllAgentHeartbeats: jest.fn().mockResolvedValue({
        orchestrator: {
          agentId: 'orchestrator',
          sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
          agentStatus: 'active',
          lastActiveTime: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        teamMembers: {},
        metadata: { lastUpdated: new Date().toISOString(), version: '1.0.0' },
      }),
      updateAgentHeartbeat: jest.fn().mockResolvedValue(undefined),
      getInstance: jest.fn()
    } as any;

    // Source uses getSessionBackendSync (not getSessionBackend)
    (sessionModule.getSessionBackendSync as jest.Mock).mockReturnValue(mockSessionBackend);
    (AgentHeartbeatService.getInstance as jest.Mock).mockReturnValue(mockAgentHeartbeatService);

    // Mock file system
    (existsSync as jest.Mock).mockReturnValue(false);
    (homedir as jest.Mock).mockReturnValue('/mock/home');
    (join as jest.Mock).mockImplementation((...args) => args.join('/'));

    // Mock rename for atomic writes in saveTeamWorkingStatusFile
    (rename as jest.Mock).mockResolvedValue(undefined);
    (unlink as jest.Mock).mockResolvedValue(undefined);

    service = ActivityMonitorService.getInstance();
  });

  afterEach(() => {
    // Clean up any running intervals
    service.stopPolling();
    jest.clearAllTimers();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = ActivityMonitorService.getInstance();
      const instance2 = ActivityMonitorService.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should initialize logger and services', () => {
      expect(LoggerService.getInstance).toHaveBeenCalled();
      expect(mockLoggerService.createComponentLogger).toHaveBeenCalledWith('ActivityMonitor');
    });
  });

  describe('startPolling', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should start polling with immediate first check', () => {
      const performActivityCheckSpy = jest.spyOn(service as any, 'performActivityCheck').mockResolvedValue(undefined);

      service.startPolling();

      expect(performActivityCheckSpy).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith('Starting activity monitoring with 2-minute intervals (NEW ARCHITECTURE: workingStatus only)');
      expect(service.isRunning()).toBe(true);
    });

    it('should set up recurring polling', () => {
      const performActivityCheckSpy = jest.spyOn(service as any, 'performActivityCheck').mockResolvedValue(undefined);

      service.startPolling();

      // Fast forward 2 minutes
      jest.advanceTimersByTime(120000);

      expect(performActivityCheckSpy).toHaveBeenCalledTimes(2); // Initial + 1 interval
    });

    it('should warn if already running', () => {
      service.startPolling();
      service.startPolling();

      expect(mockLogger.warn).toHaveBeenCalledWith('Activity monitoring already running');
    });
  });

  describe('stopPolling', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should stop polling and clear interval', () => {
      service.startPolling();
      expect(service.isRunning()).toBe(true);

      service.stopPolling();

      expect(service.isRunning()).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith('Activity monitoring stopped');
    });

    it('should do nothing if not running', () => {
      service.stopPolling();

      expect(mockLogger.info).not.toHaveBeenCalledWith('Activity monitoring stopped');
    });
  });

  describe('performActivityCheck', () => {
    const mockTeam = {
      id: 'test-team',
      name: 'Test Team',
      projectIds: [],
      createdAt: '2023-01-01T00:00:00.000Z',
      updatedAt: '2023-01-01T00:00:00.000Z',
      members: [
        {
          id: 'member-1',
          name: 'Test Member 1',
          role: 'developer' as const,
          runtimeType: 'claude-code' as const,
          systemPrompt: 'Test prompt',
          agentStatus: 'active' as const,
          workingStatus: 'idle' as const,
          sessionName: 'test-session-1',
          createdAt: '2023-01-01T00:00:00.000Z',
          updatedAt: '2023-01-01T00:00:00.000Z'
        },
        {
          id: 'member-2',
          name: 'Test Member 2',
          role: 'qa' as const,
          runtimeType: 'claude-code' as const,
          systemPrompt: 'Test prompt 2',
          agentStatus: 'inactive' as const,
          workingStatus: 'idle' as const,
          sessionName: 'test-session-2',
          createdAt: '2023-01-01T00:00:00.000Z',
          updatedAt: '2023-01-01T00:00:00.000Z'
        }
      ]
    };

    const mockWorkingStatusData: TeamWorkingStatusFile = {
      orchestrator: {
        sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
        workingStatus: 'idle',
        lastActivityCheck: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z'
      },
      teamMembers: {},
      metadata: {
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      }
    };

    beforeEach(() => {
      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockSessionBackend.sessionExists.mockReturnValue(true);
      mockSessionBackend.captureOutput.mockReturnValue('some terminal output');
      mockAgentHeartbeatService.detectStaleAgents.mockResolvedValue([]);

      // Mock file operations
      (readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockWorkingStatusData));
      (writeFile as jest.Mock).mockResolvedValue(undefined);
      (existsSync as jest.Mock).mockReturnValue(true);
    });

    it('should detect stale agents using AgentHeartbeatService', async () => {
      const staleAgents = ['member-1', 'member-2'];
      mockAgentHeartbeatService.detectStaleAgents.mockResolvedValue(staleAgents);
      mockAgentHeartbeatService.getAllAgentHeartbeats.mockResolvedValue({
        orchestrator: {
          agentId: 'orchestrator',
          sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
          agentStatus: 'active',
          lastActiveTime: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        teamMembers: {
          'member-1': {
            agentId: 'member-1',
            sessionName: 'test-session-1',
            teamMemberId: 'member-1',
            agentStatus: 'active',
            lastActiveTime: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          'member-2': {
            agentId: 'member-2',
            sessionName: 'test-session-2',
            teamMemberId: 'member-2',
            agentStatus: 'active',
            lastActiveTime: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
        metadata: { lastUpdated: new Date().toISOString(), version: '1.0.0' },
      });
      // Sessions are dead
      mockSessionBackend.sessionExists.mockReturnValue(false);

      await (service as any).performActivityCheck();

      const expectedThreshold = CONTINUATION_CONSTANTS.DETECTION.STALE_THRESHOLD_MINUTES;
      expect(mockAgentHeartbeatService.detectStaleAgents).toHaveBeenCalledWith(expectedThreshold);
      expect(mockLogger.debug).toHaveBeenCalledWith('Detected stale agents for potential inactivity', {
        staleAgents,
        thresholdMinutes: expectedThreshold
      });
      // Heartbeat file should be updated for dead agents
      expect(mockAgentHeartbeatService.updateAgentHeartbeat).toHaveBeenCalledWith(
        'test-session-1', 'member-1', 'inactive'
      );
      expect(mockAgentHeartbeatService.updateAgentHeartbeat).toHaveBeenCalledWith(
        'test-session-2', 'member-2', 'inactive'
      );
      // Team members are now batch-updated and persisted once per modified team
      expect(mockStorageService.updateAgentStatus).not.toHaveBeenCalledWith('test-session-1', 'inactive');
      expect(mockStorageService.updateAgentStatus).not.toHaveBeenCalledWith('test-session-2', 'inactive');
      expect(mockStorageService.saveTeam).toHaveBeenCalledWith(expect.objectContaining({
        id: 'test-team',
        members: expect.arrayContaining([
          expect.objectContaining({ sessionName: 'test-session-1', agentStatus: 'inactive' }),
          expect.objectContaining({ sessionName: 'test-session-2', agentStatus: 'inactive' }),
        ])
      }));
    });

    it('should mark stale orchestrator as inactive when session is dead', async () => {
      mockAgentHeartbeatService.detectStaleAgents.mockResolvedValue(['orchestrator']);
      mockAgentHeartbeatService.getAllAgentHeartbeats.mockResolvedValue({
        orchestrator: {
          agentId: 'orchestrator',
          sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
          agentStatus: 'active',
          lastActiveTime: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        teamMembers: {},
        metadata: { lastUpdated: new Date().toISOString(), version: '1.0.0' },
      });
      // Orchestrator session is dead
      mockSessionBackend.sessionExists.mockReturnValue(false);

      await (service as any).performActivityCheck();

      // Heartbeat file should be updated for dead orchestrator
      expect(mockAgentHeartbeatService.updateAgentHeartbeat).toHaveBeenCalledWith(
        CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
        undefined,
        'inactive'
      );
      expect(mockStorageService.updateAgentStatus).toHaveBeenCalledWith(
        CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
        'inactive'
      );
    });

    it('should leave stale agent as active when session is still alive', async () => {
      mockAgentHeartbeatService.detectStaleAgents.mockResolvedValue(['orchestrator']);
      mockAgentHeartbeatService.getAllAgentHeartbeats.mockResolvedValue({
        orchestrator: {
          agentId: 'orchestrator',
          sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
          agentStatus: 'active',
          lastActiveTime: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        teamMembers: {},
        metadata: { lastUpdated: new Date().toISOString(), version: '1.0.0' },
      });
      // Session is alive — agent is just idle, leave it
      mockSessionBackend.sessionExists.mockReturnValue(true);

      await (service as any).performActivityCheck();

      expect(mockStorageService.updateAgentStatus).not.toHaveBeenCalled();
    });

    it('should handle errors during stale agent cleanup gracefully', async () => {
      mockAgentHeartbeatService.detectStaleAgents.mockResolvedValue(['orchestrator']);
      mockAgentHeartbeatService.getAllAgentHeartbeats.mockRejectedValue(new Error('Heartbeat file error'));

      await (service as any).performActivityCheck();

      expect(mockLogger.error).toHaveBeenCalledWith('Error during stale agent cleanup', {
        error: 'Heartbeat file error'
      });
      expect(mockStorageService.updateAgentStatus).not.toHaveBeenCalled();
    });

    it('should check orchestrator working status and update teamWorkingStatus.json', async () => {
      mockSessionBackend.sessionExists.mockReturnValueOnce(true); // orchestrator session
      mockSessionBackend.captureOutput.mockReturnValue('new terminal output');

      await (service as any).performActivityCheck();

      expect(mockSessionBackend.sessionExists).toHaveBeenCalledWith(CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME);
      expect(mockSessionBackend.captureOutput).toHaveBeenCalledWith(CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME, 5);
    });

    it('should check team member sessions for working status', async () => {
      mockSessionBackend.sessionExists.mockReturnValueOnce(false); // orchestrator session (inactive)
      mockSessionBackend.sessionExists.mockReturnValueOnce(true); // member session

      await (service as any).performActivityCheck();

      expect(mockSessionBackend.sessionExists).toHaveBeenCalledWith('test-session-1');
      expect(mockSessionBackend.captureOutput).toHaveBeenCalledWith('test-session-1', 5);
    });

    it('should set member working status to idle if session no longer exists', async () => {
      mockSessionBackend.sessionExists.mockReturnValueOnce(false); // orchestrator session
      mockSessionBackend.sessionExists.mockReturnValueOnce(false); // member session doesn't exist

      await (service as any).performActivityCheck();

      expect(writeFile).toHaveBeenCalled();
      const savedData = JSON.parse((writeFile as jest.Mock).mock.calls[0][1]);
      expect(savedData.teamMembers['test-session-1'].workingStatus).toBe('idle');
    });

    it('should detect activity and update working status to in_progress', async () => {
      mockSessionBackend.sessionExists.mockReturnValueOnce(false); // orchestrator session
      mockSessionBackend.sessionExists.mockReturnValueOnce(true); // member session exists
      mockSessionBackend.captureOutput.mockReturnValue('new terminal output');

      // Simulate different output from cache (activity detected)
      (service as any).lastTerminalOutputs.set('test-session-1', 'old terminal output');

      await (service as any).performActivityCheck();

      expect(writeFile).toHaveBeenCalled();
      const savedData = JSON.parse((writeFile as jest.Mock).mock.calls[0][1]);
      expect(savedData.teamMembers['test-session-1'].workingStatus).toBe('in_progress');
    });

    it('should not update status if no activity detected (same output)', async () => {
      mockSessionBackend.sessionExists.mockReturnValueOnce(false); // orchestrator session
      mockSessionBackend.sessionExists.mockReturnValueOnce(true); // member session exists
      mockSessionBackend.captureOutput.mockReturnValue('same terminal output');

      // Simulate same output as cache (no activity)
      (service as any).lastTerminalOutputs.set('test-session-1', 'same terminal output');

      await (service as any).performActivityCheck();

      // Should still update metadata but status should remain idle
      expect(writeFile).toHaveBeenCalled();
      const savedData = JSON.parse((writeFile as jest.Mock).mock.calls[0][1]);
      expect(savedData.teamMembers['test-session-1'].workingStatus).toBe('idle');
    });

    it('should check all members with sessions regardless of status', async () => {
      mockSessionBackend.sessionExists.mockReturnValueOnce(false); // orchestrator session
      mockSessionBackend.sessionExists.mockReturnValueOnce(true); // member-1 session
      mockSessionBackend.sessionExists.mockReturnValueOnce(true); // member-2 session

      await (service as any).performActivityCheck();

      expect(mockSessionBackend.sessionExists).toHaveBeenCalledWith('test-session-1');
      expect(mockSessionBackend.sessionExists).toHaveBeenCalledWith('test-session-2');
    });

    it('should handle member working status check errors gracefully', async () => {
      mockSessionBackend.sessionExists.mockReturnValueOnce(false); // orchestrator session
      // Make sessionExists throw synchronously for member check
      // This propagates past Promise.resolve() before the Promise.race .catch() can handle it
      mockSessionBackend.sessionExists.mockImplementationOnce(() => { throw new Error('Session check error'); });

      await (service as any).performActivityCheck();

      expect(mockLogger.error).toHaveBeenCalledWith('Error checking member working status', {
        teamId: 'test-team',
        memberId: 'member-1',
        memberName: 'Test Member 1',
        sessionName: 'test-session-1',
        error: 'Session check error'
      });
    });

    it('should handle overall activity check errors gracefully', async () => {
      mockAgentHeartbeatService.detectStaleAgents.mockRejectedValue(new Error('Heartbeat service error'));

      await (service as any).performActivityCheck();

      expect(mockLogger.error).toHaveBeenCalledWith('Error during activity check', {
        error: 'Heartbeat service error'
      });
    });
  });

  describe('teamWorkingStatus.json file management', () => {
    it('should create default teamWorkingStatus.json if it does not exist', async () => {
      (existsSync as jest.Mock).mockReturnValue(false);
      (writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await (service as any).loadTeamWorkingStatusFile();

      expect(result.orchestrator.sessionName).toBe(CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME);
      expect(result.orchestrator.workingStatus).toBe('idle');
      expect(result.teamMembers).toEqual({});
      expect(result.metadata.version).toBe('1.0.0');
    });

    it('should load existing teamWorkingStatus.json file', async () => {
      const mockData = {
        orchestrator: {
          sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
          workingStatus: 'in_progress',
          lastActivityCheck: '2023-01-01T00:00:00.000Z',
          updatedAt: '2023-01-01T00:00:00.000Z'
        },
        teamMembers: {},
        metadata: {
          lastUpdated: '2023-01-01T00:00:00.000Z',
          version: '1.0.0'
        }
      };
      (existsSync as jest.Mock).mockReturnValue(true);
      (readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockData));

      const result = await (service as any).loadTeamWorkingStatusFile();

      expect(result.orchestrator.workingStatus).toBe('in_progress');
      expect(result.metadata.version).toBe('1.0.0');
    });

    it('should handle corrupted teamWorkingStatus.json file', async () => {
      (existsSync as jest.Mock).mockReturnValue(true);
      (readFile as jest.Mock).mockResolvedValue('invalid json');
      (writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await (service as any).loadTeamWorkingStatusFile();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to load teamWorkingStatus.json, creating new file',
        expect.objectContaining({ error: expect.any(String) })
      );
      expect(result.orchestrator.workingStatus).toBe('idle');
    });
  });

  describe('getTeamWorkingStatus', () => {
    it('should return current team working status data', async () => {
      const mockData = {
        orchestrator: {
          sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
          workingStatus: 'idle',
          lastActivityCheck: '2023-01-01T00:00:00.000Z',
          updatedAt: '2023-01-01T00:00:00.000Z'
        },
        teamMembers: {},
        metadata: {
          lastUpdated: '2023-01-01T00:00:00.000Z',
          version: '1.0.0'
        }
      };
      (existsSync as jest.Mock).mockReturnValue(true);
      (readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockData));

      const result = await service.getTeamWorkingStatus();

      expect(result).toEqual(mockData);
    });
  });

  describe('getWorkingStatusForSession', () => {
    beforeEach(() => {
      const mockData = {
        orchestrator: {
          sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
          workingStatus: 'in_progress',
          lastActivityCheck: '2023-01-01T00:00:00.000Z',
          updatedAt: '2023-01-01T00:00:00.000Z'
        },
        teamMembers: {
          'test-session': {
            sessionName: 'test-session',
            teamMemberId: 'member-1',
            workingStatus: 'idle',
            lastActivityCheck: '2023-01-01T00:00:00.000Z',
            updatedAt: '2023-01-01T00:00:00.000Z'
          }
        },
        metadata: {
          lastUpdated: '2023-01-01T00:00:00.000Z',
          version: '1.0.0'
        }
      };
      (existsSync as jest.Mock).mockReturnValue(true);
      (readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockData));
    });

    it('should return orchestrator working status', async () => {
      const result = await service.getWorkingStatusForSession(CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME);
      expect(result).toBe('in_progress');
    });

    it('should return team member working status', async () => {
      const result = await service.getWorkingStatusForSession('test-session');
      expect(result).toBe('idle');
    });

    it('should return null for non-existent session', async () => {
      const result = await service.getWorkingStatusForSession('non-existent-session');
      expect(result).toBe(null);
    });
  });

  describe('isRunning', () => {
    it('should return false initially', () => {
      expect(service.isRunning()).toBe(false);
    });

    it('should return true when polling is active', () => {
      jest.useFakeTimers();
      service.startPolling();

      expect(service.isRunning()).toBe(true);

      jest.useRealTimers();
      service.stopPolling();
    });
  });

  describe('getPollingInterval', () => {
    it('should return the correct polling interval', () => {
      expect(service.getPollingInterval()).toBe(120000); // 2 minutes
    });
  });

  describe('ANSI stripping and busy-duration gating', () => {
    const mockTeam = {
      id: 'test-team',
      name: 'Test Team',
      projectIds: [],
      createdAt: '2023-01-01T00:00:00.000Z',
      updatedAt: '2023-01-01T00:00:00.000Z',
      members: [
        {
          id: 'member-1',
          name: 'Test Member 1',
          role: 'developer' as const,
          runtimeType: 'claude-code' as const,
          systemPrompt: 'Test prompt',
          agentStatus: 'active' as const,
          workingStatus: 'idle' as const,
          sessionName: 'test-session-1',
          createdAt: '2023-01-01T00:00:00.000Z',
          updatedAt: '2023-01-01T00:00:00.000Z'
        }
      ]
    };

    const mockWorkingStatusData: TeamWorkingStatusFile = {
      orchestrator: {
        sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
        workingStatus: 'idle',
        lastActivityCheck: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z'
      },
      teamMembers: {},
      metadata: {
        lastUpdated: '2023-01-01T00:00:00.000Z',
        version: '1.0.0'
      }
    };

    beforeEach(() => {
      mockStorageService.getTeams.mockResolvedValue([mockTeam]);
      mockSessionBackend.sessionExists.mockReturnValue(true);
      mockAgentHeartbeatService.detectStaleAgents.mockResolvedValue([]);
      (readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockWorkingStatusData));
      (writeFile as jest.Mock).mockResolvedValue(undefined);
      (existsSync as jest.Mock).mockReturnValue(true);
    });

    it('should NOT trigger in_progress when output changes are ANSI-only', async () => {
      // stripAnsiCodes mock strips ANSI, so both raw outputs differ but
      // after stripping they produce the same cleaned text.
      const mockedStripAnsi = stripAnsiCodes as jest.Mock;
      mockedStripAnsi.mockImplementation(() => 'same clean output');

      // First call: raw output A (stores cleaned "same clean output")
      mockSessionBackend.captureOutput.mockReturnValue('\x1b[32msame clean output\x1b[0m');

      // Orchestrator session inactive for simplicity
      mockSessionBackend.sessionExists
        .mockReturnValueOnce(false)   // orchestrator
        .mockReturnValueOnce(true);   // member

      await (service as any).performActivityCheck();

      // Now second call with different ANSI codes but same cleaned text
      mockSessionBackend.captureOutput.mockReturnValue('\x1b[33msame clean output\x1b[0m');
      mockSessionBackend.sessionExists
        .mockReturnValueOnce(false)   // orchestrator
        .mockReturnValueOnce(true);   // member

      await (service as any).performActivityCheck();

      // The status should remain idle because stripped output is identical
      const savedCalls = (writeFile as jest.Mock).mock.calls;
      const lastSaved = JSON.parse(savedCalls[savedCalls.length - 1][1]);
      expect(lastSaved.teamMembers['test-session-1'].workingStatus).toBe('idle');
    });

    it('should NOT emit events for brief in_progress cycles (< MIN_BUSY_DURATION_MS)', async () => {
      const mockEventBus = { publish: jest.fn() };
      service.setEventBusService(mockEventBus as any);

      const mockedStripAnsi = stripAnsiCodes as jest.Mock;
      mockedStripAnsi.mockImplementation((s: string) => s);

      // Seed previous output so first check sees a change
      (service as any).lastTerminalOutputs.set('test-session-1', 'old output');

      // First check: output changed → in_progress (but < MIN_BUSY_DURATION_MS)
      mockSessionBackend.captureOutput.mockReturnValue('new output');
      mockSessionBackend.sessionExists
        .mockReturnValueOnce(false)   // orchestrator
        .mockReturnValueOnce(true);   // member

      await (service as any).performActivityCheck();

      // Verify status file updated to in_progress
      let savedCalls = (writeFile as jest.Mock).mock.calls;
      let lastSaved = JSON.parse(savedCalls[savedCalls.length - 1][1]);
      expect(lastSaved.teamMembers['test-session-1'].workingStatus).toBe('in_progress');

      // But no agent:busy event should be emitted (too soon)
      const busyEvents = mockEventBus.publish.mock.calls.filter(
        (c: any[]) => c[0].type === 'agent:busy' && c[0].sessionName === 'test-session-1'
      );
      expect(busyEvents).toHaveLength(0);

      // Second check: output same → idle (brief cycle)
      mockSessionBackend.captureOutput.mockReturnValue('new output');
      mockSessionBackend.sessionExists
        .mockReturnValueOnce(false)   // orchestrator
        .mockReturnValueOnce(true);   // member

      await (service as any).performActivityCheck();

      // back to idle
      savedCalls = (writeFile as jest.Mock).mock.calls;
      lastSaved = JSON.parse(savedCalls[savedCalls.length - 1][1]);
      expect(lastSaved.teamMembers['test-session-1'].workingStatus).toBe('idle');

      // Neither agent:busy nor agent:idle should have been emitted
      const allMemberEvents = mockEventBus.publish.mock.calls.filter(
        (c: any[]) => c[0].sessionName === 'test-session-1'
      );
      expect(allMemberEvents).toHaveLength(0);
    });

    it('should emit agent:busy then agent:idle for sustained in_progress (>= MIN_BUSY_DURATION_MS)', async () => {
      const mockEventBus = { publish: jest.fn() };
      service.setEventBusService(mockEventBus as any);

      const mockedStripAnsi = stripAnsiCodes as jest.Mock;
      mockedStripAnsi.mockImplementation((s: string) => s);

      // Make readFile return the last written data so status persists across checks
      let lastWrittenData = JSON.stringify(mockWorkingStatusData);
      (writeFile as jest.Mock).mockImplementation((_path: string, content: string) => {
        lastWrittenData = content;
        return Promise.resolve();
      });
      (readFile as jest.Mock).mockImplementation(() => Promise.resolve(lastWrittenData));

      // Seed previous output so first check detects a change
      (service as any).lastTerminalOutputs.set('test-session-1', 'old output');

      // First check: output changed → in_progress
      mockSessionBackend.captureOutput.mockReturnValue('new output');
      mockSessionBackend.sessionExists
        .mockReturnValueOnce(false)   // orchestrator
        .mockReturnValueOnce(true);   // member

      await (service as any).performActivityCheck();

      // Manually backdate the busy transition timestamp to simulate elapsed time
      const memberKey = 'test-session-1';
      (service as any).busyTransitionTimestamps.set(
        memberKey,
        Date.now() - PTY_CONSTANTS.MIN_BUSY_DURATION_MS - 1
      );

      // Second check: still in_progress (different output), should now emit agent:busy
      mockSessionBackend.captureOutput.mockReturnValue('even newer output');
      mockSessionBackend.sessionExists
        .mockReturnValueOnce(false)   // orchestrator
        .mockReturnValueOnce(true);   // member

      await (service as any).performActivityCheck();

      const busyEvents = mockEventBus.publish.mock.calls.filter(
        (c: any[]) => c[0].type === 'agent:busy' && c[0].sessionName === 'test-session-1'
      );
      expect(busyEvents).toHaveLength(1);

      // Third check: output same → idle, should emit agent:idle
      mockSessionBackend.captureOutput.mockReturnValue('even newer output');
      mockSessionBackend.sessionExists
        .mockReturnValueOnce(false)   // orchestrator
        .mockReturnValueOnce(true);   // member

      await (service as any).performActivityCheck();

      const idleEvents = mockEventBus.publish.mock.calls.filter(
        (c: any[]) => c[0].type === 'agent:idle' && c[0].sessionName === 'test-session-1'
      );
      expect(idleEvents).toHaveLength(1);
    });
  });
});
