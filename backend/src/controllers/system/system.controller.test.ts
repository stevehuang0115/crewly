import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Request, Response } from 'express';
import * as os from 'os';
import * as systemHandlers from './system.controller.js';
import type { ApiContext } from '../types.js';

// Mock os module
jest.mock('os');

// Mock fs/promises so utimes resolves immediately under fake timers
jest.mock('fs/promises', () => ({
  utimes: jest.fn<any>().mockResolvedValue(undefined),
  stat: jest.fn<any>().mockResolvedValue({ isDirectory: () => true }),
  readdir: jest.fn<any>().mockResolvedValue([]),
}));

// Mock SOP service
jest.mock('../../services/sop/sop.service.js', () => ({
  SOPService: {
    getInstance: jest.fn().mockReturnValue({
      getAvailableSOPs: jest.fn(),
    }),
  },
}));

// IMPORTANT: Combine all service mocks into a SINGLE jest.mock call.
// Multiple jest.mock calls for the same module override each other -- only the last one takes effect.
jest.mock('../../services/index.js', () => ({
  MonitoringService: {
    getInstance: jest.fn().mockReturnValue({
      getHealthStatus: jest.fn(),
      getOverallHealth: jest.fn(),
      getSystemMetrics: jest.fn(),
      getPerformanceMetrics: jest.fn(),
      getMetricsHistory: jest.fn(),
      getActiveAlerts: jest.fn(),
      getAlertConditions: jest.fn(),
      updateAlertCondition: jest.fn()
    })
  },
  ConfigService: {
    getInstance: jest.fn().mockReturnValue({
      getEnvironmentInfo: jest.fn(),
      getConfig: jest.fn(),
      validateConfig: jest.fn(),
      updateConfig: jest.fn(),
      createDefaultConfigFile: jest.fn()
    })
  },
  LoggerService: {
    getInstance: jest.fn().mockReturnValue({
      getRecentLogs: jest.fn(),
      createComponentLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      })
    })
  }
}));

const mockSaveState = jest.fn<() => Promise<number>>().mockResolvedValue(3);
const mockGetSessionBackendSync = jest.fn<() => object | null>().mockReturnValue({});
const mockGetSessionStatePersistence = jest.fn<any>().mockReturnValue({
  saveState: mockSaveState,
});

jest.mock('../../services/session/index.js', () => ({
  getSessionBackendSync: (...args: unknown[]) => mockGetSessionBackendSync(),
  getSessionStatePersistence: (...args: unknown[]) => mockGetSessionStatePersistence(),
}));

describe('System Handlers', () => {
  let mockApiContext: Partial<ApiContext>;
  let mockRequest: Partial<Request>;
  let mockResponse: any;
  let mockTmuxService: any;
  let mockMonitoringService: any;
  let mockConfigService: any;
  let mockLoggerService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    const { MonitoringService } = require('../../services/index.js');
    const { ConfigService } = require('../../services/index.js');
    const { LoggerService } = require('../../services/index.js');

    mockMonitoringService = MonitoringService.getInstance();
    mockConfigService = ConfigService.getInstance();
    mockLoggerService = LoggerService.getInstance();

    mockTmuxService = {
      checkClaudeInstallation: jest.fn<any>()
    };

    mockApiContext = {
      tmuxService: mockTmuxService
    } as any;

    mockRequest = {
      params: { conditionId: 'alert-1' },
      body: { config: 'value', enabled: true },
      query: { hours: '24', level: 'error', limit: '50', sessionName: 'test-session' }
    };

    mockResponse = {
      json: jest.fn<any>(),
      status: jest.fn<any>().mockReturnThis()
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getSystemHealth', () => {
    it('should return comprehensive system health information', async () => {
      const mockHealthStatus = new Map([
        ['database', { status: 'healthy', latency: 10 }],
        ['api', { status: 'healthy', uptime: 3600 }]
      ]);
      const mockSystemMetrics = { memory: 80, cpu: 45 };
      const mockPerformanceMetrics = { responseTime: 200, throughput: 100 };
      const mockEnvironmentInfo = { nodeVersion: '18.0.0', platform: 'linux' };

      mockMonitoringService.getHealthStatus.mockReturnValue(mockHealthStatus);
      mockMonitoringService.getOverallHealth.mockReturnValue('healthy');
      mockMonitoringService.getSystemMetrics.mockReturnValue(mockSystemMetrics);
      mockMonitoringService.getPerformanceMetrics.mockReturnValue(mockPerformanceMetrics);
      mockConfigService.getEnvironmentInfo.mockReturnValue(mockEnvironmentInfo);

      await systemHandlers.getSystemHealth.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockMonitoringService.getHealthStatus).toHaveBeenCalled();
      expect(mockMonitoringService.getOverallHealth).toHaveBeenCalled();
      expect(mockMonitoringService.getSystemMetrics).toHaveBeenCalled();
      expect(mockMonitoringService.getPerformanceMetrics).toHaveBeenCalled();
      expect(mockConfigService.getEnvironmentInfo).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          status: 'healthy',
          timestamp: expect.any(String),
          services: {
            database: { status: 'healthy', latency: 10 },
            api: { status: 'healthy', uptime: 3600 }
          },
          metrics: {
            system: mockSystemMetrics,
            performance: mockPerformanceMetrics
          },
          environment: mockEnvironmentInfo,
          auditorEnabled: expect.any(Boolean),
        }
      });
    });

    it('should include auditorEnabled=true when env var is set (#254)', async () => {
      const originalEnv = process.env['CREWLY_ENABLE_AUDITOR'];
      process.env['CREWLY_ENABLE_AUDITOR'] = 'true';

      const mockHealthStatus = new Map([['api', { status: 'healthy' }]]);
      mockMonitoringService.getHealthStatus.mockReturnValue(mockHealthStatus);
      mockMonitoringService.getOverallHealth.mockReturnValue('healthy');
      mockMonitoringService.getSystemMetrics.mockReturnValue({});
      mockMonitoringService.getPerformanceMetrics.mockReturnValue({});
      mockConfigService.getEnvironmentInfo.mockReturnValue({});

      await systemHandlers.getSystemHealth.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      const responseData = (mockResponse.json as jest.Mock).mock.calls[0][0] as { data: { auditorEnabled: boolean } };
      expect(responseData.data.auditorEnabled).toBe(true);

      if (originalEnv === undefined) {
        delete process.env['CREWLY_ENABLE_AUDITOR'];
      } else {
        process.env['CREWLY_ENABLE_AUDITOR'] = originalEnv;
      }
    });

    it('should include auditorEnabled=false when env var is not set (#254)', async () => {
      const originalEnv = process.env['CREWLY_ENABLE_AUDITOR'];
      delete process.env['CREWLY_ENABLE_AUDITOR'];

      const mockHealthStatus = new Map([['api', { status: 'healthy' }]]);
      mockMonitoringService.getHealthStatus.mockReturnValue(mockHealthStatus);
      mockMonitoringService.getOverallHealth.mockReturnValue('healthy');
      mockMonitoringService.getSystemMetrics.mockReturnValue({});
      mockMonitoringService.getPerformanceMetrics.mockReturnValue({});
      mockConfigService.getEnvironmentInfo.mockReturnValue({});

      await systemHandlers.getSystemHealth.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      const responseData = (mockResponse.json as jest.Mock).mock.calls[0][0] as { data: { auditorEnabled: boolean } };
      expect(responseData.data.auditorEnabled).toBe(false);

      if (originalEnv !== undefined) {
        process.env['CREWLY_ENABLE_AUDITOR'] = originalEnv;
      }
    });

    it('should handle monitoring service errors', async () => {
      mockMonitoringService.getHealthStatus.mockImplementation(() => {
        throw new Error('Monitoring service error');
      });

      await systemHandlers.getSystemHealth.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to get system health'
      });
    });
  });

  describe('getSystemMetrics', () => {
    it('should return metrics with default 1 hour period', async () => {
      const mockCurrentMetrics = { memory: 75, cpu: 50 };
      const mockPerformanceMetrics = { responseTime: 180, throughput: 120 };
      const mockHistory: any[] = [{ timestamp: '2024-01-01T00:00:00Z', memory: 70, cpu: 45 }];

      mockMonitoringService.getMetricsHistory.mockReturnValue(mockHistory);
      mockMonitoringService.getSystemMetrics.mockReturnValue(mockCurrentMetrics);
      mockMonitoringService.getPerformanceMetrics.mockReturnValue(mockPerformanceMetrics);

      mockRequest.query = {};

      await systemHandlers.getSystemMetrics.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockMonitoringService.getMetricsHistory).toHaveBeenCalledWith(1);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          current: {
            system: mockCurrentMetrics,
            performance: mockPerformanceMetrics
          },
          history: mockHistory,
          period: '1 hours'
        }
      });
    });

    it('should return metrics with custom hour period', async () => {
      const mockHistory: any[] = [];
      mockMonitoringService.getMetricsHistory.mockReturnValue(mockHistory);
      mockMonitoringService.getSystemMetrics.mockReturnValue({});
      mockMonitoringService.getPerformanceMetrics.mockReturnValue({});

      await systemHandlers.getSystemMetrics.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockMonitoringService.getMetricsHistory).toHaveBeenCalledWith(24);
      expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          period: '24 hours'
        })
      }));
    });

    it('should handle invalid hour values gracefully', async () => {
      mockRequest.query = { hours: 'invalid' };
      mockMonitoringService.getMetricsHistory.mockReturnValue([]);
      mockMonitoringService.getSystemMetrics.mockReturnValue({});
      mockMonitoringService.getPerformanceMetrics.mockReturnValue({});

      await systemHandlers.getSystemMetrics.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockMonitoringService.getMetricsHistory).toHaveBeenCalledWith(1);
    });
  });

  describe('getSystemConfiguration', () => {
    it('should return system configuration with validation', async () => {
      const mockConfig = { database: { host: 'localhost', port: 5432 } };
      const mockValidation = { isValid: true, errors: [] };
      const mockEnvironmentInfo = { nodeVersion: '18.0.0' };

      mockConfigService.getConfig.mockReturnValue(mockConfig);
      mockConfigService.validateConfig.mockReturnValue(mockValidation);
      mockConfigService.getEnvironmentInfo.mockReturnValue(mockEnvironmentInfo);

      await systemHandlers.getSystemConfiguration.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockConfigService.getConfig).toHaveBeenCalled();
      expect(mockConfigService.validateConfig).toHaveBeenCalled();
      expect(mockConfigService.getEnvironmentInfo).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          config: mockConfig,
          validation: mockValidation,
          environment: mockEnvironmentInfo
        }
      });
    });

    it('should handle configuration service errors', async () => {
      mockConfigService.getConfig.mockImplementation(() => {
        throw new Error('Config service error');
      });

      await systemHandlers.getSystemConfiguration.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to get system configuration'
      });
    });
  });

  describe('updateSystemConfiguration', () => {
    it('should update configuration and return validation results', async () => {
      const mockValidation = { isValid: true, warnings: ['Some warning'] };

      mockConfigService.updateConfig.mockResolvedValue(undefined);
      mockConfigService.validateConfig.mockReturnValue(mockValidation);

      await systemHandlers.updateSystemConfiguration.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockConfigService.updateConfig).toHaveBeenCalledWith(mockRequest.body);
      expect(mockConfigService.validateConfig).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          updated: true,
          validation: mockValidation,
          timestamp: expect.any(String)
        }
      });
    });

    it('should handle configuration update errors', async () => {
      mockConfigService.updateConfig.mockRejectedValue(new Error('Update failed'));

      await systemHandlers.updateSystemConfiguration.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to update system configuration'
      });
    });
  });

  describe('getSystemLogs', () => {
    it('should return logs with default parameters', async () => {
      const mockLogs = [
        { level: 'error', message: 'Test error', timestamp: '2024-01-01T00:00:00Z' },
        { level: 'info', message: 'Test info', timestamp: '2024-01-01T00:01:00Z' }
      ];

      mockLoggerService.getRecentLogs.mockResolvedValue(mockLogs);
      mockRequest.query = {};

      await systemHandlers.getSystemLogs.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockLoggerService.getRecentLogs).toHaveBeenCalledWith(undefined, 100);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          logs: mockLogs,
          count: 2,
          level: 'all',
          limit: 100
        }
      });
    });

    it('should return logs with custom level and limit', async () => {
      const mockLogs = [{ level: 'error', message: 'Error log' }];
      mockLoggerService.getRecentLogs.mockResolvedValue(mockLogs);

      await systemHandlers.getSystemLogs.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockLoggerService.getRecentLogs).toHaveBeenCalledWith('error', 50);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          logs: mockLogs,
          count: 1,
          level: 'error',
          limit: '50'
        }
      });
    });

    it('should handle logger service errors', async () => {
      mockLoggerService.getRecentLogs.mockRejectedValue(new Error('Logger error'));

      await systemHandlers.getSystemLogs.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to get system logs'
      });
    });
  });

  describe('getAlerts', () => {
    it('should return active alerts and conditions', async () => {
      const mockActiveAlerts = [
        { id: 'alert-1', severity: 'high', message: 'High CPU usage' },
        { id: 'alert-2', severity: 'medium', message: 'Low disk space' }
      ];
      const mockAlertConditions = [
        { id: 'condition-1', threshold: 90, enabled: true }
      ];

      mockMonitoringService.getActiveAlerts.mockReturnValue(mockActiveAlerts);
      mockMonitoringService.getAlertConditions.mockReturnValue(mockAlertConditions);

      await systemHandlers.getAlerts.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockMonitoringService.getActiveAlerts).toHaveBeenCalled();
      expect(mockMonitoringService.getAlertConditions).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          active: mockActiveAlerts,
          conditions: mockAlertConditions,
          count: 2
        }
      });
    });

    it('should handle monitoring service errors when getting alerts', async () => {
      mockMonitoringService.getActiveAlerts.mockImplementation(() => {
        throw new Error('Alert service error');
      });

      await systemHandlers.getAlerts.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to get alerts'
      });
    });
  });

  describe('updateAlertCondition', () => {
    it('should update alert condition successfully', async () => {
      mockMonitoringService.updateAlertCondition.mockReturnValue(true);

      await systemHandlers.updateAlertCondition.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockMonitoringService.updateAlertCondition).toHaveBeenCalledWith('alert-1', mockRequest.body);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          conditionId: 'alert-1',
          updated: true,
          timestamp: expect.any(String)
        }
      });
    });

    it('should return 404 when alert condition not found', async () => {
      mockMonitoringService.updateAlertCondition.mockReturnValue(false);

      await systemHandlers.updateAlertCondition.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Alert condition not found'
      });
    });

    it('should handle update alert condition errors', async () => {
      mockMonitoringService.updateAlertCondition.mockImplementation(() => {
        throw new Error('Update error');
      });

      await systemHandlers.updateAlertCondition.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to update alert condition'
      });
    });
  });

  describe('createDefaultConfig', () => {
    it('should create default configuration file successfully', async () => {
      mockConfigService.createDefaultConfigFile.mockResolvedValue(undefined);

      await systemHandlers.createDefaultConfig.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockConfigService.createDefaultConfigFile).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          message: 'Default configuration file created',
          timestamp: expect.any(String)
        }
      });
    });

    it('should handle config creation errors', async () => {
      mockConfigService.createDefaultConfigFile.mockRejectedValue(new Error('Creation failed'));

      await systemHandlers.createDefaultConfig.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to create default configuration'
      });
    });
  });

  describe('healthCheck', () => {
    it('should return healthy status with 200 code', async () => {
      mockMonitoringService.getOverallHealth.mockReturnValue('healthy');

      const originalUptime = process.uptime;
      process.uptime = jest.fn<any>().mockReturnValue(3600.5) as any;

      await systemHandlers.healthCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockMonitoringService.getOverallHealth).toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          status: 'healthy',
          uptime: 3601,
          timestamp: expect.any(String),
          version: expect.any(String)
        }
      });

      process.uptime = originalUptime;
    });

    it('should return unhealthy status with 503 code', async () => {
      mockMonitoringService.getOverallHealth.mockReturnValue('unhealthy');

      const originalUptime = process.uptime;
      process.uptime = jest.fn<any>().mockReturnValue(1800) as any;

      await systemHandlers.healthCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(503);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        data: {
          status: 'unhealthy',
          uptime: 1800,
          timestamp: expect.any(String),
          version: expect.any(String)
        }
      });

      process.uptime = originalUptime;
    });

    it('should handle health check errors with 503 status', async () => {
      mockMonitoringService.getOverallHealth.mockImplementation(() => {
        throw new Error('Health check error');
      });

      await systemHandlers.healthCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(503);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Health check failed'
      });
    });
  });

  describe('getClaudeStatus', () => {
    it('should return Claude installation status', async () => {
      const mockClaudeStatus = {
        installed: true,
        version: '1.0.0',
        path: '/usr/local/bin/claude'
      };

      mockTmuxService.checkClaudeInstallation.mockResolvedValue(mockClaudeStatus);

      await systemHandlers.getClaudeStatus.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockTmuxService.checkClaudeInstallation).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: mockClaudeStatus
      });
    });

    it('should handle Claude status check errors with custom message', async () => {
      const error = new Error('Claude not found');
      mockTmuxService.checkClaudeInstallation.mockRejectedValue(error);

      await systemHandlers.getClaudeStatus.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Claude not found'
      });
    });

    it('should handle Claude status check errors without message', async () => {
      mockTmuxService.checkClaudeInstallation.mockRejectedValue(new Error());

      await systemHandlers.getClaudeStatus.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to check Claude status'
      });
    });
  });

  describe('Context preservation', () => {
    it('should preserve context when handling system operations', async () => {
      const contextAwareController = {
        tmuxService: {
          checkClaudeInstallation: jest.fn<any>().mockResolvedValue({ installed: true })
        }
      } as any;

      await systemHandlers.getClaudeStatus.call(
        contextAwareController,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(contextAwareController.tmuxService.checkClaudeInstallation).toHaveBeenCalled();
    });
  });

  describe('All handlers availability', () => {
    it('should have all expected handler functions', () => {
      expect(typeof systemHandlers.getSystemHealth).toBe('function');
      expect(typeof systemHandlers.getSystemMetrics).toBe('function');
      expect(typeof systemHandlers.getSystemConfiguration).toBe('function');
      expect(typeof systemHandlers.updateSystemConfiguration).toBe('function');
      expect(typeof systemHandlers.getSystemLogs).toBe('function');
      expect(typeof systemHandlers.getAlerts).toBe('function');
      expect(typeof systemHandlers.updateAlertCondition).toBe('function');
      expect(typeof systemHandlers.createDefaultConfig).toBe('function');
      expect(typeof systemHandlers.healthCheck).toBe('function');
      expect(typeof systemHandlers.getClaudeStatus).toBe('function');
      expect(typeof systemHandlers.getLocalIpAddress).toBe('function');
      expect(typeof systemHandlers.restartServer).toBe('function');
    });

    it('should handle async operations properly', async () => {
      mockMonitoringService.getOverallHealth.mockReturnValue('healthy');
      const originalUptime = process.uptime;
      process.uptime = jest.fn<any>().mockReturnValue(3600) as any;

      const result = await systemHandlers.healthCheck.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(result).toBeUndefined();
      expect(mockResponse.json).toHaveBeenCalled();

      process.uptime = originalUptime;
    });
  });

  describe('restartServer', () => {
    let originalExit: typeof process.exit;

    beforeEach(() => {
      originalExit = process.exit;
      process.exit = jest.fn() as any;
      jest.useFakeTimers();
      mockSaveState.mockResolvedValue(3);
      mockGetSessionBackendSync.mockReturnValue({});
    });

    afterEach(() => {
      process.exit = originalExit;
      jest.useRealTimers();
    });

    it('should save session state and respond with success', async () => {
      await systemHandlers.restartServer.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockGetSessionBackendSync).toHaveBeenCalled();
      expect(mockSaveState).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          message: 'Server is restarting...',
          savedSessions: 3,
          timestamp: expect.any(String),
        },
      });
    });

    it('should call process.exit after delay', async () => {
      await systemHandlers.restartServer.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(process.exit).not.toHaveBeenCalled();
      // Advance past outer setTimeout (1000ms), flush microtasks for async fs.utimes,
      // then advance past inner setTimeout (2000ms)
      await jest.advanceTimersByTimeAsync(4000);
      expect(process.exit).toHaveBeenCalledWith(120);
    });

    it('should handle missing session backend gracefully', async () => {
      mockGetSessionBackendSync.mockReturnValue(null);

      await systemHandlers.restartServer.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          savedSessions: 0,
        }),
      });
    });

    it('should handle save state errors gracefully', async () => {
      mockSaveState.mockRejectedValue(new Error('Save failed'));

      await systemHandlers.restartServer.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          message: 'Server is restarting...',
          savedSessions: 0,
        }),
      });
    });
  });

  describe('getLocalIpAddress', () => {
    const mockedOs = os as jest.Mocked<typeof os>;
    let originalWebPort: string | undefined;

    beforeEach(() => {
      originalWebPort = process.env.WEB_PORT;
      delete process.env.WEB_PORT;
    });

    afterEach(() => {
      if (originalWebPort) {
        process.env.WEB_PORT = originalWebPort;
      } else {
        delete process.env.WEB_PORT;
      }
    });

    it('should return local IP address successfully', async () => {
      mockedOs.networkInterfaces.mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '192.168.1.100/24',
          },
        ],
      });

      await systemHandlers.getLocalIpAddress.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          ip: '192.168.1.100',
          port: 8787,
          url: 'http://192.168.1.100:8787',
          timestamp: expect.any(String),
        }),
      });
    });

    it('should skip internal (loopback) addresses', async () => {
      mockedOs.networkInterfaces.mockReturnValue({
        lo0: [
          {
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: true,
            cidr: '127.0.0.1/8',
          },
        ],
        en0: [
          {
            address: '10.0.0.50',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '10.0.0.50/24',
          },
        ],
      });

      await systemHandlers.getLocalIpAddress.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          ip: '10.0.0.50',
        }),
      });
    });

    it('should skip IPv6 addresses', async () => {
      mockedOs.networkInterfaces.mockReturnValue({
        en0: [
          {
            address: 'fe80::1',
            netmask: 'ffff:ffff:ffff:ffff::',
            family: 'IPv6',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: 'fe80::1/64',
            scopeid: 1,
          },
          {
            address: '172.16.0.1',
            netmask: '255.255.0.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '172.16.0.1/16',
          },
        ],
      });

      await systemHandlers.getLocalIpAddress.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          ip: '172.16.0.1',
        }),
      });
    });

    it('should fallback to localhost when no external IP found', async () => {
      mockedOs.networkInterfaces.mockReturnValue({
        lo0: [
          {
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: true,
            cidr: '127.0.0.1/8',
          },
        ],
      });

      await systemHandlers.getLocalIpAddress.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          ip: 'localhost',
          url: expect.stringContaining('http://localhost:'),
        }),
      });
    });

    it('should fallback to localhost when no network interfaces', async () => {
      mockedOs.networkInterfaces.mockReturnValue({});

      await systemHandlers.getLocalIpAddress.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          ip: 'localhost',
        }),
      });
    });

    it('should use WEB_PORT from environment', async () => {
      process.env.WEB_PORT = '3000';
      mockedOs.networkInterfaces.mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '192.168.1.100/24',
          },
        ],
      });

      await systemHandlers.getLocalIpAddress.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          port: 3000,
          url: 'http://192.168.1.100:3000',
        }),
      });
    });

    it('should return timestamp in ISO format', async () => {
      mockedOs.networkInterfaces.mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '192.168.1.100/24',
          },
        ],
      });

      await systemHandlers.getLocalIpAddress.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      const call = (mockResponse.json as jest.Mock).mock.calls[0][0] as { data: { timestamp: string } };
      expect(call.data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should handle error and return 500', async () => {
      mockedOs.networkInterfaces.mockImplementation(() => {
        throw new Error('Network error');
      });

      await systemHandlers.getLocalIpAddress.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to get local IP address',
      });
    });

    it('should handle interfaces with undefined addresses array', async () => {
      mockedOs.networkInterfaces.mockReturnValue({
        eth0: undefined,
        en0: [
          {
            address: '192.168.0.1',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '192.168.0.1/24',
          },
        ],
      } as NodeJS.Dict<os.NetworkInterfaceInfo[]>);

      await systemHandlers.getLocalIpAddress.call(
        mockApiContext as ApiContext,
        mockRequest as Request,
        mockResponse as Response
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          ip: '192.168.0.1',
        }),
      });
    });
  });
});
