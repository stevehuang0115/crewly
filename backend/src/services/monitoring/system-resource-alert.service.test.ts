import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SystemResourceAlertService } from './system-resource-alert.service.js';
import { MonitoringService, SystemMetrics } from './monitoring.service.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SYSTEM_RESOURCE_ALERT_CONSTANTS } from '../../constants.js';

// Mock dependencies
// Factory mock, not automock: modules this service imports (e.g.
// runtime-service.factory) create a component logger in a static initializer
// at import time, before beforeEach can stub getInstance(). An automocked
// getInstance() returns undefined there and the whole suite fails to load.
jest.mock('../core/logger.service.js', () => {
  const noopLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return {
    LoggerService: {
      getInstance: jest.fn(() => ({ createComponentLogger: jest.fn(() => noopLogger) })),
    },
  };
});
jest.mock('./monitoring.service.js');
jest.mock('../../websocket/terminal.gateway.js');
// The alert path writes to chat-v2 (Phase 6c); these handles let tests
// assert on, and fail, that write.
const mockChatV2 = {
  ensureChannelForLegacyConversation: jest.fn(),
  recordTurn: jest.fn(),
};
jest.mock('../chat-v2/chat-v2.singleton.js', () => ({
  getChatV2Service: jest.fn(() => mockChatV2),
}));
// Critical memory auto-stops idle agents; keep that out of these tests.
const mockForceStopIdleAgents = jest.fn();
jest.mock('../agent/idle-detection.service.js', () => ({
  IdleDetectionService: { getInstance: jest.fn(() => ({ forceStopIdleAgents: mockForceStopIdleAgents })) },
}));

// Import mocked modules for setup
import { getTerminalGateway } from '../../websocket/terminal.gateway.js';

const mockGetTerminalGateway = getTerminalGateway as jest.Mock;

/**
 * Let every queued promise continuation run (the alert path awaits several
 * steps before it broadcasts).
 *
 * @returns Resolves after the microtask queue has drained
 */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

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
	let stateDir: string;
	let statePath: string;

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

		mockChatV2.ensureChannelForLegacyConversation.mockReset().mockReturnValue({ id: 'test-channel' });
		mockChatV2.recordTurn.mockReset().mockReturnValue({ message: { id: 'm1' }, deduped: false });
		mockForceStopIdleAgents.mockReset().mockResolvedValue(0);

		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sys-alert-'));
		statePath = path.join(stateDir, 'owner-notices.json');
		service = new SystemResourceAlertService({ ownerNoticeStatePath: statePath });
	});

	afterEach(() => {
		service.stopMonitoring();
		jest.useRealTimers();
		fs.rmSync(stateDir, { recursive: true, force: true });
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
			mockForceStopIdleAgents.mockResolvedValue(0);
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ memoryPercentage: 96 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			// The critical path awaits the idle-agent auto-stop before alerting,
			// so one microtask turn is not enough.
			await flushMicrotasks();

			expect(mockForceStopIdleAgents).toHaveBeenCalled();
			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledWith(
				expect.objectContaining({ alertKey: 'memory_critical', severity: 'critical' })
			);
		});

		it('reports auto-stopped agents under their own key, so an earlier memory alert cannot hide them', async () => {
			mockForceStopIdleAgents.mockResolvedValue(2);
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ memoryPercentage: 96 })
			);
			service.startMonitoring();

			jest.advanceTimersByTime(SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL);
			await flushMicrotasks();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledWith(
				expect.objectContaining({
					alertKey: 'agents_auto_stopped',
					severity: 'critical',
					message: expect.stringContaining('Auto-stopped 2 idle agent(s)'),
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

			expect(mockChatV2.ensureChannelForLegacyConversation).toHaveBeenCalledWith(
				expect.objectContaining({ conversationId: 'conv-123' })
			);
			expect(mockChatV2.recordTurn).toHaveBeenCalledWith(
				expect.objectContaining({
					channelId: 'test-channel',
					senderType: 'system',
					content: expect.stringContaining('[System Alert]'),
				})
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

			expect(mockChatV2.recordTurn).not.toHaveBeenCalled();
		});

		it('should handle chat service errors gracefully', async () => {
			mockTerminalGateway.getActiveConversationId.mockReturnValue('conv-123');
			mockChatV2.recordTurn.mockImplementation(() => {
				throw new Error('DB error');
			});
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
			expect(mockChatV2.recordTurn).not.toHaveBeenCalled();
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

	describe('owner notice over Slack (#991)', () => {
		let now: number;

		beforeEach(() => {
			jest.useRealTimers();
			now = 1_800_000_000_000;
			jest.spyOn(Date, 'now').mockImplementation(() => now);
		});

		afterEach(() => {
			(Date.now as jest.Mock).mockRestore?.();
		});

		/** Run one resource check and let the owner notice and its state write settle. */
		async function check(target: SystemResourceAlertService = service): Promise<void> {
			await (target as any).checkResources();
			for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
			await (target as any).ownerNoticeWrite;
		}

		it('sends critical disk, critical memory and auto-stopped agents to the owner, besides the dashboard', async () => {
			const notifier = jest.fn().mockResolvedValue(true);
			service.setOwnerNotifier(notifier);
			mockForceStopIdleAgents.mockResolvedValue(3);
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ diskUsage: 97, memoryPercentage: 96 })
			);
			await check();

			// Still on the dashboard…
			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledWith(
				expect.objectContaining({ alertKey: 'disk_critical' })
			);
			// …and now also to the owner.
			expect(notifier).toHaveBeenCalledWith(expect.objectContaining({
				title: 'Disk almost full', urgent: true, message: expect.stringContaining('Disk is 97.0% full'),
			}));
			expect(notifier).toHaveBeenCalledWith(expect.objectContaining({
				title: 'Idle agents stopped to free memory', message: expect.stringContaining('Auto-stopped 3 idle agent(s)'),
			}));
			const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
			expect(Object.keys(state).sort()).toEqual(['agents_auto_stopped', 'disk_critical']);
		});

		it('sends critical memory (no agents stopped) to the owner', async () => {
			const notifier = jest.fn().mockResolvedValue(true);
			service.setOwnerNotifier(notifier);
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(buildMetrics({ memoryPercentage: 96 }));
			await check();
			expect(notifier).toHaveBeenCalledWith(expect.objectContaining({ title: 'Memory critically high' }));
		});

		it('does not send warnings or CPU alerts to the owner', async () => {
			const notifier = jest.fn().mockResolvedValue(true);
			service.setOwnerNotifier(notifier);
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(
				buildMetrics({ diskUsage: 88, memoryPercentage: 88, cpuLoadAvg: 4.0, cpuCores: 4 })
			);
			await check();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalled();
			expect(notifier).not.toHaveBeenCalled();
		});

		it('tells the owner once per owner cooldown, even across a restart', async () => {
			const notifier = jest.fn().mockResolvedValue(true);
			service.setOwnerNotifier(notifier);
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(buildMetrics({ diskUsage: 97 }));
			await check();
			expect(notifier).toHaveBeenCalledTimes(1);

			// Past the dashboard cooldown: the dashboard alert repeats, the owner notice does not.
			now += SYSTEM_RESOURCE_ALERT_CONSTANTS.ALERT_COOLDOWN + 1;
			await check();
			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalledTimes(2);
			expect(notifier).toHaveBeenCalledTimes(1);

			// A fresh service (backend restart) reads the saved time and stays quiet.
			const restarted = new SystemResourceAlertService({ ownerNoticeStatePath: statePath });
			restarted.setOwnerNotifier(notifier);
			await check(restarted);
			expect(notifier).toHaveBeenCalledTimes(1);

			// After the owner cooldown it is sent again.
			now += SYSTEM_RESOURCE_ALERT_CONSTANTS.OWNER_NOTICE_COOLDOWN;
			await check(restarted);
			expect(notifier).toHaveBeenCalledTimes(2);
		});

		it('tries again on the next alert when Slack could not deliver the notice', async () => {
			const notifier = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
			service.setOwnerNotifier(notifier);
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(buildMetrics({ diskUsage: 97 }));
			await check();
			expect(notifier).toHaveBeenCalledTimes(1);
			expect(fs.existsSync(statePath)).toBe(false);

			now += SYSTEM_RESOURCE_ALERT_CONSTANTS.ALERT_COOLDOWN + 1;
			await check();
			expect(notifier).toHaveBeenCalledTimes(2);
			expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toHaveProperty('disk_critical');
		});

		it('a failing notifier never breaks the dashboard alert', async () => {
			service.setOwnerNotifier(jest.fn().mockRejectedValue(new Error('slack down')));
			mockMonitoringInstance.getSystemMetrics.mockReturnValue(buildMetrics({ diskUsage: 97 }));
			await check();

			expect(mockTerminalGateway.broadcastSystemResourceAlert).toHaveBeenCalled();
			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Failed to send system alert to the owner',
				expect.objectContaining({ alertKey: 'disk_critical', error: 'slack down' })
			);
		});
	});
});
