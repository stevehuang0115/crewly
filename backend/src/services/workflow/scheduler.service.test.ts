/**
 * Tests for SchedulerService
 *
 * @module services/workflow/scheduler.service.test
 */

import { SchedulerService } from './scheduler.service.js';
import { StorageService } from '../core/storage.service.js';
import { LoggerService } from '../core/logger.service.js';
import { MessageDeliveryLogModel } from '../../models/ScheduledMessage.js';
import {
  ISessionBackend,
  ISession,
  setSessionBackendForTesting,
  resetSessionBackendFactory,
} from '../session/index.js';
import { AgentRegistrationService } from '../agent/agent-registration.service.js';
import {
  DEFAULT_SCHEDULES,
  DEFAULT_ADAPTIVE_CONFIG,
} from '../../types/scheduler.types.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

// Mock dependencies
jest.mock('../core/storage.service.js');
jest.mock('../core/logger.service.js');
jest.mock('../../models/ScheduledMessage.js');

const mockSendMessage = jest.fn().mockResolvedValue(undefined);
jest.mock('../session/session-command-helper.js', () => ({
  SessionCommandHelper: jest.fn().mockImplementation(() => ({
    sendMessage: mockSendMessage,
  })),
}));

describe('SchedulerService', () => {
  let service: SchedulerService;
  let mockStorageService: jest.Mocked<StorageService>;
  let mockSessionBackend: jest.Mocked<ISessionBackend>;
  let mockSession: jest.Mocked<ISession>;
  let mockAgentRegistrationService: { sendMessageToAgent: jest.Mock; };
  let mockLogger: any;

  const mockDeliveryLog = {
    id: 'log-1',
    scheduledMessageId: expect.any(String),
    messageName: expect.any(String),
    targetTeam: 'test-session',
    targetProject: '',
    message: expect.any(String),
    deliveredAt: expect.any(String),
    success: true,
    createdAt: expect.any(String),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMessage.mockClear();
    jest.useFakeTimers();

    // Create mock session
    mockSession = {
      name: 'test-session',
      pid: 1234,
      cwd: '/test',
      onData: jest.fn().mockReturnValue(() => {}),
      onExit: jest.fn().mockReturnValue(() => {}),
      write: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(),
    };

    // Create mock session backend
    mockSessionBackend = {
      createSession: jest.fn().mockResolvedValue(mockSession),
      getSession: jest.fn().mockReturnValue(mockSession),
      killSession: jest.fn().mockResolvedValue(undefined),
      listSessions: jest.fn().mockReturnValue(['test-session']),
      sessionExists: jest.fn().mockReturnValue(true),
      captureOutput: jest.fn().mockReturnValue(''),
      getTerminalBuffer: jest.fn().mockReturnValue(''),
      getRawHistory: jest.fn().mockReturnValue(''),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    // Set the mock backend for testing
    setSessionBackendForTesting(mockSessionBackend, 'pty');

    mockStorageService = {
      saveDeliveryLog: jest.fn().mockResolvedValue(undefined),
      findMemberBySessionName: jest.fn().mockResolvedValue(null),
      saveRecurringCheck: jest.fn().mockResolvedValue(undefined),
      deleteRecurringCheck: jest.fn().mockResolvedValue(true),
      clearRecurringChecks: jest.fn().mockResolvedValue(undefined),
      getRecurringChecks: jest.fn().mockResolvedValue([]),
      saveOneTimeCheck: jest.fn().mockResolvedValue(undefined),
      deleteOneTimeCheck: jest.fn().mockResolvedValue(true),
      clearOneTimeChecks: jest.fn().mockResolvedValue(undefined),
      getOneTimeChecks: jest.fn().mockResolvedValue([]),
    } as any;

    // Mock AgentRegistrationService for reliable delivery
    mockAgentRegistrationService = {
      sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
    };

    // Mock logger
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    (LoggerService.getInstance as jest.Mock).mockReturnValue({
      createComponentLogger: jest.fn().mockReturnValue(mockLogger),
    });

    (MessageDeliveryLogModel.create as jest.Mock).mockReturnValue(mockDeliveryLog);

    service = new SchedulerService(mockStorageService);
    // Wire up reliable delivery by default
    service.setAgentRegistrationService(mockAgentRegistrationService as any);
  });

  afterEach(() => {
    jest.useRealTimers();
    service.cleanup();
    resetSessionBackendFactory();
  });

  describe('constructor', () => {
    it('should initialize with required services', () => {
      expect(service).toBeInstanceOf(SchedulerService);
    });
  });

  describe('scheduleCheck', () => {
    it('should schedule a one-time check', () => {
      const emitSpy = jest.spyOn(service, 'emit');

      const checkId = service.scheduleCheck('test-session', 5, 'Test message');

      expect(checkId).toBeTruthy();
      expect(emitSpy).toHaveBeenCalledWith(
        'check_scheduled',
        expect.objectContaining({
          id: checkId,
          targetSession: 'test-session',
          message: 'Test message',
          isRecurring: false,
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Scheduled check-in',
        expect.objectContaining({
          checkId,
          targetSession: 'test-session',
          minutes: 5,
        })
      );
    });

    it('should execute check after delay', async () => {
      const emitSpy = jest.spyOn(service, 'emit');

      const checkId = service.scheduleCheck('test-session', 1, 'Test message');

      // Fast forward 1 minute
      jest.advanceTimersByTime(60000);
      await jest.runAllTimersAsync();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'test-session',
        'Test message',
        expect.any(String)
      );
      expect(emitSpy).toHaveBeenCalledWith('check_executed', expect.any(Object));
    });

    it('should remove one-time check from scheduled checks after execution', async () => {
      const checkId = service.scheduleCheck('test-session', 1, 'Test message');
      const initialStats = service.getStats();
      expect(initialStats.oneTimeChecks).toBe(1);

      jest.advanceTimersByTime(60000);
      await jest.runAllTimersAsync();

      const finalStats = service.getStats();
      expect(finalStats.oneTimeChecks).toBe(0);
    });

    it('should schedule with custom message type', () => {
      const checkId = service.scheduleCheck(
        'test-session',
        5,
        'Progress check',
        'progress-check'
      );

      const enhanced = service.getEnhancedMessage(checkId);
      expect(enhanced?.type).toBe('progress-check');
    });
  });

  describe('scheduleRecurringCheck', () => {
    it('should schedule a recurring check', () => {
      const emitSpy = jest.spyOn(service, 'emit');

      const checkId = service.scheduleRecurringCheck('test-session', 10, 'Recurring message');

      expect(checkId).toBeTruthy();
      expect(emitSpy).toHaveBeenCalledWith(
        'recurring_check_scheduled',
        expect.objectContaining({
          id: checkId,
          targetSession: 'test-session',
          message: 'Recurring message',
          isRecurring: true,
          intervalMinutes: 10,
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Scheduled recurring check-in',
        expect.objectContaining({
          checkId,
          targetSession: 'test-session',
          intervalMinutes: 10,
        })
      );
    });

    it('should store recurring check in recurringChecks map', () => {
      const checkId = service.scheduleRecurringCheck('test-session', 10, 'Recurring message');

      const stats = service.getStats();
      expect(stats.recurringChecks).toBe(1);
    });

    it('should execute recurring checks multiple times', async () => {
      service.scheduleRecurringCheck('test-session', 1, 'Recurring message');

      // First execution: advance timer, then flush microtasks to let async executeRecurring complete
      jest.advanceTimersByTime(60000);
      await Promise.resolve(); // enter async executeRecurring
      await Promise.resolve(); // await executeCheck
      await Promise.resolve(); // await resolveRuntimeType
      await Promise.resolve(); // await sendMessageToAgent
      await Promise.resolve(); // await saveDeliveryLog
      await Promise.resolve(); // schedule next timeout

      // Second execution
      jest.advanceTimersByTime(60000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(2);
    });

    it('should track occurrence count', async () => {
      const checkId = service.scheduleRecurringCheck('test-session', 1, 'Recurring message');

      jest.advanceTimersByTime(60000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const enhanced = service.getEnhancedMessage(checkId);
      expect(enhanced?.recurring?.currentOccurrence).toBe(1);
    });

    it('should store maxOccurrences when provided', () => {
      const checkId = service.scheduleRecurringCheck('test-session', 10, 'Limited message', 'progress-check', 5);

      const enhanced = service.getEnhancedMessage(checkId);
      expect(enhanced?.recurring?.maxOccurrences).toBe(5);
    });

    it('should stop after maxOccurrences is reached', async () => {
      const checkId = service.scheduleRecurringCheck('test-session', 1, 'Limited message', 'progress-check', 2);

      // Helper to flush microtasks after advancing timer
      const flushMicrotasks = async () => {
        for (let i = 0; i < 10; i++) {
          await Promise.resolve();
        }
      };

      // First execution
      jest.advanceTimersByTime(60000);
      await flushMicrotasks();

      // Second execution (should hit maxOccurrences and cancel)
      jest.advanceTimersByTime(60000);
      await flushMicrotasks();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(2);

      // Third execution should NOT happen — check was auto-cancelled
      jest.advanceTimersByTime(60000);
      await flushMicrotasks();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(2);
      expect(service.getStats().recurringChecks).toBe(0);
    });

    it('should leave maxOccurrences undefined when not provided', () => {
      const checkId = service.scheduleRecurringCheck('test-session', 10, 'Unlimited message');

      const enhanced = service.getEnhancedMessage(checkId);
      expect(enhanced?.recurring?.maxOccurrences).toBeUndefined();
    });
  });

  describe('scheduleDefaultCheckins', () => {
    it('should schedule default check-ins for new agent', () => {
      const scheduleCheckSpy = jest.spyOn(service, 'scheduleCheck');
      const scheduleRecurringSpy = jest.spyOn(service, 'scheduleRecurringCheck');

      const checkIds = service.scheduleDefaultCheckins('new-agent-session');

      expect(checkIds).toHaveLength(3);
      expect(scheduleCheckSpy).toHaveBeenCalledWith(
        'new-agent-session',
        DEFAULT_SCHEDULES.initialCheck,
        expect.stringContaining('Initial check-in'),
        'check-in'
      );
      expect(scheduleRecurringSpy).toHaveBeenCalledWith(
        'new-agent-session',
        DEFAULT_SCHEDULES.progressCheck,
        expect.stringContaining('Regular check-in'),
        'progress-check'
      );
      expect(scheduleRecurringSpy).toHaveBeenCalledWith(
        'new-agent-session',
        DEFAULT_SCHEDULES.commitReminder,
        expect.stringContaining('Git reminder'),
        'commit-reminder'
      );
    });
  });

  describe('scheduleContinuationCheck', () => {
    it('should schedule a continuation check', () => {
      const emitSpy = jest.spyOn(service, 'emit');

      const checkId = service.scheduleContinuationCheck({
        sessionName: 'test-session',
        delayMinutes: 5,
        agentId: 'agent-1',
        projectPath: '/path/to/project',
      });

      expect(checkId).toBeTruthy();
      expect(emitSpy).toHaveBeenCalledWith('continuation_check_scheduled', {
        checkId,
        sessionName: 'test-session',
        delayMinutes: 5,
      });
    });

    it('should store continuation metadata', () => {
      const checkId = service.scheduleContinuationCheck({
        sessionName: 'test-session',
        delayMinutes: 5,
        agentId: 'agent-1',
        projectPath: '/path/to/project',
      });

      const enhanced = service.getEnhancedMessage(checkId);
      expect(enhanced?.type).toBe('continuation');
      expect(enhanced?.metadata?.triggerContinuation).toBe(true);
      expect(enhanced?.metadata?.agentId).toBe('agent-1');
      expect(enhanced?.metadata?.projectPath).toBe('/path/to/project');
    });

    it('should execute continuation check after delay', async () => {
      const mockContinuationService = {
        handleEvent: jest.fn().mockResolvedValue({}),
      };
      service.setContinuationService(mockContinuationService);

      service.scheduleContinuationCheck({
        sessionName: 'test-session',
        delayMinutes: 1,
        agentId: 'agent-1',
        projectPath: '/path/to/project',
      });

      jest.advanceTimersByTime(60000);
      await jest.runAllTimersAsync();

      expect(mockContinuationService.handleEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: 'explicit_request',
          sessionName: 'test-session',
          agentId: 'agent-1',
          projectPath: '/path/to/project',
        })
      );
    });

    it('should fall back to regular message without continuation service', async () => {
      service.scheduleContinuationCheck({
        sessionName: 'test-session',
        delayMinutes: 1,
      });

      jest.advanceTimersByTime(60000);
      await jest.runAllTimersAsync();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'test-session',
        expect.stringContaining('Continuation check'),
        expect.any(String)
      );
    });

    it('should track continuation checks in stats', () => {
      service.scheduleContinuationCheck({
        sessionName: 'test-session',
        delayMinutes: 5,
      });

      const stats = service.getStats();
      expect(stats.continuationChecks).toBe(1);
    });
  });

  describe('scheduleAdaptiveCheckin', () => {
    it('should schedule adaptive check-in with default config', async () => {
      const checkId = await service.scheduleAdaptiveCheckin('test-session');

      expect(checkId).toBeTruthy();
      expect(service.getStats().adaptiveChecks).toBe(1);
    });

    it('should increase interval for highly active agents', async () => {
      const mockActivityMonitor = {
        getWorkingStatusForSession: jest.fn().mockResolvedValue('in_progress'),
      };
      service.setActivityMonitor(mockActivityMonitor);

      const checkId = await service.scheduleAdaptiveCheckin('test-session', {
        baseInterval: 10,
        minInterval: 5,
        maxInterval: 30,
        adjustmentFactor: 2,
      });

      // Should schedule at 20 minutes (10 * 2)
      const enhanced = service.getEnhancedMessage(checkId);
      const scheduledTime = enhanced?.scheduledFor.getTime();
      const now = Date.now();
      const expectedDelay = 20 * 60 * 1000;

      // Allow some tolerance for execution time
      expect(scheduledTime).toBeGreaterThanOrEqual(now + expectedDelay - 1000);
    });

    it('should decrease interval for idle agents', async () => {
      const mockActivityMonitor = {
        getWorkingStatusForSession: jest.fn().mockResolvedValue('idle'),
      };
      service.setActivityMonitor(mockActivityMonitor);

      const checkId = await service.scheduleAdaptiveCheckin('test-session', {
        baseInterval: 20,
        minInterval: 5,
        maxInterval: 60,
        adjustmentFactor: 2,
      });

      // Should schedule at 10 minutes (20 / 2)
      const enhanced = service.getEnhancedMessage(checkId);
      const scheduledTime = enhanced?.scheduledFor.getTime();
      const now = Date.now();
      const expectedDelay = 10 * 60 * 1000;

      expect(scheduledTime).toBeGreaterThanOrEqual(now + expectedDelay - 1000);
    });

    it('should respect maxInterval limit', async () => {
      const mockActivityMonitor = {
        getWorkingStatusForSession: jest.fn().mockResolvedValue('in_progress'),
      };
      service.setActivityMonitor(mockActivityMonitor);

      const checkId = await service.scheduleAdaptiveCheckin('test-session', {
        baseInterval: 50,
        minInterval: 5,
        maxInterval: 60,
        adjustmentFactor: 2,
      });

      // Should cap at 60 minutes (not 100)
      const enhanced = service.getEnhancedMessage(checkId);
      const scheduledTime = enhanced?.scheduledFor.getTime();
      const now = Date.now();
      const maxDelay = 60 * 60 * 1000;

      expect(scheduledTime).toBeLessThanOrEqual(now + maxDelay + 1000);
    });

    it('should respect minInterval limit', async () => {
      const mockActivityMonitor = {
        getWorkingStatusForSession: jest.fn().mockResolvedValue('idle'),
      };
      service.setActivityMonitor(mockActivityMonitor);

      const checkId = await service.scheduleAdaptiveCheckin('test-session', {
        baseInterval: 8,
        minInterval: 5,
        maxInterval: 60,
        adjustmentFactor: 2,
      });

      // Should cap at 5 minutes (not 4)
      const enhanced = service.getEnhancedMessage(checkId);
      const scheduledTime = enhanced?.scheduledFor.getTime();
      const now = Date.now();
      const minDelay = 5 * 60 * 1000;

      expect(scheduledTime).toBeGreaterThanOrEqual(now + minDelay - 1000);
    });

    it('should handle activity monitor errors gracefully', async () => {
      const mockActivityMonitor = {
        getWorkingStatusForSession: jest.fn().mockRejectedValue(new Error('Monitor error')),
      };
      service.setActivityMonitor(mockActivityMonitor);

      const checkId = await service.scheduleAdaptiveCheckin('test-session');

      // Should still schedule with base interval
      expect(checkId).toBeTruthy();
    });
  });

  describe('cancelCheck', () => {
    it('should cancel one-time check', () => {
      const emitSpy = jest.spyOn(service, 'emit');
      const checkId = service.scheduleCheck('test-session', 5, 'Test message');

      service.cancelCheck(checkId);

      expect(emitSpy).toHaveBeenCalledWith('check_cancelled', { checkId, type: 'one-time' });
      expect(mockLogger.info).toHaveBeenCalledWith('Cancelled one-time check-in', { checkId });
      expect(service.getStats().oneTimeChecks).toBe(0);
    });

    it('should cancel recurring check', () => {
      const emitSpy = jest.spyOn(service, 'emit');
      const checkId = service.scheduleRecurringCheck('test-session', 10, 'Recurring message');

      service.cancelCheck(checkId);

      expect(emitSpy).toHaveBeenCalledWith('check_cancelled', { checkId, type: 'recurring' });
      expect(mockLogger.info).toHaveBeenCalledWith('Cancelled recurring check-in', { checkId });
      expect(service.getStats().recurringChecks).toBe(0);
    });

    it('should cancel continuation check', () => {
      const emitSpy = jest.spyOn(service, 'emit');
      const checkId = service.scheduleContinuationCheck({
        sessionName: 'test-session',
        delayMinutes: 5,
      });

      service.cancelCheck(checkId);

      expect(emitSpy).toHaveBeenCalledWith('check_cancelled', { checkId, type: 'continuation' });
      expect(mockLogger.info).toHaveBeenCalledWith('Cancelled continuation check', { checkId });
      expect(service.getStats().continuationChecks).toBe(0);
    });

    it('should log warning if check not found', () => {
      service.cancelCheck('nonexistent-id');

      expect(mockLogger.warn).toHaveBeenCalledWith('Check-in not found', {
        checkId: 'nonexistent-id',
      });
    });
  });

  describe('cancelAllChecksForSession', () => {
    it('should cancel all checks for specific session', () => {
      const emitSpy = jest.spyOn(service, 'emit');

      // Schedule checks for different sessions
      service.scheduleCheck('session-1', 5, 'Message 1');
      service.scheduleCheck('session-2', 5, 'Message 2');
      const recurringId = service.scheduleRecurringCheck('session-1', 10, 'Recurring for session-1');
      service.scheduleContinuationCheck({
        sessionName: 'session-1',
        delayMinutes: 5,
      });

      service.cancelAllChecksForSession('session-1');

      expect(emitSpy).toHaveBeenCalledWith('session_checks_cancelled', {
        sessionName: 'session-1',
        checkId: recurringId,
      });
      expect(mockLogger.info).toHaveBeenCalledWith('Cancelled all check-ins for session', {
        sessionName: 'session-1',
      });

      // session-1 checks should be removed
      const stats = service.getStats();
      expect(stats.recurringChecks).toBe(0);
    });
  });

  describe('listScheduledChecks', () => {
    it('should list scheduled checks sorted by time', () => {
      service.scheduleRecurringCheck('session-1', 10, 'Message 1');
      service.scheduleRecurringCheck('session-2', 5, 'Message 2');

      const checks = service.listScheduledChecks();

      expect(checks).toHaveLength(2);
      expect(checks[0].targetSession).toBe('session-2'); // Should be first (5 minutes)
      expect(checks[1].targetSession).toBe('session-1'); // Should be second (10 minutes)
    });
  });

  describe('getChecksForSession', () => {
    it('should return checks for specific session', () => {
      service.scheduleRecurringCheck('session-1', 10, 'Message 1');
      service.scheduleRecurringCheck('session-2', 10, 'Message 2');
      service.scheduleRecurringCheck('session-1', 15, 'Message 3');

      const checks = service.getChecksForSession('session-1');

      expect(checks).toHaveLength(2);
      checks.forEach((check) => {
        expect(check.targetSession).toBe('session-1');
      });
    });
  });

  describe('executeCheck', () => {
    it('should execute check via reliable delivery when AgentRegistrationService is available', async () => {
      const emitSpy = jest.spyOn(service, 'emit');

      await (service as any).executeCheck('test-session', 'Test message');

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'test-session',
        'Test message',
        expect.any(String) // runtime type
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Check-in executed via reliable delivery', {
        targetSession: 'test-session',
        messageLength: 12,
      });
      expect(emitSpy).toHaveBeenCalledWith('check_executed', {
        targetSession: 'test-session',
        message: 'Test message',
        executedAt: expect.any(String),
      });
    });

    it('should handle delivery failure from AgentRegistrationService', async () => {
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({
        success: false,
        error: 'Agent not at prompt',
      });
      const emitSpy = jest.spyOn(service, 'emit');

      await (service as any).executeCheck('test-session', 'Test message');

      expect(mockLogger.error).toHaveBeenCalledWith('Error executing check-in', {
        targetSession: 'test-session',
        error: 'Agent not at prompt',
      });
      expect(emitSpy).toHaveBeenCalledWith('check_execution_failed', {
        targetSession: 'test-session',
        message: 'Test message',
        error: 'Agent not at prompt',
      });
    });

    it('should fall back to SessionCommandHelper when AgentRegistrationService is not available', async () => {
      // Create a new service WITHOUT agentRegistrationService
      const fallbackService = new SchedulerService(mockStorageService);

      await (fallbackService as any).executeCheck('test-session', 'Test message');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'AgentRegistrationService not available, using fallback PTY write',
        { targetSession: 'test-session' }
      );
      expect(mockSendMessage).toHaveBeenCalledWith('test-session', 'Test message');
      expect(mockAgentRegistrationService.sendMessageToAgent).not.toHaveBeenCalled();
    });

    it('should skip check in fallback mode if session does not exist', async () => {
      const fallbackService = new SchedulerService(mockStorageService);
      mockSessionBackend.sessionExists.mockReturnValue(false);

      await (fallbackService as any).executeCheck('nonexistent-session', 'Test message');

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Session no longer exists, skipping check-in',
        { targetSession: 'nonexistent-session' }
      );
    });

    it('should create delivery log with correct message name for git reminder', async () => {
      await (service as any).executeCheck('test-session', 'Git reminder: Please commit your changes');

      expect(MessageDeliveryLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messageName: 'Scheduled Git Reminder',
        })
      );
    });

    it('should create delivery log with correct message name for status check', async () => {
      await (service as any).executeCheck('test-session', 'Regular status check message');

      expect(MessageDeliveryLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messageName: 'Scheduled Status Check-in',
        })
      );
    });

    it('should save delivery log', async () => {
      await (service as any).executeCheck('test-session', 'Test message');

      expect(mockStorageService.saveDeliveryLog).toHaveBeenCalledWith(mockDeliveryLog);
    });

    it('should handle delivery log save error gracefully', async () => {
      mockStorageService.saveDeliveryLog.mockRejectedValue(new Error('Log save error'));

      await (service as any).executeCheck('test-session', 'Test message');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error saving scheduler delivery log',
        expect.objectContaining({ error: 'Log save error' })
      );
    });
  });

  describe('executeContinuationCheck', () => {
    it('should call continuation service when configured', async () => {
      const mockContinuationService = {
        handleEvent: jest.fn().mockResolvedValue({}),
      };
      service.setContinuationService(mockContinuationService);

      await (service as any).executeContinuationCheck('test-session', 'agent-1', '/path');

      expect(mockContinuationService.handleEvent).toHaveBeenCalledWith({
        trigger: 'explicit_request',
        sessionName: 'test-session',
        agentId: 'agent-1',
        projectPath: '/path',
        timestamp: expect.any(String),
        metadata: {
          source: 'scheduler',
          scheduledCheck: true,
        },
      });
    });

    it('should handle continuation service errors', async () => {
      const mockContinuationService = {
        handleEvent: jest.fn().mockRejectedValue(new Error('Continuation error')),
      };
      service.setContinuationService(mockContinuationService);

      await (service as any).executeContinuationCheck('test-session', 'agent-1', '/path');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error executing continuation check',
        expect.objectContaining({
          sessionName: 'test-session',
          error: 'Continuation error',
        })
      );
    });
  });

  describe('scheduleRecurringExecution', () => {
    it('should stop recurring execution when check is cancelled', async () => {
      const checkId = service.scheduleRecurringCheck('test-session', 1, 'Test message');

      // Let first execution happen
      jest.advanceTimersByTime(60000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Cancel the check (clears the recurring timeout)
      service.cancelCheck(checkId);

      // Fast forward and verify no more executions
      jest.advanceTimersByTime(60000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(1); // Only the first execution
    });

    it('should track recurring timeouts and clear them on cancel', () => {
      const checkId = service.scheduleRecurringCheck('test-session', 10, 'Test message');

      // Verify the recurring timeout is tracked (access private map via any)
      const recurringTimeouts = (service as any).recurringTimeouts as Map<string, NodeJS.Timeout>;
      expect(recurringTimeouts.has(checkId)).toBe(true);

      // Cancel and verify timeout is cleared
      service.cancelCheck(checkId);
      expect(recurringTimeouts.has(checkId)).toBe(false);
    });

    it('should clear recurring timeouts during cleanup', () => {
      service.scheduleRecurringCheck('test-session', 10, 'Test message');
      service.scheduleRecurringCheck('test-session', 20, 'Another message');

      const recurringTimeouts = (service as any).recurringTimeouts as Map<string, NodeJS.Timeout>;
      expect(recurringTimeouts.size).toBe(2);

      service.cleanup();
      expect(recurringTimeouts.size).toBe(0);
    });

    it('should schedule next execution only after delivery completes', async () => {
      // Use a slow-resolving mock to simulate async delivery
      let resolveDelivery: (() => void) | undefined;
      mockAgentRegistrationService.sendMessageToAgent.mockImplementation(
        () => new Promise<{ success: boolean }>((resolve) => {
          resolveDelivery = () => resolve({ success: true });
        })
      );

      const checkId = service.scheduleRecurringCheck('test-session', 1, 'Test message');
      const recurringTimeouts = (service as any).recurringTimeouts as Map<string, NodeJS.Timeout>;

      // Trigger first execution — the setTimeout fires the async callback
      jest.advanceTimersByTime(60000);
      // Flush microtasks to let async chain reach sendMessageToAgent
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      // At this point delivery is in-flight and resolveDelivery should be assigned
      expect(resolveDelivery).toBeDefined();

      // Resolve the delivery
      resolveDelivery!();
      // Flush microtasks to let the rest of the chain complete
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      // After delivery completes, the next timeout should be scheduled
      expect(recurringTimeouts.has(checkId)).toBe(true);
    });

    it('should auto-cancel recurring check after sustained idle observations', async () => {
      const mockActivityMonitor = {
        getWorkingStatusForSession: jest.fn().mockResolvedValue('idle'),
      };
      service.setActivityMonitor(mockActivityMonitor as any);

      service.scheduleRecurringCheck('test-session', 1, 'Recurring message');

      const flushMicrotasks = async () => {
        for (let i = 0; i < 10; i++) {
          await Promise.resolve();
        }
      };

      // threshold is 3; after 3 intervals it should cancel before delivery.
      jest.advanceTimersByTime(60000);
      await flushMicrotasks();
      jest.advanceTimersByTime(60000);
      await flushMicrotasks();
      jest.advanceTimersByTime(60000);
      await flushMicrotasks();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(2);
      expect(service.getStats().recurringChecks).toBe(0);
    });

    it('should auto-cancel recurring checks for orchestrator session after 3 idle hits', async () => {
      const mockActivityMonitor = {
        getWorkingStatusForSession: jest.fn().mockResolvedValue('idle'),
      };
      service.setActivityMonitor(mockActivityMonitor as any);

      service.scheduleRecurringCheck(ORCHESTRATOR_SESSION_NAME, 1, 'Recurring message');

      const flushMicrotasks = async () => {
        for (let i = 0; i < 10; i++) {
          await Promise.resolve();
        }
      };

      // Idle hit 1 — check still executes
      jest.advanceTimersByTime(60000);
      await flushMicrotasks();
      // Idle hit 2 — check still executes
      jest.advanceTimersByTime(60000);
      await flushMicrotasks();
      // Idle hit 3 — auto-cancelled before execution
      jest.advanceTimersByTime(60000);
      await flushMicrotasks();

      // Should be auto-cancelled after 3 idle hits
      expect(service.getStats().recurringChecks).toBe(0);
      // Only 2 executions (hit 3 was cancelled before execution)
      expect(mockActivityMonitor.getWorkingStatusForSession).toHaveBeenCalled();
    });
  });

  describe('persistence', () => {
    it('should save recurring check to disk when scheduling', async () => {
      const checkId = service.scheduleRecurringCheck('session-1', 10, 'Recurring message');

      // Allow the fire-and-forget .catch() chain to resolve
      await Promise.resolve();

      expect(mockStorageService.saveRecurringCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          id: checkId,
          targetSession: 'session-1',
          message: 'Recurring message',
          intervalMinutes: 10,
          isRecurring: true,
        })
      );
    });

    it('should delete recurring check from disk when cancelling', async () => {
      const checkId = service.scheduleRecurringCheck('session-1', 10, 'Recurring message');

      service.cancelCheck(checkId);

      // Allow the fire-and-forget .catch() chain to resolve
      await Promise.resolve();

      expect(mockStorageService.deleteRecurringCheck).toHaveBeenCalledWith(checkId);
    });

    it('should clear persisted recurring checks during cleanup', async () => {
      service.scheduleRecurringCheck('session-1', 10, 'Message');

      service.cleanup();

      // Allow the fire-and-forget .catch() chain to resolve
      await Promise.resolve();

      expect(mockStorageService.clearRecurringChecks).toHaveBeenCalled();
    });

    it('should restore recurring checks from disk', async () => {
      const persistedChecks = [
        {
          id: 'restored-1',
          targetSession: 'session-1',
          message: 'Restored message',
          scheduledFor: new Date().toISOString(),
          intervalMinutes: 15,
          isRecurring: true,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'restored-2',
          targetSession: 'session-2',
          message: 'Another restored',
          scheduledFor: new Date().toISOString(),
          intervalMinutes: 30,
          isRecurring: true,
          createdAt: new Date().toISOString(),
        },
      ];
      mockStorageService.getRecurringChecks.mockResolvedValue(persistedChecks);

      const restored = await service.restoreRecurringChecks();

      expect(restored).toBe(2);
      expect(service.getStats().recurringChecks).toBe(2);

      // Verify enhanced messages are created
      const enhanced1 = service.getEnhancedMessage('restored-1');
      expect(enhanced1).toBeDefined();
      expect(enhanced1?.sessionName).toBe('session-1');
      expect(enhanced1?.recurring?.interval).toBe(15);

      const enhanced2 = service.getEnhancedMessage('restored-2');
      expect(enhanced2).toBeDefined();
      expect(enhanced2?.sessionName).toBe('session-2');
    });

    it('should skip non-recurring entries when restoring', async () => {
      const persistedChecks = [
        {
          id: 'valid-1',
          targetSession: 'session-1',
          message: 'Valid',
          scheduledFor: new Date().toISOString(),
          intervalMinutes: 15,
          isRecurring: true,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'invalid-1',
          targetSession: 'session-2',
          message: 'Not recurring',
          scheduledFor: new Date().toISOString(),
          intervalMinutes: undefined,
          isRecurring: false,
          createdAt: new Date().toISOString(),
        },
      ];
      mockStorageService.getRecurringChecks.mockResolvedValue(persistedChecks);

      const restored = await service.restoreRecurringChecks();

      expect(restored).toBe(1);
      expect(service.getStats().recurringChecks).toBe(1);
    });

    it('should return 0 when no persisted checks exist', async () => {
      mockStorageService.getRecurringChecks.mockResolvedValue([]);

      const restored = await service.restoreRecurringChecks();

      expect(restored).toBe(0);
    });

    it('should handle restore errors gracefully', async () => {
      mockStorageService.getRecurringChecks.mockRejectedValue(new Error('Disk read failed'));

      const restored = await service.restoreRecurringChecks();

      expect(restored).toBe(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to restore recurring checks',
        expect.objectContaining({ error: 'Disk read failed' })
      );
    });

    it('should save one-time check to disk when scheduling', async () => {
      const checkId = service.scheduleCheck('session-1', 5, 'One-time message');

      // Allow the fire-and-forget .catch() chain to resolve
      await Promise.resolve();

      expect(mockStorageService.saveOneTimeCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          id: checkId,
          targetSession: 'session-1',
          message: 'One-time message',
          isRecurring: false,
        })
      );
    });

    it('should delete one-time check from disk after execution', async () => {
      const checkId = service.scheduleCheck('session-1', 1, 'One-time message');

      jest.advanceTimersByTime(60000);
      await jest.runAllTimersAsync();

      expect(mockStorageService.deleteOneTimeCheck).toHaveBeenCalledWith(checkId);
    });

    it('should delete one-time check from disk when cancelling', async () => {
      const checkId = service.scheduleCheck('session-1', 5, 'One-time message');

      service.cancelCheck(checkId);

      // Allow the fire-and-forget .catch() chain to resolve
      await Promise.resolve();

      expect(mockStorageService.deleteOneTimeCheck).toHaveBeenCalledWith(checkId);
    });

    it('should clear persisted one-time checks during cleanup', async () => {
      service.scheduleCheck('session-1', 5, 'Message');

      service.cleanup();

      // Allow the fire-and-forget .catch() chain to resolve
      await Promise.resolve();

      expect(mockStorageService.clearOneTimeChecks).toHaveBeenCalled();
    });

    it('should restore one-time checks from disk', async () => {
      const futureTime = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now
      const persistedChecks = [
        {
          id: 'ot-1',
          targetSession: 'session-1',
          message: 'Restored one-time',
          scheduledFor: futureTime.toISOString(),
          isRecurring: false,
          createdAt: new Date().toISOString(),
        },
      ];
      mockStorageService.getOneTimeChecks.mockResolvedValue(persistedChecks);

      const restored = await service.restoreOneTimeChecks();

      expect(restored).toBe(1);
      expect(service.getStats().oneTimeChecks).toBe(1);

      const enhanced = service.getEnhancedMessage('ot-1');
      expect(enhanced).toBeDefined();
      expect(enhanced?.sessionName).toBe('session-1');
    });

    it('should skip stale one-time checks when restoring', async () => {
      const pastTime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
      const persistedChecks = [
        {
          id: 'stale-1',
          targetSession: 'session-1',
          message: 'Stale check',
          scheduledFor: pastTime.toISOString(),
          isRecurring: false,
          createdAt: new Date().toISOString(),
        },
      ];
      mockStorageService.getOneTimeChecks.mockResolvedValue(persistedChecks);

      const restored = await service.restoreOneTimeChecks();

      expect(restored).toBe(0);
      expect(mockStorageService.deleteOneTimeCheck).toHaveBeenCalledWith('stale-1');
    });

    it('should return 0 when no persisted one-time checks exist', async () => {
      mockStorageService.getOneTimeChecks.mockResolvedValue([]);

      const restored = await service.restoreOneTimeChecks();

      expect(restored).toBe(0);
    });

    it('should handle restore one-time check errors gracefully', async () => {
      mockStorageService.getOneTimeChecks.mockRejectedValue(new Error('Disk read failed'));

      const restored = await service.restoreOneTimeChecks();

      expect(restored).toBe(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to restore one-time checks',
        expect.objectContaining({ error: 'Disk read failed' })
      );
    });

    it('should not call save for non-recurring checks via saveRecurringCheck', async () => {
      service.scheduleCheck('session-1', 5, 'One-time message');

      await Promise.resolve();

      expect(mockStorageService.saveRecurringCheck).not.toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      service.scheduleCheck('session-1', 5, 'Message 1');
      service.scheduleCheck('session-2', 5, 'Message 2');
      service.scheduleRecurringCheck('session-1', 10, 'Recurring 1');
      service.scheduleRecurringCheck('session-3', 10, 'Recurring 2');
      service.scheduleContinuationCheck({
        sessionName: 'session-4',
        delayMinutes: 5,
      });

      const stats = service.getStats();

      expect(stats.oneTimeChecks).toBe(2);
      expect(stats.recurringChecks).toBe(2);
      expect(stats.continuationChecks).toBe(1);
      expect(stats.totalActiveSessions).toBe(4);
    });

    it('should count unique sessions correctly', () => {
      service.scheduleRecurringCheck('session-1', 10, 'Recurring 1');
      service.scheduleRecurringCheck('session-1', 15, 'Recurring 2'); // Same session
      service.scheduleRecurringCheck('session-2', 10, 'Recurring 3');

      const stats = service.getStats();

      expect(stats.totalActiveSessions).toBe(2); // Only session-1 and session-2
    });
  });

  describe('cleanup', () => {
    it('should cleanup all scheduled checks', () => {
      service.scheduleCheck('session-1', 5, 'Message 1');
      service.scheduleRecurringCheck('session-2', 10, 'Message 2');
      service.scheduleContinuationCheck({
        sessionName: 'session-3',
        delayMinutes: 5,
      });

      const initialStats = service.getStats();
      expect(initialStats.oneTimeChecks).toBe(1);
      expect(initialStats.recurringChecks).toBe(1);
      expect(initialStats.continuationChecks).toBe(1);

      service.cleanup();

      const finalStats = service.getStats();
      expect(finalStats.oneTimeChecks).toBe(0);
      expect(finalStats.recurringChecks).toBe(0);
      expect(finalStats.continuationChecks).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith('Scheduler service cleaned up');
    });
  });

  describe('getEnhancedMessage', () => {
    it('should return enhanced message for scheduled check', () => {
      const checkId = service.scheduleCheck('test-session', 5, 'Test message', 'progress-check');

      const enhanced = service.getEnhancedMessage(checkId);

      expect(enhanced).toBeDefined();
      expect(enhanced?.id).toBe(checkId);
      expect(enhanced?.sessionName).toBe('test-session');
      expect(enhanced?.message).toBe('Test message');
      expect(enhanced?.type).toBe('progress-check');
    });

    it('should return undefined for unknown check ID', () => {
      const enhanced = service.getEnhancedMessage('unknown-id');

      expect(enhanced).toBeUndefined();
    });
  });

  describe('setContinuationService', () => {
    it('should set continuation service for integration', () => {
      const mockContinuationService = {
        handleEvent: jest.fn(),
      };

      service.setContinuationService(mockContinuationService);

      expect(mockLogger.info).toHaveBeenCalledWith('ContinuationService integration enabled');
    });
  });

  describe('setActivityMonitor', () => {
    it('should set activity monitor for adaptive scheduling', () => {
      const mockActivityMonitor = {
        getWorkingStatusForSession: jest.fn(),
      };

      service.setActivityMonitor(mockActivityMonitor);

      expect(mockLogger.info).toHaveBeenCalledWith('ActivityMonitor integration enabled');
    });
  });

  describe('setAgentRegistrationService', () => {
    it('should set AgentRegistrationService for reliable delivery', () => {
      const newService = new SchedulerService(mockStorageService);
      const mockARS = { sendMessageToAgent: jest.fn() };

      newService.setAgentRegistrationService(mockARS as any);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'AgentRegistrationService integration enabled for reliable delivery'
      );
    });
  });

  describe('setTaskTrackingService', () => {
    it('should set TaskTrackingService for task-aware cleanup', () => {
      const newService = new SchedulerService(mockStorageService);
      const mockTTS = { getAllInProgressTasks: jest.fn() };

      newService.setTaskTrackingService(mockTTS);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'TaskTrackingService integration enabled for task-aware cleanup'
      );
    });
  });

  describe('task-aware schedule cleanup', () => {
    let mockTaskTrackingService: { getAllInProgressTasks: jest.Mock };

    beforeEach(() => {
      mockTaskTrackingService = {
        getAllInProgressTasks: jest.fn().mockResolvedValue([]),
      };
      service.setTaskTrackingService(mockTaskTrackingService);
    });

    it('should accept taskId in scheduleRecurringCheck options', () => {
      const checkId = service.scheduleRecurringCheck(
        'test-session', 10, 'Progress check', 'progress-check', undefined,
        { taskId: 'task-123' }
      );

      const checks = service.listScheduledChecks();
      const check = checks.find(c => c.id === checkId);
      expect(check?.taskId).toBe('task-123');
    });

    it('should auto-cancel recurring check when linked task is completed (on execution)', async () => {
      // Task is still active initially
      mockTaskTrackingService.getAllInProgressTasks.mockResolvedValue([
        { id: 'task-abc', status: 'assigned' },
      ]);

      const checkId = service.scheduleRecurringCheck(
        'test-session', 1, 'Progress check', 'progress-check', undefined,
        { taskId: 'task-abc' }
      );

      expect(service.getStats().recurringChecks).toBe(1);

      // Now simulate task completion — task no longer in active list
      mockTaskTrackingService.getAllInProgressTasks.mockResolvedValue([]);

      const flushMicrotasks = async () => {
        for (let i = 0; i < 15; i++) {
          await Promise.resolve();
        }
      };

      // Trigger first execution
      jest.advanceTimersByTime(60000);
      await flushMicrotasks();

      // Check should have been cancelled
      expect(service.getStats().recurringChecks).toBe(0);
      // executeCheck should NOT have been called since we cancelled before delivery
      expect(mockAgentRegistrationService.sendMessageToAgent).not.toHaveBeenCalled();
    });

    it('should not auto-cancel recurring check when linked task is still active', async () => {
      mockTaskTrackingService.getAllInProgressTasks.mockResolvedValue([
        { id: 'task-active', status: 'assigned' },
      ]);

      service.scheduleRecurringCheck(
        'test-session', 1, 'Progress check', 'progress-check', undefined,
        { taskId: 'task-active' }
      );

      const flushMicrotasks = async () => {
        for (let i = 0; i < 15; i++) {
          await Promise.resolve();
        }
      };

      jest.advanceTimersByTime(60000);
      await flushMicrotasks();

      // Check should still be active — task is not completed
      expect(service.getStats().recurringChecks).toBe(1);
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(1);
    });

    it('should behave normally for recurring checks without taskId', async () => {
      service.scheduleRecurringCheck('test-session', 1, 'No task check');

      const flushMicrotasks = async () => {
        for (let i = 0; i < 15; i++) {
          await Promise.resolve();
        }
      };

      jest.advanceTimersByTime(60000);
      await flushMicrotasks();

      // Should execute normally
      expect(service.getStats().recurringChecks).toBe(1);
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(1);
    });

    it('should purge persisted recurring check on restore when task is completed', async () => {
      // Task is completed (not in active list)
      mockTaskTrackingService.getAllInProgressTasks.mockResolvedValue([]);

      const persistedChecks = [
        {
          id: 'restored-with-task',
          targetSession: 'session-1',
          message: 'Progress check',
          scheduledFor: new Date().toISOString(),
          intervalMinutes: 5,
          isRecurring: true,
          createdAt: new Date().toISOString(),
          taskId: 'completed-task-id',
        },
      ];
      mockStorageService.getRecurringChecks.mockResolvedValue(persistedChecks);

      const restored = await service.restoreRecurringChecks();

      expect(restored).toBe(0);
      expect(service.getStats().recurringChecks).toBe(0);
      expect(mockStorageService.deleteRecurringCheck).toHaveBeenCalledWith('restored-with-task');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Purging persisted recurring check for completed task',
        expect.objectContaining({
          checkId: 'restored-with-task',
          taskId: 'completed-task-id',
        })
      );
    });

    it('should restore persisted recurring check when task is still active', async () => {
      mockTaskTrackingService.getAllInProgressTasks.mockResolvedValue([
        { id: 'active-task-id', status: 'assigned' },
      ]);

      const persistedChecks = [
        {
          id: 'restored-active-task',
          targetSession: 'session-1',
          message: 'Progress check',
          scheduledFor: new Date().toISOString(),
          intervalMinutes: 5,
          isRecurring: true,
          createdAt: new Date().toISOString(),
          taskId: 'active-task-id',
        },
      ];
      mockStorageService.getRecurringChecks.mockResolvedValue(persistedChecks);

      const restored = await service.restoreRecurringChecks();

      expect(restored).toBe(1);
      expect(service.getStats().recurringChecks).toBe(1);
      expect(mockStorageService.deleteRecurringCheck).not.toHaveBeenCalled();
    });

    it('should restore persisted recurring check without taskId normally', async () => {
      const persistedChecks = [
        {
          id: 'restored-no-task',
          targetSession: 'session-1',
          message: 'Regular check',
          scheduledFor: new Date().toISOString(),
          intervalMinutes: 10,
          isRecurring: true,
          createdAt: new Date().toISOString(),
        },
      ];
      mockStorageService.getRecurringChecks.mockResolvedValue(persistedChecks);

      const restored = await service.restoreRecurringChecks();

      expect(restored).toBe(1);
      expect(service.getStats().recurringChecks).toBe(1);
    });
  });
});
