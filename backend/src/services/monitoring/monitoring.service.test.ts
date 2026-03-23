import { MonitoringService, SystemMetrics, PerformanceMetrics, HealthCheckResult, AlertCondition } from './monitoring.service';
import { ConfigService } from '../core/config.service.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import * as os from 'os';
import * as process from 'process';

// Mock dependencies
jest.mock('../core/config.service.js');
jest.mock('../core/logger.service.js');
jest.mock('os');
jest.mock('fs/promises', () => ({
  statfs: jest.fn().mockRejectedValue(new Error('mocked'))
}));
jest.mock('process', () => ({
  cpuUsage: jest.fn(),
  memoryUsage: jest.fn(),
  uptime: jest.fn(),
  pid: 12345,
  cwd: jest.fn(),
  version: 'v18.0.0',
  platform: 'linux'
}));

describe('MonitoringService', () => {
  let service: MonitoringService;
  let mockConfig: jest.Mocked<ConfigService>;
  let mockLogger: any;
  let mockLoggerService: any;

  const mockMonitoringConfig = {
    metricsEnabled: true,
    healthCheckInterval: 60000,
    performanceTrackingEnabled: true,
    memoryThreshold: 80,
    cpuThreshold: 70
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Reset singleton instance
    (MonitoringService as any).instance = undefined;

    // Setup mocks
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    mockLoggerService = {
      createComponentLogger: jest.fn().mockReturnValue(mockLogger),
      logSystemMetric: jest.fn()
    };

    mockConfig = {
      get: jest.fn().mockReturnValue(mockMonitoringConfig)
    } as any;

    (ConfigService.getInstance as jest.Mock).mockReturnValue(mockConfig);
    (LoggerService.getInstance as jest.Mock).mockReturnValue(mockLoggerService);

    // Mock OS functions
    (os.totalmem as jest.Mock).mockReturnValue(8000000000); // 8GB
    (os.freemem as jest.Mock).mockReturnValue(2000000000); // 2GB
    (os.loadavg as jest.Mock).mockReturnValue([1.2, 1.5, 1.8]);
    (os.cpus as jest.Mock).mockReturnValue(new Array(4)); // 4 cores

    // Mock process functions
    (process.cpuUsage as jest.Mock).mockReturnValue({ user: 100000, system: 50000 });
    (process.memoryUsage as unknown as jest.Mock).mockReturnValue({
      rss: 150000000,
      heapUsed: 100000000,
      heapTotal: 120000000,
      external: 10000000,
      arrayBuffers: 5000000
    });
    (process.uptime as jest.Mock).mockReturnValue(3600); // 1 hour

    service = MonitoringService.getInstance();
  });

  afterEach(() => {
    jest.useRealTimers();
    service.shutdown();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = MonitoringService.getInstance();
      const instance2 = MonitoringService.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should initialize with required dependencies', () => {
      expect(ConfigService.getInstance).toHaveBeenCalled();
      expect(LoggerService.getInstance).toHaveBeenCalled();
      expect(mockLoggerService.createComponentLogger).toHaveBeenCalledWith('Monitoring');
    });

    it('should start monitoring if metrics enabled', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('Metrics collection started');
      expect(mockLogger.info).toHaveBeenCalledWith('Health checks started');
    });
  });

  describe('collectMetrics', () => {
    it('should collect and store system metrics', async () => {
      await (service as any).collectMetrics();

      const metrics = service.getSystemMetrics();
      expect(metrics).toBeTruthy();
      expect(metrics?.cpu.cores).toBe(4);
      expect(metrics?.memory.total).toBe(8000000000);
      expect(metrics?.memory.free).toBe(2000000000);
      expect(metrics?.memory.used).toBe(6000000000);
      expect(metrics?.memory.percentage).toBe(75);
    });

    it('should limit metrics history to 1000 entries', async () => {
      // Fill up metrics history beyond limit
      for (let i = 0; i < 1100; i++) {
        (service as any).metricsHistory.push({ timestamp: new Date().toISOString() });
        (service as any).performanceHistory.push({ timestamp: new Date().toISOString() });
      }

      await (service as any).collectMetrics();

      expect((service as any).metricsHistory.length).toBeLessThanOrEqual(1000);
      expect((service as any).performanceHistory.length).toBeLessThanOrEqual(1000);
    });

    it('should log system metrics', async () => {
      await (service as any).collectMetrics();

      expect(mockLoggerService.logSystemMetric).toHaveBeenCalledWith('cpu_usage', expect.any(Number), '%');
      expect(mockLoggerService.logSystemMetric).toHaveBeenCalledWith('memory_usage', 75, '%');
      // Disk usage is 0 when statfs fails (mocked to reject)
      expect(mockLoggerService.logSystemMetric).toHaveBeenCalledWith('disk_usage', 0, '%');
    });

    it('should handle collection errors gracefully', async () => {
      (os.totalmem as jest.Mock).mockImplementation(() => {
        throw new Error('OS error');
      });

      await (service as any).collectMetrics();

      expect(mockLogger.error).toHaveBeenCalledWith('Failed to collect metrics', {
        error: 'OS error'
      });
    });
  });

  describe('collectSystemMetrics', () => {
    it('should return complete system metrics', async () => {
      const metrics = await (service as any).collectSystemMetrics();

      expect(metrics).toMatchObject({
        timestamp: expect.any(String),
        cpu: {
          usage: expect.any(Number),
          loadAverage: [1.2, 1.5, 1.8],
          cores: 4
        },
        memory: {
          used: 6000000000,
          total: 8000000000,
          free: 2000000000,
          percentage: 75,
          heap: expect.any(Object)
        },
        process: {
          pid: 12345,
          uptime: 3600,
          memoryUsage: expect.any(Object),
          cpuUsage: expect.any(Object)
        }
      });
    });
  });

  describe('calculateCpuUsage', () => {
    it('should calculate CPU usage percentage correctly', () => {
      const cpuUsage = { user: 500000, system: 300000 }; // 800,000 microseconds = 80%

      const result = (service as any).calculateCpuUsage(cpuUsage);

      expect(result).toBe(80);
    });

    it('should handle zero CPU usage', () => {
      const cpuUsage = { user: 0, system: 0 };

      const result = (service as any).calculateCpuUsage(cpuUsage);

      expect(result).toBe(0);
    });
  });

  describe('collectPerformanceMetrics', () => {
    beforeEach(() => {
      service.recordRequest(true, 100);
      service.recordRequest(false, 200);
      service.recordRequest(true, 150);
    });

    it('should return performance metrics with request statistics', () => {
      const metrics = (service as any).collectPerformanceMetrics();

      expect(metrics).toMatchObject({
        timestamp: expect.any(String),
        requests: {
          total: 3,
          successful: 2,
          failed: 1,
          averageResponseTime: 150 // (100 + 200 + 150) / 3
        }
      });
    });

    it('should reset counters after one hour', () => {
      const metrics1 = (service as any).collectPerformanceMetrics();
      expect(metrics1.requests.total).toBe(3);

      // Simulate time passing (1 hour + 1 second)
      jest.advanceTimersByTime(3601000);

      // The implementation reads counters first, then resets if >1 hour elapsed.
      // So the first call after the time passes still returns the old values,
      // but resets the counters. The second call should return 0.
      (service as any).collectPerformanceMetrics(); // triggers the reset
      const metrics2 = (service as any).collectPerformanceMetrics();
      expect(metrics2.requests.total).toBe(0);
    });
  });

  describe('recordRequest', () => {
    it('should record successful request', () => {
      service.recordRequest(true, 100);

      // getPerformanceMetrics() returns from performanceHistory which is populated by collectMetrics().
      // Use collectPerformanceMetrics() directly to verify counters.
      const metrics = (service as any).collectPerformanceMetrics();
      expect(metrics.requests.successful).toBe(1);
      expect(metrics.requests.failed).toBe(0);
      expect(metrics.requests.total).toBe(1);
    });

    it('should record failed request', () => {
      service.recordRequest(false, 150);

      const metrics = (service as any).collectPerformanceMetrics();
      expect(metrics.requests.successful).toBe(0);
      expect(metrics.requests.failed).toBe(1);
      expect(metrics.requests.total).toBe(1);
    });
  });

  describe('alert system', () => {
    it('should initialize default alert conditions', () => {
      const conditions = service.getAlertConditions();

      expect(conditions).toHaveLength(4);
      expect(conditions.find(c => c.id === 'high-memory-usage')).toBeTruthy();
      expect(conditions.find(c => c.id === 'critical-memory-usage')).toBeTruthy();
      expect(conditions.find(c => c.id === 'high-cpu-usage')).toBeTruthy();
      expect(conditions.find(c => c.id === 'disk-space-low')).toBeTruthy();
    });

    it('should check alert conditions and trigger alerts', () => {
      const mockMetrics: SystemMetrics = {
        timestamp: new Date().toISOString(),
        cpu: { usage: 85, loadAverage: [2, 2, 2], cores: 4 }, // Above threshold (70)
        memory: { used: 7200000000, total: 8000000000, free: 800000000, percentage: 90, heap: {} as any }, // Above threshold (80)
        disk: { usage: 0, free: 0, total: 0 },
        network: { connections: 0, bytesReceived: 0, bytesSent: 0 },
        process: { pid: 12345, uptime: 3600, memoryUsage: {} as any, cpuUsage: {} as any }
      };

      (service as any).checkAlertConditions(mockMetrics);

      // Fast forward to trigger duration-based alerts
      jest.advanceTimersByTime(70000); // More than 60 seconds for memory alert

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('High Memory Usage'),
        expect.objectContaining({ alertId: 'high-memory-usage', value: 90 })
      );
    });

    it('should clear alerts when conditions are no longer met', () => {
      const highMetrics: SystemMetrics = {
        timestamp: new Date().toISOString(),
        cpu: { usage: 85, loadAverage: [2, 2, 2], cores: 4 },
        memory: { used: 7200000000, total: 8000000000, free: 800000000, percentage: 90, heap: {} as any },
        disk: { usage: 0, free: 0, total: 0 },
        network: { connections: 0, bytesReceived: 0, bytesSent: 0 },
        process: { pid: 12345, uptime: 3600, memoryUsage: {} as any, cpuUsage: {} as any }
      };

      const normalMetrics: SystemMetrics = {
        ...highMetrics,
        memory: { ...highMetrics.memory, percentage: 60 } // Below threshold
      };

      (service as any).checkAlertConditions(highMetrics);
      (service as any).checkAlertConditions(normalMetrics); // Should clear alert

      expect(mockLogger.info).toHaveBeenCalledWith('Alert condition cleared', {
        condition: 'High Memory Usage',
        metric: 'memory.percentage',
        value: 60
      });
    });

    it('should get metric value from nested path', () => {
      const metrics: SystemMetrics = {
        memory: { percentage: 85 }
      } as any;

      const result = (service as any).getMetricValue(metrics, 'memory.percentage');
      expect(result).toBe(85);
    });

    it('should return undefined for invalid metric path', () => {
      const metrics: SystemMetrics = {} as any;

      const result = (service as any).getMetricValue(metrics, 'invalid.path');
      expect(result).toBeUndefined();
    });

    it('should evaluate conditions correctly', () => {
      expect((service as any).evaluateCondition(85, 'greater_than', 80)).toBe(true);
      expect((service as any).evaluateCondition(75, 'greater_than', 80)).toBe(false);
      expect((service as any).evaluateCondition(80, 'equals', 80)).toBe(true);
      expect((service as any).evaluateCondition(85, 'less_than', 80)).toBe(false);
      expect((service as any).evaluateCondition(75, 'less_than', 80)).toBe(true);
    });
  });

  describe('updateAlertCondition', () => {
    it('should update existing alert condition', () => {
      const success = service.updateAlertCondition('high-memory-usage', { threshold: 90 });

      expect(success).toBe(true);
      const condition = service.getAlertConditions().find(c => c.id === 'high-memory-usage');
      expect(condition?.threshold).toBe(90);
    });

    it('should return false for nonexistent condition', () => {
      const success = service.updateAlertCondition('nonexistent', { threshold: 90 });

      expect(success).toBe(false);
    });
  });

  describe('health checks', () => {
    it('should run all health checks', async () => {
      await (service as any).runHealthChecks();

      const healthStatus = service.getHealthStatus();
      expect(healthStatus.has('memory')).toBe(true);
      expect(healthStatus.has('cpu')).toBe(true);
      expect(healthStatus.has('disk')).toBe(true);
      expect(healthStatus.has('process')).toBe(true);
    });

    it('should check memory health', async () => {
      const result = await (service as any).checkMemoryHealth();

      expect(result).toMatchObject({
        service: 'memory',
        status: expect.stringMatching(/healthy|degraded|unhealthy/),
        responseTime: expect.any(Number),
        details: expect.objectContaining({
          heapUsed: expect.any(Number),
          usedPercent: expect.any(Number)
        })
      });
    });

    it('should compare heapUsedMB against memoryThreshold in MB (#258)', async () => {
      // heapUsed = 100MB (mock), memoryThreshold = 80MB (mock config)
      // Before fix: compared percentage (1.25%) against 80 → always healthy
      // After fix: compares heapUsedMB (95.4MB) against 80MB → degraded
      const result = await (service as any).checkMemoryHealth();
      expect(result.details.heapUsedMB).toBeCloseTo(95.37, 0);
      expect(result.status).toBe('degraded');
    });

    it('should report memory healthy when heapUsed is below threshold (#258)', async () => {
      // Set heap to 50MB (below 80MB threshold)
      (process.memoryUsage as unknown as jest.Mock).mockReturnValue({
        rss: 60000000,
        heapUsed: 50000000,
        heapTotal: 120000000,
        external: 10000000,
        arrayBuffers: 5000000,
      });
      const result = await (service as any).checkMemoryHealth();
      expect(result.details.heapUsedMB).toBeCloseTo(47.68, 0);
      expect(result.status).toBe('healthy');
    });

    it('should check CPU health', async () => {
      const result = await (service as any).checkCpuHealth();

      expect(result).toMatchObject({
        service: 'cpu',
        status: expect.stringMatching(/healthy|degraded|unhealthy/),
        responseTime: expect.any(Number),
        details: expect.objectContaining({
          loadAverage: expect.any(Array),
          cores: expect.any(Number),
          averageLoadPercent: expect.any(Number)
        })
      });
    });

    it('should determine overall health status', () => {
      // Move startTime back so grace period doesn't apply
      (service as any).startTime = Date.now() - 120000;

      // Clear any health checks populated by the constructor's initial runHealthChecks()
      (service as any).healthChecks.clear();

      (service as any).healthChecks.set('service1', { status: 'healthy' });
      (service as any).healthChecks.set('service2', { status: 'healthy' });
      expect(service.getOverallHealth()).toBe('healthy');

      (service as any).healthChecks.set('service3', { status: 'degraded' });
      expect(service.getOverallHealth()).toBe('degraded');

      (service as any).healthChecks.set('service4', { status: 'unhealthy' });
      expect(service.getOverallHealth()).toBe('unhealthy');
    });

    it('should return healthy during startup grace period even with unhealthy checks (#250)', () => {
      // Set startTime to now (within grace period)
      (service as any).startTime = Date.now();
      (service as any).healthChecks.set('cpu', { status: 'unhealthy' });
      expect(service.getOverallHealth()).toBe('healthy');
    });

    it('should return healthy when no health checks have run yet (#250)', () => {
      // Move past grace period but clear all health checks
      (service as any).startTime = Date.now() - 120000;
      (service as any).healthChecks.clear();
      expect(service.getOverallHealth()).toBe('healthy');
    });
  });

  describe('public API methods', () => {
    it('should get metrics history filtered by time', () => {
      const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
      const recentTimestamp = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 minutes ago

      (service as any).metricsHistory.push({ timestamp: oldTimestamp });
      (service as any).metricsHistory.push({ timestamp: recentTimestamp });

      const recent = service.getMetricsHistory(1); // Last 1 hour

      expect(recent).toHaveLength(1);
      expect(recent[0].timestamp).toBe(recentTimestamp);
    });

    it('should get active alerts', () => {
      const condition: AlertCondition = {
        id: 'test-alert',
        name: 'Test Alert',
        metric: 'test.metric',
        operator: 'greater_than',
        threshold: 100,
        duration: 60,
        severity: 'warning',
        enabled: true
      };

      (service as any).alertConditions.push(condition);
      (service as any).activeAlerts.set('test-alert_test.metric', new Date());

      const alerts = service.getActiveAlerts();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].condition.id).toBe('test-alert');
    });
  });

  describe('shutdown', () => {
    it('should stop all monitoring intervals', () => {
      service.shutdown();

      expect(mockLogger.info).toHaveBeenCalledWith('Monitoring service stopped');
    });
  });

  describe('monitoring configuration', () => {
    it('should not start metrics collection if disabled', () => {
      // Reset singleton and create new instance with disabled metrics
      (MonitoringService as any).instance = undefined;
      // Clear the logger mock to reset call history from beforeEach initialization
      mockLogger.info.mockClear();
      mockConfig.get.mockReturnValue({ ...mockMonitoringConfig, metricsEnabled: false });

      const disabledService = MonitoringService.getInstance();

      expect(mockLogger.info).not.toHaveBeenCalledWith('Metrics collection started');
    });

    it('should not start health checks if interval is 0', () => {
      (MonitoringService as any).instance = undefined;
      // Clear the logger mock to reset call history from beforeEach initialization
      mockLogger.info.mockClear();
      mockConfig.get.mockReturnValue({ ...mockMonitoringConfig, healthCheckInterval: 0 });

      const disabledService = MonitoringService.getInstance();

      expect(mockLogger.info).not.toHaveBeenCalledWith('Health checks started');
    });
  });
});
