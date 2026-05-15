/**
 * System Resource Alert Service
 *
 * Proactively monitors disk, CPU, and memory usage and sends user-facing
 * notifications when thresholds are exceeded. This prevents silent failures
 * like ENOSPC that can cause the orchestrator to become stuck.
 *
 * - Polls MonitoringService.getSystemMetrics() at a configurable interval
 * - Checks metrics against warning/critical thresholds
 * - Sends chat notifications via ChatService.addSystemMessage()
 * - Broadcasts WebSocket events for frontend toast/banner display
 * - Per-metric cooldown prevents notification spam
 *
 * @module system-resource-alert
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { MonitoringService } from './monitoring.service.js';
import { getTerminalGateway } from '../../websocket/terminal.gateway.js';
import { getChatV2Service } from '../chat-v2/chat-v2.singleton.js';
import { SYSTEM_RESOURCE_ALERT_CONSTANTS } from '../../constants.js';
import { IdleDetectionService } from '../agent/idle-detection.service.js';

const { THRESHOLDS } = SYSTEM_RESOURCE_ALERT_CONSTANTS;

/**
 * Service that polls system resource metrics and sends proactive alerts
 * when disk, memory, or CPU usage exceeds configured thresholds.
 */
export class SystemResourceAlertService {
	private intervalId: NodeJS.Timeout | null = null;
	private lastAlertTimes: Map<string, number> = new Map();
	private logger: ComponentLogger;

	private readonly pollInterval: number;
	private readonly cooldownMs: number;

	constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('SystemResourceAlert');
		this.pollInterval = SYSTEM_RESOURCE_ALERT_CONSTANTS.POLL_INTERVAL;
		this.cooldownMs = SYSTEM_RESOURCE_ALERT_CONSTANTS.ALERT_COOLDOWN;
	}

	/**
	 * Start periodic resource monitoring.
	 */
	startMonitoring(): void {
		if (this.intervalId) {
			this.logger.warn('Resource alert monitoring already running');
			return;
		}

		this.intervalId = setInterval(() => {
			void this.checkResources().catch((error) => {
				this.logger.error('Error checking system resources', {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, this.pollInterval);

		this.logger.info('System resource alert monitoring started', {
			pollIntervalMs: this.pollInterval,
			cooldownMs: this.cooldownMs,
		});
	}

	/**
	 * Stop periodic resource monitoring.
	 */
	stopMonitoring(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			this.logger.info('System resource alert monitoring stopped');
		}
	}

	/**
	 * Check current resource metrics against thresholds and send alerts.
	 */
	private async checkResources(): Promise<void> {
		const metrics = MonitoringService.getInstance().getSystemMetrics();
		if (!metrics) {
			return;
		}

		// Check disk usage
		if (metrics.disk.total > 0) {
			const diskUsage = metrics.disk.usage;
			const freeGB = (metrics.disk.free / (1024 * 1024 * 1024)).toFixed(1);

			if (diskUsage >= THRESHOLDS.DISK_CRITICAL) {
				await this.sendAlert(
					'disk_critical',
					`Disk is ${diskUsage.toFixed(1)}% full (${freeGB} GB free). Actions like git commits, file writes, and log output may fail with ENOSPC. Free up disk space immediately.`,
					'critical'
				);
			} else if (diskUsage >= THRESHOLDS.DISK_WARNING) {
				await this.sendAlert(
					'disk_warning',
					`Disk usage at ${diskUsage.toFixed(1)}% (${freeGB} GB free). Consider freeing up space to prevent issues.`,
					'warning'
				);
			}
		}

		// Check memory usage
		const memUsage = metrics.memory.percentage;
		if (memUsage >= THRESHOLDS.MEMORY_CRITICAL) {
			// Auto-stop idle agents to free memory before the system OOMs
			const stoppedCount = await this.autoStopIdleAgents();
			const stoppedMsg = stoppedCount > 0
				? ` Auto-stopped ${stoppedCount} idle agent(s) to free memory.`
				: '';
			await this.sendAlert(
				'memory_critical',
				`Memory usage at ${memUsage.toFixed(1)}%. System may start killing processes.${stoppedMsg}`,
				'critical'
			);
		} else if (memUsage >= THRESHOLDS.MEMORY_WARNING) {
			await this.sendAlert(
				'memory_warning',
				`Memory usage at ${memUsage.toFixed(1)}%. Performance may degrade if usage continues to rise.`,
				'warning'
			);
		}

		// Check CPU load (load average relative to number of cores)
		const loadAvg = metrics.cpu.loadAverage?.[0];
		if (loadAvg != null && metrics.cpu.cores > 0) {
			const cpuLoadPercent = (loadAvg / metrics.cpu.cores) * 100;
			if (cpuLoadPercent >= THRESHOLDS.CPU_CRITICAL) {
				await this.sendAlert(
					'cpu_critical',
					`CPU load at ${cpuLoadPercent.toFixed(0)}% of capacity (${loadAvg.toFixed(1)} load avg, ${metrics.cpu.cores} cores). System is overloaded.`,
					'critical'
				);
			} else if (cpuLoadPercent >= THRESHOLDS.CPU_WARNING) {
				await this.sendAlert(
					'cpu_warning',
					`CPU load at ${cpuLoadPercent.toFixed(0)}% of capacity. Consider reducing parallel workloads.`,
				'warning'
				);
			}
		}
	}

	/**
	 * Auto-stop idle agents to free memory during critical memory pressure.
	 * Only stops agents that are idle (not actively working on tasks).
	 *
	 * @returns Number of agents stopped
	 */
	private async autoStopIdleAgents(): Promise<number> {
		try {
			const idleDetection = IdleDetectionService.getInstance();
			const stoppedCount = await idleDetection.forceStopIdleAgents();
			if (stoppedCount > 0) {
				this.logger.warn('Auto-stopped idle agents due to memory pressure', { stoppedCount });
			}
			return stoppedCount;
		} catch (error) {
			this.logger.warn('Failed to auto-stop idle agents', {
				error: error instanceof Error ? error.message : String(error),
			});
			return 0;
		}
	}

	/**
	 * Send an alert if the cooldown period has elapsed for this alert key.
	 *
	 * @param alertKey - Unique identifier for the metric+severity (e.g. 'disk_critical')
	 * @param message - Human-readable alert message
	 * @param severity - Alert severity level ('warning' or 'critical')
	 */
	private async sendAlert(alertKey: string, message: string, severity: string): Promise<void> {
		const now = Date.now();
		const lastAlert = this.lastAlertTimes.get(alertKey) || 0;

		if (now - lastAlert < this.cooldownMs) {
			return;
		}

		this.lastAlertTimes.set(alertKey, now);
		const timestamp = new Date().toISOString();

		// Log the alert
		if (severity === 'critical') {
			this.logger.error(`[System Alert] ${message}`, { alertKey, severity });
		} else {
			this.logger.warn(`[System Alert] ${message}`, { alertKey, severity });
		}

		// Send to active chat conversation (if any)
		try {
			const terminalGateway = getTerminalGateway();
			const conversationId = terminalGateway?.getActiveConversationId();

			if (conversationId) {
				const chatV2 = getChatV2Service();
				const channel = chatV2.ensureChannelForLegacyConversation({
					conversationId,
					agentSession: 'crewly-orc',
				});
				chatV2.recordTurn({
					channelId: channel.id,
					senderType: 'system',
					senderId: 'system',
					content: `[System Alert] ${message}`,
					metadata: { source: 'system' },
				});
			}

			// Broadcast WebSocket event for frontend toast/banner
			if (terminalGateway) {
				terminalGateway.broadcastSystemResourceAlert({
					alertKey,
					message,
					severity,
					timestamp,
				});
			}
		} catch (error) {
			this.logger.warn('Failed to send resource alert notification', {
				alertKey,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
