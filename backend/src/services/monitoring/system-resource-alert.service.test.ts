import { SystemResourceAlertService } from './system-resource-alert.service.js';
import { MonitoringService, SystemMetrics } from './monitoring.service.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SYSTEM_RESOURCE_ALERT_CONSTANTS } from '../../constants.js';

// Mock dependencies
jest.mock('../core/logger.service.js');
jest.mock('./monitoring.service.js');
jest.mock('../../websocket/terminal.gateway.js');
// Phase 6c migration — alert path now writes via chat-v2 directly
jest.mock('../chat-v2/chat-v2.singleton.js', () => ({
  getChatV2Service: jest.fn(() => ({
    ensureChannelForLegacyConversation: jest.fn(() => ({ id: 'test-channel' })),
    recordTurn: jest.fn(() => ({ message: { id: 'm1' }, deduped: false })),
  })),
}));

// Import mocked modules for setup
import { getTerminalGateway } from '../../websocket/terminal.gateway.js';
import { getChatService } from '../chat/chat.service.js';

const mockGetTerminalGateway = getTerminalGateway as jest.Mock;
const mockGetChatService = getChatService as jest.Mock;

/**
 * Build a SystemMetrics stub with customizable overrides.
 */
function buildMetrics(overrides: Partial<{
	diskUsage: number;
	diskFree: number;
	diskTotal: number;
	memoryPercentage: number;
	cpuLoadAvg: number;
	cpuCores: number;
}> = {}): SystemMetrics {
	const {
		diskUsage = 50,
		diskFree = 50_000_000_000,
		diskTotal = 100_000_000_000,
		memoryPercentage = 50,
		cpuLoadAvg = 1,
		cpuCores = 4,
	} = overrides;

	return {
		timestamp: new Date().toISOString(),
		cpu: { usage: 10, loadAverage: [cpuLoadAvg, cpuLoadAvg, cpuLoadAvg], cores: cpuCores },
		memory: {
			used: 4_000_000_000,
			total: 8_000_000_000,
			free: 4_000_000_000,
			percentage: memoryPercentage,
			heap: {} as NodeJS.MemoryUsage,
		},
		disk: { usage: diskUsage, free: diskFree, total: diskTotal },
		network: { connections: 0, bytesReceived: 0, bytesSent: 0 },
		process: {
			pid: 12345,
			uptime: 3600,
			memoryUsage: {} as NodeJS.MemoryUsage,
			cpuUsage: {} as NodeJS.CpuUsage,
		},
	};
}

describe('SystemResourceAlertService', () => {
	let service: SystemResourceAlertService;
	let mockLogger: jest.Mocked<ComponentLogger>;
	let mockMonitoringInstance: { getSystemMetrics: jest.Mock };
	let mockTerminalGateway: {
		getActiveConversationId: jest.Mock;
		broadcastSystemResourceAlert: jest.Mock;
	};
	let mockChatService: { addSystemMessage: jest.Mock };

	beforeEach(() => {
		jest.clearAllMocks();
		jest.useFakeTimers();

		mockLogger = {
			info: jest.fn(),
			warn: jest.fn(),
			error: jest.fn(),
			debug: jest.fn(),
		} as unknown as jest.Mocked<ComponentLogger>;

		const mockLoggerService = {
			createComponentLogger: jest.fn().mockReturnValue(mockLogger),
		} as unknown as jest.Mocked<LoggerService>;
		(LoggerService.getInstance as jest.Mock).mockReturnValue(mockLoggerService);

		mockMonitoringInstance = {
			getSystemMetrics: jest.fn().mockReturnValue(null),
		};
		(MonitoringService.getInstance as jest.Mock).mockReturnValue(mockMonitoringInstance);

		mockTerminalGateway = {
			getActiveConversationId: jest.fn().mockReturnValue(null),
			broadcastSystemResourceAlert: jest.fn(),
		};
		mockGetTerminalGateway.mockReturnValue(mockTerminalGateway);

		mockChatService = {
			addSystemMessage: jest.fn().mockResolvedValue(undefined),
		};
		mockGetChatService.mockReturnValue(mockChatService);

		service = new SystemResourceAlertService();
	});

	afterEach(() => {
		service.stopMonitoring();
		jest.useRealTimers();
	});

	describe('startMonitoring / stopMonitoring', () => {
		it('should start periodic polling', () => {
			service.startMonitoring();

			expect(mockLogger.info).toHaveBeenCalledWith(
				'System resource alert monitoring started',
				expect.objectContaining({
					pollIntervalMs: SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL,
				})
			);
		});

		it('should warn if already running', () => {
			service.startMonitoring();
			service.startMonitoring();

			expect(mockLogger.warn).toHaveBeenCalledWith('Resource alert monitoring already running');
		});

		it('should stop polling on stopMonitoring', () => {
			service.startMonitoring();
			service.stopMonitoring();

			expect(mockLogger.info).toHaveBeenCalledWith('System resource alert monitoring stopped');
		});

		it('should be a no-op if not running', () => {
			service.stopMonitoring();

			expect(mockLogger.info).not.toHaveBeenCalledWith('System resource alert monitoring stopped');
		});
	});

	describe('checkResources (via timer)', () => {
		it('should skip if no metrics available', async () => {
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(null);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve(); // flush microtasks

			expect(mockTerminalGateway.broadcastSystemResourceAlert).not.toHaveBeenCalled();
		});

		it('should skip disk check if disk total is 0', async () => {
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ diskTotal: 0, diskUsage: 0, diskFree: 0 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).not.toHaveBeenCalled();
		});
	});

	describe('disk alerts', () => {
		it('should send warning when disk usage exceeds warning threshold', async () => {
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ diskUsage: 88 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledWith(
				expect.objectContaining({
					alertKey: 'disk_warning',
					severity: 'warning',
				})
			);
		});

		it('should send critical when disk usage exceeds critical threshold', async () => {
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ diskUsage: 97 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledWith(
				expect.objectContaining({
					alertKey: 'disk_critical',
					severity: 'critical',
				})
			);
			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining('[System Alert]'),
				expect.objectContaining({ alertKey: 'disk_critical' })
			);
		});
	});

	describe('memory alerts', () => {
		it('should send warning when memory exceeds warning threshold', async () => {
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ memoryPercentage: 88 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledWith(
				expect.objectContaining({
					alertKey: 'memory_warning',
					severity: 'warning',
				})
			);
		});

		it('should send critical when memory exceeds critical threshold', async () => {
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ memoryPercentage: 96 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledWith(
				expect.objectContaining({
					alertKey: 'memory_critical',
					severity: 'critical',
				})
			);
		});
	});

	describe('CPU alerts', () => {
		it('should send warning when CPU load exceeds warning threshold', async () => {
			// 4 cores, load avg = 3.4 → 85% of capacity → exceeds 80% warning
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ cpuLoadAvg: 3.4, cpuCores: 4 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledWith(
				expect.objectContaining({
					alertKey: 'cpu_warning',
					severity: 'warning',
				})
			);
		});

		it('should send critical when CPU load exceeds critical threshold', async () => {
			// 4 cores, load avg = 4.0 → 100% of capacity → exceeds 95% critical
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ cpuLoadAvg: 4.0, cpuCores: 4 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledWith(
				expect.objectContaining({
					alertKey: 'cpu_critical',
					severity: 'critical',
				})
			);
		});
	});

	describe('chat notifications', () => {
		it('should send chat message when active conversation exists', async () => {
			mockTerminalGateway.getActiveConversationId.mockReturnValue('conv-123');
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ diskUsage: 97 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockChatService.addSystemMessage).toHaveBeenCalledWith(
				'conv-123',
				expect.stringContaining('[System Alert]')
			);
		});

		it('should not send chat message when no active conversation', async () => {
			mockTerminalGateway.getActiveConversationId.mockReturnValue(null);
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ diskUsage: 97 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockChatService.addSystemMessage).not.toHaveBeenCalled();
		});

		it('should handle chat service errors gracefully', async () => {
			mockTerminalGateway.getActiveConversationId.mockReturnValue('conv-123');
			mockChatService.addSystemMessage.mockRejectedValue(new Error('DB error'));
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ diskUsage: 97 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Failed to send resource alert notification',
				expect.objectContaining({ alertKey: 'disk_critical' })
			);
		});
	});

	describe('cooldown', () => {
		it('should not resend same alert within cooldown period', async () => {
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ diskUsage: 97 })
			);
			service.startMonitoring();

			// First poll — alert should fire
			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledTimes(1);

			// Second poll — within cooldown, should NOT fire
			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledTimes(1);
		});

		it('should resend alert after cooldown period elapses', async () => {
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ diskUsage: 97 })
			);
			service.startMonitoring();

			// First poll — fires
			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledTimes(1);

			// Advance past cooldown
			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.ALERT_COOLDOWN);
			await Promise.resolve();

			// The timer that fired during cooldown advance may or may not count.
			// Advance one more poll interval to be sure.
			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledTimes(2);
		});

		it('should track different alert keys independently', async () => {
			// Disk critical + memory warning at the same time
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ diskUsage: 97, memoryPercentage: 88 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			// Should have sent both alerts
			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledTimes(2);
			const calls = mockTerminalGateway.broadcastSystemResourceAlert.mock.calls;
			const alertKeys = calls.map((c: any[]) => c[0].alertKey);
			expect(alertKeys).toContain('disk_critical');
			expect(alertKeys).toContain('memory_warning');
		});
	});

	describe('no alert when below thresholds', () => {
		it('should not alert when all metrics are normal', async () => {
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ diskUsage: 50, memoryPercentage: 50, cpuLoadAvg: 1, cpuCores: 4 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).not.toHaveBeenCalled();
			expect(mockChatService.addSystemMessage).not.toHaveBeenCalled();
		});
	});

	describe('WebSocket broadcast when no terminal gateway', () => {
		it('should handle missing terminal gateway gracefully', async () => {
			mockGetTerminalGateway.mockReturnValue(null);
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ diskUsage: 97 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await Promise.resolve();

			// Should log but not throw
			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining('[System Alert]'),
				expect.any(Object)
			);
		});
	});
});
