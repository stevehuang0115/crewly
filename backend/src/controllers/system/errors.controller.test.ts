import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Request, Response } from 'express';
import * as errorsHandlers from './errors.controller.js';
import type { ApiContext } from '../types.js';
import { StorageService, TmuxService, SchedulerService } from '../../services/index.js';
import { ActiveProjectsService } from '../../services/index.js';
import { PromptTemplateService } from '../../services/index.js';
import { ErrorTrackingService } from '../../services/index.js';

// Mock dependencies
jest.mock('../../services/index.js');

describe('Errors Handlers', () => {
  let mockApiContext: ApiContext;
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockErrorTracker: any;
  let responseMock: {
    status: jest.Mock<any>;
    json: jest.Mock<any>;
    send: jest.Mock<any>;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Create response mock
    responseMock = {
      status: jest.fn<any>().mockReturnThis(),
      json: jest.fn<any>().mockReturnThis(),
      send: jest.fn<any>().mockReturnThis(),
    };

    // Mock ErrorTrackingService singleton
    mockErrorTracker = {
      trackError: jest.fn<any>(),
      getErrorStats: jest.fn<any>(),
      getErrors: jest.fn<any>(),
      getError: jest.fn<any>(),
      clearErrors: jest.fn<any>(),
    };
    (ErrorTrackingService.getInstance as jest.Mock<any>).mockReturnValue(mockErrorTracker);

    // Setup API context
    mockApiContext = {
      storageService: new StorageService() as jest.Mocked<StorageService>,
      tmuxService: new TmuxService() as jest.Mocked<TmuxService>,
      schedulerService: new SchedulerService(new StorageService()) as jest.Mocked<SchedulerService>,
      activeProjectsService: new ActiveProjectsService() as jest.Mocked<ActiveProjectsService>,
      promptTemplateService: new PromptTemplateService() as jest.Mocked<PromptTemplateService>,
      agentRegistrationService: {} as unknown as ApiContext['agentRegistrationService'],
    };

    mockRequest = {};
    mockResponse = responseMock as any;
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('trackError', () => {
    it('should track error successfully', async () => {
      mockRequest.body = {
        message: 'Test error message',
        level: 'error',
        source: 'frontend',
        component: 'test',
      };
      mockRequest.headers = {} as any;

      mockErrorTracker.trackError.mockReturnValue('error-123');

      await errorsHandlers.trackError.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockErrorTracker.trackError).toHaveBeenCalledWith(
        'Test error message',
        expect.objectContaining({
          level: 'error',
          source: 'frontend',
          component: 'test',
        })
      );

      expect(responseMock.status).toHaveBeenCalledWith(201);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: { errorId: 'error-123' },
        })
      );
    });

    it('should handle minimal error data', async () => {
      mockRequest.body = {
        message: 'Simple error',
      };
      mockRequest.headers = {} as any;

      mockErrorTracker.trackError.mockReturnValue('error-456');

      await errorsHandlers.trackError.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockErrorTracker.trackError).toHaveBeenCalledWith(
        'Simple error',
        expect.objectContaining({
          level: 'error',
          source: 'frontend',
        })
      );
    });

    it('should return 400 when message is missing', async () => {
      mockRequest.body = {};
      mockRequest.headers = {} as any;

      await errorsHandlers.trackError.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(400);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Error message is required',
        })
      );
    });

    it('should handle ErrorTrackingService errors when tracking', async () => {
      mockRequest.body = {
        message: 'Test error',
      };
      mockRequest.headers = {} as any;

      mockErrorTracker.trackError.mockImplementation(() => {
        throw new Error('Tracking error');
      });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation((() => {}) as any);

      await errorsHandlers.trackError.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error tracking error'));
      expect(responseMock.status).toHaveBeenCalledWith(500);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to track error',
        })
      );

      consoleSpy.mockRestore();
    });
  });

  describe('getErrors', () => {
    it('should return all errors successfully', async () => {
      const mockErrors = [
        {
          id: 'error-1',
          message: 'First error',
          timestamp: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'error-2',
          message: 'Second error',
          timestamp: '2024-01-01T01:00:00.000Z',
        },
      ];

      mockRequest.query = {};
      mockErrorTracker.getErrors.mockReturnValue(mockErrors);

      await errorsHandlers.getErrors.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockErrorTracker.getErrors).toHaveBeenCalled();
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: mockErrors,
        })
      );
    });

    it('should return empty array when no errors exist', async () => {
      mockRequest.query = {};
      mockErrorTracker.getErrors.mockReturnValue([]);

      await errorsHandlers.getErrors.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: [],
        })
      );
    });
  });

  describe('getError', () => {
    it('should return specific error successfully', async () => {
      const mockError = {
        id: 'error-123',
        message: 'Specific error',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      mockRequest.params = { errorId: 'error-123' };
      mockErrorTracker.getError.mockReturnValue(mockError);

      await errorsHandlers.getError.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockErrorTracker.getError).toHaveBeenCalledWith('error-123');
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: mockError,
        })
      );
    });

    it('should return 404 when error not found', async () => {
      mockRequest.params = { errorId: 'nonexistent-error' };
      mockErrorTracker.getError.mockReturnValue(null);

      await errorsHandlers.getError.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.status).toHaveBeenCalledWith(404);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Error not found',
        })
      );
    });
  });

  describe('getErrorStats', () => {
    it('should return error statistics successfully', async () => {
      const mockStats = {
        total: 42,
        byLevel: { error: 30, warning: 12 },
      };

      mockErrorTracker.getErrorStats.mockReturnValue(mockStats);

      await errorsHandlers.getErrorStats.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockErrorTracker.getErrorStats).toHaveBeenCalled();
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: mockStats,
        })
      );
    });

    it('should handle empty stats', async () => {
      const emptyStats = {
        total: 0,
        byLevel: {},
      };

      mockErrorTracker.getErrorStats.mockReturnValue(emptyStats);

      await errorsHandlers.getErrorStats.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: emptyStats,
        })
      );
    });
  });

  describe('clearErrors', () => {
    it('should clear all errors successfully', async () => {
      mockRequest.body = {};
      mockErrorTracker.clearErrors.mockReturnValue(15);

      await errorsHandlers.clearErrors.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockErrorTracker.clearErrors).toHaveBeenCalled();
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: { removedCount: 15 },
        })
      );
    });

    it('should handle clear operation when no errors exist', async () => {
      mockRequest.body = {};
      mockErrorTracker.clearErrors.mockReturnValue(0);

      await errorsHandlers.clearErrors.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: { removedCount: 0 },
        })
      );
    });

    it('should handle ErrorTrackingService errors when clearing', async () => {
      mockRequest.body = {};
      mockErrorTracker.clearErrors.mockImplementation(() => {
        throw new Error('Clear operation failed');
      });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation((() => {}) as any);

      await errorsHandlers.clearErrors.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error clearing errors'));
      expect(responseMock.status).toHaveBeenCalledWith(500);
      expect(responseMock.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to clear errors',
        })
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Error handling', () => {
    it('should handle ErrorTrackingService errors consistently', async () => {
      const handlerTests = [
        {
          handler: errorsHandlers.getErrors,
          setup: () => {
            mockRequest.query = {};
            mockErrorTracker.getErrors.mockImplementation(() => {
              throw new Error('DB error');
            });
          },
        },
        {
          handler: errorsHandlers.getErrorStats,
          setup: () =>
            mockErrorTracker.getErrorStats.mockImplementation(() => {
              throw new Error('Stats error');
            }),
        },
        {
          handler: errorsHandlers.getError,
          setup: () => {
            mockRequest.params = { errorId: 'test-id' };
            mockErrorTracker.getError.mockImplementation(() => {
              throw new Error('Get error');
            });
          },
        },
      ];

      for (const test of handlerTests) {
        jest.clearAllMocks();
        (ErrorTrackingService.getInstance as jest.Mock<any>).mockReturnValue(mockErrorTracker);
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation((() => {}) as any);

        test.setup();

        await test.handler.call(
          mockApiContext,
          mockRequest as Request,
          mockResponse as Response
        );

        expect(consoleSpy).toHaveBeenCalled();
        expect(responseMock.status).toHaveBeenCalledWith(500);
        expect(responseMock.json).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: expect.stringContaining('Failed to'),
          })
        );

        consoleSpy.mockRestore();
      }
    });
  });

  describe('Input validation', () => {
    it('should handle missing request body in trackError', async () => {
      mockRequest.body = null;
      mockRequest.headers = {} as any;

      await errorsHandlers.trackError.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      // With null body, accessing properties throws, resulting in 500
      expect(responseMock.status).toHaveBeenCalledWith(500);
    });

    it('should handle missing error ID parameter', async () => {
      mockRequest.params = {};
      mockErrorTracker.getError.mockReturnValue(null);

      await errorsHandlers.getError.call(
        mockApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockErrorTracker.getError).toHaveBeenCalledWith(undefined);
    });
  });
});
