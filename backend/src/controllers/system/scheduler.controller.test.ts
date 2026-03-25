import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Request, Response } from 'express';
import * as schedulerHandlers from './scheduler.controller.js';
import type { ApiContext } from '../types.js';

describe('Scheduler Handlers', () => {
  let mockApiContext: Partial<ApiContext>;
  let mockRequest: Partial<Request>;
  let mockResponse: any;
  let mockSchedulerService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSchedulerService = {
      scheduleCheck: jest.fn<any>(),
      scheduleRecurringCheck: jest.fn<any>(),
      getChecksForSession: jest.fn<any>(),
      listScheduledChecks: jest.fn<any>(),
      cancelCheck: jest.fn<any>(),
      cancelAllChecks: jest.fn<any>(),
    };

    mockApiContext = {
      schedulerService: mockSchedulerService
    } as any;

    mockRequest = {
      params: { id: 'check-123' },
      body: {
        targetSession: 'session-1',
        minutes: 30,
        message: 'Check-in reminder',
        isRecurring: false,
        intervalMinutes: 60
      },
      query: { session: 'session-1' }
    };

    mockResponse = {
      json: jest.fn<any>(),
      status: jest.fn<any>().mockReturnThis()
    };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('scheduleCheck', () => {
    it('should schedule a one-time check successfully', async () => {
      const mockCheckId = 'check-456';
      mockSchedulerService.scheduleCheck.mockReturnValue(mockCheckId);

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.scheduleCheck).toHaveBeenCalledWith('session-1', 30, 'Check-in reminder');
      expect(mockResponse.status).toHaveBeenCalledWith(201);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: { checkId: mockCheckId },
        message: 'Check-in scheduled successfully'
      });
    });

    it('should schedule a recurring check successfully', async () => {
      const mockCheckId = 'recurring-check-789';
      mockSchedulerService.scheduleRecurringCheck.mockReturnValue(mockCheckId);

      mockRequest.body = {
        targetSession: 'session-1',
        minutes: 30,
        message: 'Recurring reminder',
        isRecurring: true,
        intervalMinutes: 60
      };

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.scheduleRecurringCheck).toHaveBeenCalledWith('session-1', 60, 'Recurring reminder', 'progress-check', undefined);
      expect(mockResponse.status).toHaveBeenCalledWith(201);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: { checkId: mockCheckId },
        message: 'Check-in scheduled successfully'
      });
    });

    it('should return 400 when targetSession is missing', async () => {
      mockRequest.body = {
        minutes: 30,
        message: 'Check-in reminder'
      };

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'targetSession, minutes, and message are required'
      });
      expect(mockSchedulerService.scheduleCheck).not.toHaveBeenCalled();
    });

    it('should return 400 when minutes is missing', async () => {
      mockRequest.body = {
        targetSession: 'session-1',
        message: 'Check-in reminder'
      };

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'targetSession, minutes, and message are required'
      });
    });

    it('should return 400 when message is missing', async () => {
      mockRequest.body = {
        targetSession: 'session-1',
        minutes: 30
      };

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'targetSession, minutes, and message are required'
      });
    });

    it('should pass maxOccurrences to recurring check', async () => {
      const mockCheckId = 'recurring-max-occ';
      mockSchedulerService.scheduleRecurringCheck.mockReturnValue(mockCheckId);

      mockRequest.body = {
        targetSession: 'session-1',
        minutes: 30,
        message: 'Limited recurring',
        isRecurring: true,
        intervalMinutes: 10,
        maxOccurrences: 6
      };

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.scheduleRecurringCheck).toHaveBeenCalledWith('session-1', 10, 'Limited recurring', 'progress-check', 6);
      expect(mockResponse.status).toHaveBeenCalledWith(201);
    });

    it('should handle recurring check without intervalMinutes', async () => {
      const mockCheckId = 'check-no-interval';
      mockSchedulerService.scheduleCheck.mockReturnValue(mockCheckId);

      mockRequest.body = {
        targetSession: 'session-1',
        minutes: 30,
        message: 'Check-in reminder',
        isRecurring: true
      };

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.scheduleCheck).toHaveBeenCalledWith('session-1', 30, 'Check-in reminder');
      expect(mockSchedulerService.scheduleRecurringCheck).not.toHaveBeenCalled();
    });

    it('should handle scheduler service errors', async () => {
      mockSchedulerService.scheduleCheck.mockImplementation(() => {
        throw new Error('Scheduler error');
      });

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to schedule check-in'
      });
    });

    it('should handle empty string values as missing', async () => {
      mockRequest.body = {
        targetSession: '',
        minutes: 30,
        message: 'Check-in reminder'
      };

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'targetSession, minutes, and message are required'
      });
    });
  });

  describe('getScheduledChecks', () => {
    it('should return checks for specific session when session query provided', async () => {
      const mockChecks = [
        { id: 'check-1', sessionName: 'session-1', message: 'First check' },
        { id: 'check-2', sessionName: 'session-1', message: 'Second check' }
      ];

      mockSchedulerService.getChecksForSession.mockReturnValue(mockChecks);

      await schedulerHandlers.getScheduledChecks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.getChecksForSession).toHaveBeenCalledWith('session-1');
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: mockChecks
      });
    });

    it('should return all scheduled checks when no session query provided', async () => {
      const mockAllChecks: any[] = [
        { id: 'check-1', sessionName: 'session-1', message: 'Check 1' },
        { id: 'check-2', sessionName: 'session-2', message: 'Check 2' },
        { id: 'check-3', sessionName: 'session-1', message: 'Check 3' }
      ];

      mockSchedulerService.listScheduledChecks.mockReturnValue(mockAllChecks);
      mockRequest.query = {};

      await schedulerHandlers.getScheduledChecks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.listScheduledChecks).toHaveBeenCalled();
      expect(mockSchedulerService.getChecksForSession).not.toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: mockAllChecks
      });
    });

    it('should return empty array when no checks exist', async () => {
      mockSchedulerService.listScheduledChecks.mockReturnValue([]);
      mockRequest.query = {};

      await schedulerHandlers.getScheduledChecks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: []
      });
    });

    it('should handle scheduler service errors', async () => {
      mockSchedulerService.listScheduledChecks.mockImplementation(() => {
        throw new Error('Scheduler retrieval error');
      });

      mockRequest.query = {};

      await schedulerHandlers.getScheduledChecks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to retrieve scheduled checks'
      });
    });

    it('should handle empty session parameter', async () => {
      const mockAllChecks: any[] = [];
      mockSchedulerService.listScheduledChecks.mockReturnValue(mockAllChecks);
      mockRequest.query = { session: '' };

      await schedulerHandlers.getScheduledChecks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.listScheduledChecks).toHaveBeenCalled();
      expect(mockSchedulerService.getChecksForSession).not.toHaveBeenCalled();
    });
  });

  describe('cancelScheduledCheck', () => {
    it('should cancel scheduled check successfully when found in memory', async () => {
      mockSchedulerService.cancelCheck.mockReturnValue(true);

      await schedulerHandlers.cancelScheduledCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.cancelCheck).toHaveBeenCalledWith('check-123');
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Check-in cancelled successfully'
      });
    });

    it('should return success with fallback message when not found in memory (#290)', async () => {
      mockSchedulerService.cancelCheck.mockReturnValue(false);

      await schedulerHandlers.cancelScheduledCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.cancelCheck).toHaveBeenCalledWith('check-123');
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Check-in not found in memory; persisted entry cleanup triggered'
      });
    });

    it('should handle missing check ID parameter', async () => {
      mockRequest.params = {};
      mockSchedulerService.cancelCheck.mockReturnValue(false);

      await schedulerHandlers.cancelScheduledCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.cancelCheck).toHaveBeenCalledWith(undefined);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Check-in not found in memory; persisted entry cleanup triggered'
      });
    });

    it('should handle scheduler service errors during cancellation', async () => {
      mockSchedulerService.cancelCheck.mockImplementation(() => {
        throw new Error('Cancellation error');
      });

      await schedulerHandlers.cancelScheduledCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to cancel check-in'
      });
    });

    it('should handle empty string check ID', async () => {
      mockRequest.params = { id: '' };
      mockSchedulerService.cancelCheck.mockReturnValue(false);

      await schedulerHandlers.cancelScheduledCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.cancelCheck).toHaveBeenCalledWith('');
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Check-in not found in memory; persisted entry cleanup triggered'
      });
    });
  });

  describe('cancelAllScheduledChecks', () => {
    it('should cancel all checks without filters', async () => {
      mockSchedulerService.cancelAllChecks.mockReturnValue(5);
      mockRequest.query = {};

      await schedulerHandlers.cancelAllScheduledChecks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.cancelAllChecks).toHaveBeenCalledWith(undefined);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: { cancelled: 5 },
        message: 'Cancelled 5 scheduled check(s)',
      });
    });

    it('should cancel checks filtered by session', async () => {
      mockSchedulerService.cancelAllChecks.mockReturnValue(3);
      mockRequest.query = { session: 'agent-sam' };

      await schedulerHandlers.cancelAllScheduledChecks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.cancelAllChecks).toHaveBeenCalledWith({ session: 'agent-sam' });
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: { cancelled: 3 },
        message: 'Cancelled 3 scheduled check(s)',
      });
    });

    it('should cancel checks filtered by age', async () => {
      mockSchedulerService.cancelAllChecks.mockReturnValue(2);
      mockRequest.query = { olderThanMinutes: '60' };

      await schedulerHandlers.cancelAllScheduledChecks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.cancelAllChecks).toHaveBeenCalledWith({ olderThanMinutes: 60 });
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: { cancelled: 2 },
        message: 'Cancelled 2 scheduled check(s)',
      });
    });

    it('should handle combined filters', async () => {
      mockSchedulerService.cancelAllChecks.mockReturnValue(1);
      mockRequest.query = { session: 'agent-sam', olderThanMinutes: '30' };

      await schedulerHandlers.cancelAllScheduledChecks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.cancelAllChecks).toHaveBeenCalledWith({ session: 'agent-sam', olderThanMinutes: 30 });
    });

    it('should ignore invalid olderThanMinutes', async () => {
      mockSchedulerService.cancelAllChecks.mockReturnValue(5);
      mockRequest.query = { olderThanMinutes: 'invalid' };

      await schedulerHandlers.cancelAllScheduledChecks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.cancelAllChecks).toHaveBeenCalledWith(undefined);
    });

    it('should handle service errors', async () => {
      mockSchedulerService.cancelAllChecks.mockImplementation(() => {
        throw new Error('Cancel all error');
      });
      mockRequest.query = {};

      await schedulerHandlers.cancelAllScheduledChecks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to cancel scheduled checks',
      });
    });
  });

  describe('Error handling', () => {
    it('should handle unexpected errors gracefully', async () => {
      mockSchedulerService.scheduleCheck.mockImplementation(() => {
        throw new TypeError('Unexpected error');
      });

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to schedule check-in'
      });
    });

    it('should handle null scheduler service', async () => {
      mockApiContext.schedulerService = null as any;

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to schedule check-in'
      });
    });
  });

  describe('Context preservation', () => {
    it('should preserve context when handling scheduler operations', async () => {
      const contextAwareController = {
        schedulerService: {
          scheduleCheck: jest.fn<any>().mockReturnValue('check-context-123')
        }
      } as any;

      await schedulerHandlers.scheduleCheck.call(
        contextAwareController,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(contextAwareController.schedulerService.scheduleCheck).toHaveBeenCalledWith('session-1', 30, 'Check-in reminder');
    });
  });

  describe('restoreScheduledChecks', () => {
    it('should restore both recurring and one-time checks', async () => {
      mockSchedulerService.restoreRecurringChecks = jest.fn<any>().mockResolvedValue(3);
      mockSchedulerService.restoreOneTimeChecks = jest.fn<any>().mockResolvedValue(2);

      await schedulerHandlers.restoreScheduledChecks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.restoreRecurringChecks).toHaveBeenCalled();
      expect(mockSchedulerService.restoreOneTimeChecks).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: { recurringRestored: 3, oneTimeRestored: 2 },
        message: 'Restored 3 recurring and 2 one-time checks',
      });
    });

    it('should handle restore errors', async () => {
      mockSchedulerService.restoreRecurringChecks = jest.fn<any>().mockRejectedValue(new Error('Restore failed'));

      await schedulerHandlers.restoreScheduledChecks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to restore scheduled checks',
      });
    });

    it('should handle zero restored checks', async () => {
      mockSchedulerService.restoreRecurringChecks = jest.fn<any>().mockResolvedValue(0);
      mockSchedulerService.restoreOneTimeChecks = jest.fn<any>().mockResolvedValue(0);

      await schedulerHandlers.restoreScheduledChecks.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: { recurringRestored: 0, oneTimeRestored: 0 },
        message: 'Restored 0 recurring and 0 one-time checks',
      });
    });
  });

  describe('taskId passthrough', () => {
    it('should pass taskId to scheduleRecurringCheck when provided', async () => {
      const mockCheckId = 'recurring-with-task';
      mockSchedulerService.scheduleRecurringCheck.mockReturnValue(mockCheckId);

      mockRequest.body = {
        targetSession: 'session-1',
        minutes: 30,
        message: 'Progress check',
        isRecurring: true,
        intervalMinutes: 5,
        taskId: 'task-xyz-123',
      };

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockSchedulerService.scheduleRecurringCheck).toHaveBeenCalledWith(
        'session-1',
        5,
        'Progress check',
        'progress-check',
        undefined,
        expect.objectContaining({ taskId: 'task-xyz-123' })
      );
      expect(mockResponse.status).toHaveBeenCalledWith(201);
    });

    it('should not pass taskId when not provided', async () => {
      const mockCheckId = 'recurring-no-task';
      mockSchedulerService.scheduleRecurringCheck.mockReturnValue(mockCheckId);

      mockRequest.body = {
        targetSession: 'session-1',
        minutes: 30,
        message: 'Progress check',
        isRecurring: true,
        intervalMinutes: 5,
      };

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // Without taskId, hasExtendedSchedule is false, so it takes the non-extended path
      expect(mockSchedulerService.scheduleRecurringCheck).toHaveBeenCalledWith(
        'session-1',
        5,
        'Progress check',
        'progress-check',
        undefined
      );
    });
  });

  describe('All handlers availability', () => {
    it('should have all expected handler functions', () => {
      expect(typeof schedulerHandlers.scheduleCheck).toBe('function');
      expect(typeof schedulerHandlers.getScheduledChecks).toBe('function');
      expect(typeof schedulerHandlers.cancelScheduledCheck).toBe('function');
      expect(typeof schedulerHandlers.cancelAllScheduledChecks).toBe('function');
      expect(typeof schedulerHandlers.restoreScheduledChecks).toBe('function');
    });

    it('should handle async operations properly', async () => {
      mockSchedulerService.scheduleCheck.mockReturnValue('async-check-123');

      const result = await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(result).toBeUndefined();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: { checkId: 'async-check-123' },
        message: 'Check-in scheduled successfully'
      });
    });
  });

  describe('Input validation edge cases', () => {
    it('should handle null values in required fields', async () => {
      mockRequest.body = {
        targetSession: null,
        minutes: 30,
        message: 'Check-in reminder'
      };

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'targetSession, minutes, and message are required'
      });
    });

    it('should handle zero minutes value', async () => {
      const mockCheckId = 'zero-minute-check';
      mockSchedulerService.scheduleCheck.mockReturnValue(mockCheckId);

      mockRequest.body = {
        targetSession: 'session-1',
        minutes: 0,
        message: 'Immediate check'
      };

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'targetSession, minutes, and message are required'
      });
    });

    it('should handle negative minutes value', async () => {
      const mockCheckId = 'negative-minute-check';
      mockSchedulerService.scheduleCheck.mockReturnValue(mockCheckId);

      mockRequest.body = {
        targetSession: 'session-1',
        minutes: -10,
        message: 'Invalid check'
      };

      await schedulerHandlers.scheduleCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // The controller validates with `!minutes` which is falsy for -10 (since -10 is truthy),
      // so validation passes and the check is scheduled successfully with status 201.
      expect(mockResponse.status).toHaveBeenCalledWith(201);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: { checkId: mockCheckId },
        message: 'Check-in scheduled successfully'
      });
    });
  });

  describe('recordManualCheck', () => {
    beforeEach(() => {
      mockSchedulerService.recordManualCheck = jest.fn<any>();
    });

    it('should record manual check and return success', async () => {
      mockRequest.body = { agentSession: 'agent-sam' };

      await schedulerHandlers.recordManualCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockSchedulerService.recordManualCheck).toHaveBeenCalledWith('agent-sam');
      expect(mockResponse.json).toHaveBeenCalledWith({ success: true });
    });

    it('should return 400 when agentSession is missing', async () => {
      mockRequest.body = {};

      await schedulerHandlers.recordManualCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'agentSession is required',
      });
      expect(mockSchedulerService.recordManualCheck).not.toHaveBeenCalled();
    });

    it('should return 400 when agentSession is not a string', async () => {
      mockRequest.body = { agentSession: 123 };

      await schedulerHandlers.recordManualCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });
  });
});
